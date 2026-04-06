// /api/bist-ratios.js — Barış Investing v5
// Veri Kaynağı: TradingView Scanner API (turkey/scan)
// FIX v5: Sadece TradingView'in tanıdığı kolon adları — doğrulanmış liste
// GET /api/bist-ratios?ticker=THYAO
// GET /api/bist-ratios?ticker=THYAO,TUPRS,EREGL
// GET /api/bist-ratios?ticker=THYAO&debug=1

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
// KOLONLAR — sadece TradingView'in turkey/scan'da tanıdığı isimler
// Hata alan: price_to_book_fq, enterprise_value_ebitda_fq, ev_ebitda
// ════════════════════════════════════════════════════════════════
const TV_COLUMNS = [
  'close',                       // 0  — Güncel fiyat (TRY)
  'price_earnings_ttm',          // 1  — F/K (TTM)
  'price_book_ratio',            // 2  — PD/DD
  'market_cap_basic',            // 3  — Piyasa Değeri
  'enterprise_value_ebitda_ttm', // 4  — FD/FAVÖK
  'return_on_equity',            // 5  — ROE (0–1 arası)
  'debt_to_equity',              // 6  — Borç/Özsermaye
  'earnings_per_share_basic_ttm',// 7  — EPS (F/K yedek hesabı için)
  'revenue_growth_rate_5y',      // 8  — 5 yıllık gelir büyümesi
];

// index → kolon adı haritası (d dizisinde hangi index ne)
const IDX = Object.fromEntries(TV_COLUMNS.map((col, i) => [col, i]));

// ════════════════════════════════════════════════════════════════
// TradingView POST isteği
// ════════════════════════════════════════════════════════════════
async function fetchFromTradingView(tickers) {
  const syms = tickers.map(t =>
    `BIST:${t.toUpperCase().replace('.IS', '').replace('BIST:', '')}`
  );

  const body = {
    symbols: { tickers: syms, query: { types: [] } },
    columns: TV_COLUMNS,
  };

  console.log(`[TV v5] POST turkey/scan — ${syms.join(', ')}`);

  const res = await fetch('https://scanner.tradingview.com/turkey/scan', {
    method: 'POST',
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
    throw new Error(`TradingView HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }

  const json = await res.json();
  console.log(`[TV v5] Yanıt: ${json?.data?.length ?? 0} satır`);
  if (json?.data?.[0]) {
    console.log(`[TV v5] İlk satır d[]:`, JSON.stringify(json.data[0].d));
  }
  return json;
}

// ════════════════════════════════════════════════════════════════
// Yardımcılar
// ════════════════════════════════════════════════════════════════
function safeNum(v, decimals = 2) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  if (isNaN(n) || !isFinite(n)) return null;
  return parseFloat(n.toFixed(decimals));
}

function col(d, colName) {
  const idx = IDX[colName];
  if (idx == null) return null;
  return d[idx] ?? null;
}

// ════════════════════════════════════════════════════════════════
// Satır parse → temiz obje
// ════════════════════════════════════════════════════════════════
function parseRow(ticker, row) {
  const d = row?.d ?? [];

  const guncelFiyat = safeNum(col(d, 'close'));
  const fk          = safeNum(col(d, 'price_earnings_ttm'));
  const pddd        = safeNum(col(d, 'price_book_ratio'));
  const piyasaDeg   = safeNum(col(d, 'market_cap_basic'), 0);
  const fdFavok     = safeNum(col(d, 'enterprise_value_ebitda_ttm'));
  const roeRaw      = safeNum(col(d, 'return_on_equity'), 4);
  const de          = safeNum(col(d, 'debt_to_equity'));
  const eps         = safeNum(col(d, 'earnings_per_share_basic_ttm'));
  const revGrowth   = safeNum(col(d, 'revenue_growth_rate_5y'), 4);

  // ROE: TV 0.143 → %14.3
  const roe = roeRaw != null ? safeNum(roeRaw * 100, 2) : null;

  // Büyüme oranı: TV 0.12 → %12
  const gelirBuyume = revGrowth != null ? safeNum(revGrowth * 100, 1) : null;

  // F/K yedek: Fiyat / EPS (TV'nin price_earnings_ttm null gelirse)
  let fkFinal = fk;
  if (fkFinal == null && guncelFiyat != null && eps != null && eps > 0) {
    fkFinal = safeNum(guncelFiyat / eps);
    console.log(`[TV v5] ${ticker}: F/K EPS yedek: ${guncelFiyat}/${eps}=${fkFinal}`);
  }

  const sinyaller = {
    fk: fkFinal == null ? 'N/A'
      : fkFinal < 0    ? 'ZARAR'
      : fkFinal < 10   ? 'UCUZ'
      : fkFinal < 20   ? 'ADİL'
      : fkFinal < 35   ? 'DİKKAT'
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

  // Ham değerler (debug için) — tüm kolonlar
  const _raw = {};
  TV_COLUMNS.forEach((colName, i) => {
    if (d[i] != null) _raw[colName] = d[i];
  });

  console.log(`[TV v5 Parse] ${ticker}: FK=${fkFinal} PDDD=${pddd} FD/FAVÖK=${fdFavok} ROE=%${roe} D/E=${de}`);

  return {
    ticker,
    FK:           fkFinal,
    PDDD:         pddd,
    FD_FAVOK:     fdFavok,
    ROE:          roe,
    DebtEquity:   de,
    GelirBuyume:  gelirBuyume,
    PiyasaDegeri: piyasaDeg,
    GuncelFiyat:  guncelFiyat,
    _raw,
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
    if (cached) { console.log(`[Cache HIT] ${t}`); results[t] = cached; }
    else        { toFetch.push(t); }
  }
  if (toFetch.length === 0) return results;

  const json = await fetchFromTradingView(toFetch);
  const rows = json?.data ?? [];

  for (const row of rows) {
    const sym = (row?.s ?? '').replace('BIST:', '').replace('.IS', '').toUpperCase();
    if (!sym) continue;
    const parsed = parseRow(sym, row);
    setCache(`tv:${sym}`, parsed);
    results[sym] = parsed;
  }

  // Yanıt gelmeyen hisseler
  for (const t of toFetch) {
    if (!results[t]) {
      results[t] = {
        ticker: t, FK: null, PDDD: null, FD_FAVOK: null, ROE: null,
        DebtEquity: null, GelirBuyume: null,
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

  const raw       = req.query?.ticker ?? req.body?.ticker ?? '';
  const debugMode = req.query?.debug === '1';

  if (!raw) {
    return res.status(400).json({
      error: 'ticker parametresi zorunlu',
      ornekler: [
        '/api/bist-ratios?ticker=THYAO',
        '/api/bist-ratios?ticker=THYAO,TUPRS',
        '/api/bist-ratios?ticker=THYAO&debug=1',
      ],
    });
  }

  const tickers = raw
    .split(',')
    .map(t => t.trim().toUpperCase().replace('.IS', '').replace('BIST:', ''))
    .filter(Boolean)
    .slice(0, 50);

  try {
    if (debugMode) tickers.forEach(t => CACHE.delete(`tv:${t}`));
    const data = await getBISTRatios(tickers);

    if (tickers.length === 1) {
      return res.status(200).json(data[tickers[0]] ?? { error: 'Veri bulunamadı', ticker: tickers[0] });
    }
    return res.status(200).json(data);

  } catch (e) {
    console.error('[Handler Error]', e.message);
    return res.status(500).json({ error: e.message, tickers });
  }
}
