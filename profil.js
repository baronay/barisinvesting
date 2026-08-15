/* ═══════════════════════════════════════════════════════════════
   ŞİRKET PROFİLİ — künye + finansal tablolar
   Veri: /api/profil?ticker=…  (SEC EDGAR)

   Şimdilik yalnızca ABD hisseleri: SEC verisi resmî ve ücretsiz,
   BİST tarafında aynı kalitede kaynak yok.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // istenen: şu an ağdan gelen ticker · bekleyen: yükleme sürerken gelen
  // yeni istek. Kuyruk olmadığında dışarıdan gelen ikinci istek (arama
  // kutusu → showPage → prSayfaAc yarışı) sessizce düşüyor, ekranda bir
  // önceki şirket kalıyordu.
  const durum = { ticker: null, istenen: null, bekleyen: null, veri: null, yukleniyor: false, sekme: 'ozet' };

  // Künyedeki borsa metnini analiz ekranının beklediği üç değere indir
  function borsaKodu(borsa) {
    const b = String(borsa || '').toUpperCase();
    if (b.includes('BIST') || b.includes('BİST')) return 'BIST';
    if (b.includes('NYSE')) return 'NYSE';
    return 'NASDAQ';
  }

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
    if (m >= 1e9) return `${isaret}$${bic(m / 1e9, 1)} Mlr`;
    if (m >= 1e6) return `${isaret}$${bic(m / 1e6, 1)} Mn`;
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

  /* Bir önceki döneme göre değişim. Dönemler yeniden eskiye sıralı, yani
     karşılaştırma bir sağdaki sütunla yapılıyor. İşaret değiştiren
     kalemlerde (zarardan kâra geçiş gibi) yüzde anlamsız olduğu için
     boş bırakıyoruz. */
  function degisim(simdi, once) {
    if (simdi == null || once == null || !isFinite(simdi) || !isFinite(once)) return null;
    if (once === 0) return null;
    if ((simdi < 0) !== (once < 0)) return null;
    return (simdi - once) / Math.abs(once) * 100;
  }

  function degisimHtml(v) {
    if (v == null) return '';
    const sinif = v > 0.05 ? 'pos' : v < -0.05 ? 'neg' : 'neu';
    const ok = v > 0.05 ? '▲' : v < -0.05 ? '▼' : '—';
    const say = Math.abs(v) >= 1000 ? Math.round(v) : v.toFixed(1);
    return `<span class="pr-dg ${sinif}">${ok} ${v > 0 ? '+' : v < 0 ? '-' : ''}${String(say).replace('-', '').replace('.', ',')}%</span>`;
  }

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
        <td class="pr-kalem">${esc(s.ad)}</td>
        ${s.d.map((v, i) => {
          const dg = degisimHtml(degisim(v, s.d[i + 1]));
          return `<td class="${v != null && v < 0 ? 'pr-eksi' : ''}">
            <span class="pr-v">${deger(v, s.birim)}</span>${dg}</td>`;
        }).join('')}
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
        <button class="pr-edgar" onclick="prAnaliz('${esc(k.ticker)}','${esc(borsaKodu(k.borsa))}')">ANALİZ ET →</button>
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

  function gecenSure(ms) {
    if (!ms) return '';
    const dk = Math.round((Date.now() - ms) / 60000);
    if (dk < 1) return 'şimdi';
    if (dk < 60) return dk + ' dk';
    const sa = Math.round(dk / 60);
    if (sa < 24) return sa + ' sa';
    const g = Math.round(sa / 24);
    return g < 30 ? g + ' gün' : Math.round(g / 30) + ' ay';
  }

  function ozetCiz(v) {
    let h = '';
    if (v.ozet && v.ozet.metin) {
      h += `<div class="pr-ozet"><div class="pr-ozet-t">Şirket Hakkında</div><p>${esc(v.ozet.metin)}</p></div>`;
    }
    const hb = v.haberler || [];
    if (hb.length) {
      h += `<div class="pv-blok">
        <div class="pv-blok-bas"><span class="pv-blok-t">Son Haberler</span></div>
        <div class="pr-haber">${hb.map(n => `
          <a class="pr-hb" ${n.link ? `href="${esc(n.link)}" target="_blank" rel="noopener noreferrer"` : ''}>
            <span class="pr-hb-bs">${esc(n.baslik)}</span>
            <span class="pr-hb-alt">${n.kaynak ? esc(n.kaynak) : ''}${n.tarih ? (n.kaynak ? ' · ' : '') + esc(gecenSure(n.tarih)) : ''}</span>
          </a>`).join('')}</div>
      </div>`;
    }
    if (!h) h = '<div class="pv-bos">Bu şirket için özet ve haber bulunamadı.</div>';
    return h;
  }

  function sekmeCiz(v) {
    const s = (k, ad) => `<button class="pv-sek${durum.sekme === k ? ' active' : ''}" data-sekme="${k}">${ad}</button>`;
    return `<div class="pv-sekmeler"><div class="pv-sek-grp">${s('ozet', 'Özet')}${s('finansal', 'Finansallar')}</div></div>`;
  }

  function ciz() {
    const kap = document.getElementById('prGovde');
    if (!kap || !durum.veri) return;
    const v = durum.veri;
    const finansalVar = !!(v.yillik || v.ceyreklik);
    if (durum.sekme === 'finansal' && !finansalVar) durum.sekme = 'ozet';

    const icerik = durum.sekme === 'finansal'
      ? ((v.uyari ? `<div class="pv-bos">${esc(v.uyari)}</div>` : '') +
         tabloCiz(v.yillik, 'Yıllık Finansallar', 'son 5 mali yıl · bir önceki yıla göre değişim', false) +
         tabloCiz(v.ceyreklik, 'Çeyreklik Finansallar', 'son çeyrekler · bir önceki çeyreğe göre değişim', true))
      : (ozetCiz(v) + (!finansalVar && v.uyari ? `<div class="pv-bos">${esc(v.uyari)}</div>` : ''));

    kap.innerHTML = kunyeCiz(v.kunye) + sekmeCiz(v) + icerik;

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
    if (!kap) return;
    const tk = String(ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (!tk) return;

    // Yükleme sürerken gelen istek düşmesin: aynı hisseyse yok say,
    // farklıysa sıraya al — biten istekten sonra o çalışır.
    if (durum.yukleniyor) {
      durum.bekleyen = (tk === durum.istenen) ? null : tk;
      return;
    }

    durum.istenen = tk;
    durum.yukleniyor = true;
    kap.innerHTML = '<div class="pv-bos">Şirket verisi hazırlanıyor…</div>';
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
      durum.sekme = 'ozet';   // yeni şirkette hep özetle başla
      ciz();
      // Arama kutusu boşken "son bakılanlar" olarak çıksın
      if (typeof window.aramaSonEkle === 'function') {
        window.aramaSonEkle(tk, (j.kunye && j.kunye.ad) || tk, borsaKodu(j.kunye && j.kunye.borsa));
      }
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
      const bekleyen = durum.bekleyen;
      durum.bekleyen = null;
      if (bekleyen && bekleyen !== tk) yukle(bekleyen);
    }
  }

  // Sekme tıklaması — içerik her çizimde yeniden basıldığı için delege
  document.addEventListener('click', e => {
    const b = e.target.closest('#prGovde [data-sekme]');
    if (!b) return;
    durum.sekme = b.dataset.sekme;
    ciz();
  });

  window.prAra = function () {
    const inp = document.getElementById('prTicker');
    if (inp) yukle(inp.value);
  };
  window.prAnaliz = function (ticker, borsa) {
    if (typeof window.qFill === 'function') {
      window.qFill(ticker, '', borsaKodu(borsa || (durum.veri && durum.veri.kunye && durum.veri.kunye.borsa)));
      if (typeof window.showPage === 'function') window.showPage('analiz');
      window.scrollTo(0, 0);
    }
  };
  // Başka ekranlardan çağrılabilsin (ısı haritası, takip listesi, arama kutusu)
  window.prAc = function (ticker) {
    // Sıra önemli: showPage → prSayfaAc zinciri "sayfa boşsa varsayılanı
    // getir" diyor. İstenen hisseyi önce yazmazsak AAPL yüklenip
    // asıl istek kuyruğa düşüyor.
    const tk = String(ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
    if (tk) durum.ticker = tk;
    if (typeof window.showPage === 'function') window.showPage('profil');
    if (tk) yukle(tk);
    window.scrollTo(0, 0);
  };
  window.prSayfaAc = function () {
    // Sayfa boşsa son bakılan hisseyi, o da yoksa örnek bir şirketi getir.
    // Bir yükleme sürüyorsa karışma — prAc zaten doğru hisseyi istedi.
    if (durum.yukleniyor || durum.veri) return;
    yukle(durum.ticker || 'AAPL');
  };
})();
