// Tracing must be initialized BEFORE any other imports
require('./tracing');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const promMiddleware = require('express-prometheus-middleware');
const rateLimit = require('express-rate-limit');

const bookingRoutes = require('./routes/bookings');
const healthRoutes = require('./routes/health');
const { logger } = require('./utils/logger');
const { connectDB } = require('./models/db');
const { connectRedis } = require('./utils/redis');
const { initKafkaProducer } = require('./kafka/producer');
const { startKafkaConsumer } = require('./kafka/consumer');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '10kb' }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
}));

// ─── Prometheus Metrics ───────────────────────────────────────────────────────
// Exposes /metrics endpoint for Prometheus scraping
app.use(promMiddleware({
  metricsPath: '/metrics',
  collectDefaultMetrics: true,
  requestDurationBuckets: [0.1, 0.5, 1, 1.5, 2, 5],
  requestLengthBuckets: [512, 1024, 5120, 10240],
  responseLengthBuckets: [512, 1024, 5120, 10240],
  customLabels: { service: 'booking-service', env: process.env.NODE_ENV }
}));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/health', healthRoutes);
app.use('/api/v1/bookings', bookingRoutes);

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error({ err, url: req.url, method: req.method }, 'Unhandled error');
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    requestId: req.headers['x-request-id']
  });
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function start() {
  try {
    await connectDB();
    await connectRedis();
    await initKafkaProducer();
    await startKafkaConsumer();

    app.listen(PORT, () => {
      logger.info({ port: PORT, env: process.env.NODE_ENV }, 'Booking service started');
    });
  } catch (err) {
    logger.error(err, 'Failed to start booking service');
    process.exit(1);
  }
}

// Graceful shutdown for Kubernetes SIGTERM
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  // Give in-flight requests 10s to complete before exit
  setTimeout(() => process.exit(0), 10000);
});

start();

module.exports = app; // exported for tests
