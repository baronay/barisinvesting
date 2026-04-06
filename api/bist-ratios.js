// /api/bist-ratios.js — Barış Investing
// BIST Hisseleri: Google Finance → İşYatırım → BigPara → Yahoo Formül
// Vercel'e /api/bist-ratios.js olarak ekle
// GET /api/bist-ratios?ticker=THYAO

const CACHE     = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 dakika

// ── User-Agent'lar ──────────────────────────────────────────────
const UA = {
  chrome:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  safari:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  mobile:  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36',
};

const APPROX_USD_TRY = 38;

// ════════════════════════════════════════════════════════════════
// YARDIMCI: güvenli sayı parse
// ════════════════════════════════════════════════════════════════
function safeNum(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(',', '.').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

function inRange(v, min, max) { return v != null && v > min && v < max; }

// ════════════════════════════════════════════════════════════════
// 1. GOOGLE FİNANCE — 5 farklı parse stratejisi
// ════════════════════════════════════════════════════════════════
async function fetchGoogleFinance(ticker) {
  const out = { pe: null, pb: null, peg: null, source: null };

  // Google Finance URL formatları
  const urls = [
    `https://www.google.com/finance/quote/${ticker}:IST`,
    `https://www.google.com/finance/quote/${ticker}:BIST`,
  ];

  const headerSets = [
    // Masaüstü Chrome
    {
      'User-Agent':      UA.chrome,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest':  'document',
      'Sec-Fetch-Mode':  'navigate',
      'Sec-Fetch-Site':  'none',
      'Sec-Fetch-User':  '?1',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control':   'no-cache',
      'Pragma':          'no-cache',
    },
    // Firefox
    {
      'User-Agent':      UA.firefox,
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection':      'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
    // Mobil Android
    {
      'User-Agent':      UA.mobile,
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  ];

  for (const url of urls) {
    for (const headers of headerSets) {
      try {
        const r = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(9000),
          redirect: 'follow',
        });

        if (!r.ok) { console.log(`[GF] ${ticker} HTTP ${r.status}`); continue; }

        const html = await r.text();
        console.log(`[GF] ${ticker}: ${html.length} chars — ${url}`);

        if (html.length < 5000) { console.log(`[GF] Sayfa çok kısa, bot koruması olabilir`); continue; }

        // ── Strateji 1: AF_initDataCallback gömülü JSON ──────────
        // Google Finance tüm verileri bu callback içine gömer
        // Format: AF_initDataCallback({key:'ds:...', data:function(){return [[...]];}})
        const afBlocks = [...html.matchAll(/AF_initDataCallback\s*\(\s*\{[^}]*?data\s*:\s*function[^(]*\(\s*\)\s*\{return\s+([\s\S]{50,30000}?)\}\s*\}\s*\)/g)];
        for (const blk of afBlocks) {
          try {
            const raw = blk[1].trim();
            // AF block içindeki sayısal değerleri tara
            // P/E, P/B, PEG değerleri genelde array içinde float olarak durur
            // Tipik: [null,null,3.15,null,...] veya ["P/E ratio",3.15]
            
            // "P/E ratio" string'ini ara ve yakınındaki sayıyı al
            const peIdx = raw.indexOf('P\\/E ratio') > 0 ? raw.indexOf('P\\/E ratio') : raw.indexOf('P/E ratio');
            if (peIdx >= 0 && out.pe == null) {
              const nearby = raw.slice(Math.max(0, peIdx - 50), peIdx + 150);
              const nm = nearby.match(/([0-9]+\.[0-9]{1,3})/g);
              if (nm) {
                for (const n of nm) {
                  const v = parseFloat(n);
                  if (inRange(v, 0.5, 500)) { out.pe = v; console.log(`[GF AF-PE] ${ticker}: ${v}`); break; }
                }
              }
            }

            const pbIdx = raw.indexOf('Price\\/Book') > 0 ? raw.indexOf('Price\\/Book') :
                          raw.indexOf('Price/Book') > 0  ? raw.indexOf('Price/Book')  : -1;
            if (pbIdx >= 0 && out.pb == null) {
              const nearby = raw.slice(Math.max(0, pbIdx - 50), pbIdx + 150);
              const nm = nearby.match(/([0-9]+\.[0-9]{1,3})/g);
              if (nm) {
                for (const n of nm) {
                  const v = parseFloat(n);
                  if (inRange(v, 0.05, 50)) { out.pb = v; console.log(`[GF AF-PB] ${ticker}: ${v}`); break; }
                }
              }
            }
          } catch(e) { /* ignore parse errors */ }
        }

        // ── Strateji 2: HTML tablo satırları ─────────────────────
        // <tr><td class="...">P/E ratio</td><td class="...">3.15</td></tr>
        // veya <div class="P6K39c">P/E ratio</div><div class="YMlKec">3.15</div>
        const tablePatterns = [
          // Format: label span + value span bitişik
          { key: 'pe',  rx: /(?:P\/E ratio|Fiyat\/Kazanç)[^<]{0,200}?(?:<[^>]+>){1,6}([0-9]+[.,][0-9]+)/ },
          { key: 'pb',  rx: /(?:Price\/Book|F\/DD|PD\/DD)[^<]{0,200}?(?:<[^>]+>){1,6}([0-9]+[.,][0-9]+)/ },
          { key: 'peg', rx: /(?:PEG ratio)[^<]{0,200}?(?:<[^>]+>){1,6}([0-9]+[.,][0-9]+)/ },
        ];
        for (const { key, rx } of tablePatterns) {
          if (out[key] != null) continue;
          const m = html.match(rx);
          if (m) {
            const v = safeNum(m[1]);
            const maxV = key === 'pb' ? 50 : key === 'peg' ? 30 : 500;
            if (inRange(v, 0.05, maxV)) {
              out[key] = v;
              out.source = out.source || 'Google/HTML';
              console.log(`[GF HTML-${key}] ${ticker}: ${v}`);
            }
          }
        }

        // ── Strateji 3: JSON-LD structured data ──────────────────
        const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
        for (const blk of ldBlocks) {
          try {
            const obj = JSON.parse(blk[1]);
            const peV = obj.priceEarningsRatio || obj['P/E Ratio'] || obj.trailingPE;
            const pbV = obj.priceToBook || obj['Price/Book'];
            if (peV && out.pe == null) { const v = safeNum(peV); if (inRange(v,0.5,500)) { out.pe = v; out.source='Google/LD'; } }
            if (pbV && out.pb == null) { const v = safeNum(pbV); if (inRange(v,0.05,50))  { out.pb = v; out.source='Google/LD'; } }
          } catch {}
        }

        // ── Strateji 4: Regex tabanlı ham sayı çıkarımı ──────────
        // Google Finance HTML'inde veriler her zaman belirli CSS sınıflarıyla gelir
        // class="YMlKec fxKbKc" gibi — sayı formatı: 3.15 veya 3,15
        const cssNumPatterns = [
          // P/E ratio context
          { key: 'pe',  rxs: [
            /"P\/E ratio"[^[]{0,300}\[null,null,([0-9.]+)/,
            /P\/E\s*ratio[^>]*>[^<]*<[^>]*>([0-9]+[.,][0-9]+)/,
            /isytiHjpZDIFc[^>]*>([0-9]+[.,][0-9]{1,3})[^0-9]/,
            /EV-FAVOK.*?([0-9]+[.,][0-9]+).*?P\/E.*?([0-9]+[.,][0-9]+)/s,
          ]},
          { key: 'pb', rxs: [
            /"Price\/Book"[^[]{0,300}\[null,null,([0-9.]+)/,
            /Price\/Book[^>]*>[^<]*<[^>]*>([0-9]+[.,][0-9]+)/,
          ]},
          { key: 'peg', rxs: [
            /"PEG ratio"[^[]{0,300}\[null,null,([0-9.]+)/,
            /PEG\s*ratio[^>]*>[^<]*<[^>]*>([0-9]+[.,][0-9]+)/,
          ]},
        ];
        for (const { key, rxs } of cssNumPatterns) {
          if (out[key] != null) continue;
          for (const rx of rxs) {
            const m = html.match(rx);
            if (m) {
              const candidates = m.slice(1).filter(Boolean);
              for (const c of candidates) {
                const v = safeNum(c);
                const maxV = key === 'pb' ? 50 : key === 'peg' ? 30 : 500;
                if (inRange(v, 0.05, maxV)) {
                  out[key] = v;
                  out.source = out.source || 'Google/Regex';
                  console.log(`[GF Regex-${key}] ${ticker}: ${v}`);
                  break;
                }
              }
              if (out[key] != null) break;
            }
          }
        }

        // ── Strateji 5: Sayfa içindeki tüm istatistik tablolarını tara ──
        // Google Finance'in "About" bölümünde key stats tablosu var
        // Satır formatı: "P/E ratio\n3.15" veya "P/E ratio3.15"
        const aboutSection = html.match(/(?:About|Statistics|Key stats|Temel istatistikler)([\s\S]{0,8000}?)(?:Related|Benzer|Compare)/i);
        if (aboutSection) {
          const sec = aboutSection[1];
          const kv = [
            { key: 'pe',  labels: ['P/E ratio', 'Fiyat/Kazanç', 'P/E'],        max: 500 },
            { key: 'pb',  labels: ['Price/Book', 'F/DD', 'PD/DD', 'P/B'],      max: 50  },
            { key: 'peg', labels: ['PEG ratio', 'PEG'],                         max: 30  },
          ];
          for (const { key, labels, max } of kv) {
            if (out[key] != null) continue;
            for (const lbl of labels) {
              const idx = sec.indexOf(lbl);
              if (idx >= 0) {
                const after = sec.slice(idx + lbl.length, idx + lbl.length + 120);
                const numMatch = after.match(/([0-9]+[.,][0-9]{1,4})/);
                if (numMatch) {
                  const v = safeNum(numMatch[1]);
                  if (inRange(v, 0.05, max)) {
                    out[key] = v;
                    out.source = out.source || 'Google/Section';
                    console.log(`[GF Section-${key}] ${ticker}: ${v} (label:${lbl})`);
                    break;
                  }
                }
              }
            }
          }
        }

        if (out.pe != null || out.pb != null) {
          out.source = out.source || 'Google';
          return out;
        }

      } catch(e) {
        console.log(`[GF] ${ticker} fetch error: ${e.message}`);
      }
    }
  }

  console.log(`[GF] ${ticker}: tüm stratejiler başarısız`);
  return out;
}

// ════════════════════════════════════════════════════════════════
// 2. İŞ YATIRIM — Yapılandırılmış veri API'si
// ════════════════════════════════════════════════════════════════
async function fetchIsYatirim(ticker) {
  const out = { pe: null, pb: null, roe: null, peg: null, source: null };

  const endpoints = [
    // Hisse özet API (JSON döner)
    `https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/HisseSenetleri?hisse=${ticker}`,
    // Hisse detay sayfası
    `https://www.isyatirim.com.tr/analiz-ve-bulten/hisse/${ticker}`,
  ];

  const headers = {
    'User-Agent':      UA.chrome,
    'Accept':          'text/html,application/json,*/*;q=0.8',
    'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8',
    'Referer':         'https://www.isyatirim.com.tr/',
    'X-Requested-With': 'XMLHttpRequest',
  };

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;

      const text = await r.text();
      console.log(`[İşYat] ${ticker}: ${text.length} chars`);

      // JSON yanıtı
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
          if (out.roe && out.roe > 3) out.roe /= 100; // yüzde → oran
          if (out.pe || out.pb) { out.source = 'IsYatirim/JSON'; return out; }
        } catch {}
      }

      // HTML scraping
      const pairs = [
        { key: 'pe',  labels: ['F/K', 'Fiyat/Kazanç'],        max: 300 },
        { key: 'pb',  labels: ['F/DD', 'PD/DD', 'Fiyat/Defter'], max: 50  },
        { key: 'roe', labels: ['ROE'],                          max: 200, pct: true },
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
    } catch(e) {
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
    } catch(e) {
      console.log(`[BigPara] ${ticker}: ${e.message}`);
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════
// 4. YAHOO FİNANCE — Akıllı normalize + formül fallback
// ════════════════════════════════════════════════════════════════
function normalizeToTRY(rawVal, marketCap, label) {
  if (rawVal == null || marketCap == null) return rawVal;
  const ratio = Math.abs(rawVal) / marketCap;
  console.log(`[Norm] ${label}: val=${rawVal.toExponential(2)} mc=${marketCap.toExponential(2)} ratio=${ratio.toFixed(5)}`);

  // 0.05x - 100x arası = makul
  if (ratio >= 0.05 && ratio <= 100) return rawVal;

  // Çok küçük → USD gelmiş
  if (ratio < 0.05) {
    const asTRY = rawVal * APPROX_USD_TRY;
    if (Math.abs(asTRY) / marketCap >= 0.05) { console.log(`[Norm] ${label} × ${APPROX_USD_TRY}`); return asTRY; }
    const asTRY_k = rawVal * 1000 * APPROX_USD_TRY;
    if (Math.abs(asTRY_k) / marketCap >= 0.05) { console.log(`[Norm] ${label} ×1000×${APPROX_USD_TRY}`); return asTRY_k; }
  }
  // Çok büyük → binlik TL
  if (ratio > 100) {
    const div1k = rawVal / 1000;
    if (Math.abs(div1k) / marketCap <= 100) { console.log(`[Norm] ${label} ÷1000`); return div1k; }
  }
  return rawVal;
}

async function fetchYahooNormalized(ticker) {
  const out = { pe: null, pb: null, peg: null, roe: null, marketCap: null, currentPrice: null, source: null };

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
  const h  = { 'User-Agent': UA.chrome, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/', ...(cookie ? {'Cookie': cookie} : {}) };
  const f  = v => v?.raw ?? null;

  try {
    // Piyasa değeri + fiyat (v7)
    const qr = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yt)}&fields=marketCap,regularMarketPrice,currency,trailingPE,priceToBook,epsTrailingTwelveMonths,pegRatio${cs}`,
      { headers: h, signal: AbortSignal.timeout(8000) }
    );
    if (qr.ok) {
      const qj = await qr.json();
      const q  = qj?.quoteResponse?.result?.[0];
      if (q) {
        out.marketCap    = q.marketCap    ?? null;
        out.currentPrice = q.regularMarketPrice ?? null;
        // PE: 0.5-100 arasındaysa güven
        const rawPE = q.trailingPE;
        if (rawPE != null && inRange(rawPE, 0.5, 100)) out.pe = parseFloat(rawPE.toFixed(2));
        // PB: 0.05-30 arasındaysa güven
        const rawPB = q.priceToBook;
        if (rawPB != null && inRange(rawPB, 0.05, 30)) out.pb = parseFloat(rawPB.toFixed(2));
        // PEG
        const rawPEG = q.pegRatio;
        if (rawPEG != null && inRange(rawPEG, 0.01, 20)) out.peg = parseFloat(rawPEG.toFixed(2));

        out.source = 'Yahoo/v7';
        console.log(`[Yahoo v7] ${ticker}: PE=${out.pe} PB=${out.pb} PEG=${out.peg} MC=${out.marketCap?.toExponential(3)}`);
      }
    }

    // Bilanço + gelir tablosu (v10) — formül için
    const v10 = await fetch(
      `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yt)}?modules=defaultKeyStatistics,financialData,balanceSheetHistory,incomeStatementHistory${cs}`,
      { headers: h, signal: AbortSignal.timeout(10000) }
    );
    if (v10.ok) {
      const vj  = await v10.json();
      const raw = vj?.quoteSummary?.result?.[0];
      if (raw) {
        const ks  = raw.defaultKeyStatistics    || {};
        const fd  = raw.financialData           || {};
        const bsh = raw.balanceSheetHistory     || {};
        const ish = raw.incomeStatementHistory  || {};

        const MC = out.marketCap;

        // ── Özsermaye (normalize edilmiş) ──
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
          console.log(`[Yahoo Equity] ${ticker}: SE=${seN?.toExponential(3)} equity=${equity?.toExponential(3)}`);
        }

        // ── PB formül: MC / Özsermaye ──
        if (out.pb == null && equity && MC) {
          const pbCalc = MC / equity;
          console.log(`[Yahoo PB Formül] ${ticker}: MC/EQ = ${MC.toExponential(3)} / ${equity.toExponential(3)} = ${pbCalc.toFixed(3)}`);
          if (inRange(pbCalc, 0.05, 25)) {
            out.pb = parseFloat(pbCalc.toFixed(2));
            out.source = (out.source||'') + '+PB-formül';
          }
        }

        // ── Net kâr (normalize) ──
        const stmts = ish.incomeStatementHistory || [];
        let netIncome = null;
        if (stmts.length > 0) {
          const niRaw = f(stmts[0].netIncome);
          netIncome = MC ? normalizeToTRY(niRaw, MC, 'NI') : niRaw;
          console.log(`[Yahoo NI] ${ticker}: niRaw=${niRaw?.toExponential(3)} niNorm=${netIncome?.toExponential(3)}`);
        }

        // ── PE formül: MC / Net Kâr ──
        if (out.pe == null && netIncome && MC && netIncome > 0) {
          const peCalc = MC / netIncome;
          console.log(`[Yahoo PE Formül] ${ticker}: MC/NI = ${peCalc.toFixed(2)}`);
          if (inRange(peCalc, 0.5, 150)) {
            out.pe = parseFloat(peCalc.toFixed(2));
            out.source = (out.source||'') + '+PE-MC/NI';
          }
        }

        // ── PE formül 2: Fiyat / EPS ──
        if (out.pe == null && out.currentPrice) {
          const epsRaw = f(ks.trailingEps);
          if (epsRaw != null && epsRaw !== 0) {
            const epsNorm = Math.abs(epsRaw) < 20 ? epsRaw * APPROX_USD_TRY : epsRaw;
            const peEps = out.currentPrice / epsNorm;
            console.log(`[Yahoo PE EPS] ${ticker}: ${out.currentPrice} / ${epsNorm.toFixed(2)} = ${peEps.toFixed(2)}`);
            if (inRange(peEps, 0.5, 150)) {
              out.pe = parseFloat(peEps.toFixed(2));
              out.source = (out.source||'') + '+PE-EPS';
            }
          }
        }

        // ── PEG: PE / Büyüme oranı ──
        if (out.peg == null && out.pe != null) {
          const egrRaw = f(ks.earningsGrowth) ?? f(fd.earningsGrowth) ?? f(fd.revenueGrowth);
          if (egrRaw != null && egrRaw > 0) {
            const egr = Math.abs(egrRaw) > 5 ? egrRaw / 100 : egrRaw; // % → oran
            const peg = out.pe / (egr * 100);
            if (inRange(peg, 0.01, 20)) {
              out.peg = parseFloat(peg.toFixed(2));
              out.source = (out.source||'') + '+PEG-formül';
              console.log(`[Yahoo PEG] ${ticker}: PE=${out.pe} / büyüme=%${(egr*100).toFixed(1)} = ${out.peg}`);
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
  } catch(e) {
    console.log(`[Yahoo] ${ticker}: ${e.message}`);
  }

  return out;
}

// ════════════════════════════════════════════════════════════════
// ANA ORKESTRASYUN
// ════════════════════════════════════════════════════════════════
async function getBISTRatios(ticker) {
  ticker = ticker.toUpperCase().trim();
  const cacheKey = `bist:${ticker}`;

  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    console.log(`[Cache HIT] ${ticker}`);
    return cached.data;
  }

  console.log(`\n${'═'.repeat(60)}\n[BIST Ratios] ${ticker} — sorgu başlıyor\n${'═'.repeat(60)}`);

  // Paralel çek
  const [gf, iy, bp, yh] = await Promise.allSettled([
    fetchGoogleFinance(ticker),
    fetchIsYatirim(ticker),
    fetchBigPara(ticker),
    fetchYahooNormalized(ticker),
  ]).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value : {}));

  const debug = { google: gf, isYat: iy, bigPara: bp, yahoo: yh };
  console.log('[Debug]', JSON.stringify({ google: {pe:gf.pe, pb:gf.pb, peg:gf.peg}, isYat: {pe:iy.pe, pb:iy.pb}, bigPara: {pe:bp.pe, pb:bp.pb}, yahoo: {pe:yh.pe, pb:yh.pb, peg:yh.peg} }));

  // Öncelik sırası: Google > İşYat > BigPara > Yahoo
  function pick(key, min, max) {
    for (const src of [
      { d: gf, name: 'Google'   },
      { d: iy, name: 'IsYatirim' },
      { d: bp, name: 'BigPara'  },
      { d: yh, name: 'Yahoo'    },
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
    marketCap:   yh.marketCap    ?? null,
    currentPrice: yh.currentPrice ?? null,
    debug,
    signals: {
      pe:  pe.val  == null ? 'N/A' : pe.val  < 10 ? 'ucuz' : pe.val  < 20 ? 'adil' : pe.val  < 35 ? 'dikkat' : 'pahalı',
      pb:  pb.val  == null ? 'N/A' : pb.val  < 1  ? 'çok ucuz' : pb.val < 2 ? 'ucuz' : pb.val < 4 ? 'adil' : 'pahalı',
      peg: peg.val == null ? 'N/A' : peg.val < 1  ? 'ucuz' : peg.val < 1.5 ? 'adil' : 'pahalı',
    },
    ts: new Date().toISOString(),
  };

  console.log(`[BIST Final] ${ticker}: PE=${final.pe}(${final.source_pe}) PB=${final.pb}(${final.source_pb}) PEG=${final.peg}(${final.source_peg}) ROE=${final.roe}`);

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
  } catch(e) {
    console.error('[Handler Error]', e.message);
    return res.status(500).json({ error: e.message, ticker });
  }
}
