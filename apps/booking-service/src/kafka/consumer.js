/**
 * Kafka Consumer
 *
 * booking-service listens for hotel-events (e.g., HOTEL_DEACTIVATED)
 * so it can auto-cancel affected bookings.
 */
const { Kafka } = require('kafkajs');
const { pool } = require('../models/db');
const { logger } = require('../utils/logger');

const kafka = new Kafka({
  clientId: 'booking-service-consumer',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',')
});

const consumer = kafka.consumer({ groupId: 'booking-service-group' });

async function startKafkaConsumer() {
  await consumer.connect();
  await consumer.subscribe({ topics: ['hotel-events'], fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const event = JSON.parse(message.value.toString());
        logger.info({ topic, type: event.type, key: message.key?.toString() }, 'Consumed Kafka event');

        if (event.type === 'HOTEL_DEACTIVATED') {
          await pool.query(
            `UPDATE bookings SET status = 'cancelled', updated_at = NOW()
             WHERE hotel_id = $1 AND status IN ('confirmed', 'checked_in')`,
            [event.hotelId]
          );
          logger.info({ hotelId: event.hotelId }, 'Cancelled bookings for deactivated hotel');
        }
      } catch (err) {
        logger.error(err, 'Failed to process Kafka message');
      }
    }
  });

  logger.info('Kafka consumer started — listening to hotel-events');
}

process.on('SIGTERM', async () => {
  await consumer.disconnect();
});

module.exports = { startKafkaConsumer };
