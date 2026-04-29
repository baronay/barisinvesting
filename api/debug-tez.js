// /api/debug-tez.js — sadece test için, sonra sil
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  // Tüm tezlerin maliyet_fiyat ve exchange alanlarını göster
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tezler?select=id,ticker,baslik,maliyet_fiyat,exchange,yayinda`,
    { headers }
  );
  const data = await r.json();
  return res.status(200).json(data);
}
