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

  const isBuffett = prompt.includes('Warren Buffett') || prompt.includes('ROE:');
  const isLynch = prompt.includes('Peter Lynch') || prompt.includes('STORY:');

  const systemPrompt = `Sen "Barış Investing" platformunun analiz motorusun. Warren Buffett ve Peter Lynch felsefesiyle profesyonel Türkçe analiz raporu yazıyorsun.

ÜSLUP: Profesyonel analist. Chatbot değil. Sade ama ikna edici. 12 yaşında anlayabilir, fon yöneticisi ikna olur.
FORMAT: Markdown yok. # yok. * yok. Düz metin. TOTAL_SCORE 0-7 arası tam sayı. 7 geçemez.
HER KRİTER: Minimum 2-3 cümle. Somut rakam. Sektör karşılaştırması.

BUFFETT KURALLARI (Buffett analizi için):
- Fiyatlama Gücü = Brüt marj stabilitesi ve maliyet yansıtma kapasitesi. F/K DEĞİL.
- Hissedar Kazancı = Net gelir + Amortisman - CapEx - Ek işletme sermayesi (FCF proxy kabul et)
- $1 Testi = Alıkonulan her $1 kâr, $1+ piyasa değeri yarattı mı?
- Değerleme = DCF bazlı düşün. Nakit akışını bugüne indir. F/K yardımcı araç.
- Kar marjı trendi = 3 yıllık faaliyet marjı yönü. Daralıyorsa uyar.
- Hendek = Marka/ağ etkisi/maliyet avantajı kanıtı. "Hendek Çürümüş" uyarısı yap gerekirse.

LYNCH KURALLARI (Lynch analizi için):
- İlk önce kategori: Yavaş/Orta/Hızlı Büyüyen / Döngüsel / Varlık Zengini / Dönüşümdeki
- PEG < 1.0 = fırsat, 1.0-1.5 = adil, 1.5-2.0 = dikkatli ol, 2.0+ = pahalı/FAIL
- Kurumsal sahiplik < %30 = "Gizli Mücevher" işareti
- Stok büyümesi satışı %10+ aşıyorsa FAIL + "satılamayan ürün riski"
- Diworseification varsa sert eleştir

TÜRK HİSSELERİ: Nominal büyüme TÜFE altındaysa "REEL KÜÇÜLME" uyarısı ekle.`;

  // Build enriched prompt with real data
  let enrichedPrompt = '';
  const fd = financialData;

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

    // Approximate owner earnings: FCF is closest available proxy
    const ownerEarnings = fd.freeCashflow;

    // Data validation
    let warnings = '';
    if (fd.peRatio != null && fd.peRatio > 0 && fd.peRatio < 3) warnings += 'VERİ UYARISI: F/K oranı anormal düşük — doğrulama gerekebilir.\n';
    if (fd.pbRatio != null && fd.pbRatio > 0 && fd.pbRatio < 0.2) warnings += 'VERİ UYARISI: F/DD oranı anormal düşük — varlık değerlemesi şüpheli.\n';

    enrichedPrompt = `GERÇEK FİNANSAL VERİLER — BU RAKAMLARI KULLAN, DEĞİŞTİRME:
Fiyat: ${fd.currentPrice ? `${fd.currentPrice.toFixed(2)} ${fd.currency}` : 'N/A'}
52H Aralık: ${n(fd.fiftyTwoWeekLow,2)} - ${n(fd.fiftyTwoWeekHigh,2)} ${fd.currency||''}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${n(fd.peRatio)} | F/K Forward: ${n(fd.forwardPE)} | F/DD: ${n(fd.pbRatio)}
PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)} | ROA: ${p(fd.roa)}
Brüt Marj: ${p(fd.grossMargin)} | Faaliyet Marjı: ${p(fd.operatingMargin)} | Net Marj: ${p(fd.profitMargin)}
FCF (Hissedar Kazancı Proxy): ${big(ownerEarnings)}
Nakit: ${big(fd.totalCash)} | Borç: ${big(fd.totalDebt)} | Net Nakit: ${big(nc)}
Borç/Özsermaye: ${n(fd.debtToEquity)} | Cari Oran: ${n(fd.currentRatio)}
Gelir Büyümesi: ${p(fd.revenueGrowth)} | Kazanç Büyümesi: ${p(fd.earningsGrowth)}
Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
Analist: ${fd.recommendationKey||'N/A'} | Hedef: ${n(fd.targetMeanPrice,2)} ${fd.currency||''} | Potansiyel: ${upside?`%${upside}`:'N/A'}
${warnings ? '\n' + warnings : ''}
MULTIPLES bölümüne şu değerleri yaz — kendi tahmininle doldurma:
PE=${n(fd.peRatio)} PB=${n(fd.pbRatio)} PEG=${n(fd.pegRatio)} EV_EBITDA=${n(fd.evEbitda)}
---
`;
  }

  enrichedPrompt += prompt;
  enrichedPrompt += '\n\nKRİTİK KURAL: Aşağıdaki format ŞARTSIZ uygulanacak. Her PASS/FAIL/NEUTRAL satırı pipe (|) işaretiyle açıklama içermeli. CRITERIA_START ve CRITERIA_END etiketleri olmalı.\nHer kriter için 2-3 cümle somut analiz yaz.';

  // Pre-fill multiples in prompt text
  if (fd) {
    const n2 = (v,d=1) => v!=null?v.toFixed(d):'N/A';
    enrichedPrompt = enrichedPrompt
      .replace('PE: [sayı] | [ucuz/adil/pahalı]', `PE: ${n2(fd.peRatio)} | ${sigPE(fd.peRatio)}`)
      .replace('PB: [sayı] | [ucuz/adil/pahalı]', `PB: ${n2(fd.pbRatio)} | ${sigPB(fd.pbRatio)}`)
      .replace('PEG: [sayı] | [ucuz/adil/pahalı]', `PEG: ${n2(fd.pegRatio)} | ${sigPEG(fd.pegRatio)}`)
      .replace('EV_EBITDA: [sayı] | [ucuz/adil/pahalı]', `EV_EBITDA: ${n2(fd.evEbitda)} | ${sigEV(fd.evEbitda)}`);
  }

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

    // Clamp TOTAL_SCORE to 7
    result = result.replace(/TOTAL_SCORE:\s*(\d+)/i, (m, n) =>
      `TOTAL_SCORE: ${Math.min(7, Math.max(0, parseInt(n)))}`
    );

    // Override multiples with real Yahoo data
    if (fd) {
      const n3 = (v,d=1) => v!=null?v.toFixed(d):'N/A';
      if(fd.peRatio!=null) result=result.replace(/PE:\s*[\d.]+\s*\|/,`PE: ${n3(fd.peRatio)} |`);
      if(fd.pbRatio!=null) result=result.replace(/PB:\s*[\d.]+\s*\|/,`PB: ${n3(fd.pbRatio)} |`);
      if(fd.pegRatio!=null) result=result.replace(/PEG:\s*[\d.]+\s*\|/,`PEG: ${n3(fd.pegRatio)} |`);
      if(fd.evEbitda!=null) result=result.replace(/EV_EBITDA:\s*[\d.]+\s*\|/,`EV_EBITDA: ${n3(fd.evEbitda)} |`);
    }

    console.log('OK length:', result.length, '| CRITERIA found:', result.includes('CRITERIA_START'), '| First criteria:', result.match(/STORY:|GROWTH:|BALANCE:/i)?.[0]);
    return res.status(200).json({ result, financialData });

  } catch(err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Signal helpers — Lynch PEG fixed (1.5-2.0 = dikkatli, not uygun)
function sigPE(v) { if(v==null)return 'N/A'; if(v<12)return 'ucuz'; if(v<22)return 'adil'; return 'pahalı'; }
function sigPB(v) { if(v==null)return 'N/A'; if(v<1.5)return 'ucuz'; if(v<3)return 'adil'; return 'pahalı'; }
function sigPEG(v) {
  if(v==null) return 'N/A';
  if(v<1.0) return 'ucuz — Lynch fırsatı';
  if(v<1.5) return 'adil';
  if(v<2.0) return 'dikkatli ol';
  return 'pahalı — Lynch kaçınır';
}
function sigEV(v) { if(v==null)return 'N/A'; if(v<8)return 'ucuz'; if(v<15)return 'adil'; return 'pahalı'; }

async function fetchYahooData(yahooTicker) {
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,price';
  let raw = null;

  for (const base of ['query1', 'query2']) {
    try {
      const r = await fetch(
        `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}`,
        { headers: h }
      );
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.quoteSummary?.result?.[0]) { raw = j.quoteSummary.result[0]; break; }
    } catch { continue; }
  }
  if (!raw) throw new Error('No Yahoo data');

  const { summaryDetail:sd={}, defaultKeyStatistics:ks={}, financialData:fd={}, price:pr={} } = raw;
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
    grossMargin: f(fd.grossMargins),
    operatingMargin: f(fd.operatingMargins),
    profitMargin: f(fd.profitMargins),
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
    institutionOwnership: f(ks.heldPercentInstitutions),
    recommendationKey: fd.recommendationKey || null,
    targetMeanPrice: f(fd.targetMeanPrice),
    numberOfAnalystOpinions: f(fd.numberOfAnalystOpinions),
  };
}
