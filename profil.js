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
      govde += satirlar.map(s => `<tr class="pr-satir" data-kalem="${esc(s.ad)}" data-tur="${ceyrek ? 'ceyrek' : 'yil'}" title="${esc(s.ad)} — dönemsel grafiği aç">
        <td class="pr-kalem">${esc(s.ad)}<span class="pr-grafik-ik">▊</span></td>
        ${s.d.map((v, i) => {
          const dg = degisimHtml(degisim(v, s.d[i + 1]));
          return `<td class="${v != null && v < 0 ? 'pr-eksi' : ''}">
            <span class="pr-v">${deger(v, s.birim)}</span>${dg}</td>`;
        }).join('')}
      </tr>`).join('');
    }

    return `<div class="pv-blok">
      <div class="pv-blok-bas">
        <span class="pv-blok-t">${esc(baslik)}</span>
        <span class="pv-blok-n">${esc(not || '')}</span>
        <span class="pr-tablo-ipucu"><b>▊</b> kaleme tıkla → dönemsel grafik</span>
      </div>
      <div class="pv-sar">
        <table class="pv-tablo pr-tablo">
          <thead><tr><th>Kalem</th>${bas}</tr></thead>
          <tbody>${govde}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* ═══ DÖNEMSEL GRAFİK ═══════════════════════════════════════
     Tablodaki bir kalem tıklanınca o kalemin dönem dönem seyri.
     Tabloda rakamlar var ama eğilim görünmüyor; grafik onu veriyor.
     Kütüphane yok — saf SVG, projenin sıfır-build yapısına uysun. */
  const GRF = { kalem: null, tur: 'ceyrek' };

  // Grafik etiketleri dar: "391,0 Mlr" yerine "391 Mlr" yeterli
  function kisaDeger(v, birim) {
    if (v == null || !isFinite(v)) return '—';
    if (birim === 'USD/hisse') return hisseBasi(v);
    const isaret = v < 0 ? '-' : '';
    const m = Math.abs(v);
    const bic = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toLocaleString('tr-TR');
    if (m >= 1e12) return `${isaret}${bic(m / 1e12)} Tn`;
    if (m >= 1e9) return `${isaret}${bic(m / 1e9)} Mlr`;
    if (m >= 1e6) return `${isaret}${bic(m / 1e6)} Mn`;
    if (m >= 1e3) return `${isaret}${bic(m / 1e3)} B`;
    return `${isaret}${Math.round(m)}`;
  }

  // Kalemi hangi bölümlerde bulabiliyoruz — yıllık/çeyreklik geçişi
  // yalnızca ikisinde de varsa gösteriliyor
  function seriBul(kalem, tur) {
    const v = durum.veri;
    const bolum = tur === 'yil' ? (v && v.yillik) : (v && v.ceyreklik);
    if (!bolum || !bolum.satirlar) return null;
    const satir = bolum.satirlar.find(s => s.ad === kalem);
    if (!satir) return null;
    // Dönemler yeniden eskiye geliyor; grafik soldan sağa eskiden yeniye
    const noktalar = bolum.donemler.map((d, i) => ({ d, v: satir.d[i] })).reverse();
    return { satir, noktalar };
  }

  function grafikCiz() {
    const kap = document.getElementById('prGrafikGovde');
    if (!kap) return;
    const seri = seriBul(GRF.kalem, GRF.tur);
    if (!seri || !seri.noktalar.some(n => n.v != null)) {
      kap.innerHTML = '<div class="pv-bos">Bu kalem için veri yok.</div>';
      return;
    }
    const nk = seri.noktalar;
    const birim = seri.satir.birim;
    const ceyrek = GRF.tur === 'ceyrek';

    // viewBox genişliği sabit, yükseklik ekrana göre: oran korunduğu için
    // dar ekranda 900×300'lük kutu 100 piksellik ezik bir şerit oluyor.
    const dar = window.innerWidth < 700;
    const G = 900, Y = dar ? 560 : 300;
    const ustBosluk = dar ? 48 : 26, altBosluk = dar ? 64 : 34;
    const degerler = nk.map(n => (n.v == null || !isFinite(n.v)) ? null : n.v);
    const enB = Math.max(0, ...degerler.filter(v => v != null));
    const enK = Math.min(0, ...degerler.filter(v => v != null));
    const aralik = (enB - enK) || 1;
    const alan = Y - ustBosluk - altBosluk;
    const sifirY = ustBosluk + (enB / aralik) * alan;     // sıfır çizgisi
    const adim = G / nk.length;
    const kalinlik = Math.max(6, Math.min(46, adim * 0.56));

    const cubuklar = nk.map((n, i) => {
      const orta = adim * i + adim / 2;
      if (n.v == null || !isFinite(n.v)) {
        return `<text class="pr-gr-bos" x="${orta}" y="${sifirY - 6}" text-anchor="middle">—</text>`;
      }
      const yuk = Math.abs(n.v) / aralik * alan;
      const y = n.v >= 0 ? sifirY - yuk : sifirY;
      const artı = n.v >= 0;
      // Etiket sıfırın hangi tarafındaysa oraya: negatif çubuğun altına
      const etY = artı ? y - (dar ? 12 : 7) : y + yuk + (dar ? 24 : 13);
      return `<rect class="pr-gr-cubuk ${artı ? 'pos' : 'neg'}" x="${orta - kalinlik / 2}" y="${y}" width="${kalinlik}" height="${Math.max(1, yuk)}" rx="2"></rect>
        <text class="pr-gr-deger" x="${orta}" y="${etY}" text-anchor="middle">${esc(kisaDeger(n.v, birim))}</text>`;
    }).join('');

    // Dar ekranda her dönemi yazmak okunmaz oluyor — birini atla
    const atla = nk.length > 12 ? 2 : 1;
    const etiketler = nk.map((n, i) => (i % atla) ? '' :
      `<text class="pr-gr-donem" x="${adim * i + adim / 2}" y="${Y - (dar ? 20 : 12)}" text-anchor="middle">${esc(donemAd(n.d, ceyrek))}</text>`).join('');

    const v = durum.veri;
    const ikisiVar = !!(v && v.yillik && v.ceyreklik
      && v.yillik.satirlar.some(s => s.ad === GRF.kalem)
      && v.ceyreklik.satirlar.some(s => s.ad === GRF.kalem));
    const sekme = ikisiVar ? `<div class="pv-sek-grp pr-gr-sek">
        <button class="pv-sek${GRF.tur === 'ceyrek' ? ' active' : ''}" data-gtur="ceyrek">Çeyreklik</button>
        <button class="pv-sek${GRF.tur === 'yil' ? ' active' : ''}" data-gtur="yil">Yıllık</button>
      </div>` : '';

    const son = nk[nk.length - 1];
    kap.innerHTML = `
      <div class="pr-gr-ust">
        <div class="pr-gr-baslik">
          <span class="pr-gr-ad">${esc(GRF.kalem)}</span>
          <span class="pr-gr-son">${esc(deger(son.v, birim))}<span class="pr-gr-son-d">${esc(donemAd(son.d, ceyrek))}</span></span>
        </div>
        ${sekme}
      </div>
      <div class="pr-gr-alan">
        <svg viewBox="0 0 ${G} ${Y}" class="pr-gr-svg">
          <line class="pr-gr-sifir" x1="0" y1="${sifirY}" x2="${G}" y2="${sifirY}"></line>
          ${cubuklar}${etiketler}
        </svg>
      </div>
      <div class="pr-gr-not">${birim === 'USD/hisse' ? 'Hisse başına, USD' : 'Değerler USD cinsindendir'}</div>`;
  }

  function grafikAc(kalem, tur) {
    if (!durum.veri) return;
    GRF.kalem = kalem;
    GRF.tur = seriBul(kalem, tur) ? tur : (tur === 'ceyrek' ? 'yil' : 'ceyrek');
    const ov = document.getElementById('prGrafik');
    if (!ov) return;
    ov.classList.add('acik');
    document.body.classList.add('pr-kilit');   // arkadaki sayfa kaymasın
    grafikCiz();
  }
  function grafikKapat() {
    const ov = document.getElementById('prGrafik');
    if (ov) ov.classList.remove('acik');
    document.body.classList.remove('pr-kilit');
  }
  window.prGrafikKapat = grafikKapat;

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
    if (b) { durum.sekme = b.dataset.sekme; ciz(); return; }

    // Tablo satırı → dönemsel grafik
    const satir = e.target.closest('#prGovde tr.pr-satir');
    if (satir) { grafikAc(satir.dataset.kalem, satir.dataset.tur); return; }

    // Grafik penceresinde yıllık/çeyreklik geçişi
    const gt = e.target.closest('#prGrafik [data-gtur]');
    if (gt) { GRF.tur = gt.dataset.gtur; grafikCiz(); return; }

    // Boşluğa tıklayınca kapat (kartın kendisi hariç)
    const ov = document.getElementById('prGrafik');
    if (ov && ov.classList.contains('acik') && e.target === ov) grafikKapat();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') grafikKapat();
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
