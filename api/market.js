import { US_EVREN, BIST_EVREN } from './_heatmap-universe.js';
import { ozetGetir } from './_ozet.js';

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed = !origin || origin.includes('barisinvesting.com') || origin.includes('vercel.app') || origin.includes('localhost');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? (origin || '*') : 'https://www.barisinvesting.com');
  const { type, ticker } = req.query;
  if (type === 'market') return getMarketOverview(res);
  if (type === 'news') return getNews(res);
  if (type === 'regime') return getRegime(res);
  if (type === 'heatmap') return getHeatmap(req, res);
  if (type === 'sektor') return getSektor(req, res);
  if (type === 'piyasa') return getPiyasaVerileri(req, res);
  if (type === 'bilanco') return getBilanco(req, res);
  if (type === 'search' && ticker) return searchTicker(ticker, res);
  if (type === 'evren') return getEvren(res);
  if (type === 'ozet' && ticker) return getOzet(ticker, res);
  return res.status(400).json({ error: 'Invalid' });
}

/* ── ISI HARİTASI İPUCU ÖZETİ ────────────────────────────────────
   Kutunun üstüne gelince açılan kartın metni. Şirket kartındaki
   (/api/profil) ağır SEC çağrısını yapmıyor: yalnızca evren tablosu
   + ansiklopedi girişi. Bir gün cache — tanım metni gün içinde
   değişmiyor. */
async function getOzet(ticker, res) {
  const tk = String(ticker).toUpperCase().replace(/[^A-Z0-9.]/g, '');
  const h = [...US_EVREN, ...BIST_EVREN].find(x => x.t === tk.replace('.IS', ''));
  if (!h) return res.status(404).json({ error: 'Bilinmeyen sembol' });
  const ozet = await ozetGetir(h.n, 300).catch(() => null);
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({
    ticker: tk, ad: h.n, sektor: h.s || null, borsa: h.x || null,
    ozet: ozet ? ozet.metin : null,
  });
}

/* ── ARAMA EVRENİ ────────────────────────────────────────────────
   Isı haritası evreninin arama için gereken üç alanı. İstemci bunu
   bir kez çekip yerelde süzüyor: her tuş vuruşunda ağ isteği yok,
   öneri listesi anında açılıyor. Evren dışındaki kodlar için istemci
   type=search'e düşüyor. */
function getEvren(res) {
  const sade = (h) => ({ t: h.t, n: h.n, x: h.x, s: h.s });
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
  return res.status(200).json({
    sirketler: [...US_EVREN.map(sade), ...BIST_EVREN.map(sade)],
  });
}

/* ── BİLANÇO AKIŞI ───────────────────────────────────────────────
   "Şu şirketin bilançosu geldi: beklenti X, gerçekleşen Y."

   İki kaynak birleşiyor:
   1) NASDAQ takvimi  → bugün kim açıklıyor, konsensüs, açılış öncesi mi
                        kapanış sonrası mı. Tek istek, ~250 satır.
   2) Yahoo earningsHistory → açıklanan çeyreğin GERÇEKLEŞEN EPS'i.
                        Sembol başına bir istek; takvimdeki çeyrek ile
                        geçmişteki son çeyrek eşleşiyorsa "geldi".

   NASDAQ'ın kendi sürpriz tablosu aynı gün güncellenmiyor (ölçüldü),
   Yahoo güncelleniyor — bu yüzden gerçekleşen oradan alınıyor.
   ──────────────────────────────────────────────────────────────── */
const BIL_LIMIT = 14;       // takvimden kaç şirkete gerçekleşen sorulacak
const BIL_ARALIK = 300;     // ms — bu aralığın altında Yahoo boş dönüyor
const BIL_SURE = 20000;     // ms — maxDuration 30sn, toplamaya bu kadar

const AYLAR = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Crumb sıcak lambda'da yeniden kullanılır — her istekte almak pahalı
let _crumb = null, _cerez = null, _crumbTs = 0;

async function crumbAl() {
  if (_crumb && (Date.now() - _crumbTs) < 30 * 60000) return { crumb: _crumb, cerez: _cerez };

  // fc.yahoo.com 404 döner ama çerezi yine de bırakır — durum kodu önemsiz.
  // Çerez ZORUNLU: çerezsiz getcrumb 401 veriyor (ölçüldü).
  // İki tur denenir; fc bazen 3sn'ye kadar sürüyor, tek denemede kaybetmeyelim.
  for (let deneme = 0; deneme < 2; deneme++) {
    let cerez = '';
    try {
      const r1 = await fetch('https://fc.yahoo.com', {
        headers: { 'User-Agent': YAHOO_UA }, signal: AbortSignal.timeout(7000),
      });
      // getSetCookie() çerezleri dizi verir. headers.get('set-cookie') hepsini
      // virgülle birleştiriyor ve "Expires=Wed, 12-Aug-2026" içindeki virgül
      // ayrıştırmayı bozuyor — varsa dizi biçimini kullan.
      const cerezler = typeof r1.headers.getSetCookie === 'function'
        ? r1.headers.getSetCookie()
        : String(r1.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_-]+=)/);
      cerez = cerezler.map(p => String(p).split(';')[0].trim()).filter(Boolean).join('; ');
    } catch { /* çerez alınamadı — yine de getcrumb'ı dene, bedeli tek istek */ }

    try {
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: cerez
          ? { 'User-Agent': YAHOO_UA, 'Cookie': cerez }
          : { 'User-Agent': YAHOO_UA },
        signal: AbortSignal.timeout(7000),
      });
      const c = (await r2.text()).trim();
      if (c && c.length <= 24 && !c.includes('<')) {
        _crumb = c; _cerez = cerez; _crumbTs = Date.now();
        return { crumb: _crumb, cerez: _cerez };
      }
    } catch { /* sonraki tur */ }
  }

  _crumb = null;
  return null;
}

function sayiCoz(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === 'N/A') return null;
  // "($0.21)" → -0.21, "$1.23" → 1.23
  const eksi = /^\(.*\)$/.test(t);
  const n = parseFloat(t.replace(/[()$,]/g, ''));
  if (!isFinite(n)) return null;
  return eksi ? -n : n;
}

async function getBilanco(req, res) {
  // Takvim ABD borsa gününe göre — sunucu UTC olabilir, ET'ye çevir
  const et = new Date(Date.now() - 4 * 3600000);
  const gun = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date : et.toISOString().slice(0, 10);

  try {
    const takvimR = await fetch(`https://api.nasdaq.com/api/calendar/earnings?date=${gun}`, {
      headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!takvimR.ok) throw new Error('Takvim alınamadı');
    const takvim = await takvimR.json();
    const satirlar = takvim?.data?.rows || [];

    if (!satirlar.length) {
      res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.status(200).json({ gun, toplam: 0, bilancolar: [], ts: Date.now() });
    }

    // Borsa bilgisi takvimde yok; evren tablosundan bakılıyor, yoksa
    // NASDAQ varsayılıyor (analiz ekranındaki rozet için)
    const borsaTablo = new Map(US_EVREN.map(h => [h.t, h.x]));

    // Piyasa değerine göre sırala — akışta önce büyük şirketler
    const sirali = satirlar
      .map(r => ({
        ticker: String(r.symbol || '').toUpperCase(),
        // "Brinker International, Inc." → "Brinker International"
        // (son ek atıldıktan sonra kalan virgül de temizlenmeli)
        ad: String(r.name || '')
          .replace(/[\s,]*(Incorporated|Inc\.?|Corporation|Corp\.?|Company|Co\.?|plc|PLC|Limited|Ltd\.?|N\.V\.|S\.A\.|S\.A|AB|AG)\s*$/i, '')
          .replace(/[\s,.\-]+$/, '')
          .trim(),
        kap: sayiCoz(r.marketCap) || 0,
        beklenti: sayiCoz(r.epsForecast),
        gecenYil: sayiCoz(r.lastYearEPS),
        ceyrek: String(r.fiscalQuarterEnding || ''),
        zaman: r.time === 'time-pre-market' ? 'acilis-oncesi'
          : r.time === 'time-after-hours' ? 'kapanis-sonrasi' : 'gun-ici',
        x: borsaTablo.get(String(r.symbol || '').toUpperCase()) || 'NASDAQ',
      }))
      .filter(r => r.ticker)
      .sort((a, b) => b.kap - a.kap);

    const secilenler = sirali.slice(0, BIL_LIMIT);

    // Açıklama saati gelmemiş şirkete Yahoo'ya sormak boşuna — hem yavaş
    // hem kotayı yiyor. Sadece penceresi geçmiş olanlara sor.
    const etSimdi = new Date(Date.now() - 4 * 3600000);
    const bugunMu = gun === etSimdi.toISOString().slice(0, 10);
    const etSaat = etSimdi.getUTCHours() + etSimdi.getUTCMinutes() / 60;
    const penceresiGecti = (zaman) => {
      if (!bugunMu) return true;                       // geçmiş gün: hepsi açıklanmış
      if (zaman === 'acilis-oncesi') return etSaat >= 7;
      if (zaman === 'kapanis-sonrasi') return etSaat >= 16;
      return etSaat >= 9.5;
    };

    const kimlik = await crumbAl();
    const baslangic = Date.now();

    // Gerçekleşen EPS — sıralı çekim şart: paralel gidince Yahoo boş
    // gövde dönüyor (ölçüldü: 8 eşzamanlı istekten 6'sı boş).
    for (const b of secilenler) {
      if (!kimlik || Date.now() - baslangic > BIL_SURE) break;
      if (!penceresiGecti(b.zaman)) continue;
      try {
        // price modülü ek istek maliyeti olmadan gerçek borsayı veriyor
        // (AMCR NYSE, TRMB NasdaqGS) — evren tablosunda olmayan semboller
        // için "NASDAQ" varsayımından kurtarıyor
        const u = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(b.ticker)}`
          + `?modules=earningsHistory,price&crumb=${encodeURIComponent(kimlik.crumb)}`;
        const r = await fetch(u, {
          headers: { 'User-Agent': YAHOO_UA, 'Accept': 'application/json', 'Cookie': kimlik.cerez },
          signal: AbortSignal.timeout(8000),
        });
        const j = r.ok ? await r.json() : null;
        const sonuc = j?.quoteSummary?.result?.[0];
        const borsaAd = sonuc?.price?.exchangeName;
        if (borsaAd) b.x = /nasdaq/i.test(borsaAd) ? 'NASDAQ' : 'NYSE';
        const gecmis = sonuc?.earningsHistory?.history;
        if (Array.isArray(gecmis) && gecmis.length) {
          const son = gecmis[gecmis.length - 1];
          const tarih = son?.quarter?.fmt;
          const [ayAd, yil] = b.ceyrek.split('/');
          const d = tarih ? new Date(tarih + 'T12:00:00Z') : null;
          // Takvimdeki çeyrek ile geçmişteki son çeyrek aynıysa açıklanmış
          if (d && AYLAR[ayAd] === d.getUTCMonth() + 1 && Number(yil) === d.getUTCFullYear()) {
            const gercek = son?.epsActual?.raw;
            const tahmin = son?.epsEstimate?.raw;
            if (gercek != null && isFinite(gercek)) {
              b.gerceklesen = Math.round(gercek * 10000) / 10000;
              if (tahmin != null && isFinite(tahmin)) {
                b.beklenti = Math.round(tahmin * 10000) / 10000;
                // Sürprizi kendimiz hesaplıyoruz: Yahoo'nun surprisePercent'i
                // negatif tahminlerde işaret hatası veriyor
                const bolen = Math.abs(tahmin);
                if (bolen > 0.005) b.surpriz = Math.round(((gercek - tahmin) / bolen) * 1000) / 10;
              }
              b.durum = 'geldi';
            }
          }
        }
      } catch { /* tek şirket düşerse akış devam etsin */ }
      await new Promise(z => setTimeout(z, BIL_ARALIK));
    }

    const bilancolar = secilenler.map(b => {
      if (!b.durum) b.durum = 'bekleniyor';
      if (b.surpriz != null) b.yon = b.surpriz > 0.5 ? 'asti' : b.surpriz < -0.5 ? 'kaldi' : 'tutturdu';
      return b;
    });

    const gelen = bilancolar.filter(b => b.durum === 'geldi').length;
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({
      gun,
      toplam: sirali.length,
      gelenSayisi: gelen,
      gerceklesenAlinabildi: !!kimlik,
      bilancolar,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* ── ISI HARİTASI ────────────────────────────────────────────────
   Kutu boyutu  = statik pay adedi × canlı fiyat (piyasa değeri)
   Kutu rengi   = seçilen dönemdeki yüzde değişim
   Kaynak       : Yahoo spark — crumb/çerez istemiyor, istek başına
                  en fazla 20 sembol (21'de 400 dönüyor, ölçüldü).
   ──────────────────────────────────────────────────────────────── */
const HM_DONEM = {
  '1g': { range: '1d',  interval: '5m',  ad: '1 Gün',   cache: 300 },
  '1h': { range: '5d',  interval: '1d',  ad: '1 Hafta', cache: 900 },
  '1a': { range: '1mo', interval: '1d',  ad: '1 Ay',    cache: 1800 },
  '3a': { range: '3mo', interval: '1d',  ad: '3 Ay',    cache: 3600 },
  '6a': { range: '6mo', interval: '1wk', ad: '6 Ay',    cache: 3600 },
  '1y': { range: '1y',  interval: '1wk', ad: '1 Yıl',   cache: 3600 },
};
const HM_PARCA = 20; // Yahoo spark'ın sembol tavanı

async function getHeatmap(req, res) {
  const kapsam = String(req.query.scope || 'us').toLowerCase() === 'bist' ? 'bist' : 'us';
  const donemKey = HM_DONEM[String(req.query.period || '1g')] ? String(req.query.period || '1g') : '1g';
  const donem = HM_DONEM[donemKey];

  const evren = kapsam === 'bist' ? BIST_EVREN : US_EVREN;
  const sembol = (t) => (kapsam === 'bist' ? `${t}.IS` : t);

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };

  const parcala = (liste) => {
    const g = [];
    for (let i = 0; i < liste.length; i += HM_PARCA) g.push(liste.slice(i, i + HM_PARCA));
    return g;
  };

  const veri = {}; // sembol → { fiyat, onceki }

  // Bir grup sembolü çek, sonuçları veri sözlüğüne işle
  async function grupCek(semboller) {
    const q = semboller.join(',');
    let j = null;
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(q)}&range=${donem.range}&interval=${donem.interval}`,
        { headers, signal: AbortSignal.timeout(9000) }
      );
      j = r.ok ? await r.json() : null;
    } catch { j = null; }
    if (!j || typeof j !== 'object') return;
    for (const [sym, s] of Object.entries(j)) {
      if (!s || typeof s !== 'object') continue;
      const kapanislar = (s.close || []).filter(v => v != null && isFinite(v));
      const fiyat = kapanislar.length ? kapanislar[kapanislar.length - 1] : null;
      // chartPreviousClose = pencerenin BİR ÖNCESİNDEKİ kapanış; dönem
      // getirisinin doğru referansı bu. Yoksa penceredeki ilk kapanışa düş.
      const onceki = (s.chartPreviousClose != null && isFinite(s.chartPreviousClose))
        ? s.chartPreviousClose
        : (kapanislar.length > 1 ? kapanislar[0] : null);
      if (fiyat && onceki) veri[sym] = { fiyat, onceki };
    }
  }

  const baslangic = Date.now();
  const SURE_SINIRI = 18000; // maxDuration 30sn — toplamaya bu kadarını ayır

  try {
    // 1. tur — hepsi paralel
    await Promise.allSettled(parcala(evren.map(x => sembol(x.t))).map(grupCek));

    // 2. tur — Yahoo eşzamanlı istekleri kısabiliyor; düşenleri bir kez
    // daha, seri olarak iste. Tek turda kapsama %60'lara kadar inebiliyor.
    // Seri olduğu için süre sınırı şart: her grup 9sn zaman aşımıyla
    // beklerse tüm turun maliyeti fonksiyon limitini aşar.
    const eksik = evren.map(x => sembol(x.t)).filter(s => !veri[s]);
    for (const g of parcala(eksik)) {
      if (Date.now() - baslangic > SURE_SINIRI) break;
      await grupCek(g);
    }

    // Sektörlere topla
    const sektorler = new Map();
    let toplamDeger = 0;
    for (const h of evren) {
      const v = veri[sembol(h.t)];
      if (!v) continue;
      const degisim = (v.fiyat / v.onceki - 1) * 100;
      if (!isFinite(degisim)) continue;
      const deger = h.sh * v.fiyat;
      if (!isFinite(deger) || deger <= 0) continue;
      if (!sektorler.has(h.s)) sektorler.set(h.s, { ad: h.s, deger: 0, agirlikli: 0, hisseler: [] });
      const sek = sektorler.get(h.s);
      sek.deger += deger;
      sek.agirlikli += degisim * deger;
      sek.hisseler.push({
        t: h.t,
        n: h.n,
        d: Math.round(degisim * 100) / 100,
        v: Math.round(deger),
        f: Math.round(v.fiyat * 100) / 100,
        // Borsa: analiz ekranındaki rozet doğru yazsın (JPM NYSE, AAPL NASDAQ)
        x: h.x || (kapsam === 'bist' ? 'BIST' : 'NASDAQ'),
      });
      toplamDeger += deger;
    }

    if (!sektorler.size) return res.status(502).json({ error: 'Isı haritası verisi alınamadı' });

    const liste = [...sektorler.values()]
      .map(s => ({
        ad: s.ad,
        // Sektör değişimi = piyasa değeri ağırlıklı ortalama
        d: Math.round((s.agirlikli / s.deger) * 100) / 100,
        v: Math.round(s.deger),
        hisseler: s.hisseler.sort((a, b) => b.v - a.v),
      }))
      .sort((a, b) => b.v - a.v);

    const hisseSayisi = liste.reduce((a, s) => a + s.hisseler.length, 0);
    const piyasa = liste.length ? liste.reduce((a, s) => a + s.d * s.v, 0) / toplamDeger : 0;

    res.setHeader('Cache-Control', `s-maxage=${donem.cache}, stale-while-revalidate=${donem.cache * 2}`);
    return res.status(200).json({
      kapsam,
      donem: donemKey,
      donemAd: donem.ad,
      paraBirimi: kapsam === 'bist' ? 'TRY' : 'USD',
      piyasaDegisim: Math.round(piyasa * 100) / 100,
      hisseSayisi,
      kapsananOran: Math.round(hisseSayisi / evren.length * 100),
      sektorler: liste,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* ── SEKTÖR DETAYI ───────────────────────────────────────────────
   Bir sektördeki hisselerin 1A / 3A / 6A / 1Y getirileri.

   Tek istek yeter: spark range=1y&interval=1d hem kapanışları hem
   zaman damgalarını veriyor (ölçüldü) — dört ayrı dönem isteği yerine
   bir yıllık seriden geriye sayıyoruz. Dönem başına ayrı çağrı 4 kat
   istek demekti, Yahoo o hacimde kısmaya başlıyor.
   ──────────────────────────────────────────────────────────────── */
const SEK_DONEM = [
  { k: '1a', ad: '1 Ay', gun: 30 },
  { k: '3a', ad: '3 Ay', gun: 91 },
  { k: '6a', ad: '6 Ay', gun: 182 },
  { k: '1y', ad: '1 Yıl', gun: 365 },
];
const GUN_MS = 86400;

// Hedef tarihteki (veya bir öncesindeki) kapanış. Seri hedefe kadar
// gerilemiyorsa null — yeni halka arzda "1 yıllık getiri" uydurmayalım.
function seriGetiri(ts, kapanis, sonFiyat, gun) {
  if (!ts.length) return null;
  const hedef = ts[ts.length - 1] - gun * GUN_MS;
  // Tolerans: haftasonu/tatil boşlukları hedefi ıskalatabiliyor
  if (ts[0] > hedef + 10 * GUN_MS) return null;
  let i = 0;
  for (let j = 0; j < ts.length; j++) {
    if (ts[j] <= hedef) i = j; else break;
  }
  const ref = kapanis[i];
  if (!ref || !isFinite(ref)) return null;
  const d = (sonFiyat / ref - 1) * 100;
  return isFinite(d) ? Math.round(d * 100) / 100 : null;
}

async function getSektor(req, res) {
  const kapsam = String(req.query.scope || 'us').toLowerCase() === 'bist' ? 'bist' : 'us';
  const sektorAd = String(req.query.sector || '').trim();
  if (!sektorAd) return res.status(400).json({ error: 'Sektör belirtilmedi' });

  const evren = (kapsam === 'bist' ? BIST_EVREN : US_EVREN).filter(h => h.s === sektorAd);
  if (!evren.length) return res.status(404).json({ error: 'Sektör bulunamadı' });

  const sembol = (t) => (kapsam === 'bist' ? `${t}.IS` : t);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };

  const seri = {}; // sembol → { ts, kapanis, fiyat, oncekiYil }

  async function grupCek(semboller) {
    let j = null;
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(semboller.join(','))}&range=1y&interval=1d`,
        { headers, signal: AbortSignal.timeout(9000) }
      );
      j = r.ok ? await r.json() : null;
    } catch { j = null; }
    if (!j || typeof j !== 'object') return;
    for (const [sym, s] of Object.entries(j)) {
      if (!s || !Array.isArray(s.close) || !Array.isArray(s.timestamp)) continue;
      const ts = [], kapanis = [];
      for (let i = 0; i < s.close.length; i++) {
        if (s.close[i] != null && isFinite(s.close[i]) && s.timestamp[i] != null) {
          ts.push(s.timestamp[i]); kapanis.push(s.close[i]);
        }
      }
      if (kapanis.length < 2) continue;
      seri[sym] = {
        ts, kapanis,
        fiyat: kapanis[kapanis.length - 1],
        // Pencerenin bir öncesindeki kapanış = 1 yıllık getirinin doğru referansı
        oncekiYil: (s.chartPreviousClose != null && isFinite(s.chartPreviousClose)) ? s.chartPreviousClose : null,
      };
    }
  }

  const parcala = (liste) => {
    const g = [];
    for (let i = 0; i < liste.length; i += HM_PARCA) g.push(liste.slice(i, i + HM_PARCA));
    return g;
  };

  try {
    const semboller = evren.map(h => sembol(h.t));
    await Promise.allSettled(parcala(semboller).map(grupCek));
    // Eksikleri bir kez daha, seri olarak iste (ısı haritasındaki desen)
    const eksik = semboller.filter(s => !seri[s]);
    for (const g of parcala(eksik)) await grupCek(g);

    const hisseler = [];
    for (const h of evren) {
      const s = seri[sembol(h.t)];
      if (!s) continue;
      const deger = h.sh * s.fiyat;
      const kayit = {
        t: h.t,
        n: h.n,
        x: h.x || (kapsam === 'bist' ? 'BIST' : 'NASDAQ'),
        f: Math.round(s.fiyat * 100) / 100,
        v: isFinite(deger) && deger > 0 ? Math.round(deger) : null,
      };
      // Seri gerçekten bir yıla yayılıyor mu? Yeni halka arzda spark yine
      // chartPreviousClose veriyor ama o "1 yıl önce" değil, ilk işlem günü —
      // onu 1 yıllık getiri diye yazmak yanlış olur.
      const tamYil = s.ts.length && (s.ts[s.ts.length - 1] - s.ts[0]) > 350 * 86400;
      for (const d of SEK_DONEM) {
        if (d.k === '1y' && s.oncekiYil && tamYil) {
          const g = (s.fiyat / s.oncekiYil - 1) * 100;
          kayit[d.k] = isFinite(g) ? Math.round(g * 100) / 100 : null;
        } else {
          kayit[d.k] = seriGetiri(s.ts, s.kapanis, s.fiyat, d.gun);
        }
      }
      hisseler.push(kayit);
    }

    if (!hisseler.length) return res.status(502).json({ error: 'Sektör verisi alınamadı' });
    hisseler.sort((a, b) => (b.v || 0) - (a.v || 0));

    // Sektör ortalaması: piyasa değeri ağırlıklı (ısı haritasıyla aynı yöntem)
    const ozet = {};
    for (const d of SEK_DONEM) {
      let agirlik = 0, toplam = 0;
      for (const h of hisseler) {
        if (h[d.k] == null || !h.v) continue;
        agirlik += h.v; toplam += h[d.k] * h.v;
      }
      ozet[d.k] = agirlik ? Math.round((toplam / agirlik) * 100) / 100 : null;
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({
      kapsam,
      sektor: sektorAd,
      paraBirimi: kapsam === 'bist' ? 'TRY' : 'USD',
      donemler: SEK_DONEM.map(d => ({ k: d.k, ad: d.ad })),
      hisseSayisi: hisseler.length,
      evrenSayisi: evren.length,
      ozet,
      hisseler,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

/* ── PİYASA VERİLERİ — endeks / sektör / emtia getiri tabloları ────
   Tek beş yıllık günlük seriden bütün dönemler hesaplanıyor (ısı
   haritası ve sektör detayındaki desenin aynısı). Dönem başına ayrı
   istek atmak 6 kat çağrı demekti; Yahoo o hacimde kısıyor.
   ──────────────────────────────────────────────────────────────── */
const PV_DONEM = [
  { k: '1g', ad: '1 Gün', gun: 1 },
  { k: '1h', ad: '1 Hafta', gun: 7 },
  { k: '1a', ad: '1 Ay', gun: 30 },
  { k: 'ybb', ad: 'YBB' },              // yıl başından bu yana
  { k: '1y', ad: '1 Yıl', gun: 365 },
  { k: '3y', ad: '3 Yıl', gun: 1095 },
];

const PV_BLOKLAR = [
  {
    k: 'endeks', ad: 'Endeksler', not: 'ABD · Avrupa · Asya · BİST',
    satirlar: [
      { s: '^GSPC', ad: 'S&P 500', kod: 'SPX' },
      { s: '^NDX', ad: 'NASDAQ 100', kod: 'NDX' },
      { s: '^IXIC', ad: 'NASDAQ Composite', kod: 'IXIC' },
      { s: '^DJI', ad: 'Dow Jones', kod: 'DJI' },
      { s: '^RUT', ad: 'Russell 2000', kod: 'RUT' },
      { s: '^VIX', ad: 'VIX · Korku Endeksi', kod: 'VIX' },
      { s: 'XU100.IS', ad: 'BİST 100', kod: 'XU100' },
      { s: 'XU030.IS', ad: 'BİST 30', kod: 'XU030' },
      { s: '^GDAXI', ad: 'DAX', kod: 'DAX' },
      { s: '^FTSE', ad: 'FTSE 100', kod: 'FTSE' },
      { s: '^N225', ad: 'Nikkei 225', kod: 'N225' },
    ],
  },
  {
    k: 'us-sektor', ad: 'ABD Sektörleri', not: 'SPDR sektör fonları',
    satirlar: [
      // sek = ısı haritası evrenindeki sektör adı; satır tıklanınca o
      // sektörün hisse tablosu açılıyor
      { s: 'XLK', ad: 'Teknoloji', kod: 'XLK', sek: 'Teknoloji', kap: 'us' },
      { s: 'XLC', ad: 'İletişim', kod: 'XLC', sek: 'İletişim', kap: 'us' },
      { s: 'XLY', ad: 'Tüketici (İsteğe Bağlı)', kod: 'XLY', sek: 'Tüketici', kap: 'us' },
      { s: 'XLP', ad: 'Temel Tüketim', kod: 'XLP', sek: 'Temel Tüketim', kap: 'us' },
      { s: 'XLF', ad: 'Finans', kod: 'XLF', sek: 'Finans', kap: 'us' },
      { s: 'XLV', ad: 'Sağlık', kod: 'XLV', sek: 'Sağlık', kap: 'us' },
      { s: 'XLI', ad: 'Sanayi', kod: 'XLI', sek: 'Sanayi', kap: 'us' },
      { s: 'XLE', ad: 'Enerji', kod: 'XLE', sek: 'Enerji', kap: 'us' },
      { s: 'XLB', ad: 'Temel Materyal', kod: 'XLB', sek: 'Temel Materyal', kap: 'us' },
      { s: 'XLU', ad: 'Kamu Hizmetleri', kod: 'XLU', sek: 'Kamu Hizmetleri', kap: 'us' },
      { s: 'XLRE', ad: 'Gayrimenkul', kod: 'XLRE', sek: 'Gayrimenkul', kap: 'us' },
    ],
  },
  {
    k: 'emtia', ad: 'Emtia · Kripto · Kur', not: 'vadeli ve spot fiyatlar',
    satirlar: [
      { s: 'GC=F', ad: 'Altın (ons)', kod: 'XAU' },
      { s: 'SI=F', ad: 'Gümüş (ons)', kod: 'XAG' },
      { s: 'HG=F', ad: 'Bakır', kod: 'HG' },
      { s: 'CL=F', ad: 'Ham Petrol (WTI)', kod: 'WTI' },
      { s: 'BZ=F', ad: 'Brent Petrol', kod: 'BRENT' },
      { s: 'NG=F', ad: 'Doğalgaz', kod: 'NG' },
      { s: 'BTC-USD', ad: 'Bitcoin', kod: 'BTC' },
      { s: 'ETH-USD', ad: 'Ethereum', kod: 'ETH' },
      { s: 'DX-Y.NYB', ad: 'Dolar Endeksi', kod: 'DXY' },
      { s: 'EURUSD=X', ad: 'EUR / USD', kod: 'EURUSD' },
      { s: 'USDTRY=X', ad: 'USD / TRY', kod: 'USDTRY' },
      { s: 'EURTRY=X', ad: 'EUR / TRY', kod: 'EURTRY' },
    ],
  },
];

// Yıl başından bu yana: bu yılın ilk işlem gününden ÖNCEKİ kapanış referans.
// Ocak başındaki ilk kapanışı almak yılın ilk günkü hareketini yutuyordu.
function ybbGetiri(ts, kapanis, sonFiyat) {
  if (!ts.length) return null;
  const yil = new Date(ts[ts.length - 1] * 1000).getUTCFullYear();
  let ref = null;
  for (let i = 0; i < ts.length; i++) {
    if (new Date(ts[i] * 1000).getUTCFullYear() === yil) { ref = i > 0 ? kapanis[i - 1] : null; break; }
  }
  if (!ref || !isFinite(ref)) return null;
  const d = (sonFiyat / ref - 1) * 100;
  return isFinite(d) ? Math.round(d * 100) / 100 : null;
}

// Spark, 5 yıllık günlük seride 20'lik gruplarda sembol düşürüyor
// (ölçüldü: 20 istenen gruptan 6 sembol döndü, BİST sektör endeksleri
// eksik kaldı). Küçük gruplar + tekrar denemeyle tamamı geliyor.
const PV_PARCA = 8;
const PV_TEKRAR = 2;
// Hisse sembolleri toplu istekte sorun çıkarmıyor (ısı haritası 96 hisseyi
// 20'lik gruplarla çekiyor) — sektör endekslerindeki gibi küçültmeye gerek yok
const PV_HISSE_PARCA = 16;
// Bir sektör ortalaması sayılabilmesi için gereken en az hisse sayısı
const PV_MIN_HISSE = 3;

async function getPiyasaVerileri(req, res) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };

  const seri = {};

  function seriYaz(sym, closes, stamps) {
    const ts = [], kapanis = [];
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null && isFinite(closes[i]) && stamps[i] != null) {
        ts.push(stamps[i]); kapanis.push(closes[i]);
      }
    }
    if (kapanis.length < 2) return;
    seri[sym] = { ts, kapanis, fiyat: kapanis[kapanis.length - 1] };
  }

  async function grupCek(semboller, host) {
    let j = null;
    try {
      const r = await fetch(
        `https://${host || 'query1'}.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(semboller.join(','))}&range=5y&interval=1d`,
        { headers, signal: AbortSignal.timeout(9000) }
      );
      j = r.ok ? await r.json() : null;
    } catch { j = null; }
    if (!j || typeof j !== 'object') return;
    for (const [sym, s] of Object.entries(j)) {
      if (!s || !Array.isArray(s.close) || !Array.isArray(s.timestamp)) continue;
      seriYaz(sym, s.close, s.timestamp);
    }
  }

  // Spark toplu isteği bazı sembolleri (özellikle BİST sektör endekslerini)
  // sunucu tarafında sessizce atlıyor — yereldeki aynı istek tamamını
  // döndürdüğü hâlde. Kalanlar için tek tek chart uç noktası.
  async function tekCek(sym) {
    try {
      const r = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`,
        { headers, signal: AbortSignal.timeout(9000) }
      );
      if (!r.ok) return;
      const j = await r.json();
      const c = j?.chart?.result?.[0];
      if (!c) return;
      seriYaz(sym, c.indicators?.quote?.[0]?.close || [], c.timestamp || []);
    } catch { /* sembol atlanır */ }
  }

  try {
    const tumSemboller = PV_BLOKLAR.flatMap(b => b.satirlar.map(r => r.s));
    const parcala = (liste) => {
      const g = [];
      for (let i = 0; i < liste.length; i += PV_PARCA) g.push(liste.slice(i, i + PV_PARCA));
      return g;
    };
    await Promise.allSettled(parcala(tumSemboller).map(g => grupCek(g)));
    // Eksik kalanları önce diğer Yahoo host'uyla toplu, sonra tek tek dene
    for (let tur = 0; tur < PV_TEKRAR; tur++) {
      const eksik = tumSemboller.filter(s => !seri[s]);
      if (!eksik.length) break;
      await Promise.allSettled(parcala(eksik).map(g => grupCek(g, tur === 0 ? 'query2' : 'query1')));
    }
    const kalan = tumSemboller.filter(s => !seri[s]);
    if (kalan.length) await Promise.allSettled(kalan.map(tekCek));

    // BİST sektörleri: Yahoo'nun sektör endeksi sembolleri (XUTEK.IS, XHOLD.IS…)
    // sunucudan çekilemiyor — aynı istek yerelden 16/16 dönerken Vercel'den
    // 2/16 dönüyor, tek tek chart da vermiyor. Hisse sembolleri sorunsuz
    // geldiği için sektörleri ısı haritası evreninden, piyasa değeri
    // ağırlıklı hesaplıyoruz: sektör detay sayfasıyla da aynı yöntem.
    const bistSemboller = BIST_EVREN.map(h => `${h.t}.IS`);
    const hisseParcala = (liste) => {
      const g = [];
      for (let i = 0; i < liste.length; i += PV_HISSE_PARCA) g.push(liste.slice(i, i + PV_HISSE_PARCA));
      return g;
    };
    await Promise.allSettled(hisseParcala(bistSemboller).map(g => grupCek(g)));
    const bistEksik = bistSemboller.filter(s => !seri[s]);
    if (bistEksik.length) await Promise.allSettled(hisseParcala(bistEksik).map(g => grupCek(g, 'query2')));

    const sektorHar = new Map();
    for (const h of BIST_EVREN) {
      const s = seri[`${h.t}.IS`];
      if (!s) continue;
      const deger = h.sh * s.fiyat;
      if (!isFinite(deger) || deger <= 0) continue;
      let kayit = sektorHar.get(h.s);
      if (!kayit) { kayit = { agirlik: {}, toplam: {}, adet: 0 }; sektorHar.set(h.s, kayit); }
      kayit.adet++;
      for (const d of PV_DONEM) {
        const g = d.k === 'ybb'
          ? ybbGetiri(s.ts, s.kapanis, s.fiyat)
          : seriGetiri(s.ts, s.kapanis, s.fiyat, d.gun);
        if (g == null) continue;
        kayit.agirlik[d.k] = (kayit.agirlik[d.k] || 0) + deger;
        kayit.toplam[d.k] = (kayit.toplam[d.k] || 0) + g * deger;
      }
    }
    // BİST getirileri TL bazında: 3 yıllık ham getiri büyük ölçüde enflasyon,
    // ABD sektörlerinin dolar bazlı getirisiyle aynı ölçekte gösterilince
    // yanıltıyor. Bu yüzden BİST 100'e göre PUAN FARKI veriyoruz — "hangi
    // sektör endeksi yendi" sorusu enflasyondan bağımsız cevaplanıyor.
    const xu100 = seri['XU100.IS'];
    const xuGetiri = {};
    if (xu100) {
      for (const d of PV_DONEM) {
        xuGetiri[d.k] = d.k === 'ybb'
          ? ybbGetiri(xu100.ts, xu100.kapanis, xu100.fiyat)
          : seriGetiri(xu100.ts, xu100.kapanis, xu100.fiyat, d.gun);
      }
    }
    const bistSatirlar = [...sektorHar.entries()]
      // Tek/iki hisselik "sektör ortalaması" ortalama değil, o hissenin
      // kendisi — tabloyu gürültüyle doldurmasın
      .filter(([, k]) => k.adet >= PV_MIN_HISSE)
      .map(([ad, k]) => {
        const g = {};
        for (const d of PV_DONEM) {
          const ham = k.agirlik[d.k] ? (k.toplam[d.k] / k.agirlik[d.k]) : null;
          const ref = xuGetiri[d.k];
          g[d.k] = (ham == null || ref == null) ? null : Math.round((ham - ref) * 100) / 100;
        }
        return { s: `BIST:${ad}`, ad, kod: `${k.adet} hisse`, sek: ad, kap: 'bist', f: null, g };
      })
      .sort((a, b) => (b.g['1a'] ?? -Infinity) - (a.g['1a'] ?? -Infinity));

    const bloklar = PV_BLOKLAR.map(b => ({
      k: b.k,
      ad: b.ad,
      not: b.not,
      satirlar: b.satirlar.map(r => {
        const s = seri[r.s];
        if (!s) return null;
        const g = {};
        for (const d of PV_DONEM) {
          g[d.k] = d.k === 'ybb'
            ? ybbGetiri(s.ts, s.kapanis, s.fiyat)
            : seriGetiri(s.ts, s.kapanis, s.fiyat, d.gun);
        }
        return {
          s: r.s,
          ad: r.ad,
          kod: r.kod,
          sek: r.sek || null,
          kap: r.kap || null,
          f: Math.round(s.fiyat * 100) / 100,
          g,
        };
      }).filter(Boolean),
    })).filter(b => b.satirlar.length);

    // BİST sektör bloğu ABD sektörlerinin hemen ardına
    if (bistSatirlar.length) {
      const yer = bloklar.findIndex(b => b.k === 'us-sektor');
      bloklar.splice(yer < 0 ? bloklar.length : yer + 1, 0, {
        k: 'bist-sektor',
        ad: 'BİST Sektörleri',
        not: 'BİST 100\'e göre puan farkı · TL bazında · piyasa değeri ağırlıklı',
        // Sektör ortalamasının tek bir fiyatı yok; birim de % değil puan
        fiyatVar: false,
        birim: 'p',
        satirlar: bistSatirlar,
      });
    }

    if (!bloklar.length) return res.status(502).json({ error: 'Piyasa verisi alınamadı' });

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1800');
    return res.status(200).json({
      donemler: PV_DONEM.map(d => ({ k: d.k, ad: d.ad })),
      bloklar,
      // Hangi sembolün verisi gelmedi — sessizce eksik tablo yerine görünür kayıt
      eksik: tumSemboller.filter(s => !seri[s]),
      bistEksik: bistSemboller.filter(s => !seri[s]).length,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// ── PİYASA REJİMİ — komuta merkezi şeridi ─────────────────────────
// S&P 500 vs 200 günlük ortalama + VIX seviyesi → rejim etiketi.
// Korku/açgözlülük: VIX tabanlı proxy (CNN endeksi değil, kendi göstergemiz).
const MAKRO_TAKVIM = [
  // Yaklaşık tarihler — resmi takvim açıklandıkça buradan güncelle.
  // ABD TÜFE (BLS, ~her ayın 10-14'ü) ve FOMC karar günleri, 2026 2. yarı:
  { tarih: '2026-07-14', tur: 'TÜFE', ad: 'ABD TÜFE açıklaması' },
  { tarih: '2026-07-23', tur: 'PPK',  ad: 'TCMB faiz kararı' },
  { tarih: '2026-07-29', tur: 'Fed',  ad: 'FOMC faiz kararı' },
  { tarih: '2026-08-12', tur: 'TÜFE', ad: 'ABD TÜFE açıklaması' },
  { tarih: '2026-09-11', tur: 'TÜFE', ad: 'ABD TÜFE açıklaması' },
  { tarih: '2026-09-16', tur: 'Fed',  ad: 'FOMC faiz kararı' },
  { tarih: '2026-10-13', tur: 'TÜFE', ad: 'ABD TÜFE açıklaması' },
  { tarih: '2026-10-28', tur: 'Fed',  ad: 'FOMC faiz kararı' },
  { tarih: '2026-11-12', tur: 'TÜFE', ad: 'ABD TÜFE açıklaması' },
  { tarih: '2026-12-09', tur: 'Fed',  ad: 'FOMC faiz kararı' },
  { tarih: '2026-12-10', tur: 'TÜFE', ad: 'ABD TÜFE açıklaması' },
];

async function getRegime(res) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
  };
  const chart = (sym, range, interval) =>
    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`,
      { headers, signal: AbortSignal.timeout(8000) })
      .then(r => r.json())
      .then(j => j?.chart?.result?.[0] || null)
      .catch(() => null);

  try {
    const [sp, vix, tnx, dxy, bist] = await Promise.all([
      chart('^GSPC', '1y', '1d'),
      chart('^VIX', '5d', '1d'),
      chart('^TNX', '5d', '1d'),
      // DX=F artık veri döndürmüyor ("symbol may be delisted"), DXY hep
      // boş görünüyordu. DX-Y.NYB dolar endeksinin çalışan sembolü.
      chart('DX-Y.NYB', '5d', '1d'),
      chart('XU100.IS', '5d', '1d'),
    ]);

    // GÜNLÜK değişim. Dikkat: chartPreviousClose, istenen ARALIĞIN
    // öncesindeki kapanıştır — range=5d'de haftalık, range=1y'de yıllık
    // getiri veriyordu (petrol -%0,43 iken +%5,96 görünüyordu).
    // Günlük barlarda doğru referans, bugünün barından bir önceki kapanış.
    const quote = (c) => {
      if (!c) return null;
      const m = c.meta;
      const cur = m.regularMarketPrice;
      const closes = (c.indicators?.quote?.[0]?.close || []).filter(v => v != null && isFinite(v));
      let prev = null;
      if (closes.length >= 2) {
        const son = closes[closes.length - 1];
        // Son bar bugünün barıysa canlı fiyata eşittir; o zaman bir öncekini al
        prev = (cur != null && Math.abs(son - cur) < Math.abs(cur) * 1e-6)
          ? closes[closes.length - 2] : son;
      }
      if (!prev) prev = m.previousClose || m.chartPreviousClose;
      return { deger: cur, degisim: (cur && prev) ? ((cur - prev) / prev * 100) : 0 };
    };

    // S&P 200 günlük ortalama
    let ma200 = null, spFiyat = null;
    if (sp) {
      spFiyat = sp.meta?.regularMarketPrice || null;
      const closes = (sp.indicators?.quote?.[0]?.close || []).filter(v => v != null && isFinite(v));
      if (closes.length >= 150) {
        const son = closes.slice(-200);
        ma200 = son.reduce((a, b) => a + b, 0) / son.length;
      }
    }

    const vixQ = quote(vix);
    const vixV = vixQ?.deger ?? null;
    const spUstte = (spFiyat && ma200) ? spFiyat > ma200 : null;

    let etiket = 'Belirsiz', detay = 'Veri eksik';
    if (spUstte !== null && vixV !== null) {
      if (spUstte && vixV < 20) { etiket = 'Boğa'; detay = 'Genişleme'; }
      else if (spUstte && vixV < 28) { etiket = 'Boğa'; detay = 'Gergin'; }
      else if (spUstte) { etiket = 'Boğa'; detay = 'Yüksek oynaklık'; }
      else if (vixV < 25) { etiket = 'Düzeltme'; detay = 'Trend zayıf'; }
      else { etiket = 'Ayı'; detay = 'Riskten kaçış'; }
    }

    // VIX → 0-100 korku/açgözlülük proxy'si (VIX 11 ≈ 98, VIX 35 ≈ 2)
    let fg = null, fgEtiket = '';
    if (vixV !== null) {
      fg = Math.max(2, Math.min(98, Math.round(100 - (vixV - 11) * (100 / 24))));
      fgEtiket = fg >= 75 ? 'Aşırı açgözlü' : fg >= 55 ? 'Açgözlü' : fg >= 45 ? 'Nötr' : fg >= 25 ? 'Korku' : 'Aşırı korku';
    }

    const bugun = new Date().toISOString().slice(0, 10);
    const takvim = MAKRO_TAKVIM.filter(e => e.tarih >= bugun).slice(0, 6);

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json({
      rejim: { etiket, detay, sp_200ma_ustu: spUstte, sp_fiyat: spFiyat, sp_ma200: ma200 ? Math.round(ma200) : null },
      korkuAcgozluluk: fg !== null ? { deger: fg, etiket: fgEtiket } : null,
      gostergeler: {
        vix: vixQ,
        us10y: quote(tnx),
        dxy: quote(dxy),
        bist100: quote(bist),
        sp500: spFiyat ? { deger: spFiyat, degisim: quote(sp)?.degisim ?? 0 } : null,
      },
      takvim,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

async function getMarketOverview(res) {
  // ^NDX = NASDAQ 100. ^IXIC (Composite) ile karıştırılmasın: bant "NASDAQ 100"
  // yazıyor, TradingView/Investing'de takip edilen endeks de bu.
  const symbols = ['^GSPC', '^NDX', 'XU100.IS', 'BTC-USD', 'ETH-USD', 'GC=F', 'CL=F'];
  const labels = ['sp500', 'nasdaq', 'bist100', 'btc', 'eth', 'gold', 'oil'];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };
  try {
    const results = await Promise.allSettled(
      symbols.map(s =>
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1h&range=5d`, { headers })
          .then(r => r.json())
      )
    );
    const data = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const chart = r.value?.chart?.result?.[0];
        if (chart) {
          const meta = chart.meta;
          // previousClose = DÜNÜN kapanışı (saatlik aralıkta geliyor).
          // chartPreviousClose ise istenen aralığın öncesi, yani range=5d'de
          // 5 gün öncesi — günlük değişim yerine haftalık getiri veriyordu.
          const prev = meta.previousClose || meta.chartPreviousClose;
          const cur = meta.regularMarketPrice;
          // Sparkline için son kapanış fiyatları — null/eksik değerleri temizle, en fazla son 24 noktayı tut
          const rawCloses = chart.indicators?.quote?.[0]?.close || [];
          const cleaned = rawCloses.filter(v => v != null && isFinite(v));
          const history = cleaned.length >= 2 ? cleaned.slice(-24) : [];
          data[labels[i]] = { price: cur, change: prev ? ((cur - prev) / prev * 100) : 0, currency: meta.currency, history };
        }
      }
    });
    return res.status(200).json({ market: data });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// Multi-source RSS with finance keyword filtering
async function getNews(res) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
    'Accept-Language': 'tr-TR,tr;q=0.9',
  };

  const FEEDS = [
    { url: 'https://tr.investing.com/rss/news.rss', source: 'Investing.com TR' },
    { url: 'https://tr.investing.com/rss/news_14.rss', source: 'Investing.com Hisse' },
    { url: 'https://www.bloomberght.com/rss/haberler', source: 'Bloomberg HT' },
    { url: 'https://www.dunya.com/rss/dunya_ekonomi.xml', source: 'Dünya Ekonomi' },
    { url: 'https://www.bloomberght.com/rss/ekonomi', source: 'Bloomberg HT Ekonomi' },
    { url: 'https://www.haberler.com/finans/rss/', source: 'Haberler Finans' },
    { url: 'https://www.ekonomim.com/rss', source: 'Ekonomim' },
  ];

  // Finance/economy keywords filter — exclude irrelevant news
  const FINANCE_KW = ['borsa','hisse','faiz','dolar','euro','enflasyon','merkez bankası','fed','piyasa','bist','thyao','eregl','ekonomi','döviz','altın','petrol','kripto','bitcoin','finans','bütçe','ihracat','ithalat','büyüme','gdp','tcmb','erdoğan ekonomi','yatırım','fon','tahvil','hata yok'];
  const BLOCK_KW = ['sivilce','cilt','güzellik','moda','magazin','spor','maç','futbol','basketbol','siyaset','seçim','deprem','savaş','askerlik','şiddet','kaza','cinayet'];

  function isFinanceNews(title) {
    const t = title.toLowerCase();
    // Block explicit non-finance
    if (BLOCK_KW.some(k => t.includes(k))) return false;
    return true; // Bloomberg HT ve Dünya zaten finans odaklı
  }

  for (const feed of FEEDS) {
    try {
      const r = await fetch(feed.url, { headers, signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = parseRSS(xml, feed.source)
        .filter(n => isFinanceNews(n.title))
        .slice(0, 8);
      if (items.length >= 4) {
        return res.status(200).json({ news: items, source: feed.source });
      }
    } catch { continue; }
  }

  // Fallback: Yahoo Finance Turkish market news
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v1/finance/search?q=borsa+istanbul+hisse+ekonomi&newsCount=8&quotesCount=0&lang=tr',
      { headers }
    );
    const data = await r.json();
    const news = (data?.news || [])
      .filter(n => isFinanceNews(n.title || ''))
      .slice(0, 8)
      .map(n => ({ title: n.title, publisher: n.publisher, link: n.link, providerPublishTime: n.providerPublishTime }));
    return res.status(200).json({ news, source: 'Yahoo Finance' });
  } catch { return res.status(200).json({ news: [], source: '' }); }
}

function parseRSS(xml, source) {
  const items = [];
  const matches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi);
  for (const match of matches) {
    const c = match[1];
    const get = (tag) => {
      const m = c.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get('title');
    const link = get('link') || c.match(/<link>(.*?)<\/link>/i)?.[1] || '';
    const pubDate = get('pubDate');
    const ts = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
    if (title && title.length > 10) {
      items.push({ title, publisher: source, link, providerPublishTime: ts });
    }
    if (items.length >= 8) break;
  }
  return items;
}

async function searchTicker(query, res) {
  // Sanitize: max 20 karakter, sadece harf/rakam/boşluk
  query = String(query).replace(/[^a-zA-Z0-9\s]/g, '').slice(0, 20).trim();
  if (!query) return res.status(400).json({ results: [] });
  const BIST = {
    'THYAO':'Türk Hava Yolları','EREGL':'Ereğli Demir Çelik','SAHOL':'Sabancı Holding',
    'KCHOL':'Koç Holding','ASELS':'Aselsan','BIMAS':'BİM Mağazalar','TUPRS':'Tüpraş',
    'AKBNK':'Akbank','ISCTR':'İş Bankası','FROTO':'Ford Otosan','TOASO':'Tofaş Otomobil',
    'VAKBN':'Vakıfbank','PGSUS':'Pegasus','TAVHL':'TAV Havalimanları','SISE':'Şişecam',
    'TURSG':'Türkiye Sigorta','GARAN':'Garanti BBVA','YKBNK':'Yapı Kredi','HALKB':'Halkbank',
    'TCELL':'Turkcell','TTKOM':'Türk Telekom','ARCLK':'Arçelik','VESTL':'Vestel',
    'ENKAI':'Enka İnşaat','PETKM':'Petkim','KOZAL':'Koza Altın','KRDMD':'Kardemir',
    'SOKM':'Şok Marketler','MGROS':'Migros','ULKER':'Ülker','CCOLA':'Coca-Cola İçecek',
    'MAVI':'Mavi Giyim','LOGO':'Logo Yazılım','EKGYO':'Emlak Konut','ENJSA':'Enerjisa'
  };
  const q = query.toUpperCase();
  const bm = Object.entries(BIST).filter(([k,v]) => k.startsWith(q) || v.toUpperCase().includes(q))
    .slice(0,6).map(([t,n]) => ({ticker:t, name:n, exchange:'BIST'}));
  if (bm.length > 0) return res.status(200).json({ results: bm });
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await r.json();
    const quotes = (data?.quotes || [])
      .filter(q => q.quoteType === 'EQUITY' && !q.symbol.includes('.'))
      .slice(0,5).map(q => ({ticker:q.symbol, name:q.longname||q.shortname||q.symbol, exchange:q.exchDisp||'US'}));
    return res.status(200).json({ results: quotes });
  } catch { return res.status(200).json({ results: [] }); }
}
