export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticker, prompt, exchange } = req.body || {};
  if (!ticker) return res.status(400).json({ error: 'Ticker gerekli' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key eksik' });

  const yahooTicker = exchange === 'BIST' ? `${ticker}.IS` : ticker;
  let financialData = null;
  try { financialData = await fetchYahooData(yahooTicker); } catch(e) {
    console.log('Yahoo failed:', e.message);
  }

  const systemPrompt = `Sen deneyimli bir hisse senedi analistisin. Türkçe analiz yapıyorsun.
KURALLAR:
1. Yanıtını SADECE verilen formatta yaz. Markdown KULLANMA. # KULLANMA. * KULLANMA. Düz metin yaz.
2. Her kriter açıklaması MUTLAKA 2-3 cümle olmalı. Somut rakamlar, sektör karşılaştırması ve net gerekçe içermeli.
3. TOTAL_SCORE: sadece 0-7 arasında tam sayı. 7'yi geçemez.
4. VERDICT: sadece AL, BEKLE veya UZAK_DUR yaz.
5. SUMMARY: şirketin güçlü ve zayıf yönlerini içeren 3 cümle.
6. Formata HARFIYEN uy. Verilen format dışında hiçbir şey yazma.`;

  // Build prompt with real data injected directly into MULTIPLES section
  const fd = financialData;
  let enrichedPrompt = prompt;

  if (fd) {
    const n = (v, d=1) => v != null ? v.toFixed(d) : 'N/A';
    const p = v => v != null ? `%${(v*100).toFixed(1)}` : 'N/A';
    const big = v => {
      if(v==null) return 'N/A';
      const a=Math.abs(v);
      if(a>=1e12) return `${(v/1e12).toFixed(2)}T`;
      if(a>=1e9) return `${(v/1e9).toFixed(2)}B`;
      if(a>=1e6) return `${(v/1e6).toFixed(2)}M`;
      return v.toFixed(0);
    };
    const nc = (fd.totalCash!=null&&fd.totalDebt!=null) ? fd.totalCash-fd.totalDebt : null;
    const upside = fd.currentPrice&&fd.targetMeanPrice ? ((fd.targetMeanPrice-fd.currentPrice)/fd.currentPrice*100).toFixed(1) : null;

    // Inject real data block before prompt
    const dataBlock = `GERÇEK FİNANSAL VERİLER - BU DEĞERLERİ KULLAN, DEĞİŞTİRME:
Fiyat: ${fd.currentPrice ? `${fd.currentPrice.toFixed(2)} ${fd.currency}` : 'N/A'}
F/K (TTM): ${n(fd.peRatio)} | F/K (Forward): ${n(fd.forwardPE)}
F/DD: ${n(fd.pbRatio)} | PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)} | Net Kar Marjı: ${p(fd.profitMargin)}
FCF: ${big(fd.freeCashflow)} | Net Nakit: ${big(nc)} | Borç/Özsermaye: ${n(fd.debtToEquity)}
Gelir Büyümesi: ${p(fd.revenueGrowth)} | Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
52H Düşük/Yüksek: ${fd.fiftyTwoWeekLow?.toFixed(2)||'N/A'} / ${fd.fiftyTwoWeekHigh?.toFixed(2)||'N/A'}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${fd.targetMeanPrice?.toFixed(2)||'N/A'} ${fd.currency||''} | Potansiyel: ${upside?`%${upside}`:'N/A'}
---
ÖNEMLİ: MULTIPLES_START bölümüne yukarıdaki GERÇEK değerleri yaz. Kendi tahminin ile doldurma.
PE satırına F/K (TTM) = ${n(fd.peRatio)} yaz.
PB satırına F/DD = ${n(fd.pbRatio)} yaz.
PEG satırına PEG = ${n(fd.pegRatio)} yaz.
EV_EBITDA satırına EV/FAVÖK = ${n(fd.evEbitda)} yaz.
---
`;
    enrichedPrompt = dataBlock + '\n' + prompt;

    // Also pre-fill MULTIPLES in the prompt text so AI just copies them
    enrichedPrompt = enrichedPrompt
      .replace('PE: [sayı] | [ucuz/adil/pahalı]', `PE: ${n(fd.peRatio)} | ${getPESig(fd.peRatio)}`)
      .replace('PB: [sayı] | [ucuz/adil/pahalı]', `PB: ${n(fd.pbRatio)} | ${getPBSig(fd.pbRatio)}`)
      .replace('PEG: [sayı] | [ucuz/adil/pahalı]', `PEG: ${n(fd.pegRatio)} | ${getPEGSig(fd.pegRatio)}`)
      .replace('EV_EBITDA: [sayı] | [ucuz/adil/pahalı]', `EV_EBITDA: ${n(fd.evEbitda)} | ${getEVSig(fd.evEbitda)}`);
  }

  const detailNote = '\nÖNEMLİ: Her kriter için [açıklama] yerine 2-3 cümle somut analiz yaz. Tek cümle yetersizdir.\n';
  enrichedPrompt = enrichedPrompt + detailNote;

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
    if (data.error) {
      console.error('Anthropic error:', data.error.type, data.error.message);
      return res.status(500).json({ error: `${data.error.type}: ${data.error.message}` });
    }

    let result = data.content?.[0]?.text || '';
    // Clamp TOTAL_SCORE to max 7
    result = result.replace(/TOTAL_SCORE:\s*(\d+)/i, (m, n) => `TOTAL_SCORE: ${Math.min(7, Math.max(0, parseInt(n)))}`);

    // If real data available, override PE/PB/PEG/EV in result with actual values
    if (financialData) {
      const fd2 = financialData;
      const n2 = (v,d=1) => v!=null ? v.toFixed(d) : 'N/A';
      if (fd2.peRatio != null) result = result.replace(/PE:\s*[\d.]+\s*\|/, `PE: ${n2(fd2.peRatio)} |`);
      if (fd2.pbRatio != null) result = result.replace(/PB:\s*[\d.]+\s*\|/, `PB: ${n2(fd2.pbRatio)} |`);
      if (fd2.pegRatio != null) result = result.replace(/PEG:\s*[\d.]+\s*\|/, `PEG: ${n2(fd2.pegRatio)} |`);
      if (fd2.evEbitda != null) result = result.replace(/EV_EBITDA:\s*[\d.]+\s*\|/, `EV_EBITDA: ${n2(fd2.evEbitda)} |`);
    }

    console.log('OK, length:', result.length);
    return res.status(200).json({ result, financialData });

  } catch(err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Signal helpers
function getPESig(pe) { if(pe==null)return 'N/A'; if(pe<15)return 'ucuz'; if(pe<25)return 'adil'; return 'pahalı'; }
function getPBSig(pb) { if(pb==null)return 'N/A'; if(pb<1.5)return 'ucuz'; if(pb<3)return 'adil'; return 'pahalı'; }
function getPEGSig(peg) { if(peg==null)return 'N/A'; if(peg<1)return 'ucuz'; if(peg<2)return 'adil'; return 'pahalı'; }
function getEVSig(ev) { if(ev==null)return 'N/A'; if(ev<10)return 'ucuz'; if(ev<20)return 'adil'; return 'pahalı'; }

async function fetchYahooData(yahooTicker) {
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0' };
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,price';
  const urls = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}`,
  ];

  let raw = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: h });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.quoteSummary?.result?.[0]) { raw = j.quoteSummary.result[0]; break; }
    } catch { continue; }
  }
  if (!raw) throw new Error('No Yahoo data');

  const { summaryDetail: sd = {}, defaultKeyStatistics: ks = {}, financialData: fd = {}, price: pr = {} } = raw;
  const f = v => v?.raw ?? null;

  return {
    currentPrice: f(pr.regularMarketPrice) || f(fd.currentPrice),
    currency: pr.currency || 'USD',
    marketCap: f(pr.marketCap),
    fiftyTwoWeekLow: f(sd.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: f(sd.fiftyTwoWeekHigh),
    // P/E: summaryDetail is most reliable for TTM
    peRatio: f(sd.trailingPE) || f(ks.trailingPE),
    forwardPE: f(sd.forwardPE) || f(ks.forwardPE),
    pbRatio: f(ks.priceToBook),
    pegRatio: f(ks.pegRatio),
    evEbitda: f(ks.enterpriseToEbitda),
    profitMargin: f(fd.profitMargins),
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
    numberOfAnalystOpinions: f(fd.numberOfAnalystOpinions),
  };
}
