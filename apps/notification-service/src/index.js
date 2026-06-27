/**
 * Notification Service
 *
 * Pure Kafka consumer — no HTTP server needed.
 * Listens to booking-events and hotel-events, sends emails/SMS.
 *
 * In K8s: runs as a Deployment (not exposed via Service/Ingress).
 * Scales independently from booking-service.
 */
require('./tracing');
const { startConsumer } = require('./kafka/consumer');
const { logger } = require('./utils/logger');

async function start() {
  logger.info('Notification service starting');
  await startConsumer();
  logger.info('Notification service consuming events');
}

process.on('SIGTERM', () => {
  logger.info('SIGTERM received');
  process.exit(0);
});

start().catch(err => {
  logger.error(err, 'Notification service failed to start');
  process.exit(1);
});
