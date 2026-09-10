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

      /* ── E-POSTA DUVARI ──────────────────────────────────────────
         İçeriğin girişi herkese açık, gerisi kayıtlı okura. Kesme
         sunucuda yapılıyor: istemci tarafında gizlemek, metni yine de
         ağdan indirip DOM'a koymak demekti — hem duvar delik olurdu
         hem 30-40 KB gövde boşuna inerdi. Kimlik bu uygulamada zaten
         e-posta: users tablosunda kaydı varsa tam metin gider. */
      const okur = await kayitliOkur(headers, req.query.email);
      res.setHeader('Cache-Control', 'private, no-store');   // kilitli/açık sürüm CDN'de karışmasın
      if (!okur) {
        const tam = String(tez.icerik || '');
        // Haber kısa yazılıyor: tez bütçesiyle kesilse çoğu haber hiç
        // kilitlenmez, duvar sadece uzun tezlerde çalışırdı.
        const butce = tez.kategori === 'haber' ? 420 : 950;
        const onizleme = htmlOnizleme(tam, butce);
        tez.kilit = onizleme.kesildi;
        if (onizleme.kesildi) {
          tez.icerik = onizleme.html;
          tez.kilitli_guncelleme = tez.guncellemeler.length;
          // Güncellemelerin başlığı/tarihi kalsın (neyin beklediği görünsün), gövdesi gitsin
          tez.guncellemeler = tez.guncellemeler.map(g => ({
            id: g.id, tez_id: g.tez_id, baslik: g.baslik, tarih: g.tarih,
            tur: g.tur, sinyal: g.sinyal, fiyat: g.fiyat, kilit: true, icerik: null,
            // Görsel kalsın: ana sayfa listesinde zaten herkese açık
            // (son_guncelleme_bilgi.gorsel); okuma sayfasının kapağı buradan geliyor.
            gorsel: g.gorsel || null,
          }));
        }
      }
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
    const listCols = 'id,kategori,ticker,sinyal,baslik,ozet,kapak_gorseli,olusturma,maliyet_fiyat,exchange,durum,ozet_fark';
    /* İki sorgu PARALEL: güncelleme rozetleri liste gelmeden de çekilebilir.
       Art arda beklemek soğuk isteği gereksiz yere ikiye katlıyordu
       (ölçüldü: soğuk yanıt ~2,0 sn). */
    const GU = `${SUPABASE_URL}/rest/v1/tez_guncellemeler?yayinda=eq.true&order=tarih.desc&select=`;
    const [r, grIlk] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc&select=${listCols}`, { headers }),
      fetch(GU + 'tez_id,tarih,baslik,tur,gorsel,sinyal', { headers }).catch(() => null),
    ]);
    const list = await r.json();

    // Kartlarda "N guncelleme" rozeti icin ozet bilgi — govde cekilmez
    if (Array.isArray(list) && list.length) {
      try {
        let gr = grIlk;
        // gorsel sutunu henuz eklenmediyse rozetler tamamen kaybolmasin
        if (!gr || !gr.ok) gr = await fetch(GU + 'tez_id,tarih,baslik,tur,sinyal', { headers });
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

    /* CDN kenar cache. Eskiden s-maxage=30 idi: her 30 saniyede bir
       ziyaretçi soğuk isteği (~2 sn) sırtlıyor ve "yükleniyor" yazısını
       o kadar süre görüyordu. stale-while-revalidate ile artık bayat
       sürüm anında veriliyor, tazeleme arkada yapılıyor; yeni içerik
       en geç bir sonraki ziyaretçide görünür. */
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=86400');
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

  /* ── "3 DAKİKADA TEZ" ÖZETİ (admin) ───────────────────────────
     POST /api/tez-admin?action=ozet_uret   body: { id }

     Özet için ayrıca yazı yazmak yeni bir iş yükü olurdu; bu uç tezin
     KENDİ gövdesini okuyup beş satırı çıkarıyor — boğa, ayı, "benim
     farkım", fiyat bandı ve tezin kırıldığı eşik. Hepsi metinde zaten
     var, yalnızca yüzeye çıkarılıyor. Sonuç tabloda saklanıyor, her
     okuyucuda yeniden üretilmiyor.

     NOT: Önce ayrı dosya (api/tez-ozet.js) olarak yazılmıştı ama Vercel
     Hobby planı dağıtım başına 12 fonksiyona izin veriyor; 13. dosya
     derlemeyi düşürdü. Bu yüzden tez CRUD'unun yanına alındı. */
  if (req.method === 'POST' && req.query.action === 'ozet_uret') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY eksik' });
    const idNum = String(req.body?.id || '').replace(/[^0-9]/g, '');
    if (!idNum) return res.status(400).json({ error: 'id gerekli' });

    // Gövdeyi düz metne indir: model yazının kendisini okusun, işaretlemeyi değil
    const duzMetin = (html) => String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<head[\s\S]*?<\/head>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ').trim();

    try {
      const tr = await fetch(
        `${SUPABASE_URL}/rest/v1/tezler?id=eq.${idNum}&select=id,ticker,baslik,ozet,icerik,exchange,olusturma`,
        { headers });
      const tez = (await tr.json())?.[0];
      if (!tez) return res.status(404).json({ error: 'Tez bulunamadı' });

      const govde = duzMetin(tez.icerik).slice(0, 45000);
      if (govde.length < 400) return res.status(400).json({ error: 'Tez metni özet için fazla kısa' });

      /* Güncellemeler de özete girsin: tez canlı bir belge, yazar bir
         iddiasını geri çekmiş ya da bandını değiştirmiş olabilir. Yalnız
         ilk metni okuyan model geri çekilmiş bir tezi hâlâ geçerliymiş
         gibi yazıyordu (AVGO/17: "kilitli duopol" iddiası güncellemede
         geri çekilmesine rağmen kutuda duruyordu — üstelik özet
         güncellemeden SONRA üretilmişti, yani sorun tekrar üretmemek
         değil, güncellemenin modele hiç gitmemesiydi).
         Bütçe aşılırsa en ESKİ güncellemeler düşer: kutuyu belirleyen
         taraf en yenisi. */
      const guncellemeler = await fetchGuncellemeler(headers, idNum, true);
      const guncParcalar = [];
      let guncButce = 24000;
      for (let i = guncellemeler.length - 1; i >= 0; i--) {
        const g = guncellemeler[i];
        const parca = [
          `[${i + 1}] ${String(g.tarih || '').slice(0, 10)} · ${g.tur || 'not'}` +
            `${g.sinyal ? ` · sinyal: ${g.sinyal}` : ''}${g.fiyat != null ? ` · fiyat: ${g.fiyat}` : ''}`,
          `BAŞLIK: ${g.baslik || ''}`,
          duzMetin(g.icerik).slice(0, 8000),
        ].join('\n');
        if (parca.length > guncButce) break;
        guncParcalar.unshift(parca);
        guncButce -= parca.length;
      }
      const guncMetin = guncParcalar.join('\n\n');

      const sistem = [
        'Sen Barış Investing\'in editörüsün. Sana verilen yatırım tezinin KENDİ İÇİNDEKİ bilgiyi kullanarak "3 dakikada tez" kutusunu hazırlıyorsun.',
        '',
        'KURALLAR',
        '- Metinde olmayan hiçbir şey yazma. Rakam uydurma, tahmin ekleme.',
        '- Yazarın ağzından, birinci tekil şahısla yaz ("izliyorum", "tartıştığım şey…").',
        '- Her satır TEK cümle, en fazla 25 kelime. Süs yok, doğrudan söyle.',
        '- Metinde bir alanın karşılığı gerçekten yoksa o satıra sadece "—" yaz.',
        '- Türkçe yaz.',
        '- Tez canlı bir belge: ilk metinden sonra yayımlanan güncellemeler onu günceller. Bir konuda ilk metin ile güncelleme çelişiyorsa GÜNCELLEME geçerlidir.',
        '- Kutu yazarın BUGÜNKÜ görüşünü anlatmalı: güncellemede geri çekilmiş bir iddiayı hâlâ geçerliymiş gibi yazma, değişmiş bir fiyat bandını eski hâliyle verme.',
        '',
        'BİÇİM (tam olarak bu beş satır, başka hiçbir şey yazma):',
        'BOGA: [tezin çalışması için gereken şey — piyasanın da gördüğü iyimser taraf]',
        'AYI: [en ciddi karşı argüman, tezin en zayıf yeri]',
        'FARK: [yazarın piyasadan/konsensüsten ayrıştığı nokta — "benim farkım" budur]',
        'FIYAT: [metinde geçen izleme/giriş/hedef bandı; yoksa "—"]',
        'KIRILMA: [tezi çürütecek somut eşik: hangi metrik, hangi seviyeye gelirse]',
      ].join('\n');

      const istek = [
        `ŞİRKET: ${tez.ticker || '—'} (${tez.exchange || '—'})`,
        `BAŞLIK: ${tez.baslik || ''}`,
        tez.ozet ? `GİRİŞ: ${tez.ozet}` : '',
        '',
        `İLK TEZ METNİ${tez.olusturma ? ` (${String(tez.olusturma).slice(0, 10)})` : ''}:`,
        govde,
        ...(guncMetin ? ['', 'SONRAKİ GÜNCELLEMELER (eskiden yeniye — çelişki olursa EN YENİSİ geçerlidir):', guncMetin] : []),
      ].join('\n');

      const ac = new AbortController();
      const zamanlayici = setTimeout(() => ac.abort(), 40000);
      let ai;
      try {
        ai = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: process.env.OZET_MODEL || 'claude-sonnet-5',
            max_tokens: 700,
            thinking: { type: 'disabled' },
            system: sistem,
            messages: [{ role: 'user', content: istek }],
          }),
          signal: ac.signal,
        });
      } finally { clearTimeout(zamanlayici); }

      const d = await ai.json();
      if (!ai.ok || d.error) return res.status(502).json({ error: `AI hatası: ${d?.error?.type || ai.status}` });

      const metin = (d.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
      const ALAN = { BOGA: 'ozet_boga', AYI: 'ozet_ayi', FARK: 'ozet_fark', FIYAT: 'ozet_fiyat', KIRILMA: 'ozet_kirilma' };
      const alanlar = {};
      for (const anahtar of Object.keys(ALAN)) {
        const m = metin.match(new RegExp('^' + anahtar + ':\\s*([^\\n]+)', 'm'));
        if (m) alanlar[ALAN[anahtar]] = m[1].trim().slice(0, 400);
      }
      if (!Object.keys(alanlar).length) {
        return res.status(502).json({ error: 'Özet ayrıştırılamadı', ham: metin.slice(0, 300) });
      }
      alanlar.ozet_tarih = new Date().toISOString();

      const kaydet = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${idNum}`, {
        method: 'PATCH', headers, body: JSON.stringify(alanlar),
      });
      if (!kaydet.ok) return res.status(500).json({ error: 'Kaydedilemedi', detay: (await kaydet.text()).slice(0, 200) });
      return res.status(200).json({ ok: true, ozet: alanlar, guncelleme_sayisi: guncParcalar.length });
    } catch (e) {
      const zamanAsimi = e.name === 'AbortError' || e.name === 'TimeoutError';
      return res.status(zamanAsimi ? 504 : 500).json({ error: zamanAsimi ? 'Süre doldu, tekrar dene' : e.message });
    }
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

// ── E-posta duvarı yardımcıları ─────────────────────────────────

/* Okur kayıtlı mı? users tablosunda e-posta varsa evet.
   Şifre/oturum yok — bu uygulamada kimlik zaten e-posta. */
async function kayitliOkur(headers, email) {
  const em = String(email || '').toLowerCase().trim();
  if (!em || !em.includes('@') || em.length > 200) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(em)}&select=email&limit=1`,
      { headers }
    );
    if (!r.ok) return false;
    const d = await r.json();
    return Array.isArray(d) && d.length > 0;
  } catch (_) {
    return false;   // doğrulayamıyorsak duvar kapalı kalsın
  }
}

/* HTML'i etiket bütünlüğünü bozmadan kes.

   Tezler tam bir HTML belgesi olarak yapıştırılıyor: <head> içinde ~7 KB
   <style>, ardından <article> içinde onlarca <section>. Bu yüzden kesim
   iki şeye dikkat ediyor:
   1) Bütçe yalnızca OKUNAN metni sayıyor — <style>/<script> içeriği
      sayılsaydı önizleme daha ilk paragrafa gelmeden dolardı.
   2) Kesim noktasında açık kalan tüm ataların kapanış etiketleri
      ekleniyor; yoksa <article>/<section> yarım kalır, sayfanın kalan
      düzeni bozulurdu.
   Kesim her zaman bir blok öğesinin (p, section, table…) bitiminde. */
function htmlOnizleme(html, butce) {
  if (!html) return { html: '', kesildi: false };
  const BOS  = new Set(['br','hr','img','input','meta','link','source','col','area','base','embed','track','wbr']);
  const ATLA = new Set(['style','script','head','title']);       // metni okunmuyor
  const AKIS = new Set(['p','section','article','h1','h2','h3','h4','ul','ol','table','blockquote','figure','div','pre']);
  // Yorum blokları da eşleşsin: eşleşmezlerse metin sayılıp bütçeyi
  // yiyorlardı (ölçüldü: bir tezde 390 karakterlik ayraç yorumları
  // önizlemeyi 563 karaktere düşürmüştü).
  const etiket = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;

  const yigin = [];
  let metin = 0, i = 0, atla = 0, kes = -1, m;
  while ((m = etiket.exec(html)) !== null) {
    // Bütçe okunan metne göre: kaynaktaki girinti/satır sonları ham
    // uzunluğa dahil olunca güzel biçimlendirilmiş tezlerde önizleme
    // yarı yarıya kısalıyordu (ölçüldü: 495 karakterde kesilen tez).
    if (!atla) metin += html.slice(i, m.index).replace(/\s+/g, ' ').length;
    i = etiket.lastIndex;
    if (!m[1]) continue;                       // yorum bloğu: atlandı, sayılmadı
    const ad = m[1].toLowerCase();
    const kapanis = m[0][1] === '/';
    if (m[2] === '/' || BOS.has(ad)) continue;
    if (kapanis) {
      if (ATLA.has(ad) && atla) atla--;
      for (let k = yigin.length - 1; k >= 0; k--) {
        if (yigin[k] === ad) { yigin.length = k; break; }
      }
      // Bütçe dolduysa ve hâlâ bir kabın (article/body) içindeysek burada kes
      if (metin >= butce && AKIS.has(ad) && yigin.length) { kes = etiket.lastIndex; break; }
    } else {
      if (ATLA.has(ad)) atla++;
      yigin.push(ad);
    }
  }

  if (kes < 0) {
    // Etiketsiz düz metin: kelime sınırında kes
    if (!/<[a-zA-Z]/.test(html) && html.length > butce * 1.5) {
      const p = html.lastIndexOf(' ', butce);
      return { html: html.slice(0, p > 0 ? p : butce), kesildi: true };
    }
    return { html, kesildi: false };
  }
  const kapat = yigin.slice().reverse().map(t => `</${t}>`).join('');
  return { html: html.slice(0, kes) + kapat, kesildi: true };
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
