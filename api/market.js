export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://www.barisinvesting.com','https://barisinvesting.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  else if (process.env.NODE_ENV !== 'production') res.setHeader('Access-Control-Allow-Origin', '*');
  const { type, ticker } = req.query;
  if (type === 'market') return getMarketOverview(res);
  if (type === 'news') return getNews(res);
  if (type === 'search' && ticker) return searchTicker(ticker, res);
  return res.status(400).json({ error: 'Invalid' });
}

async function getMarketOverview(res) {
  const symbols = ['^GSPC', '^IXIC', 'XU100.IS', 'BTC-USD', 'ETH-USD', 'GC=F', 'CL=F'];
  const labels = ['sp500', 'nasdaq', 'bist100', 'btc', 'eth', 'gold', 'oil'];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
  };
  try {
    const results = await Promise.allSettled(
      symbols.map(s =>
        fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=2d`, { headers })
          .then(r => r.json())
      )
    );
    const data = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const chart = r.value?.chart?.result?.[0];
        if (chart) {
          const meta = chart.meta;
          const prev = meta.chartPreviousClose || meta.previousClose;
          const cur = meta.regularMarketPrice;
          data[labels[i]] = { price: cur, change: prev ? ((cur - prev) / prev * 100) : 0, currency: meta.currency };
        }
      }
    });
    return res.status(200).json({ market: data });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

// Multi-source RSS with finance keyword filtering
async function getNews(res) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
    'Accept-Language': 'tr-TR,tr;q=0.9',
  };

  const FEEDS = [
    { url: 'https://tr.investing.com/rss/news.rss', source: 'Investing.com TR' },
    { url: 'https://tr.investing.com/rss/news_14.rss', source: 'Investing.com Hisse' },
    { url: 'https://www.bloomberght.com/rss/haberler', source: 'Bloomberg HT' },
    { url: 'https://www.dunya.com/rss/dunya_ekonomi.xml', source: 'Dünya Ekonomi' },
    { url: 'https://www.bloomberght.com/rss/ekonomi', source: 'Bloomberg HT Ekonomi' },
    { url: 'https://www.haberler.com/finans/rss/', source: 'Haberler Finans' },
    { url: 'https://www.ekonomim.com/rss', source: 'Ekonomim' },
  ];

  // Finance/economy keywords filter — exclude irrelevant news
  const FINANCE_KW = ['borsa','hisse','faiz','dolar','euro','enflasyon','merkez bankası','fed','piyasa','bist','thyao','eregl','ekonomi','döviz','altın','petrol','kripto','bitcoin','finans','bütçe','ihracat','ithalat','büyüme','gdp','tcmb','erdoğan ekonomi','yatırım','fon','tahvil','hata yok'];
  const BLOCK_KW = ['sivilce','cilt','güzellik','moda','magazin','spor','maç','futbol','basketbol','siyaset','seçim','deprem','savaş','askerlik','şiddet','kaza','cinayet'];

  function isFinanceNews(title) {
    const t = title.toLowerCase();
    // Block explicit non-finance
    if (BLOCK_KW.some(k => t.includes(k))) return false;
    return true; // Bloomberg HT ve Dünya zaten finans odaklı
  }

  for (const feed of FEEDS) {
    try {
      const r = await fetch(feed.url, { headers, signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = parseRSS(xml, feed.source)
        .filter(n => isFinanceNews(n.title))
        .slice(0, 8);
      if (items.length >= 4) {
        return res.status(200).json({ news: items, source: feed.source });
      }
    } catch { continue; }
  }

  // Fallback: Yahoo Finance Turkish market news
  try {
    const r = await fetch(
      'https://query1.finance.yahoo.com/v1/finance/search?q=borsa+istanbul+hisse+ekonomi&newsCount=8&quotesCount=0&lang=tr',
      { headers }
    );
    const data = await r.json();
    const news = (data?.news || [])
      .filter(n => isFinanceNews(n.title || ''))
      .slice(0, 8)
      .map(n => ({ title: n.title, publisher: n.publisher, link: n.link, providerPublishTime: n.providerPublishTime }));
    return res.status(200).json({ news, source: 'Yahoo Finance' });
  } catch { return res.status(200).json({ news: [], source: '' }); }
}

function parseRSS(xml, source) {
  const items = [];
  const matches = xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi);
  for (const match of matches) {
    const c = match[1];
    const get = (tag) => {
      const m = c.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = get('title');
    const link = get('link') || c.match(/<link>(.*?)<\/link>/i)?.[1] || '';
    const pubDate = get('pubDate');
    const ts = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : Math.floor(Date.now() / 1000);
    if (title && title.length > 10) {
      items.push({ title, publisher: source, link, providerPublishTime: ts });
    }
    if (items.length >= 8) break;
  }
  return items;
}

async function searchTicker(query, res) {
  // Sanitize: max 20 karakter, sadece harf/rakam/boşluk
  query = String(query).replace(/[^a-zA-Z0-9\s]/g, '').slice(0, 20).trim();
  if (!query) return res.status(400).json({ results: [] });
  const BIST = {
    'THYAO':'Türk Hava Yolları','EREGL':'Ereğli Demir Çelik','SAHOL':'Sabancı Holding',
    'KCHOL':'Koç Holding','ASELS':'Aselsan','BIMAS':'BİM Mağazalar','TUPRS':'Tüpraş',
    'AKBNK':'Akbank','ISCTR':'İş Bankası','FROTO':'Ford Otosan','TOASO':'Tofaş Otomobil',
    'VAKBN':'Vakıfbank','PGSUS':'Pegasus','TAVHL':'TAV Havalimanları','SISE':'Şişecam',
    'TURSG':'Türkiye Sigorta','GARAN':'Garanti BBVA','YKBNK':'Yapı Kredi','HALKB':'Halkbank',
    'TCELL':'Turkcell','TTKOM':'Türk Telekom','ARCLK':'Arçelik','VESTL':'Vestel',
    'ENKAI':'Enka İnşaat','PETKM':'Petkim','KOZAL':'Koza Altın','KRDMD':'Kardemir',
    'SOKM':'Şok Marketler','MGROS':'Migros','ULKER':'Ülker','CCOLA':'Coca-Cola İçecek',
    'MAVI':'Mavi Giyim','LOGO':'Logo Yazılım','EKGYO':'Emlak Konut','ENJSA':'Enerjisa'
  };
  const q = query.toUpperCase();
  const bm = Object.entries(BIST).filter(([k,v]) => k.startsWith(q) || v.toUpperCase().includes(q))
    .slice(0,6).map(([t,n]) => ({ticker:t, name:n, exchange:'BIST'}));
  if (bm.length > 0) return res.status(200).json({ results: bm });
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const data = await r.json();
    const quotes = (data?.quotes || [])
      .filter(q => q.quoteType === 'EQUITY' && !q.symbol.includes('.'))
      .slice(0,5).map(q => ({ticker:q.symbol, name:q.longname||q.shortname||q.symbol, exchange:q.exchDisp||'US'}));
    return res.status(200).json({ results: quotes });
  } catch { return res.status(200).json({ results: [] }); }
}
