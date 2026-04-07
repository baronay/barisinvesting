// /api/forum.js — Vercel KV destekli kalıcı forum
const FORUM_KEY = 'barisinvesting:forum:posts';
const MAX_POSTS = 200;

async function kvGet(key) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const j = await r.json();
    return j?.result ?? null;
  } catch { return null; }
}

async function kvSet(key, value) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return false;
  try {
    await fetch(`${url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    return true;
  } catch { return false; }
}

let memPosts = [];

async function getPosts() {
  const raw = await kvGet(FORUM_KEY);
  if (raw) { try { return JSON.parse(raw); } catch { return []; } }
  return memPosts;
}

async function savePosts(posts) {
  const ok = await kvSet(FORUM_KEY, JSON.stringify(posts));
  if (!ok) memPosts = posts;
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed = !origin || origin.includes('barisinvesting.com') || origin.includes('vercel.app') || origin.includes('localhost');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? (origin || '*') : 'https://www.barisinvesting.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  if (req.method === 'GET' && action === 'list') {
    const posts = await getPosts();
    return res.status(200).json({ posts: posts.slice(0, 50), total: posts.length });
  }

  if (req.method === 'POST' && action === 'post') {
    const { author, content, ticker, framework } = req.body || {};
    if (!content || content.trim().length < 5) return res.status(400).json({ error: 'İçerik çok kısa' });
    if (content.length > 1000) return res.status(400).json({ error: 'Mesaj 1000 karakterden uzun olamaz' });
    const posts = await getPosts();
    const newPost = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      author: (author || 'Anonim').substring(0, 30).replace(/[<>]/g, ''),
      content: content.trim().substring(0, 1000).replace(/[<>]/g, ''),
      ticker: ticker ? ticker.substring(0, 10).toUpperCase() : null,
      framework: framework || null,
      ts: Date.now(),
      likes: 0,
    };
    posts.unshift(newPost);
    if (posts.length > MAX_POSTS) posts.splice(MAX_POSTS);
    await savePosts(posts);
    return res.status(200).json({ post: newPost, total: posts.length });
  }

  if (req.method === 'POST' && action === 'like') {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'ID gerekli' });
    const posts = await getPosts();
    const idx = posts.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: 'Post bulunamadı' });
    posts[idx].likes = (posts[idx].likes || 0) + 1;
    await savePosts(posts);
    return res.status(200).json({ likes: posts[idx].likes });
  }

  return res.status(400).json({ error: 'Geçersiz istek' });
}
