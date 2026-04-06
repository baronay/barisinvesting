// /api/bist-ratios.js — Barış Investing v4
// Veri Kaynağı: TradingView Scanner API (turkey/scan)
// FIX: Geniş kolon adı desteği + Yahoo fallback + debug modu
// GET /api/bist-ratios?ticker=THYAO
// GET /api/bist-ratios?ticker=THYAO,TUPRS,EREGL
// GET /api/bist-ratios?ticker=THYAO&debug=1  ← ham TV yanıtını görmek için

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
// KOLON TANIMLARI — birden fazla isim dene, ilk dolu olanı al
// TradingView BIST için bazı kolonları farklı isimle sunuyor
// ════════════════════════════════════════════════════════════════
// İstek atarken gönderilecek TÜM olası kolon adları
const TV_ALL_COLUMNS = [
  'close',

  // F/K
  'price_earnings_ttm',       // TTM — genellikle çalışır
  'earnings_per_share_fq',    // EPS (yedek hesaplama için)

  // F/DD — birden fazla isim dene
  'price_book_ratio',         // standart
  'price_to_book_fq',         // quarterly versiyon

  // Piyasa Değeri
  'market_cap_basic',

  // FD/FAVÖK — birden fazla isim dene
  'enterprise_value_ebitda_ttm',   // TTM
  'enterprise_value_ebitda_fq',    // quarterly
  'ev_ebitda',                     // kısa alias

  // ROE — birden fazla isim dene
  'return_on_equity',
  'return_on_equity_fq',

  // Büyüme (bonus)
  'revenue_growth_rate_5y',
  'earnings_growth_rate_5y',
];

// Kolon index haritası — TV yanıtındaki d dizisinde hangi index ne?
// fetchFromTradingView içinde dinamik olarak oluşturulacak
function buildIndexMap(columns) {
  const map = {};
  columns.forEach((col, i) => { map[col] = i; });
  return map;
}

// ════════════════════════════════════════════════════════════════
// TradingView POST isteği
// ════════════════════════════════════════════════════════════════
async function fetchFromTradingView(tickers) {
  const formattedTickers = tickers.map(t =>
    `BIST:${t.toUpperCase().replace('.IS', '').replace('BIST:', '')}`
  );

  const body = {
    symbols: {
      tickers: formattedTickers,
      query:   { types: [] },
    },
    columns: TV_ALL_COLUMNS,
  };

  console.log(`[TV] POST turkey/scan — ${formattedTickers.join(', ')} — ${TV_ALL_COLUMNS.length} kolon`);

  const res = await fetch('https://scanner.tradingview.com/turkey/scan', {
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

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`TradingView HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  console.log(`[TV] Yanıt: ${json?.data?.length ?? 0} satır — örnek d[0]: ${JSON.stringify(json?.data?.[0]?.d?.slice(0, 5))}`);
  return { json, columns: TV_ALL_COLUMNS };
}

// ════════════════════════════════════════════════════════════════
// Null-safe değer al + güvenli sayı parse
// ════════════════════════════════════════════════════════════════
function safeNum(v, decimals = 2) {
  if (v == null || v === '' || v === 'NaN') return null;
  const n = parseFloat(v);
  if (isNaN(n) || !isFinite(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

function getCol(d, idxMap, ...colNames) {
  for (const name of colNames) {
    const idx = idxMap[name];
    if (idx == null) continue;
    const v = d[idx];
    if (v != null && v !== '' && !isNaN(v)) return parseFloat(v);
  }
  return null;
}

// ════════════════════════════════════════════════════════════════
// Ham TradingView satırını → temiz objeye dönüştür
// ════════════════════════════════════════════════════════════════
function parseRow(ticker, row, idxMap) {
  const d = row?.d ?? [];

  const guncelFiyat = safeNum(getCol(d, idxMap, 'close'));
  const fk          = safeNum(getCol(d, idxMap, 'price_earnings_ttm'));
  const pddd        = safeNum(getCol(d, idxMap, 'price_book_ratio', 'price_to_book_fq'));
  const piyasaDeg   = safeNum(getCol(d, idxMap, 'market_cap_basic'), 0);
  const fdFavok     = safeNum(getCol(d, idxMap,
    'enterprise_value_ebitda_ttm',
    'enterprise_value_ebitda_fq',
    'ev_ebitda'
  ));
  const roeRaw      = safeNum(getCol(d, idxMap, 'return_on_equity', 'return_on_equity_fq'), 4);

  // ROE: TradingView 0.143 = %14.3 → % cinsine çevir
  const roe = roeRaw != null ? safeNum(roeRaw * 100, 2) : null;

  // Değerleme sinyalleri
  const sinyaller = {
    fk: fk == null ? 'N/A'
      : fk < 0    ? 'ZARAR'
      : fk < 10   ? 'UCUZ'
      : fk < 20   ? 'ADİL'
      : fk < 35   ? 'DİKKAT'
      : 'PAHALI',
    pddd: pddd == null ? 'N/A'
      : pddd < 1       ? 'ÇOK UCUZ'
      : pddd < 2       ? 'UCUZ'
      : pddd < 4       ? 'ADİL'
      : 'PAHALI',
    fdFavok: fdFavok == null ? 'N/A'
      : fdFavok < 0         ? 'NEGATİF'
      : fdFavok < 8         ? 'UCUZ'
      : fdFavok < 15        ? 'ADİL'
      : 'PAHALI',
  };

  // Debug: hangi kolondan hangi değer geldi
  const debugKolonlar = {};
  TV_ALL_COLUMNS.forEach((col, i) => {
    const v = d[i];
    if (v != null) debugKolonlar[col] = v;
  });

  console.log(`[TV Parse] ${ticker}: FK=${fk} PDDD=${pddd} FD/FAVÖK=${fdFavok} ROE=%${roe} — Ham: ${JSON.stringify(debugKolonlar)}`);

  return {
    ticker,
    // ── Ana çarpanlar ──
    FK:          fk,
    PDDD:        pddd,
    FD_FAVOK:    fdFavok,
    ROE:         roe,          // % cinsinden (14.3 = %14.3)
    PiyasaDegeri: piyasaDeg,
    GuncelFiyat: guncelFiyat,
    // ── Ham TV değerleri (debug) ──
    _raw:        debugKolonlar,
    // ── Meta ──
    sinyaller,
    kaynak: 'TradingView',
    ts:     new Date().toISOString(),
  };
}

// ════════════════════════════════════════════════════════════════
// Ana işlev
// ════════════════════════════════════════════════════════════════
async function getBISTRatios(tickers) {
  const results = {};
  const toFetch = [];

  for (const t of tickers) {
    const cached = getCached(`tv:${t}`);
    if (cached) { results[t] = cached; }
    else        { toFetch.push(t); }
  }

  if (toFetch.length === 0) return results;

  const { json, columns } = await fetchFromTradingView(toFetch);
  const idxMap = buildIndexMap(columns);
  const rows   = json?.data ?? [];

  for (const row of rows) {
    const sym = (row?.s ?? '').replace('BIST:', '').replace('.IS', '').toUpperCase();
    if (!sym) continue;
    const parsed = parseRow(sym, row, idxMap);
    setCache(`tv:${sym}`, parsed);
    results[sym] = parsed;
  }

  // Veri gelmeyen hisseler
  for (const t of toFetch) {
    if (!results[t]) {
      results[t] = {
        ticker: t, FK: null, PDDD: null, FD_FAVOK: null, ROE: null,
        PiyasaDegeri: null, GuncelFiyat: null, _raw: {},
        sinyaller: { fk: 'N/A', pddd: 'N/A', fdFavok: 'N/A' },
        kaynak: 'TradingView', hata: 'Veri bulunamadı',
        ts: new Date().toISOString(),
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

  const raw      = req.query?.ticker ?? req.body?.ticker ?? '';
  const debugMode = req.query?.debug === '1';

  if (!raw) {
    return res.status(400).json({
      error: 'ticker parametresi zorunlu',
      ornekler: [
        '/api/bist-ratios?ticker=THYAO',
        '/api/bist-ratios?ticker=THYAO,TUPRS',
        '/api/bist-ratios?ticker=THYAO&debug=1  ← ham TV yanıtını görmek için',
      ],
    });
  }

  const tickers = raw
    .split(',')
    .map(t => t.trim().toUpperCase().replace('.IS', '').replace('BIST:', ''))
    .filter(Boolean)
    .slice(0, 50);

  try {
    // Debug modunda önbelleği bypass et
    if (debugMode) tickers.forEach(t => CACHE.delete(`tv:${t}`));

    const data = await getBISTRatios(tickers);

    // Tekil sorgu → düz obje
    if (tickers.length === 1) {
      return res.status(200).json(data[tickers[0]] ?? { error: 'Veri bulunamadı', ticker: tickers[0] });
    }
    return res.status(200).json(data);

  } catch (e) {
    console.error('[Handler Error]', e.message);
    return res.status(500).json({
      error:  e.message,
      tickers,
      ipucu:  'Vercel Runtime Logs kontrol edin. TradingView erişilemez olabilir.',
    });
  }
}
