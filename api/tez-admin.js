// /api/tez-admin.js — Tez CRUD (admin) + Public tez okuma + Görsel upload
// GET /api/tez-admin                    → admin: tüm tezler (auth gerekli)
// GET /api/tez-admin?pub=1&id=X         → public: tek tez
// GET /api/tez-admin?pub=1&ticker=MPARK → public: ticker'a göre tez
// GET /api/tez-admin?pub=1              → public: tüm yayındaki tezler
// GET /api/tez-admin?price=1&ticker=..  → public: anlık fiyat proxy
// POST /api/tez-admin?action=upload_image → admin: görsel upload (base64)
// POST/PUT/DELETE                        → admin CRUD (auth gerekli)

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET    = process.env.ADMIN_SECRET;
const STORAGE_BUCKET  = process.env.TEZ_STORAGE_BUCKET || 'tez-kapaklari';

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

  // ── PRICE PROXY (auth gerekmez) — CORS bypass için ──────────
  if (req.method === 'GET' && req.query.price) {
    const tk = (req.query.ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const ex = req.query.exchange || 'BIST';
    if (!tk) return res.status(400).json({ error: 'ticker gerekli' });
    const sym = ex === 'BIST' ? tk + '.IS' : tk;
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
      );
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice ?? null;
      const prev = meta?.chartPreviousClose || meta?.previousClose;
      const change = (price && prev) ? ((price - prev) / prev * 100) : null;
      return res.status(200).json({ price, change, sym });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

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

  // ── GÖRSEL UPLOAD (admin) ─────────────────────────────────────
  // POST /api/tez-admin?action=upload_image
  // body: { filename, base64 }  (base64 = "data:image/png;base64,...")
  if (req.method === 'POST' && req.query.action === 'upload_image') {
    try {
      const { filename, base64 } = req.body || {};
      if (!filename || !base64) {
        return res.status(400).json({ error: 'filename ve base64 zorunlu' });
      }

      // data URI'dan mime type + raw base64 çıkar
      const m = base64.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Geçersiz base64 (data URI bekleniyor)' });
      const mime = m[1];
      const raw  = m[2];
      const buf  = Buffer.from(raw, 'base64');

      // Uzantı: filename'dan al, yoksa mime'dan türet
      const extFromName = (filename.match(/\.([a-zA-Z0-9]+)$/) || [])[1];
      const extFromMime = mime.split('/')[1];
      const ext = (extFromName || extFromMime || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');

      // Güvenli ve benzersiz path
      const stamp = Date.now();
      const slug  = filename
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 40) || 'kapak';
      const path = `${stamp}-${slug}.${ext}`;

      // Supabase Storage'a yükle
      const upUrl = `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`;
      const upRes = await fetch(upUrl, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': mime,
          'x-upsert': 'true',
        },
        body: buf,
      });

      if (!upRes.ok) {
        const errTxt = await upRes.text();
        return res.status(500).json({
          error: 'Storage upload başarısız',
          detail: errTxt,
          status: upRes.status,
          bucket: STORAGE_BUCKET,
        });
      }

      // Public URL
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${path}`;
      return res.status(200).json({ url: publicUrl, path, bucket: STORAGE_BUCKET });

    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
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
    if (!body.kategori) body.kategori = 'tez'; // 'tez' | 'arastirma'
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
