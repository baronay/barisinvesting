// /api/analyze.js — Barış Investing
// Veri Motoru: Yahoo Finance (v7 quote + v10 quoteSummary + balanceSheetHistory)
// BIST Fallback: Ham bilanço verisiyle PD/DD ve ROE formül hesabı
// Son Çare: BIST site scraping (İş Yatırım / BigPara)

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

// ── YAHOO CRUMB ──────────────────────────────────────────────────
let _crumb = null, _cookie = null, _crumbTs = 0;
const CRUMB_TTL = 55 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function getYahooCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  try {
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookieVal = setCookie.split(';')[0] || '';
    if (!cookieVal) return { crumb: null, cookie: null };
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookieVal, 'Accept': 'text/plain',
                 'Referer': 'https://finance.yahoo.com/', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (r2.ok) {
      const txt = await r2.text();
      if (txt && txt.length > 0) { _crumb = txt.trim(); _cookie = cookieVal; _crumbTs = Date.now(); }
    }
  } catch(e) { console.log('Crumb failed:', e.message); }
  return { crumb: _crumb, cookie: _cookie };
}

// ── USD/TRY KUR TAHMİNİ ──────────────────────────────────────────
// Yahoo BIST bilançolarını bazen USD bazında saklar (özellikle büyük şirketler).
// marketCap her zaman TRY bazında doğru geldiğinden onu referans kullanıyoruz.
// Güncel kuru API'den çekmek yerine: marketCap / (price * shares) ile tespit ediyoruz.
// Fallback: 38 TRY/USD (konservatif tahmini, gerçek ~40-42 arası)
const APPROX_USD_TRY = 38;

// ── DEĞER BİRİMİ TESPİT MOTORU ───────────────────────────────────
// val: test edilen değer
// mktCap: TRY bazında piyasa değeri (referans)
// minRatio / maxRatio: "makul" oran aralığı
// label: log için
function detectAndNormalize(val, mktCap, minRatio, maxRatio, label) {
  if (val == null || mktCap == null || mktCap <= 0) return val;
  const ratio = Math.abs(val) / mktCap;

  console.log(`[Birim Tespit] ${label}: val=${val.toExponential(2)} mktCap=${mktCap.toExponential(2)} ratio=${ratio.toFixed(4)} (beklenen: ${minRatio}–${maxRatio})`);

  if (ratio >= minRatio && ratio <= maxRatio) {
    // Makul aralıkta — değiştirme
    return val;
  }

  if (ratio < minRatio) {
    // Çok küçük — USD olabilir, TRY'ye çevir
    const asTRY = val * APPROX_USD_TRY;
    const ratioTRY = Math.abs(asTRY) / mktCap;
    if (ratioTRY >= minRatio && ratioTRY <= maxRatio) {
      console.log(`[Birim] ${label}: USD→TRY ×${APPROX_USD_TRY}: ${val.toExponential(2)} → ${asTRY.toExponential(2)}`);
      return asTRY;
    }
    // Belki binlik (bin TL → USD olarak yanlış yüklenmiş)
    const asTRY_k = val * 1000;
    const ratioK = Math.abs(asTRY_k) / mktCap;
    if (ratioK >= minRatio && ratioK <= maxRatio) {
      console.log(`[Birim] ${label}: ×1000: ${val.toExponential(2)} → ${asTRY_k.toExponential(2)}`);
      return asTRY_k;
    }
    // Hem ×1000 hem USD
    const asTRY_kU = val * 1000 * APPROX_USD_TRY;
    const ratioKU = Math.abs(asTRY_kU) / mktCap;
    if (ratioKU >= minRatio && ratioKU <= maxRatio) {
      console.log(`[Birim] ${label}: ×1000×USD: ${val.toExponential(2)} → ${asTRY_kU.toExponential(2)}`);
      return asTRY_kU;
    }
    console.log(`[Birim] ${label}: düzeltilemedi (ratio=${ratio.toFixed(6)} çok küçük)`);
    return val; // en azından ham değeri döndür
  }

  if (ratio > maxRatio) {
    // Çok büyük — 1000'e böl (bin TL bazında gelmiş)
    const div1k = val / 1000;
    const ratio1k = Math.abs(div1k) / mktCap;
    if (ratio1k >= minRatio && ratio1k <= maxRatio) {
      console.log(`[Birim] ${label}: ÷1000: ${val.toExponential(2)} → ${div1k.toExponential(2)}`);
      return div1k;
    }
    const div1m = val / 1e6;
    const ratio1m = Math.abs(div1m) / mktCap;
    if (ratio1m >= minRatio && ratio1m <= maxRatio) {
      console.log(`[Birim] ${label}: ÷1M: ${val.toExponential(2)} → ${div1m.toExponential(2)}`);
      return div1m;
    }
    console.log(`[Birim] ${label}: düzeltilemedi (ratio=${ratio.toFixed(2)} çok büyük)`);
    return val;
  }

  return val;
}

// ── BİRİM NORMALİZASYON ─────────────────────────────────────────
function normalizeBISTUnits(result) {
  if (!result.marketCap || !result.currentPrice) return result;
  const MC = result.marketCap; // TRY bazında referans

  // Bilanço kalemleri: MC'nin 0.05x ile 200x arası normal
  // (büyük holdinglerin varlıkları MC'nin 10-50 katı olabilir)
  const BALANCE_MIN = 0.001, BALANCE_MAX = 500;
  // Nakit akış kalemleri: MC'nin 0.001x ile 10x arası normal
  const CASH_MIN = 0.0001, CASH_MAX = 20;

  // Bilanço
  result.totalAssets      = detectAndNormalize(result.totalAssets,      MC, BALANCE_MIN, BALANCE_MAX, 'Assets');
  result.totalLiabilities = detectAndNormalize(result.totalLiabilities, MC, BALANCE_MIN, BALANCE_MAX, 'Liabilities');
  // computedEquity (totalStockholderEquity) ayrıca normalize et — bu kritik!
  if (result.computedEquity != null) {
    result.computedEquity = detectAndNormalize(result.computedEquity, MC, BALANCE_MIN, BALANCE_MAX, 'StockholderEquity');
  }
  // Nakit akış
  result.freeCashflow      = detectAndNormalize(result.freeCashflow,      MC, CASH_MIN, CASH_MAX, 'FCF');
  result.operatingCashflow = detectAndNormalize(result.operatingCashflow, MC, CASH_MIN, CASH_MAX, 'OpCF');
  result.totalCash         = detectAndNormalize(result.totalCash,         MC, CASH_MIN, CASH_MAX, 'Cash');
  result.totalDebt         = detectAndNormalize(result.totalDebt,         MC, CASH_MIN, CASH_MAX, 'Debt');
  result.netIncome         = detectAndNormalize(result.netIncome,         MC, CASH_MIN, CASH_MAX, 'NetIncome');

  return result;
}

// ── FORMÜL BAZLI PD/DD ve ROE ─────────────────────────────────────
// Ham bilanço: Özsermaye = Varlıklar - Yükümlülükler
// PD/DD = Piyasa Değeri / Özsermaye   ← BIST için her zaman formül
// ROE   = Net Kâr / Özsermaye
function computeFromRawData(result, isBIST = false) {
  let equity = null;
  let equitySource = '';

  // 1. Doğrudan özsermaye (totalStockholderEquity) — NORMALIZE EDİLMİŞ olması şart
  if (result.computedEquity != null && result.computedEquity > 0) {
    equity = result.computedEquity;
    equitySource = 'totalStockholderEquity';
    console.log(`[Equity] Doğrudan özsermaye: ${equity.toExponential(3)}`);
  }

  // 2. Varlıklar - Yükümlülükler
  if (!equity && result.totalAssets != null && result.totalLiabilities != null) {
    const calc = result.totalAssets - result.totalLiabilities;
    if (calc > 0) {
      equity = calc;
      result.computedEquity = equity;
      equitySource = 'assets-liabilities';
      console.log(`[Equity] Assets(${result.totalAssets.toExponential(3)}) - Liab(${result.totalLiabilities.toExponential(3)}) = ${equity.toExponential(3)}`);
    } else {
      console.log(`[Equity] Negatif özsermaye: ${calc.toExponential(3)} — muhtemelen birim hatası`);
      // Birim hatası ihtimali — assets normalizasyonu yanlış gitmişse tekrar dene
      // totalAssets × 38 (USD gelmiş) ile
      if (result.totalAssets && result.totalLiabilities) {
        const calcUSD = (result.totalAssets * APPROX_USD_TRY) - (result.totalLiabilities * APPROX_USD_TRY);
        if (calcUSD > 0 && result.marketCap) {
          const pbTest = result.marketCap / calcUSD;
          if (pbTest > 0.05 && pbTest < 50) {
            equity = calcUSD;
            result.computedEquity = equity;
            equitySource = 'assets-liabilities-USD×kur';
            console.log(`[Equity] USD düzeltme: ${equity.toExponential(3)}`);
          }
        }
      }
    }
  }

  // ── DEBUG: kritik değerleri her zaman logla ──
  console.log(`[DEBUG PD/DD] marketCap=${result.marketCap?.toExponential(3)} equity=${equity?.toExponential(3)} equitySrc=${equitySource} MC/EQ=${equity ? (result.marketCap/equity).toFixed(3) : 'N/A'}`);

  if (!equity || equity <= 0 || !result.marketCap) {
    console.log('[PD/DD] Özsermaye bulunamadı, hesaplama atlandı');
    return result;
  }

  // ── PD/DD ──
  if (isBIST) {
    const pbCalc = result.marketCap / equity;
    console.log(`[PD/DD] Ham hesap: MC=${result.marketCap.toExponential(3)} / EQ=${equity.toExponential(3)} = ${pbCalc.toFixed(3)}`);

    // BIST için makul aralık: 0.1 – 20
    if (pbCalc > 0.1 && pbCalc < 20) {
      result.pbRatio  = parseFloat(pbCalc.toFixed(2));
      result.pbSource = `formül (${equitySource})`;
      console.log(`[PD/DD] ✓ ${result.pbRatio} — makul aralıkta`);
    } else if (pbCalc >= 20 && pbCalc < 1000) {
      // Büyük ihtimalle özsermaye USD, MC TRY → özsermayeyi TRY'ye çevir
      const equityTRY = equity * APPROX_USD_TRY;
      const pbTRY = result.marketCap / equityTRY;
      console.log(`[PD/DD] Kur düzeltme denemesi: EQ×${APPROX_USD_TRY}=${equityTRY.toExponential(3)} → PD/DD=${pbTRY.toFixed(3)}`);
      if (pbTRY > 0.1 && pbTRY < 20) {
        result.pbRatio  = parseFloat(pbTRY.toFixed(2));
        result.computedEquity = equityTRY;
        result.pbSource = `formül-kur (${equitySource}×${APPROX_USD_TRY})`;
        console.log(`[PD/DD] ✓ ${result.pbRatio} — kur düzeltmesiyle makul`);
      } else {
        // Özsermaye 1000 ile çarpılmış mı dene (bin TL)
        const equity1k = equity * 1000;
        const pb1k = result.marketCap / equity1k;
        console.log(`[PD/DD] ×1000 denemesi: EQ×1000=${equity1k.toExponential(3)} → PD/DD=${pb1k.toFixed(3)}`);
        if (pb1k > 0.1 && pb1k < 20) {
          result.pbRatio  = parseFloat(pb1k.toFixed(2));
          result.computedEquity = equity1k;
          result.pbSource = `formül-1k (${equitySource}×1000)`;
          console.log(`[PD/DD] ✓ ${result.pbRatio} — ×1000 düzeltmesiyle makul`);
        } else {
          result.pbRatio  = null;
          result.pbSource = 'hesaplanamadi';
          console.log(`[PD/DD] ✗ Tüm denemeler başarısız. pbCalc=${pbCalc.toFixed(2)} pbTRY=${pbTRY.toFixed(2)} pb1k=${pb1k.toFixed(2)}`);
        }
      }
    } else {
      result.pbRatio  = null;
      result.pbSource = 'hesaplanamadi';
      console.log(`[PD/DD] ✗ Aralık dışı: ${pbCalc.toFixed(3)}`);
    }
  } else {
    const pbBad = result.pbRatio == null || result.pbRatio <= 0 || result.pbRatio > 30;
    if (pbBad) {
      result.pbRatio  = parseFloat((result.marketCap / equity).toFixed(2));
      result.pbSource = 'formül';
    }
  }

  // ── ROE ──
  const roeBad = result.roe == null || result.roe === 0;
  if (roeBad && result.netIncome != null) {
    const roeCalc = result.netIncome / equity;
    if (Math.abs(roeCalc) <= 3) { // sanity: max ±300%
      result.roe       = parseFloat(roeCalc.toFixed(4));
      result.roeSource = `formül (${equitySource})`;
      console.log(`[ROE] %${(result.roe*100).toFixed(1)}`);
    } else {
      console.log(`[ROE] Aralık dışı: ${(roeCalc*100).toFixed(1)}% — atlandı`);
    }
  }

  // ── Borç/Özsermaye ──
  if (!result.debtToEquity && result.totalDebt && equity > 0) {
    result.debtToEquity = parseFloat(((result.totalDebt / equity) * 100).toFixed(1));
  }

  return result;
}

// ── BIST SITE SCRAPING (Son Çare) ────────────────────────────────
async function scrapeBISTFallback(ticker) {
  const out = { peRatio: null, pbRatio: null, roe: null, source: null };

  // Deneme 1: İş Yatırım
  try {
    const url = `https://www.isyatirim.com.tr/analiz-ve-bulten/hisse/${ticker}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'tr-TR,tr;q=0.9' },
      signal: AbortSignal.timeout(6000)
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

  // Deneme 2: BigPara
  try {
    const url = `https://bigpara.hurriyet.com.tr/hisse/${ticker.toLowerCase()}/hisse-senedi/`;
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'tr-TR,tr' },
      signal: AbortSignal.timeout(6000)
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

  console.log('Tüm BIST fallback başarısız');
  return out;
}

// ── ANA VERİ ÇEKME ──────────────────────────────────────────────
async function fetchYahooData(yahooTicker) {
  const cacheKey = `yahoo:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) { console.log(`Cache hit: ${yahooTicker}`); return cached; }

  const { crumb, cookie } = await getYahooCrumb();
  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const isBIST = yahooTicker.endsWith('.IS');

  const makeHeaders = () => ({
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
    ...(cookie ? { 'Cookie': cookie } : {}),
  });

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
    // Ham bilanço (BIST formül hesabı için)
    totalAssets: null, totalLiabilities: null, netIncome: null,
    computedEquity: null, pbSource: null, roeSource: null,
    peers: [], dataSource: 'Yahoo',
  };

  // ── 1. v7 quote ──
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
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      if (!q?.regularMarketPrice) continue;

      result.shortName         = q.shortName  ?? q.longName ?? null;
      result.currentPrice      = q.regularMarketPrice ?? null;
      result.currency          = q.currency ?? result.currency;
      result.marketCap         = q.marketCap ?? null;
      result.fiftyTwoWeekLow   = q.fiftyTwoWeekLow ?? null;
      result.fiftyTwoWeekHigh  = q.fiftyTwoWeekHigh ?? null;
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
      console.log(`v7 OK: price=${result.currentPrice} pe=${result.peRatio} pb=${result.pbRatio} roe=${result.roe}`);
      break;
    } catch(e) { console.log(`v7 error: ${e.message}`); }
  }

  // ── 2. v10 quoteSummary + ham bilanço ──
  // BIST için her zaman balanceSheetHistory + incomeStatementHistory çekiyoruz
  const needsMore = !result.roe || !result.grossMargin || !result.pbRatio || !result.totalDebt || isBIST;
  if (needsMore) {
    const modules = isBIST
      ? 'financialData,defaultKeyStatistics,summaryDetail,assetProfile,balanceSheetHistory,incomeStatementHistory'
      : 'financialData,defaultKeyStatistics,summaryDetail,assetProfile';

    for (const base of ['query2', 'query1']) {
      try {
        const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}${cs}`;
        const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(10000) });
        if (!r.ok) continue;
        const j = await r.json();
        const raw = j?.quoteSummary?.result?.[0];
        if (!raw) continue;

        const fd = raw.financialData       || {};
        const ks = raw.defaultKeyStatistics || {};
        const sd = raw.summaryDetail        || {};
        const ap = raw.assetProfile         || {};
        const f  = v => v?.raw ?? null;

        if (!result.peRatio)            result.peRatio    = f(sd.trailingPE) ?? f(ks.trailingPE);
        if (!result.forwardPE)          result.forwardPE  = f(sd.forwardPE)  ?? f(ks.forwardPE);
        // BIST: Yahoo'nun hazır priceToBook değerini çekme — formülle hesaplayacağız
        if (!isBIST && !result.pbRatio) result.pbRatio    = f(ks.priceToBook);

        // BIST için Yahoo trailingPE güvenilmez (USD/TRY karışıklığı)
        // Anormal PE → null yap, sonradan MarketCap/NetIncome ile hesaplanacak
        if (isBIST && result.peRatio != null) {
          if (result.peRatio <= 0 || result.peRatio > 200) {
            console.log(`[BIST] Yahoo PE=${result.peRatio} anormal → null, formülle hesaplanacak`);
            result.peRatio = null;
          }
        }

        // trailingEps — BIST için PE hesaplamak üzere sakla
        const trailingEps = f(ks.trailingEps);
        if (trailingEps && isBIST) result._trailingEps = trailingEps;
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
        if (!result.numberOfAnalystOpinions) result.numberOfAnalystOpinions = f(ks.numberOfAnalystOpinions);
        result.sector   = ap.sector   ?? result.sector;
        result.industry = ap.industry ?? result.industry;
        result.website  = ap.website  ?? result.website;

        // ── HAM BİLANÇO (BIST için kritik) ──
        if (raw.balanceSheetHistory) {
          const sheets = raw.balanceSheetHistory.balanceSheetStatements || [];
          if (sheets.length > 0) {
            const lat = sheets[0]; // en güncel dönem
            const fb  = v => v?.raw ?? null;
            const ta = fb(lat.totalAssets);
            const tl = fb(lat.totalLiab);
            const se = fb(lat.totalStockholderEquity);
            if (ta != null) result.totalAssets      = ta;
            if (tl != null) result.totalLiabilities = tl;
            if (se != null) {
              result.computedEquity = se; // normalize edilmemiş ham değer — BIST pipeline'da normalize edilecek
              console.log(`[Bilanço Ham] Assets=${ta?.toExponential(3)} Liab=${tl?.toExponential(3)} StockholderEquity=${se?.toExponential(3)}`);
            }
            // Ham oranı logla — debug için kritik
            if (result.marketCap && se) {
              console.log(`[Ham PD/DD] MC/SE = ${result.marketCap.toExponential(3)} / ${se.toExponential(3)} = ${(result.marketCap/se).toFixed(2)} (normalize öncesi)`);
            }
          }
        }

        // ── GELİR TABLOSU HAM ──
        if (raw.incomeStatementHistory) {
          const stmts = raw.incomeStatementHistory.incomeStatementHistory || [];
          if (stmts.length > 0) {
            const ni = stmts[0].netIncome?.raw ?? null;
            if (ni != null) result.netIncome = ni;
            console.log(`[Gelir] NetIncome=${ni}`);
          }
        }

        console.log(`v10 OK: roe=${result.roe} pb=${result.pbRatio} assets=${result.totalAssets} ni=${result.netIncome}`);
        break;
      } catch(e) { console.log(`v10 error: ${e.message}`); }
    }
  }

  // ── 3. v8 chart — son çare fiyat ──
  if (!result.currentPrice) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d${cs}`;
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        const meta = j?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          result.currentPrice     = meta.regularMarketPrice;
          result.currency         = meta.currency || result.currency;
          result.fiftyTwoWeekLow  = result.fiftyTwoWeekLow  ?? meta.fiftyTwoWeekLow;
          result.fiftyTwoWeekHigh = result.fiftyTwoWeekHigh ?? meta.fiftyTwoWeekHigh;
        }
      }
    } catch {}
  }

  if (!result.currentPrice) throw new Error(`Yahoo veri yok: ${yahooTicker}`);

  // ── BIST DÜZELTME PIPELINE ────────────────────────────────────
  if (isBIST) {

    // ADIM 0: Çoklu kaynak rasyo API'sini çağır (Google Finance öncelikli)
    // Bu endpoint Google Finance + İşYatırım + BigPara + Yahoo normalize sıralamasıyla çalışır
    let bistRatios = null;
    try {
      // Vercel'de kendi endpoint'imizi çağırıyoruz (relative URL)
      const bistUrl = `${process.env.VERCEL_URL
        ? 'https://' + process.env.VERCEL_URL
        : 'http://localhost:3000'}/api/bist-ratios?ticker=${yahooTicker.replace('.IS', '')}`;

      const bistRes = await fetch(bistUrl, {
        signal: AbortSignal.timeout(12000), // çoklu kaynak — daha uzun timeout
        headers: { 'Accept': 'application/json' }
      });
      if (bistRes.ok) {
        bistRatios = await bistRes.json();
        console.log(`[BIST API] Rasyo sonuçları: PE=${bistRatios.pe}(${bistRatios.source_pe}) PD/DD=${bistRatios.pb}(${bistRatios.source_pb})`);
      }
    } catch(e) {
      console.log(`[BIST API] Çağrı başarısız: ${e.message} — fallback pipeline devam ediyor`);
    }

    // BIST API'den gelen değerleri uygula
    if (bistRatios) {
      // PE — Google > İşYat > BigPara > Yahoo formül sıralaması
      if (bistRatios.pe != null && bistRatios.pe > 0.3 && bistRatios.pe < 200) {
        result.peRatio  = bistRatios.pe;
        result.peSource = bistRatios.source_pe;
        console.log(`[BIST API] PE override: ${result.peRatio} (${result.peSource})`);
      }
      // PB — her zaman BIST API'yi tercih et
      if (bistRatios.pb != null && bistRatios.pb > 0.03 && bistRatios.pb < 30) {
        result.pbRatio  = bistRatios.pb;
        result.pbSource = bistRatios.source_pb;
        console.log(`[BIST API] PD/DD override: ${result.pbRatio} (${result.pbSource})`);
      }
      // PEG — Google Finance'dan geliyorsa kullan
      if (bistRatios.peg != null && bistRatios.peg > 0.01 && bistRatios.peg < 20) {
        result.pegRatio  = bistRatios.peg;
        result.pegSource = bistRatios.source_peg;
        console.log(`[BIST API] PEG override: ${result.pegRatio} (${result.pegSource})`);
      }
      // ROE
      if (bistRatios.roe != null && Math.abs(bistRatios.roe) < 3) {
        if (!result.roe) result.roe = bistRatios.roe;
      }
      // MarketCap
      if (bistRatios.marketCap && !result.marketCap) {
        result.marketCap = bistRatios.marketCap;
      }
      // Debug bilgisini kaydet
      result.bistRatiosDebug = bistRatios.debug;
    }

    // ADIM 1: Yahoo'nun hazır pb değerini sıfırla — formülden hesaplanacak
    const yahooPB = result.pbRatio;
    if (!bistRatios?.pb) {
      // BIST API'den pb gelmediyse Yahoo'yu da sıfırla
      result.pbRatio = null;
      if (yahooPB) console.log(`[BIST] Yahoo pb=${yahooPB?.toFixed(2)} yoksayıldı`);
    }

    // ADIM 2: Birim normalizasyonu
    result = normalizeBISTUnits(result);

    // ADIM 3: Anormal PE temizle
    if (result.peRatio && (result.peRatio > 200 || result.peRatio < 0)) {
      console.log(`[BIST] PE anormal: ${result.peRatio} → null`); result.peRatio = null;
    }
    if (result.roe && Math.abs(result.roe) > 5) {
      console.log(`[BIST] ROE anormal: ${result.roe} → ${result.roe/100}`);
      result.roe = result.roe / 100;
    }

    // ADIM 4: Ham bilanço verisiyle PD/DD ve ROE formül hesabı (isBIST=true)
    // BIST API'den pb geldiyse formül override etmesin
    if (!result.pbRatio) {
      result = computeFromRawData(result, true);
    } else {
      // Sadece ROE ve D/E için formülü çalıştır
      result = computeFromRawData(result, false);
    }

    // ADIM 5: Hâlâ kritik eksik varsa eski scraping dene
    if (result.pbRatio == null || result.peRatio == null) {
      console.log('[BIST] Kritik veri eksik → legacy scraping...');
      const t = yahooTicker.replace('.IS', '');
      const sc = await scrapeBISTFallback(t);
      if (sc.source) {
        if (result.peRatio == null && sc.peRatio) result.peRatio = sc.peRatio;
        if (result.pbRatio == null && sc.pbRatio) { result.pbRatio = sc.pbRatio; result.pbSource = sc.source; }
        if (result.roe     == null && sc.roe)     { result.roe     = sc.roe;     result.roeSource = sc.source; }
        result.dataSource = sc.source;
      }
    }

    // ADIM 6: PE hâlâ null → MarketCap / NetIncome formülü (son çare ama güvenilir)
    // THYAO örneği: MC=408.48B TRY, NetIncome=~3.4B USD × 38 = 129.2B TRY → PE=3.15 ✓
    if (result.peRatio == null && result.marketCap && result.netIncome) {
      const niNorm = detectAndNormalize(result.netIncome, result.marketCap, 0.0001, 10, 'NetIncome_PE');
      if (niNorm > 0) {
        const peCalc = result.marketCap / niNorm;
        if (peCalc > 0.5 && peCalc < 200) {
          result.peRatio  = parseFloat(peCalc.toFixed(2));
          result.peSource = 'formül(MC/NI)';
          console.log(`[BIST PE Formül] MC=${result.marketCap.toExponential(3)} / NI=${niNorm.toExponential(3)} = ${result.peRatio}`);
        }
      }
    }

    // ADIM 7: EPS üzerinden PE — Yahoo trailingEps bazen doğru gelir
    if (result.peRatio == null && result.currentPrice && result._trailingEps) {
      const eps = result._trailingEps;
      // EPS TRY bazında mı USD bazında mı kontrol et
      const epsNorm = Math.abs(eps) < 10 ? eps * APPROX_USD_TRY : eps; // küçükse USD
      if (epsNorm > 0 && result.currentPrice > 0) {
        const peEps = result.currentPrice / epsNorm;
        if (peEps > 0.5 && peEps < 200) {
          result.peRatio  = parseFloat(peEps.toFixed(2));
          result.peSource = 'formül(Fiyat/EPS)';
          console.log(`[BIST PE EPS] Fiyat=${result.currentPrice} / EPS=${epsNorm.toFixed(2)} = ${result.peRatio}`);
        }
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
// ── IP bazlı rate limit (in-memory, Vercel serverless için yeterli) ──
const _ipHits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const window = 60 * 1000; // 1 dakika
  const max = 10;           // dakikada max 10 istek
  const hits = (_ipHits.get(ip) || []).filter(t => now - t < window);
  hits.push(now);
  _ipHits.set(ip, hits);
  if (_ipHits.size > 5000) { // bellek temizle
    const old = [..._ipHits.keys()].slice(0, 1000);
    old.forEach(k => _ipHits.delete(k));
  }
  return hits.length <= max;
}

export default async function handler(req, res) {
  // CORS — sadece kendi domain
  const origin = req.headers.origin || '';
  const isAllowed = !origin // same-origin (boş origin) — her zaman izin ver
    || origin.includes('barisinvesting.com')
    || origin.includes('vercel.app') // preview deployments
    || origin.includes('localhost');  // local dev
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? (origin || '*') : 'https://www.barisinvesting.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // IP rate limit
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Çok fazla istek. Lütfen bekleyin.' });
  }

  const { ticker, exchange, email, framework } = req.body || {};

  // Ticker sanitize — sadece harf/rakam/nokta, max 12 karakter
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });
  const cleanTicker = String(ticker).toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
  if (!cleanTicker) return res.status(400).json({ error: 'Geçersiz ticker' });

  // Framework doğrula
  const validFrameworks = ['buffett', 'lynch', 'dalio', 'graham'];
  const fw = validFrameworks.includes(framework) ? framework : 'buffett';
  const exLabel = exchange === 'BIST' ? 'BIST' : exchange === 'NYSE' ? 'NYSE' : 'NASDAQ';

  // Tam format prompt server-side üretiliyor
  const PROMPTS = {
    buffett: (t, ex) => `Warren Buffett felsefesiyle ${ex} borsasındaki "${t}" hissesini analiz et.

TICKER: ${t}
TOTAL_SCORE: X
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [2-3 cümle]
RISK: [en kritik risk]

MULTIPLES_START
PE: [sayı] | [ucuz/adil/pahalı]
PB: [sayı] | [ucuz/adil/pahalı]
EV_EBITDA: [sayı] | [ucuz/adil/pahalı]
PEG: [sayı] | [ucuz/adil/pahalı]
RSI: [30-70] | [ASIRI_SATIM|NÖTR|ASIRI_ALIM]
PRICE_52W: [düşük]-[yüksek] | [mevcut]
ANALYST: [AL%]-[TUT%]-[SAT%] | [konsensüs] | [hedef] | [upside%]
MULTIPLES_END

CRITERIA_START
ROE: PASS|FAIL|NEUTRAL | [açıklama]
PRICING: PASS|FAIL|NEUTRAL | [açıklama]
DOLLAR: PASS|FAIL|NEUTRAL | [açıklama]
MOAT: PASS|FAIL|NEUTRAL | [açıklama]
FCF: PASS|FAIL|NEUTRAL | [açıklama]
MGMT: PASS|FAIL|NEUTRAL | [açıklama]
VALUATION: PASS|FAIL|NEUTRAL | [açıklama]
CRITERIA_END`,

    lynch: (t, ex) => `Peter Lynch felsefesiyle ${ex} borsasındaki "${t}" hissesini analiz et.

TICKER: ${t}
TOTAL_SCORE: X
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [2-3 cümle Lynch perspektifinden]
RISK: [en kritik risk]

MULTIPLES_START
PE: [sayı] | [ucuz/adil/pahalı]
PB: [sayı] | [ucuz/adil/pahalı]
EV_EBITDA: [sayı] | [ucuz/adil/pahalı]
PEG: [sayı] | [ucuz/adil/pahalı]
RSI: [30-70] | [ASIRI_SATIM|NÖTR|ASIRI_ALIM]
PRICE_52W: [düşük]-[yüksek] | [mevcut]
ANALYST: [AL%]-[TUT%]-[SAT%] | [konsensüs] | [hedef] | [upside%]
MULTIPLES_END

CRITERIA_START
STORY: PASS|FAIL|NEUTRAL | [açıklama]
GROWTH: PASS|FAIL|NEUTRAL | [açıklama]
BALANCE: PASS|FAIL|NEUTRAL | [açıklama]
INVENTORY: PASS|FAIL|NEUTRAL | [açıklama]
PEGCRIT: PASS|FAIL|NEUTRAL | [açıklama]
INSTITUTION: PASS|FAIL|NEUTRAL | [açıklama]
INSIDER: PASS|FAIL|NEUTRAL | [açıklama]
CRITERIA_END`,

    graham: (t, ex) => `Benjamin Graham değer yatırımı felsefesiyle ${ex} borsasındaki "${t}" hissesini analiz et.

TICKER: ${t}
TOTAL_SCORE: X
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [2-3 cümle Graham perspektifinden]
RISK: [en kritik risk]

MULTIPLES_START
PE: [sayı] | [ucuz/adil/pahalı]
PB: [sayı] | [ucuz/adil/pahalı]
EV_EBITDA: [sayı] | [ucuz/adil/pahalı]
PEG: [sayı] | [ucuz/adil/pahalı]
RSI: [30-70] | [ASIRI_SATIM|NÖTR|ASIRI_ALIM]
PRICE_52W: [düşük]-[yüksek] | [mevcut]
ANALYST: [AL%]-[TUT%]-[SAT%] | [konsensüs] | [hedef] | [upside%]
MULTIPLES_END

CRITERIA_START
MARGIN: PASS|FAIL|NEUTRAL | [açıklama]
DEBT: PASS|FAIL|NEUTRAL | [açıklama]
CURRENT: PASS|FAIL|NEUTRAL | [açıklama]
EARNINGS: PASS|FAIL|NEUTRAL | [açıklama]
DIVIDEND: PASS|FAIL|NEUTRAL | [açıklama]
PE_G: PASS|FAIL|NEUTRAL | [açıklama]
PB_G: PASS|FAIL|NEUTRAL | [açıklama]
CRITERIA_END\`,

    dalio: (t, ex) => \`Ray Dalio makro perspektifiyle ${ex} borsasındaki "${t}" hissesini analiz et. Borç döngüsü, para politikası, enflasyon ve uzun vadeli makro faktörler çerçevesinde değerlendir.

TICKER: ${t}
TOTAL_SCORE: X
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [2-3 cümle Dalio makro perspektifinden]
RISK: [en kritik makro risk]

MULTIPLES_START
PE: [sayı] | [ucuz/adil/pahalı]
PB: [sayı] | [ucuz/adil/pahalı]
EV_EBITDA: [sayı] | [ucuz/adil/pahalı]
PEG: [sayı] | [ucuz/adil/pahalı]
RSI: [30-70] | [ASIRI_SATIM|NÖTR|ASIRI_ALIM]
PRICE_52W: [düşük]-[yüksek] | [mevcut]
ANALYST: [AL%]-[TUT%]-[SAT%] | [konsensüs] | [hedef] | [upside%]
MULTIPLES_END

CRITERIA_START
PRODGROWTH: PASS|FAIL|NEUTRAL | [açıklama]
DEBTCYCLE: PASS|FAIL|NEUTRAL | [açıklama]
MONETARY: PASS|FAIL|NEUTRAL | [açıklama]
CURRENCY: PASS|FAIL|NEUTRAL | [açıklama]
INFLATION: PASS|FAIL|NEUTRAL | [açıklama]
SYSTEMIC: PASS|FAIL|NEUTRAL | [açıklama]
LONGTERM: PASS|FAIL|NEUTRAL | [açıklama]
CRITERIA_END`
  };
  const prompt = PROMPTS[fw](cleanTicker, exLabel);


  // Server-side kredi kontrolü
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const em = email ? String(email).toLowerCase().trim() : null;
  const isAdmin = em && ADMIN_EMAIL && em === ADMIN_EMAIL;

  if (SB_URL && SB_KEY && em && !isAdmin) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/users?email=eq.${encodeURIComponent(em)}&select=credits,is_admin`, {
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
      });
      if (r.ok) {
        const rows = await r.json();
        const user = rows?.[0];
        if (user && !user.is_admin && (user.credits || 0) <= 0) {
          return res.status(403).json({ error: 'Analiz hakkınız doldu.' });
        }
      }
    } catch(e) { console.log('[Kredi kontrol] hata:', e.message); }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  const yahooTicker = exchange === 'BIST' ? `${cleanTicker}.IS` : cleanTicker;
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

GRAHAM KURALLARI:
- Güvenlik Marjı = İçsel değer hesapla, %30 altında al.
- Borç/Özsermaye < 0.5, Cari Oran > 2 olmalı.
- F/K < 15, F/DD < 1.5 Graham sınırları.
- Net-net: Net dönen varlıklar > Piyasa değeri ise cazip.
- Son 5 yıl kesintisiz kazanç ve temettü şartı.

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

    const pbNote  = fd.pbSource  && fd.pbSource  !== 'Yahoo' ? ` [${fd.pbSource}: MC/Özsermaye formülü]` : '';
    const roeNote = fd.roeSource && fd.roeSource !== 'Yahoo' ? ` [${fd.roeSource}: NetKar/Özsermaye formülü]` : '';

    let warnings = '';
    if (isBIST && fd.computedEquity!=null) warnings += `BİLGİ: Özsermaye hesaplandı = ${big(fd.computedEquity)} TRY (Varlıklar - Borçlar)\n`;
    if (isBIST && fd.peRatio==null)  warnings += 'NOT: F/K güvenilmez — sektör ortalaması kullan.\n';
    if (isBIST && fd.pbRatio==null)  warnings += 'NOT: F/DD hesaplanamadı — ROE ve piyasa değeri üzerinden değerlendir.\n';
    if (fd.dataSource !== 'Yahoo')   warnings += `VERİ KAYNAĞI: ${fd.dataSource} (Yahoo yedeği)\n`;

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
