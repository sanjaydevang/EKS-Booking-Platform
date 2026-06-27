const winston = require('winston');

// Structured JSON logging — Fluentd/Fluent Bit picks these up from pod stdout
// and ships them to Elasticsearch or CloudWatch Logs.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: 'booking-service',
    env: process.env.NODE_ENV
  },
  transports: [new winston.transports.Console()]
});

module.exports = { logger };
