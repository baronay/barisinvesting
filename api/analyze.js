// /api/analyze.js — Barış Investing
// FIX v2: Yahoo crumb-free endpoints + doğrudan TV entegrasyonu
// Yahoo v7/v10 artık crumb olmadan çalışmıyor → v8 chart + query2 alternatifleri

// ── ÖNBELLEK ────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

function getCached(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(key); return null; }
  return e.data;
}
function setCache(key, data) {
  if (cache.size >= 300) cache.delete(cache.keys().next().value);
  cache.set(key, { data, ts: Date.now() });
}

// ── SABITLER ────────────────────────────────────────────────────
const APPROX_USD_TRY = 38;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// ── YAHOO CRUMB (opsiyonel — başarısız olursa crumbsuz devam) ──
let _crumb = null, _cookie = null, _crumbTs = 0;
const CRUMB_TTL = 50 * 60 * 1000;

async function tryGetCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) {
    return { crumb: _crumb, cookie: _cookie };
  }

  // Yöntem 1: fc.yahoo.com (klasik ama Vercel'de sık başarısız)
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookieVal = setCookie.split(';')[0] || '';
    if (cookieVal) {
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { ...BASE_HEADERS, 'Cookie': cookieVal, 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(5000),
      });
      if (r2.ok) {
        const txt = await r2.text();
        if (txt && txt.length > 0 && !txt.includes('{')) {
          _crumb = txt.trim(); _cookie = cookieVal; _crumbTs = Date.now();
          console.log('[Crumb] fc.yahoo.com OK:', _crumb.slice(0,8) + '...');
          return { crumb: _crumb, cookie: _cookie };
        }
      }
    }
  } catch (e) { console.log('[Crumb] fc.yahoo.com başarısız:', e.message); }

  // Yöntem 2: consent.yahoo.com (EU/TR fallback)
  try {
    const r = await fetch('https://consent.yahoo.com/v2/collectConsent?sessionId=1_cc-session_dummy', {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(5000),
    });
    const cookie2 = r.headers.get('set-cookie')?.split(';')[0] || '';
    if (cookie2) {
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { ...BASE_HEADERS, 'Cookie': cookie2, 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(5000),
      });
      if (r2.ok) {
        const txt = await r2.text();
        if (txt && txt.length > 0 && !txt.includes('{')) {
          _crumb = txt.trim(); _cookie = cookie2; _crumbTs = Date.now();
          console.log('[Crumb] consent.yahoo OK:', _crumb.slice(0,8) + '...');
          return { crumb: _crumb, cookie: _cookie };
        }
      }
    }
  } catch (e) { console.log('[Crumb] consent.yahoo başarısız:', e.message); }

  console.log('[Crumb] Tüm yöntemler başarısız — crumbsuz devam');
  return { crumb: null, cookie: null };
}

// ── BİRİM TESPİT MOTORU ─────────────────────────────────────────
function detectAndNormalize(val, mktCap, minRatio, maxRatio, label) {
  if (val == null || mktCap == null || mktCap <= 0) return val;
  const ratio = Math.abs(val) / mktCap;
  console.log(`[Birim] ${label}: val=${val.toExponential(2)} ratio=${ratio.toFixed(4)} (beklenen: ${minRatio}–${maxRatio})`);

  if (ratio >= minRatio && ratio <= maxRatio) return val;

  if (ratio < minRatio) {
    const asTRY = val * APPROX_USD_TRY;
    if (Math.abs(asTRY) / mktCap >= minRatio && Math.abs(asTRY) / mktCap <= maxRatio) {
      console.log(`[Birim] ${label}: USD→TRY ×${APPROX_USD_TRY}`); return asTRY;
    }
    const asK = val * 1000;
    if (Math.abs(asK) / mktCap >= minRatio && Math.abs(asK) / mktCap <= maxRatio) {
      console.log(`[Birim] ${label}: ×1000`); return asK;
    }
    const asKU = val * 1000 * APPROX_USD_TRY;
    if (Math.abs(asKU) / mktCap >= minRatio && Math.abs(asKU) / mktCap <= maxRatio) {
      console.log(`[Birim] ${label}: ×1000×USD`); return asKU;
    }
    return val;
  }

  if (ratio > maxRatio) {
    const div1k = val / 1000;
    if (Math.abs(div1k) / mktCap >= minRatio && Math.abs(div1k) / mktCap <= maxRatio) {
      console.log(`[Birim] ${label}: ÷1000`); return div1k;
    }
    const div1m = val / 1e6;
    if (Math.abs(div1m) / mktCap >= minRatio && Math.abs(div1m) / mktCap <= maxRatio) {
      console.log(`[Birim] ${label}: ÷1M`); return div1m;
    }
  }
  return val;
}

function normalizeBISTUnits(result) {
  if (!result.marketCap || !result.currentPrice) return result;
  const MC = result.marketCap;
  const B = { min: 0.001, max: 500 };
  const C = { min: 0.0001, max: 20 };
  result.totalAssets      = detectAndNormalize(result.totalAssets,      MC, B.min, B.max, 'Assets');
  result.totalLiabilities = detectAndNormalize(result.totalLiabilities, MC, B.min, B.max, 'Liabilities');
  if (result.computedEquity != null)
    result.computedEquity = detectAndNormalize(result.computedEquity, MC, B.min, B.max, 'StockholderEquity');
  result.freeCashflow      = detectAndNormalize(result.freeCashflow,      MC, C.min, C.max, 'FCF');
  result.operatingCashflow = detectAndNormalize(result.operatingCashflow, MC, C.min, C.max, 'OpCF');
  result.totalCash         = detectAndNormalize(result.totalCash,         MC, C.min, C.max, 'Cash');
  result.totalDebt         = detectAndNormalize(result.totalDebt,         MC, C.min, C.max, 'Debt');
  result.netIncome         = detectAndNormalize(result.netIncome,         MC, C.min, C.max, 'NetIncome');
  return result;
}

function computeFromRawData(result, isBIST = false) {
  let equity = null, equitySource = '';

  if (result.computedEquity != null && result.computedEquity > 0) {
    equity = result.computedEquity; equitySource = 'totalStockholderEquity';
  }
  if (!equity && result.totalAssets != null && result.totalLiabilities != null) {
    const calc = result.totalAssets - result.totalLiabilities;
    if (calc > 0) { equity = calc; result.computedEquity = equity; equitySource = 'assets-liabilities'; }
  }

  console.log(`[DEBUG PD/DD] marketCap=${result.marketCap?.toExponential(3)} equity=${equity?.toExponential(3)} src=${equitySource}`);
  if (!equity || equity <= 0 || !result.marketCap) return result;

  if (isBIST) {
    const pbCalc = result.marketCap / equity;
    if (pbCalc > 0.1 && pbCalc < 20) {
      result.pbRatio = parseFloat(pbCalc.toFixed(2));
      result.pbSource = `formül (${equitySource})`;
    } else if (pbCalc >= 20 && pbCalc < 1000) {
      const equityTRY = equity * APPROX_USD_TRY;
      const pbTRY = result.marketCap / equityTRY;
      if (pbTRY > 0.1 && pbTRY < 20) {
        result.pbRatio = parseFloat(pbTRY.toFixed(2));
        result.computedEquity = equityTRY;
        result.pbSource = `formül-kur (×${APPROX_USD_TRY})`;
      } else {
        const pb1k = result.marketCap / (equity * 1000);
        if (pb1k > 0.1 && pb1k < 20) {
          result.pbRatio = parseFloat(pb1k.toFixed(2));
          result.computedEquity = equity * 1000;
          result.pbSource = 'formül-1k';
        }
      }
    }
  } else {
    if (!result.pbRatio || result.pbRatio <= 0 || result.pbRatio > 30) {
      result.pbRatio = parseFloat((result.marketCap / equity).toFixed(2));
      result.pbSource = 'formül';
    }
  }

  if ((!result.roe || result.roe === 0) && result.netIncome != null) {
    const roeCalc = result.netIncome / equity;
    if (Math.abs(roeCalc) <= 3) { result.roe = parseFloat(roeCalc.toFixed(4)); result.roeSource = `formül (${equitySource})`; }
  }
  if (!result.debtToEquity && result.totalDebt && equity > 0) {
    result.debtToEquity = parseFloat(((result.totalDebt / equity) * 100).toFixed(1));
  }
  return result;
}

// ── TRADİNGVİEW DOĞRUDAN (bist-ratios API'ye bağımlılık yok) ───
const TV_COLS = [
  'close','price_earnings_ttm','price_book_ratio','market_cap_basic',
  'enterprise_value_ebitda_ttm','return_on_equity','debt_to_equity','earnings_per_share_basic_ttm'
];

async function fetchTradingView(ticker) {
  const sym = `BIST:${ticker.replace('.IS','').toUpperCase()}`;
  try {
    const res = await fetch('https://scanner.tradingview.com/turkey/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        symbols: { tickers: [sym], query: { types: [] } },
        columns: TV_COLS,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.log(`[TV] HTTP ${res.status}`); return null; }
    const json = await res.json();
    const row = json?.data?.[0]?.d;
    if (!row) return null;
    const safe = (v) => { const n = parseFloat(v); return (isNaN(n) || !isFinite(n)) ? null : n; };
    const fk = safe(row[1]);
    const eps = safe(row[7]);
    const fkFinal = fk ?? (safe(row[0]) && eps && eps > 0 ? parseFloat((safe(row[0]) / eps).toFixed(2)) : null);
    const result = {
      pe: fkFinal, pb: safe(row[2]), marketCap: safe(row[3]),
      evEbitda: safe(row[4]), roe: safe(row[5]) != null ? safe(row[5]) / 100 : null,
      debtToEquity: safe(row[6]), price: safe(row[0]),
    };
    console.log(`[TV] ${ticker}: PE=${result.pe} PB=${result.pb} ROE=${result.roe}`);
    return result;
  } catch (e) { console.log(`[TV] Hata: ${e.message}`); return null; }
}

// ── BIST SITE SCRAPING (Son Çare) ────────────────────────────────
async function scrapeBISTFallback(ticker) {
  const out = { peRatio: null, pbRatio: null, roe: null, source: null };
  try {
    const url = `https://www.isyatirim.com.tr/analiz-ve-bulten/hisse/${ticker}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'tr-TR,tr;q=0.9' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const html = await r.text();
      const fk  = html.match(/F\/K[^>]*>[\s]*([0-9]+[.,][0-9]+)/i);
      const fdd = html.match(/F\/DD[^>]*>[\s]*([0-9]+[.,][0-9]+)/i);
      const roe = html.match(/ROE[^>]*>[\s]*%?\s*([0-9]+[.,][0-9]+)/i);
      if (fk)  out.peRatio = parseFloat(fk[1].replace(',','.'));
      if (fdd) out.pbRatio = parseFloat(fdd[1].replace(',','.'));
      if (roe) out.roe     = parseFloat(roe[1].replace(',','.')) / 100;
      if (out.peRatio || out.pbRatio) { out.source = 'IsYatirim'; return out; }
    }
  } catch(e) { console.log('İş Yatırım scrape:', e.message); }
  try {
    const url = `https://bigpara.hurriyet.com.tr/hisse/${ticker.toLowerCase()}/hisse-senedi/`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'tr-TR,tr' },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const html = await r.text();
      const fk  = html.match(/(?:FD\/Kazanç|F\/K)[^<]*<[^>]+>([0-9]+[.,][0-9]+)/i);
      const fdd = html.match(/(?:FD\/Defter|F\/DD)[^<]*<[^>]+>([0-9]+[.,][0-9]+)/i);
      const roe = html.match(/ROE[^<]*<[^>]+>%?\s*([0-9]+[.,][0-9]+)/i);
      if (fk)  out.peRatio = parseFloat(fk[1].replace(',','.'));
      if (fdd) out.pbRatio = parseFloat(fdd[1].replace(',','.'));
      if (roe) out.roe     = parseFloat(roe[1].replace(',','.')) / 100;
      if (out.peRatio || out.pbRatio) { out.source = 'BigPara'; return out; }
    }
  } catch(e) { console.log('BigPara scrape:', e.message); }
  return out;
}

// ── ANA VERİ ÇEKME ──────────────────────────────────────────────
async function fetchYahooData(yahooTicker) {
  const cacheKey = `yahoo:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) { console.log(`Cache hit: ${yahooTicker}`); return cached; }

  const isBIST = yahooTicker.endsWith('.IS');

  let result = {
    currentPrice: null, currency: isBIST ? 'TRY' : 'USD',
    marketCap: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null,
    peRatio: null, forwardPE: null, pbRatio: null, pegRatio: null, evEbitda: null,
    grossMargin: null, operatingMargin: null, profitMargin: null,
    roe: null, roa: null, freeCashflow: null, operatingCashflow: null,
    totalCash: null, totalDebt: null, debtToEquity: null, currentRatio: null,
    revenueGrowth: null, earningsGrowth: null,
    institutionOwnership: null, recommendationKey: null,
    targetMeanPrice: null, numberOfAnalystOpinions: null,
    shortName: null, website: null, sector: null, industry: null,
    totalAssets: null, totalLiabilities: null, netIncome: null,
    computedEquity: null, pbSource: null, roeSource: null,
    peers: [], dataSource: 'Yahoo',
  };

  // ── ADIM 1: Yahoo v8 chart (crumb GEREKMİYOR — her zaman çalışır) ──
  // Bu endpoint public ve crumb olmadan fiyat + meta verir
  for (const base of ['query2', 'query1']) {
    try {
      const url = `https://${base}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d&includePrePost=false`;
      const r = await fetch(url, {
        headers: BASE_HEADERS,
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) { console.log(`[v8] ${base} HTTP ${r.status}`); continue; }
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;

      result.currentPrice     = meta.regularMarketPrice;
      result.currency         = meta.currency || result.currency;
      result.marketCap        = meta.marketCap ?? null;
      result.fiftyTwoWeekLow  = meta.fiftyTwoWeekLow ?? null;
      result.fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh ?? null;
      console.log(`[v8 chart] OK: price=${result.currentPrice} mktCap=${result.marketCap}`);
      break;
    } catch (e) { console.log(`[v8] ${e.message}`); }
  }

  // ── ADIM 2: Yahoo v7 quote (crumb ile dene, başarısızsa atla) ──
  const { crumb, cookie } = await tryGetCrumb();
  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const makeH = () => ({ ...BASE_HEADERS, ...(cookie ? { 'Cookie': cookie } : {}) });

  if (crumb) {
    for (const base of ['query2', 'query1']) {
      try {
        const fields = [
          'shortName','longName','regularMarketPrice','currency','marketCap',
          'fiftyTwoWeekLow','fiftyTwoWeekHigh',
          'trailingPE','forwardPE','priceToBook','pegRatio','enterpriseToEbitda',
          'profitMargins','grossMargins','operatingMargins',
          'returnOnEquity','returnOnAssets',
          'freeCashflow','operatingCashflow','totalCash','totalDebt',
          'debtToEquity','currentRatio','revenueGrowth','earningsGrowth',
          'heldPercentInstitutions','targetMeanPrice',
          'recommendationKey','numberOfAnalystOpinions'
        ].join(',');
        const url = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooTicker)}&fields=${fields}${cs}`;
        const r = await fetch(url, { headers: makeH(), signal: AbortSignal.timeout(8000) });
        if (!r.ok) continue;
        const j = await r.json();
        const q = j?.quoteResponse?.result?.[0];
        if (!q?.regularMarketPrice) continue;

        result.shortName         = q.shortName  ?? q.longName ?? null;
        if (!result.currentPrice)  result.currentPrice = q.regularMarketPrice;
        result.currency          = q.currency ?? result.currency;
        if (!result.marketCap)     result.marketCap = q.marketCap ?? null;
        if (!result.fiftyTwoWeekLow)  result.fiftyTwoWeekLow  = q.fiftyTwoWeekLow ?? null;
        if (!result.fiftyTwoWeekHigh) result.fiftyTwoWeekHigh = q.fiftyTwoWeekHigh ?? null;
        result.peRatio           = q.trailingPE ?? null;
        result.forwardPE         = q.forwardPE ?? null;
        result.pbRatio           = q.priceToBook ?? null;
        result.pegRatio          = q.pegRatio ?? null;
        result.evEbitda          = q.enterpriseToEbitda ?? null;
        result.grossMargin       = q.grossMargins ?? null;
        result.operatingMargin   = q.operatingMargins ?? null;
        result.profitMargin      = q.profitMargins ?? null;
        result.roe               = q.returnOnEquity ?? null;
        result.roa               = q.returnOnAssets ?? null;
        result.freeCashflow      = q.freeCashflow ?? null;
        result.operatingCashflow = q.operatingCashflow ?? null;
        result.totalCash         = q.totalCash ?? null;
        result.totalDebt         = q.totalDebt ?? null;
        result.debtToEquity      = q.debtToEquity ?? null;
        result.currentRatio      = q.currentRatio ?? null;
        result.revenueGrowth     = q.revenueGrowth ?? null;
        result.earningsGrowth    = q.earningsGrowth ?? null;
        result.institutionOwnership = q.heldPercentInstitutions ?? null;
        result.targetMeanPrice   = q.targetMeanPrice ?? null;
        result.recommendationKey = q.recommendationKey ?? null;
        result.numberOfAnalystOpinions = q.numberOfAnalystOpinions ?? null;
        console.log(`[v7 quote] OK: pe=${result.peRatio} pb=${result.pbRatio} roe=${result.roe}`);
        break;
      } catch(e) { console.log(`[v7] ${e.message}`); }
    }

    // ── ADIM 3: v10 quoteSummary (ham bilanço için) ──
    const needsMore = !result.roe || !result.grossMargin || !result.pbRatio || !result.totalDebt || isBIST;
    if (needsMore) {
      const modules = isBIST
        ? 'financialData,defaultKeyStatistics,summaryDetail,assetProfile,balanceSheetHistory,incomeStatementHistory'
        : 'financialData,defaultKeyStatistics,summaryDetail,assetProfile';

      for (const base of ['query2', 'query1']) {
        try {
          const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}${cs}`;
          const r = await fetch(url, { headers: makeH(), signal: AbortSignal.timeout(10000) });
          if (!r.ok) continue;
          const j = await r.json();
          const raw = j?.quoteSummary?.result?.[0];
          if (!raw) continue;

          const fd = raw.financialData || {};
          const ks = raw.defaultKeyStatistics || {};
          const sd = raw.summaryDetail || {};
          const ap = raw.assetProfile || {};
          const f  = v => v?.raw ?? null;

          if (!result.peRatio)            result.peRatio    = f(sd.trailingPE) ?? f(ks.trailingPE);
          if (!result.forwardPE)          result.forwardPE  = f(sd.forwardPE)  ?? f(ks.forwardPE);
          if (!isBIST && !result.pbRatio) result.pbRatio    = f(ks.priceToBook);
          if (!result.pegRatio)           result.pegRatio   = f(ks.pegRatio);
          if (!result.evEbitda)           result.evEbitda   = f(ks.enterpriseToEbitda);
          if (!result.grossMargin)        result.grossMargin       = f(fd.grossMargins);
          if (!result.operatingMargin)    result.operatingMargin   = f(fd.operatingMargins);
          if (!result.profitMargin)       result.profitMargin      = f(fd.profitMargins);
          if (!result.roe)                result.roe               = f(fd.returnOnEquity);
          if (!result.roa)                result.roa               = f(fd.returnOnAssets);
          if (!result.freeCashflow)       result.freeCashflow      = f(fd.freeCashflow);
          if (!result.operatingCashflow)  result.operatingCashflow = f(fd.operatingCashflow);
          if (!result.totalCash)          result.totalCash         = f(fd.totalCash);
          if (!result.totalDebt)          result.totalDebt         = f(fd.totalDebt);
          if (!result.debtToEquity)       result.debtToEquity      = f(fd.debtToEquity);
          if (!result.currentRatio)       result.currentRatio      = f(fd.currentRatio);
          if (!result.revenueGrowth)      result.revenueGrowth     = f(fd.revenueGrowth);
          if (!result.earningsGrowth)     result.earningsGrowth    = f(fd.earningsGrowth);
          if (!result.institutionOwnership) result.institutionOwnership = f(ks.heldPercentInstitutions);
          if (!result.targetMeanPrice)    result.targetMeanPrice   = f(fd.targetMeanPrice);
          if (!result.recommendationKey)  result.recommendationKey = fd.recommendationKey ?? null;
          result.sector   = ap.sector   ?? result.sector;
          result.industry = ap.industry ?? result.industry;
          result.website  = ap.website  ?? result.website;

          const trailingEps = f(ks.trailingEps);
          if (trailingEps && isBIST) result._trailingEps = trailingEps;

          if (raw.balanceSheetHistory) {
            const sheets = raw.balanceSheetHistory.balanceSheetStatements || [];
            if (sheets.length > 0) {
              const lat = sheets[0];
              const fb  = v => v?.raw ?? null;
              const ta = fb(lat.totalAssets), tl = fb(lat.totalLiab), se = fb(lat.totalStockholderEquity);
              if (ta != null) result.totalAssets      = ta;
              if (tl != null) result.totalLiabilities = tl;
              if (se != null) { result.computedEquity = se; console.log(`[Bilanço] Assets=${ta?.toExponential(3)} Liab=${tl?.toExponential(3)} SE=${se?.toExponential(3)}`); }
            }
          }
          if (raw.incomeStatementHistory) {
            const stmts = raw.incomeStatementHistory.incomeStatementHistory || [];
            if (stmts.length > 0) { const ni = stmts[0].netIncome?.raw ?? null; if (ni != null) result.netIncome = ni; }
          }

          if (isBIST && result.peRatio != null) {
            if (result.peRatio <= 0 || result.peRatio > 200) { console.log(`[BIST] PE anormal: ${result.peRatio}`); result.peRatio = null; }
          }

          console.log(`[v10] OK: roe=${result.roe} assets=${result.totalAssets} ni=${result.netIncome}`);
          break;
        } catch(e) { console.log(`[v10] ${e.message}`); }
      }
    }
  } else {
    // Crumb yok — sadece v8 chart ile devam, BIST için TV kullanacağız
    console.log('[Yahoo] Crumb alınamadı — sadece v8 chart verisi kullanılıyor');
    if (!result.shortName) result.shortName = yahooTicker.replace('.IS', '');
  }

  if (!result.currentPrice) {
    throw new Error(`Fiyat verisi alınamadı: ${yahooTicker}`);
  }

  // ── BIST DÜZELTME PIPELINE ────────────────────────────────────
  if (isBIST) {
    // TradingView'dan doğrudan oku (iç API çağrısı yok)
    const tv = await fetchTradingView(yahooTicker);

    if (tv) {
      if (tv.pe != null && tv.pe > 0.3 && tv.pe < 200) {
        result.peRatio  = tv.pe; result.peSource = 'TradingView';
        console.log(`[TV] PE override: ${result.peRatio}`);
      }
      if (tv.pb != null && tv.pb > 0.03 && tv.pb < 30) {
        result.pbRatio  = tv.pb; result.pbSource = 'TradingView';
        console.log(`[TV] PD/DD override: ${result.pbRatio}`);
      }
      if (tv.roe != null && Math.abs(tv.roe) < 3) {
        if (!result.roe) result.roe = tv.roe;
      }
      if (tv.evEbitda != null) result.evEbitda = result.evEbitda ?? tv.evEbitda;
      if (tv.debtToEquity != null) result.debtToEquity = result.debtToEquity ?? tv.debtToEquity;
      if (!result.marketCap && tv.marketCap) result.marketCap = tv.marketCap;
      if (!result.currentPrice && tv.price) result.currentPrice = tv.price;
    }

    // ADIM 1: BIST için Yahoo pb'yi sıfırla (TV yoksa formülle hesaplanacak)
    if (!tv?.pb) {
      const yahooPB = result.pbRatio;
      result.pbRatio = null;
      if (yahooPB) console.log(`[BIST] Yahoo pb=${yahooPB?.toFixed(2)} yoksayıldı`);
    }

    // ADIM 2: Birim normalizasyonu
    result = normalizeBISTUnits(result);

    // ADIM 3: Anormal değerleri temizle
    if (result.peRatio && (result.peRatio > 200 || result.peRatio < 0)) result.peRatio = null;
    if (result.roe && Math.abs(result.roe) > 5) result.roe = result.roe / 100;

    // ADIM 4: Formül bazlı PD/DD ve ROE
    if (!result.pbRatio) result = computeFromRawData(result, true);
    else result = computeFromRawData(result, false);

    // ADIM 5: Hâlâ eksikse eski scraping
    if (result.pbRatio == null || result.peRatio == null) {
      const t = yahooTicker.replace('.IS', '');
      const sc = await scrapeBISTFallback(t);
      if (sc.source) {
        if (result.peRatio == null && sc.peRatio) result.peRatio = sc.peRatio;
        if (result.pbRatio == null && sc.pbRatio) { result.pbRatio = sc.pbRatio; result.pbSource = sc.source; }
        if (result.roe     == null && sc.roe)     { result.roe     = sc.roe;     result.roeSource = sc.source; }
        result.dataSource = sc.source;
      }
    }

    // ADIM 6: PE son çare — MC / NetIncome
    if (result.peRatio == null && result.marketCap && result.netIncome) {
      const niNorm = detectAndNormalize(result.netIncome, result.marketCap, 0.0001, 10, 'NetIncome_PE');
      if (niNorm > 0) {
        const peCalc = result.marketCap / niNorm;
        if (peCalc > 0.5 && peCalc < 200) { result.peRatio = parseFloat(peCalc.toFixed(2)); result.peSource = 'formül(MC/NI)'; }
      }
    }

    // ADIM 7: EPS üzerinden PE
    if (result.peRatio == null && result.currentPrice && result._trailingEps) {
      const eps = result._trailingEps;
      const epsNorm = Math.abs(eps) < 10 ? eps * APPROX_USD_TRY : eps;
      if (epsNorm > 0 && result.currentPrice > 0) {
        const peEps = result.currentPrice / epsNorm;
        if (peEps > 0.5 && peEps < 200) { result.peRatio = parseFloat(peEps.toFixed(2)); result.peSource = 'formül(Fiyat/EPS)'; }
      }
    }

    console.log(`[BIST Final] PE=${result.peRatio?.toFixed(2)}(${result.peSource||'?'}) PD/DD=${result.pbRatio?.toFixed(2)}(${result.pbSource}) ROE=${result.roe ? (result.roe*100).toFixed(1)+'%' : 'N/A'}`);
  }

  // Logo
  if (result.website) {
    try {
      const domain = new URL(result.website.startsWith('http') ? result.website : 'https://' + result.website).hostname;
      result.logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch {}
  }

  setCache(cacheKey, result);
  return result;
}

// ── SIGNAL HELPERS ───────────────────────────────────────────────
function sigPE(v)  { if(v==null)return'N/A'; if(v<12)return'ucuz'; if(v<22)return'adil'; return'pahalı'; }
function sigPB(v)  { if(v==null)return'N/A'; if(v<1.5)return'ucuz'; if(v<3)return'adil'; return'pahalı'; }
function sigPEG(v) { if(v==null)return'N/A'; if(v<1)return'ucuz — Lynch fırsatı'; if(v<1.5)return'adil'; if(v<2)return'dikkatli ol'; return'pahalı'; }
function sigEV(v)  { if(v==null)return'N/A'; if(v<8)return'ucuz'; if(v<15)return'adil'; return'pahalı'; }

// ── ANA HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, prompt, exchange } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY env eksik' });

  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  let financialData = null;
  try { financialData = await fetchYahooData(yahooTicker); }
  catch(e) { console.log('Fetch failed:', e.message); }

  const fd     = financialData;
  const isBIST = exchange === 'BIST';

  const systemPrompt = `Sen "Barış Investing" platformunun analiz motorusun. Warren Buffett, Peter Lynch ve Ray Dalio felsefesiyle profesyonel Türkçe analiz raporu yazıyorsun.

ÜSLUP: Profesyonel analist. Chatbot değil. Sade ama ikna edici.
FORMAT: Markdown yok. # yok. * yok. Düz metin. TOTAL_SCORE 0-7 arası tam sayı. 7 geçemez.
HER KRİTER: Minimum 2-3 cümle. Somut rakam. Sektör karşılaştırması.

BUFFETT KURALLARI:
- Fiyatlama Gücü = Brüt marj stabilitesi. F/K DEĞİL.
- Hissedar Kazancı = FCF proxy
- $1 Testi = Alıkonulan her $1 kâr → $1+ piyasa değeri?
- Hendek = Marka/ağ etkisi/maliyet avantajı kanıtı.

LYNCH KURALLARI:
- Kategori: Yavaş/Orta/Hızlı Büyüyen / Döngüsel / Varlık Zengini / Dönüşümdeki
- PEG < 1.0 = fırsat, > 2.0 = pahalı/FAIL
- Kurumsal sahiplik < %30 = "Gizli Mücevher"

DALIO KURALLARI:
- Borç döngüsü, para politikası, döviz riski, enflasyon koruması, makro şok direnci.

TÜRK HİSSELERİ: Nominal büyüme TÜFE altındaysa "REEL KÜÇÜLME" uyarısı ekle.
BIST F/K VE F/DD: Eğer hesaplanan veya güvenilmez ise tek başına PASS/FAIL YAPMA. ROE, FCF ve özsermaye üzerinden değerlendir.`;

  let enrichedPrompt = '';
  if (fd) {
    const n   = (v,d=1) => v!=null ? Number(v).toFixed(d) : 'N/A';
    const p   = v => v!=null ? `%${(v*100).toFixed(1)}` : 'N/A';
    const big = v => {
      if(v==null) return 'N/A';
      const a = Math.abs(v);
      if(a>=1e12) return `${(v/1e12).toFixed(2)}T`;
      if(a>=1e9)  return `${(v/1e9).toFixed(2)}B`;
      if(a>=1e6)  return `${(v/1e6).toFixed(2)}M`;
      return Number(v).toFixed(0);
    };
    const nc     = (fd.totalCash!=null && fd.totalDebt!=null) ? fd.totalCash - fd.totalDebt : null;
    const upside = fd.currentPrice && fd.targetMeanPrice
      ? ((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice * 100).toFixed(1) : null;
    const pbNote  = fd.pbSource  && fd.pbSource  !== 'Yahoo' ? ` [${fd.pbSource}]` : '';
    const roeNote = fd.roeSource && fd.roeSource !== 'Yahoo' ? ` [${fd.roeSource}]` : '';
    let warnings = '';
    if (isBIST && fd.computedEquity!=null) warnings += `BİLGİ: Özsermaye hesaplandı = ${big(fd.computedEquity)} TRY\n`;
    if (isBIST && fd.peRatio==null)  warnings += 'NOT: F/K güvenilmez — sektör ortalaması kullan.\n';
    if (isBIST && fd.pbRatio==null)  warnings += 'NOT: F/DD hesaplanamadı — ROE ve piyasa değeri üzerinden değerlendir.\n';
    if (fd.dataSource !== 'Yahoo')   warnings += `VERİ KAYNAĞI: ${fd.dataSource}\n`;

    enrichedPrompt = `GERÇEK FİNANSAL VERİLER [${fd.dataSource}] — BU RAKAMLARI KULLAN:
Fiyat: ${fd.currentPrice ? `${Number(fd.currentPrice).toFixed(2)} ${fd.currency}` : 'N/A'}
52H Aralık: ${n(fd.fiftyTwoWeekLow,2)} - ${n(fd.fiftyTwoWeekHigh,2)} ${fd.currency||''}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${n(fd.peRatio)} | F/K Forward: ${n(fd.forwardPE)} | F/DD: ${n(fd.pbRatio)}${pbNote}
PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)}${roeNote} | ROA: ${p(fd.roa)}
Brüt Marj: ${p(fd.grossMargin)} | Faaliyet Marjı: ${p(fd.operatingMargin)} | Net Marj: ${p(fd.profitMargin)}
FCF: ${big(fd.freeCashflow)} | Op.CF: ${big(fd.operatingCashflow)}
Nakit: ${big(fd.totalCash)} | Borç: ${big(fd.totalDebt)} | Net Nakit: ${big(nc)}
Borç/Özsermaye: ${n(fd.debtToEquity)} | Cari Oran: ${n(fd.currentRatio)}
Gelir Büyümesi: ${p(fd.revenueGrowth)} | Kazanç Büyümesi: ${p(fd.earningsGrowth)}
Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${n(fd.targetMeanPrice,2)} | Potansiyel: ${upside ? `%${upside}` : 'N/A'}
${fd.sector ? `Sektör: ${fd.sector}${fd.industry ? ' / '+fd.industry : ''}` : ''}
${fd.totalAssets ? `Ham Bilanço: Varlıklar=${big(fd.totalAssets)} | Borçlar=${big(fd.totalLiabilities)} | NetKar=${big(fd.netIncome)}` : ''}
${warnings ? '\nUYARILAR:\n'+warnings : ''}
MULTIPLES: PE=${n(fd.peRatio)} PB=${n(fd.pbRatio)} PEG=${n(fd.pegRatio)} EV_EBITDA=${n(fd.evEbitda)}
---
`;
  }

  enrichedPrompt += prompt;
  enrichedPrompt += '\n\nKRİTİK KURAL: Her PASS/FAIL/NEUTRAL pipe (|) ile açıklama içermeli. CRITERIA_START/CRITERIA_END olmalı. Her kriter 2-3 cümle somut analiz.';
  if (!fd) enrichedPrompt += '\n\nVERİ NOTU: Finansal veri alınamadı. Sektör bilgine göre tahmin yap. "Veri sınırlı" uyarısı ekle ama analizi tamamla.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: enrichedPrompt }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: `${data.error.type}: ${data.error.message}` });

    let aiResult = data.content?.[0]?.text || '';
    aiResult = aiResult.replace(/TOTAL_SCORE:\s*(\d+)/i, (m, sc) =>
      `TOTAL_SCORE: ${Math.min(7, Math.max(0, parseInt(sc)))}`
    );

    if (fd) {
      const n2 = (v,d=1) => v!=null ? Number(v).toFixed(d) : 'N/A';
      if (fd.peRatio  != null) aiResult = aiResult.replace(/PE:\s*[\d.N\/A]+\s*\|/, `PE: ${n2(fd.peRatio)} |`);
      if (fd.pbRatio  != null) aiResult = aiResult.replace(/PB:\s*[\d.N\/A]+\s*\|/, `PB: ${n2(fd.pbRatio)} |`);
      if (fd.pegRatio != null) aiResult = aiResult.replace(/PEG:\s*[\d.N\/A]+\s*\|/, `PEG: ${n2(fd.pegRatio)} |`);
      if (fd.evEbitda != null) aiResult = aiResult.replace(/EV_EBITDA:\s*[\d.N\/A]+\s*\|/, `EV_EBITDA: ${n2(fd.evEbitda)} |`);
    }

    console.log(`✓ ${yahooTicker} | src:${fd?.dataSource} | roe:${fd?.roe} | pb:${fd?.pbRatio}(${fd?.pbSource||'yahoo'}) | len:${aiResult.length}`);
    return res.status(200).json({ result: aiResult, financialData: fd, peers: fd?.peers || [] });

  } catch(err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
