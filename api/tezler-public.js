const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

  const { id } = req.query;

  if (id) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${id}&yayinda=eq.true&select=*`, { headers });
    const data = await r.json();
    return res.status(200).json(data?.[0] || null);
  }

  const r = await fetch(`${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&order=olusturma.desc&select=*`, { headers });
  return res.status(200).json(await r.json());
}
