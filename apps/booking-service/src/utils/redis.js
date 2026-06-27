const { createClient } = require('redis');
const { logger } = require('./logger');

let client;

async function connectRedis() {
  client = createClient({
    url: process.env.REDIS_URL || 'redis://redis:6379',
    socket: { reconnectStrategy: retries => Math.min(retries * 50, 2000) }
  });

  client.on('error', err => logger.error(err, 'Redis error'));
  client.on('reconnecting', () => logger.warn('Redis reconnecting'));

  await client.connect();
  logger.info('Redis connected');
}

async function getCache(key) {
  if (!client?.isReady) return null;
  const val = await client.get(key);
  return val ? JSON.parse(val) : null;
}

async function setCache(key, value, ttlSeconds = 60) {
  if (!client?.isReady) return;
  await client.setEx(key, ttlSeconds, JSON.stringify(value));
}

async function deleteCache(key) {
  if (!client?.isReady) return;
  await client.del(key);
}

module.exports = { connectRedis, getCache, setCache, deleteCache };
