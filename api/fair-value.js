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
// SADECE statistics + price endpoint'leri (free tier'da garanti çalışan)
// 2 paralel istek = 2 credit/hisse. 8 req/dk limit'le 4 hisse/dk güvenli.
async function fetchTwelveData(ticker, debugCollector) {
  if (!TD_KEY) throw new Error('Twelve Data API key not configured');

  const base = 'https://api.twelvedata.com';
  const opts = { signal: AbortSignal.timeout(TIMEOUT_MS) };
  const k    = `&apikey=${TD_KEY}`;

  // 2 paralel istek (toplam 2 credit) — minimum yük
  const [statsRes, priceRes] = await Promise.allSettled([
    fetch(`${base}/statistics?symbol=${encodeURIComponent(ticker)}${k}`, opts),
    fetch(`${base}/price?symbol=${encodeURIComponent(ticker)}${k}`, opts),
  ]);

  const td_debug = { endpoints: {} };

  async function safeJson(settled, label) {
    if (settled.status !== 'fulfilled') {
      const err = settled.reason?.message || 'rejected';
      td_debug.endpoints[label] = { ok: false, reason: 'fetch_rejected', error: err };
      return null;
    }
    const status = settled.value.status;
    let bodyText = '';
    try { bodyText = await settled.value.text(); } catch {}

    if (!settled.value.ok) {
      td_debug.endpoints[label] = { ok: false, http: status, body_preview: bodyText.slice(0, 200) };
      return null;
    }
    try {
      const j = JSON.parse(bodyText);
      if (j?.code && j.code !== 200) {
        td_debug.endpoints[label] = { ok: false, http: status, api_code: j.code, message: j.message };
        return null;
      }
      td_debug.endpoints[label] = { ok: true, http: status };
      return j;
    } catch (e) {
      td_debug.endpoints[label] = { ok: false, parse_error: e.message, body_preview: bodyText.slice(0, 200) };
      return null;
    }
  }

  const [stats, priceData] = await Promise.all([
    safeJson(statsRes, 'statistics'),
    safeJson(priceRes, 'price'),
  ]);

  if (debugCollector) debugCollector.twelve_data = td_debug;

  if (!stats) {
    const reasons = Object.entries(td_debug.endpoints)
      .filter(([_, v]) => !v.ok)
      .map(([k, v]) => `${k}: ${v.message || v.body_preview || `HTTP ${v.http}` || v.error || 'unknown'}`)
      .join(' | ');
    throw new Error(`Twelve Data başarısız: ${reasons}`);
  }

  // ── statistics'ten temel veriler ──
  const s         = stats?.statistics || {};
  const valMet    = s.valuations_metrics || {};
  const finStat   = s.financials || {};
  const incStat   = finStat.income_statement || {};
  const shareStat = s.share_statistics || {};

  const eps = num(incStat.diluted_eps_ttm) || num(valMet.trailing_eps);

  // Büyüme: önce earnings yoy, yoksa revenue yoy
  let growthRate = num(incStat.quarterly_earnings_growth_yoy);
  if (growthRate == null) growthRate = num(incStat.quarterly_revenue_growth);

  const marketCap   = num(valMet.market_capitalization);
  const peRatio     = num(valMet.trailing_pe);
  const pbRatio     = num(valMet.price_to_book_mrq);
  const currentPrice = num(priceData?.price);

  // Shares outstanding — birden fazla yerden dene
  let sharesOut = num(shareStat.shares_outstanding)
              || num(shareStat.outstanding_shares)
              || num(s.shares_outstanding);

  // Market cap ve fiyat varsa, sharesOut'u güvenle türet
  if (sharesOut == null && marketCap != null && currentPrice != null && currentPrice > 0) {
    sharesOut = marketCap / currentPrice;
  }

  return {
    eps,
    bookValuePS: null,    // free tier'da yok — Lite formüller kullanılacak
    growthRate,
    fcf: null,            // free tier'da yok
    sharesOut,
    marketCap,
    peRatio,              // YENİ: PE ratio (Buffett-Lite için)
    pbRatio,              // YENİ: P/B (sektör karşılaştırma için)
    currentPrice,
    currency:    'USD',
    source:      'twelvedata-statistics',
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
// DEĞERLEME FORMÜLLERİ — "Lite" varyantlar
// Twelve Data free tier sınırlamaları nedeniyle:
// - Tam Graham Number (√22.5×EPS×BV) yapılamaz → Graham Defensive PE
// - Tam DCF (FCF projeksiyonu) yapılamaz → Buffett Earnings Multiple
// - Lynch PEG formülü olduğu gibi çalışıyor (sadece EPS+growth ister)
// ════════════════════════════════════════════════════

// 1) LYNCH PEG=1 FAIR VALUE
//    EPS × growthRate(%) — Lynch'e göre F/K = büyüme oranı ise hisse adil
//    Örn: EPS=$8.26, büyüme=%19.4 → adil PE 19.4 → adil fiyat = 8.26 × 19.4 = $160
function lynchFairValue(d, warnings) {
  if (d.eps == null || d.eps <= 0) {
    warnings.push('Lynch: pozitif EPS yok');
    return null;
  }
  if (d.growthRate == null) {
    warnings.push('Lynch: büyüme oranı yok');
    return null;
  }
  const growthPct = d.growthRate * 100;
  if (growthPct <= 0) {
    warnings.push('Lynch: negatif büyüme (PEG anlamsız)');
    return null;
  }
  // Lynch >25% büyüme için PEG güvenilmez der
  const capped = Math.min(growthPct, 25);
  if (growthPct > 25) {
    warnings.push(`Lynch: büyüme %${growthPct.toFixed(0)} → %25'le sınırlandı (Lynch metodolojisi)`);
  }
  return Math.round(d.eps * capped * 100) / 100;
}

// 2) GRAHAM DEFENSIVE PE
//    Benjamin Graham, "Akıllı Yatırımcı" (1949) kitabında defansif yatırımcılar için
//    maksimum PE 15 önerir. Yani adil değer = EPS × 15.
//    Bu, klasik Graham Number (√22.5×EPS×BV) için BV gerekli olduğu için kullanılan
//    onaylı bir basitleştirilmiş varyanttır.
function grahamDefensivePE(d, warnings) {
  if (d.eps == null || d.eps <= 0) {
    warnings.push('Graham: pozitif EPS yok');
    return null;
  }
  // Eğer P/B oranı çok yüksekse ek uyarı (Graham P/B<1.5 ister)
  if (d.pbRatio != null && d.pbRatio > 2.5) {
    warnings.push(`Graham: P/B ${d.pbRatio.toFixed(1)} (>2.5, klasik Graham eşiği aşılmış)`);
  }
  return Math.round(d.eps * 15 * 100) / 100;
}

// 3) BUFFETT EARNINGS MULTIPLE
//    Buffett'in mektuplarında ve yatırımlarında tipik kullandığı multiple 10-12x earnings.
//    Quality şirketler için 12x, "good business at fair price" prensibine uyar.
//    ROE yüksekse (>15%) "kalite şirket" sayılır → 12x kullan.
//    ROE yoksa veya düşükse → 10x (daha muhafazakar).
function buffettEarningsMultiple(d, warnings) {
  if (d.eps == null || d.eps <= 0) {
    warnings.push('Buffett: pozitif EPS yok');
    return null;
  }
  // ROE'yi statistics'ten al (varsa)
  // Burada d.roe alınmıyor şimdilik — d.eps × 12 sabitle güvenli başlayalım
  const multiple = 12;
  return Math.round(d.eps * multiple * 100) / 100;
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
      // NYSE/NASDAQ: SADECE Twelve Data (Yahoo Vercel IP'lerinden 401 verir)
      try {
        raw = await fetchTwelveData(ticker, dbg);
        if (dbg) dbg.attempts.push({ source: 'twelvedata', ok: true });
      } catch (e) {
        if (dbg) dbg.attempts.push({ source: 'twelvedata', ok: false, error: e.message });

        // Twelve Data rate limit hatasıysa anlamlı mesaj
        const isRateLimit = /run out of API credits|rate limit|too many requests/i.test(e.message);
        if (isRateLimit) {
          throw new Error('Geçici rate limit — birkaç saniye sonra tekrar deneyin');
        }
        throw new Error(`Twelve Data: ${e.message}`);
      }
    }
  } catch (e) {
    const err = new Error(`Veri kaynağına ulaşılamadı: ${e.message}`);
    if (dbg) err._debug = dbg;
    throw err;
  }

  // Hesapla
  const warnings = [];
  const graham_value = grahamDefensivePE(raw, warnings);    // EPS × 15
  const lynch_value  = lynchFairValue(raw, warnings);       // EPS × growth%
  const dcf_value    = buffettEarningsMultiple(raw, warnings); // EPS × 12

  const result = {
    graham_value,
    lynch_value,
    dcf_value,         // alan adı backward-compatible kalsın diye dcf_value
    current_price: raw.currentPrice,
    currency:      raw.currency,
    inputs: {
      eps:         raw.eps,
      bookValuePS: raw.bookValuePS,
      growthRate:  raw.growthRate,
      fcf:         raw.fcf,
      sharesOut:   raw.sharesOut,
      marketCap:   raw.marketCap,
      peRatio:     raw.peRatio,
      pbRatio:     raw.pbRatio,
    },
    warnings,
    sources: { primary: raw.source },
    method: {
      graham_value: 'Graham Defensive PE (EPS × 15)',
      lynch_value:  'Lynch PEG=1 (EPS × büyüme%)',
      dcf_value:    'Buffett Earnings Multiple (EPS × 12)',
    },
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
