export default async function handler(req, res) {
  const { type, ticker, exchange, symbol } = req.query;

  if (type === 'market') return getMarketOverview(res);
  if (type === 'quote' && ticker) return getQuote(ticker, exchange || 'NASDAQ', res);
  if (type === 'search' && ticker) return searchTicker(ticker, res);
  if (type === 'news') return getNews(symbol || 'AAPL', res);

  return res.status(400).json({ error: 'Invalid request' });
}

async function getMarketOverview(res) {
  const symbols = ['^GSPC', '^IXIC', 'XU100.IS', 'BTC-USD', 'ETH-USD', 'GC=F', 'CL=F'];
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  try {
    const results = await Promise.allSettled(
      symbols.map(s => fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=2d`, { headers }).then(r => r.json()))
    );
    const data = {};
    const labels = ['sp500', 'nasdaq', 'bist100', 'btc', 'eth', 'gold', 'oil'];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const chart = r.value?.chart?.result?.[0];
        if (chart) {
          const meta = chart.meta;
          const prev = meta.chartPreviousClose || meta.previousClose;
          const cur = meta.regularMarketPrice;
          data[labels[i]] = {
            price: cur, change: prev ? ((cur - prev) / prev * 100) : 0,
            currency: meta.currency, symbol: symbols[i],
            high: meta.regularMarketDayHigh, low: meta.regularMarketDayLow,
            volume: meta.regularMarketVolume,
          };
        }
      }
    });
    return res.status(200).json({ market: data });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function getNews(symbol, res) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  try {
    // Yahoo Finance news for symbol
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=8&quotesCount=0`,
      { headers }
    );
    const data = await r.json();
    const news = (data?.news || []).slice(0, 8).map(n => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      providerPublishTime: n.providerPublishTime,
      thumbnail: n.thumbnail?.resolutions?.[0]?.url || null,
    }));
    return res.status(200).json({ news });
  } catch (e) { return res.status(200).json({ news: [] }); }
}

async function getQuote(ticker, exchange, res) {
  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=price,financialData`,
      { headers }
    );
    const data = await r.json();
    const result = data?.quoteSummary?.result?.[0];
    if (!result) return res.status(404).json({ error: 'Not found' });
    const pr = result.price || {};
    return res.status(200).json({
      name: pr.longName || pr.shortName || ticker,
      price: pr.regularMarketPrice?.raw,
      change: pr.regularMarketChangePercent?.raw,
      currency: pr.currency,
      marketCap: pr.marketCap?.raw,
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

async function searchTicker(query, res) {
  const BIST_COMPANIES = {
    'THYAO':'Türk Hava Yolları','EREGL':'Ereğli Demir Çelik','SAHOL':'Sabancı Holding',
    'KCHOL':'Koç Holding','ASELS':'Aselsan','BIMAS':'BİM Mağazalar','TUPRS':'Tüpraş',
    'AKBNK':'Akbank','ISCTR':'İş Bankası','FROTO':'Ford Otosan','TOASO':'Tofaş Otomobil',
    'VAKBN':'Vakıfbank','PGSUS':'Pegasus','TAVHL':'TAV Havalimanları','SISE':'Şişecam',
    'TURSG':'Türkiye Sigorta','GARAN':'Garanti BBVA','YKBNK':'Yapı Kredi',
    'HALKB':'Halkbank','TCELL':'Turkcell','TTKOM':'Türk Telekom','ARCLK':'Arçelik',
    'VESTL':'Vestel','ENKAI':'Enka İnşaat','PETKM':'Petkim','KOZAL':'Koza Altın',
    'KRDMD':'Kardemir','SOKM':'Şok Marketler','MGROS':'Migros','ULKER':'Ülker',
    'CCOLA':'Coca-Cola İçecek','ENJSA':'Enerjisa','EKGYO':'Emlak Konut',
  };
  const q = query.toUpperCase();
  const bistMatches = Object.entries(BIST_COMPANIES)
    .filter(([k, v]) => k.startsWith(q) || v.toUpperCase().includes(q))
    .slice(0, 5).map(([ticker, name]) => ({ ticker, name, exchange: 'BIST' }));
  if (bistMatches.length > 0) return res.status(200).json({ results: bistMatches });
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await r.json();
    const quotes = (data?.quotes || [])
      .filter(q => q.quoteType === 'EQUITY' && !q.symbol.includes('.'))
      .slice(0, 5).map(q => ({ ticker: q.symbol, name: q.longname || q.shortname || q.symbol, exchange: q.exchDisp || 'US' }));
    return res.status(200).json({ results: quotes });
  } catch (e) { return res.status(200).json({ results: [] }); }
}
