export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const fmpKey = process.env.FMP_API_KEY;
  const hasKey = !!fmpKey;
  const keyLen = fmpKey ? fmpKey.length : 0;
  const keyStart = fmpKey ? fmpKey.substring(0, 4) : 'YOOK';

  // FMP'ye gerçek istek at
  let fmpTest = null;
  if (fmpKey) {
    try {
      const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=${fmpKey}`, {
        signal: AbortSignal.timeout(5000)
      });
      const text = await r.text();
      fmpTest = { status: r.status, body: text.substring(0, 200) };
    } catch(e) {
      fmpTest = { error: e.message };
    }
  }

  return res.status(200).json({
    hasKey,
    keyLen,
    keyStart,
    fmpTest,
    allEnvKeys: Object.keys(process.env).filter(k => k.includes('FMP') || k.includes('SUPABASE') || k.includes('ADMIN'))
  });
}
