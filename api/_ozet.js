/* ═══════════════════════════════════════════════════════════════
   ŞİRKET ÖZETİ — ansiklopedi girişinden kısa tanım
   Hem şirket kartı (/api/profil) hem ısı haritası ipucu balonu
   (/api/market?type=ozet) buradan besleniyor; tek kaynak, tek davranış.
   ═══════════════════════════════════════════════════════════════ */

const BASLIK = { 'Accept': 'application/json', 'User-Agent': process.env.SEC_UA || 'BarisInvesting/1.0 (info@barisinvesting.com)' };

/* ── Şirket adı temizliği ─────────────────────────────────────────
   "NVIDIA CORP" → "NVIDIA", "Apple Inc." → "Apple". Hem ansiklopedi
   hem haber aramasında ham unvan kötü sonuç veriyor. */
const SIRKET_EKI = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|plc|ltd|ltd\.|llc|lp|nv|sa|ag|holdings?|group|the)\b/gi;

export function adiSadelestir(ad) {
  return String(ad || '')
    .replace(/[,&]/g, ' ')
    .replace(SIRKET_EKI, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ansiklopedi araması yanlış şirkete düşebiliyor (TR'de "NVIDIA Corp"
// araması MSI'yı, "Powell Industries" bir kaykaycıyı getirdi) — bulunan
// başlık şirket adıyla en az bir anlamlı kelimeyi paylaşmalı
export function baslikUyuyor(baslik, ad) {
  const kelimeler = adiSadelestir(ad).toLowerCase().split(/\s+/).filter(k => k.length >= 4);
  if (!kelimeler.length) return false;
  const b = String(baslik || '').toLowerCase();
  return kelimeler.some(k => b.includes(k));
}

/* uzunluk: ipucu balonu kısa metin istiyor, şirket kartı uzun */
export async function ozetGetir(ad, uzunluk) {
  const sorgu = adiSadelestir(ad);
  if (!sorgu) return null;
  const kar = Math.max(120, Math.min(1000, uzunluk || 520));
  for (const dil of ['tr', 'en']) {
    try {
      const u = `https://${dil}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&exchars=${kar}&generator=search&gsrsearch=${encodeURIComponent(sorgu)}&gsrlimit=1`;
      const r = await fetch(u, { headers: BASLIK, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const sayfalar = j?.query?.pages;
      if (!sayfalar) continue;
      const s = Object.values(sayfalar)[0];
      if (!s || !s.extract || !baslikUyuyor(s.title, ad)) continue;
      const metin = String(s.extract).replace(/\s+/g, ' ').trim();
      if (metin.length < 40) continue;
      return { metin, dil };
    } catch { /* sonraki dil */ }
  }
  return null;
}
