// /api/fair-value.js — Barış Investing
// ════════════════════════════════════════════════════
// FAIR VALUE CALCULATION ENDPOINT
// 3 model: Graham Number · Lynch PEG=1 · Simplified DCF
// Veri: BIST → Yahoo, NYSE/NASDAQ → Twelve Data
// Cache: Supabase (24h TTL) + in-memory hot cache (5dk)
// ════════════════════════════════════════════════════

const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY;
const TD_KEY    = process.env.TWELVE_DATA_API_KEY;

const CACHE_TTL_MS    = 24 * 60 * 60 * 1000;   // 24 saat (DB cache)
const HOT_CACHE_TTL   = 5 * 60 * 1000;          // 5 dakika (in-memory)
const TIMEOUT_MS      = 12000;
const VALID_EXCHANGES = new Set(['BIST', 'NYSE', 'NASDAQ']);

// ── In-memory hot cache ──
const HOT = new Map();
function hotGet(key) {
  const e = HOT.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > HOT_CACHE_TTL) { HOT.delete(key); return null; }
  return e.data;
}
function hotSet(key, data) {
  if (HOT.size >= 200) HOT.delete(HOT.keys().next().value);
  HOT.set(key, { data, ts: Date.now() });
}

// ── Helpers ──
function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return (isNaN(n) || !isFinite(n)) ? null : n;
}
function clean(t) {
  return String(t || '').trim().toUpperCase().replace('.IS','').replace('BIST:','');
}

// ════════════════════════════════════════════════════
// VERİ KAYNAKLARI
// ════════════════════════════════════════════════════

// ── Twelve Data (NYSE/NASDAQ) ──
async function fetchTwelveData(ticker) {
  if (!TD_KEY) throw new Error('Twelve Data API key not configured');

  // statistics endpoint = tüm fundamentals tek istekte
  // Free tier: 800 req/gün, 8 req/dk
  const url = `https://api.twelvedata.com/statistics?symbol=${encodeURIComponent(ticker)}&apikey=${TD_KEY}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);
  const data = await r.json();

  if (data.code && data.code !== 200) {
    throw new Error(`Twelve Data error: ${data.message || data.code}`);
  }

  const stats = data?.statistics || {};
  const valuation = stats?.valuations_metrics || {};
  const finHi = stats?.financials || {};
  const inc   = finHi?.income_statement || {};
  const bal   = finHi?.balance_sheet || {};
  const cf    = finHi?.cash_flow || {};

  // Güncel fiyat ayrı endpoint (statistics fiyat içermez)
  let price = null;
  try {
    const pr = await fetch(
      `https://api.twelvedata.com/price?symbol=${encodeURIComponent(ticker)}&apikey=${TD_KEY}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (pr.ok) price = num((await pr.json())?.price);
  } catch(e) { /* swallow */ }

  return {
    eps:           num(stats?.financials?.income_statement?.diluted_eps_ttm)
                || num(valuation?.trailing_eps),
    bookValuePS:   num(valuation?.book_value_per_share_mrq),
    growthRate:    num(stats?.financials?.income_statement?.quarterly_earnings_growth_yoy)
                || num(stats?.financials?.income_statement?.quarterly_revenue_growth),
    fcf:           num(cf?.free_cash_flow_ttm),
    sharesOut:     num(stats?.share_statistics?.shares_outstanding),
    marketCap:     num(valuation?.market_capitalization),
    currentPrice:  price,
    currency:      'USD',
    source:        'twelvedata',
  };
}

// ── Yahoo Finance (BIST + global yedek) ──
async function fetchYahooFundamentals(ticker, isBIST) {
  const symbol = isBIST ? `${ticker}.IS` : ticker;

  // v10 quoteSummary modülü — fundamentals + key stats
  const modules = [
    'defaultKeyStatistics',
    'financialData',
    'summaryDetail',
    'price',
    'incomeStatementHistory',
    'cashflowStatementHistory',
  ].join(',');

  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
  const r = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  const json = await r.json();
  const result = json?.quoteSummary?.result?.[0];
  if (!result) throw new Error('Yahoo: empty response');

  const ks   = result.defaultKeyStatistics || {};
  const fd   = result.financialData || {};
  const sd   = result.summaryDetail || {};
  const pr   = result.price || {};
  const cf   = result.cashflowStatementHistory?.cashflowStatements?.[0] || {};

  const eps         = num(ks.trailingEps?.raw);
  const bookValue   = num(ks.bookValue?.raw);
  const growthQ     = num(fd.earningsGrowth?.raw);   // 0.15 = %15
  const growthRev   = num(fd.revenueGrowth?.raw);
  const growthRate  = (growthQ != null ? growthQ : growthRev);
  const fcf         = num(fd.freeCashflow?.raw);
  const opCF        = num(cf.totalCashFromOperatingActivities?.raw);
  const capex       = num(cf.capitalExpenditures?.raw);
  const sharesOut   = num(ks.sharesOutstanding?.raw);
  const marketCap   = num(sd.marketCap?.raw) || num(pr.marketCap?.raw);
  const currentPrice= num(fd.currentPrice?.raw) || num(pr.regularMarketPrice?.raw);
  const currency    = pr.currency || (isBIST ? 'TRY' : 'USD');

  // FCF yoksa OCF - |Capex| ile hesapla
  let computedFcf = fcf;
  if (computedFcf == null && opCF != null && capex != null) {
    computedFcf = opCF + capex;  // capex zaten negatif gelir
  }

  return {
    eps,
    bookValuePS:   bookValue,
    growthRate:    growthRate,        // decimal: 0.15 = %15
    fcf:           computedFcf,
    sharesOut,
    marketCap,
    currentPrice,
    currency,
    source:        'yahoo',
  };
}

// ════════════════════════════════════════════════════
// DEĞERLEME FORMÜLLERİ
// ════════════════════════════════════════════════════

// 1) GRAHAM NUMBER
//    √(22.5 × EPS × BookValuePerShare)
//    Negatif EPS veya book value varsa N/A
function grahamNumber(d, warnings) {
  if (d.eps == null || d.bookValuePS == null) {
    warnings.push('Graham: EPS veya defter değeri yok');
    return null;
  }
  if (d.eps <= 0) {
    warnings.push('Graham: EPS negatif (zararda şirket)');
    return null;
  }
  if (d.bookValuePS <= 0) {
    warnings.push('Graham: defter değeri negatif');
    return null;
  }
  const v = Math.sqrt(22.5 * d.eps * d.bookValuePS);
  return Math.round(v * 100) / 100;
}

// 2) LYNCH PEG=1 FAIR VALUE
//    EPS × growthRate(%) — Lynch'e göre F/K = büyüme oranı ise hisse adil
//    Örn: EPS=$5, büyüme=%15 → adil PE 15 → adil fiyat = 5 × 15 = $75
function lynchFairValue(d, warnings) {
  if (d.eps == null) {
    warnings.push('Lynch: EPS yok');
    return null;
  }
  if (d.eps <= 0) {
    warnings.push('Lynch: EPS negatif');
    return null;
  }
  if (d.growthRate == null) {
    warnings.push('Lynch: büyüme oranı yok');
    return null;
  }
  // Yahoo growth decimal (0.15), %'ye çevir
  const growthPct = d.growthRate * 100;
  if (growthPct <= 0) {
    warnings.push('Lynch: negatif büyüme (PEG anlamsız)');
    return null;
  }
  // Aşırı yüksek büyümeyi cap'le (Lynch 25% üstü için PEG güvenilmez der)
  const capped = Math.min(growthPct, 25);
  if (growthPct > 25) {
    warnings.push(`Lynch: büyüme %${growthPct.toFixed(0)} → %25'le sınırlandı`);
  }
  const v = d.eps * capped;
  return Math.round(v * 100) / 100;
}

// 3) SIMPLIFIED DCF
//    10 yıllık FCF projeksiyonu + terminal value
//    DiscountRate = 10%, PerpetualGrowth = 2.5%
//    Result: per share intrinsic value
function simplifiedDCF(d, warnings) {
  if (d.fcf == null || d.fcf <= 0) {
    warnings.push('DCF: pozitif FCF yok');
    return null;
  }
  if (d.sharesOut == null || d.sharesOut <= 0) {
    warnings.push('DCF: hisse sayısı yok');
    return null;
  }

  // Büyüme: 1-5 yıl şirket büyümesi (cap %15), 6-10 yıl yarısı, sonra %2.5 sonsuz
  const rawGrowth = (d.growthRate != null ? d.growthRate : 0.05);
  const g1 = Math.min(Math.max(rawGrowth, 0.02), 0.15);  // 1-5 yıl: 2-15% arası
  const g2 = g1 / 2;                                       // 6-10 yıl: yarısı
  const gT = 0.025;                                        // sonsuza: %2.5
  const r  = 0.10;                                         // discount %10

  let fcf = d.fcf;
  let pv  = 0;

  // Yıl 1-5
  for (let y = 1; y <= 5; y++) {
    fcf *= (1 + g1);
    pv  += fcf / Math.pow(1 + r, y);
  }
  // Yıl 6-10
  for (let y = 6; y <= 10; y++) {
    fcf *= (1 + g2);
    pv  += fcf / Math.pow(1 + r, y);
  }
  // Terminal value (Gordon growth)
  const terminalFcf = fcf * (1 + gT);
  const terminalVal = terminalFcf / (r - gT);
  pv += terminalVal / Math.pow(1 + r, 10);

  // Per share
  const perShare = pv / d.sharesOut;
  if (!isFinite(perShare) || perShare <= 0) {
    warnings.push('DCF: anlamsız sonuç');
    return null;
  }

  // Cap'le — saçma rakamlar üretmesin (10x current price'dan büyükse şüpheli)
  if (d.currentPrice && perShare > d.currentPrice * 20) {
    warnings.push('DCF: aşırı yüksek sonuç, şüpheli (cap\'lendi)');
    return Math.round(d.currentPrice * 20 * 100) / 100;
  }

  return Math.round(perShare * 100) / 100;
}

// ════════════════════════════════════════════════════
// CACHE LAYER (Supabase)
// ════════════════════════════════════════════════════

async function readDbCache(ticker, exchange) {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const url = `${SB_URL}/rest/v1/fair_value_cache?ticker=eq.${ticker}&exchange=eq.${exchange}&select=*`;
    const r = await fetch(url, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const rows = await r.json();
    const row = rows?.[0];
    if (!row) return null;

    // TTL kontrolü
    const age = Date.now() - new Date(row.computed_at).getTime();
    if (age > CACHE_TTL_MS) return null;

    return row;
  } catch (e) {
    console.log('[fv] cache read err:', e.message);
    return null;
  }
}

async function writeDbCache(ticker, exchange, payload) {
  if (!SB_URL || !SB_KEY) return;
  try {
    // UPSERT (Prefer: resolution=merge-duplicates)
    await fetch(`${SB_URL}/rest/v1/fair_value_cache?on_conflict=ticker,exchange`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        ticker, exchange,
        graham_value:  payload.graham_value,
        lynch_value:   payload.lynch_value,
        dcf_value:     payload.dcf_value,
        current_price: payload.current_price,
        currency:      payload.currency,
        inputs:        payload.inputs,
        warnings:      payload.warnings,
        sources:       payload.sources,
        computed_at:   new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.log('[fv] cache write err:', e.message);
  }
}

async function bumpHitCount(ticker, exchange) {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}/rest/v1/rpc/increment_fv_hit`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_ticker: ticker, p_exchange: exchange }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) { /* swallow */ }
}

// ════════════════════════════════════════════════════
// CORE: Fair value hesapla
// ════════════════════════════════════════════════════

async function computeFairValue(ticker, exchange) {
  const isBIST = exchange === 'BIST';

  // Veri çek
  let raw;
  try {
    if (isBIST) {
      raw = await fetchYahooFundamentals(ticker, true);
    } else {
      // NYSE/NASDAQ: Twelve Data tercih, yedek olarak Yahoo
      try {
        raw = await fetchTwelveData(ticker);
        // Twelve Data null'lar varsa Yahoo ile patch
        if (raw.eps == null || raw.bookValuePS == null) {
          const yh = await fetchYahooFundamentals(ticker, false);
          raw = {
            ...raw,
            eps:          raw.eps ?? yh.eps,
            bookValuePS:  raw.bookValuePS ?? yh.bookValuePS,
            growthRate:   raw.growthRate ?? yh.growthRate,
            fcf:          raw.fcf ?? yh.fcf,
            sharesOut:    raw.sharesOut ?? yh.sharesOut,
            currentPrice: raw.currentPrice ?? yh.currentPrice,
            source:       'twelvedata+yahoo',
          };
        }
      } catch (tdErr) {
        console.log('[fv] Twelve Data failed, falling back to Yahoo:', tdErr.message);
        raw = await fetchYahooFundamentals(ticker, false);
      }
    }
  } catch (e) {
    throw new Error(`Veri kaynağına ulaşılamadı: ${e.message}`);
  }

  // Hesapla
  const warnings = [];
  const graham_value = grahamNumber(raw, warnings);
  const lynch_value  = lynchFairValue(raw, warnings);
  const dcf_value    = simplifiedDCF(raw, warnings);

  return {
    graham_value,
    lynch_value,
    dcf_value,
    current_price: raw.currentPrice,
    currency:      raw.currency,
    inputs: {
      eps:         raw.eps,
      bookValuePS: raw.bookValuePS,
      growthRate:  raw.growthRate,
      fcf:         raw.fcf,
      sharesOut:   raw.sharesOut,
      marketCap:   raw.marketCap,
    },
    warnings,
    sources: { primary: raw.source },
  };
}

// ════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ticker   = clean(req.query?.ticker || req.body?.ticker);
  const exchange = String(req.query?.exchange || req.body?.exchange || 'BIST').toUpperCase();
  const force    = req.query?.force === '1';

  if (!ticker) return res.status(400).json({ error: 'ticker zorunlu (örn: ?ticker=THYAO&exchange=BIST)' });
  if (!VALID_EXCHANGES.has(exchange)) {
    return res.status(400).json({ error: `geçersiz exchange. izinli: ${[...VALID_EXCHANGES].join(', ')}` });
  }

  const cacheKey = `${ticker}:${exchange}`;

  // 1) Hot cache (in-memory, 5dk)
  if (!force) {
    const hot = hotGet(cacheKey);
    if (hot) {
      res.setHeader('X-FV-Cache', 'hot');
      return res.status(200).json(hot);
    }
  }

  // 2) DB cache (Supabase, 24h)
  if (!force) {
    const db = await readDbCache(ticker, exchange);
    if (db) {
      const payload = {
        ticker, exchange,
        graham_value:  num(db.graham_value),
        lynch_value:   num(db.lynch_value),
        dcf_value:     num(db.dcf_value),
        current_price: num(db.current_price),
        currency:      db.currency,
        inputs:        db.inputs,
        warnings:      db.warnings || [],
        sources:       db.sources || {},
        computed_at:   db.computed_at,
        cached:        true,
      };
      hotSet(cacheKey, payload);
      bumpHitCount(ticker, exchange);   // fire-and-forget
      res.setHeader('X-FV-Cache', 'db');
      return res.status(200).json(payload);
    }
  }

  // 3) Hesapla — yeni veri
  try {
    const result = await computeFairValue(ticker, exchange);
    const payload = {
      ticker, exchange,
      ...result,
      computed_at: new Date().toISOString(),
      cached:      false,
    };

    // DB'ye yaz (fire-and-forget)
    writeDbCache(ticker, exchange, payload);
    hotSet(cacheKey, payload);

    res.setHeader('X-FV-Cache', 'miss');
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[fair-value]', ticker, exchange, e.message);
    return res.status(500).json({
      error:   'Hesaplama başarısız',
      detail:  e.message,
      ticker, exchange,
    });
  }
}
