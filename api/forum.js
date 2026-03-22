// Public forum — anyone can post, admin can delete
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { method } = req;
  const { action, id } = req.query;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'barisinvesting2026';

  if (method === 'GET') return listPosts(res);
  if (method === 'POST') {
    const { post, adminKey, deleteId } = req.body || {};
    if (deleteId && adminKey === ADMIN_KEY) return deletePost(deleteId, res);
    if (post) return savePost(post, res);
    return res.status(400).json({ error: 'Geçersiz istek' });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

const KEY = 'baris_forum_v1';

async function getKV() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    const base = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    const hdrs = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    return {
      async get(k) {
        const r = await fetch(`${base}/get/${k}`, { headers: hdrs });
        const d = await r.json();
        return d.result ? JSON.parse(d.result) : null;
      },
      async set(k, v) {
        await fetch(`${base}/set/${k}`, { method: 'POST', headers: hdrs, body: JSON.stringify({ value: JSON.stringify(v) }) });
      }
    };
  }
  return null;
}

async function listPosts(res) {
  try {
    const kv = await getKV();
    if (!kv) return res.status(200).json({ posts: getDemo() });
    const data = await kv.get(KEY);
    const posts = (data || []).sort((a, b) => b.createdAt - a.createdAt);
    return res.status(200).json({ posts });
  } catch { return res.status(200).json({ posts: getDemo() }); }
}

async function savePost(post, res) {
  const { author, ticker, exchange, verdict, content, nickname } = post;
  if (!content || content.trim().length < 20) return res.status(400).json({ error: 'Yazı çok kısa (min 20 karakter)' });
  if (content.length > 2000) return res.status(400).json({ error: 'Yazı çok uzun (max 2000 karakter)' });

  const newPost = {
    id: `p_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
    nickname: (nickname||'Anonim').substring(0,30),
    ticker: (ticker||'').toUpperCase().substring(0,10),
    exchange: exchange || '',
    verdict: ['AL','BEKLE','UZAK_DUR',''].includes(verdict) ? verdict : '',
    content: content.trim().substring(0, 2000),
    createdAt: Date.now(),
    likes: 0,
  };
  try {
    const kv = await getKV();
    if (!kv) return res.status(200).json({ success: true, post: newPost, warning: 'KV not configured, post not persisted' });
    const existing = await kv.get(KEY) || [];
    existing.unshift(newPost);
    await kv.set(KEY, existing.slice(0, 200)); // max 200 posts
    return res.status(200).json({ success: true, post: newPost });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function deletePost(id, res) {
  try {
    const kv = await getKV();
    if (!kv) return res.status(404).json({ error: 'KV not configured' });
    const existing = await kv.get(KEY) || [];
    await kv.set(KEY, existing.filter(p => p.id !== id));
    return res.status(200).json({ success: true });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

function getDemo() {
  return [
    {
      id:'demo_1', nickname:'Barış | Investing', ticker:'THYAO', exchange:'BIST', verdict:'AL',
      content:'THY global expansion devam ediyor. 2026 yolcu kapasitesi hedefleri tutarlı şekilde dolduruluyor. Düşen yakıt maliyetleri marjı destekliyor. Uzun vadede AL görüşüm devam ediyor.',
      createdAt: Date.now()-86400000*2, likes:12
    },
    {
      id:'demo_2', nickname:'Yatırımcı1', ticker:'NVDA', exchange:'NASDAQ', verdict:'BEKLE',
      content:'NVDA valüasyonu hâlâ yüksek. Data center büyümesi süiyor ama P/E 60x üzerinde. Geri çekilmelerde alım fırsatı olabilir. Şu an bekle diyen Buffett çerçevesi mantıklı.',
      createdAt: Date.now()-86400000, likes:5
    },
  ];
}
