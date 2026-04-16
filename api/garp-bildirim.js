const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers gerekli' });

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/bist_garp_latest?ticker=in.(${tickers})&select=ticker,sinyal,final_skoru,teknik_teyit`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const data = await r.json();
  return res.status(200).json(data);
}
