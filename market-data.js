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

  // Sayfa eskiden dört tabloyu alt alta, her birini altı dönem sütunuyla
  // gösteriyordu: 45 satır × 7 sütun. Okunmuyordu. Artık aynı anda tek
  // blok ve tek dönem görünüyor; kullanıcı ikisini de üstten seçiyor.
  const durum = { veri: null, ts: 0, yukleniyor: false, blok: null, donem: '1g' };
  // Blok bazlı sıralama: { blokKey: { anahtar, yon } }. anahtar 'ad' | 'f' | dönem kodu.
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

  function sekmeCiz(veri) {
    const bloklar = veri.bloklar.map(b =>
      `<button class="pv-sek${b.k === durum.blok ? ' active' : ''}" data-blok="${esc(b.k)}">${esc(b.ad)}</button>`).join('');
    const donemler = veri.donemler.map(d =>
      `<button class="pv-sek pv-sek-d${d.k === durum.donem ? ' active' : ''}" data-donem="${esc(d.k)}">${esc(d.ad)}</button>`).join('');
    return `<div class="pv-sekmeler">
      <div class="pv-sek-grp">${bloklar}</div>
      <div class="pv-sek-grp pv-sek-sag">${donemler}</div>
    </div>`;
  }

  function blokCiz(blok, donemler) {
    const s = sirala[blok.k] || {};
    // Sektör ortalamalarının tek bir fiyatı yok — o blokta sütunu hiç açma,
    // 11 satır boyunca "—" yazan ölü bir sütun kalmasın
    const fiyatVar = blok.fiyatVar !== false;
    const bas = (anahtar, ad) =>
      `<th class="${s.anahtar === anahtar ? 'sirali' : ''}" data-blok="${esc(blok.k)}" data-sirala="${esc(anahtar)}">${esc(ad)}${s.anahtar === anahtar ? (s.yon > 0 ? ' ▲' : ' ▼') : ''}</th>`;

    const satirlar = siralanmis(blok).map(r => {
      const hucreler = donemler.map(d =>
        `<td class="pv-g ${sinif(r.g[d.k])}">${yuzde(r.g[d.k], blok.birim)}</td>`).join('');
      return `<tr${r.sek ? ` data-sek="${esc(r.sek)}" data-kap="${esc(r.kap || 'us')}" title="${esc(r.ad)} sektöründeki hisseler"` : ''}>
        <td><span class="pv-ad"><span class="pv-ad-t">${esc(r.ad)}</span><span class="pv-ad-s">${esc(r.kod || '')}</span></span></td>
        ${fiyatVar ? `<td class="pv-fiyat">${fiyat(r.f)}</td>` : ''}
        ${hucreler}
      </tr>`;
    }).join('');

    return `<div class="pv-blok">
      <div class="pv-blok-bas">
        <span class="pv-blok-n">${esc(blok.not || '')}</span>
      </div>
      <div class="pv-sar">
        <table class="pv-tablo">
          <thead><tr>
            ${bas('ad', 'Ad')}
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
      if (!durum.blok || !veri.bloklar.some(b => b.k === durum.blok)) durum.blok = veri.bloklar[0].k;
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
    const blok = veri.bloklar.find(b => b.k === durum.blok) || veri.bloklar[0];
    const donem = veri.donemler.find(d => d.k === durum.donem) || veri.donemler[0];
    // Seçili dönemi varsayılan sıralama yap: tablo doğrudan bir sıralama
    // olarak okunsun, kullanıcı başlığa basmak zorunda kalmasın
    if (!sirala[blok.k]) sirala[blok.k] = { anahtar: donem.k, yon: -1 };
    govde.innerHTML = sekmeCiz(veri) + blokCiz(blok, [donem]);
  }

  function olaylariKur() {
    const govde = document.getElementById('pvGovde');
    if (!govde) return;

    govde.addEventListener('click', e => {
      const sekB = e.target.closest('[data-blok]:not(th)');
      if (sekB) { durum.blok = sekB.dataset.blok; ciz(); return; }
      const sekD = e.target.closest('[data-donem]');
      if (sekD) {
        durum.donem = sekD.dataset.donem;
        // Dönem değişince sıralama da o döneme geçsin
        const b = durum.blok;
        if (b) sirala[b] = { anahtar: durum.donem, yon: -1 };
        ciz();
        return;
      }
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
