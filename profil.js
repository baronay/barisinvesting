/* ═══════════════════════════════════════════════════════════════
   ŞİRKET PROFİLİ — künye + finansal tablolar
   Veri: /api/profil?ticker=…  (SEC EDGAR)

   Şimdilik yalnızca ABD hisseleri: SEC verisi resmî ve ücretsiz,
   BİST tarafında aynı kalitede kaynak yok.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const durum = { ticker: null, veri: null, yukleniyor: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 391035000000 → "391,0 Mlr" · 45600000 → "45,6 Mn"
  function para(v) {
    if (v == null || !isFinite(v)) return '—';
    const isaret = v < 0 ? '-' : '';
    const m = Math.abs(v);
    const bic = (x, ond) => x.toLocaleString('tr-TR', { minimumFractionDigits: ond, maximumFractionDigits: ond });
    if (m >= 1e12) return `${isaret}$${bic(m / 1e12, 2)} Tn`;
    if (m >= 1e9) return `${isaret}$${bic(m / 1e9, m / 1e9 >= 100 ? 0 : 1)} Mlr`;
    if (m >= 1e6) return `${isaret}$${bic(m / 1e6, m / 1e6 >= 100 ? 0 : 1)} Mn`;
    return `${isaret}$${bic(m, 0)}`;
  }

  function hisseBasi(v) {
    if (v == null || !isFinite(v)) return '—';
    return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function deger(v, birim) {
    return birim === 'USD/hisse' ? hisseBasi(v) : para(v);
  }

  // "2025-09-27" → "Eyl 2025"
  const AYLAR = ['Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz', 'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara'];
  function donemAd(iso, ceyrek) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d)) return iso;
    const ay = AYLAR[d.getUTCMonth()];
    const yil = d.getUTCFullYear();
    return ceyrek ? `${ay} ${yil}` : `${yil}`;
  }

  // Yıl sonu ayı değişken olabildiği için yıllık başlıkta da ayı göster
  function yilBaslik(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    if (isNaN(d)) return iso;
    return `${d.getUTCFullYear()}<span class="pr-ay">${AYLAR[d.getUTCMonth()]}</span>`;
  }

  const TABLO_AD = { gelir: 'Gelir Tablosu', bilanco: 'Bilanço', nakit: 'Nakit Akışı' };

  function tabloCiz(bolum, baslik, not, ceyrek) {
    if (!bolum || !bolum.satirlar || !bolum.satirlar.length) return '';
    const bas = bolum.donemler.map(d =>
      `<th>${ceyrek ? esc(donemAd(d, true)) : yilBaslik(d)}</th>`).join('');

    let govde = '';
    for (const grup of ['gelir', 'bilanco', 'nakit']) {
      const satirlar = bolum.satirlar.filter(s => s.tablo === grup);
      if (!satirlar.length) continue;
      govde += `<tr class="pr-grup"><td colspan="${bolum.donemler.length + 1}">${esc(TABLO_AD[grup])}</td></tr>`;
      govde += satirlar.map(s => `<tr>
        <td class="pr-kalem" title="${esc(s.xbrl || '')}">${esc(s.ad)}</td>
        ${s.d.map(v => `<td class="${v != null && v < 0 ? 'pr-eksi' : ''}">${deger(v, s.birim)}</td>`).join('')}
      </tr>`).join('');
    }

    return `<div class="pv-blok">
      <div class="pv-blok-bas"><span class="pv-blok-t">${esc(baslik)}</span><span class="pv-blok-n">${esc(not || '')}</span></div>
      <div class="pv-sar">
        <table class="pv-tablo pr-tablo">
          <thead><tr><th>Kalem</th>${bas}</tr></thead>
          <tbody>${govde}</tbody>
        </table>
      </div>
    </div>`;
  }

  function kunyeCiz(k) {
    const satir = (etiket, d) => d ? `<div class="pr-k-row"><span class="pr-k-l">${esc(etiket)}</span><span class="pr-k-v">${esc(d)}</span></div>` : '';
    return `<div class="pr-kunye">
      <div class="pr-k-ust">
        <div class="pr-logo" id="prLogo"></div>
        <div class="pr-k-bas">
          <div class="pr-ad">${esc(k.ad)}</div>
          <div class="pr-alt">${esc(k.ticker)}${k.borsa ? ' · ' + esc(k.borsa) : ''}${k.sektor ? ' · ' + esc(k.sektor) : ''}</div>
        </div>
        <a class="pr-edgar" href="${esc(k.edgar)}" target="_blank" rel="noopener noreferrer">SEC DOSYALARI →</a>
      </div>
      <div class="pr-k-grid">
        ${satir('Sektör (SIC)', k.sektor ? `${k.sektor}${k.sicKod ? ' · ' + k.sicKod : ''}` : null)}
        ${satir('Borsa', k.borsa)}
        ${satir('Mali Yıl Sonu', k.mkSonu)}
        ${satir('Kuruluş Yeri', k.eyalet)}
        ${satir('CIK', k.cik)}
        ${satir('Telefon', k.telefon)}
        ${satir('Merkez', k.adres)}
        ${k.eskiAdlar && k.eskiAdlar.length ? satir('Eski Unvan', k.eskiAdlar.join(' · ')) : ''}
      </div>
    </div>`;
  }

  function ciz() {
    const kap = document.getElementById('prGovde');
    if (!kap || !durum.veri) return;
    const v = durum.veri;
    kap.innerHTML =
      kunyeCiz(v.kunye) +
      (v.uyari ? `<div class="pv-bos">${esc(v.uyari)}</div>` : '') +
      tabloCiz(v.yillik, 'Yıllık Finansallar', 'son 5 mali yıl · 10-K', false) +
      tabloCiz(v.ceyreklik, 'Çeyreklik Finansallar', 'son 6 çeyrek · 10-Q / 10-K', true) +
      `<div class="pv-alt">Kaynak: SEC EDGAR (resmî XBRL) · rakamlar şirketin raporladığı gibidir, düzeltme yapılmamıştır</div>`;

    // Künye logosu: /api/logo 404 dönerse baş harf avatarı kalır
    const lg = document.getElementById('prLogo');
    if (lg) {
      const tk = v.kunye.ticker;
      lg.textContent = tk.slice(0, 2);
      const img = new Image();
      img.onload = () => { lg.textContent = ''; lg.appendChild(img); img.style.cssText = 'width:100%;height:100%;object-fit:contain;padding:4px;'; };
      img.onerror = () => {};
      img.src = '/api/logo?ticker=' + encodeURIComponent(tk) + '&sz=128';
    }
  }

  async function yukle(ticker) {
    const kap = document.getElementById('prGovde');
    const durumEl = document.getElementById('prDurum');
    if (!kap || durum.yukleniyor) return;
    const tk = String(ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!tk) return;

    durum.yukleniyor = true;
    kap.innerHTML = '<div class="pv-bos">Şirket verisi SEC EDGAR\'dan alınıyor…</div>';
    if (durumEl) durumEl.textContent = tk;

    try {
      const r = await fetch('/api/profil?ticker=' + encodeURIComponent(tk));
      const j = await r.json();
      if (!r.ok || j.error) {
        kap.innerHTML = `<div class="pv-bos">${esc(j.error || 'Veri alınamadı')}${j.detay ? '<br><span style="opacity:.7">' + esc(j.detay) + '</span>' : ''}</div>`;
        if (durumEl) durumEl.textContent = '';
        return;
      }
      durum.ticker = tk;
      durum.veri = j;
      ciz();
      if (durumEl) {
        const saat = new Date(j.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        durumEl.textContent = `${tk} · ${saat}`;
      }
      const inp = document.getElementById('prTicker');
      if (inp) inp.value = tk;
    } catch (e) {
      kap.innerHTML = '<div class="pv-bos">Şirket verisi alınamadı. Birazdan tekrar dene.</div>';
      if (durumEl) durumEl.textContent = '';
    } finally {
      durum.yukleniyor = false;
    }
  }

  window.prAra = function () {
    const inp = document.getElementById('prTicker');
    if (inp) yukle(inp.value);
  };
  // Başka ekranlardan çağrılabilsin (takip listesi, analiz sonucu)
  window.prAc = function (ticker) {
    if (typeof window.showPage === 'function') window.showPage('profil');
    if (ticker) yukle(ticker);
  };
  window.prSayfaAc = function () {
    // Sayfa boşsa son bakılan hisseyi, o da yoksa örnek bir şirketi getir
    if (!durum.veri) yukle(durum.ticker || 'AAPL');
  };
})();
