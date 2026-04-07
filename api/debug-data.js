// /api/debug-data.js — Barış Investing Teşhis Aracı
// Bu dosyayı api/ klasörüne koy, sonra:
// https://barisinvesting.com/api/debug-data?ticker=THYAO
// sonucu bana gönder

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ticker = req.query.ticker || 'THYAO';
  const yahooTicker = ticker.includes('.') ? ticker : `${ticker}.IS`;

  const results = {};

  // ── TEST 1: Yahoo v8 chart (crumb yok) ──
  try {
    const start = Date.now();
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=5d`,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
        signal: AbortSignal.timeout(8000) }
    );
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    results.yahoo_v8_chart = {
      status: r.status,
      ok: r.ok,
      ms: Date.now() - start,
      price: meta?.regularMarketPrice ?? null,
      marketCap: meta?.marketCap ?? null,
      currency: meta?.currency ?? null,
      error: j?.chart?.error ?? null,
    };
  } catch (e) {
    results.yahoo_v8_chart = { ok: false, error: e.message };
  }

  // ── TEST 2: Yahoo v8 chart query1 ──
  try {
    const start = Date.now();
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=5d`,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
        signal: AbortSignal.timeout(8000) }
    );
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    results.yahoo_v8_query1 = {
      status: r.status,
      ok: r.ok,
      ms: Date.now() - start,
      price: parsed?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null,
      snippet: text.slice(0, 200),
    };
  } catch (e) {
    results.yahoo_v8_query1 = { ok: false, error: e.message };
  }

  // ── TEST 3: Yahoo Crumb ──
  try {
    const start = Date.now();
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookieVal = setCookie.split(';')[0] || '';
    results.yahoo_crumb_fc = {
      status: r1.status,
      ok: r1.ok,
      ms: Date.now() - start,
      hasCookie: !!cookieVal,
      cookieSnippet: cookieVal.slice(0, 30),
    };
    if (cookieVal) {
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: { 'User-Agent': UA, 'Cookie': cookieVal, 'Accept': 'text/plain',
                   'Referer': 'https://finance.yahoo.com/' },
        signal: AbortSignal.timeout(5000),
      });
      const txt = await r2.text();
      results.yahoo_crumb_value = {
        status: r2.status,
        ok: r2.ok,
        crumb: txt.slice(0, 20),
        valid: txt.length > 0 && !txt.includes('{'),
      };
    }
  } catch (e) {
    results.yahoo_crumb_fc = { ok: false, error: e.message };
  }

  // ── TEST 4: Yahoo v7 quote (crumbsuz) ──
  try {
    const start = Date.now();
    const r = await fetch(
      `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${yahooTicker}&fields=regularMarketPrice,marketCap,trailingPE,priceToBook`,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
        signal: AbortSignal.timeout(8000) }
    );
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    results.yahoo_v7_no_crumb = {
      status: r.status,
      ok: r.ok,
      ms: Date.now() - start,
      price: parsed?.quoteResponse?.result?.[0]?.regularMarketPrice ?? null,
      snippet: text.slice(0, 200),
    };
  } catch (e) {
    results.yahoo_v7_no_crumb = { ok: false, error: e.message };
  }

  // ── TEST 5: TradingView Scanner ──
  try {
    const start = Date.now();
    const sym = `BIST:${ticker.replace('.IS','').toUpperCase()}`;
    const r = await fetch('https://scanner.tradingview.com/turkey/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        symbols: { tickers: [sym], query: { types: [] } },
        columns: ['close','price_earnings_ttm','price_book_ratio','market_cap_basic','return_on_equity'],
      }),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json();
    const row = j?.data?.[0]?.d;
    results.tradingview = {
      status: r.status,
      ok: r.ok,
      ms: Date.now() - start,
      rowCount: j?.data?.length ?? 0,
      price: row?.[0] ?? null,
      pe: row?.[1] ?? null,
      pb: row?.[2] ?? null,
      marketCap: row?.[3] ?? null,
      roe: row?.[4] ?? null,
    };
  } catch (e) {
    results.tradingview = { ok: false, error: e.message };
  }

  // ── TEST 6: BigPara ──
  try {
    const start = Date.now();
    const t = ticker.replace('.IS','').toLowerCase();
    const r = await fetch(`https://bigpara.hurriyet.com.tr/hisse/${t}/hisse-senedi/`, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'tr-TR,tr' },
      signal: AbortSignal.timeout(6000),
    });
    results.bigpara = {
      status: r.status,
      ok: r.ok,
      ms: Date.now() - start,
      hasContent: r.ok ? (await r.text()).length > 1000 : false,
    };
  } catch (e) {
    results.bigpara = { ok: false, error: e.message };
  }

  // ── TEST 7: ANTHROPIC_API_KEY ──
  results.env = {
    has_anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    key_prefix: process.env.ANTHROPIC_API_KEY?.slice(0, 7) ?? 'YOK',
    has_vercel_url: !!process.env.VERCEL_URL,
    vercel_url: process.env.VERCEL_URL ?? 'YOK',
    node_version: process.version,
    region: process.env.VERCEL_REGION ?? 'bilinmiyor',
  };

  // ── ÖZET ──
  results._summary = {
    ticker: yahooTicker,
    timestamp: new Date().toISOString(),
    working: Object.entries(results)
      .filter(([k, v]) => k !== '_summary' && k !== 'env' && v?.ok === true)
      .map(([k]) => k),
    failing: Object.entries(results)
      .filter(([k, v]) => k !== '_summary' && k !== 'env' && v?.ok === false)
      .map(([k, v]) => `${k}: ${v?.error || 'HTTP ' + v?.status}`),
  };

  return res.status(200).json(results);
}
