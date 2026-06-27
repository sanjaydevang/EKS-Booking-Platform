/**
 * Kafka Producer
 *
 * booking-service publishes events to Kafka topics.
 * Other services (notification-service, inventory-service) consume these.
 *
 * In K8s: Kafka brokers are accessed via their Service DNS names.
 * MSK on AWS uses: broker1.kafka.us-east-1.amazonaws.com:9092
 * Local/dev uses: kafka:9092 (from docker-compose or K8s Service)
 */
const { Kafka, Partitioners } = require('kafkajs');
const { logger } = require('../utils/logger');

const kafka = new Kafka({
  clientId: 'booking-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
  retry: { initialRetryTime: 300, retries: 8 }
});

const producer = kafka.producer({
  createPartitioner: Partitioners.LegacyPartitioner,
  allowAutoTopicCreation: false
});

let isConnected = false;

async function initKafkaProducer() {
  await producer.connect();
  isConnected = true;
  logger.info('Kafka producer connected');
}

async function publishEvent(topic, payload) {
  if (!isConnected) {
    logger.warn({ topic, payload }, 'Kafka not connected, skipping event');
    return;
  }

  const message = {
    key: payload.bookingId || payload.hotelId || 'default',
    value: JSON.stringify({
      ...payload,
      timestamp: new Date().toISOString(),
      service: 'booking-service'
    }),
    headers: {
      'content-type': 'application/json',
      'event-type': payload.type
    }
  };

  await producer.send({ topic, messages: [message] });
  logger.info({ topic, type: payload.type, key: message.key }, 'Event published to Kafka');
}

process.on('SIGTERM', async () => {
  await producer.disconnect();
});

module.exports = { initKafkaProducer, publishEvent };
