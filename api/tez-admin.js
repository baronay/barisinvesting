// /api/tez-admin.js — Tez CRUD (admin) + Public tez okuma + Görsel upload
// GET /api/tez-admin                    → admin: tüm tezler (auth gerekli)
// GET /api/tez-admin?pub=1&id=X         → public: tek tez (+ guncellemeler dizisi)
// GET /api/tez-admin?pub=1&ticker=MPARK → public: ticker'a göre tez
// GET /api/tez-admin?pub=1              → public: tüm yayındaki tezler (+ guncelleme sayısı/son tarih)
// GET /api/tez-admin?price=1&ticker=..  → public: anlık fiyat proxy
// GET /api/tez-admin?entity=guncelleme&tez_id=X → admin: bir tezin tüm güncellemeleri (taslaklar dahil)
// POST /api/tez-admin?action=upload_image → admin: görsel upload (base64)
// POST/PUT/DELETE?entity=guncelleme      → admin: güncelleme CRUD
// POST/PUT/DELETE                        → admin tez CRUD (auth gerekli)

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
      const idNum = String(id).replace(/[^0-9]/g, '');   // PostgREST filtre injection'i engelle
      if (!idNum) return res.status(400).json({ error: 'gecersiz id' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${idNum}&yayinda=eq.true&select=*`, { headers });
      const data = await r.json();
      const tez = data?.[0] || null;
      if (!tez) return res.status(200).json(null);
      // Pozisyon geçmişi — yayındaki güncellemeler, eskiden yeniye
      tez.guncellemeler = await fetchGuncellemeler(headers, idNum, true);
      return res.status(200).json(tez);
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

    // Liste kartlari sadece ozet alanlarini kullanir — tez govdesini (icerik) cekme, payload kucuk kalsin
    const listCols = 'id,kategori,ticker,sinyal,baslik,ozet,kapak_gorseli,olusturma,maliyet_fiyat,exchange';
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc&select=${listCols}`, { headers });
    const list = await r.json();

    // Kartlarda "N guncelleme" rozeti icin ozet bilgi — tek ek sorgu, govde cekilmez
    if (Array.isArray(list) && list.length) {
      try {
        const GU = `${SUPABASE_URL}/rest/v1/tez_guncellemeler?yayinda=eq.true&order=tarih.desc&select=`;
        let gr = await fetch(GU + 'tez_id,tarih,baslik,tur,gorsel,sinyal', { headers });
        // gorsel sutunu henuz eklenmediyse rozetler tamamen kaybolmasin
        if (!gr.ok) gr = await fetch(GU + 'tez_id,tarih,baslik,tur,sinyal', { headers });
        const gs = await gr.json();
        if (Array.isArray(gs)) {
          const byTez = {};
          for (const g of gs) {
            const k = g.tez_id;
            if (!byTez[k]) byTez[k] = { n: 0, son: null };
            byTez[k].n++;
            // order=tarih.desc geldigi icin ilk gorulen en yenisi
            if (!byTez[k].son || g.tarih > byTez[k].son.tarih) byTez[k].son = g;
          }
          for (const t of list) {
            const s = byTez[t.id];
            t.guncelleme_sayisi = s ? s.n : 0;
            t.son_guncelleme    = s ? s.son.tarih : null;
            t.son_guncelleme_bilgi = s ? {
              baslik: s.son.baslik,
              tur:    s.son.tur,
              gorsel: s.son.gorsel || null,
              sinyal: s.son.sinyal || null,
            } : null;
          }
        }
      } catch (_) { /* guncelleme tablosu yoksa liste yine calissin */ }
    }

    // CDN kenar cache: tekrar acilislar aninda gelsin, yeni tez ~30sn'de yansisin
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=120');
    return res.status(200).json(list);
  }

  // ── ADMIN AUTH ────────────────────────────────────────────────
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Yetkisiz' });
  }

  // ── TEZ GÜNCELLEMELERİ (admin CRUD) ───────────────────────────
  // ?entity=guncelleme  →  GET (tez_id ile) / POST / PUT / DELETE
  if (req.query.entity === 'guncelleme') {
    const GT = `${SUPABASE_URL}/rest/v1/tez_guncellemeler`;

    if (req.method === 'GET') {
      const tezId = String(req.query.tez_id || '').replace(/[^0-9]/g, '');
      if (!tezId) return res.status(400).json({ error: 'tez_id gerekli' });
      return res.status(200).json(await fetchGuncellemeler(headers, tezId, false));
    }

    if (req.method === 'POST') {
      const body = normalizeGuncelleme(req.body || {});
      if (!body.tez_id)  return res.status(400).json({ error: 'tez_id zorunlu' });
      if (!body.baslik)  return res.status(400).json({ error: 'baslik zorunlu' });
      body.olusturma = new Date().toISOString();
      let r = await fetch(GT, { method: 'POST', headers, body: JSON.stringify(body) });
      // gorsel sutunu henuz eklenmediyse kayit tamamen kirilmasin — o alan olmadan tekrar dene
      if (!r.ok && 'gorsel' in body) {
        const { gorsel, ...gorselsiz } = body;
        r = await fetch(GT, { method: 'POST', headers, body: JSON.stringify(gorselsiz) });
      }
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'kayit basarisiz', detail: data });
      await syncTezSinyal(headers, body);
      return res.status(200).json(data);
    }

    if (req.method === 'PUT') {
      const gid = String(req.body?.id || '').replace(/[^0-9]/g, '');
      if (!gid) return res.status(400).json({ error: 'id gerekli' });
      const body = normalizeGuncelleme(req.body || {});
      delete body.id;
      let r = await fetch(`${GT}?id=eq.${gid}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
      if (!r.ok && 'gorsel' in body) {
        const { gorsel, ...gorselsiz } = body;
        r = await fetch(`${GT}?id=eq.${gid}`, { method: 'PATCH', headers, body: JSON.stringify(gorselsiz) });
      }
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: 'guncelleme basarisiz', detail: data });
      await syncTezSinyal(headers, body);
      return res.status(200).json(data);
    }

    if (req.method === 'DELETE') {
      const gid = String(req.body?.id || '').replace(/[^0-9]/g, '');
      if (!gid) return res.status(400).json({ error: 'id gerekli' });
      await fetch(`${GT}?id=eq.${gid}`, { method: 'DELETE', headers });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
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
    // Kategori beyaz listesi: yanlis yazilan bir deger icerigi hicbir
    // bolumde gostermiyordu (liste filtreleri tam esitlik ariyor).
    const KATEGORILER = ['tez', 'arastirma', 'haber'];
    if (!KATEGORILER.includes(body.kategori)) body.kategori = 'tez';
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

// ── Güncelleme yardımcıları ─────────────────────────────────────

const GUNC_TURLER = ['bilanco', 'haber', 'revizyon', 'fiyat', 'kapanis', 'not'];
const SINYALLER   = ['AL', 'IZLE', 'NOTR', 'KACIN'];

// Bir tezin güncellemeleri — eskiden yeniye (zaman çizelgesi sırası)
async function fetchGuncellemeler(headers, tezId, sadeceYayinda) {
  try {
    const filtre = sadeceYayinda ? '&yayinda=eq.true' : '';
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tez_guncellemeler?tez_id=eq.${tezId}${filtre}&order=tarih.asc,id.asc&select=*`,
      { headers }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch (_) {
    return []; // tablo henüz yoksa tez yine açılsın
  }
}

// Gelen gövdeyi güvenli alanlara indirger
function normalizeGuncelleme(b) {
  const out = {};
  if (b.tez_id != null) out.tez_id = parseInt(String(b.tez_id).replace(/[^0-9]/g, ''), 10) || null;
  if (b.baslik  != null) out.baslik  = String(b.baslik).slice(0, 300);
  if (b.icerik  != null) out.icerik  = b.icerik ? String(b.icerik) : null;
  if (b.gorsel  !== undefined) out.gorsel = b.gorsel ? String(b.gorsel).slice(0, 500) : null;
  if (b.tur     != null) out.tur     = GUNC_TURLER.includes(b.tur) ? b.tur : 'not';
  if (b.sinyal  !== undefined) out.sinyal = SINYALLER.includes(b.sinyal) ? b.sinyal : null;
  if (b.fiyat   !== undefined) {
    const f = parseFloat(b.fiyat);
    out.fiyat = Number.isFinite(f) ? f : null;
  }
  if (b.yayinda != null) out.yayinda = !!b.yayinda;
  if (b.tarih) {
    const d = new Date(b.tarih);
    out.tarih = isNaN(d) ? new Date().toISOString() : d.toISOString();
  }
  return out;
}

// Güncelleme yeni bir sinyal taşıyorsa tezin güncel sinyalini de aynı yere çek
async function syncTezSinyal(headers, g) {
  if (!g.sinyal || !g.tez_id || g.yayinda === false) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${g.tez_id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ sinyal: g.sinyal, guncelleme: new Date().toISOString() }),
    });
  } catch (_) { /* sinyal senkronu kritik değil */ }
}
