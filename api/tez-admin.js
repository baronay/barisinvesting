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

  /* ── SUNUCU TARAFI META (X / WhatsApp / Telegram kartları) ────────
     /tez/:id isteği vercel.json üzerinden buraya yönleniyor. app.html
     olduğu gibi dönüyor; yalnızca <head> içindeki başlık, açıklama ve
     paylaşım etiketleri o yazının bilgileriyle değiştiriliyor.

     Neden sunucuda: paylaşım botları JavaScript çalıştırmıyor. SPA
     başlığı istemcide yazdığı için her tez linki aynı genel kartı
     gösteriyordu.

     Neden ayrı bir fonksiyon dosyası değil: Hobby planında 12 fonksiyon
     sınırı dolu (api/ altında tam 12 dosya var), 13.'sü dağıtımı kırar.

     Etiketler <head>'in EN BAŞINA giriyor: app.html'in head'i ~40 KB
     CSS taşıyor, botların çoğu belgenin ilk parçasını okuyup kesiyor. */
  if (req.method === 'GET' && req.query.html) {
    const kabuk = await appKabugu();
    const idNum = String(req.query.id || '').replace(/[^0-9]/g, '');

    if (!kabuk) {
      /* Kabuk hiçbir yoldan okunamadı: sayfa yine açılsın diye statik
         dosyaya yönlendiriyoruz. Kart genel kalır ama site çalışır. */
      res.setHeader('Cache-Control', 'public, s-maxage=30');
      res.setHeader('Location', '/app.html');
      return res.status(302).end();
    }

    let tez = null;
    if (idNum) {
      try {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/tezler?id=eq.${idNum}&yayinda=eq.true`
          + `&select=id,baslik,ozet,kapak_gorseli,kategori,ticker,olusturma,tez_guncellemeler(gorsel,tarih)`,
          { headers }
        );
        if (r.ok) { const d = await r.json(); tez = d?.[0] || null; }
      } catch (_) { /* meta zenginleştirme kritik değil, kabuk yine dönüyor */ }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    /* Kenar önbelleği: aynı tez linki her tıklamada fonksiyonu
       çalıştırmasın. Güncelleme yayınlandığında kart 5 dakika içinde
       tazeleniyor, SWR sayesinde okur beklemiyor. */
    res.setHeader('Cache-Control', tez
      ? 'public, s-maxage=300, stale-while-revalidate=86400'
      : 'public, s-maxage=60');
    return res.status(200).send(tez ? metaYerlestir(kabuk, tez) : kabuk);
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

      /* ── KAPI KALDIRILDI ─────────────────────────────────────────────
         Tez, araştırma ve haber metinleri artık giriş ya da mail istemeden
         tam okunuyor. Mail yazının SONUNDAKİ abonelik kutusundan isteniyor:
         okumanın önünde değil, okur değeri gördükten sonra.

         Kilit alanları açıkça kapatılıyor — istemci hâlâ bu alanlara bakıyor,
         false görünce duvarı hiç çizmiyor. Böylece eski istemci önbelleğe
         alınmış sayfalarda da duvar açılmıyor.

         Yanıt artık herkes için aynı olduğu için private/no-store kalktı,
         normal kenar önbelleğine döndü (kapıdayken kilitli/açık sürüm
         karışmasın diye kapatılmıştı). */
      tez.kilit = false;
      tez.kilitli_guncelleme = 0;
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=86400');
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
    // Sürenin nereye gittiğini ölçmek için: cache ıskası ~800 ms sürüyor
    // ama fonksiyonu Frankfurt'a taşımak değiştirmedi. Server-Timing ile
    // Supabase'e giden kısmı ayrı görüyoruz (yanıt başlığında db;dur=...).
    /* TEK SORGU: güncellemeler gömülü geliyor (tez_guncellemeler'in tezler'e
       FK'si var). Ölçüldü: iki istek paralel atılmasına rağmen ikincisi
       ısrarla ~370 ms'de bitiyordu, ilki 131-234 ms'de — ikinci istek
       Supabase tarafında sıra bekliyor görünüyordu. Tek round-trip bunu
       ortadan kaldırıyor. Gömülü sorgu çalışmazsa (ilişki adı değişir,
       sütun eksilir) aşağıdaki eski iki sorgulu yola düşülüyor; hangi yolun
       kullanıldığı Server-Timing'de desc olarak görünüyor. */
    const _t0 = Date.now();
    let _yol = 'gomulu';
    const GOMULU = `${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc`
      + `&select=${listCols},tez_guncellemeler(tez_id,tarih,baslik,tur,gorsel,sinyal)`
      + `&tez_guncellemeler.yayinda=eq.true&tez_guncellemeler.order=tarih.desc`;
    let list = null, gs = null;
    try {
      const rg = await fetch(GOMULU, { headers });
      if (rg.ok) {
        const d = await rg.json();
        if (Array.isArray(d)) {
          list = d;
          gs = [];
          for (const t of list) {
            const arr = Array.isArray(t.tez_guncellemeler) ? t.tez_guncellemeler : [];
            for (const g of arr) gs.push(g.tez_id ? g : { ...g, tez_id: t.id });
            delete t.tez_guncellemeler;   // ham güncelleme listesi istemciye gitmesin
          }
        }
      }
    } catch (_) { /* eski yola düşülecek */ }

    if (!list) {
      _yol = 'ikili';
      const [r, grIlk] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc&select=${listCols}`, { headers }),
        fetch(GU + 'tez_id,tarih,baslik,tur,gorsel,sinyal', { headers }).catch(() => null),
      ]);
      list = await r.json();
      try {
        let gr = grIlk;
        // gorsel sutunu henuz eklenmediyse rozetler tamamen kaybolmasin
        if (!gr || !gr.ok) gr = await fetch(GU + 'tez_id,tarih,baslik,tur,sinyal', { headers });
        const d = await gr.json();
        if (Array.isArray(d)) gs = d;
      } catch (_) { /* guncelleme tablosu yoksa liste yine calissin */ }
    }

    // Kartlarda "N guncelleme" rozeti icin ozet bilgi — govde cekilmez
    if (Array.isArray(list) && list.length && Array.isArray(gs)) {
      const byTez = {};
      for (const g of gs) {
        const k = g.tez_id;
        if (!byTez[k]) byTez[k] = { n: 0, son: null };
        byTez[k].n++;
        // en yenisi kazansin (gomulu sorguda da tarih.desc istendi)
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

    /* CDN kenar cache. Eskiden s-maxage=30 idi: her 30 saniyede bir
       ziyaretçi soğuk isteği (~2 sn) sırtlıyor ve "yükleniyor" yazısını
       o kadar süre görüyordu. stale-while-revalidate ile artık bayat
       sürüm anında veriliyor, tazeleme arkada yapılıyor; yeni içerik
       en geç bir sonraki ziyaretçide görünür. */
    // tezler ve guncellemeler sorgulari ayri ayri: hangisi uzunsa onu
    // optimize etmek gerekiyor, ikisi paralel kostugu icin toplam degil
    // uzun olan belirleyici.
    res.setHeader('Server-Timing', `db;dur=${Date.now() - _t0};desc="${_yol}"`);
    /* s-maxage 60: once 600 denendi ama icerik guncellemeleri gec
       goruntuleniyordu — kapak degistirildi, makalede yeni gorsel cikti,
       ana sayfada 10 dakika eskisi kaldi (olculdu: liste HIT, Age 386 sn,
       icinde eski URL). Dusurmenin hiz maliyeti yok: stale-while-revalidate
       bayat kopyayi ANINDA veriyor, tazeleme arkada yapiliyor. s-maxage
       yalnizca arka plan tazelemesinin sikligini belirler, ziyaretcinin
       bekleme suresini degil. */
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=86400');
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
            `${g.sinyal ? ` · görüş: ${({ AL: 'AL', IZLE: 'İZLE', NOTR: 'TUT', KACIN: 'UZAK DUR' })[g.sinyal] || g.sinyal}` : ''}${g.fiyat != null ? ` · fiyat: ${g.fiyat}` : ''}`,
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

// ── Sunucu tarafı meta yardımcıları ─────────────────────────────

const SITE = 'https://www.barisinvesting.com';

/* app.html'i bir kez oku, sıcak lambda'da tekrar kullan.

   Üç yol sırayla deneniyor: diskten (vercel.json içindeki includeFiles
   sayesinde paketin içinde), sonra dağıtımın kendi adresinden, sonra
   canlı alan adından. Birincisi hızlı ama paketleyicinin dosyayı
   almasına bağlı; diğerleri ağ üzerinden ama her koşulda çalışıyor. */
let _kabuk = null;
async function appKabugu() {
  if (_kabuk) return _kabuk;
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const p = path.join(process.cwd(), 'app.html');
    const d = await fs.readFile(p, 'utf8');
    if (d && d.length > 1000) { _kabuk = d; return _kabuk; }
  } catch (_) {}
  for (const kok of [process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null, SITE]) {
    if (!kok) continue;
    try {
      const r = await fetch(`${kok}/app.html`);
      if (r.ok) { const d = await r.text(); if (d && d.length > 1000) { _kabuk = d; return _kabuk; } }
    } catch (_) {}
  }
  return null;
}

function attrEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Düz metne indir ve kısalt: ozet alanı HTML içerebiliyor, paylaşım
   açıklamasında etiket görünmesin. Kesim kelime sınırında. */
function metinKis(s, n) {
  const duz = String(s == null ? '' : s)
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (duz.length <= n) return duz;
  const p = duz.lastIndexOf(' ', n);
  return duz.slice(0, p > 40 ? p : n).trim() + '…';
}

function metaYerlestir(kabuk, tez) {
  const katAd = tez.kategori === 'arastirma' ? 'Şirket Araştırması'
    : tez.kategori === 'haber' ? 'Haber' : 'Yatırım Tezi';
  const baslik = `${tez.baslik} — Barış Investing`;
  const aciklama = metinKis(tez.ozet, 200)
    || `${tez.ticker ? tez.ticker + ' · ' : ''}${katAd} — Barış Investing`;

  /* Kapak: son güncellemenin görseli varsa o. Ana sayfadaki manşet de
     onu gösteriyor; kart ile sitenin aynı görseli göstermesi gerekiyor. */
  const guncler = Array.isArray(tez.tez_guncellemeler) ? tez.tez_guncellemeler.slice() : [];
  guncler.sort((a, b) => String(b.tarih || '').localeCompare(String(a.tarih || '')));
  const gorsel = (guncler.find(g => g && g.gorsel) || {}).gorsel || tez.kapak_gorseli || `${SITE}/og.jpg`;
  const url = `${SITE}/tez/${tez.id}`;

  const etiketler = [
    `<title>${attrEsc(baslik)}</title>`,
    `<meta name="description" content="${attrEsc(aciklama)}">`,
    `<link rel="canonical" href="${attrEsc(url)}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Barış Investing">`,
    `<meta property="og:locale" content="tr_TR">`,
    `<meta property="og:title" content="${attrEsc(baslik)}">`,
    `<meta property="og:description" content="${attrEsc(aciklama)}">`,
    `<meta property="og:url" content="${attrEsc(url)}">`,
    `<meta property="og:image" content="${attrEsc(gorsel)}">`,
    `<meta property="og:image:alt" content="${attrEsc(tez.baslik)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attrEsc(baslik)}">`,
    `<meta name="twitter:description" content="${attrEsc(aciklama)}">`,
    `<meta name="twitter:image" content="${attrEsc(gorsel)}">`,
    `<meta name="twitter:image:alt" content="${attrEsc(tez.baslik)}">`,
    tez.olusturma ? `<meta property="article:published_time" content="${attrEsc(tez.olusturma)}">` : '',
    `<meta property="article:section" content="${attrEsc(katAd)}">`,
  ].filter(Boolean).join('\n');

  /* Önce kabuktaki genel başlık ve açıklama çıkarılıyor; ikisi birden
     kalsa botlar hangisini alacağına kendi karar verirdi. */
  let out = kabuk
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name=["']description["'][^>]*>\s*/i, '');

  const yer = out.search(/<meta\s+charset=[^>]*>/i);
  if (yer >= 0) {
    const son = out.indexOf('>', yer) + 1;
    return out.slice(0, son) + '\n' + etiketler + out.slice(son);
  }
  return out.replace(/<head[^>]*>/i, (m) => m + '\n' + etiketler);
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
