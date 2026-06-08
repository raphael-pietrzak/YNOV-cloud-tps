const express = require('express');
const { withCache, invalidateCache } = require('./cache-service');

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// GET /merchants — Liste des marchands partenaires (avec cache Redis)
app.get('/merchants', async (req, res) => {
  try {
    const merchants = await withCache(
      'merchants:all',
      async () => {
        await new Promise(r => setTimeout(r, 200));
        return [
          { id: 'MERCH-1', name: 'BoutiqueA', category: 'retail' },
          { id: 'MERCH-2', name: 'MarketplaceB', category: 'marketplace' },
          { id: 'MERCH-3', name: 'EcommerceC', category: 'fashion' },
        ];
      },
      3600,
    );

    res.json({ source: 'cache_or_db', count: merchants.length, data: merchants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /merchants — Invalide le cache
app.post('/merchants', async (req, res) => {
  await invalidateCache('merchants:all');
  res.status(201).json({ message: 'Marchand créé, cache invalidé' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FinSecure API on :${PORT}`));
