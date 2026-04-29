// /api/tez-admin.js — Admin tez CRUD + image upload endpoint
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// Supabase Storage bucket adı — Supabase dashboard'da "tez-gorseller" bucket oluştur (public)
const BUCKET = 'tez-gorseller';

export const config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Admin auth
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

  // ── IMAGE UPLOAD ──────────────────────────────────────────────
  // POST /api/tez-admin?action=upload_image
  // Body: { filename: "kapak.jpg", base64: "data:image/jpeg;base64,..." }
  if (req.method === 'POST' && req.query.action === 'upload_image') {
    try {
      const { filename, base64 } = req.body;
      if (!base64 || !filename) return res.status(400).json({ error: 'filename ve base64 gerekli' });

      // data:image/jpeg;base64,XXXX → buffer
      const match = base64.match(/^data:([a-zA-Z0-9+/]+\/[a-zA-Z0-9+/]+);base64,(.+)$/);
      if (!match) return res.status(400).json({ error: 'Geçersiz base64 format' });

      const mimeType   = match[1];
      const buffer     = Buffer.from(match[2], 'base64');
      const ext        = filename.split('.').pop().toLowerCase() || 'jpg';
      const uniqueName = `kapak_${Date.now()}.${ext}`;

      // Supabase Storage upload
      const uploadHeaders = {
        apikey:          SUPABASE_KEY,
        Authorization:   `Bearer ${SUPABASE_KEY}`,
        'Content-Type':  mimeType,
        'Cache-Control': '3600',
        'x-upsert':      'true',
      };

      const uploadRes = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${uniqueName}`,
        { method: 'POST', headers: uploadHeaders, body: buffer }
      );

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        return res.status(500).json({ error: 'Upload hatası: ' + err });
      }

      // Public URL
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${uniqueName}`;
      return res.status(200).json({ url: publicUrl });

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET — tüm tezleri getir ────────────────────────────────────
  if (req.method === 'GET') {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?order=olusturma.desc&select=*`, { headers });
    return res.status(200).json(await r.json());
  }

  // ── POST — yeni tez oluştur ────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body;
    body.guncelleme = new Date().toISOString();
    body.olusturma  = new Date().toISOString();
    if (!body.slug) body.slug = body.baslik.toLowerCase().replace(/[^a-z0-9ğüşıöç]+/gi, '-').replace(/(^-|-$)/g, '');
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler`, {
      method: 'POST', headers,
      body: JSON.stringify(body)
    });
    return res.status(200).json(await r.json());
  }

  // ── PUT — tez güncelle ─────────────────────────────────────────
  if (req.method === 'PUT') {
    const { id, ...body } = req.body;
    body.guncelleme = new Date().toISOString();
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify(body)
    });
    return res.status(200).json(await r.json());
  }

  // ── DELETE — tez sil ──────────────────────────────────────────
  if (req.method === 'DELETE') {
    const { id } = req.body;
    await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}`, { method: 'DELETE', headers });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
