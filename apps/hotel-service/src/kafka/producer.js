const { Kafka, Partitioners } = require('kafkajs');
const { logger } = require('../utils/logger');

const kafka = new Kafka({
  clientId: 'hotel-service',
  brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(',')
});
const producer = kafka.producer({ createPartitioner: Partitioners.LegacyPartitioner });
let connected = false;

async function initKafkaProducer() {
  await producer.connect();
  connected = true;
  logger.info('Hotel service Kafka producer connected');
}

async function publishEvent(topic, payload) {
  if (!connected) return;
  await producer.send({
    topic,
    messages: [{
      key: payload.hotelId || 'default',
      value: JSON.stringify({ ...payload, timestamp: new Date().toISOString(), service: 'hotel-service' })
    }]
  });
}

process.on('SIGTERM', () => producer.disconnect());
module.exports = { initKafkaProducer, publishEvent };
