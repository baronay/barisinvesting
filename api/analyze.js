// /api/analyze.js — Barış Investing
// FIX v3: TradingView primary (PE/PB/ROE), Yahoo v8+v10 supplement (marj/FCF/sektör)
// Debug sonucu: TV çalışıyor ✅ | Yahoo v8 fiyat veriyor ✅ | v7 401 ❌ (crumb ile de)

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
const YH = {
  'User-Agent': UA,
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// ── YAHOO CRUMB ──────────────────────────────────────────────────
let _crumb = null, _cookie = null, _crumbTs = 0;
const CRUMB_TTL = 50 * 60 * 1000;

async function getYahooCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  try {
    // fc.yahoo.com 404 döndürse bile cookie header geliyor (debug'dan doğrulandı)
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA }, redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookieVal = setCookie.split(';')[0] || '';
    if (!cookieVal) { console.log('[Crumb] Cookie yok'); return { crumb: null, cookie: null }; }

    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...YH, 'Cookie': cookieVal, 'Accept': 'text/plain' },
      signal: AbortSignal.timeout(5000),
    });
    if (r2.ok) {
      const txt = await r2.text();
      if (txt && txt.length > 0 && !txt.includes('{')) {
        _crumb = txt.trim(); _cookie = cookieVal; _crumbTs = Date.now();
        console.log('[Crumb] OK:', _crumb.slice(0,8) + '...');
      }
    }
  } catch(e) { console.log('[Crumb] Hata:', e.message); }
  return { crumb: _crumb, cookie: _cookie };
}

// ── BİRİM TESPİT MOTORU ─────────────────────────────────────────
function detectAndNormalize(val, mktCap, minR, maxR, label) {
  if (val == null || !mktCap || mktCap <= 0) return val;
  const ratio = Math.abs(val) / mktCap;
  if (ratio >= minR && ratio <= maxR) return val;
  if (ratio < minR) {
    const t = val * APPROX_USD_TRY; if (Math.abs(t)/mktCap >= minR && Math.abs(t)/mktCap <= maxR) { console.log(`[Birim] ${label}: x38`); return t; }
    const k = val * 1000;            if (Math.abs(k)/mktCap >= minR && Math.abs(k)/mktCap <= maxR) { console.log(`[Birim] ${label}: x1000`); return k; }
    const ku = val * 1000 * APPROX_USD_TRY; if (Math.abs(ku)/mktCap >= minR && Math.abs(ku)/mktCap <= maxR) { console.log(`[Birim] ${label}: x1000xUSD`); return ku; }
  }
  if (ratio > maxR) {
    const d1 = val/1000; if (Math.abs(d1)/mktCap >= minR && Math.abs(d1)/mktCap <= maxR) { console.log(`[Birim] ${label}: /1000`); return d1; }
    const dm = val/1e6;  if (Math.abs(dm)/mktCap >= minR && Math.abs(dm)/mktCap <= maxR) { console.log(`[Birim] ${label}: /1M`); return dm; }
  }
  return val;
}

function normalizeBISTUnits(r) {
  if (!r.marketCap) return r;
  const MC = r.marketCap;
  r.totalAssets      = detectAndNormalize(r.totalAssets,      MC, 0.001, 500, 'Assets');
  r.totalLiabilities = detectAndNormalize(r.totalLiabilities, MC, 0.001, 500, 'Liabilities');
  r.computedEquity   = detectAndNormalize(r.computedEquity,   MC, 0.001, 500, 'Equity');
  r.freeCashflow     = detectAndNormalize(r.freeCashflow,     MC, 0.0001, 20, 'FCF');
  r.operatingCashflow= detectAndNormalize(r.operatingCashflow,MC, 0.0001, 20, 'OpCF');
  r.totalCash        = detectAndNormalize(r.totalCash,        MC, 0.0001, 20, 'Cash');
  r.totalDebt        = detectAndNormalize(r.totalDebt,        MC, 0.0001, 20, 'Debt');
  r.netIncome        = detectAndNormalize(r.netIncome,        MC, 0.0001, 20, 'NetIncome');
  return r;
}

function computeEquityRatios(result) {
  let equity = (result.computedEquity > 0) ? result.computedEquity : null;
  if (!equity && result.totalAssets > 0 && result.totalLiabilities > 0) {
    const c = result.totalAssets - result.totalLiabilities;
    if (c > 0) { equity = c; result.computedEquity = c; }
  }
  if (!equity || !result.marketCap) return result;

  if (!result.pbRatio) {
    const pb = result.marketCap / equity;
    if (pb > 0.05 && pb < 50) { result.pbRatio = +pb.toFixed(2); result.pbSource = 'formul(Varliklar-Borclar)'; }
    else {
      const pbU = result.marketCap / (equity * APPROX_USD_TRY);
      if (pbU > 0.05 && pbU < 50) { result.pbRatio = +pbU.toFixed(2); result.pbSource = 'formul(USD-TRY)'; result.computedEquity = equity * APPROX_USD_TRY; }
    }
  }
  if (!result.roe && result.netIncome) {
    const roe = result.netIncome / equity;
    if (Math.abs(roe) < 3) { result.roe = +roe.toFixed(4); result.roeSource = 'formul'; }
  }
  if (!result.debtToEquity && result.totalDebt) {
    result.debtToEquity = +((result.totalDebt / equity) * 100).toFixed(1);
  }
  return result;
}

// ── TRADİNGVİEW — BIST primary kaynak ──────────────────────────
// Debug'da doğrulandı: status 200, PE=3.44, PB=0.45, ROE=14.86, MC=410B
async function fetchTradingView(bistTicker) {
  const sym = `BIST:${bistTicker.replace('.IS','').toUpperCase()}`;
  const cols = [
    'close',                        // 0  fiyat
    'price_earnings_ttm',           // 1  F/K
    'price_book_ratio',             // 2  F/DD
    'market_cap_basic',             // 3  piyasa degeri
    'return_on_equity',             // 4  ROE (% cinsinden, ornegin 14.85)
    'debt_to_equity',               // 5  D/E
    'enterprise_value_ebitda_ttm',  // 6  EV/EBITDA
    'earnings_per_share_basic_ttm', // 7  EPS (F/K yedek)
    'gross_margin',                 // 8  brut marj (%)
    'operating_margin',             // 9  faaliyet marji (%)
    'net_margin',                   // 10 net marj (%)
    'free_cash_flow_ttm',           // 11 FCF
    'revenue_growth_rate_ttm',      // 12 gelir buyumesi (%)
  ];
  try {
    const r = await fetch('https://scanner.tradingview.com/turkey/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/',
        'User-Agent': UA,
      },
      body: JSON.stringify({ symbols: { tickers:[sym], query:{types:[]} }, columns: cols }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { console.log(`[TV] HTTP ${r.status}`); return null; }
    const json = await r.json();
    const d = json?.data?.[0]?.d;
    if (!d) { console.log('[TV] Veri yok'); return null; }
    const s = (i) => { const v = parseFloat(d[i]); return (isNaN(v)||!isFinite(v)) ? null : v; };
    const fk = s(1), eps = s(7), price = s(0);
    const fkFinal = (fk != null && fk > 0 && fk < 300) ? fk
                  : (price && eps && eps > 0) ? +(price/eps).toFixed(2) : null;
    const tv = {
      price,
      pe:              fkFinal,
      pb:              s(2),
      marketCap:       s(3),
      roe:             s(4) != null ? s(4) / 100 : null, // % -> oran
      debtToEquity:    s(5),
      evEbitda:        s(6),
      grossMargin:     s(8) != null ? s(8) / 100 : null,
      operatingMargin: s(9) != null ? s(9) / 100 : null,
      profitMargin:    s(10)!= null ? s(10)/ 100 : null,
      freeCashflow:    s(11),
      revenueGrowth:   s(12)!= null ? s(12)/ 100 : null,
    };
    console.log(`[TV] ${bistTicker}: fiyat=${tv.price} PE=${tv.pe} PB=${tv.pb} ROE%=${s(4)} MC=${tv.marketCap}`);
    return tv;
  } catch(e) { console.log('[TV] Hata:', e.message); return null; }
}

// ── YAHOO v8 chart — fiyat + 52H (crumb gerektirmiyor) ──────────
async function fetchYahooChart(yahooTicker) {
  for (const base of ['query1','query2']) {
    try {
      const r = await fetch(
        `https://${base}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d`,
        { headers: YH, signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;
      console.log(`[v8] ${base}: fiyat=${meta.regularMarketPrice} MC=${meta.marketCap}`);
      return {
        price:    meta.regularMarketPrice,
        currency: meta.currency,
        marketCap:meta.marketCap ?? null,
        low52:    meta.fiftyTwoWeekLow  ?? null,
        high52:   meta.fiftyTwoWeekHigh ?? null,
      };
    } catch(e) { console.log(`[v8] ${base}: ${e.message}`); }
  }
  return null;
}

// ── YAHOO v10 quoteSummary — marj/FCF/sektor/bilanco ────────────
async function fetchYahooSummary(yahooTicker, crumb, cookie) {
  if (!crumb) { console.log('[v10] Crumb yok, atlanıyor'); return null; }
  const isBIST = yahooTicker.endsWith('.IS');
  const modules = isBIST
    ? 'financialData,defaultKeyStatistics,summaryDetail,assetProfile,balanceSheetHistory,incomeStatementHistory'
    : 'financialData,defaultKeyStatistics,summaryDetail,assetProfile';
  const h = { ...YH, 'Cookie': cookie };

  for (const base of ['query2','query1']) {
    try {
      const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
      const r = await fetch(url, { headers: h, signal: AbortSignal.timeout(10000) });
      if (!r.ok) { console.log(`[v10] ${base} HTTP ${r.status}`); continue; }
      const j = await r.json();
      const raw = j?.quoteSummary?.result?.[0];
      if (!raw) continue;

      const fd = raw.financialData        || {};
      const ks = raw.defaultKeyStatistics || {};
      const sd = raw.summaryDetail        || {};
      const ap = raw.assetProfile         || {};
      const f  = v => v?.raw ?? null;

      const out = {
        sector:    ap.sector   ?? null,
        industry:  ap.industry ?? null,
        website:   ap.website  ?? null,
        longBusinessSummary: ap.longBusinessSummary ?? null,
        shortName: ap.address1 ? null : null,
        grossMargin:       f(fd.grossMargins),
        operatingMargin:   f(fd.operatingMargins),
        profitMargin:      f(fd.profitMargins),
        roe:               f(fd.returnOnEquity),
        roa:               f(fd.returnOnAssets),
        freeCashflow:      f(fd.freeCashflow),
        operatingCashflow: f(fd.operatingCashflow),
        totalCash:         f(fd.totalCash),
        totalDebt:         f(fd.totalDebt),
        debtToEquity:      f(fd.debtToEquity),
        currentRatio:      f(fd.currentRatio),
        revenueGrowth:     f(fd.revenueGrowth),
        earningsGrowth:    f(fd.earningsGrowth),
        targetMeanPrice:   f(fd.targetMeanPrice),
        recommendationKey: fd.recommendationKey ?? null,
        institutionOwnership: f(ks.heldPercentInstitutions),
        pegRatio:          f(ks.pegRatio),
        evEbitda:          f(ks.enterpriseToEbitda),
        forwardPE:         f(ks.forwardPE) ?? f(sd.forwardPE),
        trailingEps:       f(ks.trailingEps),
        totalAssets: null, totalLiabilities: null, computedEquity: null, netIncome: null,
      };

      if (raw.balanceSheetHistory?.balanceSheetStatements?.[0]) {
        const lat = raw.balanceSheetHistory.balanceSheetStatements[0];
        out.totalAssets      = lat.totalAssets?.raw ?? null;
        out.totalLiabilities = lat.totalLiab?.raw   ?? null;
        out.computedEquity   = lat.totalStockholderEquity?.raw ?? null;
        console.log(`[v10] Bilanco: Assets=${out.totalAssets} Liab=${out.totalLiabilities} SE=${out.computedEquity}`);
      }
      if (raw.incomeStatementHistory?.incomeStatementHistory?.[0]) {
        out.netIncome = raw.incomeStatementHistory.incomeStatementHistory[0].netIncome?.raw ?? null;
      }
      console.log(`[v10] ${base} OK: roe=${out.roe} fcf=${out.freeCashflow} sector=${out.sector}`);
      return out;
    } catch(e) { console.log(`[v10] ${base}: ${e.message}`); }
  }
  return null;
}

// ── BIST SCRAPING Son Çare ───────────────────────────────────────
async function scrapeBISTFallback(ticker) {
  const out = { peRatio:null, pbRatio:null, roe:null, source:null };
  try {
    const r = await fetch(`https://www.isyatirim.com.tr/analiz-ve-bulten/hisse/${ticker}`,
      { headers:{...YH,'Accept':'text/html','Accept-Language':'tr-TR'}, signal:AbortSignal.timeout(6000) });
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
  } catch(e) { console.log('IsYat:', e.message); }
  return out;
}

// ── ANA VERİ ÇEKME ──────────────────────────────────────────────
async function fetchFinancialData(yahooTicker) {
  const cacheKey = `fd3:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) { console.log(`[Cache] ${yahooTicker}`); return cached; }

  const isBIST = yahooTicker.endsWith('.IS');
  const bistTicker = yahooTicker.replace('.IS','');

  let result = {
    currentPrice:null, currency: isBIST ? 'TRY' : 'USD',
    marketCap:null, fiftyTwoWeekLow:null, fiftyTwoWeekHigh:null,
    peRatio:null, forwardPE:null, pbRatio:null, pegRatio:null, evEbitda:null,
    grossMargin:null, operatingMargin:null, profitMargin:null,
    roe:null, roa:null, freeCashflow:null, operatingCashflow:null,
    totalCash:null, totalDebt:null, debtToEquity:null, currentRatio:null,
    revenueGrowth:null, earningsGrowth:null,
    institutionOwnership:null, recommendationKey:null,
    targetMeanPrice:null, numberOfAnalystOpinions:null,
    shortName:null, sector:null, industry:null, website:null, longBusinessSummary:null,
    totalAssets:null, totalLiabilities:null, netIncome:null,
    computedEquity:null, pbSource:null, roeSource:null, peSource:null,
    peers:[], dataSource:'Yahoo',
  };

  // ADIM 1: Yahoo v8 chart — fiyat + 52H (her zaman çalışıyor)
  const chart = await fetchYahooChart(yahooTicker);
  if (chart) {
    result.currentPrice     = chart.price;
    result.currency         = chart.currency || result.currency;
    result.marketCap        = chart.marketCap;
    result.fiftyTwoWeekLow  = chart.low52;
    result.fiftyTwoWeekHigh = chart.high52;
  }

  // ADIM 2: TradingView (BIST) — PE/PB/ROE/marj primary kaynak
  if (isBIST) {
    const tv = await fetchTradingView(yahooTicker);
    if (tv) {
      result.dataSource = 'TradingView+Yahoo';
      if (!result.currentPrice && tv.price)    result.currentPrice = tv.price;
      if (!result.marketCap   && tv.marketCap) result.marketCap    = tv.marketCap;
      if (tv.pe  != null && tv.pe  > 0.3 && tv.pe  < 300) { result.peRatio  = +tv.pe.toFixed(2);  result.peSource  = 'TradingView'; }
      if (tv.pb  != null && tv.pb  > 0.03 && tv.pb < 50)  { result.pbRatio  = +tv.pb.toFixed(2);  result.pbSource  = 'TradingView'; }
      if (tv.roe != null && Math.abs(tv.roe) < 5)          { result.roe      = +tv.roe.toFixed(4); result.roeSource = 'TradingView'; }
      if (tv.evEbitda     != null) result.evEbitda        = tv.evEbitda;
      if (tv.debtToEquity != null) result.debtToEquity    = tv.debtToEquity;
      if (tv.grossMargin  != null) result.grossMargin     = tv.grossMargin;
      if (tv.operatingMargin != null) result.operatingMargin = tv.operatingMargin;
      if (tv.profitMargin != null) result.profitMargin    = tv.profitMargin;
      if (tv.freeCashflow != null) result.freeCashflow    = tv.freeCashflow;
      if (tv.revenueGrowth!= null) result.revenueGrowth  = tv.revenueGrowth;
    }
  }

  // ADIM 3: Yahoo crumb + v10 summary (sektor/bilanco/FCF detay)
  const { crumb, cookie } = await getYahooCrumb();
  const ys = await fetchYahooSummary(yahooTicker, crumb, cookie);
  if (ys) {
    result.sector   = ys.sector   ?? result.sector;
    result.industry = ys.industry ?? result.industry;
    result.website  = ys.website  ?? result.website;
    result.longBusinessSummary = ys.longBusinessSummary;
    result.forwardPE   = ys.forwardPE  ?? result.forwardPE;
    result.pegRatio    = ys.pegRatio   ?? result.pegRatio;
    result.evEbitda    = result.evEbitda ?? ys.evEbitda;
    result.targetMeanPrice   = ys.targetMeanPrice   ?? result.targetMeanPrice;
    result.recommendationKey = ys.recommendationKey ?? result.recommendationKey;
    result.institutionOwnership = ys.institutionOwnership ?? result.institutionOwnership;
    result.roa          = ys.roa          ?? result.roa;
    result.currentRatio = ys.currentRatio ?? result.currentRatio;
    result.earningsGrowth = ys.earningsGrowth ?? result.earningsGrowth;
    if (!result.grossMargin)       result.grossMargin     = ys.grossMargin;
    if (!result.operatingMargin)   result.operatingMargin = ys.operatingMargin;
    if (!result.profitMargin)      result.profitMargin    = ys.profitMargin;
    if (!result.roe)               result.roe             = ys.roe;
    if (!result.freeCashflow)      result.freeCashflow    = ys.freeCashflow;
    if (!result.operatingCashflow) result.operatingCashflow = ys.operatingCashflow;
    if (!result.totalCash)         result.totalCash       = ys.totalCash;
    if (!result.totalDebt)         result.totalDebt       = ys.totalDebt;
    if (!result.debtToEquity)      result.debtToEquity    = ys.debtToEquity;
    if (!result.revenueGrowth)     result.revenueGrowth   = ys.revenueGrowth;
    if (isBIST) {
      result.totalAssets      = ys.totalAssets      ?? result.totalAssets;
      result.totalLiabilities = ys.totalLiabilities ?? result.totalLiabilities;
      result.computedEquity   = ys.computedEquity   ?? result.computedEquity;
      result.netIncome        = ys.netIncome        ?? result.netIncome;
    }
  }

  // ADIM 4: BIST normalizasyon + formul hesaplari
  if (isBIST) {
    result = normalizeBISTUnits(result);
    if (result.roe && Math.abs(result.roe) > 5) result.roe = result.roe / 100;
    if (!result.pbRatio) result = computeEquityRatios(result);
    if (!result.peRatio && result.marketCap && result.netIncome) {
      const niN = detectAndNormalize(result.netIncome, result.marketCap, 0.0001, 10, 'NetIncome_PE');
      if (niN > 0) { const pe = result.marketCap / niN; if (pe > 0.5 && pe < 300) { result.peRatio = +pe.toFixed(2); result.peSource = 'formul(MC/NI)'; } }
    }
    if (!result.peRatio && result.currentPrice && ys?.trailingEps) {
      const eps = Math.abs(ys.trailingEps) < 10 ? ys.trailingEps * APPROX_USD_TRY : ys.trailingEps;
      if (eps > 0) { const pe = result.currentPrice / eps; if (pe > 0.5 && pe < 300) { result.peRatio = +pe.toFixed(2); result.peSource = 'formul(F/EPS)'; } }
    }
    if (!result.pbRatio || !result.peRatio) {
      const sc = await scrapeBISTFallback(bistTicker);
      if (sc.source) {
        if (!result.peRatio && sc.peRatio) { result.peRatio = sc.peRatio; result.peSource = sc.source; }
        if (!result.pbRatio && sc.pbRatio) { result.pbRatio = sc.pbRatio; result.pbSource = sc.source; }
        if (!result.roe     && sc.roe)     { result.roe     = sc.roe;     result.roeSource = sc.source; }
        if (result.dataSource === 'Yahoo') result.dataSource = sc.source;
      }
    }
    console.log(`[BIST Final] PE=${result.peRatio}(${result.peSource||'?'}) PB=${result.pbRatio}(${result.pbSource}) ROE=${result.roe ? (result.roe*100).toFixed(1)+'%' : 'N/A'}`);
  }

  // Non-BIST: Yahoo v7 quote (crumb ile)
  if (!isBIST && crumb) {
    const fields = [
      'shortName','longName','regularMarketPrice','currency','marketCap',
      'fiftyTwoWeekLow','fiftyTwoWeekHigh','trailingPE','forwardPE','priceToBook',
      'pegRatio','enterpriseToEbitda','profitMargins','grossMargins','operatingMargins',
      'returnOnEquity','returnOnAssets','freeCashflow','operatingCashflow',
      'totalCash','totalDebt','debtToEquity','currentRatio','revenueGrowth','earningsGrowth',
      'heldPercentInstitutions','targetMeanPrice','recommendationKey','numberOfAnalystOpinions',
    ].join(',');
    for (const base of ['query2','query1']) {
      try {
        const r = await fetch(
          `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooTicker)}&fields=${fields}&crumb=${encodeURIComponent(crumb)}`,
          { headers:{ ...YH, 'Cookie': cookie }, signal: AbortSignal.timeout(8000) }
        );
        if (!r.ok) continue;
        const j = await r.json();
        const q = j?.quoteResponse?.result?.[0];
        if (!q?.regularMarketPrice) continue;
        result.shortName         = q.shortName ?? q.longName ?? result.shortName;
        if (!result.currentPrice)  result.currentPrice = q.regularMarketPrice;
        result.currency          = q.currency ?? result.currency;
        if (!result.marketCap)     result.marketCap = q.marketCap ?? null;
        result.peRatio           = q.trailingPE ?? result.peRatio;
        result.pbRatio           = q.priceToBook ?? result.pbRatio;
        result.pegRatio          = q.pegRatio ?? result.pegRatio;
        result.evEbitda          = q.enterpriseToEbitda ?? result.evEbitda;
        result.grossMargin       = result.grossMargin ?? q.grossMargins;
        result.operatingMargin   = result.operatingMargin ?? q.operatingMargins;
        result.profitMargin      = result.profitMargin ?? q.profitMargins;
        result.roe               = result.roe ?? q.returnOnEquity;
        result.roa               = result.roa ?? q.returnOnAssets;
        result.freeCashflow      = result.freeCashflow ?? q.freeCashflow;
        result.operatingCashflow = result.operatingCashflow ?? q.operatingCashflow;
        result.totalCash         = result.totalCash ?? q.totalCash;
        result.totalDebt         = result.totalDebt ?? q.totalDebt;
        result.debtToEquity      = result.debtToEquity ?? q.debtToEquity;
        result.currentRatio      = result.currentRatio ?? q.currentRatio;
        result.revenueGrowth     = result.revenueGrowth ?? q.revenueGrowth;
        result.earningsGrowth    = result.earningsGrowth ?? q.earningsGrowth;
        result.institutionOwnership = result.institutionOwnership ?? q.heldPercentInstitutions;
        result.targetMeanPrice   = result.targetMeanPrice ?? q.targetMeanPrice;
        result.recommendationKey = result.recommendationKey ?? q.recommendationKey;
        result.fiftyTwoWeekLow   = result.fiftyTwoWeekLow  ?? q.fiftyTwoWeekLow;
        result.fiftyTwoWeekHigh  = result.fiftyTwoWeekHigh ?? q.fiftyTwoWeekHigh;
        console.log(`[v7] ${base} OK: pe=${result.peRatio} pb=${result.pbRatio}`);
        break;
      } catch(e) { console.log(`[v7] ${base}: ${e.message}`); }
    }
  }

  // Logo
  if (result.website) {
    try {
      const domain = new URL(result.website.startsWith('http') ? result.website : 'https://'+result.website).hostname;
      result.logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch {}
  }

  if (!result.currentPrice) throw new Error(`Fiyat alinamadi: ${yahooTicker}`);
  setCache(cacheKey, result);
  return result;
}

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
  let fd = null;
  try { fd = await fetchFinancialData(yahooTicker); }
  catch(e) { console.log('fetchFinancialData hatasi:', e.message); }

  const isBIST = exchange === 'BIST';

  const systemPrompt = `Sen "Baris Investing" platformunun analiz motorusun. Warren Buffett, Peter Lynch ve Ray Dalio felsefesiyle profesyonel Turkce analiz raporu yaziyorsun.

USLUP: Profesyonel analist. Chatbot degil. Sade ama ikna edici.
FORMAT: Markdown yok. # yok. * yok. Duz metin. TOTAL_SCORE 0-7 arasi tam sayi. 7 gecemez.
HER KRITER: Minimum 2-3 cumle. Somut rakam. Sektor karsilastirmasi.

BUFFETT: Fiyatlama gucu=brut marj, FCF=hissedar kazanci, $1 testi, hendek analizi.
LYNCH: Kategori (Yavas/Orta/Hizli/Dongusel/Varlik/Donusum), PEG<1=firsat, kurum<%30=gizli mucevher.
DALIO: Borc dongusu, para politikasi, doviz riski, enflasyon korumasi, makro sok direnci.
TURK HISSELERI: Nominal buyume TUFE altindaysa REEL KUCUL uyarisi ekle.
BIST: F/K ve F/DD tek basina PASS/FAIL yaratmasin; ROE ve FCF oncelikli.`;

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

    enrichedPrompt = `GERCEK FINANSAL VERILER [${fd.dataSource}]:
Sirket: ${fd.shortName || ticker} | Sektor: ${fd.sector||'N/A'}${fd.industry ? ' / '+fd.industry : ''}
Fiyat: ${n(fd.currentPrice,2)} ${fd.currency} | 52H: ${n(fd.fiftyTwoWeekLow,2)}-${n(fd.fiftyTwoWeekHigh,2)}
Piyasa Degeri: ${big(fd.marketCap)}
F/K: ${n(fd.peRatio)} | F/K Fwd: ${n(fd.forwardPE)} | F/DD: ${n(fd.pbRatio)}${fd.pbSource && fd.pbSource!=='Yahoo' ? ` [${fd.pbSource}]` : ''}
PEG: ${n(fd.pegRatio)} | EV/FAVOK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)}${fd.roeSource && fd.roeSource!=='Yahoo' ? ` [${fd.roeSource}]` : ''} | ROA: ${p(fd.roa)}
Brut Marj: ${p(fd.grossMargin)} | Faaliyet Marji: ${p(fd.operatingMargin)} | Net Marj: ${p(fd.profitMargin)}
FCF: ${big(fd.freeCashflow)} | Op.CF: ${big(fd.operatingCashflow)}
Nakit: ${big(fd.totalCash)} | Borc: ${big(fd.totalDebt)} | Net Nakit: ${big(nc)}
Borc/Ozsermaye: ${n(fd.debtToEquity)} | Cari Oran: ${n(fd.currentRatio)}
Gelir Buyumesi: ${p(fd.revenueGrowth)} | Kazanc Buyumesi: ${p(fd.earningsGrowth)}
Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${n(fd.targetMeanPrice,2)} | Potansiyel: ${upside ? `%${upside}` : 'N/A'}
${fd.totalAssets ? `Ham Bilanco: Varliklar=${big(fd.totalAssets)} | Borclar=${big(fd.totalLiabilities)} | NetKar=${big(fd.netIncome)}` : ''}
${isBIST && fd.computedEquity ? `Ozsermaye (hesaplanan): ${big(fd.computedEquity)} TRY` : ''}
${isBIST && !fd.peRatio ? 'NOT: F/K guvensiz - sektor bazinda degerlendir.' : ''}
MULTIPLES: PE=${n(fd.peRatio)} PB=${n(fd.pbRatio)} PEG=${n(fd.pegRatio)} EV_EBITDA=${n(fd.evEbitda)}
---
`;
  }

  enrichedPrompt += prompt;
  enrichedPrompt += '\n\nKRITIK KURAL: Her PASS/FAIL/NEUTRAL sonrasi pipe (|) ile aciklama. CRITERIA_START/CRITERIA_END bloklari zorunlu. Her kriter min 2-3 cumle, somut rakamlarla.';
  if (!fd) enrichedPrompt += '\n\nVERI NOTU: Finansal veri alinamadi. Sektor bilgine gore tahmin yap, "veri sinirli" uyarisi ekle ama analizi tamamla.';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role:'user', content:enrichedPrompt }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: `${data.error.type}: ${data.error.message}` });

    let aiResult = data.content?.[0]?.text || '';
    aiResult = aiResult.replace(/TOTAL_SCORE:\s*(\d+)/i, (m, sc) =>
      `TOTAL_SCORE: ${Math.min(7, Math.max(0, parseInt(sc)))}`
    );
    if (fd) {
      const n2 = v => v!=null ? Number(v).toFixed(1) : 'N/A';
      if (fd.peRatio  != null) aiResult = aiResult.replace(/PE:\s*[\d.N\/A]+\s*\|/, `PE: ${n2(fd.peRatio)} |`);
      if (fd.pbRatio  != null) aiResult = aiResult.replace(/PB:\s*[\d.N\/A]+\s*\|/, `PB: ${n2(fd.pbRatio)} |`);
      if (fd.pegRatio != null) aiResult = aiResult.replace(/PEG:\s*[\d.N\/A]+\s*\|/, `PEG: ${n2(fd.pegRatio)} |`);
      if (fd.evEbitda != null) aiResult = aiResult.replace(/EV_EBITDA:\s*[\d.N\/A]+\s*\|/, `EV_EBITDA: ${n2(fd.evEbitda)} |`);
    }

    console.log(`OK ${yahooTicker} | ${fd?.dataSource} | PE=${fd?.peRatio} PB=${fd?.pbRatio} ROE=${fd?.roe} | len=${aiResult.length}`);
    return res.status(200).json({ result: aiResult, financialData: fd, peers: fd?.peers || [] });

  } catch(err) {
    console.error('Analyze hatasi:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
