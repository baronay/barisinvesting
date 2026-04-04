// /api/analyze.js — Barış Investing
// Veri Motoru: FMP (birincil) + Yahoo Finance (yedek)
// Önbellek: In-memory, 1 saat TTL
// FMP ENV: FMP_API_KEY

// ── ÖNBELLEK ────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 saat

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

// ── FMP API HELPER ───────────────────────────────────────────────
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

async function fmp(path, params = {}) {
  const key = process.env.FMP_API_KEY;
  if (!key) throw new Error('FMP_API_KEY eksik');
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  const url = `${FMP_BASE}${path}?${qs}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`FMP ${path}: ${r.status}`);
  return r.json();
}

// BIST ticker'ını FMP formatına çevir (THYAO → THYAO.IS)
function toFmpTicker(ticker, exchange) {
  return exchange === 'BIST' ? `${ticker}.IS` : ticker;
}

// ── FMP VERİ ÇEKME ───────────────────────────────────────────────
async function fetchFmpData(ticker, exchange) {
  const sym = toFmpTicker(ticker, exchange);
  const cacheKey = `fmp:${sym}`;
  const cached = getCached(cacheKey);
  if (cached) { console.log(`FMP cache hit: ${sym}`); return cached; }

  try {
    // Paralel istek — limit korumak için sadece gerekli endpointler
    const [quoteArr, profileArr, metricsArr, ratiosArr] = await Promise.allSettled([
      fmp(`/quote/${sym}`),
      fmp(`/profile/${sym}`),
      fmp(`/key-metrics-ttm/${sym}`),
      fmp(`/ratios-ttm/${sym}`),
    ]);

    const quote   = quoteArr.status   === 'fulfilled' ? quoteArr.value?.[0]   : null;
    const profile = profileArr.status === 'fulfilled' ? profileArr.value?.[0] : null;
    const metrics = metricsArr.status === 'fulfilled' ? metricsArr.value?.[0] : null;
    const ratios  = ratiosArr.status  === 'fulfilled' ? ratiosArr.value?.[0]  : null;

    if (!quote && !profile) throw new Error('FMP veri yok');

    const currency = exchange === 'BIST' ? 'TRY' : (quote?.currency || 'USD');

    // ── Peer listesi: aynı industry, aynı exchange, piyasa değerine göre ──
    let peers = [];
    const industry = profile?.industry ?? null;
    const sector   = profile?.sector   ?? null;

    try {
      if (industry) {
        // FMP screener ile aynı industry'deki şirketleri çek
        const screenerParams = {
          industry: industry,
          limit: '50',
          ...(exchange === 'BIST' ? { exchange: 'IST' } : { exchange: 'NASDAQ,NYSE' })
        };
        const screenerData = await fmp('/stock-screener', screenerParams);

        peers = (screenerData || [])
          .filter(p => {
            if (!p.symbol || p.symbol === sym) return false;
            // BIST için .IS ile bitmeli, diğerleri için bitmemeli
            if (exchange === 'BIST') return p.symbol.endsWith('.IS');
            return !p.symbol.endsWith('.IS');
          })
          .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0)) // Piyasa değerine göre sırala
          .slice(0, 4)
          .map(p => p.symbol.replace('.IS', ''));
      }

      // Screener sonuç vermezse stock-peers fallback
      if (peers.length === 0) {
        const peerData = await fmp('/stock-peers', { symbol: sym });
        const raw = peerData?.[0]?.peersList || [];
        peers = raw
          .filter(p => exchange === 'BIST' ? p.endsWith('.IS') : !p.endsWith('.IS'))
          .slice(0, 4)
          .map(p => p.replace('.IS', ''));
      }
    } catch(e) {
      console.log('Peer fetch failed:', e.message);
    }

    const result = {
      // Fiyat
      currentPrice:      quote?.price             ?? null,
      currency,
      marketCap:         quote?.marketCap          ?? profile?.mktCap ?? null,
      fiftyTwoWeekLow:   quote?.yearLow            ?? null,
      fiftyTwoWeekHigh:  quote?.yearHigh           ?? null,

      // Değerleme — FMP'den (daha doğru)
      peRatio:           ratios?.peRatioTTM        ?? quote?.pe ?? null,
      forwardPE:         quote?.priceEpsEstimatedNextYear ?? null,
      pbRatio:           ratios?.priceToBookRatioTTM ?? metrics?.pbRatioTTM ?? null,
      pegRatio:          ratios?.pegRatioTTM       ?? null,
      evEbitda:          metrics?.enterpriseValueOverEBITDATTM ?? ratios?.enterpriseValueMultipleTTM ?? null,

      // Karlılık
      grossMargin:       ratios?.grossProfitMarginTTM    ?? null,
      operatingMargin:   ratios?.operatingProfitMarginTTM ?? null,
      profitMargin:      ratios?.netProfitMarginTTM      ?? null,

      // Verimlilik
      roe:               ratios?.returnOnEquityTTM       ?? metrics?.roeTTM ?? null,
      roa:               ratios?.returnOnAssetsTTM       ?? metrics?.roaTTM ?? null,
      roic:              metrics?.roicTTM                ?? null,

      // Nakit & Borç
      freeCashflow:      metrics?.freeCashFlowPerShareTTM != null && quote?.sharesOutstanding
                           ? metrics.freeCashFlowPerShareTTM * quote.sharesOutstanding
                           : null,
      totalCash:         metrics?.cashPerShareTTM != null && quote?.sharesOutstanding
                           ? metrics.cashPerShareTTM * quote.sharesOutstanding
                           : null,
      totalDebt:         metrics?.debtToEquityTTM != null && metrics?.bookValuePerShareTTM != null && quote?.sharesOutstanding
                           ? metrics.debtToEquityTTM * metrics.bookValuePerShareTTM * quote.sharesOutstanding
                           : null,
      debtToEquity:      metrics?.debtToEquityTTM        ?? ratios?.debtEquityRatioTTM ?? null,
      currentRatio:      ratios?.currentRatioTTM         ?? metrics?.currentRatioTTM ?? null,

      // Büyüme
      revenueGrowth:     metrics?.revenuePerShareTTM != null ? null : null, // FMP TTM büyüme yok, Yahoo'dan alınır
      earningsGrowth:    null,

      // Analist
      institutionOwnership: null, // FMP'de ayrı endpoint, şimdilik null
      recommendationKey:    quote?.analystRatings?.toLowerCase().replace(' ', '-') ?? null,
      targetMeanPrice:      quote?.priceAvg50 ?? null,
      numberOfAnalystOpinions: null,

      // Ekstra FMP verileri
      sector:    sector,
      industry:  industry,
      peers,
      description: profile?.description ?? null,
      website:   profile?.website  ?? null,
      logoUrl:   `https://financialmodelingprep.com/image-stock/${sym}.png`,
      employees: profile?.fullTimeEmployees ?? null,
      country:   profile?.country  ?? null,
      dataSource: 'FMP',
    };

    setCache(cacheKey, result);
    return result;

  } catch(e) {
    console.log(`FMP failed for ${sym}: ${e.message}`);
    return null;
  }
}

// ── YAHOO FİNANCE (YEDEK) ────────────────────────────────────────
let _crumb = null, _cookie = null, _crumbTs = 0;
const CRUMB_TTL = 55 * 60 * 1000;

async function getYahooCrumb() {
  if (_crumb && _cookie && Date.now() - _crumbTs < CRUMB_TTL) return { crumb: _crumb, cookie: _cookie };
  try {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'follow' });
    const cookieVal = (r1.headers.get('set-cookie') || '').split(';')[0] || 'A=o';
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, 'Cookie': cookieVal, 'Accept': 'text/plain', 'Referer': 'https://finance.yahoo.com/' }
    });
    if (r2.ok) { _crumb = await r2.text(); _cookie = cookieVal; _crumbTs = Date.now(); }
  } catch {}
  return { crumb: _crumb, cookie: _cookie };
}

async function fetchYahooData(yahooTicker) {
  const cacheKey = `yahoo:${yahooTicker}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const { crumb, cookie } = await getYahooCrumb();
  const makeHeaders = () => ({
    'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://finance.yahoo.com/',
    ...(cookie ? { 'Cookie': cookie } : {}),
  });
  const cs = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

  let result = {
    currentPrice: null, currency: yahooTicker.endsWith('.IS') ? 'TRY' : 'USD',
    marketCap: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null,
    peRatio: null, forwardPE: null, pbRatio: null, pegRatio: null, evEbitda: null,
    grossMargin: null, operatingMargin: null, profitMargin: null,
    roe: null, roa: null, freeCashflow: null, totalCash: null, totalDebt: null,
    debtToEquity: null, currentRatio: null, revenueGrowth: null, earningsGrowth: null,
    institutionOwnership: null, recommendationKey: null, targetMeanPrice: null,
    numberOfAnalystOpinions: null, peers: [], dataSource: 'Yahoo',
  };

  for (const base of ['query2', 'query1']) {
    try {
      const fields = 'regularMarketPrice,currency,marketCap,fiftyTwoWeekLow,fiftyTwoWeekHigh,trailingPE,forwardPE,priceToBook,pegRatio,enterpriseToEbitda,profitMargins,grossMargins,operatingMargins,returnOnEquity,returnOnAssets,freeCashflow,totalCash,totalDebt,debtToEquity,currentRatio,revenueGrowth,earningsGrowth,heldPercentInstitutions,targetMeanPrice,recommendationKey,numberOfAnalystOpinions';
      const url = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooTicker)}&fields=${fields}${cs}`;
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      if (!q?.regularMarketPrice) continue;
      result.currentPrice = q.regularMarketPrice;
      result.currency = q.currency ?? result.currency;
      result.marketCap = q.marketCap; result.fiftyTwoWeekLow = q.fiftyTwoWeekLow; result.fiftyTwoWeekHigh = q.fiftyTwoWeekHigh;
      result.peRatio = q.trailingPE; result.forwardPE = q.forwardPE; result.pbRatio = q.priceToBook;
      result.pegRatio = q.pegRatio; result.evEbitda = q.enterpriseToEbitda;
      result.grossMargin = q.grossMargins; result.operatingMargin = q.operatingMargins; result.profitMargin = q.profitMargins;
      result.roe = q.returnOnEquity; result.roa = q.returnOnAssets;
      result.freeCashflow = q.freeCashflow; result.totalCash = q.totalCash; result.totalDebt = q.totalDebt;
      result.debtToEquity = q.debtToEquity; result.currentRatio = q.currentRatio;
      result.revenueGrowth = q.revenueGrowth; result.earningsGrowth = q.earningsGrowth;
      result.institutionOwnership = q.heldPercentInstitutions;
      result.targetMeanPrice = q.targetMeanPrice; result.recommendationKey = q.recommendationKey;
      result.numberOfAnalystOpinions = q.numberOfAnalystOpinions;
      break;
    } catch { continue; }
  }

  if (!result.currentPrice) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d${cs}`,
        { headers: makeHeaders(), signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json();
        const meta = j?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) { result.currentPrice = meta.regularMarketPrice; result.currency = meta.currency || result.currency; }
      }
    } catch {}
  }

  if (!result.currentPrice) throw new Error('Yahoo Finance verisi alınamadı');
  setCache(cacheKey, result);
  return result;
}

// ── HİBRİT VERİ ÇEKME ───────────────────────────────────────────
// FMP birincil, Yahoo yedek. FMP eksik bıraktığı alanları Yahoo tamamlar.
async function fetchFinancialData(ticker, exchange) {
  const fmpKey = process.env.FMP_API_KEY;
  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;

  let fmpData = null;
  if (fmpKey) {
    fmpData = await fetchFmpData(ticker, exchange);
  }

  let yahooData = null;
  try { yahooData = await fetchYahooData(yahooTicker); } catch(e) {
    console.log('Yahoo failed:', e.message);
  }

  if (!fmpData && !yahooData) return null;

  // FMP yoksa Yahoo'yu kullan
  if (!fmpData) return yahooData;
  // Yahoo yoksa FMP'yi kullan
  if (!yahooData) return fmpData;

  // İkisi de varsa: FMP'yi temel al, Yahoo'dan eksikleri tamamla
  // Özellikle fiyat ve büyüme verileri için Yahoo daha güncel olabilir
  return {
    ...fmpData,
    // Fiyat: Yahoo daha anlık
    currentPrice:    yahooData.currentPrice ?? fmpData.currentPrice,
    fiftyTwoWeekLow: yahooData.fiftyTwoWeekLow ?? fmpData.fiftyTwoWeekLow,
    fiftyTwoWeekHigh:yahooData.fiftyTwoWeekHigh ?? fmpData.fiftyTwoWeekHigh,
    // Büyüme: Yahoo'dan
    revenueGrowth:   yahooData.revenueGrowth ?? fmpData.revenueGrowth,
    earningsGrowth:  yahooData.earningsGrowth ?? fmpData.earningsGrowth,
    // Sahiplik & analist: Yahoo'dan
    institutionOwnership: yahooData.institutionOwnership ?? fmpData.institutionOwnership,
    recommendationKey:    yahooData.recommendationKey ?? fmpData.recommendationKey,
    targetMeanPrice:      yahooData.targetMeanPrice ?? fmpData.targetMeanPrice,
    numberOfAnalystOpinions: yahooData.numberOfAnalystOpinions,
    // Değerleme: FMP daha doğru (özellikle BIST P/B için)
    peRatio:    fmpData.peRatio    ?? yahooData.peRatio,
    pbRatio:    fmpData.pbRatio    ?? yahooData.pbRatio,
    pegRatio:   fmpData.pegRatio   ?? yahooData.pegRatio,
    evEbitda:   fmpData.evEbitda   ?? yahooData.evEbitda,
    roe:        fmpData.roe        ?? yahooData.roe,
    dataSource: 'FMP+Yahoo',
  };
}

// ── SIGNAL HELPERS ───────────────────────────────────────────────
function sigPE(v) { if(v==null)return'N/A'; if(v<12)return'ucuz'; if(v<22)return'adil'; return'pahalı'; }
function sigPB(v) { if(v==null)return'N/A'; if(v<1.5)return'ucuz'; if(v<3)return'adil'; return'pahalı'; }
function sigPEG(v) { if(v==null)return'N/A'; if(v<1)return'ucuz — Lynch fırsatı'; if(v<1.5)return'adil'; if(v<2)return'dikkatli ol'; return'pahalı — Lynch kaçınır'; }
function sigEV(v)  { if(v==null)return'N/A'; if(v<8)return'ucuz'; if(v<15)return'adil'; return'pahalı'; }

// ── ANA HANDLER ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, prompt, exchange } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  // Finansal veri çek (hibrit)
  let financialData = null;
  try { financialData = await fetchFinancialData(ticker, exchange || 'BIST'); }
  catch(e) { console.log('Data fetch failed:', e.message); }

  const fd = financialData;

  // ── System Prompt ──
  const systemPrompt = `Sen "Barış Investing" platformunun analiz motorusun. Warren Buffett, Peter Lynch ve Ray Dalio felsefesiyle profesyonel Türkçe analiz raporu yazıyorsun.

ÜSLUP: Profesyonel analist. Chatbot değil. Sade ama ikna edici. 12 yaşında anlayabilir, fon yöneticisi ikna olur.
FORMAT: Markdown yok. # yok. * yok. Düz metin. TOTAL_SCORE 0-7 arası tam sayı. 7 geçemez.
HER KRİTER: Minimum 2-3 cümle. Somut rakam. Sektör karşılaştırması.

BUFFETT KURALLARI:
- Fiyatlama Gücü = Brüt marj stabilitesi. F/K DEĞİL.
- Hissedar Kazancı = FCF proxy
- $1 Testi = Alıkonulan her $1 kâr → $1+ piyasa değeri?
- Değerleme = DCF bazlı. F/K yardımcı araç.
- Hendek = Marka/ağ etkisi/maliyet avantajı kanıtı.

LYNCH KURALLARI:
- Kategori belirle: Yavaş/Orta/Hızlı Büyüyen / Döngüsel / Varlık Zengini / Dönüşümdeki
- PEG < 1.0 = fırsat, > 2.0 = pahalı/FAIL
- Kurumsal sahiplik < %30 = "Gizli Mücevher"
- Stok büyümesi > satış %10+ = FAIL

DALIO KURALLARI:
- Borç döngüsü konumu, para politikası etkisi, döviz riski, enflasyon koruması, makro şok direnci.

TÜRK HİSSELERİ: Nominal büyüme TÜFE altındaysa "REEL KÜÇÜLME" uyarısı ekle.`;

  // ── Enriched Prompt ──
  let enrichedPrompt = '';
  if (fd) {
    const n  = (v, d=1) => v != null ? Number(v).toFixed(d) : 'N/A';
    const p  = v => v != null ? `%${(v*100).toFixed(1)}` : 'N/A';
    const big = v => {
      if (v == null) return 'N/A';
      const a = Math.abs(v);
      if (a >= 1e12) return `${(v/1e12).toFixed(2)}T`;
      if (a >= 1e9)  return `${(v/1e9).toFixed(2)}B`;
      if (a >= 1e6)  return `${(v/1e6).toFixed(2)}M`;
      return Number(v).toFixed(0);
    };
    const nc = (fd.totalCash != null && fd.totalDebt != null) ? fd.totalCash - fd.totalDebt : null;
    const upside = fd.currentPrice && fd.targetMeanPrice
      ? ((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice * 100).toFixed(1) : null;

    let warnings = '';
    if (fd.peRatio  != null && fd.peRatio  > 0 && fd.peRatio  < 3)  warnings += 'VERİ UYARISI: F/K anormal düşük — doğrula.\n';
    if (fd.pbRatio  != null && fd.pbRatio  > 0 && fd.pbRatio  < 0.2) warnings += 'VERİ UYARISI: F/DD anormal düşük — doğrula.\n';

    enrichedPrompt = `GERÇEK FİNANSAL VERİLER [Kaynak: ${fd.dataSource}] — BU RAKAMLARI KULLAN:
Fiyat: ${fd.currentPrice ? `${Number(fd.currentPrice).toFixed(2)} ${fd.currency}` : 'N/A'}
52H Aralık: ${n(fd.fiftyTwoWeekLow,2)} - ${n(fd.fiftyTwoWeekHigh,2)} ${fd.currency||''}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${n(fd.peRatio)} | F/K Forward: ${n(fd.forwardPE)} | F/DD: ${n(fd.pbRatio)}
PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)} | ROA: ${p(fd.roa)}${fd.roic != null ? ` | ROIC: ${p(fd.roic)}` : ''}
Brüt Marj: ${p(fd.grossMargin)} | Faaliyet Marjı: ${p(fd.operatingMargin)} | Net Marj: ${p(fd.profitMargin)}
FCF: ${big(fd.freeCashflow)}
Nakit: ${big(fd.totalCash)} | Borç: ${big(fd.totalDebt)} | Net Nakit: ${big(nc)}
Borç/Özsermaye: ${n(fd.debtToEquity)} | Cari Oran: ${n(fd.currentRatio)}
Gelir Büyümesi: ${p(fd.revenueGrowth)} | Kazanç Büyümesi: ${p(fd.earningsGrowth)}
Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${n(fd.targetMeanPrice,2)} | Potansiyel: ${upside?`%${upside}`:'N/A'}
${fd.sector ? `Sektör: ${fd.sector} | Endüstri: ${fd.industry||'—'}` : ''}
${warnings ? '\n' + warnings : ''}
MULTIPLES: PE=${n(fd.peRatio)} PB=${n(fd.pbRatio)} PEG=${n(fd.pegRatio)} EV_EBITDA=${n(fd.evEbitda)}
---
`;
  }

  enrichedPrompt += prompt;
  enrichedPrompt += '\n\nKRİTİK KURAL: Her PASS/FAIL/NEUTRAL pipe (|) ile açıklama içermeli. CRITERIA_START/CRITERIA_END olmalı. Her kriter 2-3 cümle somut analiz.';

  if (!fd) {
    enrichedPrompt += '\n\nVERİ NOTU: Finansal veri alınamadı. Sektör bilgine göre tahmin yap. "Veri sınırlı" uyarısını her kritere ekle ama analizi tamamla.';
  }

  // ── Claude API ──
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

    // FMP değerlerini AI çıktısına override et
    if (fd) {
      const n2 = (v,d=1) => v!=null ? Number(v).toFixed(d) : 'N/A';
      if (fd.peRatio  != null) result = result.replace(/PE:\s*[\d.]+\s*\|/, `PE: ${n2(fd.peRatio)} |`);
      if (fd.pbRatio  != null) result = result.replace(/PB:\s*[\d.]+\s*\|/, `PB: ${n2(fd.pbRatio)} |`);
      if (fd.pegRatio != null) result = result.replace(/PEG:\s*[\d.]+\s*\|/, `PEG: ${n2(fd.pegRatio)} |`);
      if (fd.evEbitda != null) result = result.replace(/EV_EBITDA:\s*[\d.]+\s*\|/, `EV_EBITDA: ${n2(fd.evEbitda)} |`);
    }

    console.log(`OK ${ticker} | src:${fd?.dataSource||'none'} | peers:${fd?.peers?.length||0} | len:${result.length}`);
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
