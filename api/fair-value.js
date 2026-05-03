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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── Yahoo Crumb + Cookie cache (55 dakika TTL) ──
// Yahoo 2024'ten beri cookie + crumb token zorunlu kıldı.
// fc.yahoo.com'dan cookie al → /v1/test/getcrumb ile crumb token al.
let _crumb = null, _cookie = null, _crumbTs = 0;
const CRUMB_TTL = 55 * 60 * 1000;

async function getYahooCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookieVal = setCookie.split(';')[0] || '';
    if (!cookieVal) return { crumb: null, cookie: null };

    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent':      UA,
        'Cookie':          cookieVal,
        'Accept':          'text/plain',
        'Referer':         'https://finance.yahoo.com/',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (r2.ok) {
      const txt = await r2.text();
      if (txt && txt.length > 0) {
        _crumb   = txt.trim();
        _cookie  = cookieVal;
        _crumbTs = Date.now();
      }
    }
  } catch (e) {
    console.log('[fv] Crumb failed:', e.message);
  }
  return { crumb: _crumb, cookie: _cookie };
}

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
// 4 paralel endpoint çağrısı: statistics + balance_sheet + cash_flow + price
// Free tier: 800 req/gün, 8 req/dk → 4 req/hisse → 2 hisse/dk güvenli
async function fetchTwelveData(ticker) {
  if (!TD_KEY) throw new Error('Twelve Data API key not configured');

  const base = 'https://api.twelvedata.com';
  const opts = { signal: AbortSignal.timeout(TIMEOUT_MS) };
  const k    = `&apikey=${TD_KEY}`;

  // Paralel çağırma — 4 endpoint birden
  const [statsRes, bsRes, cfRes, priceRes] = await Promise.allSettled([
    fetch(`${base}/statistics?symbol=${encodeURIComponent(ticker)}${k}`, opts),
    fetch(`${base}/balance_sheet?symbol=${encodeURIComponent(ticker)}&period=annual&start_date=2022-01-01${k}`, opts),
    fetch(`${base}/cash_flow?symbol=${encodeURIComponent(ticker)}&period=annual&start_date=2022-01-01${k}`, opts),
    fetch(`${base}/price?symbol=${encodeURIComponent(ticker)}${k}`, opts),
  ]);

  // Helper: response → JSON, hata varsa null
  async function safeJson(settled, label) {
    if (settled.status !== 'fulfilled') {
      console.log(`[fv-td] ${label} failed:`, settled.reason?.message);
      return null;
    }
    if (!settled.value.ok) {
      console.log(`[fv-td] ${label} HTTP ${settled.value.status}`);
      return null;
    }
    try {
      const j = await settled.value.json();
      // Twelve Data hata kalıbı: { code: 400, message: "..." }
      if (j?.code && j.code !== 200) {
        console.log(`[fv-td] ${label} error:`, j.message);
        return null;
      }
      return j;
    } catch (e) {
      return null;
    }
  }

  const [stats, balance, cashflow, priceData] = await Promise.all([
    safeJson(statsRes, 'statistics'),
    safeJson(bsRes,    'balance_sheet'),
    safeJson(cfRes,    'cash_flow'),
    safeJson(priceRes, 'price'),
  ]);

  if (!stats && !balance && !cashflow) {
    throw new Error('Twelve Data: tüm endpointler başarısız');
  }

  // ── statistics'ten temel veriler ──
  const s        = stats?.statistics || {};
  const valMet   = s.valuations_metrics || {};
  const finStat  = s.financials || {};
  const incStat  = finStat.income_statement || {};
  const shareStat= s.share_statistics || {};
  const stockPx  = s.stock_price_summary || {};

  const eps = num(incStat.diluted_eps_ttm) || num(valMet.trailing_eps);

  // Büyüme: önce earnings yoy, yoksa revenue yoy
  let growthRate = num(incStat.quarterly_earnings_growth_yoy);
  if (growthRate == null) growthRate = num(incStat.quarterly_revenue_growth);

  // Market cap
  const marketCap = num(valMet.market_capitalization);

  // ── balance_sheet'ten book value per share ──
  // Yapı: { balance_sheet: [ { fiscal_date, equity: { common_stock_equity, ... }, ... }, ... ] }
  let bookValuePS = num(valMet.book_value_per_share_mrq);  // önce statistics'ten dene

  let totalEquity = null;
  if (balance?.balance_sheet?.length > 0) {
    const latest = balance.balance_sheet[0];
    totalEquity = num(latest?.equity?.common_stock_equity)
              || num(latest?.equity?.total_stockholders_equity)
              || num(latest?.equity?.shareholders_equity);
  }

  // Shares outstanding — 3 farklı yerden dene
  let sharesOut = num(shareStat.shares_outstanding)
              || num(shareStat.outstanding_shares)
              || num(s.shares_outstanding);

  // Eğer book value per share yok ama equity ve shares varsa hesapla
  if (bookValuePS == null && totalEquity != null && sharesOut != null && sharesOut > 0) {
    bookValuePS = totalEquity / sharesOut;
  }

  // Eğer shares yok ama market cap ve price varsa türet
  let priceFromEndpoint = num(priceData?.price);

  // ── cash_flow'dan FCF ──
  // Yapı: { cash_flow: [ { fiscal_date, free_cash_flow, operating_activities: {...}, investing_activities: {...} } ] }
  let fcf = null;
  if (cashflow?.cash_flow?.length > 0) {
    const latest = cashflow.cash_flow[0];
    fcf = num(latest.free_cash_flow);

    // Yoksa OCF + Capex (capex genelde negatif olarak gelir)
    if (fcf == null) {
      const ocf = num(latest.operating_activities?.operating_cash_flow)
              ||  num(latest.operating_activities?.cash_flow_from_operating_activities);
      const capex = num(latest.investing_activities?.capital_expenditures);
      if (ocf != null && capex != null) {
        fcf = ocf + capex;  // capex negatif, toplam doğru çıkar
      }
    }
  }

  // sharesOut hâlâ yoksa marketCap/price ile türet
  if (sharesOut == null && marketCap != null && priceFromEndpoint != null && priceFromEndpoint > 0) {
    sharesOut = marketCap / priceFromEndpoint;
  }

  return {
    eps,
    bookValuePS,
    growthRate,
    fcf,
    sharesOut,
    marketCap,
    currentPrice: priceFromEndpoint,
    currency:     'USD',
    source:       'twelvedata',
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

  // Yahoo Vercel/datacenter IP'leri 2024'ten beri agresif filtreliyor.
  // Tam tarayıcı header set'i + her iki host'u dene (query1/query2).
  const HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer':         'https://finance.yahoo.com/',
    'Origin':          'https://finance.yahoo.com',
    'Cache-Control':   'no-cache',
    'Pragma':          'no-cache',
    'Sec-Fetch-Dest':  'empty',
    'Sec-Fetch-Mode':  'cors',
    'Sec-Fetch-Site':  'same-site',
  };

  // İki host dene — biri 401 verirse diğerini test et
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr = null;
  for (const host of hosts) {
    try {
      const url = `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
      const r = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: HEADERS,
      });
      if (!r.ok) {
        lastErr = new Error(`Yahoo ${host} HTTP ${r.status}`);
        continue;
      }
      const json = await r.json();
      const result = json?.quoteSummary?.result?.[0];
      if (!result) {
        lastErr = new Error(`Yahoo ${host}: empty response`);
        continue;
      }

      // Başarılı — parse et
      return parseYahooResult(result, isBIST);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Yahoo: all hosts failed');
}

function parseYahooResult(result, isBIST) {
  const ks   = result.defaultKeyStatistics || {};
  const fd   = result.financialData || {};
  const sd   = result.summaryDetail || {};
  const pr   = result.price || {};
  const cf   = result.cashflowStatementHistory?.cashflowStatements?.[0] || {};

  const eps         = num(ks.trailingEps?.raw);
  const bookValue   = num(ks.bookValue?.raw);
  const growthQ     = num(fd.earningsGrowth?.raw);
  const growthRev   = num(fd.revenueGrowth?.raw);
  const growthRate  = (growthQ != null ? growthQ : growthRev);
  const fcf         = num(fd.freeCashflow?.raw);
  const opCF        = num(cf.totalCashFromOperatingActivities?.raw);
  const capex       = num(cf.capitalExpenditures?.raw);
  const sharesOut   = num(ks.sharesOutstanding?.raw);
  const marketCap   = num(sd.marketCap?.raw) || num(pr.marketCap?.raw);
  const currentPrice= num(fd.currentPrice?.raw) || num(pr.regularMarketPrice?.raw);
  const currency    = pr.currency || (isBIST ? 'TRY' : 'USD');

  let computedFcf = fcf;
  if (computedFcf == null && opCF != null && capex != null) {
    computedFcf = opCF + capex;
  }

  return {
    eps,
    bookValuePS:   bookValue,
    growthRate,
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

async function computeFairValue(ticker, exchange, debug) {
  const isBIST = exchange === 'BIST';
  const dbg = debug ? { attempts: [] } : null;

  // Veri çek
  let raw;
  try {
    if (isBIST) {
      try {
        raw = await fetchYahooFundamentals(ticker, true);
        if (dbg) dbg.attempts.push({ source: 'yahoo', ok: true });
      } catch (yhErr) {
        if (dbg) dbg.attempts.push({ source: 'yahoo', ok: false, error: yhErr.message });
        throw yhErr;
      }
    } else {
      // NYSE/NASDAQ: Twelve Data tercih, yedek olarak Yahoo
      let tdErr = null;
      try {
        raw = await fetchTwelveData(ticker);
        if (dbg) dbg.attempts.push({ source: 'twelvedata', ok: true });

        // Twelve Data null'lar varsa Yahoo ile patch
        if (raw.eps == null || raw.bookValuePS == null) {
          try {
            const yh = await fetchYahooFundamentals(ticker, false);
            if (dbg) dbg.attempts.push({ source: 'yahoo-patch', ok: true });
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
          } catch (patchErr) {
            if (dbg) dbg.attempts.push({ source: 'yahoo-patch', ok: false, error: patchErr.message });
            // Patch fail olabilir, twelve data verisiyle devam
          }
        }
      } catch (e) {
        tdErr = e;
        if (dbg) dbg.attempts.push({ source: 'twelvedata', ok: false, error: e.message });
        console.log('[fv] Twelve Data failed, falling back to Yahoo:', e.message);
        try {
          raw = await fetchYahooFundamentals(ticker, false);
          if (dbg) dbg.attempts.push({ source: 'yahoo-fallback', ok: true });
        } catch (yhErr) {
          if (dbg) dbg.attempts.push({ source: 'yahoo-fallback', ok: false, error: yhErr.message });
          // Her iki kaynak da düştü — gerçek hatayı gönder
          throw new Error(
            `Twelve Data: ${tdErr.message} | Yahoo: ${yhErr.message}`
          );
        }
      }
    }
  } catch (e) {
    const err = new Error(`Veri kaynağına ulaşılamadı: ${e.message}`);
    if (dbg) err._debug = dbg;
    throw err;
  }

  // Hesapla
  const warnings = [];
  const graham_value = grahamNumber(raw, warnings);
  const lynch_value  = lynchFairValue(raw, warnings);
  const dcf_value    = simplifiedDCF(raw, warnings);

  const result = {
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

  if (dbg) result._debug = dbg;
  return result;
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
  const debug    = req.query?.debug === '1';

  if (!ticker) return res.status(400).json({ error: 'ticker zorunlu (örn: ?ticker=THYAO&exchange=BIST)' });
  if (!VALID_EXCHANGES.has(exchange)) {
    return res.status(400).json({ error: `geçersiz exchange. izinli: ${[...VALID_EXCHANGES].join(', ')}` });
  }

  const cacheKey = `${ticker}:${exchange}`;

  // Debug mode'da cache'i bypass et — her şeyi taze çek
  const skipCache = force || debug;

  // 1) Hot cache (in-memory, 5dk)
  if (!skipCache) {
    const hot = hotGet(cacheKey);
    if (hot) {
      res.setHeader('X-FV-Cache', 'hot');
      return res.status(200).json(hot);
    }
  }

  // 2) DB cache (Supabase, 24h)
  if (!skipCache) {
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
    const result = await computeFairValue(ticker, exchange, debug);
    const payload = {
      ticker, exchange,
      ...result,
      computed_at: new Date().toISOString(),
      cached:      false,
    };

    // DB'ye yaz (fire-and-forget) — debug mode'da yazma
    if (!debug) {
      writeDbCache(ticker, exchange, payload);
      hotSet(cacheKey, payload);
    }

    res.setHeader('X-FV-Cache', 'miss');
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[fair-value]', ticker, exchange, e.message);
    const errPayload = {
      error:   'Hesaplama başarısız',
      detail:  e.message,
      ticker, exchange,
    };
    if (debug && e._debug) errPayload._debug = e._debug;
    if (debug) {
      errPayload._env = {
        SUPABASE_URL_set:        !!SB_URL,
        SUPABASE_SERVICE_KEY_set:!!SB_KEY,
        TWELVE_DATA_API_KEY_set: !!TD_KEY,
      };
    }
    return res.status(500).json(errPayload);
  }
}
