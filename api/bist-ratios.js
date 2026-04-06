// /api/bist-ratios.js — Barış Investing
// BIST Hisseleri için Çoklu Kaynak Rasyo API'si
//
// Kaynak önceliği:
//   1. Google Finance (F/K ve PD/DD için en güvenilir)
//   2. İş Yatırım scraping
//   3. BigPara scraping
//   4. Yahoo Finance (normalize edilmiş fallback)
//
// Kullanım: GET /api/bist-ratios?ticker=THYAO
//           veya POST { ticker: "THYAO" }
//
// Vercel'e eklemek için:
//   → /api/bist-ratios.js dosyasını oluştur, push et, hazır.
//   → analyze.js'de BIST hisseleri için bu endpoint'i çağır.

const CACHE = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 dakika

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// ═══════════════════════════════════════════════════════════
// 1. GOOGLE FİNANCE
// ═══════════════════════════════════════════════════════════
// Google Finance BIST hisseleri için: THYAO:IST, EREGL:IST vb.
// HTML yapısı: <div data-last-price="..."> ve tablo satırları

async function fetchGoogleFinance(ticker) {
  const result = { pe: null, pb: null, source: null };

  // Hem masaüstü hem mobil dene — Cloudflare bypass için
  const attempts = [
    {
      url: `https://www.google.com/finance/quote/${ticker}:IST`,
      headers: {
        'User-Agent': UA_CHROME,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      }
    },
    {
      url: `https://www.google.com/finance/quote/${ticker}:IST`,
      headers: {
        'User-Agent': UA_MOBILE,
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
      }
    },
    // Google Finance API endpoint (non-public ama çalışıyor)
    {
      url: `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}.IS&fields=trailingPE,priceToBook`,
      headers: { 'User-Agent': UA_CHROME }
    }
  ];

  for (const attempt of attempts) {
    try {
      const r = await fetch(attempt.url, {
        headers: attempt.headers,
        signal: AbortSignal.timeout(7000),
        redirect: 'follow',
      });

      if (!r.ok) {
        console.log(`[Google] ${ticker}: HTTP ${r.status}`);
        continue;
      }

      const html = await r.text();
      console.log(`[Google] ${ticker}: ${html.length} chars from ${attempt.url}`);

      // ── Google Finance HTML parse stratejileri ──
      // Google Finance HTML yapısı sık değişiyor, birden fazla pattern dene

      // Pattern 1: JSON-LD içinde ratios
      const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
      if (jsonLdMatch) {
        for (const block of jsonLdMatch) {
          try {
            const json = JSON.parse(block.replace(/<script[^>]*>|<\/script>/g, ''));
            if (json.priceEarningsRatio || json['P/E Ratio']) {
              result.pe = parseFloat(json.priceEarningsRatio || json['P/E Ratio']);
              result.source = 'Google/JSON-LD';
            }
          } catch {}
        }
      }

      // Pattern 2: data-* attribute'larından çek
      // <div class="... P/E ratio ..."><span>...</span><span>4.23</span>
      const patterns = [
        // P/E — çeşitli Google Finance HTML versiyonları
        { key: 'pe',  regexes: [
          /P\/E ratio[^"]*"[^>]*>[^<]*<[^>]*>([0-9,]+\.?[0-9]*)/i,
          /(?:Fiyat\/Kazanç|Price\/Earning|P\/E)[^0-9]*([0-9]+\.?[0-9]*)/i,
          /"trailingPE"[^:]*:[^"]*"([0-9]+\.?[0-9]*)"/i,
          /P\/E ratio<\/span>[^<]*<span[^>]*>([0-9]+\.?[0-9]*)/i,
          // Google Finance data attribute
          /data-label="P\/E ratio"[^>]*>([0-9]+\.?[0-9]*)/i,
          // Table row format
          /P\/E ratio<\/div>[^<]*<div[^>]*>([0-9]+\.?[0-9]*)/i,
          // New Google Finance format (2024)
          /YA-wl[^>]*>[^<]*<[^>]*>P\/E ratio[^<]*<[^>]*>[^<]*<[^>]*>([0-9]+\.?[0-9]*)/i,
        ]},
        // P/B
        { key: 'pb',  regexes: [
          /Price\/Book[^"]*"[^>]*>[^<]*<[^>]*>([0-9]+\.?[0-9]*)/i,
          /(?:P\/B|Price\/Book|PD\/DD)[^0-9]*([0-9]+\.?[0-9]*)/i,
          /"priceToBook"[^:]*:[^"]*"([0-9]+\.?[0-9]*)"/i,
          /Price\/Book<\/span>[^<]*<span[^>]*>([0-9]+\.?[0-9]*)/i,
          /Price\/Book<\/div>[^<]*<div[^>]*>([0-9]+\.?[0-9]*)/i,
        ]},
      ];

      for (const { key, regexes } of patterns) {
        if (result[key] != null) continue; // zaten bulunduysa geç
        for (const rx of regexes) {
          const m = html.match(rx);
          if (m) {
            const val = parseFloat(m[1].replace(',', '.'));
            if (!isNaN(val) && val > 0 && val < 1000) {
              result[key] = val;
              result.source = result.source || 'Google/HTML';
              console.log(`[Google] ${ticker} ${key}=${val} (regex match)`);
              break;
            }
          }
        }
      }

      // Pattern 3: Google Finance'in gömülü JS state'inden çek (en güvenilir)
      // window.FINANCE_QUOTE_STORE veya benzeri global state
      const storeMatch = html.match(/(?:FINANCE_QUOTE_STORE|AF_initDataCallback)[^{]*({[\s\S]{100,5000}})/);
      if (storeMatch) {
        try {
          const peM = storeMatch[1].match(/"(?:pe|trailingPe|P\\u002FE)"\s*:\s*([0-9]+\.?[0-9]*)/i);
          const pbM = storeMatch[1].match(/"(?:pb|priceToBook|P\\u002FB)"\s*:\s*([0-9]+\.?[0-9]*)/i);
          if (peM && !result.pe) { result.pe = parseFloat(peM[1]); result.source = 'Google/Store'; }
          if (pbM && !result.pb) { result.pb = parseFloat(pbM[1]); result.source = 'Google/Store'; }
        } catch {}
      }

      // Başarılı sonuç aldıysak dur
      if (result.pe != null || result.pb != null) {
        return result;
      }

    } catch (e) {
      console.log(`[Google] ${ticker} attempt error: ${e.message}`);
    }
  }

  return result; // bulunamazsa null'lı döner
}

// ═══════════════════════════════════════════════════════════
// 2. İŞ YATIRIM SCRAPING
// ═══════════════════════════════════════════════════════════
async function fetchIsYatirim(ticker) {
  const result = { pe: null, pb: null, roe: null, source: null };

  const urls = [
    `https://www.isyatirim.com.tr/analiz-ve-bulten/hisse/${ticker}`,
    `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/HisseSenetleri?hisse=${ticker}`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA_CHROME,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
          'Referer': 'https://www.isyatirim.com.tr/',
        },
        signal: AbortSignal.timeout(7000),
      });

      if (!r.ok) continue;
      const text = await r.text();
      console.log(`[İşYat] ${ticker}: ${text.length} chars`);

      // İş Yatırım HTML pattern'leri
      const patterns = [
        { key: 'pe',  regexes: [
          /F\/K[^0-9]*([0-9]+[.,][0-9]+)/i,
          /Fiyat\/Kazanç[^0-9]*([0-9]+[.,][0-9]+)/i,
          /"f_k"\s*:\s*"?([0-9]+\.?[0-9]*)"/i,
          /"pe"\s*:\s*([0-9]+\.?[0-9]*)/i,
        ]},
        { key: 'pb',  regexes: [
          /F\/DD[^0-9]*([0-9]+[.,][0-9]+)/i,
          /PD\/DD[^0-9]*([0-9]+[.,][0-9]+)/i,
          /Fiyat\/Defter[^0-9]*([0-9]+[.,][0-9]+)/i,
          /"f_dd"\s*:\s*"?([0-9]+\.?[0-9]*)"/i,
          /"pb"\s*:\s*([0-9]+\.?[0-9]*)/i,
        ]},
        { key: 'roe', regexes: [
          /ROE[^0-9%]*%?\s*([0-9]+[.,][0-9]+)/i,
          /"roe"\s*:\s*([0-9]+\.?[0-9]*)/i,
        ]},
      ];

      for (const { key, regexes } of patterns) {
        for (const rx of regexes) {
          const m = text.match(rx);
          if (m) {
            const raw = m[1].replace(',', '.');
            const val = parseFloat(raw);
            if (!isNaN(val) && val > 0 && val < 500) {
              result[key] = val;
              // ROE genellikle yüzde olarak gelir
              if (key === 'roe' && val > 3) result.roe = val / 100;
              result.source = 'IsYatirim';
              console.log(`[İşYat] ${ticker} ${key}=${val}`);
              break;
            }
          }
        }
      }

      if (result.pe != null || result.pb != null) return result;

    } catch(e) {
      console.log(`[İşYat] ${ticker} error: ${e.message}`);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 3. BİGPARA SCRAPING
// ═══════════════════════════════════════════════════════════
async function fetchBigPara(ticker) {
  const result = { pe: null, pb: null, roe: null, source: null };

  const urls = [
    `https://bigpara.hurriyet.com.tr/hisse/${ticker.toLowerCase()}/hisse-senedi/`,
    `https://bigpara.hurriyet.com.tr/hisse/${ticker.toLowerCase()}/`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA_CHROME,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9',
          'Referer': 'https://bigpara.hurriyet.com.tr/',
        },
        signal: AbortSignal.timeout(7000),
      });

      if (!r.ok) continue;
      const text = await r.text();
      console.log(`[BigPara] ${ticker}: ${text.length} chars`);

      const patterns = [
        { key: 'pe',  regexes: [
          /(?:Fiyat\/Kazanç|F\/K|FD\/Kazanç)[^<]*<[^>]+>\s*([0-9]+[.,][0-9]+)/i,
          /"pe"\s*:\s*([0-9]+\.?[0-9]*)/i,
          /piyasa-deger-kazanc[^"]*"[^>]*>([0-9]+[.,][0-9]+)/i,
        ]},
        { key: 'pb',  regexes: [
          /(?:Piy\.Değer\/Defter|F\/DD|PD\/DD|Fiyat\/Defter)[^<]*<[^>]+>\s*([0-9]+[.,][0-9]+)/i,
          /"pb"\s*:\s*([0-9]+\.?[0-9]*)/i,
        ]},
        { key: 'roe', regexes: [
          /ROE[^<]*<[^>]+>\s*%?\s*([0-9]+[.,][0-9]+)/i,
          /"roe"\s*:\s*([0-9]+\.?[0-9]*)/i,
        ]},
      ];

      for (const { key, regexes } of patterns) {
        for (const rx of regexes) {
          const m = text.match(rx);
          if (m) {
            const val = parseFloat(m[1].replace(',', '.'));
            if (!isNaN(val) && val > 0 && val < 500) {
              result[key] = val;
              if (key === 'roe' && val > 3) result.roe = val / 100;
              result.source = 'BigPara';
              console.log(`[BigPara] ${ticker} ${key}=${val}`);
              break;
            }
          }
        }
      }

      if (result.pe != null || result.pb != null) return result;

    } catch(e) {
      console.log(`[BigPara] ${ticker} error: ${e.message}`);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════
// 4. YAHOO FİNANCE (AKILLI NORMALİZASYON)
// ═══════════════════════════════════════════════════════════
// Yahoo BIST verileri için USD/TRY birim uyumsuzluğunu gider
async function fetchYahooNormalized(ticker) {
  const result = { pe: null, pb: null, roe: null, marketCap: null, source: null };

  const APPROX_USD_TRY = 38; // konservatif tahmin

  let crumb = null, cookie = null;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA_CHROME }, redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    });
    cookie = (r1.headers.get('set-cookie') || '').split(';')[0] || null;
    if (cookie) {
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA_CHROME, 'Cookie': cookie, 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(5000)
      });
      if (r2.ok) crumb = (await r2.text()).trim();
    }
  } catch {}

  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const yhTicker = `${ticker}.IS`;
  const headers = {
    'User-Agent': UA_CHROME,
    'Accept': 'application/json',
    'Referer': 'https://finance.yahoo.com/',
    ...(cookie ? { 'Cookie': cookie } : {}),
  };

  try {
    // v10: quoteSummary ile hem istatistikler hem bilanço
    const modules = 'defaultKeyStatistics,financialData,balanceSheetHistory,incomeStatementHistory';
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yhTicker)}?modules=${modules}${cs}`;
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`Yahoo v10: ${r.status}`);

    const j = await r.json();
    const raw = j?.quoteSummary?.result?.[0];
    if (!raw) throw new Error('No result');

    const ks  = raw.defaultKeyStatistics || {};
    const fd  = raw.financialData || {};
    const bsh = raw.balanceSheetHistory || {};
    const ish = raw.incomeStatementHistory || {};
    const f   = v => v?.raw ?? null;

    // Piyasa değeri v7'den gelir, onu da al
    const qUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yhTicker)}&fields=marketCap,regularMarketPrice,currency${cs}`;
    const qr = await fetch(qUrl, { headers, signal: AbortSignal.timeout(8000) });
    let marketCap = null, currentPrice = null;
    if (qr.ok) {
      const qj = await qr.json();
      const q = qj?.quoteResponse?.result?.[0];
      marketCap    = q?.marketCap    ?? null; // TRY bazında
      currentPrice = q?.regularMarketPrice ?? null;
    }

    result.marketCap = marketCap;

    // ── Bilanço verilerini çek ──
    const sheets = bsh.balanceSheetStatements || [];
    let equity = null;
    if (sheets.length > 0) {
      const lat = sheets[0];
      const se  = f(lat.totalStockholderEquity);
      const ta  = f(lat.totalAssets);
      const tl  = f(lat.totalLiab);

      console.log(`[Yahoo Debug] ${ticker}: MC=${marketCap?.toExponential(3)} SE=${se?.toExponential(3)} TA=${ta?.toExponential(3)} TL=${tl?.toExponential(3)}`);

      // Birim tespiti — özsermayeyi normalize et
      if (se != null && marketCap) {
        equity = normalizeEquity(se, marketCap, ticker);
      } else if (ta != null && tl != null && marketCap) {
        const rawEquity = ta - tl;
        if (rawEquity > 0) {
          equity = normalizeEquity(rawEquity, marketCap, ticker);
        }
      }
    }

    // PE: önce Yahoo trailingPE dene, sonra formül
    const yahooPE = f(ks.trailingPE) ?? f(ks.forwardPE);
    if (yahooPE != null && yahooPE > 0.5 && yahooPE <= 100) {
      result.pe = parseFloat(yahooPE.toFixed(2));
      result.source = 'Yahoo/PE';
    }

    // PE Formül 1: MarketCap / NetIncome (en güvenilir BIST için)
    if (!result.pe && marketCap) {
      const stmts = ish.incomeStatementHistory || [];
      if (stmts.length > 0) {
        const niRaw = f(stmts[0].netIncome);
        if (niRaw != null && niRaw !== 0) {
          const niNorm = normalizeEquity(Math.abs(niRaw), marketCap, ticker);
          if (niNorm > 0) {
            const peCalc = marketCap / niNorm;
            console.log(`[Yahoo PE Formül] MC=${marketCap.toExponential(3)} / NI(norm)=${niNorm.toExponential(3)} = ${peCalc.toFixed(2)}`);
            if (peCalc > 0.5 && peCalc < 150) {
              result.pe = parseFloat(peCalc.toFixed(2));
              result.source = (result.source || '') + '+PE-formül(MC/NI)';
            }
          }
        }
      }
    }

    // PE Formül 2: Fiyat / EPS
    if (!result.pe && currentPrice) {
      const eps = f(ks.trailingEps);
      if (eps != null && eps !== 0) {
        // EPS çok küçükse USD → TRY çevir
        const epsNorm = Math.abs(eps) < 20 ? eps * APPROX_USD_TRY : eps;
        if (epsNorm > 0 && currentPrice > 0) {
          const peEps = currentPrice / epsNorm;
          console.log(`[Yahoo PE EPS] Fiyat=${currentPrice} / EPS(norm)=${epsNorm.toFixed(2)} = ${peEps.toFixed(2)}`);
          if (peEps > 0.5 && peEps < 150) {
            result.pe = parseFloat(peEps.toFixed(2));
            result.source = (result.source || '') + '+PE-formül(EPS)';
          }
        }
      }
    }

    // PB: Yahoo'yu kesinlikle kullanma, formülle hesapla
    if (equity && equity > 0 && marketCap) {
      const pbCalc = marketCap / equity;
      console.log(`[Yahoo Norm] ${ticker}: PD/DD = ${marketCap.toExponential(3)} / ${equity.toExponential(3)} = ${pbCalc.toFixed(3)}`);
      if (pbCalc > 0.1 && pbCalc < 25) {
        result.pb = parseFloat(pbCalc.toFixed(2));
        result.pbEquity = equity;
        result.source = result.source || 'Yahoo/Formül';
        result.source += '+PD/DD-formül';
      }
    }

    // ROE
    const roeRaw = f(fd.returnOnEquity);
    if (roeRaw != null && Math.abs(roeRaw) < 5) {
      result.roe = roeRaw;
    } else if (equity && equity > 0) {
      const stmts = ish.incomeStatementHistory || [];
      if (stmts.length > 0) {
        const ni = f(stmts[0].netIncome);
        if (ni != null) {
          const roeCalc = ni / equity;
          if (Math.abs(roeCalc) < 3) result.roe = parseFloat(roeCalc.toFixed(4));
        }
      }
    }

  } catch(e) {
    console.log(`[Yahoo] ${ticker} error: ${e.message}`);
  }

  return result;
}

// ── Özsermaye birim normalizasyonu ──
function normalizeEquity(rawEquity, marketCap, ticker) {
  const APPROX_USD_TRY = 38;
  const ratio = rawEquity / marketCap;

  console.log(`[Normalize] ${ticker}: equity=${rawEquity.toExponential(3)} mc=${marketCap.toExponential(3)} ratio=${ratio.toFixed(4)}`);

  // Makul aralık: özsermaye MC'nin %5'i ile 20 katı arasında
  if (ratio >= 0.05 && ratio <= 20) return rawEquity;

  // Çok küçük → USD gelmiş
  if (ratio < 0.05) {
    const asTRY = rawEquity * APPROX_USD_TRY;
    const ratioTRY = asTRY / marketCap;
    if (ratioTRY >= 0.05 && ratioTRY <= 20) {
      console.log(`[Normalize] ${ticker}: USD→TRY ×${APPROX_USD_TRY} → ${asTRY.toExponential(3)}`);
      return asTRY;
    }
    // Binlik USD
    const asTRY_k = rawEquity * 1000 * APPROX_USD_TRY;
    const ratioKU = asTRY_k / marketCap;
    if (ratioKU >= 0.05 && ratioKU <= 20) {
      console.log(`[Normalize] ${ticker}: binUSD→TRY ×${1000 * APPROX_USD_TRY} → ${asTRY_k.toExponential(3)}`);
      return asTRY_k;
    }
  }

  // Çok büyük → binlik TL
  if (ratio > 20) {
    const div1k = rawEquity / 1000;
    if (div1k / marketCap >= 0.05 && div1k / marketCap <= 20) {
      console.log(`[Normalize] ${ticker}: ÷1000 → ${div1k.toExponential(3)}`);
      return div1k;
    }
  }

  console.log(`[Normalize] ${ticker}: düzeltilemedi, ham değer kullanılıyor`);
  return rawEquity;
}

// ═══════════════════════════════════════════════════════════
// ANA ORKESTRASYUN
// ═══════════════════════════════════════════════════════════
async function getBISTRatios(ticker) {
  ticker = ticker.toUpperCase().trim();
  const cacheKey = `bist:${ticker}`;

  // Cache kontrolü
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[Cache] ${ticker} cache hit`);
    return cached.data;
  }

  const final = {
    ticker,
    pe:          null,
    pb:          null,
    roe:         null,
    marketCap:   null,
    source_pe:   null,
    source_pb:   null,
    sources_tried: [],
    debug:       {},
    ts:          new Date().toISOString(),
  };

  // ── Paralel olarak birden fazla kaynağı dene ──
  console.log(`\n${'═'.repeat(50)}\n[BIST Ratios] ${ticker} — sorgu başlıyor\n${'═'.repeat(50)}`);

  const [googleResult, isYatResult, bigParaResult, yahooResult] = await Promise.allSettled([
    fetchGoogleFinance(ticker),
    fetchIsYatirim(ticker),
    fetchBigPara(ticker),
    fetchYahooNormalized(ticker),
  ]);

  const google  = googleResult.status  === 'fulfilled' ? googleResult.value  : {};
  const isYat   = isYatResult.status   === 'fulfilled' ? isYatResult.value   : {};
  const bigPara = bigParaResult.status === 'fulfilled' ? bigParaResult.value : {};
  const yahoo   = yahooResult.status   === 'fulfilled' ? yahooResult.value   : {};

  // Debug bilgisi
  final.debug = {
    google:  { pe: google.pe,  pb: google.pb,  source: google.source },
    isYat:   { pe: isYat.pe,   pb: isYat.pb,   source: isYat.source },
    bigPara: { pe: bigPara.pe, pb: bigPara.pb, source: bigPara.source },
    yahoo:   { pe: yahoo.pe,   pb: yahoo.pb,   pbEquity: yahoo.pbEquity, source: yahoo.source },
  };

  final.marketCap = yahoo.marketCap;

  // ── PE (F/K) — Öncelik: Google > İşYat > BigPara > Yahoo ──
  // PE için Yahoo'ya da güvenebiliriz (pb kadar bozuk değil)
  const peSources = [
    { val: google.pe,  src: 'Google' },
    { val: isYat.pe,  src: 'IsYatirim' },
    { val: bigPara.pe, src: 'BigPara' },
    { val: yahoo.pe,   src: 'Yahoo' },
  ];
  for (const { val, src } of peSources) {
    if (val != null && val > 0 && val < 200) {
      final.pe       = parseFloat(val.toFixed(2));
      final.source_pe = src;
      final.sources_tried.push(src);
      break;
    }
  }

  // ── PB (PD/DD) — Öncelik: Google > İşYat > BigPara > Yahoo/Formül ──
  // PB için Yahoo HAM değerini kesinlikle kullanma, sadece Yahoo/Formül kabul et
  const pbSources = [
    { val: google.pb,  src: 'Google' },
    { val: isYat.pb,  src: 'IsYatirim' },
    { val: bigPara.pb, src: 'BigPara' },
    { val: yahoo.pb,   src: yahoo.source ? yahoo.source : 'Yahoo/Formül' },
  ];
  for (const { val, src } of pbSources) {
    if (val != null && val > 0.05 && val < 30) {
      final.pb       = parseFloat(val.toFixed(2));
      final.source_pb = src;
      if (!final.sources_tried.includes(src)) final.sources_tried.push(src);
      break;
    }
  }

  // ROE
  const roeSources = [google, isYat, bigPara, yahoo];
  for (const src of roeSources) {
    if (src.roe != null && Math.abs(src.roe) < 3) {
      final.roe = parseFloat(src.roe.toFixed(4));
      break;
    }
  }

  // Sinyal hesapla (UI'da kullanmak için)
  final.signals = {
    pe_signal: sigPE(final.pe),
    pb_signal: sigPB(final.pb),
  };

  console.log(`\n[BIST Final] ${ticker}: PE=${final.pe}(${final.source_pe}) PD/DD=${final.pb}(${final.source_pb}) ROE=${final.roe}`);

  // Cache'e yaz
  CACHE.set(cacheKey, { data: final, ts: Date.now() });
  if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);

  return final;
}

function sigPE(v) {
  if (v == null) return 'N/A';
  if (v < 10) return 'ucuz';
  if (v < 20) return 'adil';
  if (v < 35) return 'dikkat';
  return 'pahalı';
}
function sigPB(v) {
  if (v == null) return 'N/A';
  if (v < 1)   return 'çok ucuz';
  if (v < 2)   return 'ucuz';
  if (v < 4)   return 'adil';
  if (v < 8)   return 'pahalı';
  return 'çok pahalı';
}

// ═══════════════════════════════════════════════════════════
// VERCEL HANDLER
// ═══════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = req.query?.ticker || req.body?.ticker;
  if (!ticker) return res.status(400).json({ error: 'ticker parametresi zorunlu' });

  try {
    const data = await getBISTRatios(ticker);
    return res.status(200).json(data);
  } catch(e) {
    console.error('[BIST Ratios Error]', e.message);
    return res.status(500).json({ error: e.message, ticker });
  }
}
