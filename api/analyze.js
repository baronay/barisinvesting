// /api/analyze.js — Barış Investing
// Veri Motoru: Yahoo Finance (v7 quote + v10 quoteSummary + balanceSheetHistory)
// BIST Fallback: Ham bilanço verisiyle PD/DD ve ROE formül hesabı
// Son Çare: BIST site scraping (İş Yatırım / BigPara)

// Geliştirme izleme logları — varsayılan kapalı, DEBUG_LOGS=1 ile açılır.
const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
function dlog(...args) { if (DEBUG_LOGS) console.log(...args); }

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
  } catch(e) { dlog('Crumb failed:', e.message); }
  return { crumb: _crumb, cookie: _cookie };
}

// ── USD/TRY KUR TAHMİNİ ──────────────────────────────────────────
// Yahoo BIST bilançolarını bazen USD bazında saklar (özellikle büyük şirketler).
// marketCap her zaman TRY bazında doğru geldiğinden onu referans kullanıyoruz.
// Güncel kuru API'den çekmek yerine: marketCap / (price * shares) ile tespit ediyoruz.
// USD_TRY env değişkeninden okunur (pipeline/bist_pipeline.py ile aynı yaklaşım), yoksa fallback kullanılır.
const APPROX_USD_TRY = parseFloat(process.env.USD_TRY) || 38;

// ── DEĞER BİRİMİ TESPİT MOTORU ───────────────────────────────────
// val: test edilen değer
// mktCap: TRY bazında piyasa değeri (referans)
// minRatio / maxRatio: "makul" oran aralığı
// label: log için
function detectAndNormalize(val, mktCap, minRatio, maxRatio, label) {
  if (val == null || mktCap == null || mktCap <= 0) return val;
  const ratio = Math.abs(val) / mktCap;

  dlog(`[Birim Tespit] ${label}: val=${val.toExponential(2)} mktCap=${mktCap.toExponential(2)} ratio=${ratio.toFixed(4)} (beklenen: ${minRatio}–${maxRatio})`);

  if (ratio >= minRatio && ratio <= maxRatio) {
    // Makul aralıkta — değiştirme
    return val;
  }

  if (ratio < minRatio) {
    // Çok küçük — USD olabilir, TRY'ye çevir
    const asTRY = val * APPROX_USD_TRY;
    const ratioTRY = Math.abs(asTRY) / mktCap;
    if (ratioTRY >= minRatio && ratioTRY <= maxRatio) {
      dlog(`[Birim] ${label}: USD→TRY ×${APPROX_USD_TRY}: ${val.toExponential(2)} → ${asTRY.toExponential(2)}`);
      return asTRY;
    }
    // Belki binlik (bin TL → USD olarak yanlış yüklenmiş)
    const asTRY_k = val * 1000;
    const ratioK = Math.abs(asTRY_k) / mktCap;
    if (ratioK >= minRatio && ratioK <= maxRatio) {
      dlog(`[Birim] ${label}: ×1000: ${val.toExponential(2)} → ${asTRY_k.toExponential(2)}`);
      return asTRY_k;
    }
    // Hem ×1000 hem USD
    const asTRY_kU = val * 1000 * APPROX_USD_TRY;
    const ratioKU = Math.abs(asTRY_kU) / mktCap;
    if (ratioKU >= minRatio && ratioKU <= maxRatio) {
      dlog(`[Birim] ${label}: ×1000×USD: ${val.toExponential(2)} → ${asTRY_kU.toExponential(2)}`);
      return asTRY_kU;
    }
    dlog(`[Birim] ${label}: düzeltilemedi (ratio=${ratio.toFixed(6)} çok küçük)`);
    return val; // en azından ham değeri döndür
  }

  if (ratio > maxRatio) {
    // Çok büyük — 1000'e böl (bin TL bazında gelmiş)
    const div1k = val / 1000;
    const ratio1k = Math.abs(div1k) / mktCap;
    if (ratio1k >= minRatio && ratio1k <= maxRatio) {
      dlog(`[Birim] ${label}: ÷1000: ${val.toExponential(2)} → ${div1k.toExponential(2)}`);
      return div1k;
    }
    const div1m = val / 1e6;
    const ratio1m = Math.abs(div1m) / mktCap;
    if (ratio1m >= minRatio && ratio1m <= maxRatio) {
      dlog(`[Birim] ${label}: ÷1M: ${val.toExponential(2)} → ${div1m.toExponential(2)}`);
      return div1m;
    }
    dlog(`[Birim] ${label}: düzeltilemedi (ratio=${ratio.toFixed(2)} çok büyük)`);
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
    dlog(`[Equity] Doğrudan özsermaye: ${equity.toExponential(3)}`);
  }

  // 2. Varlıklar - Yükümlülükler
  if (!equity && result.totalAssets != null && result.totalLiabilities != null) {
    const calc = result.totalAssets - result.totalLiabilities;
    if (calc > 0) {
      equity = calc;
      result.computedEquity = equity;
      equitySource = 'assets-liabilities';
      dlog(`[Equity] Assets(${result.totalAssets.toExponential(3)}) - Liab(${result.totalLiabilities.toExponential(3)}) = ${equity.toExponential(3)}`);
    } else {
      dlog(`[Equity] Negatif özsermaye: ${calc.toExponential(3)} — muhtemelen birim hatası`);
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
            dlog(`[Equity] USD düzeltme: ${equity.toExponential(3)}`);
          }
        }
      }
    }
  }

  // ── DEBUG: kritik değerleri her zaman logla ──
  dlog(`[DEBUG PD/DD] marketCap=${result.marketCap?.toExponential(3)} equity=${equity?.toExponential(3)} equitySrc=${equitySource} MC/EQ=${equity ? (result.marketCap/equity).toFixed(3) : 'N/A'}`);

  if (!equity || equity <= 0 || !result.marketCap) {
    dlog('[PD/DD] Özsermaye bulunamadı, hesaplama atlandı');
    return result;
  }

  // ── PD/DD ──
  if (isBIST) {
    const pbCalc = result.marketCap / equity;
    dlog(`[PD/DD] Ham hesap: MC=${result.marketCap.toExponential(3)} / EQ=${equity.toExponential(3)} = ${pbCalc.toFixed(3)}`);

    // BIST için makul aralık: 0.1 – 20
    if (pbCalc > 0.1 && pbCalc < 20) {
      result.pbRatio  = parseFloat(pbCalc.toFixed(2));
      result.pbSource = `formül (${equitySource})`;
      dlog(`[PD/DD] ✓ ${result.pbRatio} — makul aralıkta`);
    } else if (pbCalc >= 20 && pbCalc < 1000) {
      // Büyük ihtimalle özsermaye USD, MC TRY → özsermayeyi TRY'ye çevir
      const equityTRY = equity * APPROX_USD_TRY;
      const pbTRY = result.marketCap / equityTRY;
      dlog(`[PD/DD] Kur düzeltme denemesi: EQ×${APPROX_USD_TRY}=${equityTRY.toExponential(3)} → PD/DD=${pbTRY.toFixed(3)}`);
      if (pbTRY > 0.1 && pbTRY < 20) {
        result.pbRatio  = parseFloat(pbTRY.toFixed(2));
        result.computedEquity = equityTRY;
        result.pbSource = `formül-kur (${equitySource}×${APPROX_USD_TRY})`;
        dlog(`[PD/DD] ✓ ${result.pbRatio} — kur düzeltmesiyle makul`);
      } else {
        // Özsermaye 1000 ile çarpılmış mı dene (bin TL)
        const equity1k = equity * 1000;
        const pb1k = result.marketCap / equity1k;
        dlog(`[PD/DD] ×1000 denemesi: EQ×1000=${equity1k.toExponential(3)} → PD/DD=${pb1k.toFixed(3)}`);
        if (pb1k > 0.1 && pb1k < 20) {
          result.pbRatio  = parseFloat(pb1k.toFixed(2));
          result.computedEquity = equity1k;
          result.pbSource = `formül-1k (${equitySource}×1000)`;
          dlog(`[PD/DD] ✓ ${result.pbRatio} — ×1000 düzeltmesiyle makul`);
        } else {
          result.pbRatio  = null;
          result.pbSource = 'hesaplanamadi';
          dlog(`[PD/DD] ✗ Tüm denemeler başarısız. pbCalc=${pbCalc.toFixed(2)} pbTRY=${pbTRY.toFixed(2)} pb1k=${pb1k.toFixed(2)}`);
        }
      }
    } else {
      result.pbRatio  = null;
      result.pbSource = 'hesaplanamadi';
      dlog(`[PD/DD] ✗ Aralık dışı: ${pbCalc.toFixed(3)}`);
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
      dlog(`[ROE] %${(result.roe*100).toFixed(1)}`);
    } else {
      dlog(`[ROE] Aralık dışı: ${(roeCalc*100).toFixed(1)}% — atlandı`);
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
  } catch(e) { dlog('İş Yatırım scrape:', e.message); }

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
  } catch(e) { dlog('BigPara scrape:', e.message); }

  dlog('Tüm BIST fallback başarısız');
  return out;
}

// ── VERİ DOĞRULAMA KATMANI ────────────────────────────────────────
// Yahoo (veya BIST yedek kaynakları) bazen NaN, Infinity, yanlış tip ya da
// saçma büyüklükte değer döndürebiliyor. Bu katman onları sessizce ayıklar;
// hiçbir koşulda exception fırlatmaz — sadece ilgili alanı null'a çevirir.
const NUMERIC_BOUNDS = {
  currentPrice:            [0.0001, 1e7],
  marketCap:               [0, 1e16],
  fiftyTwoWeekLow:         [0.0001, 1e7],
  fiftyTwoWeekHigh:        [0.0001, 1e7],
  peRatio:                 [-1000, 1000],
  forwardPE:               [-1000, 1000],
  pbRatio:                 [-1000, 1000],
  pegRatio:                [-100, 100],
  evEbitda:                [-1000, 1000],
  grossMargin:             [-10, 10],
  operatingMargin:         [-10, 10],
  profitMargin:            [-10, 10],
  roe:                     [-10, 10],
  roa:                     [-10, 10],
  debtToEquity:            [-100, 1000],
  currentRatio:            [0, 100],
  revenueGrowth:           [-10, 100],
  earningsGrowth:          [-10, 100],
  institutionOwnership:    [0, 1],
  targetMeanPrice:         [0.0001, 1e7],
  numberOfAnalystOpinions: [0, 1000],
  totalAssets:             [0, 1e16],
  totalLiabilities:        [0, 1e16],
  netIncome:               [-1e15, 1e15],
  computedEquity:          [-1e15, 1e15],
  freeCashflow:            [-1e15, 1e15],
  operatingCashflow:       [-1e15, 1e15],
  totalCash:               [0, 1e16],
  totalDebt:               [0, 1e16],
};

const STRING_FIELDS = [
  'currency', 'shortName', 'website', 'sector', 'industry',
  'recommendationKey', 'dataSource', 'pbSource', 'roeSource', 'peSource', 'pegSource',
];

function safeNumOrNull(v, bounds) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;          // NaN / Infinity / -Infinity
  if (bounds && (n < bounds[0] || n > bounds[1])) return null; // mantıksız büyüklük
  return n;
}

// raw: fetchYahooData'nın oluşturduğu ham result nesnesi.
// Dönen: { data: temizlenmiş nesne veya null, warnings: string[] }
function sanitizeFinancialData(raw) {
  const warnings = [];
  if (!raw || typeof raw !== 'object') {
    return { data: null, warnings: ['Yahoo verisi geçersiz formatta döndü (object değil).'] };
  }

  const out = { ...raw };

  for (const [field, bounds] of Object.entries(NUMERIC_BOUNDS)) {
    const original = out[field];
    if (original == null) continue;
    const cleaned = safeNumOrNull(original, bounds);
    if (cleaned == null) warnings.push(`${field} geçersiz/aralık dışı (${original}) → atlandı`);
    out[field] = cleaned;
  }

  for (const field of STRING_FIELDS) {
    if (out[field] != null && typeof out[field] !== 'string') {
      warnings.push(`${field} beklenmeyen tipte (${typeof out[field]}) → atlandı`);
      out[field] = null;
    }
  }

  if (out.peers != null && !Array.isArray(out.peers)) out.peers = [];

  // 52 hafta aralığı ters geldiyse (Yahoo'da nadiren olur) ikisini de güvensiz say
  if (out.fiftyTwoWeekLow != null && out.fiftyTwoWeekHigh != null && out.fiftyTwoWeekLow > out.fiftyTwoWeekHigh) {
    warnings.push('52 haftalık düşük/yüksek aralığı ters görünüyor → ikisi de atlandı');
    out.fiftyTwoWeekLow = null;
    out.fiftyTwoWeekHigh = null;
  }

  // Fiyat olmadan analiz anlamsız — tüm veriyi geçersiz say (üst katman "veri yok" yoluna düşer)
  if (out.currentPrice == null) {
    return { data: null, warnings: [...warnings, 'Geçerli/makul bir fiyat verisi yok.'] };
  }

  return { data: out, warnings };
}

// ── ANA VERİ ÇEKME ──────────────────────────────────────────────
async function fetchYahooData(yahooTicker) {
  const cacheKey = `yahoo:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) { dlog(`Cache hit: ${yahooTicker}`); return cached; }

  const { crumb, cookie } = await getYahooCrumb();
  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const isBIST = yahooTicker.endsWith('.IS');

  // BIST rasyo kaynağımız (kendi /api/bist-ratios uç noktamız) Yahoo'nun
  // sonucuna bağlı değil — bekletmeden hemen başlatıp Yahoo çağrılarıyla
  // PARALEL ilerlemesini sağlıyoruz (önceden sıralıydı, gereksiz gecikme yaratıyordu).
  const bistRatiosPromise = isBIST
    ? fetch(
        `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'http://localhost:3000'}/api/bist-ratios?ticker=${yahooTicker.replace('.IS', '')}`,
        { signal: AbortSignal.timeout(7000), headers: { 'Accept': 'application/json' } }
      )
        .then(r => (r.ok ? r.json() : null))
        .catch(e => { dlog(`[BIST API] Çağrı başarısız: ${e.message} — fallback pipeline devam ediyor`); return null; })
    : null;

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
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(4500) });
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
      dlog(`v7 OK: price=${result.currentPrice} pe=${result.peRatio} pb=${result.pbRatio} roe=${result.roe}`);
      break;
    } catch(e) { dlog(`v7 error: ${e.message}`); }
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
        const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(5500) });
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
            dlog(`[BIST] Yahoo PE=${result.peRatio} anormal → null, formülle hesaplanacak`);
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
              dlog(`[Bilanço Ham] Assets=${ta?.toExponential(3)} Liab=${tl?.toExponential(3)} StockholderEquity=${se?.toExponential(3)}`);
            }
            // Ham oranı logla — debug için kritik
            if (result.marketCap && se) {
              dlog(`[Ham PD/DD] MC/SE = ${result.marketCap.toExponential(3)} / ${se.toExponential(3)} = ${(result.marketCap/se).toFixed(2)} (normalize öncesi)`);
            }
          }
        }

        // ── GELİR TABLOSU HAM ──
        if (raw.incomeStatementHistory) {
          const stmts = raw.incomeStatementHistory.incomeStatementHistory || [];
          if (stmts.length > 0) {
            const ni = stmts[0].netIncome?.raw ?? null;
            if (ni != null) result.netIncome = ni;
            dlog(`[Gelir] NetIncome=${ni}`);
          }
        }

        dlog(`v10 OK: roe=${result.roe} pb=${result.pbRatio} assets=${result.totalAssets} ni=${result.netIncome}`);
        break;
      } catch(e) { dlog(`v10 error: ${e.message}`); }
    }
  }

  // ── 3. v8 chart — son çare fiyat ──
  if (!result.currentPrice) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d${cs}`;
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(3000) });
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

    // ADIM 0: Çoklu kaynak rasyo API'sini bekle — yukarıda Yahoo çağrılarıyla
    // PARALEL başlatılmıştı (bistRatiosPromise), burada sadece sonucu alıyoruz.
    const bistRatios = await bistRatiosPromise;
    if (bistRatios) {
      dlog(`[BIST API] Rasyo sonuçları: PE=${bistRatios.pe}(${bistRatios.source_pe}) PD/DD=${bistRatios.pb}(${bistRatios.source_pb})`);
    }

    // BIST API'den gelen değerleri uygula
    if (bistRatios) {
      // PE — Google > İşYat > BigPara > Yahoo formül sıralaması
      if (bistRatios.pe != null && bistRatios.pe > 0.3 && bistRatios.pe < 200) {
        result.peRatio  = bistRatios.pe;
        result.peSource = bistRatios.source_pe;
        dlog(`[BIST API] PE override: ${result.peRatio} (${result.peSource})`);
      }
      // PB — her zaman BIST API'yi tercih et
      if (bistRatios.pb != null && bistRatios.pb > 0.03 && bistRatios.pb < 30) {
        result.pbRatio  = bistRatios.pb;
        result.pbSource = bistRatios.source_pb;
        dlog(`[BIST API] PD/DD override: ${result.pbRatio} (${result.pbSource})`);
      }
      // PEG — Google Finance'dan geliyorsa kullan
      if (bistRatios.peg != null && bistRatios.peg > 0.01 && bistRatios.peg < 20) {
        result.pegRatio  = bistRatios.peg;
        result.pegSource = bistRatios.source_peg;
        dlog(`[BIST API] PEG override: ${result.pegRatio} (${result.pegSource})`);
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
      if (yahooPB) dlog(`[BIST] Yahoo pb=${yahooPB?.toFixed(2)} yoksayıldı`);
    }

    // ADIM 2: Birim normalizasyonu
    result = normalizeBISTUnits(result);

    // ADIM 3: Anormal PE temizle
    if (result.peRatio && (result.peRatio > 200 || result.peRatio < 0)) {
      dlog(`[BIST] PE anormal: ${result.peRatio} → null`); result.peRatio = null;
    }
    if (result.roe && Math.abs(result.roe) > 5) {
      dlog(`[BIST] ROE anormal: ${result.roe} → ${result.roe/100}`);
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
      dlog('[BIST] Kritik veri eksik → legacy scraping...');
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
          dlog(`[BIST PE Formül] MC=${result.marketCap.toExponential(3)} / NI=${niNorm.toExponential(3)} = ${result.peRatio}`);
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
          dlog(`[BIST PE EPS] Fiyat=${result.currentPrice} / EPS=${epsNorm.toFixed(2)} = ${result.peRatio}`);
        }
      }
    }

    dlog(`[BIST Final] PE=${result.peRatio?.toFixed(2)}(${result.peSource||'?'}) PD/DD=${result.pbRatio?.toFixed(2)}(${result.pbSource}) ROE=${result.roe ? (result.roe*100).toFixed(1)+'%' : 'N/A'}`);
  }

  // Logo
  if (result.website) {
    try {
      const domain = new URL(result.website.startsWith('http') ? result.website : 'https://' + result.website).hostname;
      result.logoUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
    } catch {}
  }

  // ── VERİ DOĞRULAMA ── cache'e veya çağırana asla ham/bozuk veri gitmesin
  const { data: cleanResult, warnings } = sanitizeFinancialData(result);
  if (warnings.length) dlog(`[Veri Doğrulama] ${yahooTicker}: ${warnings.join(' | ')}`);
  if (!cleanResult) {
    throw new Error(`Veri doğrulama başarısız (${yahooTicker}): ${warnings.join('; ') || 'bilinmeyen sebep'}`);
  }
  cleanResult._dataWarnings = warnings;

  setCache(cacheKey, cleanResult);
  return cleanResult;
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
CRITERIA_END`,

    dalio: (t, ex) => `Ray Dalio makro perspektifiyle ${ex} borsasındaki "${t}" hissesini analiz et. Borç döngüsü, para politikası, enflasyon ve uzun vadeli makro faktörler çerçevesinde değerlendir.

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
        headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) {
        const rows = await r.json();
        const user = rows?.[0];
        if (user && !user.is_admin && (user.credits || 0) <= 0) {
          return res.status(403).json({ error: 'Analiz hakkınız doldu.' });
        }
      }
    } catch(e) { dlog('[Kredi kontrol] hata:', e.message); }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  const yahooTicker = exchange === 'BIST' ? `${cleanTicker}.IS` : cleanTicker;
  let financialData = null;
  try {
    // Veri çekmeye kesin üst süre (Hobby'nin dar bütçesinde AI'ya yer kalsın).
    // Yahoo Vercel IP'lerini yavaşlattığında BIST çekimi çok uzuyordu; 9sn'de
    // pes edip elimizdeki veriyle (veya veri yoksa "sınırlı" modda) AI'ya geçiyoruz.
    financialData = await Promise.race([
      fetchYahooData(yahooTicker),
      new Promise((_, rej) => setTimeout(() => rej(new Error('veri-suresi-doldu')), 6000)),
    ]);
  } catch(e) { dlog('Fetch failed/timeout:', e.message); }

  const fd     = financialData;
  const isBIST = exchange === 'BIST';

  const systemPrompt = `Sen "Barış Investing"in baş analistisin ve analiz ettiğin efsanenin (Buffett/Lynch/Graham/Dalio) ağzından, birinci tekil şahısla, sohbet eder gibi konuşuyorsun.

ÜSLUP:
- KONUŞMA DİLİ, akıcı ve iddialı. Buffett sabırlı/alaycı, Lynch enerjik/atak, Graham temkinli, Dalio makrocu.
- NET OL: "olabilir, belki" YASAK. Bir tarafı tut, beğenmediysen sert eleştir, beğendiysen fırsatı savun.
- HER cümlede sana verilen GERÇEK rakamı kullan (ROE, FCF, PEG, net nakit vs). Rakamsız laf yok. Klişe/dolgu cümle yasak. KISA VE VURUCU yaz.

FORMAT (ASLA BOZMA):
- Düz metin, markdown YOK (#, *, - kullanma). Tüm alan ve anahtar isimlerini şablonla birebir aynı yaz.
- TOTAL_SCORE: 0-7 tam sayı (PASS sayısıyla tutarlı).
- Her kriter: "KEY: PASS|FAIL|NEUTRAL | açıklama" — açıklama 1-2 KISA vurucu cümle, rakamlı, net karar. NEUTRAL'ı sadece veri yoksa kullan.
- SUMMARY: 2 cümle, net tez. RISK: en can alıcı risk, tek cümle.

KISA KİMLİK NOTLARI:
- Buffett: Fiyatlama gücü=brüt marj istikrarı (F/K değil). Hissedar kazancı=FCF. Hendek yoksa ucuzluk kurtarmaz.
- Lynch: Önce kategori koy (Yavaş/Hızlı Büyüyen/Döngüsel...). PEG<1 fırsat, >2 FAIL. Kurumsal sahiplik <%30 "gizli mücevher".
- Graham: Güvenlik marjı, Borç/Özsermaye<0.5, F/K<15, F/DD<1.5.
- Dalio: Borç döngüsü, faiz/döviz/enflasyon duyarlılığı.

TÜRK HİSSELERİ: Nominal büyüme TÜFE altındaysa "REEL KÜÇÜLME" uyar. BIST F/K/F/DD güvenilmezse tek başına PASS/FAIL yapma, ROE ve FCF'e bak.`;

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
  enrichedPrompt += '\n\nKRİTİK KURAL: Yukarıdaki gerçek rakamları kullan, uydurma. Her PASS/FAIL/NEUTRAL satırı pipe (|) ile açıklama içermeli, CRITERIA_START/CRITERIA_END eksiksiz olmalı. Her açıklama 1-2 KISA vurucu cümle, en az bir rakam, NET karar — uzatma. Efsanenin ağzından, iddialı yaz.';
  if (!fd) enrichedPrompt += '\n\nVERİ NOTU: Finansal veri alınamadı. Sektör bilgine göre dürüstçe tahmin yürüt, "veri sınırlı" olduğunu açıkça söyle ama yine de net bir görüş ver, analizi yarım bırakma.';

  try {
    // Vercel'in bu fonksiyon için maxDuration'ı 30sn (vercel.json) — Anthropic
    // çağrısı bu süreyi aşarsa fonksiyon sert şekilde kesiliyordu. 25sn'de kendi
    // isteğimizi iptal edip kullanıcıya anlamlı bir hata dönüyoruz.
    // Varsayılan haiku: Vercel Hobby planının dar süre bütçesinde (30sn) hızlı
    // ve güvenilir. Kalite için ANALYZE_MODEL=claude-sonnet-5 (veya opus-4-8)
    // env ile yükseltilebilir — ama Hobby'de yavaş modeller timeout riski taşır.
    // Prompt iyileştirmesi her modelde geçerli, haiku bile eskisinden çok daha iyi.
    const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';
    const primaryModel = process.env.ANALYZE_MODEL || FALLBACK_MODEL;

    const callModel = async (model, timeoutMs) => {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          system: systemPrompt,
          messages: [{ role: 'user', content: enrichedPrompt }]
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      let d = null;
      try { d = await resp.json(); } catch {}
      return { resp, d };
    };

    let { resp: response, d: data } = await callModel(primaryModel, 19000);

    // Birincil model HATA döndürdüyse (ör. API anahtarında Sonnet erişimi yok /
    // geçersiz model ID) hemen bilinen-çalışan haiku'ya düş — analiz komple
    // patlamasın. Not: timeout durumunda callModel exception atar ve buraya
    // düşmez (dış catch yakalar), o yüzden çift-timeout riski yok.
    if ((!data || data.error || !response.ok) && primaryModel !== FALLBACK_MODEL) {
      dlog(`[AI] ${primaryModel} başarısız (${data?.error?.message || response?.status}) → ${FALLBACK_MODEL}`);
      ({ resp: response, d: data } = await callModel(FALLBACK_MODEL, 15000));
    }

    if (!data) return res.status(502).json({ error: 'AI servisinden geçersiz yanıt alındı.' });
    if (data.error || !response.ok) {
      const et = (data.error?.type || '').toLowerCase();
      const em = (data.error?.message || '').toLowerCase();
      const status = response?.status;
      // Anthropic hata tiplerini teşhis edilebilir mesajlara çevir
      if (status === 401 || et.includes('authentication') || em.includes('x-api-key') || em.includes('api key') || em.includes('api-key'))
        return res.status(502).json({ error: 'AI_AUTH: Anthropic API anahtarı geçersiz/eksik.' });
      if (em.includes('credit balance') || em.includes('billing') || em.includes('quota') || em.includes('insufficient'))
        return res.status(502).json({ error: 'AI_CREDIT: Anthropic hesabında bakiye/kredi yetersiz.' });
      if (status === 429 || et.includes('rate_limit') || et.includes('overloaded') || status === 529)
        return res.status(503).json({ error: 'AI_BUSY: AI servisi şu an meşgul, birkaç saniye sonra tekrar deneyin.' });
      // Bilinmeyen — ham Anthropic mesajını göster (teşhis için)
      return res.status(502).json({ error: `AI_HATA (${status||'?'}/${et||'?'}): ${data.error?.message || 'bilinmeyen'}` });
    }

    let aiResult = data.content?.[0]?.text || '';
    if (!aiResult) return res.status(502).json({ error: 'AI servisi boş yanıt döndü.' });
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

    dlog(`✓ ${yahooTicker} | src:${fd?.dataSource} | roe:${fd?.roe} | pb:${fd?.pbRatio}(${fd?.pbSource||'yahoo'}) | len:${aiResult.length}`);
    return res.status(200).json({
      result: aiResult,
      financialData: fd,
      peers: fd?.peers || [],
      dataWarnings: fd?._dataWarnings || [],
    });

  } catch(err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error('Analyze error:', err.message);
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'AI servisi zaman aşımına uğradı. Lütfen tekrar deneyin.' : err.message,
    });
  }
}
