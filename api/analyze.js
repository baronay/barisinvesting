// /api/analyze.js — Barış Investing
import crypto from 'node:crypto';
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
  rsi:                     [0, 100],
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
        { signal: AbortSignal.timeout(5500), headers: { 'Accept': 'application/json' } }
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
    ebitda: null, totalRevenue: null,
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
        // FAVÖK marjı: BIST'te en temiz fiyatlama gücü sinyali. Enflasyon
        // muhasebesi net kârı ve F/K'yı bozuyor, FAVÖK marjı daha az bozuluyor.
        if (result.ebitda == null)       result.ebitda       = f(fd.ebitda);
        if (result.totalRevenue == null) result.totalRevenue = f(fd.totalRevenue);
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

    // ADIM 5 (KAPATILDI): Eski İşYatırım/BigPara scraping'i (her biri ~6sn, arka
    // planda AI çağrısıyla yarışıp timeout'a sebep oluyordu) devre dışı. Doğru
    // BIST rasyoları zaten TradingView'den (bist-ratios) geliyor; eksik kalırsa
    // formül (MC/NetIncome, Fiyat/EPS) devreye giriyor (ADIM 6-7). Scraping'e
    // ihtiyaç yok — hız ve güvenilirlik için tamamen atlanıyor.

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

// ── BIST YAHOO TAKVİYESİ (sadece birim-güvenli alanlar) ──────────
// Yahoo'nun BIST bilanço kalemleri USD/TRY karışıklığı yüzünden güvenilmez,
// ama YÜZDE ve FİYAT alanları (kurumsal sahiplik, analist hedefi, tavsiye)
// bu sorundan etkilenmez. TradingView'de bu alanlar hiç yok — buradan
// best-effort tamamlıyoruz; başarısız olursa null döner, analiz aksamaz.
async function fetchBISTExtrasFromYahoo(yahooTicker) {
  const cacheKey = `bistextra:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const { crumb, cookie } = await getYahooCrumb();
  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=financialData,defaultKeyStatistics,assetProfile${cs}`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA, 'Accept': 'application/json',
      'Referer': 'https://finance.yahoo.com/', 'Origin': 'https://finance.yahoo.com',
      ...(cookie ? { 'Cookie': cookie } : {}),
    },
    signal: AbortSignal.timeout(4000),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const raw = j?.quoteSummary?.result?.[0];
  if (!raw) return null;

  const fd = raw.financialData || {}, ks = raw.defaultKeyStatistics || {}, ap = raw.assetProfile || {};
  const f = v => v?.raw ?? null;
  const out = {
    institutionOwnership:    f(ks.heldPercentInstitutions),
    targetMeanPrice:         f(fd.targetMeanPrice),
    recommendationKey:       fd.recommendationKey ?? null,
    numberOfAnalystOpinions: f(ks.numberOfAnalystOpinions) ?? f(fd.numberOfAnalystOpinions),
    website:                 ap.website ?? null,
  };
  setCache(cacheKey, out);
  return out;
}

// ── BIST HIZLI VERİ (sadece TradingView) ─────────────────────────
// Yahoo BIST verisi kökten bozuk (USD/TRY karışıklığı → F/K 33 yerine 3.3).
// Doğru rasyolar TradingView'de (api/bist-ratios). Tek çağrı, doğru veri,
// ~2-3sn → Yahoo dansı ve timeout derdi yok. bist-ratios FK/PDDD/FD_FAVOK
// alan isimleriyle döner; burada financialData yapısına doğru eşliyoruz
// (eski kodda bu eşleme yanlıştı: pe/pb okuyordu, hiç uygulanmıyordu).
async function fetchBISTFast(ticker) {
  const cacheKey = `bistfast:${ticker}`;
  const cached = getCached(cacheKey);
  if (cached) { dlog(`Cache hit (bistfast): ${ticker}`); return cached; }

  // Yahoo takviyesini TV çağrısıyla PARALEL başlat — kritik yol TV'dir,
  // Yahoo gecikirse aşağıda kısa bir süre bekleyip onsuz devam ederiz.
  const extrasPromise = fetchBISTExtrasFromYahoo(`${ticker}.IS`)
    .catch(e => { dlog(`[BIST Extras] Yahoo takviyesi başarısız: ${e.message}`); return null; });

  // TradingView scanner'ı DOĞRUDAN çağır — kendi API'mize HTTP self-call yok
  // (ekstra fonksiyon çağrısı, gecikme ve Vercel URL koruma riski kalkıyor).
  // GENİŞ KOLON SETİ: PEG, marjlar, 52H aralığı, RSI, FCF, nakit vb. TV'de
  // mevcut — bunlar boş kalınca AI çarpanları uydurup ekrana basıyordu.
  // Tüm kolonlar 2026-07 itibarıyla turkey/scan'da test edildi ve çalışıyor.
  const TV_COLS = ['close','price_earnings_ttm','price_book_ratio','market_cap_basic',
                   'enterprise_value_ebitda_ttm','return_on_equity','debt_to_equity',
                   'earnings_per_share_basic_ttm',
                   'price_52_week_low','price_52_week_high','price_earnings_growth_ttm',
                   'gross_margin','operating_margin','after_tax_margin','return_on_assets',
                   'current_ratio','free_cash_flow','total_debt','cash_n_short_term_invest_fq',
                   'total_revenue_yoy_growth_ttm','net_income_yoy_growth_ttm','RSI',
                   'sector','industry','description',
                   /* MALİ TABLO KALEMLERİ — bunlar istenmediği için BIST'te
                      totalAssets/netIncome/computedEquity hep null gidiyordu ve
                      bot "eksik veri" diyordu. Veri kaynağı değişmedi, aynı uca
                      doğru kolonlar soruluyor.

                      DİKKAT: TradingView bilinmeyen bir kolona hata DÖNMÜYOR,
                      sessizce null veriyor. Yani buradaki bir yazım hatası
                      analizi kırmaz, veriyi sessizce eksiltir — kolon adı
                      değiştirirken scanner'da tek tek doğrula. */
                   'total_assets_fq','total_liabilities_fq','total_equity_fq',
                   'net_income_fq','total_revenue_fq','cash_f_operating_activities_ttm',
                   'total_revenue_ttm','net_income_ttm','ebitda_ttm',
                   'total_assets_fy','total_liabilities_fy','total_equity_fy',
                   'net_income_fy','total_revenue_fy',
                   'total_revenue_yoy_growth_fy','net_income_yoy_growth_fy',
                   'fiscal_period_end_fq','fiscal_period_end_fy','earnings_release_next_date'];
  const r = await fetch('https://scanner.tradingview.com/turkey/scan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Accept': 'application/json',
      'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/',
      'User-Agent': UA,
    },
    body: JSON.stringify({ symbols: { tickers: [`BIST:${ticker}`], query: { types: [] } }, columns: TV_COLS }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`TradingView HTTP ${r.status}`);
  const json = await r.json();
  const row = json?.data?.[0]?.d;
  if (!row) throw new Error('TradingView veri yok');

  const IX  = Object.fromEntries(TV_COLS.map((c, i) => [c, i]));
  const num = v => (v != null && isFinite(v)) ? Number(v) : null;
  const g   = c => num(row[IX[c]]);
  const str = c => (typeof row[IX[c]] === 'string' && row[IX[c]]) ? row[IX[c]] : null;
  const pct = v => v != null ? v / 100 : null; // TV yüzde döner → Yahoo kesir formatına çevir

  const fiyat = g('close'), fk = g('price_earnings_ttm'), pddd = g('price_book_ratio');
  const mc = g('market_cap_basic'), eps = g('earnings_per_share_basic_ttm');
  if (fiyat == null) throw new Error('BIST fiyat verisi yok');
  // F/K yedeği: TV bazen price_earnings_ttm'i boş döner — fiyat/EPS'den hesapla
  const fkFinal = (fk && fk > 0) ? fk : (eps && eps > 0 ? fiyat / eps : null);

  const result = {
    currentPrice: fiyat, currency: 'TRY',
    marketCap: mc,
    peRatio: fkFinal, peSource: 'TradingView',
    forwardPE: null,
    pbRatio: (pddd && pddd > 0) ? pddd : null, pbSource: 'TradingView',
    pegRatio: g('price_earnings_growth_ttm'), pegSource: 'TradingView',
    evEbitda: g('enterprise_value_ebitda_ttm'),
    roe: pct(g('return_on_equity')), roeSource: 'TradingView',
    roa: pct(g('return_on_assets')),
    grossMargin: pct(g('gross_margin')),
    operatingMargin: pct(g('operating_margin')),
    profitMargin: pct(g('after_tax_margin')),
    freeCashflow: g('free_cash_flow'), operatingCashflow: g('cash_f_operating_activities_ttm'),
    totalCash: g('cash_n_short_term_invest_fq'), totalDebt: g('total_debt'),
    // TV debt_to_equity ORAN döner (0.84), Yahoo ise YÜZDE (84) — frontend ve
    // prompt Yahoo formatını beklediği için yüzdeye çeviriyoruz.
    debtToEquity: g('debt_to_equity') != null ? g('debt_to_equity') * 100 : null,
    currentRatio: g('current_ratio'),
    revenueGrowth: pct(g('total_revenue_yoy_growth_ttm')),
    earningsGrowth: pct(g('net_income_yoy_growth_ttm')),
    rsi: g('RSI'),
    institutionOwnership: null, recommendationKey: null, targetMeanPrice: null,
    numberOfAnalystOpinions: null,
    fiftyTwoWeekLow: g('price_52_week_low'), fiftyTwoWeekHigh: g('price_52_week_high'),
    shortName: str('description'), website: null,
    sector: str('sector'), industry: str('industry'),
    /* Mali tablolar — hepsi TL ve tam birim (bin/milyon değil). Dönem
       etiketleri ayrıca taşınıyor: prompt çeyreklik, yıllık ve TTM rakamını
       aynı satırda karıştırmasın.

       Bankalarda FAVÖK yok; TradingView zaten null döndürüyor, yani
       XI_29 / UFRS ayrımını elle yapmaya gerek kalmıyor. */
    totalAssets:      g('total_assets_fq'),
    totalLiabilities: g('total_liabilities_fq'),
    computedEquity:   g('total_equity_fq'),
    netIncome:        g('net_income_fq'),      // ÇEYREK net kâr
    ceyrekHasilat:    g('total_revenue_fq'),
    totalRevenue:     g('total_revenue_ttm'),  // TTM hasılat
    netIncomeTTM:     g('net_income_ttm'),
    ebitda:           g('ebitda_ttm'),
    yillik: {
      aktif:         g('total_assets_fy'),
      borc:          g('total_liabilities_fy'),
      ozkaynak:      g('total_equity_fy'),
      netKar:        g('net_income_fy'),
      hasilat:       g('total_revenue_fy'),
      hasilatBuyume: pct(g('total_revenue_yoy_growth_fy')),
      karBuyume:     pct(g('net_income_yoy_growth_fy')),
      donemSonu:     g('fiscal_period_end_fy'),
    },
    donemSonuFQ:    g('fiscal_period_end_fq'),
    sonrakiBilanco: g('earnings_release_next_date'),
    cekilme:        new Date().toISOString(),
    peers: [], dataSource: 'TradingView',
  };

  // Yahoo takviyesini en fazla 2.5sn bekle — gelmezse bu alanlar null kalır.
  const extras = await Promise.race([
    extrasPromise,
    new Promise(resolve => setTimeout(() => resolve(null), 2500)),
  ]);
  if (extras) {
    /* BIST'te Yahoo'nun kurumsal sahiplik oranı takas verisiyle tutmuyor;
       beslenmiyor ki ne kartta ne de yorumda yanlış rakam görünsün. */
    result.institutionOwnership    = null;
    result.recommendationKey       = extras.recommendationKey;
    result.numberOfAnalystOpinions = extras.numberOfAnalystOpinions;
    result.website                 = extras.website ?? result.website;
    // Analist hedefi TRY olmalı — USD gelmişse (fiyatın çok altında) alma
    if (extras.targetMeanPrice != null && fiyat > 0) {
      const tRatio = extras.targetMeanPrice / fiyat;
      if (tRatio > 0.3 && tRatio < 8) result.targetMeanPrice = extras.targetMeanPrice;
      else dlog(`[BIST Extras] targetMeanPrice=${extras.targetMeanPrice} fiyata (${fiyat}) göre anormal → atlandı`);
    }
    dlog(`[BIST Extras] inst=${extras.institutionOwnership} hedef=${result.targetMeanPrice} tavsiye=${extras.recommendationKey}`);
  }

  /* PD/DD son çeyrek özkaynağıyla: TradingView'in hazır price_book_ratio
     değeri farklı bir döneme dayanabiliyor, elimizde total_equity_fq
     varken tahmin etmeye gerek yok. */
  const ozkaynakFQ = g('total_equity_fq');
  if (mc && ozkaynakFQ && ozkaynakFQ > 0) {
    result.pbRatio  = mc / ozkaynakFQ;
    result.pbSource = 'MC/Özkaynak (son çeyrek)';
  }

  const { data: clean, warnings } = sanitizeFinancialData(result);
  if (!clean) throw new Error('BIST veri doğrulama başarısız');
  clean._dataWarnings = warnings;
  setCache(cacheKey, clean);
  return clean;
}

// ── SIGNAL HELPERS ───────────────────────────────────────────────
function sigPE(v)  { if(v==null)return'N/A'; if(v<12)return'ucuz'; if(v<22)return'adil'; return'pahalı'; }
function sigPB(v)  { if(v==null)return'N/A'; if(v<1.5)return'ucuz'; if(v<3)return'adil'; return'pahalı'; }
function sigPEG(v) { if(v==null)return'N/A'; if(v<1)return'ucuz — büyüme fiyatlanmamış'; if(v<1.5)return'adil'; if(v<2)return'dikkatli ol'; return'pahalı'; }
function sigEV(v)  { if(v==null)return'N/A'; if(v<8)return'ucuz'; if(v<15)return'adil'; return'pahalı'; }

/* ── BIST'E ÖZGÜ DEĞERLENDİRME KURALLARI ───────────────────────────
   ABD'ye göre kalibre edilmiş eşikler (F/K, PD/DD, büyüme) BIST'e
   doğrudan taşınmasın diye ayrı blok. Yalnızca exchange BIST ise
   prompt'a giriyor; ABD analizinde token yakmıyor.

   Makro değerler CONFIG'DEN geliyor. Tanımsızsa yerine "VERİ YOK"
   yazılıyor ve kural setinin son maddesi o değerlendirmeyi atlamayı
   söylüyor — rakam uydurulmuyor.

   Ortam değişkenleri (Vercel → Environment Variables):
     TUFE_YILLIK  POLITIKA_FAIZI  TL_10Y  CDS_5Y  US_10Y  MAKRO_GUNCELLEME_TARIHI */
const BIST_MAKRO_ALANLAR = {
  TUFE_YILLIK:    { env: 'TUFE_YILLIK',    bicim: v => `%${v}` },
  POLITIKA_FAIZI: { env: 'POLITIKA_FAIZI', bicim: v => `%${v}` },
  TL_10Y:         { env: 'TL_10Y',         bicim: v => `%${v}` },
  CDS_5Y:         { env: 'CDS_5Y',         bicim: v => `${v} baz puan` },
  US_10Y:         { env: 'US_10Y',         bicim: v => `%${v}` },
  /* Makro verinin tarihi. Bayat bir TÜFE ile reel büyüme hesaplamak
     uydurmanın başka bir hâli; tarih prompt'a giriyor ki model eskiliği
     görebilsin. */
  MAKRO_TARIHI:   { env: 'MAKRO_GUNCELLEME_TARIHI', bicim: v => v },
};

function bistMakroEksikler() {
  return Object.entries(BIST_MAKRO_ALANLAR)
    .filter(([, a]) => {
      const v = process.env[a.env];
      return v == null || String(v).trim() === '';
    })
    .map(([ad]) => ad);
}

/* ── ENDÜSTRİ → SEKTÖR MODÜLÜ EŞLEMESİ ────────────────────────────
   TradingView'ın SEKTÖR alanı BIST'te işe yaramıyor: gayrimenkul
   şirketleri de bankalar da "Finance" altında görünüyor. Eşleme
   ENDÜSTRİ alanıyla yapılıyor.

   Tablo 626 BIST hissesinin gerçek endüstri değerlerinden çıkarıldı
   (80 farklı değer). Listede olmayan bir endüstri gelirse modül
   seçilmiyor ve yalnızca genel kurallar gidiyor — yanlış modül
   göndermektense hiç göndermemek doğru.

   BİLİNEN SINIR: TradingView büyük holdingleri en büyük iştirakine göre
   sınıflıyor (KCHOL "Oil Refining/Marketing", SAHOL "Regional Banks").
   Bu ikisine holding modülü gitmiyor; eşleme tablosuna elle eklemek
   gerekirse ticker bazlı bir istisna listesi açılabilir. */
const ENDUSTRI_MODUL = {
  // Bankalar ve banka benzeri finansal kurumlar
  'Major Banks': 'BANKALAR',
  'Regional Banks': 'BANKALAR',
  'Investment Banks/Brokers': 'BANKALAR',
  'Finance/Rental/Leasing': 'BANKALAR',

  'Multi-Line Insurance': 'SIGORTA',
  'Life/Health Insurance': 'SIGORTA',
  'Property/Casualty Insurance': 'SIGORTA',

  'Financial Conglomerates': 'HOLDING',
  'Industrial Conglomerates': 'HOLDING',
  'Investment Managers': 'HOLDING',
  'Miscellaneous': 'HOLDING',

  'Real Estate Investment Trusts': 'GAYRIMENKUL',
  'Real Estate Development': 'GAYRIMENKUL',
  'Homebuilding': 'GAYRIMENKUL',

  'Airlines': 'HAVAYOLU',
  'Air Freight/Couriers': 'HAVAYOLU',
  'Other Transportation': 'HAVAYOLU',
  'Railroads': 'HAVAYOLU',
  'Trucking': 'HAVAYOLU',

  'Oil Refining/Marketing': 'RAFINERI',
  'Integrated Oil': 'RAFINERI',
  'Gas Distributors': 'RAFINERI',

  'Electric Utilities': 'ELEKTRIK',
  'Alternative Power Generation': 'ELEKTRIK',

  'Steel': 'DEMIRCELIK',
  'Metal Fabrication': 'DEMIRCELIK',

  'Precious Metals': 'MADENCILIK',
  'Other Metals/Minerals': 'MADENCILIK',

  'Motor Vehicles': 'OTOMOTIV',
  'Auto Parts: OEM': 'OTOMOTIV',
  'Automotive Aftermarket': 'OTOMOTIV',
  'Electronics/Appliances': 'OTOMOTIV',
  'Trucks/Construction/Farm Machinery': 'OTOMOTIV',
  'Electrical Products': 'OTOMOTIV',

  'Aerospace & Defense': 'SAVUNMA',

  'Food Retail': 'PERAKENDE',
  'Apparel/Footwear Retail': 'PERAKENDE',
  'Specialty Stores': 'PERAKENDE',
  'Restaurants': 'PERAKENDE',
  'Electronics Distributors': 'PERAKENDE',
  'Wholesale Distributors': 'PERAKENDE',

  'Major Telecommunications': 'TELEKOM',
  'Wireless Telecommunications': 'TELEKOM',

  'Construction Materials': 'INSAAT_MALZEME',
  'Building Products': 'INSAAT_MALZEME',
  'Home Furnishings': 'INSAAT_MALZEME',

  'Packaged Software': 'TEKNOLOJI',
  'Information Technology Services': 'TEKNOLOJI',
  'Semiconductors': 'TEKNOLOJI',
  'Electronic Production Equipment': 'TEKNOLOJI',
  'Electronic Equipment/Instruments': 'TEKNOLOJI',

  // Üretim yapan geri kalan sanayi — genel sanayi modülü
  'Textiles': 'DIGER_SANAYI',
  'Apparel/Footwear': 'DIGER_SANAYI',
  'Chemicals: Specialty': 'DIGER_SANAYI',
  'Chemicals: Agricultural': 'DIGER_SANAYI',
  'Chemicals: Major Diversified': 'DIGER_SANAYI',
  'Containers/Packaging': 'DIGER_SANAYI',
  'Industrial Specialties': 'DIGER_SANAYI',
  'Industrial Machinery': 'DIGER_SANAYI',
  'Miscellaneous Manufacturing': 'DIGER_SANAYI',
  'Commercial Printing/Forms': 'DIGER_SANAYI',
  'Agricultural Commodities/Milling': 'DIGER_SANAYI',
  'Food: Specialty/Candy': 'DIGER_SANAYI',
  'Food: Major Diversified': 'DIGER_SANAYI',
  'Food: Meat/Fish/Dairy': 'DIGER_SANAYI',
  'Beverages: Non-Alcoholic': 'DIGER_SANAYI',
  'Beverages: Alcoholic': 'DIGER_SANAYI',
  'Household/Personal Care': 'DIGER_SANAYI',
  'Other Consumer Specialties': 'DIGER_SANAYI',
  'Recreational Products': 'DIGER_SANAYI',
};

/* Eşleşmeyen endüstriler bilerek boş bırakıldı — bunlara yalnızca genel
   kurallar gidiyor: Engineering & Construction (taahhüt; modülü yok,
   backlog/alacak dinamiği savunmaya benziyor ama aynı değil),
   Pharmaceuticals, Biotechnology, Hospital/Nursing Management,
   Medical/Nursing Services, Medical Distributors, Movies/Entertainment,
   Hotels/Resorts, Other Consumer Services, Miscellaneous Commercial
   Services. */

const BIST_A_SABLON = `
BIST HİSSELERİ — DEĞERLENDİRME KURALLARI
Analiz edilen hisse Borsa İstanbul'da işlem görüyor. Önce A bölümündeki
genel kuralları, ardından veri bloğundaki Sektör/Endüstri bilgisine göre
B bölümündeki İLGİLİ sektör modülünü uygula. Sektör belirlenemiyorsa
yalnızca genel kuralları uygula ve bunu belirt. ABD piyasasına göre
kalibre edilmiş eşikleri (F/K, PD/DD, büyüme oranı vb.) doğrudan BIST'e
taşıma.

── A. GENEL KURALLAR ──

1) ENFLASYON MUHASEBESİ (TMS 29). BIST şirketleri 2023 yıl sonundan
   itibaren finansal tablolarını raporlama tarihinin satın alma gücüyle
   sunuyor. Bu yüzden düzeltilmiş verideki yıllık büyüme ZATEN REEL
   büyümedir; bunu tekrar enflasyonla karşılaştırma. Veri düzeltilmemişse
   aynı dönemin enflasyonuyla karşılaştır. Hangi durumda olduğu
   bilinmiyorsa reel büyüme yorumu YAPMA ve bunu belirt.

2) FONKSİYONEL PARA BİRİMİ. Fonksiyonel para birimi ABD doları veya avro
   olan şirketler (ör. havayolları) TMS 29 uygulamaz. Bu şirketlerde
   büyümeyi ve marjları fonksiyonel para biriminde değerlendir; TL
   rakamlardaki büyüme büyük ölçüde kur etkisidir.

3) TTM VERİSİ. TradingView'ın BIST için verdiği son 12 ay (TTM) rakamları
   farklı satın alma gücündeki çeyreklerin toplamı olabilir. Büyüme ve
   nakit akışı yorumlarında SON YILLIK RAPORU ve son çeyreğin yıllık
   değişimini kullan. TTM kullanırsan yanıltıcı olabileceğini belirt.

4) NET PARASAL POZİSYON KAZANCI/KAYBI. Net kârın içinde bu kalem varsa
   faaliyet kârından ayrı değerlendir. Parasal kazançla şişen net kâr
   operasyonel güç göstergesi değildir.

5) GETİRİ KARŞILAŞTIRMASI. TL bazlı değerlendirmede referans getiri TL
   faizidir; kâr getirisini (1/F/K) ve temettü verimini bununla
   karşılaştır. Döviz bazlı değerlendirmede beklenen getiri ABD 10 yıllık
   tahvil faizi + Türkiye ülke risk primi + hisse senedi risk primidir.
   Güncel değerler: politika faizi {{POLITIKA_FAIZI}}, TL 10 yıllık
   {{TL_10Y}}, CDS {{CDS_5Y}}, ABD 10 yıllık {{US_10Y}}, yıllık TÜFE
   {{TUFE_YILLIK}} (makro verinin tarihi: {{MAKRO_TARIHI}} — analiz
   tarihine göre bayatsa belirt).

6) ÇARPANLAR. BIST çarpanları yapısal olarak ABD'nin altındadır. Düşük
   F/K veya PD/DD tek başına ucuzluk değildir. Çarpanları aynı sektördeki
   BIST şirketleri, şirketin kendi geçmiş ortalaması ve TL faiziyle
   karşılaştır.

7) DÖVİZ YAPISI. Gelir, maliyet ve borcun para birimini tespit et. Döviz
   geliri olan şirketlerde döviz bazlı değerlendirmeyi öne çıkar. Geliri
   TL, borcu döviz olan şirketlerde kur riskini açıkça belirt.

8) PİYASA YAPISI. Halka açıklık oranı ve işlem hacmi düşükse likidite
   riskini belirt. Yabancı payı verisi varsa trendini not et.

9) VERİ DİSİPLİNİ.
   - Özkaynak bazlı oranları EN SON ÇEYREK özkaynağıyla hesapla.
   - Her rakamın yanında dönem tipini (çeyrek / yıllık / TTM) ve dönemini
     belirt.
   - Veri yoksa "elimde yok" de. Vekil göstergelerle (52 haftalık bant
     vb.) adil giriş bölgesi ÜRETME, veriye dayanmayan portföy ağırlığı
     önerme.
   - Bir bölümün temel verisi yoksa durum BELİRSİZ (NEUTRAL) olsun.
     KALDI (FAIL) yalnızca veri OLUMSUZ bir sonuç gösterdiğinde verilsin.

10) TEZ ENTEGRASYONU. Hissenin sitede tezi varsa tez tablosundaki veriyi
    kullan; tezin sinyalini ve tarihini belirt, kendi görüşün farklıysa
    sebebini açıkla ve tez sayfasına link ver.

`;

/* Sektör modülleri — yalnızca eşleşen biri prompt'a giriyor.
   Hepsini göndermek 16 modülün 15'ini boşa yakıyordu ve sistem
   promptunu 8.533 token'a çıkarıp dağıtım sonrası ilk analizin
   kesilmesine yol açıyordu (ölçüldü: cacheYaz 8533, sureDoldu). */
const BIST_MODULLER = {
  BANKALAR: `
BANKALAR
- Ana metrikler: ROE, PD/DD, net faiz marjı, takipteki kredi oranı, net
  risk maliyeti, sermaye yeterlilik oranı, ücret ve komisyon gelirlerinin
  giderleri karşılama oranı.
- ROE'yi enflasyon ve politika faiziyle karşılaştır; enflasyonun altındaki
  ROE özkaynağın reel olarak eridiği anlamına gelir. PD/DD'yi ROE ile
  birlikte yorumla.
- Faiz indirim döngüsünde mevduat ağırlıklı ve vadesiz mevduatı yüksek
  bankaların marjı daha hızlı genişler. TÜFE'ye endeksli menkul kıymet
  gelirinin kâra katkısını not et.
- FAVÖK, cari oran, borç/özsermaye gibi SANAYİ metriklerini bankalara
  UYGULAMA.`,
  SIGORTA: `
SİGORTA VE EMEKLİLİK
- Teknik kârı (sigortacılık faaliyeti) yatırım gelirinden ayır. Yüksek
  faiz ortamında kârın büyük kısmı yatırım gelirinden gelir; faiz
  indirimleri bu kısmı daraltır.
- Birleşik rasyo verisi varsa %100'ün üstü teknik zarardır. Emeklilik
  şirketlerinde fon büyüklüğü ve katılımcı sayısı büyüme motorudur.
- ROE ve PD/DD birlikte değerlendirilir; sanayi metriklerini uygulama.`,
  HOLDING: `
HOLDİNGLER
- Asıl metrik NAD'a göre iskontodur: halka açık iştiraklerin piyasa değeri
  × holdingin payı + halka açık olmayan varlıklar − holding net borcu.
- İştirak payları veride yoksa NAD HESAPLAMA; iskontonun holding
  değerlemesinin temeli olduğunu ve verinin eksik olduğunu belirt.
- Konsolide F/K ve FAVÖK holdingler için yanıltıcıdır; banka, enerji,
  sanayi gibi farklı işleri karıştırır.`,
  GAYRIMENKUL: `
GAYRİMENKUL (GYO VE GAYRİMENKUL ŞİRKETLERİ)
- Asıl metrik NAD'a göre iskontodur. Gelir tablosunda yatırım amaçlı
  gayrimenkul değerleme kazancı varsa şirket gerçeğe uygun değer modelini
  kullanıyor demektir.
- GYO statüsündeki (vergiden muaf) şirketlerde son çeyrek özkaynağı NAD'ın
  vekili olarak kullanılabilir. GYO statüsünde OLMAYAN şirketlerde
  ertelenmiş vergi nedeniyle özkaynak NAD'ı olduğundan DÜŞÜK gösterir;
  bunu belirt ve o şirkete "GYO" deme, "gayrimenkul şirketi" de.
- Değerleme kazançları nakit yaratmaz; tekrarlanabilir kira gelirini ve
  operasyonel nakit akışını ayrı değerlendir. Konut geliştiricilerinde ön
  satışlar ve teslim takvimi gelirin zamanlamasını belirler.`,
  HAVAYOLU: `
HAVAYOLU VE ULAŞTIRMA
- Fonksiyonel para birimi genelde ABD dolarıdır; değerlendirmeyi dolar
  bazında yap.
- Ana metrikler: yolcu ve kapasite büyümesi, doluluk, birim gelir ve birim
  maliyet (yakıt hariç), yakıt maliyetinin payı, kiralama yükümlülükleri
  dahil net borç.
- Jeopolitik riskleri ve petrol fiyatı duyarlılığını not et.`,
  RAFINERI: `
RAFİNERİ, PETROKİMYA VE ENERJİ TİCARETİ
- Kârlılık rafineri marjlarına (crack spread) ve stok kazanç/kayıplarına
  bağlıdır. Stok etkisini operasyonel kârdan ayır.
- Döngüsel sektör: yüksek marj dönemindeki düşük F/K ucuzluk değil, döngü
  zirvesi olabilir.`,
  ELEKTRIK: `
ELEKTRİK ÜRETİM VE DAĞITIM
- Dağıtım şirketleri regüle getiriye tabidir; düzenleyici varlık tabanı ve
  izin verilen getiri oranı belirleyicidir.
- Üretim şirketlerinde kaynak tipi (yenilenebilir/termik), YEKDEM ve dolar
  bazlı alım garantileri, piyasa takas fiyatına duyarlılık ve döviz borcu
  ana metriklerdir.`,
  DEMIRCELIK: `
DEMİR-ÇELİK VE METAL
- Döngüsel sektör: emtia fiyatı ve ton başına marj belirleyicidir. Döngü
  zirvesindeki düşük F/K'ya güvenme; normalize edilmiş marjı düşün.
- İhracat payı, enerji maliyeti ve Çin kaynaklı fiyat baskısını not et.`,
  OTOMOTIV: `
OTOMOTİV, BEYAZ EŞYA VE İHRACATÇI SANAYİ
- İhracat payı ve ihracatın para birimi (çoğunlukla avro) kritik. Reel TL
  değerlenmesi ihracatçı marjlarını baskılar; bunu kur ve maliyet
  enflasyonu farkı olarak değerlendir.
- Kapasite kullanımı, üretim adetleri ve iç pazar talebinin kredi
  koşullarına duyarlılığını not et.`,
  SAVUNMA: `
SAVUNMA
- Ana metrikler: sipariş bakiyesi (backlog) ve bunun yıllık gelire oranı,
  kamu alacakları, işletme sermayesi ve kârın nakde dönüşümü.
- Yüksek sipariş bakiyesine rağmen zayıf operasyonel nakit akışı, alacak
  tahsilatı sorununa işaret edebilir.`,
  PERAKENDE: `
PERAKENDE VE GIDA PERAKENDESİ
- Negatif işletme sermayesiyle çalışan perakendeciler yüksek enflasyonda
  finansman avantajı elde eder. Bu kazancı faaliyet kârından ayır.
- Ana metrikler: aynı mağaza satış büyümesi (reel), mağaza sayısı
  büyümesi, brüt marj, metrekare verimliliği.`,
  TELEKOM: `
TELEKOM
- Abone başına gelir (ARPU) artışını enflasyonla karşılaştır. Yatırım
  harcamalarının hasılata oranı ve döviz borcu ana risklerdir.
- Fiber ve mobil abone büyümesini, regülasyon kaynaklı fiyat sınırlarını
  not et.`,
  INSAAT_MALZEME: `
İNŞAAT MALZEMELERİ, ÇİMENTO VE CAM
- Enerji maliyeti (doğal gaz, elektrik) marjı belirler. İhracat payı ve iç
  pazarda inşaat faaliyetinin faiz oranlarına duyarlılığını not et.`,
  MADENCILIK: `
MADENCİLİK VE ALTIN
- Emtia fiyatı, üretim hacmi, birim nakit maliyet ve rezerv ömrü ana
  metriklerdir. Kâr emtia fiyatının bir fonksiyonu olduğu için F/K'yı
  emtia fiyat varsayımıyla birlikte yorumla.`,
  TEKNOLOJI: `
TEKNOLOJİ VE YAZILIM
- Tekrarlayan gelir payı, ihracat/yurt dışı gelir payı ve kârın nakde
  dönüşümü ana metriklerdir. Aktifleştirilen geliştirme giderlerinin kârı
  şişirip şişirmediğine dikkat et.`,
  DIGER_SANAYI: `
DİĞER SANAYİ (KİMYA, TEKSTİL, KÂĞIT, GIDA ÜRETİMİ VB.)
- Genel kuralları uygula. Ek olarak hammadde maliyetinin para birimi,
  ihracat payı ve fiyatlama gücünü (maliyet artışını fiyata yansıtabilme)
  değerlendir.`,
};

const BIST_C_SABLON = `
── C. GENEL KURAL ──
Sektör modülünde istenen bir metrik veride YOKSA o değerlendirmeyi ATLA ve
eksikliği belirt. Sektör modülü ile genel kurallar çelişirse SEKTÖR
MODÜLÜNÜ uygula.`;

/* Endüstriye göre modül seç. Eşleşme yoksa modül GÖNDERİLMİYOR — yanlış
   modül göndermektense hiç göndermemek doğru (C kuralının gereği). */
function bistModulSec(endustri) {
  const ad = ENDUSTRI_MODUL[String(endustri || '').trim()] || null;
  return (ad && BIST_MODULLER[ad]) ? ad : null;
}

function bistKurallari(endustri) {
  const modulAd = bistModulSec(endustri);
  const b = modulAd
    ? `\n── B. SEKTÖR MODÜLÜ: ${modulAd} ──\n${BIST_MODULLER[modulAd]}\n`
    : `\n── B. SEKTÖR MODÜLÜ ──\nBu hissenin endüstrisi (${endustri || 'bilinmiyor'}) için tanımlı bir sektör modülü YOK. Yalnızca genel kuralları uygula ve sektör modülü uygulanmadığını yanıtta belirt.\n`;
  return (BIST_A_SABLON + b + BIST_C_SABLON).replace(/\{\{(\w+)\}\}/g, (tam, ad) => {
    const alan = BIST_MAKRO_ALANLAR[ad];
    if (!alan) return 'VERİ YOK';
    const ham = process.env[alan.env];
    if (ham == null || String(ham).trim() === '') return 'VERİ YOK';
    return alan.bicim(String(ham).trim());
  });
}

/* ── MANUEL TEZ VERİSİ ─────────────────────────────────────────────
   TradingView bir GYO'nun EPRA net aktif değerini, kira endeksini,
   değerleme raporunu ya da tezin senaryolarını bilmiyor. Bunlar elle
   derleniyor ve tez_veri tablosunda duruyor.

   Her zaman o ticker'ın EN GÜNCEL satırı okunuyor; eski satırlar
   silinmiyor, "tez o gün neye dayanıyordu" geriye dönük cevaplanabilsin. */
async function tezVerisiGetir(ticker) {
  const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/tez_veri?ticker=eq.${encodeURIComponent(ticker)}`
      + `&order=guncelleme_tarihi.desc&limit=1&select=*`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, signal: AbortSignal.timeout(3000) }
    );
    if (!r.ok) return null;
    const d = await r.json();
    return (Array.isArray(d) && d[0]) ? d[0] : null;
  } catch (e) { dlog('[tez_veri] cekilemedi:', e.message); return null; }
}

/* EUR/TRY — NAD'ı TL'ye çevirmek için. BIST taraması turkey/scan'de ama
   kur orada yok, forex/scan'de. Sabit kur kullanmıyoruz: tez 610 TL
   derken kur 55,3'tü, kur değişince iskonto da değişiyor. */
async function eurTryGetir() {
  try {
    const r = await fetch('https://scanner.tradingview.com/forex/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com', 'User-Agent': UA,
      },
      body: JSON.stringify({ symbols: { tickers: ['FX_IDC:EURTRY'], query: { types: [] } }, columns: ['close'] }),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const v = j?.data?.[0]?.d?.[0];
    return (v != null && isFinite(v)) ? Number(v) : null;
  } catch (e) { dlog('[EURTRY] cekilemedi:', e.message); return null; }
}

/* Tarihler Europe/Istanbul'a göre. Sunucu UTC çalışıyor; gece yarısı
   civarında analiz "bir gün geride" tarih yazıyordu. sv-SE yerel biçimi
   zaten YYYY-MM-DD veriyor. */
function trTarih(d) {
  try { return new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Europe/Istanbul' }); }
  catch (_) { try { return new Date(d).toISOString().slice(0, 10); } catch (_e) { return null; } }
}

/* NAD hesabı tek yerde: hem prompt bloğu hem istemciye dönen tez notu
   aynı rakamı kullansın, iki yerde ayrı hesaplanıp ayrışmasın. */
function nadHesapla(m, fd, eurTry) {
  const fiyat = fd?.currentPrice ?? null;
  const nadEurHisse = (m?.epra_nad_eur && m?.hisse_sayisi) ? (m.epra_nad_eur / m.hisse_sayisi) : null;
  const nadTry = (nadEurHisse != null && eurTry) ? nadEurHisse * eurTry : null;
  const iskonto = (nadTry && fiyat) ? (1 - fiyat / nadTry) * 100 : null;
  return { fiyat, nadEurHisse, nadTry, iskonto };
}

/* Manuel veriyi prompt bloğuna çevir.

   OLGU / GÖRÜŞ AYRIMI: buraya yalnızca OLGULAR giriyor — kira yapısı,
   değerleme raporu, hissedar yapısı, borç ve bilanço, kırılma eşikleri,
   kontrol noktaları, EPRA NAD, hisse sayısı, GYO statüsü.

   Tezin GÖRÜŞÜ (sinyal, senaryolar, giriş bandı, tez fiyatı, beklenen
   değer, kapanış oranı) BİLEREK verilmiyor: model tezi tekrarlamasın,
   aynı olgulardan kendi bağımsız sonucuna varsın. O alanlar yanıtta
   ayrıca istemciye gidiyor ve orada gösteriliyor.

   Üç şeye dikkat ediyor:
   1) ÖNCELİK — aynı kalemde manuel ile TradingView çakışırsa manuel
      kazanıyor ve kaynağı yazılıyor. Çakışmayan kalemlerde TV sürüyor.
   2) BAYATLIK — kontrol noktasının tarihi geçmiş ama veri o tarihten
      sonra güncellenmemişse model bunu söylüyor.
   3) CANLI KONTROL — doluluk, kiracı cirosu gibi eşikler canlı veriyle
      doğrulanamıyor; "son manuel veri itibarıyla" diye işaretleniyor ki
      güncel durum gibi sunulmasın. */
function manuelBlok(m, fd, eurTry) {
  if (!m) return '';
  const say = (v, d = 1) => (v != null && isFinite(v)) ? Number(v).toFixed(d) : null;
  const gun = (t) => { const d = new Date(t); return isNaN(d) ? null : d; };
  const bugun = new Date();
  const guncTarih = gun(m.guncelleme_tarihi);
  const kaynakEtiket = `${m.kaynak || 'Barış Investing tezi'}, ${m.guncelleme_tarihi}`;

  // ── NAD iskontosu: canlı kurla, sabit rakam yok ──
  const { fiyat, nadEurHisse, nadTry, iskonto } = nadHesapla(m, fd, eurTry);

  let nadMetin;
  if (nadTry == null) {
    nadMetin = eurTry
      ? 'NAD hesaplanamadı (EPRA NAD ya da hisse sayısı eksik) — iskonto rakamı ÜRETME.'
      : 'EUR/TRY kuru alınamadı — NAD iskontosunu hesaplama, "kur verisi elimde yok" de.';
  } else {
    nadMetin = `  EPRA NAD: ${(m.epra_nad_eur / 1e6).toFixed(0)} mn € · hisse sayısı ${(m.hisse_sayisi / 1e6).toFixed(0)} mn → ${say(nadEurHisse, 3)} €/hisse
  EUR/TRY (TradingView, canlı): ${say(eurTry, 4)}  →  NAD = ${say(nadTry, 2)} TL/hisse
  Güncel fiyat ${say(fiyat, 2)} TL  →  NAD İSKONTOSU: %${say(iskonto, 1)}
  BU HESABI YANITTA GÖSTER: kullanılan kur, kurun kaynağı ve tarih (${trTarih(bugun)}).`;
  }

  // ── Bayatlık: tarihi geçmiş ama veri o tarihten sonra güncellenmemiş ──
  const kn = Array.isArray(m.kontrol_noktalari) ? m.kontrol_noktalari : [];
  const bayat = kn.filter(k => { const t = gun(k.tarih); return t && t < bugun && guncTarih && t > guncTarih; });
  const bayatMetin = bayat.length
    ? `\nBAYATLIK UYARISI: şu kontrol noktalarının tarihi geçti ama manuel veri (${m.guncelleme_tarihi}) o tarihten sonra güncellenmedi — ${bayat.map(k => `${k.tarih} ${k.olay}`).join('; ')}. İlgili verinin GÜNCELLENMEYİ BEKLEDİĞİNİ söyle, eski rakamı güncelmiş gibi sunma.`
    : '';

  // ── Kırılma eşikleri: canlı kontrol edilebilenler ayrı ──
  const esikler = Array.isArray(m.kirilma_esikleri) ? m.kirilma_esikleri : [];
  const netBorc = (fd?.totalDebt != null && fd?.totalCash != null) ? fd.totalDebt - fd.totalCash : null;
  const canliNetBorcFavok = (netBorc != null && fd?.ebitda) ? netBorc / fd.ebitda : null;
  const gavTry = (m.gav_eur && eurTry) ? m.gav_eur * eurTry : null;
  const canliLtv = (netBorc != null && gavTry) ? (netBorc / gavTry) * 100 : null;

  const esikSatir = esikler.map(e => {
    const temel = `  - ${e.ad}: eşik ${e.yon === 'ust' ? '>' : '<'} ${e.esik} ${e.birim}`;
    if (e.canli_kontrol && e.metrik === 'net_borc_favok' && canliNetBorcFavok != null) {
      return `${temel} | manuel ${m.net_borc_favok}x (${m.guncelleme_tarihi}) | TradingView'den türetilen güncel ≈ ${say(canliNetBorcFavok, 1)}x (net borç/FAVÖK TTM — tanım farkı olabilir)`;
    }
    if (e.canli_kontrol && e.metrik === 'ltv_yuzde' && canliLtv != null) {
      return `${temel} | manuel %${m.ltv_yuzde} (${m.guncelleme_tarihi}) | TradingView net borcu ile rapor GAV'ı üzerinden ≈ %${say(canliLtv, 1)}`;
    }
    return `${temel} | SON MANUEL VERİ İTİBARIYLA (${m.guncelleme_tarihi}) — canlı veriyle doğrulanamıyor, güncel durum gibi sunma`;
  }).join('\n');

  const kira = m.kira_yapisi || {};
  const dg = m.degerleme || {};
  const hy = m.hissedar_yapisi || {};

  return `
═══ MANUEL TEZ VERİSİ — ${m.ticker} ═══
KAYNAK: ${kaynakEtiket}${m.rapor_tarihi ? ` · değerleme raporu ${m.rapor_tarihi}` : ''}

BU BLOK OLGU VERİSİDİR. Bir yatırım görüşü değil. Tezin sinyali,
senaryoları, giriş bandı ve hedef fiyatı sana BİLEREK verilmedi —
aşağıdaki olgulardan KENDİ bağımsız değerlendirmeni yapacaksın.

ÖNCELİK KURALI: Aşağıdaki veriler TradingView ile AYNI kalemde çakışırsa
(net aktif değer, borç yapısı, doluluk vb.) BUNLARI kullan ve kaynağı
"${kaynakEtiket}" olarak belirt. Çakışmayan kalemlerde TradingView verisini
kullanmaya devam et. İki kaynağın da olmadığı yerde rakam ÜRETME.

NAD İSKONTOSU (sabit rakam kullanma, aşağıdaki canlı hesabı kullan):
${nadMetin}

KİRA YAPISI: ${kira.para_birimi || '—'} · endeks: ${kira.endeks || '—'}
  Kiracı ciro artışı (6A26) %${kira.kiraci_ciro_artisi_6a26} vs TÜFE %${kira.ortalama_tufe} · hazır giyim %${kira.hazir_giyim_ciro_artisi} vs TÜFE %${kira.hazir_giyim_tufe}
  Doluluk %${m.doluluk_yuzde} · OCR %${m.ocr_yuzde} (2024: %8,6, küresel emsal %9-10)
  NOI 6A25 ${(kira.noi_6a25_eur / 1e6).toFixed(1)} mn € → 6A26 ${(kira.noi_6a26_eur / 1e6).toFixed(1)} mn € (+%${kira.noi_buyume_yuzde})
    satın alma katkısı +${(kira.noi_satin_alma_katkisi_eur / 1e6).toFixed(1)} mn € · ORGANİK +${(kira.noi_organik_katki_eur / 1e6).toFixed(1)} mn € (organik € büyüme +%${kira.noi_organik_buyume_yuzde})
  FCF 6A26 ${(kira.fcf_6a26_eur / 1e6).toFixed(0)} mn € (yıllıklandırılmış ~%${kira.fcf_getirisi_yillik_yuzde} FCF getirisi)
  Borç: ${(kira.borc_eur / 1e6).toFixed(0)} mn € + ${(kira.borc_usd / 1e6).toFixed(1)} mn $ · faiz ${kira.faiz_bandi} · Fitch ${kira.fitch}
  Net döviz yükümlülüğü ${(m.net_doviz_yukumluluk_eur / 1e6).toFixed(0)} mn € · net borç/FAVÖK ${m.net_borc_favok}x · LTV %${m.ltv_yuzde}
  Temettü 2026: brüt ${kira.temettu_brut_tl} TL/hisse, %${kira.stopaj_yuzde} stopaj
  GYO STATÜSÜ: ${m.gyo_statusu ? 'EVET' : 'HAYIR'}${m.gyo_statusu ? '' : " — kurumlar vergisi muafiyeti YOK, bilançoda ertelenmiş vergi yükümlülüğü var, DEFTER DEĞERİ NET AKTİF DEĞERİ OLDUĞUNDAN DÜŞÜK GÖSTERİR. Defter değerini NAD vekili olarak kullanma, yukarıdaki EPRA NAD'ı kullan."}
  Ana risk: ${kira.ana_risk || '—'}

DEĞERLEME RAPORU (${m.rapor_tarihi}, ${dg.sirket || '—'}, rapor kuru ${m.rapor_kuru_eur_try} TL/€):
  GAV ${(m.gav_eur / 1e6).toFixed(0)} mn € · ${dg.portfoy || '—'}
  İlk yıl net gelir/değer %${dg.ilk_yil_getiri_yuzde} · çıkış kapitalizasyon %${dg.cikis_kap_orani_yuzde}
  Rapor varsayımı: ${dg.varsayim || '—'}
  ${dg.optimum_istanbul || ''}
  PİYASANIN İMA ETTİĞİ: firma değeri ~${(dg.piyasa_ima_firma_degeri_eur / 1e9).toFixed(1)} mlr € · ~${dg.piyasa_ima_m2_eur} €/m² (rapor ~${dg.rapor_m2_eur} €/m²) · ima edilen NOI getirisi ~%${dg.piyasa_ima_noi_getirisi_yuzde} (€)

KIRILMA EŞİKLERİ — her birinin ŞU ANKİ durumunu kontrol et:
${esikSatir}

KONTROL NOKTALARI:
${kn.map(k => `  - ${k.tarih} · ${k.olay} · izlenecek: ${k.izlenecek}`).join('\n')}${bayatMetin}

HİSSEDAR YAPISI: ${hy.ana_ortak || '—'} %${hy.ana_ortak_pay} (${hy.ana_ortak_not || ''})
  ${hy.gic || ''}
  Yabancı payı (${hy.yabanci_payi?.kaynak || '—'}): yıl başı %${hy.yabanci_payi?.yil_basi} → %${hy.yabanci_payi?.['2026-10-06']}

BÖLÜMLERE DAĞITIM — bu veriyi şu kriterlerde kullan:
  ANLATI  : piyasanın ima ettiği ~${dg.piyasa_ima_m2_eur} €/m² ile rapor ~${dg.rapor_m2_eur} €/m² farkı ve NAD iskontosu
  MOTOR   : kiracı ciro artışı vs TÜFE, hazır giyim cirosu, € bazında ORGANİK NOI büyümesi (satın alma katkısını ayırarak)
  KALITE  : doluluk, OCR, € bazında FCF
  BILANCO : net borç/FAVÖK, LTV, döviz borç yapısı, net döviz yükümlülüğü ve devalüasyon riski
  FIYAT   : NAD iskontosu, piyasanın ima ettiği €/m² ile rapor değeri farkı,
            ilk yıl net gelir/değer ve çıkış kapitalizasyon oranı üzerinden
            KENDİ adil giriş bölgeni belirle. Hazır bir bant verilmedi.
  KATALIZOR: kontrol noktaları
  BOZULMA : kırılma eşikleri ve her birinin şu anki durumu

═══ MANUEL VERİ SONU ═══

`;
}

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
  /* Fonksiyon penceresi 60 sn (vercel.json). Veri çekme + model denemeleri
     bu bütçeyi paylaşıyor; 54 sn'de durup düzgün hata dönmek, 60'ta Vercel
     tarafından kesilip HTML hata sayfası döndürmekten iyi. */
  const T0 = Date.now();
  const kalanSure = () => 54000 - (Date.now() - T0);

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

  const { ticker, exchange, email, framework, oturum } = req.body || {};

  // Ticker sanitize — sadece harf/rakam/nokta, max 12 karakter
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });
  const cleanTicker = String(ticker).toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
  if (!cleanTicker) return res.status(400).json({ error: 'Geçersiz ticker' });
  /* Harfsiz ticker kabul edilmiyor. 12 Ekim 2026'da uca ticker=1,2,3…14
     diye sırayla istek atıldı; rakamlar bu filtreden geçtiği için hepsi
     geçerli sayıldı, AI'a gitti ve para harcattı. BIST, NYSE ve NASDAQ
     sembollerinin hepsinde en az bir harf var. */
  if (!/[A-Z]/.test(cleanTicker)) return res.status(400).json({ error: 'Geçersiz ticker' });

  // Tek çerçeve var: Barış Investing. Eski bağlantılar (fw=buffett gibi)
  // hâlâ geliyor olabilir, hepsi buraya düşüyor.
  const fw = 'baris';
  const exLabel = exchange === 'BIST' ? 'BIST' : exchange === 'NYSE' ? 'NYSE' : 'NASDAQ';

  /* Barış Investing çerçevesi — yedi kriter, günlük GARP taramasının
     (pipeline/global_pipeline.py) mantığıyla aynı hizada. Alan adları
     istemcideki ayrıştırıcıyla birebir aynı, bozma. */
  /* Sıra önemli: cevap kesilirse en değerli kısım hayatta kalsın.
     Yedek model 1100 token tavanıyla çalışıyor; kriterler sona kalınca
     BIST analizlerinde yarısı boş dönüyordu. Kriterler önce yazılıyor. */
  const prompt = `${exLabel} borsasındaki "${cleanTicker}" hissesini Barış Investing çerçevesiyle analiz et.

TICKER: ${cleanTicker}
TOTAL_SCORE: X
GARP_SKOR: [0-100]
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [tek cümlede tez: piyasa neyi fiyatlıyor, rakamlar ne diyor, senin duruşun ne]
RISK: [en can alıcı risk, 1 cümle]

CRITERIA_START
ANLATI: PASS|FAIL|NEUTRAL | [açıklama]
MOTOR: PASS|FAIL|NEUTRAL | [açıklama]
KALITE: PASS|FAIL|NEUTRAL | [açıklama]
BILANCO: PASS|FAIL|NEUTRAL | [açıklama]
FIYAT: PASS|FAIL|NEUTRAL | [açıklama]
KATALIZOR: PASS|FAIL|NEUTRAL | [açıklama]
BOZULMA: PASS|FAIL|NEUTRAL | [açıklama]
CRITERIA_END

METRIKLER_START
[metrik adı] | [değer] | [tek cümle yorum]
[metrik adı] | [değer] | [tek cümle yorum]
[metrik adı] | [değer] | [tek cümle yorum]
METRIKLER_END

ADIL_DEGER: [adil değer bandı] | [nasıl hesaplandı]
ADIL_GIRIS: [giriş bölgesi] | [tek cümle gerekçe]
IZLENECEK: [metrik ve eşik] | [ne zaman test edilecek]
PORTFOY: [portföydeki rol, NİTEL] | [bu rolü ne sınırlar]
HEDEF: [12 aylık hedef fiyat bandı] | [yukarı potansiyel %]`;


  // Server-side kredi kontrolü
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

  /* ── ANALİZ KAYDI ────────────────────────────────────────────────
     Kota kapısı yalnızca "kaç analiz yapıldı" sayıyordu (total_used);
     hangi hisseye bakıldığı hiçbir yere yazılmıyordu. Her istek —
     başarılı da hatalı da — analiz_kayitlari tablosuna düşüyor.
     Yanıtı bekletmiyoruz: insert hata verse bile analiz dönmeli. */
  const istekBasi = Date.now();
  /* NOT: bu çağrı BEKLENMELİ. Sunucusuz ortamda yanıt döndüğü anda
     örnek donduruluyor; beklenmeyen fetch bazen Supabase'e hiç
     ulaşmıyordu (kayıtların bir kısmı düşüyor, bir kısmı düşmüyordu).
     ~100 ms'lik gecikme, eksik veriye tercih edilir. */
  /* IP'nin kendisi saklanmıyor; misafir sayacının sayabilmesi için tuzlu
     özeti yetiyor. Tuz olarak servis anahtarı kullanılıyor — zaten gizli,
     yeni bir ortam değişkeni eklemeye gerek kalmıyor. */
  const ipIzi = (SB_KEY && ip && ip !== 'unknown')
    ? crypto.createHash('sha256').update(SB_KEY + '|' + ip).digest('hex').slice(0, 32)
    : null;

  const kayitYaz = async (alanlar) => {
    if (!SB_URL || !SB_KEY) return;
    const govde = {
      ticker: cleanTicker,
      exchange: exLabel,
      email: email ? String(email).toLowerCase().trim().slice(0, 200) : null,
      oturum: oturum ? String(oturum).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : null,
      ip_iz: ipIzi,
      sure_ms: Date.now() - istekBasi,
      ...alanlar,
    };
    const yaz = (g) => fetch(`${SB_URL}/rest/v1/analiz_kayitlari`, {
      method: 'POST',
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify(g),
      signal: AbortSignal.timeout(3000),
    });
    try {
      let r = await yaz(govde);
      if (!r.ok) {
        const metin = await r.text();
        /* ip_iz sütunu henüz eklenmediyse (göç çalıştırılmadıysa) kayıt
           tamamen kaybolmasın: o alan olmadan bir kez daha dene. */
        if (metin.includes("'ip_iz'")) {
          const { ip_iz, ...sade } = govde;
          r = await yaz(sade);
        }
        if (!r.ok) dlog('[kayit] reddedildi:', r.status, metin.slice(0, 200));
      }
    } catch (e) {
      dlog('[kayit] yazilamadi:', e.message);   // kayıt hatası analizi asla bozmaz
    }
  };
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
          await kayitYaz({ durum: 'hata', hata: 'kota_doldu' });
          return res.status(403).json({ error: 'Analiz hakkınız doldu.' });
        }
      }
    } catch(e) { dlog('[Kredi kontrol] hata:', e.message); }
  }

  /* ── MİSAFİR GÜNLÜK SINIRI ────────────────────────────────────────
     Yukarıdaki kredi kontrolü "kullanıcıyı mail tanır" varsayımıyla
     yazılmıştı: mail yoksa bakılacak satır da yok, blok tamamen
     atlanıyordu. Misafir sınırı yalnızca tarayıcıdaki guest_credits'te
     duruyordu — site verisini temizlemek ya da doğrudan uca istek atmak
     onu baypas ediyor.

     Handler başındaki checkRateLimit bir patlama freni (10/dk) ve
     BELLEKTE tutuluyor: soğuk başlangıçta sıfırlanıyor, paralel çalışan
     her örneğin kendi sayacı oluyor. 12 Ekim 2026'da 17 analiz 14 dakikaya
     yayılınca o frenden rahatça geçti ve ~$0,25 harcattı.

     Bu sayaç kalıcı: analiz_kayitlari'nda son 24 saatteki BAŞARILI
     analizlere bakıyor. Sütun henüz eklenmemişse sorgu dizi döndürmüyor
     ve sınır uygulanmıyor — analiz hiçbir koşulda bu yüzden kırılmıyor. */
  const MISAFIR_GUNLUK = 3;   // istemcideki guest_credits ile aynı
  if (SB_URL && SB_KEY && !em && ipIzi) {
    try {
      const gecmis24 = new Date(Date.now() - 86400000).toISOString();
      const r = await fetch(
        /* email=is.null ŞART: sayaç yalnızca MİSAFİR analizlerini saymalı.
           Aksi hâlde aynı IP'den giriş yapmış bir kullanıcının (ya da
           admin'in) analizleri oradaki misafirlerin hakkını yiyor — ev,
           ofis ya da NAT arkasındaki herkes tek kotayı paylaşırdı. */
        `${SB_URL}/rest/v1/analiz_kayitlari?ip_iz=eq.${ipIzi}&durum=eq.ok&email=is.null`
        + `&olusturma=gte.${gecmis24}&select=id&limit=${MISAFIR_GUNLUK}`,
        {
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
          signal: AbortSignal.timeout(4000),
        }
      );
      if (r.ok) {
        const satirlar = await r.json();
        if (Array.isArray(satirlar) && satirlar.length >= MISAFIR_GUNLUK) {
          await kayitYaz({ durum: 'hata', hata: 'misafir_kota' });
          return res.status(403).json({
            error: 'Günlük ücretsiz analiz hakkın doldu. E-postanı bırakırsan hakkın hemen yenilenir.',
            kota: 'misafir',
          });
        }
      }
    } catch (e) { dlog('[misafir kota] hata:', e.message); }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  const isBIST = exchange === 'BIST';
  const yahooTicker = isBIST ? `${cleanTicker}.IS` : cleanTicker;
  /* Manuel tez verisi ve EUR/TRY kuru — TradingView çağrısıyla PARALEL
     başlıyor. Kritik yol onlar değil; gelmezlerse analiz onlarsız sürüyor. */
  const manuelSoz = isBIST ? tezVerisiGetir(cleanTicker) : Promise.resolve(null);
  const kurSoz    = isBIST ? eurTryGetir() : Promise.resolve(null);

  let financialData = null;
  let veriHatasi = null;
  try {
    // Veri çekmeye kesin üst süre. Bütçe: veri 8sn + AI 30sn + haiku yedeği
    // 15sn = ~53sn < maxDuration 60sn. BIST: TV (5sn) + Yahoo takviye (2.5sn).
    const dataFetch = isBIST
      ? fetchBISTFast(cleanTicker)      // BIST → rasyolar TV + sahiplik/analist Yahoo
      : fetchYahooData(yahooTicker);    // US → Yahoo
    financialData = await Promise.race([
      dataFetch,
      new Promise((_, rej) => setTimeout(() => rej(new Error('veri-suresi-doldu')), 8000)),
    ]);
  } catch(e) { veriHatasi = e.message; dlog('Fetch failed/timeout:', e.message); }

  /* Hiç veri gelmediyse sembol muhtemelen yok: AI'a gitmeden dönüyoruz,
     var olmayan bir sembol için para harcanmasın.

     Zaman aşımı AYRI tutuluyor: gerçek bir hissenin verisi yavaş geldiği
     için analiz reddedilmesin, orada eski davranış (eksik veriyle analiz)
     korunuyor. */
  if (!financialData && veriHatasi !== 'veri-suresi-doldu') {
    await kayitYaz({ durum: 'hata', hata: 'veri-yok' });
    return res.status(422).json({ error: 'Bu sembol için veri bulunamadı. Ticker’ı kontrol et.' });
  }

  const fd     = financialData;

  /* Paralel başlayan iki çağrıyı topla. 2,5 sn'den uzun sürerlerse
     onlarsız devam: manuel veri analizi bloke etmemeli. */
  const bekle = (soz) => Promise.race([soz, new Promise(r => setTimeout(() => r(null), 2500))]);
  const manuelVeri = await bekle(manuelSoz).catch(() => null);
  const eurTryKuru = await bekle(kurSoz).catch(() => null);

  /* ═══ BARIŞ INVESTING ANALİST PROMPTU ═══════════════════════════
     Yöntem sitedeki tezlerden çıkarıldı (ServiceNow, UnitedHealth,
     Broadcom, Marvell, USA Rare Earth, Microsoft): her tezin merkezinde
     piyasanın anlatısı ile bilançonun çatışması var, fiyat disiplini
     ayrı bir karar, tez somut bir eşikle çürütülebiliyor.
     GARP bantları günlük taramayla (pipeline/global_pipeline.py) aynı. */
  const systemPrompt = `Sen "Barış Investing"in baş analistisin. Bir efsaneyi (Buffett, Lynch…) taklit etmiyorsun; evin kendi yöntemiyle yazıyorsun. DİL: tarafsız üçüncü şahıs. Olgun, akıcı, net. Pozisyon sahibi gibi konuşma — "benim tarafımda", "lehime", "pozisyonumu büyütürüm" gibi ifadeler kullanma; değerlendirme şirket hakkındadır.

YÖNTEM — TEZ KURMA:
1) ÇATIŞMAYI BUL. Her tezin merkezinde tek bir soru var: piyasanın bu şirkete dair fiyatladığı anlatı ile rakamların söylediği şey ayrışıyor mu? "Piyasa X'i fiyatlıyor; oysa bilanço Y diyor" cümlesini kurabiliyor musun? Ayrışma yoksa bunu da açıkça söyle — her hissede fırsat yoktur.
2) ŞİRKETE ÖZGÜ METRİKLE KONUŞ. Jenerik oran listesi (F/K, ROE) yetmez; işi ne anlatıyorsa onu kullan: yazılımda cRPO/RPO/ACV/yenileme oranı/net dolar genişlemesi, sağlık sigortasında MCR, yarı iletkende brüt marj ve kapasite/fiyat döngüsü, perakendede aynı mağaza satışı ve stok devri, bankada net faiz marjı ve takip oranı, madencilikte tenör/üretim/ayrıştırma kapasitesi. Bu metrikler veride yoksa şirket hakkındaki bilginle konuş ve bunun tahmin olduğunu belirt.
3) RAKAMIN ALTINI KAZ. Manşet rakamı olduğu gibi kabul etme: raporlanan büyüme ile sabit kur büyümesi, tek seferlik etkiler, hisse bazlı ödemeler (SBC gerçek bir giderdir), tam sulandırılmış hisse sayısıyla gerçek piyasa değeri, muhasebe kârı ile nakit arasındaki fark. Piyasanın atladığı detayı bulmak bu analizin en değerli kısmı.
4) FİYAT AYRI BİR KARARDIR. Kaliteli şirket her fiyattan alınmaz. "Adil giriş bölgesi" belirle ve fiyat oranın üstündeyse net söyle: kaliteyi teslim et, fiyatın peşinden koşma. Bu durumda karar İZLE'dir, AL değil.
5) TEZİ ÇÜRÜTECEK EŞİĞİ YAZ. Somut olacak: hangi metrik, hangi eşiğin altına/üstüne giderse tez çöker, ve bu ne zaman test edilecek (bilanço tarihi, katalizör penceresi). "Riskler artabilir" gibi cümleler değersizdir.
6) PORTFÖY ROLÜNÜ SÖYLE. Bu şirket bir portföyde ne işe yarar (dolar bazlı çapa, döngüsel opsiyon, temettü omurgası…) ve makul ağırlık tavanı nedir. Yüksek belirsizlikli hikâyelerde tavan düşüktür.

DEĞERLEME REFERANSI (günlük GARP taramamızla aynı bantlar — mekanik kural değil, referans; saparsan nedenini yaz):
- F/K: 10-18 ideal · 18-28 kabul · 28-45 pahalı · 45+ veya negatif eleme sebebi
- PD/DD: 2 altı ideal · 4'e kadar iyi · 7'ye kadar tolere · 12 üstü elenir
- FD/FAVÖK: 8-12 ideal · 18'e kadar kabul · 25 üstü pahalı
- ROE: %20-40 ideal · %10-20 kabul · %10 altı zayıf · %40 üstü kaldıraçtan mı diye bak
- Büyüme (YoY): %15-30 ideal · %30-60 iyi ama sürdürülebilirliğini sorgula · %5 altı motor yok
- Borç/Özsermaye 2 üstü skoru kırar, 3 üstü tek başına FAIL sebebidir
- Teknik teyit: RSI 30-50 en iyi giriş bandı · 30 altı dip ama düşen bıçak riski · 70 üstü ısınmış · 50 günlük ortalama 200 günlüğün üstündeyse trend teyit ediyor
- Sektör farkını gözet: bankanın F/DD'si ile yazılımın F/DD'si aynı ölçüde okunmaz. Yüksek çarpan, kontratlı gelir görünürlüğü ve marj kalıcıysa yapısal olabilir — bunu savunabiliyorsan savun.

ÜSLUP:
- Konuşma dili: akıcı, samimi, profesyonel. Zeki bir yatırımcı arkadaşına anlatır gibi.
- RAKAMI YORUMLA, TEKRAR ETME. "F/K 11,5" deme; "11,5 F/K ile sektörün belirgin altında, piyasa büyümeye inanmıyor" de.
- Fikrin net olsun ama kaba olma. "Çöp", "aptalca", "berbat" gibi küçümseyici/argo kelimeler kullanma. Beğenmediğinde nedenini olgun ve gerekçeli anlat. Net taraf tut, ortada kalma.
- ASLA "kesin al", "kesin sat", "garanti", "kaçırma" deme. Bunun yerine "güçlü aday", "fiyat henüz gelmemiş", "tez çalışmıyor" gibi ifadeler kullan. Bu bir yatırım tavsiyesi değil, bir tezdir.
- Emin olmadığında emin değilim de. Veri yoksa uydurma; neyi bilmediğini söylemek analizin değerini artırır.
- Klişe/dolgu cümle ("uzun vadede sabır önemli") yasak. Her yargı bir rakama yaslanacak.

FORMAT (ASLA BOZMA):
- Düz metin, markdown YOK (#, *, - kullanma). Tüm alan ve anahtar isimlerini şablonla birebir aynı yaz.
- TOTAL_SCORE: 0-7 tam sayı (PASS sayısıyla tutarlı). GARP_SKOR: 0-100 arası, değerleme+büyüme+kârlılık bantlarına göre kendi hesabın.
- Her kriter: "KEY: PASS|FAIL|NEUTRAL | açıklama". Açıklama düşünülmüş olacak: rakam + o rakamın sektöre/geçmişe göre ne anlama geldiği + net karar. Rakamı tekrar eden satır yazma; veri okuyucusu değil analistsin. NEUTRAL'ı sadece veri gerçekten yoksa kullan, o zaman bile neye bakılması gerektiğini yaz.
- BÜTÇENİ DAĞIT: tezin kaderini belirleyen 2-3 kriterde 3-4 cümle yaz, kalan kriterlerde 1-2 cümleyle geç. Hepsini uzun yazarsan cevap sonuna varamadan kesilir ve adil giriş, izlenecek eşik, metrikler bölümleri boş kalır — bu bölümler tezin en değerli kısmı, onlara mutlaka sıra gelsin.
- 7 kriterin tamamını bitir. Cevabın kesilmemesi için önce kriterleri, sonra tez alanlarını yaz.
- SUMMARY: tek cümlede tez — çatışmayı ve net duruşu içersin. RISK: en can alıcı risk, 1 cümle.
- ADIL_GIRIS: fiyat aralığı + tek cümle gerekçe. IZLENECEK: metrik + eşik + ne zaman test edileceği. PORTFOY: rol + ağırlık tavanı.
- METRIKLER: bu şirketin işini anlatan ÜÇ operasyonel metrik — jenerik oran (F/K, ROE, marj) YAZMA, onlar zaten ekranda. Sektöre göre seç: yazılımda cRPO/ACV/yenileme oranı/net dolar genişlemesi, sigortada bileşik oran/prim üretimi/teknik kâr, bankada net faiz marjı/takip oranı/kredi mevduat, havacılıkta doluluk/birim gelir (RASK)/akaryakıt maliyeti, perakendede aynı mağaza satışı/stok devri/m² başına ciro, yarı iletkende brüt marj/kapasite kullanımı/sipariş defteri, madencilikte tenör/üretim/nakit maliyet, enerjide üretim kapasitesi/spread. Değeri biliyorsan yaz, bilmiyorsan "veri yok" yaz ama metriği yine de göster — hangi metriğe bakılacağını söylemek de bilgidir. Uydurma rakam yazma.

KRİTERLERİN ANLAMI:
- ANLATI: Piyasanın fiyatladığı hikâye ile rakamlar ayrışıyor mu? Ayrışma senin lehine ise PASS, piyasa haklıysa FAIL.
- MOTOR: Büyümeyi ne sürüklüyor, ivme artıyor mu? Şirkete özgü metrikle kanıtla.
- KALITE: Marj, sermaye verimliliği, nakde dönüşüm, müşteri yapışkanlığı.
- BILANCO: Borç, net nakit, sulandırma ve SBC dahil gerçek maliyet.
- FIYAT: Değerleme bantları + adil giriş bölgesi. Kalite yüksek ama fiyat yüksekse burada FAIL vermekten çekinme.
- KATALIZOR: Önümüzdeki 6-12 ayda tezi çalıştıracak tarihli olay + teknik teyit.
- BOZULMA: Tezi çürütecek somut eşik tanımlanabiliyor ve risk-getiri asimetrisi lehine mi?

${isBIST ? bistKurallari(fd?.industry) : ""}`;

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

    /* Unix saniyeyi okunur döneme çevir. TradingView dönem sonlarını
       epoch saniye veriyor; bot "hangi döneme bakıyorum" diyebilsin. */
    const don = (v) => {
      if (v == null) return null;
      const d = new Date(Number(v) * 1000);
      if (isNaN(d.getTime())) return null;
      return trTarih(d);
    };
    const fqDon = don(fd.donemSonuFQ), fyDon = don(fd.yillik?.donemSonu);
    const sonraki = don(fd.sonrakiBilanco);

    /* Makro referanslar config'den geliyor. TANIMLI DEĞİLSE hiçbir rakam
       uydurulmuyor: prompt'a "elimde yok" notu düşüyor. Eski davranış
       modele "sektör ortalaması kullan" diyordu, uydurmanın kaynağı oydu. */

    let warnings = '';
    if (isBIST && fd.peRatio==null)  warnings += 'F/K verisi YOK — "bu veri elimde yok" de. Sektör ortalamasıyla DOLDURMA.\n';
    if (isBIST && fd.pbRatio==null)  warnings += 'F/DD verisi YOK — "bu veri elimde yok" de, tahmin etme.\n';
    /* BIST'te Yahoo'nun kurumsal sahiplik oranı güvenilmez (takas verisiyle
       tutmuyor). Hiç beslemiyoruz; model de bu konuda yorum yapmıyor.
       Manuel veride hissedar yapısı varsa onu kullanıyor. */
    if (isBIST) warnings += 'Kurumsal sahiplik verisi beslenmiyor — bu konuda oran yazma ve yorum yapma; manuel veride hissedar yapısı varsa yalnızca onu kullan.\n';
    if (isBIST) warnings += 'Insider alım/geri alım verisi beslenmiyor — bu kriterde NEUTRAL ver ve "veri yok" yaz.\n';
    if (isBIST) {
      const eksik = bistMakroEksikler();
      if (eksik.length) warnings += `Makro referans eksik (${eksik.join(', ')}) — BIST kural setinde "VERİ YOK" yazan maddeleri ATLA, bu rakamları tahmin etme.\n`;
    }
    if (fd.dataSource !== 'Yahoo')   warnings += `VERİ KAYNAĞI: ${fd.dataSource}\n`;

    enrichedPrompt = `GERÇEK FİNANSAL VERİLER [${fd.dataSource}] — BU RAKAMLARI KULLAN:
Fiyat: ${fd.currentPrice ? `${Number(fd.currentPrice).toFixed(2)} ${fd.currency}` : 'N/A'}
52H Aralık: ${n(fd.fiftyTwoWeekLow,2)} - ${n(fd.fiftyTwoWeekHigh,2)} ${fd.currency||''}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${n(fd.peRatio)} | F/K Forward: ${n(fd.forwardPE)} | F/DD: ${n(fd.pbRatio)}${pbNote}
PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)}${roeNote} | ROA: ${p(fd.roa)}
Brüt Marj: ${p(fd.grossMargin)} | Faaliyet Marjı: ${p(fd.operatingMargin)} | Net Marj: ${p(fd.profitMargin)}
FAVÖK: ${big(fd.ebitda)} | Hasılat: ${big(fd.totalRevenue)} | FAVÖK Marjı: ${(fd.ebitda != null && fd.totalRevenue) ? `%${(fd.ebitda / fd.totalRevenue * 100).toFixed(1)}` : 'N/A'}
FCF: ${big(fd.freeCashflow)} | Op.CF: ${big(fd.operatingCashflow)}
Nakit: ${big(fd.totalCash)} | Borç: ${big(fd.totalDebt)} | Net Nakit: ${big(nc)}
Borç/Özsermaye: ${n(fd.debtToEquity)}% (YÜZDE — 20,6 demek 0,21 kat demektir, 20,6 kat DEĞİL) | Cari Oran: ${n(fd.currentRatio)} (kat)
Gelir Büyümesi (TTM, YoY): ${p(fd.revenueGrowth)} | Kazanç Büyümesi (TTM, YoY): ${p(fd.earningsGrowth)}
${fd.institutionOwnership != null ? `Kurumsal Sahiplik: ${p(fd.institutionOwnership)}` : ''}
${fd.rsi != null ? `RSI(14): ${Number(fd.rsi).toFixed(0)} — MULTIPLES bölümündeki RSI satırında BU değeri kullan\n` : ''}Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${n(fd.targetMeanPrice,2)} | Potansiyel: ${upside ? `%${upside}` : 'N/A'}
${fd.sector ? `Sektör: ${fd.sector}${fd.industry ? ' / '+fd.industry : ''}` : ''}
${fd.totalAssets ? `
MALİ TABLO — ÇEYREK${fqDon ? ` (dönem sonu ${fqDon})` : ''}:
  Toplam Aktif: ${big(fd.totalAssets)} | Toplam Yükümlülük: ${big(fd.totalLiabilities)} | Özkaynak: ${big(fd.computedEquity)}
  Net Kâr (çeyrek): ${big(fd.netIncome)} | Hasılat (çeyrek): ${big(fd.ceyrekHasilat)}` : ''}
${fd.yillik && fd.yillik.aktif ? `MALİ TABLO — YILLIK${fyDon ? ` (mali yıl sonu ${fyDon})` : ''}:
  Toplam Aktif: ${big(fd.yillik.aktif)} | Toplam Yükümlülük: ${big(fd.yillik.borc)} | Özkaynak: ${big(fd.yillik.ozkaynak)}
  Net Kâr (yıllık): ${big(fd.yillik.netKar)} | Hasılat (yıllık): ${big(fd.yillik.hasilat)}
  Hasılat Büyümesi (yıllık, YoY): ${p(fd.yillik.hasilatBuyume)} | Net Kâr Büyümesi (yıllık, YoY): ${p(fd.yillik.karBuyume)}` : ''}
${fd.totalRevenue != null || fd.netIncomeTTM != null ? `SON 12 AY (TTM): Hasılat: ${big(fd.totalRevenue)} | Net Kâr: ${big(fd.netIncomeTTM)} | FAVÖK: ${big(fd.ebitda)}` : ''}
${sonraki ? `Sonraki bilanço tarihi: ${sonraki}` : ''}

${warnings ? '\nUYARILAR:\n'+warnings : ''}
MULTIPLES: PE=${n(fd.peRatio)} PB=${n(fd.pbRatio)} PEG=${n(fd.pegRatio)} EV_EBITDA=${n(fd.evEbitda)}
---
`;
  }

  /* Manuel blok veri bloğunun HEMEN ARDINDAN, soru metninden ÖNCE:
     öncelik kuralı TradingView rakamlarını gördükten sonra okunmalı. */
  if (manuelVeri) enrichedPrompt += manuelBlok(manuelVeri, fd, eurTryKuru);

  enrichedPrompt += prompt;

  /* ── ÇIKTI DİSİPLİNİ ───────────────────────────────────────────────
     Hepsi canlı RGYAS çıktısında görülen somut hatalardan çıktı:
     giriş bölgesi adil değerin üstünde kaldı, net döviz borcu olan bir
     şirket "TL değer kaybına karşı koruma" diye tanımlandı, portföy
     rolüne uydurma bir yüzde ağırlık yazıldı, GYO olmayan şirkete GYO
     dendi ve veride olmayan emsal iskonto oranları üretildi. */
  enrichedPrompt += `

ÇIKTI DİSİPLİNİ — HEPSİ ZORUNLU:

1) ADIL_DEGER ve ADIL_GIRIS. Varlık bazlı şirketlerde (gayrimenkul,
   holding, yatırım şirketi) ikisi AYRI şeydir:
   - ADIL_DEGER = net aktif değer üzerinden hesaplanan değer aralığı.
   - ADIL_GIRIS = adil değerin ALTINDA, güvenlik payı bırakan alım aralığı.
   GİRİŞ BÖLGESİ HİÇBİR ZAMAN adil değer bandının ya da 12 aylık hedefin
   ÜSTÜNDE olamaz. Varlık bazlı değilse ADIL_DEGER satırına "—" yaz.

2) DÖVİZ POZİSYONU. Şirketin kur hareketinden nasıl etkilendiği NET DÖVİZ
   POZİSYONUNA ve gelirin para birimine göre belirlenir. Net döviz
   YÜKÜMLÜLÜĞÜ olan ve geliri TL olan bir şirket, TL değer kaybına karşı
   koruma DEĞİLDİR — tam tersine kur riski taşır. Risk bölümünde kur
   riski yazıp portföy rolünde "kur koruması" demek çelişkidir, yapma.

3) PORTFÖY ROLÜ NİTELDİR. "%6-8 ağırlık" gibi yüzde öneri YAZMA; rolün ne
   olduğunu ve neyin sınırladığını anlat.

4) ŞİRKET TÜRÜ. Bir şirkete yalnızca GYO statüsündeyse "GYO" de. Değilse
   "gayrimenkul şirketi" yaz. Veride olmayan emsal çarpan ya da iskonto
   aralığı ("benzer şirketlerde %30-40 iskonto olur" gibi) ÜRETME —
   elinde emsal verisi yoksa karşılaştırma yapmadığını söyle.

5) DİL. Tarafsız üçüncü şahısla yaz. "Rakamlar benim tarafımda", "lehime",
   "pozisyonumu büyütürüm" gibi pozisyon sahibi bir anlatım KULLANMA.
   Değerlendirme şirket hakkındadır, yazarın portföyü hakkında değil.

6) DURUM ETİKETİ. Bir kriterin değerlendirmesi için gereken verinin bir
   kısmı eksikse ve kalan veri net bir sonuç vermiyorsa PASS verme,
   NEUTRAL ver ve hangi verinin eksik olduğunu yaz.`;
  enrichedPrompt += '\n\nKRİTİK KURAL: Yukarıdaki gerçek rakamları kullan, uydurma. Her PASS/FAIL/NEUTRAL satırı pipe (|) ile açıklama içermeli, CRITERIA_START/CRITERIA_END eksiksiz olmalı. 7 kriterin TAMAMINI yaz, hiçbirini atlama. ADIL_GIRIS, IZLENECEK, PORTFOY ve METRIKLER bölümlerini de doldur — tezin değeri orada. Olgun ve akıcı yaz, küçümseyici/argo kelime kullanma.\n\nDÜŞÜNME TALİMATI: Bu bir veri özeti değil, bir tez. Ekrandaki rakamları tekrar etmek analiz değildir — kullanıcı onları zaten görüyor. Senden beklenen: rakamların birbiriyle çeliştiği yeri bulmak (marj düşerken ciro büyüyorsa neden), piyasanın atladığı detayı görmek, ve "bu fiyat neyi varsayıyor, o varsayım tutar mı" sorusunu cevaplamak. Cevabı yazmadan önce hangi iki-üç kriterin bu hissede belirleyici olduğunu kendine sor, derinliği oraya harca.';
  /* Uydurmayı kapatan kural. Eskiden burada "sektör bilgine göre tahmin
     yürüt" yazıyordu; modelin olmayan rakamı üretmesinin kaynağı buydu. */
  enrichedPrompt += '\n\nVERİ DÜRÜSTLÜĞÜ — İHLAL EDİLEMEZ: Yalnızca yukarıdaki blokta sana VERİLEN rakamları kullan. Bir alan N/A ise ya da hiç yoksa, o rakamı tahmin etme, hatırladığın/bildiğin bir değerle doldurma, sektör ortalamasıyla ikame etme. Açıkça "bu veri elimde yok" yaz ve o kriteri NEUTRAL bırak. Sana verilmeyen bir dönemin rakamını da üretme. Her rakamı yazarken dönemini belirt (çeyrek / yıllık / TTM); blokta hangi dönem yazıyorsa onu kullan, dönemleri birbirine karıştırma.';
  if (!fd) enrichedPrompt += '\n\nVERİ NOTU: Finansal veri hiç alınamadı. Rakam üretme; hangi verinin eksik olduğunu söyle ve yalnızca niteliksel, rakamsız bir çerçeve sun.';

  /* ÇIKTI BİÇİMİ ÇAPASI — en sonda, çünkü son okunan talimat en ağır basıyor.
     Manuel veri bloğundaki "kendi bağımsız değerlendirmeni yap" talimatı
     modeli anlatıya itti: bir kez şemaya hiç başlamadan düz metin yazdı ve
     süre dolunca VERDICT üretilmeden kesildi (ölçüm: sureDoldu=true,
     kesildi=true). Şemanın dışındaki her satır istemcide ayrıştırılmıyor,
     yani kullanıcıya hiç ulaşmadan süreyi ve token'ı yiyor. */
  enrichedPrompt += '\n\nÇIKTI BİÇİMİ — İSTİSNASIZ: Yanıta DOĞRUDAN "TICKER:" satırıyla başla. Açılış cümlesi, selamlama, düşünce dökümü ya da "analiz ediyorum", "önce şuna bakayım", "bölümlere geçiyorum" gibi ara metin YAZMA. Şemanın dışındaki hiçbir satır kullanıcıya ulaşmıyor; düşünceni şemanın İÇİNDEKİ açıklama alanlarına yaz.';

  try {
    // Süre bütçesi: vercel.json maxDuration=60sn (Hobby planı 60sn'e izin verir).
    // BÜTÇE DAĞILIMI (60 sn'lik fonksiyon penceresi):
    //   veri çekme ≤8sn + birincil 34sn + kurtarma/yedek ≤11sn.
    // Her çağrı kalanSure() ile sınırlanıyor, toplam 54sn'yi geçemiyor:
    // hangi kurtarma yolunun tetiklendiğinden bağımsız olarak Vercel'in
    // 60sn penceresi içinde düzgün bir cevap ya da düzgün bir hata dönüyor.
    // Birincil eskiden 24sn alıyordu, yani pencerenin yarısı yalnızca
    // "belki zaman aşımı olur" diye yedeğe ayrılmış boş bekliyordu. Yedek
    // nadiren çalışıyor; süreyi asıl işi yapan modele verdik. Düşünme
    // açıldığı için model artık cevabı yazmadan önce de token harcıyor —
    // sürenin tamamı ona lazım.
    const FALLBACK_MODEL = 'claude-haiku-4-5';
    const primaryModel = process.env.ANALYZE_MODEL || 'claude-sonnet-5';

    /* DÜŞÜNME VARSAYILAN OLARAK KAPALI — ölçümle alınmış karar.
       Canlıda düşünme açıkken istek 45 sn'de 504'e düştü: gizli düşünme
       de saniye yiyor, model 3400 token'ı 34 sn'ye sığdıramıyor (~50 tok/sn
       ⇒ ~68 sn gerekiyor). 60 sn'lik Vercel penceresinde "gizli düşün +
       uzun yaz" ikisi birden olmuyor. Derinliği görünür metinden alıyoruz:
       prompt zaten her kriterde gerekçeli 2-4 cümle istiyor, yani model
       düşüncesini kullanıcıya yazıyor — hem okunabiliyor hem kesilirse
       elde kalıyor. Daha uzun pencereye geçilirse ANALYZE_THINKING=1. */
    const dusunmeAcik = process.env.ANALYZE_THINKING === '1';
    const effort = ['low', 'medium', 'high'].includes(process.env.ANALYZE_EFFORT) ? process.env.ANALYZE_EFFORT : 'low';

    /* AKIŞLI ÇAĞRI: yanıtı parça parça topluyoruz. Süre dolarsa akışı kesip
       O ANA KADAR GELEN METİNLE dönüyoruz — kriterler şablonun başında
       olduğu için yarım cevap bile kullanılabilir analiz veriyor. Eskiden
       zaman aşımı = elde hiçbir şey yok = 504 idi.
       sade=true: düşünme/effort/önbellek alanları olmadan, en temel gövde. */
    const callModel = async (model, timeoutMs, maxTokens, dusun, sade) => {
      const sure = Math.max(4000, Math.min(timeoutMs, kalanSure() - 2000));
      const ac = new AbortController();
      const zamanlayici = setTimeout(() => ac.abort(), sure);
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            /* Karar tutarlılığı: aynı veriyle üç ardışık koşuda verdict
               AL → BEKLE → AL oldu. Düşük sıcaklık bu salınımı daraltıyor;
               analiz bir yaratıcılık işi değil, aynı rakamlar aynı sonuca
               çıkmalı. */
            temperature: 0.2,
            /* Sistem promptu sabit (tarih/ticker içermiyor) → önbelleğe
               alınabilir. Şirkete özel veri kullanıcı mesajında, yani
               önbellek önekini bozmuyor. */
            system: sade ? systemPrompt : [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            ...(sade ? {} : dusun
              ? { thinking: { type: 'adaptive' }, output_config: { effort } }
              : { thinking: { type: 'disabled' } }),
            stream: true,
            messages: [{ role: 'user', content: enrichedPrompt }]
          }),
          signal: ac.signal,
        });

        // Hata gövdesi akış değil düz JSON gelir
        if (!resp.ok) {
          let d = null;
          try { d = JSON.parse(await resp.text()); } catch {}
          return { resp, d };
        }

        let metin = '', kullanim = {}, stopReason = null, kesildi = false;
        const okuyucu = resp.body.getReader();
        const cozucu = new TextDecoder();
        let tampon = '';
        try {
          while (true) {
            const { done, value } = await okuyucu.read();
            if (done) break;
            tampon += cozucu.decode(value, { stream: true });
            const satirlar = tampon.split('\n');
            tampon = satirlar.pop() || '';
            for (const satir of satirlar) {
              if (!satir.startsWith('data:')) continue;
              const ham = satir.slice(5).trim();
              if (!ham || ham === '[DONE]') continue;
              let ev; try { ev = JSON.parse(ham); } catch { continue; }
              if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') metin += ev.delta.text;
              else if (ev.type === 'message_start') Object.assign(kullanim, ev.message?.usage || {});
              else if (ev.type === 'message_delta') { Object.assign(kullanim, ev.usage || {}); stopReason = ev.delta?.stop_reason || stopReason; }
              else if (ev.type === 'error') return { resp, d: { error: ev.error } };
            }
            // Süre bitmek üzere: elimizdekiyle dön, boş dönme
            if (kalanSure() < 6000) { kesildi = true; break; }
          }
        } catch (e) {
          // Akış kesildi (abort/ağ) — metin varsa onunla devam
          if (!metin) throw e;
          kesildi = true;
        } finally {
          try { await okuyucu.cancel(); } catch {}
        }

        return {
          resp,
          d: {
            content: [{ type: 'text', text: metin }],
            usage: kullanim,
            stop_reason: kesildi ? 'sure_doldu' : stopReason,
            model,
            _kismi: kesildi,
          },
        };
      } finally { clearTimeout(zamanlayici); }
    };

    let response, data, usedFallback = false, sadeDenendi = false;
    const teshis = [];   // hangi denemede ne oldu — hata mesajına ekleniyor
    const denemeNotu = (etiket) => {
      const et = data?.error?.type || (response && !response.ok ? `http_${response.status}` : null);
      const em = data?.error?.message;
      teshis.push(`${etiket}:${et || 'ok'}${em ? ` (${String(em).slice(0, 120)})` : ''}`);
    };

    try {
      /* Manuel verisi olan ticker'larda çıktı token tavanına çarpıyordu
         (RGYAS: 2825/3000, "TOKEN TAVANI — KISMİ"). Tavan ve süre birlikte
         yükseliyor; yalnız tavanı artırmak süre aşımına çevirirdi.
         Bütçe: veri ≤8sn + 46sn = 54sn < maxDuration 60sn. Süre dolarsa
         akış kısmi metni döndürüyor, hata fırlatmıyor. */
      ({ resp: response, d: data } = await callModel(
        primaryModel,
        manuelVeri ? 46000 : 40000,
        manuelVeri ? 3800 : 3000,
        dusunmeAcik
      ));
      denemeNotu(primaryModel);
    } catch (e) {
      // Birincil model ZAMAN AŞIMINA uğradıysa 504 dönme — hızlı haiku'yla kurtar.
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      if (!isTimeout || primaryModel === FALLBACK_MODEL) throw e;
      teshis.push(`${primaryModel}:timeout`);
      dlog(`[AI] ${primaryModel} zaman aşımı → ${FALLBACK_MODEL} ile tekrar deneniyor`);
      ({ resp: response, d: data } = await callModel(FALLBACK_MODEL, 10000, 1200, false));
      denemeNotu(FALLBACK_MODEL);
      usedFallback = true;
    }

    /* İstek gövdesi reddedildiyse (400) suç modelde değil parametrededir —
       düşünme/effort/önbellek alanlarından biri o model veya API sürümünde
       geçersizdir. Aynı modeli sade gövdeyle bir kez daha dene; çalışırsa
       analiz kalitesi biraz düşer ama kullanıcı hata ekranı görmez. */
    const gecersizIstek = !usedFallback && kalanSure() > 12000 && (response?.status === 400 || (data?.error?.type || '').includes('invalid_request'));
    if (gecersizIstek) {
      sadeDenendi = true;
      dlog(`[AI] ${primaryModel} gövdeyi reddetti → sade gövdeyle tekrar`);
      try {
        ({ resp: response, d: data } = await callModel(primaryModel, 16000, 2200, false, true));
        denemeNotu(`${primaryModel}/sade`);
      } catch (e) { teshis.push(`${primaryModel}/sade:timeout`); }
    }

    // Hâlâ hata varsa bilinen-çalışan haiku'ya düş — analiz komple patlamasın.
    if ((!data || data.error || !response?.ok) && !usedFallback && primaryModel !== FALLBACK_MODEL && kalanSure() > 8000) {
      dlog(`[AI] ${primaryModel} başarısız (${data?.error?.message || response?.status}) → ${FALLBACK_MODEL}`);
      ({ resp: response, d: data } = await callModel(FALLBACK_MODEL, 10000, 1200, false));
      denemeNotu(FALLBACK_MODEL);
      usedFallback = true;
    }

    if (!data) return res.status(502).json({ error: `AI_HATA (yanıt ayrıştırılamadı): ${teshis.join(' → ') || 'ayrıntı yok'}` });
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
      // Bilinmeyen — ham Anthropic mesajını ve deneme zincirini göster
      console.error(`[AI] ${cleanTicker} başarısız — ${teshis.join(' → ')}`);
      return res.status(502).json({ error: `AI_HATA (${status||'?'}/${et||'?'}): ${data.error?.message || 'bilinmeyen'} [${teshis.join(' → ')}]` });
    }

    /* Düşünme açıkken cevabın ilk bloğu "thinking" oluyor; content[0].text
       almak boş dönerdi. Metin bloklarını süzüp birleştiriyoruz. */
    const metinAl = (d) => (d?.content || [])
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('\n')
      .trim();

    let aiResult = metinAl(data);

    /* Düşünme tavanı yiyip metin bırakmamış olabilir (content sadece
       "thinking", stop_reason "max_tokens"). Kullanıcıya hata göstermek
       yerine aynı modeli düşünmesiz çağır — analiz biraz sığ olur ama gelir. */
    if (!aiResult && !usedFallback && kalanSure() > 10000) {
      teshis.push(`bos_metin(${(data.content || []).map(b => b?.type).join(',') || 'blok yok'}/${data.stop_reason || '?'})`);
      dlog('[AI] metin boş (düşünme tavanı yemiş olabilir) → düşünmesiz tekrar');
      try {
        ({ resp: response, d: data } = await callModel(primaryModel, 12000, 1800, false));
        denemeNotu(`${primaryModel}/düşünmesiz`);
        aiResult = metinAl(data);
      } catch (e) { teshis.push(`${primaryModel}/düşünmesiz:timeout`); }
    }
    if (!aiResult) {
      // Boş metin: hangi blok tipleri geldi, neden durdu — teşhis için söyle
      const tipler = (data.content || []).map(b => b?.type).join(',') || 'blok yok';
      console.error(`[AI] ${cleanTicker} boş metin — bloklar:${tipler} stop:${data.stop_reason} ${teshis.join(' → ')}`);
      return res.status(502).json({ error: `AI_HATA (boş metin): bloklar=${tipler}, stop=${data.stop_reason || '?'} [${teshis.join(' → ')}]` });
    }
    aiResult = aiResult.replace(/TOTAL_SCORE:\s*(\d+)/i, (m, sc) =>
      `TOTAL_SCORE: ${Math.min(7, Math.max(0, parseInt(sc)))}`
    );

    if (fd) {
      const n2 = (v,d=1) => v!=null ? Number(v).toFixed(d) : 'N/A';
      if (fd.peRatio  != null) aiResult = aiResult.replace(/PE:\s*[\d.N\/A]+\s*\|/, `PE: ${n2(fd.peRatio)} |`);
      if (fd.pbRatio  != null) aiResult = aiResult.replace(/PB:\s*[\d.N\/A]+\s*\|/, `PB: ${n2(fd.pbRatio)} |`);
      if (fd.pegRatio != null) aiResult = aiResult.replace(/PEG:\s*[\d.N\/A]+\s*\|/, `PEG: ${n2(fd.pegRatio)} |`);
      if (fd.evEbitda != null) aiResult = aiResult.replace(/EV_EBITDA:\s*[\d.N\/A]+\s*\|/, `EV_EBITDA: ${n2(fd.evEbitda)} |`);
      if (fd.rsi      != null) aiResult = aiResult.replace(/RSI:\s*[\d.N\/A]+\s*\|/, `RSI: ${Number(fd.rsi).toFixed(0)} |`);
      if (fd.fiftyTwoWeekLow != null && fd.fiftyTwoWeekHigh != null && fd.currentPrice != null)
        aiResult = aiResult.replace(/PRICE_52W:\s*[^\n|]+\|[^\n]*/, `PRICE_52W: ${n2(fd.fiftyTwoWeekLow,2)}-${n2(fd.fiftyTwoWeekHigh,2)} | ${n2(fd.currentPrice,2)}`);
    }

    /* ÇARPAN BLOĞU SUNUCUDA ÜRETİLİYOR — modele yazdırmıyoruz.
       Değerleri zaten gerçek veriden eziyorduk, yani model bu bloğu her
       analizde ~120 token harcayıp uydurma riskiyle yazıyordu. O bütçe
       artık kriterlerin derinliğine gidiyor; blok da hiç kesilmiyor. */
    if (fd && !/MULTIPLES_START/.test(aiResult)) {
      const s = (v, d = 1) => (v != null && isFinite(v)) ? Number(v).toFixed(d) : 'N/A';
      const bant = (v, ucuz, pahali) => v == null || !isFinite(v) ? '—' : v <= ucuz ? 'ucuz' : v >= pahali ? 'pahalı' : 'adil';
      const rsiEt = fd.rsi == null ? '—' : fd.rsi < 30 ? 'ASIRI_SATIM' : fd.rsi > 70 ? 'ASIRI_ALIM' : 'NÖTR';
      const upsideStr = (fd.currentPrice && fd.targetMeanPrice)
        ? `%${(((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice) * 100).toFixed(1)}` : 'N/A';
      aiResult += `\n\nMULTIPLES_START
PE: ${s(fd.peRatio)} | ${bant(fd.peRatio, 18, 28)}
PB: ${s(fd.pbRatio)} | ${bant(fd.pbRatio, 2, 7)}
EV_EBITDA: ${s(fd.evEbitda)} | ${bant(fd.evEbitda, 12, 25)}
PEG: ${s(fd.pegRatio)} | ${bant(fd.pegRatio, 1, 2)}
RSI: ${fd.rsi != null ? Number(fd.rsi).toFixed(0) : 'N/A'} | ${rsiEt}
PRICE_52W: ${s(fd.fiftyTwoWeekLow, 2)}-${s(fd.fiftyTwoWeekHigh, 2)} | ${s(fd.currentPrice, 2)}
ANALYST: — | ${fd.recommendationKey || 'N/A'} | ${s(fd.targetMeanPrice, 2)} | ${upsideStr}
MULTIPLES_END`;
    }

    /* ── KULLANIM ÖLÇÜMÜ ────────────────────────────────────────────
       Hangi model, kaç token, yaklaşık kaç dolar. Önbellek okuması
       ayrı sayılıyor: cacheOku yüksekse sistem promptu %10 fiyatına
       geliyor demektir, düşükse önbellek tutmuyor (bkz. system bloğu). */
    const kullanim = data.usage || {};
    const servisEdenModel = data.model || (usedFallback ? FALLBACK_MODEL : primaryModel);
    // Token tavanı doldu ya da süre bütçesi bitti — ikisi de kısmi cevap demek
    const kesildi = data.stop_reason === 'max_tokens' || data.stop_reason === 'sure_doldu';
    const sureDoldu = data.stop_reason === 'sure_doldu';
    /* Akış süre dolduğu için kesildiyse son "message_delta" hiç gelmez,
       yani output_tokens eksik kalır (1 gibi anlamsız değer). Böyle
       durumda metin uzunluğundan tahmin ediyoruz (~4 karakter/token). */
    const cikisTahmini = Math.round(aiResult.length / 4);
    const cikisToken = (kullanim.output_tokens && kullanim.output_tokens > 5)
      ? kullanim.output_tokens : cikisTahmini;
    const olcum = {
      model: servisEdenModel,
      giris: kullanim.input_tokens ?? null,
      cikis: cikisToken,
      cikisTahmini: !(kullanim.output_tokens && kullanim.output_tokens > 5),
      cacheYaz: kullanim.cache_creation_input_tokens ?? 0,
      cacheOku: kullanim.cache_read_input_tokens ?? 0,
      kesildi,
      sureDoldu,
      yedek: usedFallback,
      // Hangi sektör modülü seçildi — yanlış eşleme admin şeridinden görülsün
      sektorModulu: isBIST ? (bistModulSec(fd?.industry) || 'modül yok') : null,
    };
    // Fiyat/1M token — model değişince buradan güncelle
    const FIYAT = {
      'claude-sonnet-5': { g: 2.00, c: 10.00 },   // tanıtım fiyatı (2026-08-31'e kadar; sonrası 3/15)
      'claude-opus-5':   { g: 5.00, c: 25.00 },
      'claude-haiku-4-5':{ g: 1.00, c: 5.00 },
      'claude-sonnet-4-5': { g: 3.00, c: 15.00 },
    };
    const f = FIYAT[servisEdenModel] || FIYAT[Object.keys(FIYAT).find(k => servisEdenModel.startsWith(k))] || null;
    if (f) {
      // Önbellek yazımı 1,25x, okuması 0,1x
      olcum.maliyet = Number((
        ((olcum.giris || 0) * f.g + (olcum.cacheYaz || 0) * f.g * 1.25 + (olcum.cacheOku || 0) * f.g * 0.1
         + (olcum.cikis || 0) * f.c) / 1e6
      ).toFixed(4));
    }
    console.log(`[AI] ${cleanTicker} ${olcum.model} giriş:${olcum.giris} çıkış:${olcum.cikis} cache(yaz:${olcum.cacheYaz} oku:${olcum.cacheOku})${olcum.maliyet != null ? ` ~$${olcum.maliyet}` : ''}${kesildi ? ' KESİLDİ' : ''}`);

    dlog(`✓ ${yahooTicker} | src:${fd?.dataSource} | roe:${fd?.roe} | pb:${fd?.pbRatio}(${fd?.pbSource||'yahoo'}) | len:${aiResult.length}`);

    const sayi = (re) => { const m = aiResult.match(re); return m ? parseInt(m[1], 10) : null; };
    await kayitYaz({
      sirket: fd?.shortName || fd?.longName || null,
      verdict: (aiResult.match(/^VERDICT:\s*([A-Z_]+)/m) || [])[1] || null,
      skor: sayi(/^TOTAL_SCORE:\s*(\d+)/m),
      garp: sayi(/^GARP_SKOR:\s*(\d{1,3})/m),
      model: olcum.model,
      giris_token: olcum.giris,
      cikis_token: olcum.cikis,
      maliyet: olcum.maliyet ?? null,
      durum: sureDoldu ? 'sure_doldu' : 'ok',
    });

    return res.status(200).json({
      result: aiResult,
      financialData: fd,
      peers: fd?.peers || [],
      dataWarnings: fd?._dataWarnings || [],
      /* Tezin GÖRÜŞÜ — modele gitmiyor, yalnızca istemcide gösteriliyor.
         Böylece model kendi sonucuna bağımsız varıyor, okur ise tezin ne
         dediğini yine görüyor. */
      tezNotu: manuelVeri ? {
        tez_id: manuelVeri.tez_id ?? null,
        ticker: manuelVeri.ticker,
        sinyal: manuelVeri.tez?.sinyal ?? null,
        tip: manuelVeri.tez?.tip ?? null,
        tarih: manuelVeri.tez?.tarih ?? manuelVeri.guncelleme_tarihi,
        guncelleme_tarihi: manuelVeri.guncelleme_tarihi,
        tez_fiyati: manuelVeri.tez_fiyati ?? null,
        giris_bandi_al_ust: manuelVeri.giris_bandi_al_ust ?? null,
        giris_bandi_olculu_ust: manuelVeri.giris_bandi_olculu_ust ?? null,
        beklenen_deger: manuelVeri.beklenen_deger ?? null,
        senaryolar: manuelVeri.tez?.senaryolar ?? [],
        varsayimlar_12ay: manuelVeri.tez?.varsayimlar_12ay ?? null,
        kapanis_fiyat: (() => {
          const h = nadHesapla(manuelVeri, fd, eurTryKuru);
          return (h.nadTry && manuelVeri.tez_kapanis_nad_orani)
            ? Math.round(h.nadTry * Number(manuelVeri.tez_kapanis_nad_orani)) : null;
        })(),
      } : null,
      /* Ölçüm YALNIZCA admin'e. Arayüzde zaten admin kontrolü vardı ama
         nesne yanıtta herkese gidiyordu: kullanıcı DevTools'tan analiz
         başına maliyeti, hangi modeli kullandığımızı ve yedek modele ne
         sıklıkta düştüğümüzü okuyabiliyordu. Gizleme kozmetik kalmasın.
         undefined alanı JSON.stringify atıyor, istemci de null görüp
         şeridi hiç çizmiyor. */
      olcum: isAdmin ? olcum : undefined,
    });

  } catch(err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    console.error('Analyze error:', err.message);
    await kayitYaz({ durum: isTimeout ? 'sure_doldu' : 'hata', hata: String(err.message || '').slice(0, 300) });
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'AI servisi zaman aşımına uğradı. Lütfen tekrar deneyin.' : err.message,
    });
  }
}
