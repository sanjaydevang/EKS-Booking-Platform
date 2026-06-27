require('./tracing');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const promMiddleware = require('express-prometheus-middleware');

const hotelRoutes = require('./routes/hotels');
const healthRoutes = require('./routes/health');
const { logger } = require('./utils/logger');
const { connectDB } = require('./models/db');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10kb' }));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

app.use(promMiddleware({
  metricsPath: '/metrics',
  collectDefaultMetrics: true,
  customLabels: { service: 'hotel-service', env: process.env.NODE_ENV }
}));

app.use('/health', healthRoutes);
app.use('/api/v1/hotels', hotelRoutes);

app.use((err, req, res, next) => {
  logger.error(err, 'Unhandled error');
  res.status(err.status || 500).json({ error: err.message });
});

async function start() {
  await connectDB();
  app.listen(PORT, () => logger.info({ port: PORT }, 'Hotel service started'));
}

process.on('SIGTERM', () => setTimeout(() => process.exit(0), 10000));
start();
module.exports = app;
