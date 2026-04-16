// /api/tez-admin.js — Admin tez CRUD endpoint
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Admin auth kontrolü
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };

  // GET — tüm tezleri getir
  if (req.method === 'GET') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?order=olusturma.desc&select=*`, { headers });
    return res.status(200).json(await r.json());
  }

  // POST — yeni tez oluştur
  if (req.method === 'POST') {
    const body = req.body;
    body.guncelleme = new Date().toISOString();
    body.olusturma  = new Date().toISOString();
    if (!body.slug) body.slug = body.baslik.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler`, {
      method: 'POST', headers,
      body: JSON.stringify(body)
    });
    return res.status(200).json(await r.json());
  }

  // PUT — tez güncelle
  if (req.method === 'PUT') {
    const { id, ...body } = req.body;
    body.guncelleme = new Date().toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify(body)
    });
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
