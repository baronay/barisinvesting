export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, prompt, exchange } = req.body;
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });

  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  let financialData = null;
  try { financialData = await fetchYahooData(yahooTicker); } catch (e) {}

  const enrichedPrompt = financialData ? injectFinancialData(prompt, financialData, ticker) : prompt;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2000, messages: [{ role: 'user', content: enrichedPrompt }] })
    });
    const data = await response.json();
    if (data.error) { console.error('Anthropic error:', JSON.stringify(data.error)); return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) }); }
    const result = data.content?.[0]?.text || ''; console.log('Result length:', result.length, 'First 100:', result.substring(0,100)); res.status(200).json({ result, financialData });
  } catch (err) {
    res.status(500).json({ error: 'API hatası: ' + err.message });
  }
}

async function fetchYahooData(yahooTicker) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  const [r1, r2] = await Promise.allSettled([
    fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=summaryDetail,defaultKeyStatistics,financialData,price`, { headers }),
    fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=summaryDetail,defaultKeyStatistics,financialData,price`, { headers }),
  ]);
  const resp = r1.status === 'fulfilled' && r1.value.ok ? await r1.value.json() : r2.status === 'fulfilled' && r2.value.ok ? await r2.value.json() : null;
  if (!resp?.quoteSummary?.result?.[0]) throw new Error('No data');
  const { summaryDetail: sd = {}, defaultKeyStatistics: ks = {}, financialData: fd = {}, price: pr = {} } = resp.quoteSummary.result[0];
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
    profitMargin: f(fd.profitMargins),
    operatingMargin: f(fd.operatingMargins),
    grossMargin: f(fd.grossMargins),
    roe: f(fd.returnOnEquity),
    roa: f(fd.returnOnAssets),
    freeCashflow: f(fd.freeCashflow),
    operatingCashflow: f(fd.operatingCashflow),
    totalCash: f(fd.totalCash),
    totalDebt: f(fd.totalDebt),
    debtToEquity: f(fd.debtToEquity),
    currentRatio: f(fd.currentRatio),
    revenueGrowth: f(fd.revenueGrowth),
    earningsGrowth: f(fd.earningsGrowth),
    dividendYield: f(sd.dividendYield),
    institutionOwnership: f(ks.heldPercentInstitutions),
    recommendationKey: fd.recommendationKey || null,
    numberOfAnalystOpinions: f(fd.numberOfAnalystOpinions),
    targetMeanPrice: f(fd.targetMeanPrice),
    targetHighPrice: f(fd.targetHighPrice),
    shortRatio: f(ks.shortRatio),
  };
}

function injectFinancialData(prompt, fd, ticker) {
  const pct = v => v !== null ? `%${(v * 100).toFixed(1)}` : 'N/A';
  const num = (v, d = 2) => v !== null ? v.toFixed(d) : 'N/A';
  const big = v => {
    if (v === null) return 'N/A';
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v/1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
    return `$${v.toFixed(0)}`;
  };
  const netCash = fd.totalCash !== null && fd.totalDebt !== null ? fd.totalCash - fd.totalDebt : null;
  const upside = fd.currentPrice && fd.targetMeanPrice ? ((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice * 100).toFixed(1) : null;

  const block = `
=== GERÇEK FİNANSAL VERİLER (Yahoo Finance - Anlık) ===
Güncel Fiyat: ${fd.currentPrice ? `${fd.currentPrice} ${fd.currency}` : 'N/A'}
52H Düşük/Yüksek: ${fd.fiftyTwoWeekLow || 'N/A'} / ${fd.fiftyTwoWeekHigh || 'N/A'}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${num(fd.peRatio)} | F/K (Forward): ${num(fd.forwardPE)}
F/DD: ${num(fd.pbRatio)} | PEG: ${num(fd.pegRatio)} | EV/FAVÖK: ${num(fd.evEbitda)}
Net Kâr Marjı: ${pct(fd.profitMargin)} | ROE: ${pct(fd.roe)} | ROA: ${pct(fd.roa)}
FCF: ${big(fd.freeCashflow)} | Nakit: ${big(fd.totalCash)} | Borç: ${big(fd.totalDebt)}
Net Nakit: ${big(netCash)} | Borç/Özsermaye: ${num(fd.debtToEquity)}
Gelir Büyümesi: ${pct(fd.revenueGrowth)} | Kazanç Büyümesi: ${pct(fd.earningsGrowth)}
Kurumsal Sahiplik: ${pct(fd.institutionOwnership)}
Analist Öneri: ${fd.recommendationKey || 'N/A'} | Hedef: ${fd.targetMeanPrice ? `${fd.targetMeanPrice} ${fd.currency}` : 'N/A'} | Potansiyel: ${upside ? `%${upside}` : 'N/A'}
======================================================
Bu GERÇEK verileri kullanarak analiz yap. MULTIPLES bölümünde bu değerleri kullan.
`;
  return prompt.replace('KRİTERLER:', block + '\nKRİTERLER:');
}
