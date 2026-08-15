/* ═══════════════════════════════════════════════════════════════
   PİYASA VERİLERİ — endeks / sektör / emtia getiri tabloları
   Veri: /api/market?type=piyasa

   Isı haritası dashboard'da duruyor; bu sayfa "hangi dönemde ne
   kazandırdı" sorusuna bakıyor. Tüm bloklar alt alta, her satırda
   altı dönem — Seeking Alpha'nın "Market Data" sayfası gibi tek
   kaydırmada okunuyor, sekme tıklamaya gerek yok.
   Kütüphane yok — projenin sıfır-build yapısına uysun diye saf DOM.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const UC = '/api/market?type=piyasa';
  const ONBELLEK_MS = 300000;         // 5 dk — sunucu tarafı zaten 10 dk cache'li

  // Sayfa bir ara "tek blok + tek dönem" sekmelerine indirilmişti: veriyi
  // görmek için ikili kombinasyon başına iki tıklama gerekiyordu. Artık
  // her şey açık geliyor; üstteki çipler yalnızca daraltmak isteyene.
  const durum = { veri: null, ts: 0, yukleniyor: false, suzgec: 'tumu' };
  // Blok bazlı sıralama: { blokKey: { anahtar, yon } }. anahtar 'ad' | 'f' | dönem kodu.
  // Boş bırakılırsa API'nin kendi sırası korunur (endeksler mantıklı sırada geliyor).
  const sirala = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Çoğu blok yüzde getiri gösteriyor; BİST sektörleri BİST 100'e göre
  // puan farkı gösterdiği için birimi ayrı (blok.birim === 'p')
  function yuzde(v, birim) {
    if (v == null || !isFinite(v)) return '—';
    const son = birim === 'p' ? ' p' : '%';
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}${son}`;
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

  // Üstteki çipler bloğu değiştirmiyor, yalnızca listeyi daraltıyor:
  // varsayılan "Tümü" olduğu için sayfa hiç tıklamadan tam görünüyor.
  function suzgecCiz(veri) {
    const cip = (k, ad) => `<button class="pv-cip${k === durum.suzgec ? ' active' : ''}" data-suz="${esc(k)}">${esc(ad)}</button>`;
    return `<div class="pv-suzgec">
      ${cip('tumu', 'Tümü')}${veri.bloklar.map(b => cip(b.k, b.ad)).join('')}
    </div>`;
  }

  function blokCiz(blok, donemler) {
    const s = sirala[blok.k] || {};
    // Sektör ortalamalarının tek bir fiyatı yok — o blokta sütunu hiç açma,
    // 11 satır boyunca "—" yazan ölü bir sütun kalmasın
    const fiyatVar = blok.fiyatVar !== false;
    const bas = (anahtar, ad, ek) =>
      `<th class="${ek || ''}${s.anahtar === anahtar ? ' sirali' : ''}" data-blok="${esc(blok.k)}" data-sirala="${esc(anahtar)}">${esc(ad)}<span class="pv-ok">${s.anahtar === anahtar ? (s.yon > 0 ? '▲' : '▼') : ''}</span></th>`;

    const satirlar = siralanmis(blok).map(r => {
      const hucreler = donemler.map(d =>
        `<td class="pv-g ${sinif(r.g[d.k])}">${yuzde(r.g[d.k], blok.birim)}</td>`).join('');
      return `<tr${r.sek ? ` data-sek="${esc(r.sek)}" data-kap="${esc(r.kap || 'us')}" title="${esc(r.ad)} sektöründeki hisseler"` : ''}>
        <td><span class="pv-ad"><span class="pv-ad-t">${esc(r.ad)}</span><span class="pv-ad-s">${esc(r.kod || '')}</span></span></td>
        ${fiyatVar ? `<td class="pv-fiyat">${fiyat(r.f)}</td>` : ''}
        ${hucreler}
      </tr>`;
    }).join('');

    return `<div class="pv-blok" id="pv-blok-${esc(blok.k)}">
      <div class="pv-blok-bas">
        <span class="pv-blok-t">${esc(blok.ad)}</span>
        <span class="pv-blok-n">${esc(blok.not || '')}</span>
        <span class="pv-blok-s">${blok.satirlar.length} satır</span>
      </div>
      <div class="pv-sar">
        <table class="pv-tablo pv-genis">
          <thead><tr>
            ${bas('ad', 'Ad', 'pv-th-ad')}
            ${fiyatVar ? bas('f', 'Fiyat') : ''}
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
      if (durum.suzgec !== 'tumu' && !veri.bloklar.some(b => b.k === durum.suzgec)) durum.suzgec = 'tumu';
      ciz();
      if (durumEl) {
        const saat = new Date(veri.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        durumEl.textContent = saat;
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
    const veri = durum.veri;
    const bloklar = durum.suzgec === 'tumu'
      ? veri.bloklar
      : veri.bloklar.filter(b => b.k === durum.suzgec);
    govde.innerHTML = suzgecCiz(veri) + bloklar.map(b => blokCiz(b, veri.donemler)).join('');
  }

  function olaylariKur() {
    const govde = document.getElementById('pvGovde');
    if (!govde) return;

    govde.addEventListener('click', e => {
      const cip = e.target.closest('[data-suz]');
      if (cip) { durum.suzgec = cip.dataset.suz; ciz(); window.scrollTo(0, 0); return; }
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
      // Sektör satırı → o sektörün hisse tablosu (ısı haritasıyla ortak sayfa)
      const tr = e.target.closest('tr[data-sek]');
      if (tr && typeof window.hmSektorAc === 'function') window.hmSektorAc(tr.dataset.sek, tr.dataset.kap || 'us');
    });
  }

  window.pvSayfaAc = function () { sayfaYukle(false); };
  window.pvYenile = function () { sayfaYukle(true); };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', olaylariKur);
  else olaylariKur();
})();
