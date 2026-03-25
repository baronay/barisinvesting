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

  const systemPrompt = `Sen "Barış Investing" platformunun çekirdek analiz motorusun. Görevin Warren Buffett ve Peter Lynch disipliniyle derinlemesine hisse analizi yapmaktır.

KİŞİLİK VE ÜSLUP:
- Profesyonel analiz raporu formatında yaz. Chatbot gibi değil.
- Peter Lynch'in "sokak zekası" + Buffett'ın "sadeliği" — karmaşık jargon yok.
- 12 yaşında bir çocuğun anlayabileceği ama bir fon yöneticisini ikna edecek ciddiyette.
- Türkçe yaz. Markdown kullanma. # işareti kullanma. * işareti kullanma. Düz metin.

VERİ DOĞRULAMA KURALLARI:
1. Sana verilen F/K ve P/B rasyolarını doğrudan kabul etme. Net Income ve Market Cap mevcutsa kendin kontrol et.
2. Tutarsızlık sezersen (Net kar yüksek ama F/K çok düşükse) "VERİ UYARISI: [açıklama]" notu düş.
3. Türkiye hisseleri için: Nominal büyüme TÜFE'nin altındaysa "Reel olarak küçülen şirket" uyarısı ekle.
4. Veri eksikse hemen "Belirsiz" deme — sektörel trend ve haber akışından eğilim çıkar.

PETER LYNCH MODÜLÜ:
- Önce şirketi kategorize et: Yavaş Büyüyen / Orta Büyüyen / Hızlı Büyüyen / Döngüsel / Varlık Zengini / Dönüşümdeki
- Diworseification kontrolü: Ana iş kolundan uzaklaşma + marj daralması varsa sert eleştir
- Stok büyümesi satış büyümesini %10+ aşıyorsa "KALDI" puanı ver
- Kurumsal sahiplik %30 altındaysa "Gizli Mücevher" işareti ekle

WARREN BUFFETT MODÜLÜ:
- $1 Testi: Son 5 yılda alıkonulan her $1 kârın piyasa değerinde $1+ artış yaratıp yaratmadığını hesapla
- Hendek: Teknolojik liderliğini kaybetmiş şirketlerde "Hendek Çürümüş" uyarısı yap
- ROIC > WACC şartını kontrol et

FORMAT KURALLARI:
- TOTAL_SCORE: 0-7 arası TAM SAYI. 7'yi kesinlikle geçemez.
- VERDICT: sadece AL, BEKLE veya UZAK_DUR
- Her kriter açıklaması minimum 2-3 cümle. Somut rakam ve sektör karşılaştırması zorunlu.
- Verilen format dışında hiçbir şey yazma.`;

  const fd = financialData;
  let dataBlock = '';

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

    // Data validation check
    let dataWarning = '';
    if (fd.peRatio != null && fd.peRatio < 3 && fd.peRatio > 0) {
      dataWarning = '\nVERİ UYARISI: F/K oranı anormal derecede düşük — doğrulama gerekebilir.\n';
    }
    if (fd.pbRatio != null && fd.pbRatio < 0.2) {
      dataWarning += '\nVERİ UYARISI: F/DD oranı anormal düşük — varlık değerlemesi kontrol edilmeli.\n';
    }

    dataBlock = `GERÇEK FİNANSAL VERİLER (Yahoo Finance — BU DEĞERLERİ KULLAN):
Güncel Fiyat: ${fd.currentPrice ? `${fd.currentPrice.toFixed(2)} ${fd.currency}` : 'N/A'}
52H Düşük / Yüksek: ${n(fd.fiftyTwoWeekLow,2)} / ${n(fd.fiftyTwoWeekHigh,2)} ${fd.currency||''}
Piyasa Değeri: ${big(fd.marketCap)}
F/K (TTM): ${n(fd.peRatio)} | F/K (Forward): ${n(fd.forwardPE)}
F/DD (P/B): ${n(fd.pbRatio)} | PEG: ${n(fd.pegRatio)} | EV/FAVÖK: ${n(fd.evEbitda)}
ROE: ${p(fd.roe)} | Net Kâr Marjı: ${p(fd.profitMargin)} | Faaliyet Marjı: ${p(fd.operatingMargin)}
Serbest Nakit Akışı: ${big(fd.freeCashflow)} | Net Nakit: ${big(nc)}
Borç/Özsermaye: ${n(fd.debtToEquity)} | Cari Oran: ${n(fd.currentRatio)}
Gelir Büyümesi (YoY): ${p(fd.revenueGrowth)} | Kâr Büyümesi: ${p(fd.earningsGrowth)}
Kurumsal Sahiplik: ${p(fd.institutionOwnership)}
Analist Konsensüsü: ${fd.recommendationKey||'N/A'} | Hedef Fiyat: ${fd.targetMeanPrice?.toFixed(2)||'N/A'} ${fd.currency||''} | Yukarı Potansiyel: ${upside?`%${upside}`:'N/A'}
${dataWarning}
ÖNEMLİ: MULTIPLES bölümüne yukarıdaki GERÇEK değerleri yaz:
PE = ${n(fd.peRatio)} | PB = ${n(fd.pbRatio)} | PEG = ${n(fd.pegRatio)} | EV_EBITDA = ${n(fd.evEbitda)}
---`;
  }

  // Pre-fill multiples in prompt with real data
  let enrichedPrompt = dataBlock + '\n' + prompt;
  if (fd) {
    const n2 = (v,d=1) => v!=null ? v.toFixed(d) : 'N/A';
    enrichedPrompt = enrichedPrompt
      .replace('PE: [sayı] | [ucuz/adil/pahalı]', `PE: ${n2(fd.peRatio)} | ${sig_pe(fd.peRatio)}`)
      .replace('PB: [sayı] | [ucuz/adil/pahalı]', `PB: ${n2(fd.pbRatio)} | ${sig_pb(fd.pbRatio)}`)
      .replace('PEG: [sayı] | [ucuz/adil/pahalı]', `PEG: ${n2(fd.pegRatio)} | ${sig_peg(fd.pegRatio)}`)
      .replace('EV_EBITDA: [sayı] | [ucuz/adil/pahalı]', `EV_EBITDA: ${n2(fd.evEbitda)} | ${sig_ev(fd.evEbitda)}`);
  }

  enrichedPrompt += '\n\nÖNEMLİ: Her kriter için minimum 2-3 cümle yaz. Somut rakamlar ve sektör karşılaştırması zorunlu.';

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

    // Override multiples with real Yahoo data (prevent hallucination)
    if (fd) {
      const n3 = (v,d=1) => v!=null ? v.toFixed(d) : 'N/A';
      if (fd.peRatio != null) result = result.replace(/PE:\s*[\d.]+\s*\|/, `PE: ${n3(fd.peRatio)} |`);
      if (fd.pbRatio != null) result = result.replace(/PB:\s*[\d.]+\s*\|/, `PB: ${n3(fd.pbRatio)} |`);
      if (fd.pegRatio != null) result = result.replace(/PEG:\s*[\d.]+\s*\|/, `PEG: ${n3(fd.pegRatio)} |`);
      if (fd.evEbitda != null) result = result.replace(/EV_EBITDA:\s*[\d.]+\s*\|/, `EV_EBITDA: ${n3(fd.evEbitda)} |`);
    }

    console.log('OK length:', result.length);
    return res.status(200).json({ result, financialData });

  } catch(err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Signal helpers
function sig_pe(v) { if(v==null)return 'N/A'; if(v<12)return 'ucuz'; if(v<22)return 'adil'; return 'pahalı'; }
function sig_pb(v) { if(v==null)return 'N/A'; if(v<1.5)return 'ucuz'; if(v<3)return 'adil'; return 'pahalı'; }
function sig_peg(v) { if(v==null)return 'N/A'; if(v<1)return 'ucuz'; if(v<2)return 'adil'; return 'pahalı'; }
function sig_ev(v) { if(v==null)return 'N/A'; if(v<8)return 'ucuz'; if(v<15)return 'adil'; return 'pahalı'; }

async function fetchYahooData(yahooTicker) {
  const h = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  const modules = 'summaryDetail,defaultKeyStatistics,financialData,price';
  let raw = null;

  for (const base of ['query1', 'query2']) {
    try {
      const url = `https://${base}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=${modules}`;
      const r = await fetch(url, { headers: h });
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
    profitMargin: f(fd.profitMargins),
    operatingMargin: f(fd.operatingMargins),
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
