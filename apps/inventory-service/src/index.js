const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { Pool } = require('pg');
const winston = require('winston');

const app = express();
const PORT = process.env.PORT || 3003;

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  defaultMeta: { service: 'inventory-service' },
  transports: [new winston.transports.Console()]
});

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres-hotels',
  port: 5432,
  database: process.env.DB_NAME || 'hotels_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'dev_password',
  max: 10
});

app.use(helmet());
app.use(cors());
app.use(express.json());

// Initialize rooms table
pool.query(`
  CREATE TABLE IF NOT EXISTS rooms (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hotel_id    UUID NOT NULL,
    room_number VARCHAR(20) NOT NULL,
    room_type   VARCHAR(50) NOT NULL DEFAULT 'standard',
    capacity    INT NOT NULL DEFAULT 2,
    base_price  DECIMAL(10,2) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'available',
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_hotel_id ON rooms(hotel_id);

  CREATE TABLE IF NOT EXISTS room_blocks (
    id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id   UUID NOT NULL REFERENCES rooms(id),
    check_in  DATE NOT NULL,
    check_out DATE NOT NULL,
    booking_id UUID
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_room ON room_blocks(room_id, check_in, check_out);
`).then(() => logger.info('Inventory DB ready')).catch(e => logger.error(e));

// GET /api/v1/inventory/:hotelId/availability
// Called by booking-service before confirming a booking
app.get('/api/v1/inventory/:hotelId/availability', async (req, res) => {
  const { hotelId } = req.params;
  const { room_id, check_in, check_out } = req.query;

  if (!room_id || !check_in || !check_out) {
    return res.status(400).json({ error: 'room_id, check_in, check_out required' });
  }

  try {
    // Check if room has any overlapping blocks
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS conflicts
      FROM room_blocks
      WHERE room_id = $1
        AND check_in  < $3::date
        AND check_out > $2::date
    `, [room_id, check_in, check_out]);

    const available = parseInt(rows[0].conflicts) === 0;
    res.json({ available, room_id, check_in, check_out });
  } catch (err) {
    logger.error(err);
    res.json({ available: true }); // fail open
  }
});

// GET /api/v1/inventory/:hotelId/rooms — list rooms for a hotel
app.get('/api/v1/inventory/:hotelId/rooms', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM rooms WHERE hotel_id = $1 ORDER BY room_number',
      [req.params.hotelId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/inventory/rooms — add rooms to a hotel
app.post('/api/v1/inventory/rooms', async (req, res) => {
  const { hotel_id, room_number, room_type, capacity, base_price } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO rooms (hotel_id, room_number, room_type, capacity, base_price)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [hotel_id, room_number, room_type || 'standard', capacity || 2, base_price]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/v1/inventory/block — block a room (called after booking confirmed)
app.post('/api/v1/inventory/block', async (req, res) => {
  const { room_id, check_in, check_out, booking_id } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO room_blocks (room_id, check_in, check_out, booking_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [room_id, check_in, check_out, booking_id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health/live',  (req, res) => res.json({ status: 'alive' }));
app.get('/health/ready', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ready' }); }
  catch (e) { res.status(503).json({ status: 'not ready' }); }
});

app.listen(PORT, () => logger.info({ port: PORT }, 'Inventory service started'));
