const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function getHaftaKodu() {
  const now = new Date();
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const hafta = Math.ceil(((now - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${now.getFullYear()}-W${String(hafta).padStart(2, '0')}`;
}

async function getCachedenSecimler(hafta, market) {
  const key = `${hafta}-${market}`;
  const url = `${SUPABASE_URL}/rest/v1/haftalik_secimler?hafta=eq.${key}&select=*`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const data = await r.json();
  return data?.[0] || null;
}

async function getTopHisseler(market) {
  const tablo = market === 'global' ? 'global_garp_latest' : 'bist_garp_latest';
  const url = `${SUPABASE_URL}/rest/v1/${tablo}?sinyal=in.(AL,IZLE)&order=final_skoru.desc&limit=3&select=*`;
  const r = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return await r.json();
}

async function llmYorum(hisse, market) {
  const doviz = market === 'global' ? '$' : '₺';
  const prompt = `Hisse: ${hisse.ticker}${market === 'global' ? ' ('+hisse.exchange+')' : ''}
Sinyal: ${hisse.sinyal} (Skor: ${hisse.final_skoru}/100)
F/K: ${hisse.fk || 'N/A'} | PD/DD: ${hisse.pddd || 'N/A'} | FD/FAVOK: ${hisse.fd_favok || 'N/A'}
ROE: %${hisse.roe || 'N/A'} | Buyume: %${hisse.buyume_yoy || 'N/A'}
Teknik: ${hisse.teknik_teyit} (${hisse.teknik_skoru}/100)

Bu hisse icin 2-3 cumlelik net yatirim tezi yaz.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: 'Sen GARP yatirim felsefesiyle calisan bir analistsin. Kisa, net, aksiyona donuk Turkce yatirim tezleri yaziyorsun. Maksimum 3 cumle.',
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await r.json();
  return data?.content?.[0]?.text?.trim() || null;
}

async function saveCache(hafta, market, secimler) {
  const key = `${hafta}-${market}`;
  const url = `${SUPABASE_URL}/rest/v1/haftalik_secimler`;
  await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ hafta: key, secimler })
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const market = req.query.market === 'global' ? 'global' : 'bist';

  try {
    const hafta = getHaftaKodu();
    const cache = await getCachedenSecimler(hafta, market);
    if (cache) {
      return res.status(200).json({ hafta, market, secimler: cache.secimler, cache: true });
    }

    const hisseler = await getTopHisseler(market);
    if (!hisseler?.length) {
      return res.status(404).json({ error: 'Veri yok' });
    }

    const secimler = [];
    for (const h of hisseler) {
      const yorum = await llmYorum(h, market);
      secimler.push({
        ticker:      h.ticker,
        exchange:    h.exchange || 'BIST',
        sinyal:      h.sinyal,
        final_skoru: h.final_skoru,
        garp_skoru:  h.garp_skoru,
        teknik_skoru:h.teknik_skoru,
        teknik_teyit:h.teknik_teyit,
        fk:          h.fk,
        pddd:        h.pddd,
        roe:         h.roe,
        yorum,
      });
    }

    await saveCache(hafta, market, secimler);
    return res.status(200).json({ hafta, market, secimler, cache: false });

  } catch (e) {
    console.error('[Haftalik] Hata:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
