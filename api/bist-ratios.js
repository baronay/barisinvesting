// /api/bist-ratios.js — Barış Investing v3
// Veri Kaynağı: TradingView Scanner API (turkey/scan)
// Scraping YOK — sadece native fetch ile POST isteği
// GET /api/bist-ratios?ticker=THYAO
// GET /api/bist-ratios?ticker=THYAO,TUPRS,EREGL  (toplu sorgu)

// ════════════════════════════════════════════════════════════════
// ÖNBELLEK — 30 dakika
// ════════════════════════════════════════════════════════════════
const CACHE     = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { CACHE.delete(key); return null; }
  return e.data;
}

function setCache(key, data) {
  if (CACHE.size >= 500) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(key, { data, ts: Date.now() });
}

// ════════════════════════════════════════════════════════════════
// TradingView Scanner sütun tanımları
// ════════════════════════════════════════════════════════════════
const TV_COLUMNS = [
  'close',                       // 0 — Güncel fiyat (TRY)
  'price_earnings_ttm',          // 1 — F/K (TTM)
  'price_book_ratio',            // 2 — PD/DD
  'market_cap_basic',            // 3 — Piyasa Değeri
  'enterprise_value_ebitda_ttm', // 4 — FD/FAVÖK
  'return_on_equity',            // 5 — ROE (0-1 arası, ör: 0.08 = %8)
];

// ════════════════════════════════════════════════════════════════
// TradingView'e POST isteği
// ════════════════════════════════════════════════════════════════
async function fetchFromTradingView(tickers) {
  const formattedTickers = tickers.map(t =>
    `BIST:${t.toUpperCase().replace('.IS', '')}`
  );

  const body = {
    symbols: {
      tickers: formattedTickers,
      query:   { types: [] },
    },
    columns: TV_COLUMNS,
  };

  console.log(`[TradingView] POST → turkey/scan | Hisseler: ${formattedTickers.join(', ')}`);

  const response = await fetch('https://scanner.tradingview.com/turkey/scan', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Origin':       'https://www.tradingview.com',
      'Referer':      'https://www.tradingview.com/',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`TradingView HTTP ${response.status}: ${errText.slice(0, 300)}`);
  }

  const json = await response.json();
  console.log(`[TradingView] Yanıt: ${json?.data?.length ?? 0} satır`);
  return json;
}

// ════════════════════════════════════════════════════════════════
// Ham TradingView satırını → temiz objeye dönüştür
// data.data[0].d dizisi → { FK, PDDD, FD_FAVOK, ROE, ... }
// ════════════════════════════════════════════════════════════════
function parseRow(ticker, row) {
  const d = row?.d ?? [];

  // Güvenli sayı çıkarımı — null/NaN kontrolü
  const safeVal = (idx, decimals = 4) => {
    const v = d[idx];
    if (v == null || v === '' || (typeof v === 'number' && isNaN(v))) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : parseFloat(n.toFixed(decimals));
  };

  const guncelFiyat = safeVal(0, 2);
  const fk          = safeVal(1, 2);   // F/K
  const pddd        = safeVal(2, 2);   // PD/DD
  const piyasaDeg   = safeVal(3, 0);   // Piyasa Değeri (TRY)
  const fdFavok     = safeVal(4, 2);   // FD/FAVÖK
  const roeRaw      = safeVal(5, 4);   // ROE — TradingView 0.143 = %14.3 verir

  // ROE'yi yüzdeye çevir (0.143 → 14.3)
  const roe = roeRaw != null ? parseFloat((roeRaw * 100).toFixed(2)) : null;

  // Değerleme sinyalleri
  const sinyaller = {
    fk: fk == null       ? 'N/A'
      : fk < 0           ? 'ZARAR'
      : fk < 10          ? 'UCUZ'
      : fk < 20          ? 'ADİL'
      : fk < 35          ? 'DİKKAT'
      : 'PAHALI',
    pddd: pddd == null   ? 'N/A'
      : pddd < 1         ? 'ÇOK UCUZ'
      : pddd < 2         ? 'UCUZ'
      : pddd < 4         ? 'ADİL'
      : 'PAHALI',
    fdFavok: fdFavok == null ? 'N/A'
      : fdFavok < 0         ? 'NEGATİF'
      : fdFavok < 8         ? 'UCUZ'
      : fdFavok < 15        ? 'ADİL'
      : 'PAHALI',
  };

  return {
    ticker,
    // ── Ana çarpanlar (Barış Investing formatı) ──
    FK:          fk,
    PDDD:        pddd,
    FD_FAVOK:    fdFavok,
    ROE:         roe,          // % cinsinden, ör: 14.3
    PiyasaDegeri: piyasaDeg,   // TRY
    GuncelFiyat: guncelFiyat,  // TRY
    // ── Ham TV değerleri (debug için) ──
    _raw: {
      close:                       d[0] ?? null,
      price_earnings_ttm:          d[1] ?? null,
      price_book_ratio:            d[2] ?? null,
      market_cap_basic:            d[3] ?? null,
      enterprise_value_ebitda_ttm: d[4] ?? null,
      return_on_equity:            d[5] ?? null,
    },
    // ── Meta ──
    sinyaller,
    kaynak: 'TradingView',
    ts:     new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════
// Ana işlev — tekil veya toplu hisse
// ════════════════════════════════════════════════════════════════
async function getBISTRatios(tickers) {
  const results  = {};
  const toFetch  = [];

  // Önbellekten kontrol
  for (const t of tickers) {
    const key    = `tv:${t}`;
    const cached = getCached(key);
    if (cached) {
      console.log(`[Cache HIT] ${t}`);
      results[t] = cached;
    } else {
      toFetch.push(t);
    }
  }

  if (toFetch.length === 0) return results;

  // TradingView'e tek POST ile tüm hisseleri sor
  const json = await fetchFromTradingView(toFetch);
  const rows  = json?.data ?? [];

  for (const row of rows) {
    // row.s = "BIST:THYAO"
    const sym = (row?.s ?? '').replace('BIST:', '').replace('.IS', '').toUpperCase();
    if (!sym) continue;

    const parsed   = parseRow(sym, row);
    const key      = `tv:${sym}`;
    setCache(key, parsed);
    results[sym]   = parsed;
    console.log(`[TV Parse] ${sym}: FK=${parsed.FK} PDDD=${parsed.PDDD} FD/FAVÖK=${parsed.FD_FAVOK} ROE=%${parsed.ROE}`);
  }

  // Veri gelmeyen hisseler için boş kayıt
  for (const t of toFetch) {
    if (!results[t]) {
      results[t] = {
        ticker:       t,
        FK:           null,
        PDDD:         null,
        FD_FAVOK:     null,
        ROE:          null,
        PiyasaDegeri: null,
        GuncelFiyat:  null,
        _raw:         {},
        sinyaller:    { fk: 'N/A', pddd: 'N/A', fdFavok: 'N/A' },
        kaynak:       'TradingView',
        hata:         'TradingView bu hisse için veri döndürmedi',
        ts:           new Date().toISOString(),
      };
    }
  }

  return results;
}

// ════════════════════════════════════════════════════════════════
// VERCEL HANDLER
// ════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ticker: tekil veya virgülle ayrılmış liste
  const raw = req.query?.ticker ?? req.body?.ticker ?? '';

  if (!raw) {
    return res.status(400).json({
      error: 'ticker parametresi zorunlu',
      ornekler: [
        '/api/bist-ratios?ticker=THYAO',
        '/api/bist-ratios?ticker=THYAO,TUPRS,EREGL',
      ],
    });
  }

  // Temizle ve normalize et
  const tickers = raw
    .split(',')
    .map(t => t.trim().toUpperCase().replace('.IS', '').replace('BIST:', ''))
    .filter(Boolean)
    .slice(0, 50); // güvenlik limiti

  try {
    const data = await getBISTRatios(tickers);

    // Tekil sorgu → düz obje döndür (analyze.js geriye uyumluluk)
    if (tickers.length === 1) {
      const result = data[tickers[0]];
      return res.status(200).json(
        result ?? { error: 'Veri bulunamadı', ticker: tickers[0] }
      );
    }

    // Çoklu sorgu → { THYAO: {...}, TUPRS: {...} }
    return res.status(200).json(data);

  } catch (e) {
    console.error('[Handler Error]', e.message);
    return res.status(500).json({
      error:   e.message,
      tickers,
      ipucu:   'TradingView Scanner erişilemiyor. Vercel Runtime Logs kontrol edin.',
    });
  }
}
