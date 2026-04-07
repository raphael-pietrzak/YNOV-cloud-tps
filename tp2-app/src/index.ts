import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import { createClient } from 'redis';


const app = express();
const PORT = parseInt(process.env.PORT || '8080', 10);

// Pool de connexion PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'ynov_db',
  user: process.env.DB_USER || 'ynov',
  password: process.env.DB_PASSWORD || 'password',
});

const redisClient = createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});

redisClient.connect().catch(console.error);

const ensureVisitsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS visits (
      id SERIAL PRIMARY KEY,
      visited_at TIMESTAMP DEFAULT NOW()
    )
  `);
};


app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'Hello from YNOV Cloud TP2', version: process.env.APP_VERSION || 'latest', stage: process.env.APP_ENV || 'test' });
});

app.get('/health', async (req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', database: 'connected', stage: process.env.APP_ENV || 'test' });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', stage: process.env.APP_ENV || 'test' });
  }
});

app.get('/db', async (req: Request, res: Response) => {
  try {
    // Creer la table si elle n'existe pas et inserer une entree
    await ensureVisitsTable();
    await pool.query('INSERT INTO visits DEFAULT VALUES');
    const result = await pool.query('SELECT COUNT(*) as total FROM visits');
    res.json({ total_visits: parseInt(result.rows[0].total, 10) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});



app.get('/cached', async (req: Request, res: Response) => {
  const CACHE_KEY = 'visit_count_cached';
  const TTL_SECONDS = 10;

  try {
    await ensureVisitsTable();
    // Lire depuis le cache Redis
    const cached = await redisClient.get(CACHE_KEY);

    if (cached !== null) {
      return res.json({
        total_visits: parseInt(cached, 10),
        source: "cache", // "cache" si lu depuis Redis
        ttl_remaining: await redisClient.ttl(CACHE_KEY),
      });
    }

    // Cache miss : lire depuis PostgreSQL
    const result = await pool.query('SELECT COUNT(*) as total FROM visits');
    const count = parseInt(result.rows[0].total, 10);

    // Stocker dans Redis avec TTL de 10 secondes
    await redisClient.setEx(CACHE_KEY, TTL_SECONDS, String(count));

    return res.json({
      total_visits: count,
      source: "database", // "database" si lu depuis PostgreSQL
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on :${PORT}`);
});