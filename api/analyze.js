// /api/analyze.js — Barış Investing
// Veri Motoru: Yahoo Finance (v7 quote + v10 quoteSummary)
// Önbellek: In-memory, 1 saat TTL

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
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA }, redirect: 'follow'
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookieVal = setCookie.split(';')[0] || '';
    if (!cookieVal) return { crumb: null, cookie: null };

    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': UA,
        'Cookie': cookieVal,
        'Accept': 'text/plain',
        'Referer': 'https://finance.yahoo.com/',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    });
    if (r2.ok) {
      const crumbText = await r2.text();
      if (crumbText && crumbText.length > 0) {
        _crumb = crumbText.trim();
        _cookie = cookieVal;
        _crumbTs = Date.now();
        console.log('Yahoo crumb OK:', _crumb.substring(0, 6));
      }
    }
  } catch(e) {
    console.log('Crumb failed:', e.message);
  }
  return { crumb: _crumb, cookie: _cookie };
}

// ── YAHOO FİNANCE VERİ ÇEKME ────────────────────────────────────
async function fetchYahooData(yahooTicker) {
  const cacheKey = `yahoo:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) { console.log(`Yahoo cache hit: ${yahooTicker}`); return cached; }

  const { crumb, cookie } = await getYahooCrumb();
  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

  const makeHeaders = () => ({
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
    ...(cookie ? { 'Cookie': cookie } : {}),
  });

  let result = {
    currentPrice: null,
    currency: yahooTicker.endsWith('.IS') ? 'TRY' : 'USD',
    marketCap: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null,
    peRatio: null, forwardPE: null, pbRatio: null, pegRatio: null, evEbitda: null,
    grossMargin: null, operatingMargin: null, profitMargin: null,
    roe: null, roa: null, freeCashflow: null, operatingCashflow: null,
    totalCash: null, totalDebt: null, debtToEquity: null, currentRatio: null,
    revenueGrowth: null, earningsGrowth: null,
    institutionOwnership: null, recommendationKey: null,
    targetMeanPrice: null, numberOfAnalystOpinions: null,
    website: null, sector: null, industry: null,
    peers: [], dataSource: 'Yahoo',
  };

  // ── 1. v7 quote (fiyat + temel değerleme) ──
  for (const base of ['query2', 'query1']) {
    try {
      const fields = [
        'regularMarketPrice','currency','marketCap',
        'fiftyTwoWeekLow','fiftyTwoWeekHigh',
        'trailingPE','forwardPE','priceToBook','pegRatio','enterpriseToEbitda',
        'profitMargins','grossMargins','operatingMargins',
        'returnOnEquity','returnOnAssets',
        'freeCashflow','operatingCashflow','totalCash','totalDebt',
        'debtToEquity','currentRatio',
        'revenueGrowth','earningsGrowth',
        'heldPercentInstitutions','targetMeanPrice',
        'recommendationKey','numberOfAnalystOpinions'
      ].join(',');

      const url = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooTicker)}&fields=${fields}${cs}`;
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.log(`v7 ${base} status: ${r.status}`); continue; }
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      if (!q?.regularMarketPrice) { console.log(`v7 ${base}: no price`); continue; }

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
    } catch(e) { console.log(`v7 ${base} error:`, e.message); continue; }
  }

  // ── 2. v10 quoteSummary — BIST için ROE, FCF, marj gibi eksik verileri tamamla ──
  const needsMore = !result.roe || !result.grossMargin || !result.freeCashflow || !result.totalDebt;
  if (needsMore) {
    const modules = 'financialData,defaultKeyStatistics,summaryDetail,assetProfile';
    for (const base of ['query2', 'query1']) {
      try {
        const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}${cs}`;
        const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(8000) });
        if (!r.ok) { console.log(`v10 ${base} status: ${r.status}`); continue; }
        const j = await r.json();
        const raw = j?.quoteSummary?.result?.[0];
        if (!raw) continue;

        const fd  = raw.financialData       || {};
        const ks  = raw.defaultKeyStatistics || {};
        const sd  = raw.summaryDetail        || {};
        const ap  = raw.assetProfile         || {};
        const f   = v => v?.raw ?? null;

        // Değerleme
        if (!result.peRatio)    result.peRatio    = f(sd.trailingPE)  ?? f(ks.trailingPE);
        if (!result.forwardPE)  result.forwardPE  = f(sd.forwardPE)   ?? f(ks.forwardPE);
        if (!result.pbRatio)    result.pbRatio     = f(ks.priceToBook);
        if (!result.pegRatio)   result.pegRatio    = f(ks.pegRatio);
        if (!result.evEbitda)   result.evEbitda    = f(ks.enterpriseToEbitda);

        // Karlılık
        if (!result.grossMargin)     result.grossMargin     = f(fd.grossMargins);
        if (!result.operatingMargin) result.operatingMargin = f(fd.operatingMargins);
        if (!result.profitMargin)    result.profitMargin    = f(fd.profitMargins);

        // Verimlilik
        if (!result.roe) result.roe = f(fd.returnOnEquity);
        if (!result.roa) result.roa = f(fd.returnOnAssets);

        // Nakit & Borç
        if (!result.freeCashflow)    result.freeCashflow    = f(fd.freeCashflow);
        if (!result.operatingCashflow) result.operatingCashflow = f(fd.operatingCashflow);
        if (!result.totalCash)       result.totalCash       = f(fd.totalCash);
        if (!result.totalDebt)       result.totalDebt       = f(fd.totalDebt);
        if (!result.debtToEquity)    result.debtToEquity    = f(fd.debtToEquity);
        if (!result.currentRatio)    result.currentRatio    = f(fd.currentRatio);

        // Büyüme
        if (!result.revenueGrowth)  result.revenueGrowth  = f(fd.revenueGrowth);
        if (!result.earningsGrowth) result.earningsGrowth = f(fd.earningsGrowth);

        // Sahiplik & analist
        if (!result.institutionOwnership) result.institutionOwnership = f(ks.heldPercentInstitutions);
        if (!result.targetMeanPrice)      result.targetMeanPrice      = f(fd.targetMeanPrice);
        if (!result.recommendationKey)    result.recommendationKey    = fd.recommendationKey ?? null;
        if (!result.numberOfAnalystOpinions) result.numberOfAnalystOpinions = f(fd.numberOfAnalystOpinions);

        // Şirket profili
        result.sector   = ap.sector   ?? null;
        result.industry = ap.industry  ?? null;
        result.website  = ap.website   ?? null;

        console.log(`v10 OK: roe=${result.roe} pb=${result.pbRatio} fcf=${result.freeCashflow} sector=${result.sector}`);
        break;
      } catch(e) { console.log(`v10 ${base} error:`, e.message); continue; }
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
          result.currentPrice = meta.regularMarketPrice;
          result.currency = meta.currency || result.currency;
          result.fiftyTwoWeekLow  = result.fiftyTwoWeekLow  ?? meta.fiftyTwoWeekLow;
          result.fiftyTwoWeekHigh = result.fiftyTwoWeekHigh ?? meta.fiftyTwoWeekHigh;
        }
      }
    } catch {}
  }

  if (!result.currentPrice) throw new Error(`Yahoo veri yok: ${yahooTicker}`);

  // Logo URL — Google favicon (website varsa) veya placeholder
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
function sigPEG(v) { if(v==null)return'N/A'; if(v<1)return'ucuz — Lynch fırsatı'; if(v<1.5)return'adil'; if(v<2)return'dikkatli ol'; return'pahalı — Lynch kaçınır'; }
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
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  let financialData = null;
  try {
    financialData = await fetchYahooData(yahooTicker);
  } catch(e) {
    console.log('Data fetch failed:', e.message);
  }

  const fd = financialData;

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

TÜRK HİSSELERİ: Nominal büyüme TÜFE altındaysa "REEL KÜÇÜLME" uyarısı ekle.`;

  let enrichedPrompt = '';
  if (fd) {
    const n   = (v, d=1) => v != null ? Number(v).toFixed(d) : 'N/A';
    const p   = v => v != null ? `%${(v*100).toFixed(1)}` : 'N/A';
    const big = v => {
      if (v == null) return 'N/A';
      const a = Math.abs(v);
      if (a >= 1e12) return `${(v/1e12).toFixed(2)}T`;
      if (a >= 1e9)  return `${(v/1e9).toFixed(2)}B`;
      if (a >= 1e6)  return `${(v/1e6).toFixed(2)}M`;
      return Number(v).toFixed(0);
    };
    const nc     = (fd.totalCash != null && fd.totalDebt != null) ? fd.totalCash - fd.totalDebt : null;
    const upside = fd.currentPrice && fd.targetMeanPrice
      ? ((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice * 100).toFixed(1) : null;

    let warnings = '';
    if (fd.peRatio  != null && fd.peRatio  > 0 && fd.peRatio  < 3)   warnings += 'VERİ UYARISI: F/K anormal düşük — doğrula.\n';
    if (fd.pbRatio  != null && fd.pbRatio  > 0 && fd.pbRatio  < 0.2) warnings += 'VERİ UYARISI: F/DD anormal düşük — doğrula.\n';

    enrichedPrompt = `GERÇEK FİNANSAL VERİLER [Yahoo Finance] — BU RAKAMLARI KULLAN:
Fiyat: ${fd.currentPrice ? `${Number(fd.currentPrice).toFixed(2)} ${fd.currency}` : 'N/A'}
52H Aralık: ${n(fd.fiftyTwoWeekLow,2)} - ${n(fd.fiftyTwoWeekHigh,2)} ${fd.currency||''}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${n(fd.peRatio)} | F/K Forward: ${n(fd.forwardPE)} | F/DD: ${n(fd.pbRatio)}
PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)} | ROA: ${p(fd.roa)}
Brüt Marj: ${p(fd.grossMargin)} | Faaliyet Marjı: ${p(fd.operatingMargin)} | Net Marj: ${p(fd.profitMargin)}
FCF: ${big(fd.freeCashflow)} | Op.CF: ${big(fd.operatingCashflow)}
Nakit: ${big(fd.totalCash)} | Borç: ${big(fd.totalDebt)} | Net Nakit: ${big(nc)}
Borç/Özsermaye: ${n(fd.debtToEquity)} | Cari Oran: ${n(fd.currentRatio)}
Gelir Büyümesi: ${p(fd.revenueGrowth)} | Kazanç Büyümesi: ${p(fd.earningsGrowth)}
Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${n(fd.targetMeanPrice,2)} | Potansiyel: ${upside?`%${upside}`:'N/A'}
${fd.sector ? `Sektör: ${fd.sector}${fd.industry ? ' / ' + fd.industry : ''}` : ''}
${warnings}
MULTIPLES: PE=${n(fd.peRatio)} PB=${n(fd.pbRatio)} PEG=${n(fd.pegRatio)} EV_EBITDA=${n(fd.evEbitda)}
---
`;
  }

  enrichedPrompt += prompt;
  enrichedPrompt += '\n\nKRİTİK KURAL: Her PASS/FAIL/NEUTRAL pipe (|) ile açıklama içermeli. CRITERIA_START/CRITERIA_END olmalı. Her kriter 2-3 cümle somut analiz.';

  if (!fd) {
    enrichedPrompt += '\n\nVERİ NOTU: Finansal veri alınamadı. Sektör bilgine göre tahmin yap. "Veri sınırlı" uyarısı ekle ama analizi tamamla.';
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        system: systemPrompt,
        messages: [{ role: 'user', content: enrichedPrompt }]
      })
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: `${data.error.type}: ${data.error.message}` });

    let result = data.content?.[0]?.text || '';

    // TOTAL_SCORE 7 ile sınırla
    result = result.replace(/TOTAL_SCORE:\s*(\d+)/i, (m, n) =>
      `TOTAL_SCORE: ${Math.min(7, Math.max(0, parseInt(n)))}`
    );

    // Yahoo değerlerini AI çıktısına override et
    if (fd) {
      const n2 = (v,d=1) => v!=null ? Number(v).toFixed(d) : 'N/A';
      if (fd.peRatio  != null) result = result.replace(/PE:\s*[\d.N\/A]+\s*\|/, `PE: ${n2(fd.peRatio)} |`);
      if (fd.pbRatio  != null) result = result.replace(/PB:\s*[\d.N\/A]+\s*\|/, `PB: ${n2(fd.pbRatio)} |`);
      if (fd.pegRatio != null) result = result.replace(/PEG:\s*[\d.N\/A]+\s*\|/, `PEG: ${n2(fd.pegRatio)} |`);
      if (fd.evEbitda != null) result = result.replace(/EV_EBITDA:\s*[\d.N\/A]+\s*\|/, `EV_EBITDA: ${n2(fd.evEbitda)} |`);
    }

    console.log(`OK ${ticker} | src:${fd?.dataSource||'none'} | roe:${fd?.roe} | pb:${fd?.pbRatio} | len:${result.length}`);
    return res.status(200).json({
      result,
      financialData: fd,
      peers: fd?.peers || [],
    });

  } catch(err) {
    console.error('Analyze error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
