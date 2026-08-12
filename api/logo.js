// /api/logo.js — Barış Investing
// Sunucu taraflı logo proxy — CORS sorununu ortadan kaldırır
// GET /api/logo?domain=thy.com
// GET /api/logo?domain=apple.com&sz=128
// Canvas'ta crossOrigin sorunu olmadan kullanılabilir

const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
function dlog(...args) { if (DEBUG_LOGS) console.log(...args); }

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 saat — logolar sık değişmez

// Bilinen şirketler için fallback domain haritası
const DOMAIN_MAP = {
  // ── BIST — Bankalar & Holdingler ──
  'AKBNK': 'akbank.com',
  'GARAN': 'garantibbva.com.tr',
  'ISCTR': 'isbank.com.tr',
  'YKBNK': 'yapikredi.com.tr',
  'HALKB': 'halkbank.com.tr',
  'VAKBN': 'vakifbank.com.tr',
  'TSKB':  'tskb.com.tr',
  'SKBNK': 'sekerbank.com.tr',
  'ALBRK': 'albaraka.com.tr',
  'ICBCT': 'icbc.com.tr',
  'KCHOL': 'koc.com.tr',
  'SAHOL': 'sabanci.com',
  'AGHOL': 'anadolugrubu.com.tr',
  'DOHOL': 'doganholding.com.tr',
  'GLYHO': 'globalyatirim.com.tr',
  'ALARK': 'alarko.com.tr',
  'TKFEN': 'tekfen.com.tr',
  'ENKAI': 'enka.com',
  'SISE':  'sisecam.com',
  // ── BIST — Sanayi & Enerji ──
  'EREGL': 'erdemir.com.tr',
  'ISDMR': 'isdemir.com.tr',
  'KRDMD': 'kardemir.com.tr',
  'TUPRS': 'tupras.com.tr',
  'PETKM': 'petkim.com.tr',
  'SASA':  'sasa.com.tr',
  'AKSA':  'aksa.com',
  'ALKIM': 'alkim.com.tr',
  'BAGFS': 'bagfas.com.tr',
  'GUBRF': 'gubretas.com.tr',
  'HEKTS': 'hektas.com.tr',
  'KORDS': 'kordsa.com',
  'BRISA': 'brisa.com.tr',
  'CIMSA': 'cimsa.com.tr',
  'AKCNS': 'akcansa.com.tr',
  'OYAKC': 'oyakcimento.com',
  'BRSAN': 'borusanboru.com',
  'EGEEN': 'egeendustri.com.tr',
  'PARSN': 'parsan.com.tr',
  'KARTN': 'kartonsan.com.tr',
  'ECILC': 'eczacibasi.com.tr',
  // Enerji
  'ENJSA': 'enerjisa.com.tr',
  'AKSEN': 'aksaenerji.com.tr',
  'ZOREN': 'zorluenerji.com.tr',
  'AYDEM': 'aydemenerji.com.tr',
  'GWIND': 'galatawind.com',
  'ASTOR': 'astor.com.tr',
  'KONTR': 'kontrolmatik.com',
  // ── BIST — Otomotiv & Ulaştırma ──
  'FROTO': 'fordotosan.com.tr',
  'TOASO': 'tofas.com.tr',
  'OTKAR': 'otokar.com.tr',
  'KARSN': 'karsan.com.tr',
  'TTRAK': 'turktraktor.com.tr',
  'TMSN':  'tumosan.com.tr',
  'DOAS':  'doas.com.tr',
  'THYAO': 'thy.com',
  'PGSUS': 'flypgs.com',
  'TAVHL': 'tav.aero',
  'CLEBI': 'celebi.com',
  // ── BIST — Perakende & Tüketim ──
  'BIMAS': 'bim.com.tr',
  'MGROS': 'migros.com.tr',
  'SOKM':  'sok.com.tr',
  'BIZIM': 'bizimtoptan.com.tr',
  'CRFSA': 'carrefoursa.com',
  'MAVI':  'mavicompany.com',
  'YATAS': 'yatas.com.tr',
  'ULKER': 'ulker.com.tr',
  'AEFES': 'anadoluefes.com',
  'CCOLA': 'coca-colaic.com',
  'BANVT': 'banvit.com',
  'PNSUT': 'pinar.com.tr',
  'TATGD': 'tatgida.com',
  'SELEC': 'selcukecza.com.tr',
  'MPARK': 'mlpcare.com',
  'ARCLK': 'arcelik.com',
  'VESTL': 'vestel.com.tr',
  'VESBE': 'vestel.com.tr',
  // ── BIST — Telekom & Teknoloji ──
  'TCELL': 'turkcell.com.tr',
  'TTKOM': 'turktelekom.com.tr',
  'ASELS': 'aselsan.com.tr',
  'LOGO':  'logo.com.tr',
  'KAREL': 'karel.com.tr',
  'NETAS': 'netas.com.tr',
  'ARENA': 'arena.com.tr',
  // ── BIST — GYO & Madencilik ──
  'EKGYO': 'emlakkonut.com.tr',
  'ISGYO': 'isgyo.com.tr',
  'TRGYO': 'torunlargyo.com.tr',
  'KOZAL': 'koza-altin.com.tr',
  // ── NYSE / NASDAQ ──
  'AAPL':  'apple.com',
  'MSFT':  'microsoft.com',
  'NVDA':  'nvidia.com',
  'GOOGL': 'google.com',
  'META':  'meta.com',
  'AMZN':  'amazon.com',
  'TSLA':  'tesla.com',
  'AMD':   'amd.com',
  'PLTR':  'palantir.com',
  'CRWD':  'crowdstrike.com',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // domain veya ticker'dan domain türet
  let domain = req.query?.domain || '';
  const ticker = (req.query?.ticker || '').toUpperCase().replace('.IS', '');
  const sz = parseInt(req.query?.sz || '128');

  // Ticker → domain haritasından al
  if (!domain && ticker && DOMAIN_MAP[ticker]) {
    domain = DOMAIN_MAP[ticker];
  }

  // Domain temizle — sadece gecerli hostname karakterleri kalsin
  // (domain ucuncu taraf URL'lerine gomuluyor; ?/&/@ ile query/SSRF enjeksiyonunu engelle)
  domain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');

  if (!domain) {
    // Domain bilinmiyor → 404 ki <img> onerror tetiklensin, çağıran avatar/baş harf göstersin
    return res.status(404).json({ error: 'domain bilinmiyor' });
  }

  const cacheKey = `logo:${domain}:${sz}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.setHeader('Content-Type', cached.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(cached.buf);
  }

  // Kaynak sırası: Clearbit → Google S2 → Fallback
  const sources = [
    `https://logo.clearbit.com/${domain}?size=${sz}`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=${sz}`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];

  for (const url of sources) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BarisInvesting/1.0)' },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      });

      if (!r.ok) continue;

      const mime = r.headers.get('content-type') || 'image/png';
      // SVG veya HTML döndüyse atla (Clearbit bazen 1x1 SVG döner)
      if (mime.includes('text') || mime.includes('svg')) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) continue; // Çok küçük = placeholder

      // Cache'e al
      CACHE.set(cacheKey, { buf, mime, ts: Date.now() });
      if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value);

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      dlog(`[Logo] ${domain} → ${url} (${buf.length} bytes)`);
      return res.status(200).send(buf);

    } catch (e) {
      dlog(`[Logo] ${domain} ${url} hata: ${e.message}`);
    }
  }

  // Hiçbiri çalışmadı → 404 (çağıran <img> onerror ile avatar/baş harf gösterir)
  return res.status(404).json({ error: 'logo bulunamadı' });
}
