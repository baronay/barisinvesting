// /api/bist-ratios.js — Barış Investing v2
// BIST Hisseleri: Mynet/Finans → İşYatırım → BigPara → Yahoo (canlı kur ile)
// GET /api/bist-ratios?ticker=THYAO

const CACHE     = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 dakika

// ── User-Agent'lar ──────────────────────────────────────────────
const UA = {
  chrome:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  mobile:  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
};

// ── Canlı USD/TRY kur cache ──────────────────────────────────────
let _usdtry = 38.5;
let _usdtryTs = 0;
const USDTRY_TTL = 30 * 60 * 1000; // 30 dk

async function getUsdTry() {
  if (Date.now() - _usdtryTs < USDTRY_TTL) return _usdtry;
  try {
    // Yahoo Finance'den USDTRY anlık kur
    const r = await fetch(
      'https://query1.finance.yahoo.com/v7/finance/quote?symbols=USDTRY%3DX&fields=regularMarketPrice',
      { headers: { 'User-Agent': UA.chrome }, signal: AbortSignal.timeout(5000) }
    );
    if (r.ok) {
      const j = await r.json();
      const price = j?.quoteResponse?.result?.[0]?.regularMarketPrice;
      if (price && price > 10 && price < 200) {
        _usdtry = price;
        _usdtryTs = Date.now();
        console.log(`[Kur] USDTRY = ${_usdtry}`);
        return _usdtry;
      }
    }
  } catch (e) {
    console.log(`[Kur] Hata: ${e.message} — fallback ${_usdtry} kullanılıyor`);
  }
  return _usdtry;
}

// ════════════════════════════════════════════════════════════════
// YARDIMCILAR
// ════════════════════════════════════════════════════════════════
function safeNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function inRange(v, min, max) { return v != null && v > min && v < max; }

// ════════════════════════════════════════════════════════════════
// 1. MYNET FİNANS — Türkiye'nin en güvenilir BIST scrape kaynağı
// F/K ve PD/DD'yi TRY bazında direkt sunuyor
// ════════════════════════════════════════════════════════════════
async function fetchMynet(ticker) {
  const out = { pe: null, pb: null, roe: null, source: null };

  const urls = [
    `https://finans.mynet.com/borsa/hisseler/${ticker.toLowerCase()}/temel-veriler/`,
    `https://finans.mynet.com/borsa/hisseler/${ticker.toLowerCase()}/`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent':      UA.chrome,
          'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9',
          'Referer':         'https://finans.mynet.com/borsa/',
        },
        signal: AbortSignal.timeout(9000),
        redirect: 'follow',
      });
      if (!r.ok) { console.log(`[Mynet] ${ticker} HTTP ${r.status}`); continue; }

      const text = await r.text();
      console.log(`[Mynet] ${ticker}: ${text.length} chars`);

      if (text.length < 3000) continue; // bot koruması

      const pairs = [
        { key: 'pe',  labels: ['F/K', 'Fiyat/Kazanç', 'FK'],           max: 500 },
        { key: 'pb',  labels: ['PD/DD', 'F/DD', 'Fiyat/Defter Değeri'], max: 50  },
        { key: 'roe', labels: ['ROE', 'Özsermaye Kârlılığı', 'Özkaynak Kârlılığı'], max: 300, pct: true },
      ];

      for (const { key, labels, max, pct } of pairs) {
        for (const lbl of labels) {
          const idx = text.indexOf(lbl);
          if (idx < 0) continue;
          const after = text.slice(idx + lbl.length, idx + lbl.length + 300);
          const m = after.match(/([0-9]+[.,][0-9]+)/);
          if (m) {
            let v = safeNum(m[1]);
            if (pct && v > 3) v /= 100;
            if (inRange(v, 0.001, max)) {
              out[key] = v;
              out.source = 'Mynet';
              console.log(`[Mynet ${key}] ${ticker}: ${v}`);
              break;
            }
          }
        }
      }

      if (out.pe != null || out.pb != null) return out;
    } catch (e) {
      console.log(`[Mynet] ${ticker}: ${e.message}`);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 2. İŞ YATIRIM — Yapılandırılmış veri API'si
// ════════════════════════════════════════════════════════════════
async function fetchIsYatirim(ticker) {
  const out = { pe: null, pb: null, roe: null, peg: null, source: null };

  const endpoints = [
    `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/HisseSenetleri?hisse=${ticker}`,
    `https://www.isyatirim.com.tr/analiz-ve-bulten/hisse/${ticker}`,
  ];

  const headers = {
    'User-Agent':       UA.chrome,
    'Accept':           'text/html,application/json,*/*;q=0.8',
    'Accept-Language':  'tr-TR,tr;q=0.9,en-US;q=0.8',
    'Referer':          'https://www.isyatirim.com.tr/',
    'X-Requested-With': 'XMLHttpRequest',
  };

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;

      const text = await r.text();
      console.log(`[İşYat] ${ticker}: ${text.length} chars`);

      if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
        try {
          const data = JSON.parse(text);
          const flat = JSON.stringify(data);
          const extract = (keys) => {
            for (const k of keys) {
              const m = flat.match(new RegExp(`"${k}"\\s*:\\s*"?([0-9]+[.,]?[0-9]*)"?`, 'i'));
              if (m) { const v = safeNum(m[1]); if (v != null && v > 0) return v; }
            }
            return null;
          };
          out.pe  = extract(['fk', 'f_k', 'pe', 'fiyatKazanc', 'piyasaDegerKazanc']);
          out.pb  = extract(['fdd', 'f_dd', 'pb', 'pdDd', 'fiyatDefter']);
          out.roe = extract(['roe', 'ozSermayeKarliligi']);
          if (out.roe && out.roe > 3) out.roe /= 100;
          if (out.pe || out.pb) { out.source = 'IsYatirim/JSON'; return out; }
        } catch {}
      }

      const pairs = [
        { key: 'pe',  labels: ['F/K', 'Fiyat/Kazanç'],           max: 300 },
        { key: 'pb',  labels: ['F/DD', 'PD/DD', 'Fiyat/Defter'], max: 50  },
        { key: 'roe', labels: ['ROE'],                             max: 200, pct: true },
      ];
      for (const { key, labels, max, pct } of pairs) {
        for (const lbl of labels) {
          const idx = text.indexOf(lbl);
          if (idx < 0) continue;
          const after = text.slice(idx + lbl.length, idx + lbl.length + 200);
          const m = after.match(/([0-9]+[.,][0-9]+)/);
          if (m) {
            let v = safeNum(m[1]);
            if (pct && v > 3) v /= 100;
            if (inRange(v, 0.001, max)) {
              out[key] = v;
              out.source = 'IsYatirim/HTML';
              console.log(`[İşYat ${key}] ${ticker}: ${v}`);
              break;
            }
          }
        }
      }

      if (out.pe != null || out.pb != null) return out;
    } catch (e) {
      console.log(`[İşYat] ${ticker}: ${e.message}`);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 3. BİGPARA — Hürriyet finansal veri
// ════════════════════════════════════════════════════════════════
async function fetchBigPara(ticker) {
  const out = { pe: null, pb: null, roe: null, source: null };
  const urls = [
    `https://bigpara.hurriyet.com.tr/hisse/${ticker.toLowerCase()}/hisse-senedi/`,
    `https://bigpara.hurriyet.com.tr/hisse/${ticker.toLowerCase()}/temel-veriler/`,
  ];

  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent':      UA.chrome,
          'Accept':          'text/html,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9',
          'Referer':         'https://bigpara.hurriyet.com.tr/',
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) continue;
      const text = await r.text();
      console.log(`[BigPara] ${ticker}: ${text.length} chars`);

      const pairs = [
        { key: 'pe',  labels: ['F/K', 'Fiyat/Kazanç', 'Piyasa Değ./Kazanç'], max: 300 },
        { key: 'pb',  labels: ['F/DD', 'PD/DD', 'Piyasa Değ./Defter'],        max: 50  },
        { key: 'roe', labels: ['ROE', 'Özsermaye Kârlılığı'],                  max: 200, pct: true },
      ];
      for (const { key, labels, max, pct } of pairs) {
        for (const lbl of labels) {
          const idx = text.indexOf(lbl);
          if (idx < 0) continue;
          const after = text.slice(idx + lbl.length, idx + lbl.length + 250);
          const m = after.match(/([0-9]+[.,][0-9]+)/);
          if (m) {
            let v = safeNum(m[1]);
            if (pct && v > 3) v /= 100;
            if (inRange(v, 0.001, max)) {
              out[key] = v;
              out.source = 'BigPara';
              console.log(`[BigPara ${key}] ${ticker}: ${v}`);
              break;
            }
          }
        }
      }
      if (out.pe != null || out.pb != null) return out;
    } catch (e) {
      console.log(`[BigPara] ${ticker}: ${e.message}`);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 4. YAHOO FİNANCE — Canlı kur ile doğru normalize
// ════════════════════════════════════════════════════════════════
async function fetchYahooNormalized(ticker) {
  const out = { pe: null, pb: null, peg: null, roe: null, marketCap: null, currentPrice: null, source: null };

  // Canlı kur al
  const USD_TRY = await getUsdTry();

  // ── normalizeToTRY: MarketCap referansıyla birim tespit ──
  // MarketCap her zaman TRY cinsinden doğru gelir (Yahoo bunu doğru yapar)
  // Diğer bilanço rakamlarını buna göre normalize ediyoruz
  function normalizeToTRY(rawVal, marketCap, label) {
    if (rawVal == null || marketCap == null) return rawVal;
    const ratio = Math.abs(rawVal) / marketCap;
    console.log(`[Norm] ${label}: val=${rawVal.toExponential(2)} mc=${marketCap.toExponential(2)} ratio=${ratio.toFixed(5)}`);

    // Makul aralık: 1% - 1000% arası
    if (ratio >= 0.001 && ratio <= 10) return rawVal;

    // Çok küçük → USD cinsinden gelmiş → TRY'ye çevir
    if (ratio < 0.001) {
      const asTRY = rawVal * USD_TRY;
      const r2 = Math.abs(asTRY) / marketCap;
      if (r2 >= 0.001 && r2 <= 10) {
        console.log(`[Norm] ${label} × ${USD_TRY.toFixed(1)} (USD→TRY)`);
        return asTRY;
      }
      // Binlik USD → TRY
      const asTRY_k = rawVal * 1000 * USD_TRY;
      const r3 = Math.abs(asTRY_k) / marketCap;
      if (r3 >= 0.001 && r3 <= 10) {
        console.log(`[Norm] ${label} ×1000×${USD_TRY.toFixed(1)} (binlik USD→TRY)`);
        return asTRY_k;
      }
    }

    // Çok büyük → bin TRY cinsinden → normal TRY'ye çevir
    if (ratio > 10) {
      const div1k = rawVal / 1000;
      const r2 = Math.abs(div1k) / marketCap;
      if (r2 >= 0.001 && r2 <= 10) {
        console.log(`[Norm] ${label} ÷1000 (binlik TRY→TRY)`);
        return div1k;
      }
    }

    console.log(`[Norm] ${label}: normalize edilemedi, ham değer döndürülüyor`);
    return rawVal;
  }

  let crumb = null, cookie = null;
  try {
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA.chrome }, redirect: 'follow', signal: AbortSignal.timeout(5000),
    });
    cookie = (r1.headers.get('set-cookie') || '').split(';')[0] || null;
    if (cookie) {
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA.chrome, 'Cookie': cookie, 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(5000),
      });
      if (r2.ok) crumb = (await r2.text()).trim();
    }
  } catch {}

  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';
  const yt = `${ticker}.IS`;
  const h  = { 'User-Agent': UA.chrome, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', ...(cookie ? { 'Cookie': cookie } : {}) };
  const f  = v => v?.raw ?? null;

  try {
    // ── v7 quote: fiyat, MC, ve Yahoo'nun kendi PE/PB'si ──
    const qr = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yt)}&fields=marketCap,regularMarketPrice,currency,trailingPE,priceToBook,pegRatio${cs}`,
      { headers: h, signal: AbortSignal.timeout(8000) }
    );
    if (qr.ok) {
      const qj = await qr.json();
      const q  = qj?.quoteResponse?.result?.[0];
      if (q) {
        out.marketCap    = q.marketCap ?? null;
        out.currentPrice = q.regularMarketPrice ?? null;
        // Yahoo'nun trailingPE'si BIST için genellikle doğru gelir (hisse fiyatı / EPS)
        const rawPE = q.trailingPE;
        if (rawPE != null && inRange(rawPE, 0.5, 200)) out.pe = parseFloat(rawPE.toFixed(2));
        // PriceToBook ise sorunlu olabilir — inRange ile filtrele
        const rawPB = q.priceToBook;
        if (rawPB != null && inRange(rawPB, 0.03, 30)) out.pb = parseFloat(rawPB.toFixed(2));
        const rawPEG = q.pegRatio;
        if (rawPEG != null && inRange(rawPEG, 0.01, 20)) out.peg = parseFloat(rawPEG.toFixed(2));
        out.source = 'Yahoo/v7';
        console.log(`[Yahoo v7] ${ticker}: PE=${out.pe} PB=${out.pb} MC=${out.marketCap?.toExponential(3)} USDTRY=${USD_TRY}`);
      }
    }

    // ── v10 quoteSummary: bilanço ve gelir tablosu (formül için) ──
    const v10 = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yt)}?modules=defaultKeyStatistics,financialData,balanceSheetHistory,incomeStatementHistory${cs}`,
      { headers: h, signal: AbortSignal.timeout(10000) }
    );
    if (v10.ok) {
      const vj  = await v10.json();
      const raw = vj?.quoteSummary?.result?.[0];
      if (raw) {
        const ks  = raw.defaultKeyStatistics  || {};
        const fd  = raw.financialData         || {};
        const bsh = raw.balanceSheetHistory   || {};
        const ish = raw.incomeStatementHistory || {};
        const MC  = out.marketCap;

        // ── Özsermaye (normalize edilmiş TRY) ──
        const sheets = bsh.balanceSheetStatements || [];
        let equity = null;
        if (sheets.length > 0) {
          const lat = sheets[0];
          const se  = f(lat.totalStockholderEquity);
          const ta  = f(lat.totalAssets);
          const tl  = f(lat.totalLiab);
          const seN = MC ? normalizeToTRY(se, MC, 'SE') : se;
          const taN = MC ? normalizeToTRY(ta, MC, 'TA') : ta;
          const tlN = MC ? normalizeToTRY(tl, MC, 'TL') : tl;
          if (seN != null && seN > 0) equity = seN;
          else if (taN != null && tlN != null && taN - tlN > 0) equity = taN - tlN;
          console.log(`[Yahoo Equity] ${ticker}: equity=${equity?.toExponential(3)} (USDTRY=${USD_TRY})`);
        }

        // ── PB formül: MC / Özsermaye (Yahoo PB başarısızsa) ──
        if (out.pb == null && equity && MC) {
          const pbCalc = MC / equity;
          console.log(`[Yahoo PB Formül] ${ticker}: ${MC.toExponential(3)} / ${equity.toExponential(3)} = ${pbCalc.toFixed(3)}`);
          if (inRange(pbCalc, 0.03, 25)) {
            out.pb = parseFloat(pbCalc.toFixed(2));
            out.source = (out.source || '') + '+PB-formül';
          }
        }

        // ── Net kâr (normalize TRY) ──
        const stmts = ish.incomeStatementHistory || [];
        let netIncome = null;
        if (stmts.length > 0) {
          const niRaw = f(stmts[0].netIncome);
          netIncome = MC ? normalizeToTRY(niRaw, MC, 'NI') : niRaw;
        }

        // ── PE formül: MC / Net Kâr (Yahoo PE başarısızsa) ──
        if (out.pe == null && netIncome && MC && netIncome > 0) {
          const peCalc = MC / netIncome;
          console.log(`[Yahoo PE Formül] ${ticker}: MC/NI = ${peCalc.toFixed(2)}`);
          if (inRange(peCalc, 0.5, 200)) {
            out.pe = parseFloat(peCalc.toFixed(2));
            out.source = (out.source || '') + '+PE-formül';
          }
        }

        // ── PE formül 2: Fiyat / EPS (normalize) ──
        if (out.pe == null && out.currentPrice) {
          const epsRaw = f(ks.trailingEps);
          if (epsRaw != null && epsRaw !== 0) {
            // EPS < 20 ise USD cinsinden gelmiş
            const epsNorm = Math.abs(epsRaw) < 20 ? epsRaw * USD_TRY : epsRaw;
            const peEps = out.currentPrice / epsNorm;
            console.log(`[Yahoo PE EPS] ${ticker}: ${out.currentPrice} / ${epsNorm.toFixed(2)} = ${peEps.toFixed(2)} (USDTRY=${USD_TRY})`);
            if (inRange(peEps, 0.5, 200)) {
              out.pe = parseFloat(peEps.toFixed(2));
              out.source = (out.source || '') + '+PE-EPS';
            }
          }
        }

        // ── PEG ──
        if (out.peg == null && out.pe != null) {
          const egrRaw = f(ks.earningsGrowth) ?? f(fd.earningsGrowth) ?? f(fd.revenueGrowth);
          if (egrRaw != null && egrRaw > 0) {
            const egr = Math.abs(egrRaw) > 5 ? egrRaw / 100 : egrRaw;
            const peg = out.pe / (egr * 100);
            if (inRange(peg, 0.01, 20)) {
              out.peg = parseFloat(peg.toFixed(2));
              out.source = (out.source || '') + '+PEG-formül';
            }
          }
        }

        // ── ROE ──
        const roeRaw = f(fd.returnOnEquity);
        if (roeRaw != null && Math.abs(roeRaw) < 5) out.roe = roeRaw;
        else if (equity && netIncome) {
          const roeCalc = netIncome / equity;
          if (Math.abs(roeCalc) < 3) out.roe = parseFloat(roeCalc.toFixed(4));
        }
      }
    }
  } catch (e) {
    console.log(`[Yahoo] ${ticker}: ${e.message}`);
  }

  return out;
}

// ════════════════════════════════════════════════════════════════
// ANA ORKESTRASYON
// Öncelik: Mynet → İşYatırım → BigPara → Yahoo
// ════════════════════════════════════════════════════════════════
async function getBISTRatios(ticker) {
  ticker = ticker.toUpperCase().trim();
  const cacheKey = `bist:${ticker}`;

  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[Cache HIT] ${ticker}`);
    return cached.data;
  }

  console.log(`\n${'═'.repeat(60)}\n[BIST Ratios v2] ${ticker} — sorgu başlıyor\n${'═'.repeat(60)}`);

  // Paralel çek
  const [mn, iy, bp, yh] = await Promise.allSettled([
    fetchMynet(ticker),
    fetchIsYatirim(ticker),
    fetchBigPara(ticker),
    fetchYahooNormalized(ticker),
  ]).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : {}));

  console.log('[Debug]', JSON.stringify({
    mynet:   { pe: mn.pe,  pb: mn.pb  },
    isYat:   { pe: iy.pe,  pb: iy.pb  },
    bigPara: { pe: bp.pe,  pb: bp.pb  },
    yahoo:   { pe: yh.pe,  pb: yh.pb, peg: yh.peg },
  }));

  // Öncelik sırası: Mynet > İşYatırım > BigPara > Yahoo
  function pick(key, min, max) {
    for (const src of [
      { d: mn, name: 'Mynet'     },
      { d: iy, name: 'IsYatirim' },
      { d: bp, name: 'BigPara'   },
      { d: yh, name: 'Yahoo'     },
    ]) {
      const v = src.d[key];
      if (v != null && inRange(v, min, max)) return { val: v, src: src.name };
    }
    return { val: null, src: null };
  }

  const pe  = pick('pe',  0.3,  500);
  const pb  = pick('pb',  0.03,  30);
  const peg = pick('peg', 0.01,  20);
  const roe = pick('roe', -5,     5);

  const final = {
    ticker,
    pe:        pe.val,  source_pe:  pe.src,
    pb:        pb.val,  source_pb:  pb.src,
    peg:       peg.val, source_peg: peg.src,
    roe:       roe.val, source_roe: roe.src,
    marketCap:    yh.marketCap    ?? null,
    currentPrice: yh.currentPrice ?? null,
    usdtry:       _usdtry,
    debug: { mynet: mn, isYat: iy, bigPara: bp, yahoo: yh },
    signals: {
      pe:  pe.val  == null ? 'N/A' : pe.val  < 10 ? 'ucuz' : pe.val  < 20 ? 'adil' : pe.val  < 35 ? 'dikkat' : 'pahalı',
      pb:  pb.val  == null ? 'N/A' : pb.val  < 1  ? 'çok ucuz' : pb.val < 2 ? 'ucuz' : pb.val < 4 ? 'adil' : 'pahalı',
      peg: peg.val == null ? 'N/A' : peg.val < 1  ? 'ucuz' : peg.val < 1.5 ? 'adil' : 'pahalı',
    },
    ts: new Date().toISOString(),
  };

  console.log(`[BIST Final] ${ticker}: PE=${final.pe}(${final.source_pe}) PB=${final.pb}(${final.source_pb}) PEG=${final.peg}(${final.source_peg}) ROE=${final.roe} USDTRY=${_usdtry}`);

  CACHE.set(cacheKey, { data: final, ts: Date.now() });
  if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);

  return final;
}

// ════════════════════════════════════════════════════════════════
// VERCEL HANDLER
// ════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const ticker = req.query?.ticker || req.body?.ticker;
  if (!ticker) return res.status(400).json({ error: 'ticker parametresi zorunlu. Örnek: ?ticker=THYAO' });

  try {
    const data = await getBISTRatios(ticker);
    return res.status(200).json(data);
  } catch (e) {
    console.error('[Handler Error]', e.message);
    return res.status(500).json({ error: e.message, ticker });
  }
}
