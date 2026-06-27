const { Pool } = require('pg');
const { logger } = require('../utils/logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'bookings_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20,                 // max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000
});

pool.on('error', (err) => {
  logger.error(err, 'PostgreSQL pool error');
});

async function connectDB() {
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  logger.info('PostgreSQL connected');
  await runMigrations();
}

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      hotel_id      UUID NOT NULL,
      room_id       UUID NOT NULL,
      guest_name    VARCHAR(255) NOT NULL,
      guest_email   VARCHAR(255) NOT NULL,
      source        VARCHAR(50) NOT NULL DEFAULT 'direct',
      ota_ref       VARCHAR(255),
      check_in      DATE NOT NULL,
      check_out     DATE NOT NULL,
      status        VARCHAR(50) NOT NULL DEFAULT 'confirmed',
      total_amount  DECIMAL(10,2) NOT NULL,
      currency      VARCHAR(3) NOT NULL DEFAULT 'USD',
      metadata      JSONB DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_hotel_id ON bookings(hotel_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_source ON bookings(source);
    CREATE INDEX IF NOT EXISTS idx_bookings_check_in ON bookings(check_in);

    CREATE TABLE IF NOT EXISTS booking_events (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      booking_id  UUID NOT NULL REFERENCES bookings(id),
      event_type  VARCHAR(100) NOT NULL,
      payload     JSONB DEFAULT '{}',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  logger.info('DB migrations complete');
}

module.exports = { pool, connectDB };
