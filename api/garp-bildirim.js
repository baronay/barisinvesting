const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { tickers, delta, since } = req.query;
  if (!tickers) return res.status(400).json({ error: 'tickers gerekli' });

  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const clean = String(tickers).toUpperCase().replace(/[^A-Z0-9,]/g, '');
  if (!clean) return res.status(400).json({ error: 'tickers gerekli' });

  // ── DELTA MODU: son ziyaretten beri skor/sinyal değişimi + yeni tezler ──
  // GET /api/garp-bildirim?delta=1&tickers=THYAO,ASELS&since=2026-06-28T08:30:00Z
  if (delta) {
    const sinceTs = since ? new Date(since) : null;
    if (!sinceTs || isNaN(sinceTs)) return res.status(400).json({ error: 'gecerli since gerekli' });
    const sinceDate = sinceTs.toISOString().slice(0, 10);
    // Baseline penceresi: since'ten geriye 14 gün — hisse başına o aralıktaki
    // en güncel scan satırı "ziyaret anındaki skor" kabul edilir
    const floorDate = new Date(sinceTs.getTime() - 14 * 86400000).toISOString().slice(0, 10);

    try {
      // Güncel skorlar da bist_garp_scan'den (son 7 gün penceresi, hisse başına
      // en yeni satır) — view şemasına bağımlılık yok
      const freshFloor = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
      const [latestRes, baseRes, tezRes] = await Promise.all([
        fetch(
          `${SUPABASE_URL}/rest/v1/bist_garp_scan?ticker=in.(${clean})&scan_date=gte.${freshFloor}&order=scan_date.desc&select=ticker,sinyal,final_skoru,teknik_teyit,scan_date`,
          { headers }
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/bist_garp_scan?ticker=in.(${clean})&scan_date=lte.${sinceDate}&scan_date=gte.${floorDate}&order=scan_date.desc&select=ticker,sinyal,final_skoru,scan_date`,
          { headers }
        ),
        fetch(
          `${SUPABASE_URL}/rest/v1/tezler?yayinda=eq.true&olusturma=gt.${encodeURIComponent(sinceTs.toISOString())}&order=olusturma.desc&select=id,baslik,ticker,sinyal,olusturma,exchange&limit=5`,
          { headers }
        ),
      ]);

      const latestRows = latestRes.ok ? await latestRes.json() : [];
      const baseRows = baseRes.ok ? await baseRes.json() : [];
      const tezler = tezRes.ok ? await tezRes.json() : [];

      // Hisse başına en güncel satır (sorgu desc sıralı)
      const latestMap = {};
      for (const r of Array.isArray(latestRows) ? latestRows : []) {
        if (!latestMap[r.ticker]) latestMap[r.ticker] = r;
      }
      const latest = Object.values(latestMap);

      // Hisse başına baseline: since öncesi en yeni satır (sorgu desc sıralı)
      const baseline = {};
      for (const r of Array.isArray(baseRows) ? baseRows : []) {
        if (!baseline[r.ticker]) baseline[r.ticker] = r;
      }

      const deltalar = [];
      for (const g of latest) {
        const b = baseline[g.ticker];
        if (!b) continue; // ziyaret anında veri yoktu — kıyaslanamaz
        if (b.scan_date === g.scan_date) continue; // yeni scan yok
        const skorFark = Math.round((g.final_skoru - b.final_skoru) * 10) / 10;
        const sinyalDegisti = b.sinyal !== g.sinyal;
        if (Math.abs(skorFark) < 3 && !sinyalDegisti) continue; // gürültüyü ele
        deltalar.push({
          ticker: g.ticker,
          eski_skor: b.final_skoru,
          yeni_skor: g.final_skoru,
          eski_sinyal: b.sinyal,
          yeni_sinyal: g.sinyal,
          teknik_teyit: g.teknik_teyit,
          scan_date: g.scan_date,
        });
      }
      deltalar.sort((a, b) => Math.abs(b.yeni_skor - b.eski_skor) - Math.abs(a.yeni_skor - a.eski_skor));

      return res.status(200).json({
        deltalar,
        tezler: (Array.isArray(tezler) ? tezler : []).map(t => ({
          id: t.id, baslik: t.baslik, ticker: t.ticker, sinyal: t.sinyal,
          olusturma: t.olusturma, exchange: t.exchange,
        })),
        since: sinceTs.toISOString(),
        ts: Date.now(),
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── MEVCUT MOD: güncel GARP sinyalleri (badge bildirimi) ──
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/bist_garp_latest?ticker=in.(${clean})&select=ticker,sinyal,final_skoru,teknik_teyit`,
    { headers }
  );
  const data = await r.json();
  return res.status(200).json(data);
}
