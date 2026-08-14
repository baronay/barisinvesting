/* ═══════════════════════════════════════════════════════════════
   TERMİNAL DASHBOARD — ana ekran
   1) Kayan bant   — /api/market?type=market  (endeks/emtia/kripto)
   2) Rejim satırı — /api/market?type=regime  (S&P 200g + VIX)
   3) Isı haritası — heatmap.js (window.hmPanelCiz)
   4) Bilanço akışı— /api/market?type=bilanco (beklenti / gerçekleşen)
   5) Son dakika   — /api/market?type=news

   Analiz akışı bu sayfada YOK; kendi sekmesinde (page-analiz).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const TAZELE_MS = 120000;    // bant + rejim yenileme aralığı
  const AKIS_MS = 300000;      // bilanço + haber yenileme aralığı
  let _zamanlayici = null;
  let _akisZaman = 0;
  // Bölüm bazlı başarı durumu: ilk denemede düşen bir bölüm, kullanıcı
  // sekmeye geri geldiğinde yeniden denensin — yoksa sayfa yenilenene
  // kadar "alınamadı" yazısında takılı kalıyor.
  const yuklendi = { bilanco: false, haber: false, harita: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function yuzde(v, basamak) {
    if (v == null || !isFinite(v)) return '—';
    return `${v >= 0 ? '+' : ''}${v.toFixed(basamak == null ? 2 : basamak)}%`;
  }
  function sinif(v) { return v > 0 ? 'db-up' : v < 0 ? 'db-down' : 'db-flat'; }

  function sayiBicim(v, ondalik) {
    if (v == null || !isFinite(v)) return '—';
    return v.toLocaleString('tr-TR', { minimumFractionDigits: ondalik, maximumFractionDigits: ondalik });
  }

  /* ════════ 1. KAYAN BANT ════════ */
  const BANT = [
    { k: 'sp500', ad: 'S&P 500', ondalik: 0 },
    { k: 'nasdaq', ad: 'NASDAQ 100', ondalik: 0 },
    { k: 'bist100', ad: 'BİST 100', ondalik: 0 },
    { k: 'btc', ad: 'BTC', ondalik: 0, on: '$' },
    { k: 'eth', ad: 'ETH', ondalik: 0, on: '$' },
    { k: 'gold', ad: 'Altın', ondalik: 0, on: '$' },
    { k: 'oil', ad: 'Petrol', ondalik: 2, on: '$' },
  ];

  async function bantYukle() {
    const el = document.getElementById('dbTape');
    if (!el) return;
    try {
      const r = await fetch('/api/market?type=market');
      const j = await r.json();
      const m = (j && j.market) || {};
      const parcalar = BANT
        .filter(b => m[b.k] && m[b.k].price != null)
        .map(b => {
          const d = m[b.k];
          return `<span class="db-tape-i">
            <span class="db-tape-ad">${esc(b.ad)}</span>
            <span class="db-tape-fy">${b.on || ''}${sayiBicim(d.price, b.ondalik)}</span>
            <span class="db-tape-dg ${sinif(d.change)}">${yuzde(d.change)}</span>
          </span>`;
        });
      if (!parcalar.length) throw new Error('boş');
      // İçeriği iki kez basıyoruz: CSS animasyonu %50'de başa sarınca
      // kopukluk olmasın, bant kesintisiz aksın.
      const dizi = parcalar.join('');
      el.innerHTML = `<div class="db-tape-akis">${dizi}${dizi}</div>`;
    } catch (e) {
      el.innerHTML = '<div class="db-tape-bos">Piyasa verisi alınamadı.</div>';
    }
  }

  /* ════════ 2. REJİM SATIRI ════════ */
  async function rejimYukle() {
    const el = document.getElementById('dbRejim');
    if (!el) return;
    try {
      const r = await fetch('/api/market?type=regime');
      const j = await r.json();
      if (!j || j.error) throw new Error('yok');

      const rj = j.rejim || {};
      const fg = j.korkuAcgozluluk;
      const g = j.gostergeler || {};
      const rejimCls = rj.etiket === 'Boğa' ? 'db-up' : rj.etiket === 'Ayı' ? 'db-down' : 'db-flat';

      // Sıradaki makro olay
      let olay = '', kalanGun = null;
      if (j.takvim && j.takvim.length) {
        const e0 = j.takvim[0];
        kalanGun = Math.max(0, Math.ceil((new Date(e0.tarih + 'T12:00:00') - Date.now()) / 86400000));
        olay = `${e0.tur} · ${e0.ad}`;
      }

      const hucre = (etiket, deger, ek) =>
        `<div class="db-rj-h"><div class="db-rj-l">${etiket}</div><div class="db-rj-v">${deger}${ek || ''}</div></div>`;

      const gost = (q, birim, ondalik) => q && q.deger != null
        ? `${sayiBicim(q.deger, ondalik)}${birim} <span class="${sinif(q.degisim)}">${yuzde(q.degisim)}</span>`
        : '—';

      el.innerHTML =
        hucre('Rejim', `<span class="${rejimCls}">${esc(rj.etiket || '—')}</span>`, `<span class="db-rj-alt">${esc(rj.detay || '')}</span>`) +
        hucre('Korku / Açgözlülük', fg ? String(fg.deger) : '—', fg ? `<span class="db-rj-alt">${esc(fg.etiket)}</span>` : '') +
        hucre('VIX', gost(g.vix, '', 2)) +
        hucre('ABD 10Y', gost(g.us10y, '%', 2)) +
        hucre('DXY', gost(g.dxy, '', 1)) +
        (olay ? hucre(esc(olay), `<span class="db-warn">${kalanGun === 0 ? 'Bugün' : kalanGun + ' gün'}</span>`) : '');
    } catch (e) {
      el.innerHTML = '<div class="db-rj-h"><div class="db-rj-l">Piyasa rejimi</div><div class="db-rj-v db-flat">Veri alınamadı</div></div>';
    }
  }

  /* ════════ 4. BİLANÇO AKIŞI ════════ */
  const ZAMAN_AD = {
    'acilis-oncesi': 'açılış öncesi',
    'kapanis-sonrasi': 'kapanış sonrası',
    'gun-ici': 'gün içi',
  };

  function eps(v) {
    if (v == null || !isFinite(v)) return '—';
    return `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;
  }

  async function bilancoYukle() {
    const el = document.getElementById('dbBilanco');
    const durumEl = document.getElementById('dbBilancoDurum');
    if (!el) return;
    try {
      const r = await fetch('/api/market?type=bilanco');
      const j = await r.json();
      if (!j || j.error) throw new Error('yok');

      const liste = j.bilancolar || [];
      if (!liste.length) {
        el.innerHTML = '<div class="db-bos">Bugün büyük şirket bilançosu yok.</div>';
        if (durumEl) durumEl.textContent = '';
        // Takvim gerçekten boş olabilir (tatil) — bunu başarı say, sürekli
        // yeniden denemenin anlamı yok
        yuklendi.bilanco = true;
        return;
      }

      // Açıklananlar üstte — akışın haber değeri onlarda
      const sirali = liste.slice().sort((a, b) => {
        if (a.durum !== b.durum) return a.durum === 'geldi' ? -1 : 1;
        return (b.kap || 0) - (a.kap || 0);
      });

      el.innerHTML = sirali.map(b => {
        if (b.durum === 'geldi') {
          const yonCls = b.yon === 'asti' ? 'db-up' : b.yon === 'kaldi' ? 'db-down' : 'db-flat';
          const yonAd = b.yon === 'asti' ? 'beklentiyi aştı'
            : b.yon === 'kaldi' ? 'beklentinin altında' : 'beklentiyi tutturdu';
          return `<div class="db-bl db-bl-geldi" data-t="${esc(b.ticker)}" data-x="${esc(b.x || '')}">
            <div class="db-bl-ust">
              <span class="db-bl-logo"><img src="/api/logo?ticker=${encodeURIComponent(b.ticker)}&sz=64" alt="" loading="lazy" onerror="this.remove()"></span>
              <span class="db-bl-tk">${esc(b.ticker)}</span>
              <span class="db-bl-ad">${esc(b.ad)}</span>
              <span class="db-bl-rozet ${yonCls}">${b.surpriz != null ? yuzde(b.surpriz, 1) : 'geldi'}</span>
            </div>
            <div class="db-bl-alt">
              <span class="db-bl-eps">Gerçekleşen <b>${eps(b.gerceklesen)}</b></span>
              <span class="db-bl-ayrac">·</span>
              <span class="db-bl-eps">Beklenti ${eps(b.beklenti)}</span>
              <span class="db-bl-not ${yonCls}">${yonAd}</span>
            </div>
          </div>`;
        }
        return `<div class="db-bl" data-t="${esc(b.ticker)}" data-x="${esc(b.x || '')}">
          <div class="db-bl-ust">
            <span class="db-bl-logo"><img src="/api/logo?ticker=${encodeURIComponent(b.ticker)}&sz=64" alt="" loading="lazy" onerror="this.remove()"></span>
            <span class="db-bl-tk">${esc(b.ticker)}</span>
            <span class="db-bl-ad">${esc(b.ad)}</span>
            <span class="db-bl-rozet db-bekle">bekleniyor</span>
          </div>
          <div class="db-bl-alt">
            <span class="db-bl-eps">Beklenti ${eps(b.beklenti)}</span>
            <span class="db-bl-ayrac">·</span>
            <span class="db-bl-not">${esc(ZAMAN_AD[b.zaman] || '')}</span>
          </div>
        </div>`;
      }).join('');

      if (durumEl) {
        const uyari = j.gerceklesenAlinabildi ? '' : ' · sonuçlar alınamadı';
        durumEl.textContent = `${j.gelenSayisi}/${liste.length} açıklandı · bugün ${j.toplam} şirket${uyari}`;
      }
      yuklendi.bilanco = true;
    } catch (e) {
      yuklendi.bilanco = false;
      el.innerHTML = '<div class="db-bos">Bilanço verisi alınamadı.</div>';
      if (durumEl) durumEl.textContent = '';
    }
  }

  /* ════════ 5. SON DAKİKA ════════ */
  async function haberYukle() {
    const el = document.getElementById('dbHaber');
    const kaynakEl = document.getElementById('dbHaberKaynak');
    if (!el) return;
    try {
      const r = await fetch('/api/market?type=news');
      const j = await r.json();
      const haberler = (j && j.news) || [];
      if (!haberler.length) {
        el.innerHTML = '<div class="db-bos">Haber bulunamadı.</div>';
        yuklendi.haber = false;   // akış boşsa tekrar dene
        return;
      }
      if (kaynakEl && j.source) kaynakEl.textContent = j.source;
      el.innerHTML = haberler.slice(0, 7).map(n => {
        const t = n.providerPublishTime ? gecenSure(n.providerPublishTime * 1000) : '';
        return `<a class="db-hb" href="${esc(n.link || '#')}" target="_blank" rel="noopener noreferrer">
          <span class="db-hb-sa">${esc(t)}</span>
          <span class="db-hb-bs">${esc(n.title)}</span>
        </a>`;
      }).join('');
      yuklendi.haber = true;
    } catch (e) {
      yuklendi.haber = false;
      el.innerHTML = '<div class="db-bos">Haberler alınamadı.</div>';
    }
  }

  function gecenSure(ms) {
    const dk = Math.round((Date.now() - ms) / 60000);
    if (dk < 1) return 'şimdi';
    if (dk < 60) return dk + 'dk';
    const sa = Math.round(dk / 60);
    if (sa < 24) return sa + 'sa';
    return Math.round(sa / 24) + 'g';
  }

  /* ════════ BİLANÇO SATIRI → ANALİZ ════════ */
  function tiklamalariKur() {
    const bl = document.getElementById('dbBilanco');
    if (bl) bl.addEventListener('click', e => {
      const satir = e.target.closest('[data-t]');
      if (!satir) return;
      const tk = satir.dataset.t;
      if (typeof window.qFill === 'function') {
        // Borsa evren tablosundan geliyor; bilinmiyorsa NASDAQ varsayılıyor
        window.qFill(tk, '', satir.dataset.x || 'NASDAQ');
        if (typeof window.showPage === 'function') window.showPage('analiz');
        window.scrollTo(0, 0);
      }
    });
  }

  /* ════════ YÜKLEME ════════ */
  // Dashboard görünür değilken tazelemeye gerek yok — sekme geçişinde
  // showPage tetikliyor, arka planda boşuna istek atmayalım.
  function gorunurMu() {
    const s = document.getElementById('page-overview');
    return !!s && s.classList.contains('active');
  }

  function yukle(zorla) {
    if (!document.getElementById('dbTape')) return;
    bantYukle();
    rejimYukle();

    const akisEskidi = (Date.now() - _akisZaman) > AKIS_MS;
    if (zorla || akisEskidi || !yuklendi.bilanco) { _akisZaman = Date.now(); bilancoYukle(); }
    if (zorla || akisEskidi || !yuklendi.haber) haberYukle();
    if ((zorla || !yuklendi.harita) && typeof window.hmPanelCiz === 'function') {
      yuklendi.harita = true;   // hmPanelCiz kendi hata durumunu gösteriyor
      window.hmPanelCiz('dbHarita', 'dbHaritaDurum');
    }
  }

  function zamanlayiciKur() {
    clearInterval(_zamanlayici);
    _zamanlayici = setInterval(() => {
      if (!gorunurMu() || document.hidden) return;
      yukle();
    }, TAZELE_MS);
  }

  window.dbYukle = yukle;

  function baslat() {
    if (!document.getElementById('dbTape')) return;
    tiklamalariKur();
    zamanlayiciKur();
    yukle();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', baslat);
  else baslat();
})();
