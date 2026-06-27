/**
 * Notification Service Kafka Consumer
 *
 * Consumes events from multiple topics and dispatches notifications.
 * This is the fan-out pattern — booking-service emits ONE event,
 * notification-service handles sending email/SMS independently.
 */
const { Kafka } = require('kafkajs');
const { handleBookingEvent } = require('../handlers/bookingHandler');
const { handleHotelEvent } = require('../handlers/hotelHandler');
const { logger } = require('../utils/logger');

const kafka = new Kafka({
  clientId: 'notification-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  retry: { initialRetryTime: 300, retries: 10 }
});

const consumer = kafka.consumer({
  groupId: 'notification-service-group',
  // Each partition is consumed by exactly ONE consumer in a group.
  // Scale to multiple replicas → more partitions → parallel processing.
  sessionTimeout: 30000,
  heartbeatInterval: 3000
});

async function startConsumer() {
  await consumer.connect();

  await consumer.subscribe({
    topics: ['booking-events', 'hotel-events'],
    fromBeginning: false
  });

  await consumer.run({
    // autoCommit: true means offset advances after processing
    // For guaranteed delivery, set to false and commit manually
    autoCommit: true,
    autoCommitInterval: 5000,
    eachMessage: async ({ topic, partition, message }) => {
      const event = JSON.parse(message.value.toString());
      const offset = message.offset;

      logger.info({ topic, partition, offset, type: event.type }, 'Processing event');

      try {
        if (topic === 'booking-events') {
          await handleBookingEvent(event);
        } else if (topic === 'hotel-events') {
          await handleHotelEvent(event);
        }
      } catch (err) {
        // Log and continue — don't crash the consumer for one bad message
        // In production: send to a Dead Letter Queue (DLQ) topic
        logger.error({ err, event, topic }, 'Failed to process event — sending to DLQ');
        await sendToDLQ(topic, event, err);
      }
    }
  });
}

async function sendToDLQ(originalTopic, event, err) {
  // DLQ pattern: failed messages go to notification-service-dlq for manual review
  try {
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({
      topic: `${originalTopic}-dlq`,
      messages: [{
        value: JSON.stringify({ originalEvent: event, error: err.message, timestamp: new Date().toISOString() })
      }]
    });
    await producer.disconnect();
  } catch (dlqErr) {
    logger.error(dlqErr, 'Failed to send to DLQ');
  }
}

process.on('SIGTERM', async () => {
  await consumer.disconnect();
});

module.exports = { startConsumer };
