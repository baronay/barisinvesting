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

  const systemPrompt = `Sen "Barış Investing" platformunun çekirdek analiz motorusun. Warren Buffett ve Peter Lynch disipliniyle profesyonel analiz raporu üretiyorsun.

ÜSLUP VE FORMAT:
- Profesyonel yatırım analizi raporu. Chatbot değil, analist sesi.
- Sade ve net: 12 yaşında anlayabilir, fon yöneticisi ikna olur.
- Türkçe yaz. Markdown kullanma. # işareti kullanma. * kullanma. Düz metin.
- Her kriter: minimum 2-3 cümle, somut rakam, sektör karşılaştırması zorunlu.

${isBuffett ? `
WARREN BUFFETT ÇERÇEVE KURALLARI — BUNLARA HARFIYEN UY:

1. ROE KALİTESİ: ROE'yi yüzde olarak ifade et. Son 3-5 yıl tutarlılığına bak. Sadece "yüksek" deme — sektör ortalamasıyla karşılaştır. Finansal kaldıraçla şişirilmiş ROE'yi ayırt et.

2. FİYATLAMA GÜCÜ — F/K ile karıştırma: Bu kriter şunu ölçer: Şirket maliyet artışlarını (hammadde, işçilik, enerji) fiyatlarına yansıtabiliyor mu? Brüt marj trendi son 3 yılda artıyor mu, koruyor mu, yoksa eriyor mu? Coca-Cola, fiyatını artırdığında satış hacmi neredeyse değişmez — bu fiyatlama gücüdür. F/K burada göstergedir ama asıl kanıt brüt marj stabilitesidir.

3. HİSSEDAR KAZANCI (OWNER EARNINGS) — Buffett'ın Gerçek Nakit Akışı: Net gelir + Amortisman ve yıpranma (D&A) — Sermaye harcamaları (CapEx) — İhtiyaç duyulan ek işletme sermayesi. Bu formül varsa hesapla. FCF verisi kullanılabiliyorsa, "Hissedar kazancına yakın değer: X" şeklinde belirt.

4. DAĞITILMAMIŞ KAR $1 TESTİ: Son 5 yılda şirketin dağıtmayıp bünyesinde tuttuğu toplam karı hesapla. Bu karın aynı dönemde piyasa değerinde yarattığı artışla karşılaştır. Her 1 dolarlık alıkonulan kar, 1 dolar+ piyasa değeri yaratıyor mu? Bu Buffett'ın en özgün testidir.

5. EKONOMİK HENDEK (MOAT): Marka gücü, ağ etkisi, maliyet avantajı veya yasal koruma — hangisi var? Soyut konuşma, somut kanıt göster. "Teknolojik liderliğini kaybetmiş" şirketlerde "HENDEK ÇÜRÜMÜŞ" uyarısı yap.

6. KAR MARJLARI VE YÖNETİM KALİTESİ: Buffett, maliyetleri artıran yöneticilerden nefret eder. "Maliyetleri düşüreceğim" diyen yönetici değil, hiç söylemesine gerek duymayan yönetici iyidir. Faaliyet marjı trendi son 3 yılda ne yönde? CEO sermaye tahsisi: buyback, temettü, borç — hangisini tercih ediyor? Hissedar mektupları varsa referans ver.

7. DEĞERLEME — DCF YAKLAŞIMI (THE THEORY OF INVESTMENT VALUE): Buffett'a göre bir şirketin değeri, ömrü boyunca üretmesi beklenen net nakit akışının belirli bir iskonto oranıyla bugüne indirgenmesiyle hesaplanır. Bu prensiple: Mevcut FCF veya hissedar kazancı büyüme hızını tahmin et, makul bir iskonto oranıyla (genellikle uzun vadeli hazine bonosu + risk primi) değerle. F/K ve EV/EBITDA yardımcı araçtır ama asıl değerleme nakit akışı bazlıdır. "Güvenlik marjı" var mı?
` : ''}

${isLynch ? `
PETER LYNCH ÇERÇEVE KURALLARI — BUNLARA HARFIYEN UY:

1. ÖNCE KATEGORİZE ET: Analiz başlamadan şirketi ata:
   - Yavaş Büyüyen (Slow Grower): Yılda %0-5 büyüme, olgun sektör
   - Orta Büyüyen (Stalwart): Yılda %5-12, güvenilir kar
   - Hızlı Büyüyen (Fast Grower): Yılda %15-25+, Lynch'in favorisi
   - Döngüsel (Cyclical): Ekonomiyle iner çıkar
   - Varlık Zengini (Asset Play): Defter değeri gizli hazine
   - Dönüşümdeki (Turnaround): Kötüden iyiye dönüş potansiyeli
   Kategoriye göre analiz kriterlerini esnet veya sertleştir.

2. SAHA VE HİKAYE (AMATÖR AVANTAJI): Şirketin ürün/hizmetini sıradan bir insan günlük hayatta gözlemleyebilir mi? "Annem bu markayı kullanıyor" testi geçiyor mu? Hikaye 2 dakikada anlatılabiliyor mu? Karmaşık anlatıma ihtiyaç duyan şirketler şüphelidir.

3. DİWORSEİFİCATION KONTROLÜ: Şirket ana iş kolundan uzaklaşıp alakasız alanlara yatırım yapıyor mu? Marj daralması + diversifikasyon = tehlike sinyali. Varsa sert eleştir.

4. PEG ORANI — DOĞRU KULLANIM:
   PEG = F/K / Yıllık Kazanç Büyüme Hızı
   Lynch'e göre: PEG < 1.0 = gerçek değer fırsatı, PEG 1.0-1.5 = adil fiyatlı, PEG > 2.0 = pahalı.
   KRİTİK: PEG 1.5-2.0 arası için "uygun" değil, "dikkatli ol" de. PEG > 2 kesinlikle FAIL.
   Büyüme hızı verisi yoksa tahmini bile belirt ama PEG sinyalini gevşetme.

5. NET NAKİT VE BİLANÇO: Net nakit pozitif mi? Borç/Özsermaye < 0.3 ise güçlü. Lynch, borçlu şirketleri sevmez özellikle döngüsel sektörlerde.

6. STOK/SATIŞ DENGESİ: Stok büyümesi satış büyümesini %10+ aşıyorsa "KALDI" puanı ver. "Satılamayan ürün riski" notu ekle.

7. KURUMSAL SAHİPLİK: %30 altındaysa "GİZLİ MÜCEVHER" işareti ekle. Wall Street henüz keşfetmemiş demektir. %70+ ise "Kurumlar dolu, sürpriz yukarı potansiyeli sınırlı" de.
` : ''}

TÜRK HİSSELERİ İÇİN EK KURAL:
Nominal büyüme Türkiye TÜFE'sinin (%40-65 bandı) altındaysa: "REEL OLARAK KÜÇÜLEN ŞİRKET — Yanıltıcı nominal büyüme uyarısı" ekle.

VERİ TUTARSIZLIĞI:
F/K < 3 veya F/DD < 0.2 gibi anormal değerlerde "VERİ UYARISI" notu ekle.
Veri eksikse "Belirsiz" yazma — sektörel trend ve bilgi birikiminden eğilim (bias) çıkar.

FORMAT KURALLARI:
TOTAL_SCORE: 0-7 arası TAM SAYI. 7'yi kesinlikle geçemez.
VERDICT: sadece AL, BEKLE veya UZAK_DUR`;

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
  enrichedPrompt += '\n\nHer kriter için minimum 2-3 cümle. Somut rakam ve sektör karşılaştırması zorunlu.';

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

    console.log('OK length:', result.length);
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
