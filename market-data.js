/* ═══════════════════════════════════════════════════════════════
   PİYASA VERİLERİ — endeks / sektör / emtia getiri tabloları
   Veri: /api/market?type=piyasa

   Isı haritası dashboard'da duruyor; bu sayfa "hangi dönemde ne
   kazandırdı" sorusuna bakıyor. Dört blok, her satırda altı dönem.
   Kütüphane yok — projenin sıfır-build yapısına uysun diye saf DOM.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const UC = '/api/market?type=piyasa';
  const ONBELLEK_MS = 300000;         // 5 dk — sunucu tarafı zaten 10 dk cache'li

  const durum = { veri: null, ts: 0, yukleniyor: false };
  // Blok bazlı sıralama: { blokKey: { anahtar, yon } }. anahtar 'ad' | 'f' | dönem kodu.
  const sirala = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function yuzde(v) {
    if (v == null || !isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  }

  function sinif(v) {
    if (v == null || !isFinite(v)) return 'neu';
    return v > 0.004 ? 'pos' : v < -0.004 ? 'neg' : 'neu';
  }

  // Endeksler dört haneli, kurlar dört ondalıklı — tek biçim ikisine de uymuyor
  function fiyat(v) {
    if (v == null || !isFinite(v)) return '—';
    const m = Math.abs(v);
    const ond = m >= 1000 ? 0 : m >= 10 ? 2 : 4;
    return v.toLocaleString('tr-TR', { minimumFractionDigits: ond, maximumFractionDigits: ond });
  }

  async function getir(zorla) {
    if (!zorla && durum.veri && (Date.now() - durum.ts) < ONBELLEK_MS) return durum.veri;
    const r = await fetch(UC);
    const j = await r.json();
    if (!j || j.error) throw new Error((j && j.error) || 'Veri yok');
    durum.veri = j;
    durum.ts = Date.now();
    return j;
  }

  function siralanmis(blok) {
    const s = sirala[blok.k];
    if (!s) return blok.satirlar;
    const liste = blok.satirlar.slice();
    liste.sort((a, b) => {
      let av, bv;
      if (s.anahtar === 'ad') { av = a.ad || ''; bv = b.ad || ''; return av.localeCompare(bv, 'tr') * s.yon; }
      if (s.anahtar === 'f') { av = a.f; bv = b.f; }
      else { av = a.g[s.anahtar]; bv = b.g[s.anahtar]; }
      // Veri gelmeyen satır her zaman altta kalsın — yoksa "en kötü getiri"
      // sıralamasında boş satırlar başa çıkıyor
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * s.yon;
    });
    return liste;
  }

  function blokCiz(blok, donemler) {
    const s = sirala[blok.k] || {};
    const bas = (anahtar, ad) =>
      `<th class="${s.anahtar === anahtar ? 'sirali' : ''}" data-blok="${esc(blok.k)}" data-sirala="${esc(anahtar)}">${esc(ad)}${s.anahtar === anahtar ? (s.yon > 0 ? ' ▲' : ' ▼') : ''}</th>`;

    const satirlar = siralanmis(blok).map(r => {
      const hucreler = donemler.map(d =>
        `<td class="pv-g ${sinif(r.g[d.k])}">${yuzde(r.g[d.k])}</td>`).join('');
      return `<tr${r.sek ? ` data-sek="${esc(r.sek)}" title="${esc(r.ad)} sektöründeki hisseler"` : ''}>
        <td><span class="pv-ad"><span class="pv-ad-t">${esc(r.ad)}</span><span class="pv-ad-s">${esc(r.kod || '')}</span></span></td>
        <td class="pv-fiyat">${fiyat(r.f)}</td>
        ${hucreler}
      </tr>`;
    }).join('');

    return `<div class="pv-blok">
      <div class="pv-blok-bas">
        <span class="pv-blok-t">${esc(blok.ad)}</span>
        <span class="pv-blok-n">${esc(blok.not || '')}</span>
      </div>
      <div class="pv-sar">
        <table class="pv-tablo">
          <thead><tr>
            ${bas('ad', 'Ad')}
            ${bas('f', 'Fiyat')}
            ${donemler.map(d => bas(d.k, d.ad)).join('')}
          </tr></thead>
          <tbody>${satirlar}</tbody>
        </table>
      </div>
    </div>`;
  }

  async function sayfaYukle(zorla) {
    const govde = document.getElementById('pvGovde');
    if (!govde || durum.yukleniyor) return;
    durum.yukleniyor = true;

    const durumEl = document.getElementById('pvDurum');
    if (!durum.veri) govde.innerHTML = '<div class="pv-bos">Piyasa verileri hazırlanıyor…</div>';
    if (durumEl) durumEl.textContent = 'yükleniyor…';

    try {
      const veri = await getir(zorla);
      govde.innerHTML = veri.bloklar.map(b => blokCiz(b, veri.donemler)).join('');
      if (durumEl) {
        const saat = new Date(veri.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        const adet = veri.bloklar.reduce((t, b) => t + b.satirlar.length, 0);
        durumEl.textContent = `${adet} enstrüman · ${saat}`;
      }
    } catch (e) {
      govde.innerHTML = '<div class="pv-bos">Piyasa verisi alınamadı. Birazdan tekrar dene.</div>';
      if (durumEl) durumEl.textContent = '';
    } finally {
      durum.yukleniyor = false;
    }
  }

  function ciz() {
    const govde = document.getElementById('pvGovde');
    if (!govde || !durum.veri) return;
    govde.innerHTML = durum.veri.bloklar.map(b => blokCiz(b, durum.veri.donemler)).join('');
  }

  function olaylariKur() {
    const govde = document.getElementById('pvGovde');
    if (!govde) return;

    govde.addEventListener('click', e => {
      const th = e.target.closest('th[data-sirala]');
      if (th) {
        const blok = th.dataset.blok, anahtar = th.dataset.sirala;
        const s = sirala[blok];
        // Aynı sütuna tekrar basınca yön değişir; metin A→Z, sayı büyükten küçüğe başlar
        if (s && s.anahtar === anahtar) s.yon *= -1;
        else sirala[blok] = { anahtar, yon: anahtar === 'ad' ? 1 : -1 };
        ciz();
        return;
      }
      // ABD sektör satırı → o sektörün hisse tablosu (ısı haritasıyla ortak sayfa)
      const tr = e.target.closest('tr[data-sek]');
      if (tr && typeof window.hmSektorAc === 'function') window.hmSektorAc(tr.dataset.sek, 'us');
    });
  }

  window.pvSayfaAc = function () { sayfaYukle(false); };
  window.pvYenile = function () { sayfaYukle(true); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', olaylariKur);
  else olaylariKur();
})();
