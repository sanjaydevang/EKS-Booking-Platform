/**
 * Hotel Onboarding & Management
 *
 * Hotels go through a lifecycle: PENDING → ACTIVE → INACTIVE
 * OTAs (Expedia, Booking.com) sync their hotel inventory via this API.
 */
const express = require('express');
const Joi = require('joi');
const { pool } = require('../models/db');
const { publishEvent } = require('../kafka/producer');
const { logger } = require('../utils/logger');

const router = express.Router();

const hotelSchema = Joi.object({
  name: Joi.string().min(2).max(255).required(),
  address: Joi.object({
    street: Joi.string().required(),
    city: Joi.string().required(),
    state: Joi.string().required(),
    country: Joi.string().length(2).uppercase().required(),
    zip: Joi.string().required()
  }).required(),
  star_rating: Joi.number().min(1).max(5).required(),
  contact_email: Joi.string().email().required(),
  contact_phone: Joi.string().required(),
  amenities: Joi.array().items(Joi.string()).default([]),
  ota_mappings: Joi.object({
    expedia_id: Joi.string().optional(),
    booking_com_id: Joi.string().optional(),
    airbnb_id: Joi.string().optional()
  }).default({}),
  policies: Joi.object({
    check_in_time: Joi.string().default('15:00'),
    check_out_time: Joi.string().default('11:00'),
    cancellation_hours: Joi.number().default(24)
  }).default({})
});

// GET /hotels — list all hotels with status
router.get('/', async (req, res, next) => {
  try {
    const { status, city, country, page = 1, limit = 20 } = req.query;
    const conditions = [];
    const params = [];
    let i = 1;

    if (status) { conditions.push(`status = $${i++}`); params.push(status); }
    if (city) { conditions.push(`address->>'city' ILIKE $${i++}`); params.push(`%${city}%`); }
    if (country) { conditions.push(`address->>'country' = $${i++}`); params.push(country.toUpperCase()); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows } = await pool.query(
      `SELECT * FROM hotels ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, parseInt(limit), offset]
    );

    res.json({ data: rows, page: parseInt(page) });
  } catch (err) { next(err); }
});

// GET /hotels/:id — hotel detail
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM hotels WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Hotel not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /hotels — onboard a new hotel
router.post('/', async (req, res, next) => {
  try {
    const { error, value } = hotelSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const { rows } = await pool.query(
      `INSERT INTO hotels (name, address, star_rating, contact_email, contact_phone,
        amenities, ota_mappings, policies, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING *`,
      [
        value.name,
        JSON.stringify(value.address),
        value.star_rating,
        value.contact_email,
        value.contact_phone,
        JSON.stringify(value.amenities),
        JSON.stringify(value.ota_mappings),
        JSON.stringify(value.policies)
      ]
    );

    const hotel = rows[0];

    // Notify other services that a new hotel is being onboarded
    await publishEvent('hotel-events', {
      type: 'HOTEL_ONBOARDED',
      hotelId: hotel.id,
      name: hotel.name,
      otaMappings: hotel.ota_mappings
    });

    logger.info({ hotelId: hotel.id, name: hotel.name }, 'Hotel onboarded');
    res.status(201).json(hotel);
  } catch (err) { next(err); }
});

// PUT /hotels/:id/activate — approve hotel for bookings
router.put('/:id/activate', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE hotels SET status = 'active', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Hotel not found or already active' });

    await publishEvent('hotel-events', {
      type: 'HOTEL_ACTIVATED',
      hotelId: rows[0].id,
      name: rows[0].name
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /hotels/:id/deactivate — take hotel offline (cascades to bookings via Kafka)
router.put('/:id/deactivate', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE hotels SET status = 'inactive', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Hotel not found' });

    // booking-service consumes this and auto-cancels future bookings
    await publishEvent('hotel-events', {
      type: 'HOTEL_DEACTIVATED',
      hotelId: rows[0].id,
      name: rows[0].name
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /hotels/:id/ota-sync — sync OTA channel mapping
router.put('/:id/ota-sync', async (req, res, next) => {
  try {
    const { expedia_id, booking_com_id, airbnb_id } = req.body;
    const { rows } = await pool.query(
      `UPDATE hotels
       SET ota_mappings = ota_mappings || $1::jsonb, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [JSON.stringify({ expedia_id, booking_com_id, airbnb_id }), req.params.id]
    );

    if (!rows[0]) return res.status(404).json({ error: 'Hotel not found' });

    await publishEvent('hotel-events', {
      type: 'HOTEL_OTA_SYNCED',
      hotelId: rows[0].id,
      otaMappings: rows[0].ota_mappings
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
