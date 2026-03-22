export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, prompt, exchange } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik - Vercel env variable yok' });

  // Fetch Yahoo Finance data
  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  let financialData = null;
  try { financialData = await fetchYahooData(yahooTicker); } catch (e) {
    console.log('Yahoo fetch failed:', e.message);
  }

  const enrichedPrompt = financialData ? injectFinancialData(prompt, financialData, ticker) : prompt;

  // Call Anthropic
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
        max_tokens: 2000,
        messages: [{ role: 'user', content: enrichedPrompt }]
      })
    });

    const data = await response.json();

    // Anthropic error
    if (data.error) {
      console.error('Anthropic API error:', JSON.stringify(data.error));
      return res.status(500).json({ error: `Anthropic hatası: ${data.error.message || data.error.type}` });
    }

    const result = data.content?.[0]?.text || '';
    console.log('Success, result length:', result.length);
    return res.status(200).json({ result, financialData });

  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).json({ error: 'API bağlantı hatası: ' + err.message });
  }
}

async function fetchYahooData(yahooTicker) {
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=summaryDetail,defaultKeyStatistics,financialData,price`;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const data = await r.json();
  if (!data?.quoteSummary?.result?.[0]) throw new Error('No Yahoo data');
  const { summaryDetail: sd = {}, defaultKeyStatistics: ks = {}, financialData: fd = {}, price: pr = {} } = data.quoteSummary.result[0];
  const f = v => v?.raw ?? null;
  return {
    currentPrice: f(pr.regularMarketPrice) || f(fd.currentPrice),
    currency: pr.currency || 'USD',
    marketCap: f(pr.marketCap),
    fiftyTwoWeekLow: f(sd.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: f(sd.fiftyTwoWeekHigh),
    peRatio: f(sd.trailingPE) || f(ks.trailingPE),
    forwardPE: f(sd.forwardPE) || f(ks.forwardPE),
    pbRatio: f(ks.priceToBook),
    pegRatio: f(ks.pegRatio),
    evEbitda: f(ks.enterpriseToEbitda),
    roe: f(fd.returnOnEquity),
    freeCashflow: f(fd.freeCashflow),
    totalCash: f(fd.totalCash),
    totalDebt: f(fd.totalDebt),
    debtToEquity: f(fd.debtToEquity),
    revenueGrowth: f(fd.revenueGrowth),
    earningsGrowth: f(fd.earningsGrowth),
    institutionOwnership: f(ks.heldPercentInstitutions),
    recommendationKey: fd.recommendationKey || null,
    targetMeanPrice: f(fd.targetMeanPrice),
    profitMargin: f(fd.profitMargins),
  };
}

function injectFinancialData(prompt, fd, ticker) {
  const pct = v => v !== null ? `%${(v * 100).toFixed(1)}` : 'N/A';
  const n = (v, d = 2) => v !== null ? v.toFixed(d) : 'N/A';
  const big = v => {
    if (v === null) return 'N/A';
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
    return `$${v.toFixed(0)}`;
  };
  const nc = fd.totalCash !== null && fd.totalDebt !== null ? fd.totalCash - fd.totalDebt : null;
  const upside = fd.currentPrice && fd.targetMeanPrice ? ((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice * 100).toFixed(1) : null;
  const block = `\n=== GERÇEK VERİ (Yahoo Finance) ===
Fiyat: ${fd.currentPrice ? `${fd.currentPrice} ${fd.currency}` : 'N/A'}
52H: ${fd.fiftyTwoWeekLow||'N/A'} / ${fd.fiftyTwoWeekHigh||'N/A'}
Piyasa Değeri: ${big(fd.marketCap)}
F/K: ${n(fd.peRatio)} | F/DD: ${n(fd.pbRatio)} | PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${pct(fd.roe)} | Net Kâr Marjı: ${pct(fd.profitMargin)}
FCF: ${big(fd.freeCashflow)} | Net Nakit: ${big(nc)} | Borç/Özsermaye: ${n(fd.debtToEquity)}
Gelir Büyümesi: ${pct(fd.revenueGrowth)} | Kurumsal Sahiplik: ${pct(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${fd.targetMeanPrice||'N/A'} | Potansiyel: ${upside?`%${upside}`:'N/A'}
===================================\n`;
  return prompt.replace('KRİTERLER:', block + '\nKRİTERLER:');
}
