// /api/tez-admin.js — Tez CRUD (admin) + Public tez okuma
// GET /api/tez-admin                    → admin: tüm tezler (auth gerekli)
// GET /api/tez-admin?pub=1&id=X         → public: tek tez
// GET /api/tez-admin?pub=1&ticker=MPARK → public: ticker'a göre tez
// GET /api/tez-admin?pub=1              → public: tüm yayındaki tezler
// POST/PUT/DELETE                        → admin CRUD (auth gerekli)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // ── PUBLIC OKUMA (auth gerekmez) ──────────────────────────────
  if (req.method === 'GET' && req.query.pub) {
    const { id, ticker } = req.query;

    if (id) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}&yayinda=eq.true&select=*`, { headers });
      const data = await r.json();
      return res.status(200).json(data?.[0] || null);
    }

    if (ticker) {
      const t = ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/tezler?ticker=eq.${t}&yayinda=eq.true&select=id,baslik,sinyal,ozet,olusturma,maliyet_fiyat,exchange&limit=1`,
        { headers }
      );
      const data = await r.json();
      return res.status(200).json(data?.[0] || null);
    }

    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc&select=*`, { headers });
    return res.status(200).json(await r.json());
  }

  // ── ADMIN AUTH ────────────────────────────────────────────────
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  // GET — admin tüm tezler
  if (req.method === 'GET') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?order=olusturma.desc&select=*`, { headers });
    return res.status(200).json(await r.json());
  }

  // POST — yeni tez
  if (req.method === 'POST') {
    const body = req.body;
    body.guncelleme = new Date().toISOString();
    if (!body.olusturma) body.olusturma = new Date().toISOString();
    if (!body.slug) body.slug = body.baslik.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').replace(/(^-|-$)/g, '');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler`, { method: 'POST', headers, body: JSON.stringify(body) });
    return res.status(200).json(await r.json());
  }

  // PUT — tez güncelle
  if (req.method === 'PUT') {
    const { id, ...body } = req.body;
    body.guncelleme = new Date().toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    return res.status(200).json(await r.json());
  }

  // DELETE — tez sil
  if (req.method === 'DELETE') {
    const { id } = req.body;
    await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}`, { method: 'DELETE', headers });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
