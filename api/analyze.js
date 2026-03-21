export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ticker, framework } = req.body;

  if (!ticker) {
    return res.status(400).json({ error: 'Ticker gerekli' });
  }

  const prompts = {
    buffett: `Sen Buffett ve Druckenmiller'ın yatırım felsefesini derinlemesine inceleyen bir finans analistisin.

"${ticker}" hissesini aşağıdaki 7 Buffett kriteri ile analiz et.

KRİTERLER:
1. ROE_SUSTAINABILITY: ROE %15+ ve son 5 yılda tutarlı mı?
2. PRICING_POWER: Şirket fiyat belirleyici mi? Kâr marjı genişliyor mu?
3. DOLLAR_TEST: Her $1 alıkonulan sermaye, $1+ piyasa değeri yarattı mı?
4. MOAT: Sürdürülebilir rekabet avantajı var mı?
5. FREE_CASH_FLOW: FCF tutarlı, büyüyor ve net gelirle uyumlu mu?
6. MANAGEMENT: Hissedar dostu yönetim, iyi sermaye tahsisi geçmişi var mı?
7. VALUATION: İçsel değerine göre makul güvenlik marjıyla fiyatlanmış mı?

YANIT FORMATI (sadece bu format):
TICKER: ${ticker}
TOTAL_SCORE: X
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [2-3 cümle genel değerlendirme]
DRUCKENMILLER: [makro/momentum değerlendirmesi 1-2 cümle]
RISK: [en kritik 1 risk faktörü]

CRITERIA_START
ROE: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
PRICING: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
DOLLAR: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
MOAT: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
FCF: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
MGMT: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
VALUATION: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
CRITERIA_END`,

    lynch: `Sen Peter Lynch'in yatırım felsefesini derinlemesine inceleyen bir finans analistisin.

"${ticker}" hissesini Peter Lynch'in 7 kriteri ile analiz et.

KRİTERLER:
1. PEG_RATIO: PEG oranı 1'in altında mı? Büyüme fiyatına göre ucuz mu?
2. UNDERSTANDABLE: İşi anlaşılır mı? Sıradan insan açıklayabilir mi?
3. GROWTH_STORY: Büyüme hikayesi tutarlı ve devam ediyor mu?
4. INSTITUTIONAL_NEGLECT: Kurumsal yatırımcılar tarafından ihmal ediliyor mu?
5. EARNINGS_GROWTH: EPS büyümesi tutarlı ve güçlü mü?
6. BALANCE_SHEET: Bilanço güçlü mü, borç yönetilebilir mi?
7. CATEGORY: Hangi Lynch kategorisi? (Slow Grower/Stalwart/Fast Grower/Turnaround/Asset Play)

YANIT FORMATI (sadece bu format):
TICKER: ${ticker}
TOTAL_SCORE: X
VERDICT: AL|BEKLE|UZAK_DUR
SUMMARY: [2-3 cümle genel değerlendirme]
LYNCH_NOTE: [Lynch'in bu hisseye yaklaşımı 1-2 cümle]
RISK: [en kritik 1 risk faktörü]

CRITERIA_START
PEG: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
UNDERSTAND: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
GROWTH: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
NEGLECT: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
EARNINGS: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
BALANCE: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
CATEGORY: PASS|FAIL|NEUTRAL | [2-3 cümle detaylı açıklama]
CRITERIA_END`
  };

  const selectedPrompt = prompts[framework || 'buffett'];

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
        max_tokens: 1000,
        messages: [{ role: 'user', content: selectedPrompt }]
      })
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    res.status(200).json({ result: text });

  } catch (err) {
    res.status(500).json({ error: 'API hatası: ' + err.message });
  }
}
