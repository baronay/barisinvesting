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

DALIO KURALLARI (Dalio analizi için):
- Borç döngüsü: Kaldıraç artıyor mu, azalıyor mu? Konumu belirle.
- Para politikası: Mevcut faiz ortamının şirkete etkisi — pozitif/negatif?
- Döviz riski: Dolar borcu varsa kur baskısını değerlendir.
- Enflasyon koruması: Reel varlık veya emtia bağlantısı var mı?
- Makro şok direnci: En kötü makro senaryoda (stagflasyon, kriz) hayatta kalır mı?

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

  // Veri yoksa (küçük BIST hisseleri gibi) AI tahmini yapsın
  if (!fd) {
    enrichedPrompt += '\n\nVERİ NOTU: Yahoo Finance bu hisse için yapısal finansal veri döndürmedi. Sektör bilgine ve genel şirket profiline dayanarak en iyi tahmini yap. Tüm MULTIPLES değerlerini sektör ortalamasına göre tahmin et. Her kriterde "Veri sınırlı" uyarısını ekle ama analizi tamamla — boş bırakma.';
  }

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

// Yahoo Finance crumb cache
let _crumb = null;
let _cookie = null;

async function getYahooCrumb() {
  if (_crumb && _cookie) return { crumb: _crumb, cookie: _cookie };
  try {
    // Step 1: Get cookie
    const r1 = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      redirect: 'follow',
    });
    const cookies = r1.headers.get('set-cookie') || '';
    const cookieVal = cookies.split(';')[0] || 'A=o; B=abc';

    // Step 2: Get crumb
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Cookie': cookieVal,
        'Accept': 'text/plain',
        'Referer': 'https://finance.yahoo.com/',
      }
    });
    if (r2.ok) {
      _crumb = await r2.text();
      _cookie = cookieVal;
      return { crumb: _crumb, cookie: _cookie };
    }
  } catch {}
  return { crumb: null, cookie: null };
}

async function fetchYahooData(yahooTicker) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  let result = {
    currentPrice: null, currency: yahooTicker.endsWith('.IS') ? 'TRY' : 'USD',
    marketCap: null, fiftyTwoWeekLow: null, fiftyTwoWeekHigh: null,
    peRatio: null, forwardPE: null, pbRatio: null, pegRatio: null, evEbitda: null,
    grossMargin: null, operatingMargin: null, profitMargin: null,
    roe: null, roa: null, freeCashflow: null, operatingCashflow: null,
    totalCash: null, totalDebt: null, debtToEquity: null, currentRatio: null,
    revenueGrowth: null, earningsGrowth: null, institutionOwnership: null,
    recommendationKey: null, targetMeanPrice: null, numberOfAnalystOpinions: null,
  };

  // Get crumb for authenticated requests
  const { crumb, cookie } = await getYahooCrumb();

  const makeHeaders = (withCookie = true) => ({
    'User-Agent': UA,
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    ...(withCookie && cookie ? { 'Cookie': cookie } : {}),
  });

  const crumbSuffix = crumb ? `&crumb=${encodeURIComponent(crumb)}` : '';

  // 1. v7 quote — fiyat + temel metrikler (crumb ile)
  for (const base of ['query2', 'query1']) {
    try {
      const fields = 'regularMarketPrice,currency,marketCap,fiftyTwoWeekLow,fiftyTwoWeekHigh,trailingPE,forwardPE,priceToBook,pegRatio,epsTrailingTwelveMonths,epsForward,targetMeanPrice,recommendationKey,numberOfAnalystOpinions,enterpriseToEbitda,profitMargins,grossMargins,operatingMargins,returnOnEquity,returnOnAssets,freeCashflow,operatingCashflow,totalCash,totalDebt,debtToEquity,currentRatio,revenueGrowth,earningsGrowth,heldPercentInstitutions,regularMarketVolume';
      const url = `https://${base}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(yahooTicker)}&fields=${fields}${crumbSuffix}`;
      const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(7000) });
      if (!r.ok) continue;
      const j = await r.json();
      const q = j?.quoteResponse?.result?.[0];
      if (!q || !q.regularMarketPrice) continue;

      result.currentPrice = q.regularMarketPrice ?? null;
      result.currency = q.currency ?? result.currency;
      result.marketCap = q.marketCap ?? null;
      result.fiftyTwoWeekLow = q.fiftyTwoWeekLow ?? null;
      result.fiftyTwoWeekHigh = q.fiftyTwoWeekHigh ?? null;
      result.peRatio = q.trailingPE ?? null;
      result.forwardPE = q.forwardPE ?? null;
      result.pbRatio = q.priceToBook ?? null;
      result.pegRatio = q.pegRatio ?? null;
      result.evEbitda = q.enterpriseToEbitda ?? null;
      result.grossMargin = q.grossMargins ?? null;
      result.operatingMargin = q.operatingMargins ?? null;
      result.profitMargin = q.profitMargins ?? null;
      result.roe = q.returnOnEquity ?? null;
      result.roa = q.returnOnAssets ?? null;
      result.freeCashflow = q.freeCashflow ?? null;
      result.operatingCashflow = q.operatingCashflow ?? null;
      result.totalCash = q.totalCash ?? null;
      result.totalDebt = q.totalDebt ?? null;
      result.debtToEquity = q.debtToEquity ?? null;
      result.currentRatio = q.currentRatio ?? null;
      result.revenueGrowth = q.revenueGrowth ?? null;
      result.earningsGrowth = q.earningsGrowth ?? null;
      result.institutionOwnership = q.heldPercentInstitutions ?? null;
      result.targetMeanPrice = q.targetMeanPrice ?? null;
      result.recommendationKey = q.recommendationKey ?? null;
      result.numberOfAnalystOpinions = q.numberOfAnalystOpinions ?? null;
      break;
    } catch { continue; }
  }

  // 2. v10 quoteSummary — eksik finansalları tamamla (özellikle BIST)
  if (!result.roe || !result.grossMargin) {
    const modules = 'defaultKeyStatistics,financialData,summaryDetail';
    for (const base of ['query2', 'query1']) {
      try {
        const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}&corsDomain=finance.yahoo.com${crumbSuffix}`;
        const r = await fetch(url, { headers: makeHeaders(), signal: AbortSignal.timeout(7000) });
        if (!r.ok) continue;
        const j = await r.json();
        const raw = j?.quoteSummary?.result?.[0];
        if (!raw) continue;
        const { summaryDetail:sd={}, defaultKeyStatistics:ks={}, financialData:fd={} } = raw;
        const f = v => v?.raw ?? null;

        if (!result.peRatio) result.peRatio = f(sd.trailingPE) || f(ks.trailingPE);
        if (!result.forwardPE) result.forwardPE = f(sd.forwardPE) || f(ks.forwardPE);
        if (!result.pbRatio) result.pbRatio = f(ks.priceToBook);
        if (!result.pegRatio) result.pegRatio = f(ks.pegRatio);
        if (!result.evEbitda) result.evEbitda = f(ks.enterpriseToEbitda);
        if (!result.grossMargin) result.grossMargin = f(fd.grossMargins);
        if (!result.operatingMargin) result.operatingMargin = f(fd.operatingMargins);
        if (!result.profitMargin) result.profitMargin = f(fd.profitMargins);
        if (!result.roe) result.roe = f(fd.returnOnEquity);
        if (!result.roa) result.roa = f(fd.returnOnAssets);
        if (!result.freeCashflow) result.freeCashflow = f(fd.freeCashflow);
        if (!result.totalCash) result.totalCash = f(fd.totalCash);
        if (!result.totalDebt) result.totalDebt = f(fd.totalDebt);
        if (!result.debtToEquity) result.debtToEquity = f(fd.debtToEquity);
        if (!result.revenueGrowth) result.revenueGrowth = f(fd.revenueGrowth);
        if (!result.earningsGrowth) result.earningsGrowth = f(fd.earningsGrowth);
        if (!result.institutionOwnership) result.institutionOwnership = f(ks.heldPercentInstitutions);
        break;
      } catch { continue; }
    }
  }

  // 3. v8 chart — son çare fiyat
  if (!result.currentPrice) {
    try {
      const r = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?interval=1d&range=5d${crumbSuffix}`,
        { headers: makeHeaders(), signal: AbortSignal.timeout(5000) }
      );
      if (r.ok) {
        const j = await r.json();
        const meta = j?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          result.currentPrice = meta.regularMarketPrice;
          result.currency = meta.currency || result.currency;
          if (!result.fiftyTwoWeekLow) result.fiftyTwoWeekLow = meta.fiftyTwoWeekLow || null;
          if (!result.fiftyTwoWeekHigh) result.fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || null;
        }
      }
    } catch {}
  }

  if (!result.currentPrice) throw new Error('Yahoo Finance verisi alınamadı');
  return result;
}
