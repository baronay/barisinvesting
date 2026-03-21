export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ticker, prompt, exchange } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker gerekli' });
  }

  // Yahoo Finance ticker format
  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;

  // Fetch real financial data from Yahoo Finance
  let financialData = null;
  try {
    financialData = await fetchYahooData(yahooTicker);
  } catch (e) {
    console.log('Yahoo fetch failed:', e.message);
  }

  // Build enriched prompt with real data
  const enrichedPrompt = financialData
    ? injectFinancialData(prompt, financialData, ticker)
    : prompt;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1400,
        messages: [{ role: 'user', content: enrichedPrompt }]
      })
    });

    const data = await response.json();
    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.content?.[0]?.text || '';
    res.status(200).json({ result: text, financialData });

  } catch (err) {
    res.status(500).json({ error: 'API hatası: ' + err.message });
  }
}

async function fetchYahooData(yahooTicker) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  };

  // Fetch summary + key stats in parallel
  const [summaryRes, statsRes] = await Promise.allSettled([
    fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=summaryDetail,defaultKeyStatistics,financialData,price`, { headers }),
    fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${yahooTicker}?modules=summaryDetail,defaultKeyStatistics,financialData,price`, { headers }),
  ]);

  const summaryData = summaryRes.status === 'fulfilled' && summaryRes.value.ok
    ? await summaryRes.value.json()
    : statsRes.status === 'fulfilled' && statsRes.value.ok
      ? await statsRes.value.json()
      : null;

  if (!summaryData?.quoteSummary?.result?.[0]) {
    throw new Error('Yahoo data not available');
  }

  const result = summaryData.quoteSummary.result[0];
  const sd = result.summaryDetail || {};
  const ks = result.defaultKeyStatistics || {};
  const fd = result.financialData || {};
  const pr = result.price || {};

  const fmt = (v) => {
    if (!v || v.raw === undefined || v.raw === null) return null;
    return v.raw;
  };
  const fmtStr = (v) => v?.fmt || null;

  return {
    // Price
    currentPrice: fmt(pr.regularMarketPrice) || fmt(fd.currentPrice),
    currency: pr.currency || 'USD',
    marketCap: fmt(pr.marketCap),
    fiftyTwoWeekLow: fmt(sd.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: fmt(sd.fiftyTwoWeekHigh),

    // Valuation
    peRatio: fmt(sd.trailingPE) || fmt(ks.trailingPE),
    forwardPE: fmt(sd.forwardPE) || fmt(ks.forwardPE),
    pbRatio: fmt(ks.priceToBook),
    pegRatio: fmt(ks.pegRatio),
    evEbitda: fmt(ks.enterpriseToEbitda),
    priceToSales: fmt(ks.priceToSalesTrailing12Months),
    evToRevenue: fmt(ks.enterpriseToRevenue),

    // Profitability
    profitMargin: fmt(fd.profitMargins),
    operatingMargin: fmt(fd.operatingMargins),
    grossMargin: fmt(fd.grossMargins),
    roe: fmt(fd.returnOnEquity),
    roa: fmt(fd.returnOnAssets),

    // Cash flow
    freeCashflow: fmt(fd.freeCashflow),
    operatingCashflow: fmt(fd.operatingCashflow),

    // Balance
    totalCash: fmt(fd.totalCash),
    totalDebt: fmt(fd.totalDebt),
    debtToEquity: fmt(fd.debtToEquity),
    currentRatio: fmt(fd.currentRatio),
    quickRatio: fmt(fd.quickRatio),

    // Growth
    revenueGrowth: fmt(fd.revenueGrowth),
    earningsGrowth: fmt(fd.earningsGrowth),
    revenuePerShare: fmt(fd.revenuePerShare),

    // Dividend
    dividendYield: fmt(sd.dividendYield),
    payoutRatio: fmt(sd.payoutRatio),

    // Short/Institution
    shortRatio: fmt(ks.shortRatio),
    institutionOwnership: fmt(ks.heldPercentInstitutions),

    // Recommendations
    recommendationKey: fd.recommendationKey || null,
    numberOfAnalystOpinions: fmt(fd.numberOfAnalystOpinions),
    targetMeanPrice: fmt(fd.targetMeanPrice),
    targetHighPrice: fmt(fd.targetHighPrice),
    targetLowPrice: fmt(fd.targetLowPrice),
  };
}

function injectFinancialData(prompt, fd, ticker) {
  const pct = (v) => v !== null ? `%${(v * 100).toFixed(1)}` : 'N/A';
  const num = (v, dec = 2) => v !== null ? v.toFixed(dec) : 'N/A';
  const big = (v) => {
    if (v === null) return 'N/A';
    if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    return `$${v.toFixed(0)}`;
  };

  const netCash = fd.totalCash !== null && fd.totalDebt !== null
    ? fd.totalCash - fd.totalDebt : null;

  const upside = fd.currentPrice && fd.targetMeanPrice
    ? ((fd.targetMeanPrice - fd.currentPrice) / fd.currentPrice * 100).toFixed(1)
    : null;

  const dataBlock = `

=== GERÇEK FİNANSAL VERİLER (Yahoo Finance - Anlık) ===
Şirket: ${ticker}
Güncel Fiyat: ${fd.currentPrice ? `${fd.currentPrice} ${fd.currency}` : 'N/A'}
52H Düşük/Yüksek: ${fd.fiftyTwoWeekLow || 'N/A'} / ${fd.fiftyTwoWeekHigh || 'N/A'} ${fd.currency || ''}
Piyasa Değeri: ${big(fd.marketCap)}

DEĞERLEME ÇARPANLARI:
- F/K (P/E TTM): ${num(fd.peRatio)}
- F/K (Forward): ${num(fd.forwardPE)}
- F/DD (P/B): ${num(fd.pbRatio)}
- PEG Oranı: ${num(fd.pegRatio)}
- EV/FAVÖK: ${num(fd.evEbitda)}
- F/S (P/S): ${num(fd.priceToSales)}

KÂRLILİK:
- Net Kâr Marjı: ${pct(fd.profitMargin)}
- Faaliyet Marjı: ${pct(fd.operatingMargin)}
- Brüt Kâr Marjı: ${pct(fd.grossMargin)}
- Özsermaye Kârlılığı (ROE): ${pct(fd.roe)}
- Aktif Kârlılığı (ROA): ${pct(fd.roa)}

NAKİT AKIŞI:
- Serbest Nakit Akışı: ${big(fd.freeCashflow)}
- Operasyonel Nakit Akışı: ${big(fd.operatingCashflow)}

BİLANÇO:
- Toplam Nakit: ${big(fd.totalCash)}
- Toplam Borç: ${big(fd.totalDebt)}
- Net Nakit Pozisyonu: ${big(netCash)}
- Borç/Özsermaye: ${num(fd.debtToEquity)}
- Cari Oran: ${num(fd.currentRatio)}

BÜYÜME:
- Gelir Büyümesi (YoY): ${pct(fd.revenueGrowth)}
- Kazanç Büyümesi (YoY): ${pct(fd.earningsGrowth)}

SAHİPLİK:
- Kurumsal Sahiplik: ${pct(fd.institutionOwnership)}
- Temettü Verimi: ${pct(fd.dividendYield)}

ANALİST KONSENSÜSÜ:
- Öneri: ${fd.recommendationKey || 'N/A'}
- Analist Sayısı: ${fd.numberOfAnalystOpinions || 'N/A'}
- Hedef Fiyat (Ort): ${fd.targetMeanPrice ? `${fd.targetMeanPrice} ${fd.currency}` : 'N/A'}
- Hedef Fiyat (Yüksek): ${fd.targetHighPrice ? `${fd.targetHighPrice} ${fd.currency}` : 'N/A'}
- Yukarı Potansiyel: ${upside ? `%${upside}` : 'N/A'}
======================================================

Bu GERÇEK verileri kullanarak analiz yap. MULTIPLES bölümünde yukarıdaki gerçek değerleri kullan.
`;

  // Inject before the criteria section
  return prompt.replace('KRİTERLER:', dataBlock + '\nKRİTERLER:');
}
