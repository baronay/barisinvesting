// /api/watchlist.js — Top 5 Dikkat Çeken Hisse (BIST + ABD)
// Scoring: momentum + relative strength + volume anomaly + analyst signal
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { market } = req.query;
  const isBIST = market === 'BIST';

  const US_UNIVERSE = [
    'NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','AMD','NOW','ETN',
    'AVGO','ORCL','CRM','PLTR','ANET','VST','GEV','CEG','AXON','TTD',
    'UBER','COIN','SNOW','DDOG','CRWD','ZS','MDB','NET','SMCI','ARM'
  ];

  const BIST_UNIVERSE = [
    'THYAO.IS','EREGL.IS','SAHOL.IS','KCHOL.IS','ASELS.IS','BIMAS.IS','TUPRS.IS',
    'AKBNK.IS','ISCTR.IS','GARAN.IS','YKBNK.IS','VAKBN.IS','TCELL.IS','FROTO.IS',
    'TOASO.IS','PGSUS.IS','TAVHL.IS','SISE.IS','TURSG.IS','TTKOM.IS','ARCLK.IS',
    'ENKAI.IS','PETKM.IS','KOZAL.IS','KRDMD.IS','SOKM.IS','MGROS.IS','LOGO.IS',
    'VAKFA.IS','EKGYO.IS'
  ];

  const universe = isBIST ? BIST_UNIVERSE : US_UNIVERSE;
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  // Fetch batch quotes from Yahoo Finance v7
  async function fetchBatch(tickers) {
    const syms = tickers.join(',');
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month,fiftyTwoWeekLow,fiftyTwoWeekHigh,fiftyDayAverage,twoHundredDayAverage,trailingPE,forwardPE,recommendationMean,targetMeanPrice,regularMarketDayHigh,regularMarketDayLow`,
        { headers, signal: AbortSignal.timeout(8000) }
      );
      if (!r.ok) throw new Error('v7 failed');
      const j = await r.json();
      return j?.quoteResponse?.result || [];
    } catch {
      // fallback: fetch individually (slower but more reliable)
      const results = await Promise.allSettled(
        tickers.slice(0, 15).map(sym =>
          fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, { headers })
            .then(r => r.json())
            .then(j => {
              const meta = j?.chart?.result?.[0]?.meta;
              if (!meta) return null;
              return {
                symbol: sym,
                regularMarketPrice: meta.regularMarketPrice,
                regularMarketChangePercent: meta.regularMarketPrice && meta.chartPreviousClose
                  ? ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose * 100)
                  : 0,
                regularMarketVolume: meta.regularMarketVolume,
                averageDailyVolume3Month: meta.regularMarketVolume, // fallback
                fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
                fiftyDayAverage: meta.fiftyDayAverage || meta.regularMarketPrice,
                twoHundredDayAverage: meta.twoHundredDayAverage || meta.regularMarketPrice,
              };
            })
        )
      );
      return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    }
  }

  function scoreStock(q) {
    if (!q || !q.regularMarketPrice) return null;
    const price = q.regularMarketPrice;
    const chg = q.regularMarketChangePercent || 0;
    const vol = q.regularMarketVolume || 0;
    const avgVol = q.averageDailyVolume3Month || vol;
    const low52 = q.fiftyTwoWeekLow || price;
    const high52 = q.fiftyTwoWeekHigh || price;
    const ma50 = q.fiftyDayAverage || price;
    const ma200 = q.twoHundredDayAverage || price;
    const target = q.targetMeanPrice;
    const recMean = q.recommendationMean; // 1=Strong Buy, 5=Sell

    // 1. Momentum score (0-30): day change
    let momentum = 0;
    if (chg > 5) momentum = 30;
    else if (chg > 3) momentum = 22;
    else if (chg > 1.5) momentum = 15;
    else if (chg > 0.5) momentum = 8;
    else if (chg < -4) momentum = 25; // oversold bounce signal
    else if (chg < -2) momentum = 12;

    // 2. Volume anomaly (0-25): volume vs 3M average
    let volScore = 0;
    if (avgVol > 0) {
      const volRatio = vol / avgVol;
      if (volRatio > 3) volScore = 25;
      else if (volRatio > 2) volScore = 18;
      else if (volRatio > 1.5) volScore = 12;
      else if (volRatio > 1.2) volScore = 6;
    }

    // 3. 52-week range position (0-20)
    let rangeScore = 0;
    const range = high52 - low52;
    if (range > 0) {
      const pos = (price - low52) / range; // 0=at low, 1=at high
      // Near 52w high = momentum; near 52w low = value signal — both interesting
      if (pos > 0.9) rangeScore = 20; // near ATH — momentum
      else if (pos < 0.15) rangeScore = 18; // near 52w low — oversold
      else if (pos > 0.75) rangeScore = 12;
      else if (pos < 0.3) rangeScore = 10;
    }

    // 4. MA alignment (0-15)
    let maScore = 0;
    const aboveMa50 = price > ma50;
    const aboveMa200 = price > ma200;
    const goldCross = ma50 > ma200; // bullish
    if (aboveMa50 && aboveMa200 && goldCross) maScore = 15;
    else if (aboveMa50 && aboveMa200) maScore = 10;
    else if (!aboveMa50 && !aboveMa200) maScore = 8; // deeply oversold = watch signal

    // 5. Analyst signal (0-10)
    let analystScore = 0;
    if (recMean) {
      if (recMean <= 1.5) analystScore = 10;
      else if (recMean <= 2.0) analystScore = 7;
      else if (recMean <= 2.5) analystScore = 4;
    }
    if (target && price) {
      const upside = (target - price) / price;
      if (upside > 0.3) analystScore = Math.max(analystScore, 8);
      else if (upside > 0.15) analystScore = Math.max(analystScore, 5);
    }

    const total = momentum + volScore + rangeScore + maScore + analystScore;

    // Build signal tags
    const tags = [];
    if (chg > 3) tags.push({ t: `+%${chg.toFixed(1)}`, c: 'bull' });
    else if (chg < -2) tags.push({ t: `%${chg.toFixed(1)}`, c: 'bear' });
    if (avgVol > 0 && (vol / avgVol) > 1.8) tags.push({ t: `${(vol / avgVol).toFixed(1)}x Hacim`, c: 'vol' });
    const pos52 = range > 0 ? (price - low52) / range : 0.5;
    if (pos52 > 0.9) tags.push({ t: '52H Zirvesi', c: 'ath' });
    else if (pos52 < 0.15) tags.push({ t: '52H Dibi', c: 'low' });
    if (aboveMa50 && goldCross) tags.push({ t: 'MA Hizalı', c: 'ma' });
    if (recMean && recMean <= 1.5) tags.push({ t: 'Güçlü AL', c: 'bull' });

    const rawSym = q.symbol?.replace('.IS', '') || q.symbol;
    const names = {
      THYAO:'Türk Hava Yolları',EREGL:'Ereğli Demir',SAHOL:'Sabancı Holding',
      KCHOL:'Koç Holding',ASELS:'Aselsan',BIMAS:'BİM Mağazalar',TUPRS:'Tüpraş',
      AKBNK:'Akbank',ISCTR:'İş Bankası',GARAN:'Garanti BBVA',YKBNK:'Yapı Kredi',
      VAKBN:'Vakıfbank',TCELL:'Turkcell',FROTO:'Ford Otosan',TOASO:'Tofaş',
      PGSUS:'Pegasus',TAVHL:'TAV Havalimanları',SISE:'Şişecam',TURSG:'T. Sigorta',
      TTKOM:'Türk Telekom',ARCLK:'Arçelik',ENKAI:'Enka İnşaat',PETKM:'Petkim',
      KOZAL:'Koza Altın',KRDMD:'Kardemir',SOKM:'Şok Market',MGROS:'Migros',
      LOGO:'Logo Yazılım',VAKFA:'Vakıf Faktoring',EKGYO:'Emlak Konut',
      NVDA:'NVIDIA',MSFT:'Microsoft',AAPL:'Apple',AMZN:'Amazon',GOOGL:'Alphabet',
      META:'Meta',TSLA:'Tesla',AMD:'AMD',NOW:'ServiceNow',ETN:'Eaton Corp',
      AVGO:'Broadcom',ORCL:'Oracle',CRM:'Salesforce',PLTR:'Palantir',
      ANET:'Arista Networks',VST:'Vistra',GEV:'GE Vernova',CEG:'Constellation',
      AXON:'Axon Enterprise',TTD:'The Trade Desk',UBER:'Uber',COIN:'Coinbase',
      SNOW:'Snowflake',DDOG:'Datadog',CRWD:'CrowdStrike',ZS:'Zscaler',
      MDB:'MongoDB',NET:'Cloudflare',SMCI:'Super Micro',ARM:'ARM Holdings'
    };

    return {
      ticker: rawSym,
      name: names[rawSym] || rawSym,
      price,
      chg,
      currency: isBIST ? 'TRY' : 'USD',
      score: total,
      tags: tags.slice(0, 3),
      pos52: Math.round(pos52 * 100),
      volRatio: avgVol > 0 ? parseFloat((vol / avgVol).toFixed(1)) : 1,
    };
  }

  try {
    const quotes = await fetchBatch(universe);
    const scored = quotes
      .map(q => scoreStock(q))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    return res.status(200).json({ stocks: scored, market: isBIST ? 'BIST' : 'US', ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
