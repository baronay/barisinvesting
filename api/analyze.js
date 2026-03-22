export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, prompt, exchange } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  // Yahoo Finance
  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  let financialData = null;
  try { financialData = await fetchYahooData(yahooTicker); } catch(e) {
    console.log('Yahoo failed:', e.message);
  }

  // Build strict system prompt
  const systemPrompt = `Sen bir hisse senedi analiz asistanısın. 
KURAL: Yanıtını SADECE aşağıdaki formatta ver. Markdown kullanma. # işareti kullanma. * işareti kullanma. Sadece düz metin.
Verilen formata HARFIYEN uy. Başka hiçbir şey yazma.`;

  // Build user message with real data
  const fdBlock = financialData ? buildDataBlock(financialData) : '';
  const userMsg = fdBlock + '\n' + prompt;

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
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }]
      })
    });

    const data = await response.json();
    if (data.error) {
      console.error('Anthropic error:', data.error.type, data.error.message);
      return res.status(500).json({ error: `${data.error.type}: ${data.error.message}` });
    }

    const result = data.content?.[0]?.text || '';
    console.log('Success, length:', result.length, '| First 200:', result.substring(0, 200));
    return res.status(200).json({ result, financialData });

  } catch(err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function buildDataBlock(fd) {
  const p = v => v != null ? `%${(v*100).toFixed(1)}` : 'N/A';
  const n = (v,d=2) => v != null ? v.toFixed(d) : 'N/A';
  const b = v => {
    if(v==null) return 'N/A';
    const a=Math.abs(v);
    if(a>=1e12) return `${(v/1e12).toFixed(2)}T`;
    if(a>=1e9) return `${(v/1e9).toFixed(2)}B`;
    if(a>=1e6) return `${(v/1e6).toFixed(2)}M`;
    return v.toFixed(0);
  };
  const nc = (fd.totalCash!=null&&fd.totalDebt!=null) ? fd.totalCash-fd.totalDebt : null;
  const up = (fd.currentPrice&&fd.targetMeanPrice) ? ((fd.targetMeanPrice-fd.currentPrice)/fd.currentPrice*100).toFixed(1) : null;
  return `GERCEK FINANSAL VERI (Yahoo Finance):
Fiyat: ${fd.currentPrice||'N/A'} ${fd.currency||''}
52H Aralik: ${fd.fiftyTwoWeekLow||'N/A'} - ${fd.fiftyTwoWeekHigh||'N/A'}
Piyasa Degeri: ${b(fd.marketCap)}
F/K: ${n(fd.peRatio)} | F/DD: ${n(fd.pbRatio)} | PEG: ${n(fd.pegRatio)} | EV/FAOK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)} | Net Kar Marji: ${p(fd.profitMargin)}
FCF: ${b(fd.freeCashflow)} | Net Nakit: ${b(nc)} | Borc/Oz: ${n(fd.debtToEquity)}
Gelir Buyumesi: ${p(fd.revenueGrowth)} | Kurumsal: ${p(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${fd.targetMeanPrice||'N/A'} | Potansiyel: ${up?`%${up}`:'N/A'}
---`;
}

async function fetchYahooData(yahooTicker) {
  const h = { 'User-Agent': 'Mozilla/5.0' };
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=summaryDetail,defaultKeyStatistics,financialData,price`;
  const r = await fetch(url, { headers: h });
  if(!r.ok) throw new Error(`Yahoo ${r.status}`);
  const data = await r.json();
  if(!data?.quoteSummary?.result?.[0]) throw new Error('No data');
  const {summaryDetail:sd={},defaultKeyStatistics:ks={},financialData:fd={},price:pr={}} = data.quoteSummary.result[0];
  const f = v => v?.raw ?? null;
  return {
    currentPrice: f(pr.regularMarketPrice)||f(fd.currentPrice),
    currency: pr.currency||'USD',
    marketCap: f(pr.marketCap),
    fiftyTwoWeekLow: f(sd.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: f(sd.fiftyTwoWeekHigh),
    peRatio: f(sd.trailingPE)||f(ks.trailingPE),
    pbRatio: f(ks.priceToBook),
    pegRatio: f(ks.pegRatio),
    evEbitda: f(ks.enterpriseToEbitda),
    roe: f(fd.returnOnEquity),
    freeCashflow: f(fd.freeCashflow),
    totalCash: f(fd.totalCash),
    totalDebt: f(fd.totalDebt),
    debtToEquity: f(fd.debtToEquity),
    revenueGrowth: f(fd.revenueGrowth),
    institutionOwnership: f(ks.heldPercentInstitutions),
    recommendationKey: fd.recommendationKey||null,
    targetMeanPrice: f(fd.targetMeanPrice),
    profitMargin: f(fd.profitMargins),
    fiftyTwoWeekLow: f(sd.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: f(sd.fiftyTwoWeekHigh),
    forwardPE: f(sd.forwardPE)||f(ks.forwardPE),
    earningsGrowth: f(fd.earningsGrowth),
    returnOnAssets: f(fd.returnOnAssets),
    operatingMargins: f(fd.operatingMargins),
    numberOfAnalystOpinions: f(fd.numberOfAnalystOpinions),
  };
}
