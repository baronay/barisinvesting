// /api/bist-ratios.js — Barış Investing v6
// FIX: Minimal kolon seti — sadece TradingView turkey/scan'da kesin çalışanlar
// Sorunlu olanlar kaldırıldı: price_to_book_fq, revenue_growth_rate_5y, ev_ebitda, enterprise_value_ebitda_fq

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

// Sadece kesin çalıştığı bilinen kolonlar
const TV_COLUMNS = [
  'close',                        // 0 — Fiyat
  'price_earnings_ttm',           // 1 — F/K
  'price_book_ratio',             // 2 — PD/DD
  'market_cap_basic',             // 3 — Piyasa Değeri
  'enterprise_value_ebitda_ttm',  // 4 — FD/FAVÖK
  'return_on_equity',             // 5 — ROE
  'debt_to_equity',               // 6 — Borç/Özsermaye
  'earnings_per_share_basic_ttm', // 7 — EPS (F/K yedek)
];

const IDX = Object.fromEntries(TV_COLUMNS.map((c, i) => [c, i]));

function safeNum(v, dec = 2) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return (isNaN(n) || !isFinite(n)) ? null : parseFloat(n.toFixed(dec));
}

function col(d, name) {
  const i = IDX[name];
  return (i != null && d[i] != null) ? d[i] : null;
}

async function fetchTV(tickers) {
  const syms = tickers.map(t => `BIST:${t.replace('.IS','').replace('BIST:','').toUpperCase()}`);
  const body = { symbols: { tickers: syms, query: { types: [] } }, columns: TV_COLUMNS };

  console.log(`[TV v6] POST — ${syms.join(', ')}`);

  const res = await fetch('https://scanner.tradingview.com/turkey/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept':       'application/json',
      'Origin':       'https://www.tradingview.com',
      'Referer':      'https://www.tradingview.com/',
      'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body:   JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`TradingView HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }

  const json = await res.json();
  console.log(`[TV v6] ${json?.data?.length ?? 0} satır — d[]:`, JSON.stringify(json?.data?.[0]?.d));
  return json;
}

function parseRow(ticker, row) {
  const d = row?.d ?? [];

  const fiyat   = safeNum(col(d, 'close'));
  const fk      = safeNum(col(d, 'price_earnings_ttm'));
  const pddd    = safeNum(col(d, 'price_book_ratio'));
  const mc      = safeNum(col(d, 'market_cap_basic'), 0);
  const fdFavok = safeNum(col(d, 'enterprise_value_ebitda_ttm'));
  const roeRaw  = safeNum(col(d, 'return_on_equity'), 4);
  const de      = safeNum(col(d, 'debt_to_equity'));
  const eps     = safeNum(col(d, 'earnings_per_share_basic_ttm'));

  // TV return_on_equity zaten % cinsinden gelir (14.85 = %14.85), x100 yapma
  const roe = roeRaw;

  // F/K yedek: fiyat / EPS
  let fkFinal = fk;
  if (fkFinal == null && fiyat && eps && eps > 0) {
    fkFinal = safeNum(fiyat / eps);
    console.log(`[TV v6] ${ticker} F/K EPS yedek: ${fiyat}/${eps}=${fkFinal}`);
  }

  const _raw = {};
  TV_COLUMNS.forEach((c, i) => { if (d[i] != null) _raw[c] = d[i]; });
  console.log(`[TV v6] ${ticker}: FK=${fkFinal} PDDD=${pddd} FDFAVOK=${fdFavok} ROE%=${roe} D/E=${de}`);

  return {
    ticker,
    FK:           fkFinal,
    PDDD:         pddd,
    FD_FAVOK:     fdFavok,
    ROE:          roe,
    DebtEquity:   de,
    PiyasaDegeri: mc,
    GuncelFiyat:  fiyat,
    _raw,
    sinyaller: {
      fk:     fkFinal == null ? 'N/A' : fkFinal < 0 ? 'ZARAR' : fkFinal < 10 ? 'UCUZ' : fkFinal < 20 ? 'ADİL' : fkFinal < 35 ? 'DİKKAT' : 'PAHALI',
      pddd:   pddd    == null ? 'N/A' : pddd < 1 ? 'ÇOK UCUZ' : pddd < 2 ? 'UCUZ' : pddd < 4 ? 'ADİL' : 'PAHALI',
      fdFavok:fdFavok == null ? 'N/A' : fdFavok < 0 ? 'NEGATİF' : fdFavok < 8 ? 'UCUZ' : fdFavok < 15 ? 'ADİL' : 'PAHALI',
    },
    kaynak: 'TradingView',
    ts: new Date().toISOString(),
  };
}

async function getBISTRatios(tickers) {
  const results = {};
  const toFetch = [];

  for (const t of tickers) {
    const cached = getCached(`tv:${t}`);
    if (cached) { results[t] = cached; } else { toFetch.push(t); }
  }
  if (!toFetch.length) return results;

  const json = await fetchTV(toFetch);
  for (const row of (json?.data ?? [])) {
    const sym = (row?.s ?? '').replace('BIST:', '').toUpperCase();
    if (!sym) continue;
    const parsed = parseRow(sym, row);
    setCache(`tv:${sym}`, parsed);
    results[sym] = parsed;
  }

  for (const t of toFetch) {
    if (!results[t]) results[t] = {
      ticker: t, FK: null, PDDD: null, FD_FAVOK: null, ROE: null,
      DebtEquity: null, PiyasaDegeri: null, GuncelFiyat: null, _raw: {},
      sinyaller: { fk: 'N/A', pddd: 'N/A', fdFavok: 'N/A' },
      kaynak: 'TradingView', hata: 'Veri bulunamadı', ts: new Date().toISOString(),
    };
  }
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const raw       = req.query?.ticker ?? req.body?.ticker ?? '';
  const debugMode = req.query?.debug === '1';
  if (!raw) return res.status(400).json({ error: 'ticker parametresi zorunlu. Örnek: ?ticker=THYAO' });

  const tickers = raw.split(',')
    .map(t => t.trim().toUpperCase().replace('.IS','').replace('BIST:',''))
    .filter(Boolean).slice(0, 50);

  try {
    if (debugMode) tickers.forEach(t => CACHE.delete(`tv:${t}`));
    const data = await getBISTRatios(tickers);
    if (tickers.length === 1) return res.status(200).json(data[tickers[0]] ?? { error: 'Veri bulunamadı' });
    return res.status(200).json(data);
  } catch (e) {
    console.error('[Handler Error]', e.message);
    return res.status(500).json({ error: e.message, tickers });
  }
}
