// /api/tez-ozet.js — "3 dakikada tez" özetini tezin KENDİ metninden çıkarır
//
// POST /api/tez-ozet   body: { id, email, secret }   (admin)
//
// Neden var: tezler akademik makale uzunluğunda; giriş bariyeri yüksek.
// Ama özet için ayrıca yazı yazmak yeni bir iş yükü demek olurdu. Bu uç
// tezin gövdesini okuyup beş satırı çıkarıyor — boğa, ayı, "benim farkım",
// fiyat bandı ve tezin kırıldığı eşik. Hepsi metnin içinde zaten var,
// yalnızca yüzeye çıkarılıyor. Sonuç tabloda saklanıyor: her okuyucuda
// yeniden üretilmiyor, tek seferlik. Admin isterse elle düzeltir.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const ADMIN_EMAIL  = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const MODEL = process.env.OZET_MODEL || 'claude-sonnet-5';

export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

/* Gövdeyi düz metne indir: etiketler, stil ve script dışarıda kalsın.
   Modelin okuması gereken şey yazının kendisi, işaretlemesi değil. */
function duzMetin(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALAN = {
  BOGA: 'ozet_boga', AYI: 'ozet_ayi', FARK: 'ozet_fark',
  FIYAT: 'ozet_fiyat', KIRILMA: 'ozet_kirilma',
};

function ayikla(metin) {
  const out = {};
  for (const [anahtar, sutun] of Object.entries(ALAN)) {
    const m = metin.match(new RegExp(`^${anahtar}:\\s*([^\\n]+)`, 'm'));
    if (m) out[sutun] = m[1].trim().slice(0, 400);
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { id, email, secret } = req.body || {};
  const emailOk  = ADMIN_EMAIL && String(email || '').toLowerCase().trim() === ADMIN_EMAIL;
  const secretOk = ADMIN_SECRET && secret === ADMIN_SECRET;
  if (!emailOk || !secretOk) return res.status(403).json({ error: 'Yetkisiz' });

  const idNum = String(id || '').replace(/[^0-9]/g, '');
  if (!idNum) return res.status(400).json({ error: 'id gerekli' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY eksik' });

  const headers = {
    apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
  };

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/tezler?id=eq.${idNum}&select=id,ticker,baslik,ozet,icerik,sinyal,exchange`,
      { headers });
    const tez = (await r.json())?.[0];
    if (!tez) return res.status(404).json({ error: 'Tez bulunamadı' });

    const govde = duzMetin(tez.icerik).slice(0, 45000);
    if (govde.length < 400) return res.status(400).json({ error: 'Tez metni özet için fazla kısa' });

    const sistem = `Sen Barış Investing'in editörüsün. Sana verilen yatırım tezinin KENDİ İÇİNDEKİ bilgiyi kullanarak "3 dakikada tez" kutusunu hazırlıyorsun.

KURALLAR
- Metinde olmayan hiçbir şey yazma. Rakam uydurma, tahmin ekleme.
- Yazarın ağzından, birinci tekil şahısla yaz ("izliyorum", "tartıştığım şey…").
- Her satır TEK cümle, en fazla 25 kelime. Süs yok, doğrudan söyle.
- Metinde bir alanın karşılığı gerçekten yoksa o satıra sadece "—" yaz.
- Türkçe yaz.

BİÇİM (tam olarak bu beş satır, başka hiçbir şey yazma):
BOGA: [tezin çalışması için gereken şey — piyasanın da gördüğü iyimser taraf]
AYI: [en ciddi karşı argüman, tezin en zayıf yeri]
FARK: [yazarın piyasadan/konsensüsten ayrıştığı nokta — "benim farkım" budur]
FIYAT: [metinde geçen izleme/giriş/hedef bandı; yoksa "—"]
KIRILMA: [tezi çürütecek somut eşik: hangi metrik, hangi seviyeye gelirse]`;

    const istek = `ŞİRKET: ${tez.ticker || '—'} (${tez.exchange || '—'})
BAŞLIK: ${tez.baslik || ''}
${tez.ozet ? `GİRİŞ: ${tez.ozet}\n` : ''}
TEZ METNİ:
${govde}`;

    const ac = new AbortController();
    const zamanlayici = setTimeout(() => ac.abort(), 40000);
    let ai;
    try {
      ai = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 700,
          thinking: { type: 'disabled' },
          system: sistem,
          messages: [{ role: 'user', content: istek }],
        }),
        signal: ac.signal,
      });
    } finally { clearTimeout(zamanlayici); }

    const d = await ai.json();
    if (!ai.ok || d.error) {
      return res.status(502).json({ error: `AI hatası: ${d?.error?.type || ai.status}` });
    }
    const metin = (d.content || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
    const alanlar = ayikla(metin);
    if (!Object.keys(alanlar).length) {
      return res.status(502).json({ error: 'Özet ayrıştırılamadı', ham: metin.slice(0, 300) });
    }

    alanlar.ozet_tarih = new Date().toISOString();
    const kaydet = await fetch(`${SUPABASE_URL}/rest/v1/tezler?id=eq.${idNum}`, {
      method: 'PATCH', headers, body: JSON.stringify(alanlar),
    });
    if (!kaydet.ok) {
      const detay = await kaydet.text();
      return res.status(500).json({ error: 'Kaydedilemedi', detay: detay.slice(0, 200) });
    }

    return res.status(200).json({ ok: true, ozet: alanlar });
  } catch (e) {
    const zamanAsimi = e.name === 'AbortError' || e.name === 'TimeoutError';
    return res.status(zamanAsimi ? 504 : 500).json({ error: zamanAsimi ? 'Süre doldu, tekrar dene' : e.message });
  }
}
