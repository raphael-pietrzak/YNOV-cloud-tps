const redis = require('redis');

const client = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
});

client.on('error', (err) => console.error('Redis Client Error:', err));
client.on('connect', () => console.log('Connecté à Redis Memorystore'));

/**
 * Pattern Cache-Aside : vérifier le cache avant la DB
 */
async function withCache(key, fetchFn, ttlSeconds = 3600) {
  await client.connect().catch(() => {});

  const cached = await client.get(key);
  if (cached) {
    console.log(`Cache HIT : ${key}`);
    return JSON.parse(cached);
  }

  console.log(`Cache MISS : ${key} — requête DB`);
  const data = await fetchFn();

  await client.setEx(key, ttlSeconds, JSON.stringify(data));
  return data;
}

async function invalidateCache(key) {
  await client.connect().catch(() => {});
  await client.del(key);
  console.log(`Cache invalidé : ${key}`);
}

module.exports = { withCache, invalidateCache };
