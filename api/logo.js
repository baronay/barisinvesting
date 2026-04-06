// /api/logo.js — Barış Investing
// Sunucu taraflı logo proxy — CORS sorununu ortadan kaldırır
// GET /api/logo?domain=thy.com
// GET /api/logo?domain=apple.com&sz=128
// Canvas'ta crossOrigin sorunu olmadan kullanılabilir

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 saat — logolar sık değişmez

// Bilinen şirketler için fallback domain haritası
const DOMAIN_MAP = {
  // BIST
  'THYAO': 'thy.com',
  'TUPRS': 'tupras.com.tr',
  'EREGL': 'erdemir.com.tr',
  'SAHOL': 'sabancı.com',
  'KCHOL': 'koc.com.tr',
  'ASELS': 'aselsan.com.tr',
  'BIMAS': 'bim.com.tr',
  'AKBNK': 'akbank.com',
  'GARAN': 'garantibbva.com.tr',
  'ISCTR': 'isbank.com.tr',
  'YKBNK': 'yapikredi.com.tr',
  'TCELL': 'turkcell.com.tr',
  'FROTO': 'ford.com.tr',
  'TOASO': 'tofas.com.tr',
  'PGSUS': 'flypgs.com',
  'TAVHL': 'tav.aero',
  'SISE':  'sisecam.com',
  'ENKAI': 'enka.com',
  'PETKM': 'petkim.com.tr',
  'KOZAL': 'koza-altin.com.tr',
  'KRDMD': 'kardemir.com.tr',
  'SOKM':  'sok.com.tr',
  'MGROS': 'migros.com.tr',
  'LOGO':  'logo.com.tr',
  'EKGYO': 'emlakkonut.com.tr',
  'TTKOM': 'turktelekom.com.tr',
  'ARCLK': 'arcelik.com',
  'VESTL': 'vestel.com.tr',
  // NYSE/NASDAQ
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

  // Domain temizle
  domain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();

  if (!domain) {
    // 1x1 şeffaf PNG döndür
    return sendPlaceholder(res);
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
      console.log(`[Logo] ${domain} → ${url} (${buf.length} bytes)`);
      return res.status(200).send(buf);

    } catch (e) {
      console.log(`[Logo] ${domain} ${url} hata: ${e.message}`);
    }
  }

  // Hiçbiri çalışmadı → şeffaf placeholder
  return sendPlaceholder(res);
}

function sendPlaceholder(res) {
  // 1x1 şeffaf PNG (base64)
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).send(PNG);
}
