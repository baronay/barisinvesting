const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  const { id, ticker } = req.query;

  // Tek tez — ID ile
  if (id) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}&yayinda=eq.true&select=*`, { headers });
    const data = await r.json();
    return res.status(200).json(data?.[0] || null);
  }

  // Ticker ile tez ara — analiz sonrası bildirim için
  if (ticker) {
    const t = ticker.toUpperCase().replace(/[^A-Z0-9.]/g, '');
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tezler?ticker=eq.${t}&yayinda=eq.true&select=id,baslik,sinyal,ozet,olusturma,maliyet_fiyat,exchange&limit=1`,
      { headers }
    );
    const data = await r.json();
    return res.status(200).json(data?.[0] || null);
  }

  // Tüm tezler listesi
  const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc&select=*`, { headers });
  return res.status(200).json(await r.json());
}
