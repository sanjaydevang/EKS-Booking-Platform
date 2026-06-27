const express = require('express');
const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../models/db');
const { publishEvent } = require('../kafka/producer');
const { getCache, setCache, deleteCache } = require('../utils/redis');
const { logger } = require('../utils/logger');

const router = express.Router();

// ─── Validation Schemas ───────────────────────────────────────────────────────
const createBookingSchema = Joi.object({
  hotel_id: Joi.string().uuid().required(),
  room_id: Joi.string().uuid().required(),
  guest_name: Joi.string().min(2).max(255).required(),
  guest_email: Joi.string().email().required(),
  check_in: Joi.date().iso().min('now').required(),
  check_out: Joi.date().iso().greater(Joi.ref('check_in')).required(),
  total_amount: Joi.number().positive().required(),
  currency: Joi.string().length(3).default('USD'),
  source: Joi.string().valid('direct', 'expedia', 'booking.com', 'airbnb', 'hotels.com', 'ota').default('direct'),
  ota_ref: Joi.string().max(255).optional(),
  metadata: Joi.object().default({})
});

// ─── GET /bookings — list with filters ───────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { status, source, hotel_id, page = 1, limit = 20, date_from, date_to } = req.query;

    const cacheKey = `bookings:list:${JSON.stringify(req.query)}`;
    const cached = await getCache(cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (status) { conditions.push(`status = $${paramIdx++}`); params.push(status); }
    if (source) { conditions.push(`source = $${paramIdx++}`); params.push(source); }
    if (hotel_id) { conditions.push(`hotel_id = $${paramIdx++}`); params.push(hotel_id); }
    if (date_from) { conditions.push(`check_in >= $${paramIdx++}`); params.push(date_from); }
    if (date_to) { conditions.push(`check_out <= $${paramIdx++}`); params.push(date_to); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const [rows, countResult] = await Promise.all([
      pool.query(
        `SELECT * FROM bookings ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, parseInt(limit), offset]
      ),
      pool.query(`SELECT COUNT(*) FROM bookings ${where}`, params)
    ]);

    const result = {
      data: rows.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(parseInt(countResult.rows[0].count) / parseInt(limit))
      }
    };

    await setCache(cacheKey, result, 30); // cache for 30 seconds
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /bookings/stats — OTA/PMS dashboard stats ───────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const cached = await getCache('bookings:stats');
    if (cached) return res.json({ ...cached, cached: true });

    const { rows } = await pool.query(`
      SELECT
        source,
        status,
        COUNT(*)                  AS count,
        SUM(total_amount)         AS revenue,
        AVG(total_amount)         AS avg_value,
        DATE(created_at)          AS date
      FROM bookings
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY source, status, DATE(created_at)
      ORDER BY date DESC
    `);

    const bySource = await pool.query(`
      SELECT source, COUNT(*) AS count, SUM(total_amount) AS revenue
      FROM bookings GROUP BY source ORDER BY count DESC
    `);

    const result = {
      daily: rows,
      by_source: bySource.rows,
      generated_at: new Date().toISOString()
    };

    await setCache('bookings:stats', result, 60);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── GET /bookings/:id ────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const cached = await getCache(`booking:${req.params.id}`);
    if (cached) return res.json({ ...cached, cached: true });

    const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Booking not found' });

    await setCache(`booking:${req.params.id}`, rows[0], 60);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── POST /bookings — create booking ─────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { error, value } = createBookingSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    // Check room availability (calls inventory-service via internal K8s DNS)
    const available = await checkRoomAvailability(value.hotel_id, value.room_id, value.check_in, value.check_out);
    if (!available) {
      return res.status(409).json({ error: 'Room not available for selected dates' });
    }

    const { rows } = await pool.query(
      `INSERT INTO bookings (hotel_id, room_id, guest_name, guest_email, source, ota_ref,
        check_in, check_out, total_amount, currency, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [value.hotel_id, value.room_id, value.guest_name, value.guest_email,
       value.source, value.ota_ref, value.check_in, value.check_out,
       value.total_amount, value.currency, JSON.stringify(value.metadata)]
    );

    const booking = rows[0];

    // Record event for audit trail
    await pool.query(
      `INSERT INTO booking_events (booking_id, event_type, payload) VALUES ($1, $2, $3)`,
      [booking.id, 'BOOKING_CREATED', JSON.stringify({ source: value.source })]
    );

    // Publish to Kafka — notification-service and inventory-service both consume this
    await publishEvent('booking-events', {
      type: 'BOOKING_CREATED',
      bookingId: booking.id,
      hotelId: booking.hotel_id,
      roomId: booking.room_id,
      guestEmail: booking.guest_email,
      guestName: booking.guest_name,
      checkIn: booking.check_in,
      checkOut: booking.check_out,
      source: booking.source,
      totalAmount: booking.total_amount,
      currency: booking.currency
    });

    logger.info({ bookingId: booking.id, source: booking.source }, 'Booking created');
    res.status(201).json(booking);
  } catch (err) {
    next(err);
  }
});

// ─── PUT /bookings/:id/checkin ────────────────────────────────────────────────
router.put('/:id/checkin', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'checked_in', updated_at = NOW()
       WHERE id = $1 AND status = 'confirmed' RETURNING *`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Booking not found or already checked in' });

    await pool.query(
      `INSERT INTO booking_events (booking_id, event_type, payload) VALUES ($1, $2, $3)`,
      [req.params.id, 'GUEST_CHECKED_IN', JSON.stringify({ checkin_time: new Date() })]
    );

    await publishEvent('booking-events', {
      type: 'GUEST_CHECKED_IN',
      bookingId: rows[0].id,
      hotelId: rows[0].hotel_id,
      guestName: rows[0].guest_name,
      guestEmail: rows[0].guest_email
    });

    await deleteCache(`booking:${req.params.id}`);
    logger.info({ bookingId: req.params.id }, 'Guest checked in');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── PUT /bookings/:id/checkout ───────────────────────────────────────────────
router.put('/:id/checkout', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'checked_out', updated_at = NOW()
       WHERE id = $1 AND status = 'checked_in' RETURNING *`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Booking not found or not checked in' });

    await pool.query(
      `INSERT INTO booking_events (booking_id, event_type, payload) VALUES ($1, $2, $3)`,
      [req.params.id, 'GUEST_CHECKED_OUT', JSON.stringify({ checkout_time: new Date() })]
    );

    await publishEvent('booking-events', {
      type: 'GUEST_CHECKED_OUT',
      bookingId: rows[0].id,
      hotelId: rows[0].hotel_id,
      roomId: rows[0].room_id,
      guestEmail: rows[0].guest_email
    });

    await deleteCache(`booking:${req.params.id}`);
    logger.info({ bookingId: req.params.id }, 'Guest checked out');
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /bookings/:id — cancel ───────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status NOT IN ('checked_in','checked_out','cancelled') RETURNING *`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Booking not found or cannot be cancelled' });

    await publishEvent('booking-events', {
      type: 'BOOKING_CANCELLED',
      bookingId: rows[0].id,
      hotelId: rows[0].hotel_id,
      roomId: rows[0].room_id,
      guestEmail: rows[0].guest_email
    });

    await deleteCache(`booking:${req.params.id}`);
    res.json({ message: 'Booking cancelled', booking: rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── Internal: check room availability via inventory-service ──────────────────
async function checkRoomAvailability(hotelId, roomId, checkIn, checkOut) {
  try {
    // In K8s this resolves to inventory-service ClusterIP via CoreDNS:
    // http://inventory-service.default.svc.cluster.local:3003
    const inventoryUrl = process.env.INVENTORY_SERVICE_URL || 'http://inventory-service:3003';
    const http = require('http');

    return new Promise((resolve) => {
      const url = `${inventoryUrl}/api/v1/inventory/${hotelId}/availability?room_id=${roomId}&check_in=${checkIn}&check_out=${checkOut}`;
      http.get(url, (resp) => {
        let data = '';
        resp.on('data', chunk => data += chunk);
        resp.on('end', () => {
          try {
            const body = JSON.parse(data);
            resolve(body.available === true);
          } catch { resolve(true); } // fail open if inventory-service is down
        });
      }).on('error', () => resolve(true)); // fail open
    });
  } catch {
    return true;
  }
}

module.exports = router;
