// Analysis publish/read API using Vercel KV (free tier)
// Setup: Add KV store in Vercel dashboard, env vars auto-added

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { method } = req;
  const { action, id } = req.query;

  // Simple admin key check for write operations
  const ADMIN_KEY = process.env.ADMIN_KEY || 'barisinvesting2026';

  if (method === 'GET') {
    if (action === 'list') return listAnalyses(res);
    if (action === 'get' && id) return getAnalysis(id, res);
    return listAnalyses(res);
  }

  if (method === 'POST') {
    const { adminKey, analysis } = req.body || {};
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Yetkisiz erişim' });
    return saveAnalysis(analysis, res);
  }

  if (method === 'DELETE') {
    const { adminKey } = req.body || {};
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Yetkisiz erişim' });
    return deleteAnalysis(id, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ---- KV helpers (Vercel KV) ----
async function getKV() {
  // Use Vercel KV if available, else fallback to in-memory (dev)
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return {
      async get(key) {
        const r = await fetch(`${process.env.KV_REST_API_URL}/get/${key}`, {
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
        });
        const d = await r.json();
        return d.result ? JSON.parse(d.result) : null;
      },
      async set(key, value) {
        await fetch(`${process.env.KV_REST_API_URL}/set/${key}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: JSON.stringify(value) })
        });
      },
      async del(key) {
        await fetch(`${process.env.KV_REST_API_URL}/del/${key}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` }
        });
      }
    };
  }
  // Fallback: simple file-based or return mock
  return null;
}

const ANALYSES_KEY = 'baris_analyses_v1';

async function listAnalyses(res) {
  try {
    const kv = await getKV();
    if (!kv) {
      // Return demo analyses if no KV configured
      return res.status(200).json({ analyses: getDemoAnalyses() });
    }
    const data = await kv.get(ANALYSES_KEY);
    const analyses = data || [];
    return res.status(200).json({ analyses: analyses.sort((a, b) => b.createdAt - a.createdAt) });
  } catch (e) {
    return res.status(200).json({ analyses: getDemoAnalyses() });
  }
}

async function getAnalysis(id, res) {
  try {
    const kv = await getKV();
    if (!kv) return res.status(404).json({ error: 'Not found' });
    const data = await kv.get(ANALYSES_KEY);
    const analyses = data || [];
    const found = analyses.find(a => a.id === id);
    if (!found) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ analysis: found });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function saveAnalysis(analysis, res) {
  if (!analysis?.title || !analysis?.content) {
    return res.status(400).json({ error: 'Başlık ve içerik gerekli' });
  }
  const newAnalysis = {
    id: `a_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    title: analysis.title,
    ticker: (analysis.ticker || '').toUpperCase(),
    exchange: analysis.exchange || '',
    verdict: analysis.verdict || 'BEKLE',
    buffettScore: analysis.buffettScore || null,
    lynchScore: analysis.lynchScore || null,
    summary: analysis.summary || '',
    content: analysis.content,
    tags: analysis.tags || [],
    createdAt: Date.now(),
  };
  try {
    const kv = await getKV();
    if (!kv) return res.status(200).json({ success: true, analysis: newAnalysis, warning: 'KV not configured' });
    const existing = await kv.get(ANALYSES_KEY) || [];
    existing.unshift(newAnalysis);
    // Keep max 100 analyses
    const trimmed = existing.slice(0, 100);
    await kv.set(ANALYSES_KEY, trimmed);
    return res.status(200).json({ success: true, analysis: newAnalysis });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function deleteAnalysis(id, res) {
  try {
    const kv = await getKV();
    if (!kv) return res.status(404).json({ error: 'KV not configured' });
    const existing = await kv.get(ANALYSES_KEY) || [];
    const filtered = existing.filter(a => a.id !== id);
    await kv.set(ANALYSES_KEY, filtered);
    return res.status(200).json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

function getDemoAnalyses() {
  return [
    {
      id: 'demo_1',
      title: 'THYAO — Türk Hava Yolları Derin Analiz',
      ticker: 'THYAO', exchange: 'BIST', verdict: 'AL',
      buffettScore: 5, lynchScore: 6,
      summary: 'THY global expansion hikayesi güçlü, marj iyileştirmesi devam ediyor. 2026 hedef kapasiteye ulaşma sürecinde.',
      content: `THY analiz içeriği buraya gelecek...`,
      tags: ['Havacılık', 'BIST30', 'Büyüme'],
      createdAt: Date.now() - 86400000 * 2,
    },
    {
      id: 'demo_2',
      title: 'ABBV — AbbVie Buffett Kriterleri ile Analiz',
      ticker: 'ABBV', exchange: 'NYSE', verdict: 'BEKLE',
      buffettScore: 4, lynchScore: 4,
      summary: 'Humira patent kaybı telafi ediliyor ama büyüme ivmesi henüz netleşmedi.',
      content: `ABBV analiz içeriği buraya gelecek...`,
      tags: ['İlaç', 'Temettü', 'Değer'],
      createdAt: Date.now() - 86400000 * 5,
    },
  ];
}
