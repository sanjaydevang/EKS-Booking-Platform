const { Pool } = require('pg');
const { logger } = require('../utils/logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'hotels_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  max: 20
});

async function connectDB() {
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  await runMigrations();
  logger.info('Hotel service DB connected');
}

async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hotels (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name           VARCHAR(255) NOT NULL,
      address        JSONB NOT NULL,
      star_rating    SMALLINT NOT NULL CHECK (star_rating BETWEEN 1 AND 5),
      contact_email  VARCHAR(255) NOT NULL,
      contact_phone  VARCHAR(50) NOT NULL,
      amenities      JSONB DEFAULT '[]',
      ota_mappings   JSONB DEFAULT '{}',
      policies       JSONB DEFAULT '{}',
      status         VARCHAR(50) NOT NULL DEFAULT 'pending',
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_hotels_status ON hotels(status);
    CREATE INDEX IF NOT EXISTS idx_hotels_country ON hotels((address->>'country'));
  `);
}

module.exports = { pool, connectDB };
