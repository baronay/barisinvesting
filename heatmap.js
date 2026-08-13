/* ═══════════════════════════════════════════════════════════════
   ISI HARİTASI — sektör/hisse treemap'i
   Veri: /api/market?type=heatmap&scope=us|bist&period=1g…1y
   Kutu alanı = piyasa değeri, renk = dönem değişimi.

   İki kademeli squarified treemap: önce sektörler, sonra her
   sektörün içinde hisseler. Kütüphane yok — mevcut sıfır-build
   yapısına uysun diye saf DOM.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const UC = '/api/market?type=heatmap';
  const DONEMLER = [
    { k: '1g', ad: '1 Gün' }, { k: '1h', ad: '1 Hafta' }, { k: '1a', ad: '1 Ay' },
    { k: '3a', ad: '3 Ay' }, { k: '6a', ad: '6 Ay' }, { k: '1y', ad: '1 Yıl' },
  ];
  const KAPSAMLAR = [
    { k: 'us', ad: 'ABD', bayrak: '#f-us' },
    { k: 'bist', ad: 'BİST', bayrak: '#f-tr' },
  ];

  const durum = { kapsam: 'us', donem: '1g', veri: null, yukleniyor: false };
  const onbellek = new Map();   // "kapsam|dönem" → { veri, ts }
  const ONBELLEK_MS = 120000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ── Renk skalası ───────────────────────────────────────────────
     ±%3 uçlarda doyuma ulaşır. Küçük değişimler de seçilebilsin
     diye üsse (0.7) bindiriliyor — lineer skalada %0.4'lük hareket
     nötrden ayırt edilemiyor. */
  function renk(d) {
    const t = Math.max(-1, Math.min(1, (d || 0) / 3));
    const k = Math.pow(Math.abs(t), 0.7);
    const notr = [38, 44, 56];
    const hedef = t >= 0 ? [22, 152, 82] : [188, 52, 52];
    const c = notr.map((n, i) => Math.round(n + (hedef[i] - n) * k));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  function yuzde(d) {
    if (d == null || !isFinite(d)) return '—';
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
  }

  function buyukSayi(v, birim) {
    if (v == null || !isFinite(v)) return '—';
    const s = birim === 'TRY' ? '₺' : '$';
    const a = Math.abs(v);
    if (a >= 1e12) return `${s}${(v / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `${s}${(v / 1e9).toFixed(1)}Mr`;
    if (a >= 1e6) return `${s}${(v / 1e6).toFixed(0)}M`;
    return `${s}${v.toFixed(0)}`;
  }

  /* ── Squarified treemap ─────────────────────────────────────────
     Bruls, Huizing & van Wijk (2000). Kutuları kareye yakın tutar;
     şeritleme (slice-and-dice) yerine bu, çünkü ince uzun kutularda
     ne sembol ne yüzde sığıyor. */
  function squarify(kalemler, x, y, w, h) {
    const sonuc = [];
    const liste = kalemler.filter(i => i.v > 0).slice().sort((a, b) => b.v - a.v);
    if (!liste.length || w <= 0 || h <= 0) return sonuc;

    const toplam = liste.reduce((a, i) => a + i.v, 0);
    const olcek = (w * h) / toplam;
    const kutu = liste.map(i => ({ kalem: i, alan: i.v * olcek }));

    let i = 0;
    while (i < kutu.length) {
      const yatay = w >= h;             // şerit kısa kenar boyunca dizilir
      const kisa = yatay ? h : w;
      let satir = [kutu[i]];
      let satirAlan = kutu[i].alan;
      let enIyi = enBoyOrani(satir, satirAlan, kisa);

      // Şeride kalem eklemeye devam et — en/boy oranı bozulana kadar
      let j = i + 1;
      while (j < kutu.length) {
        const denemeAlan = satirAlan + kutu[j].alan;
        const deneme = enBoyOrani(satir.concat([kutu[j]]), denemeAlan, kisa);
        if (deneme > enIyi) break;
        satir.push(kutu[j]);
        satirAlan = denemeAlan;
        enIyi = deneme;
        j++;
      }

      // Şeridi yerleştir
      const kalinlik = satirAlan / kisa;
      let kayma = 0;
      for (const b of satir) {
        const uzunluk = b.alan / kalinlik;
        if (yatay) {
          sonuc.push({ kalem: b.kalem, x: x, y: y + kayma, w: kalinlik, h: uzunluk });
        } else {
          sonuc.push({ kalem: b.kalem, x: x + kayma, y: y, w: uzunluk, h: kalinlik });
        }
        kayma += uzunluk;
      }
      if (yatay) { x += kalinlik; w -= kalinlik; } else { y += kalinlik; h -= kalinlik; }
      i = j;
    }
    return sonuc;
  }

  function enBoyOrani(satir, alan, kisa) {
    const kalinlik = alan / kisa;
    let enKotu = 1;
    for (const b of satir) {
      const uzunluk = b.alan / kalinlik;
      if (uzunluk <= 0 || kalinlik <= 0) return Infinity;
      enKotu = Math.max(enKotu, kalinlik / uzunluk, uzunluk / kalinlik);
    }
    return enKotu;
  }

  /* ── Çizim ──────────────────────────────────────────────────── */
  const BASLIK_Y = 17;   // sektör başlık şeridi yüksekliği
  const BOSLUK = 2;      // sektör kutuları arası

  /* Dar ekranda hisse sayısını kırp. 166 kutu 350px'e sığdığında kutuların
     üçte ikisi etiketsiz kalıyor — okunmayan kutu bilgi taşımıyor. Sektör
     yüzdesi SUNUCUDAN geldiği gibi bırakılıyor (tüm hisselerin gerçek
     ortalaması); sadece hangi kutuların çizildiği kısılıyor. */
  function kirp(veri, sinir) {
    const tum = [];
    veri.sektorler.forEach(s => s.hisseler.forEach(h => tum.push(h)));
    if (tum.length <= sinir) return veri;
    const esik = tum.slice().sort((a, b) => b.v - a.v)[sinir - 1].v;
    const sektorler = veri.sektorler
      .map(s => {
        const hisseler = s.hisseler.filter(h => h.v >= esik);
        return { ad: s.ad, d: s.d, v: hisseler.reduce((a, h) => a + h.v, 0), hisseler };
      })
      .filter(s => s.hisseler.length);
    return Object.assign({}, veri, { sektorler, kirpildi: sinir });
  }

  function ciz(kap, veri, secenek) {
    const opt = secenek || {};
    const w = kap.clientWidth;
    const h = opt.yukseklik || kap.clientHeight;
    if (!w || !h) return;

    // Kutu başına ~3550px² hedefi: bu eşiğin altında sembol etiketi
    // sığmıyor. Sabit kırılma noktası yerine alana bağlamak, 1280 ile
    // 1440 arasında hisse sayısının zıplamasını önlüyor.
    veri = kirp(veri, Math.max(40, Math.round(w * h / 3550)));

    kap.innerHTML = '';
    kap.style.height = h + 'px';

    const sektorler = veri.sektorler.map(s => ({ v: s.v, s }));
    const yerlesim = squarify(sektorler, 0, 0, w, h);

    const parca = document.createDocumentFragment();
    let cizilen = 0;

    for (const yer of yerlesim) {
      const s = yer.kalem.s;
      const sx = yer.x + BOSLUK / 2, sy = yer.y + BOSLUK / 2;
      const sw = Math.max(0, yer.w - BOSLUK), sh = Math.max(0, yer.h - BOSLUK);
      if (sw < 6 || sh < 6) continue;

      const kutu = document.createElement('div');
      kutu.className = 'hm-sek';
      kutu.style.cssText = `left:${sx}px;top:${sy}px;width:${sw}px;height:${sh}px`;

      // Başlık — dar sektörlerde yüzdeyi düşür, çok darda başlığı tamamen at
      const baslikVar = sh >= 44 && sw >= 46;
      if (baslikVar) {
        const bas = document.createElement('div');
        bas.className = 'hm-sek-bas';
        bas.dataset.sektor = s.ad;
        bas.title = `${s.ad} — sektör detayına git`;
        const isim = sw >= 120 ? esc(s.ad) : esc(s.ad).slice(0, 9);
        bas.innerHTML = sw >= 92
          ? `<span class="hm-sek-ad">${isim}</span><span class="hm-sek-d" style="color:${s.d >= 0 ? 'var(--success)' : 'var(--danger)'}">${yuzde(s.d)}</span>`
          : `<span class="hm-sek-ad">${isim}</span>`;
        kutu.appendChild(bas);
      }

      // Hisseler
      const icY = baslikVar ? BASLIK_Y : 0;
      const icH = sh - icY;
      const hisseler = s.hisseler.map(x => ({ v: x.v, x }));
      for (const hy of squarify(hisseler, 0, icY, sw, icH)) {
        const d = hy.kalem.x;
        if (hy.w < 3 || hy.h < 3) continue;
        const el = document.createElement('div');
        el.className = 'hm-kutu';
        el.style.cssText = `left:${hy.x}px;top:${hy.y}px;width:${Math.max(0, hy.w - 1)}px;height:${Math.max(0, hy.h - 1)}px;background:${renk(d.d)}`;
        el.dataset.t = d.t;
        el.dataset.n = d.n;
        el.dataset.d = d.d;
        el.dataset.f = d.f;
        el.dataset.v = d.v;
        if (d.x) el.dataset.x = d.x;

        // Etiket kademeleri — sığmayan yazı hiç basılmaz, kırpılmış metin
        // kutuyu okunmaz hale getiriyor. Punto sembol UZUNLUĞUNA göre
        // hesaplanıyor: 5 harfli BIST kodu (THYAO) 4 harfliden (AAPL)
        // daha geniş kutu ister, sabit eşik BIST'te etiketleri yiyor.
        const enPuntoW = hy.w / (d.t.length * 0.66 + 0.7);  // mono ≈ 0.6em/karakter
        const enPuntoH = hy.h / 2.4;
        const punto = Math.floor(Math.min(enPuntoW, enPuntoH, 17));
        if (punto >= 7) {
          const sembol = document.createElement('div');
          sembol.className = 'hm-tk';
          sembol.style.fontSize = punto + 'px';
          sembol.textContent = d.t;
          el.appendChild(sembol);
          // Yüzde ancak sembolün altına rahat sığıyorsa
          if (hy.h >= punto * 2.3 + 6 && hy.w >= 44) {
            const dg = document.createElement('div');
            dg.className = 'hm-d';
            dg.style.fontSize = Math.max(7, Math.min(12, Math.floor(Math.min(hy.w / 6.4, punto * 0.78)))) + 'px';
            dg.textContent = yuzde(d.d);
            el.appendChild(dg);
          }
        }
        kutu.appendChild(el);
        cizilen++;
      }
      parca.appendChild(kutu);
    }
    kap.appendChild(parca);
    return cizilen;
  }

  /* ── İpucu balonu ───────────────────────────────────────────── */
  let ipucu = null;
  // Harita birden fazla yerde çiziliyor (tam sayfa + dashboard paneli).
  // Hangi konteynere dinleyici bağlandığını tut — her çizimde yeniden
  // bağlanırsa dinleyiciler üst üste birikiyor.
  const ipuculuKaplar = new WeakSet();
  // Para birimi kapsam değiştikçe değişiyor; dinleyici güncel değeri
  // buradan okuyor.
  let ipucuParaBirimi = 'USD';

  function ipucuKur(kap, paraBirimi) {
    if (paraBirimi) ipucuParaBirimi = paraBirimi;
    if (!kap || ipuculuKaplar.has(kap)) return;
    ipuculuKaplar.add(kap);
    if (!ipucu) {
      ipucu = document.createElement('div');
      ipucu.className = 'hm-ipucu';
      document.body.appendChild(ipucu);
    }
    kap.addEventListener('mousemove', e => {
      const el = e.target.closest('.hm-kutu');
      if (!el) { ipucu.style.display = 'none'; return; }
      const d = parseFloat(el.dataset.d);
      ipucu.innerHTML =
        `<div class="hm-ip-tk">${esc(el.dataset.t)}<span style="color:${d >= 0 ? 'var(--success)' : 'var(--danger)'}">${yuzde(d)}</span></div>` +
        `<div class="hm-ip-ad">${esc(el.dataset.n)}</div>` +
        `<div class="hm-ip-alt">Fiyat ${ipucuParaBirimi === 'TRY' ? '₺' : '$'}${esc(el.dataset.f)} · Değer ${buyukSayi(parseFloat(el.dataset.v), ipucuParaBirimi)}</div>`;
      ipucu.style.display = 'block';
      // Ekran kenarına taşmasın
      const g = 14, gen = 200;
      let x = e.clientX + g;
      if (x + gen > window.innerWidth) x = e.clientX - gen - g;
      ipucu.style.left = x + 'px';
      ipucu.style.top = Math.min(e.clientY + g, window.innerHeight - 90) + 'px';
    });
    kap.addEventListener('mouseleave', () => { if (ipucu) ipucu.style.display = 'none'; });
  }

  /* ── Veri ───────────────────────────────────────────────────── */
  async function getir(kapsam, donem) {
    const anahtar = `${kapsam}|${donem}`;
    const onbl = onbellek.get(anahtar);
    if (onbl && (Date.now() - onbl.ts) < ONBELLEK_MS) return onbl.veri;
    const r = await fetch(`${UC}&scope=${encodeURIComponent(kapsam)}&period=${encodeURIComponent(donem)}`);
    const j = await r.json();
    if (!j || j.error) throw new Error((j && j.error) || 'Veri yok');
    onbellek.set(anahtar, { veri: j, ts: Date.now() });
    return j;
  }

  /* ── Tam sayfa ──────────────────────────────────────────────── */
  function yukseklikHesapla() {
    const g = window.innerWidth;
    if (g < 600) return 460;
    if (g < 1000) return 540;
    return Math.max(520, Math.min(720, Math.round(window.innerHeight * 0.66)));
  }

  function kontrolleriCiz() {
    const dEl = document.getElementById('hmDonemler');
    if (dEl) {
      dEl.innerHTML = DONEMLER.map(d =>
        `<button class="hm-tab${d.k === durum.donem ? ' active' : ''}" data-donem="${d.k}">${d.ad}</button>`).join('');
    }
    const kEl = document.getElementById('hmKapsamlar');
    if (kEl) {
      kEl.innerHTML = KAPSAMLAR.map(k =>
        `<button class="hm-tab hm-tab-k${k.k === durum.kapsam ? ' active' : ''}" data-kapsam="${k.k}"><svg class="chip-f" style="width:14px;height:9px"><use href="${k.bayrak}"/></svg>${k.ad}</button>`).join('');
    }
  }

  async function sayfaYukle() {
    const kap = document.getElementById('hmHarita');
    if (!kap) return;
    if (durum.yukleniyor) return;
    durum.yukleniyor = true;
    kontrolleriCiz();

    const durumEl = document.getElementById('hmDurum');
    if (!durum.veri) {
      kap.innerHTML = '<div class="hm-yukleniyor">Isı haritası hazırlanıyor…</div>';
      kap.style.height = yukseklikHesapla() + 'px';
    }
    if (durumEl) durumEl.textContent = 'yükleniyor…';

    try {
      const veri = await getir(durum.kapsam, durum.donem);
      durum.veri = veri;
      const cizilen = ciz(kap, veri, { yukseklik: yukseklikHesapla() });
      ipucuKur(kap, veri.paraBirimi);
      ozetCiz(veri);
      if (durumEl) {
        const saat = new Date(veri.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        const adet = (cizilen && cizilen < veri.hisseSayisi)
          ? `en büyük ${cizilen} hisse` : `${veri.hisseSayisi} hisse`;
        durumEl.textContent = `${adet} · ${veri.donemAd} · ${saat}`;
      }
      // Tam sayfada kapsam/dönem değişince dashboard paneli de tazelensin,
      // yoksa iki ekran farklı veri gösteriyor
      if (document.getElementById('dbHarita')) panelCiz('dbHarita', 'dbHaritaDurum');
    } catch (e) {
      kap.innerHTML = `<div class="hm-yukleniyor">Isı haritası verisi alınamadı. Birazdan tekrar dene.</div>`;
      if (durumEl) durumEl.textContent = '';
    } finally {
      durum.yukleniyor = false;
    }
  }

  /* Sağdaki liderler/gerileyenler paneli */
  function ozetCiz(veri) {
    const el = document.getElementById('hmOzet');
    if (!el) return;
    const tum = [];
    veri.sektorler.forEach(s => s.hisseler.forEach(h => tum.push(h)));
    const artan = tum.slice().sort((a, b) => b.d - a.d).slice(0, 6);
    const azalan = tum.slice().sort((a, b) => a.d - b.d).slice(0, 6);
    const sekArtan = veri.sektorler.slice().sort((a, b) => b.d - a.d);

    const satir = (h) => `<div class="hm-oz-row" data-t="${esc(h.t)}" data-x="${esc(h.x || '')}">
        <span class="hm-oz-tk">${esc(h.t)}</span>
        <span class="hm-oz-ad">${esc(h.n)}</span>
        <span class="hm-oz-d" style="color:${h.d >= 0 ? 'var(--success)' : 'var(--danger)'}">${yuzde(h.d)}</span>
      </div>`;

    el.innerHTML = `
      <div class="hm-oz-blok">
        <div class="hm-oz-bas">Piyasa</div>
        <div class="hm-oz-piyasa" style="color:${veri.piyasaDegisim >= 0 ? 'var(--success)' : 'var(--danger)'}">${yuzde(veri.piyasaDegisim)}</div>
        <div class="hm-oz-not">${veri.hisseSayisi} hissenin değer ağırlıklı ortalaması</div>
      </div>
      <div class="hm-oz-blok">
        <div class="hm-oz-bas">Sektörler</div>
        ${sekArtan.map(s => `<div class="hm-oz-row" data-sektor="${esc(s.ad)}" title="${esc(s.ad)} sektör detayı">
            <span class="hm-oz-ad" style="flex:1">${esc(s.ad)}</span>
            <span class="hm-oz-d" style="color:${s.d >= 0 ? 'var(--success)' : 'var(--danger)'}">${yuzde(s.d)}</span>
          </div>`).join('')}
      </div>
      <div class="hm-oz-blok">
        <div class="hm-oz-bas">Yükselenler</div>
        ${artan.map(satir).join('')}
      </div>
      <div class="hm-oz-blok">
        <div class="hm-oz-bas">Düşenler</div>
        ${azalan.map(satir).join('')}
      </div>`;
  }

  /* ── Ana sayfa mini şeridi — sadece sektörler ───────────────── */
  async function miniYukle() {
    const el = document.getElementById('hmMini');
    if (!el) return;
    try {
      const veri = await getir('us', '1g');
      const sirali = veri.sektorler.slice().sort((a, b) => b.d - a.d);
      el.innerHTML = sirali.map(s => `
        <div class="hm-mini-kutu" data-sektor="${esc(s.ad)}" style="background:${renk(s.d)}" title="${esc(s.ad)} ${yuzde(s.d)} — sektör detayı">
          <span class="hm-mini-ad">${esc(s.ad)}</span>
          <span class="hm-mini-d">${yuzde(s.d)}</span>
        </div>`).join('');
      const not = document.getElementById('hmMiniNot');
      if (not) not.textContent = `ABD · günlük · ${veri.hisseSayisi} hisse`;
    } catch (e) {
      el.innerHTML = '<div class="hm-mini-bos">Sektör verisi alınamadı.</div>';
    }
  }

  /* ── Olaylar ────────────────────────────────────────────────── */
  function olaylariKur() {
    const dEl = document.getElementById('hmDonemler');
    if (dEl) dEl.addEventListener('click', e => {
      const b = e.target.closest('[data-donem]');
      if (!b || b.dataset.donem === durum.donem) return;
      durum.donem = b.dataset.donem;
      sayfaYukle();
    });

    const kEl = document.getElementById('hmKapsamlar');
    if (kEl) kEl.addEventListener('click', e => {
      const b = e.target.closest('[data-kapsam]');
      if (!b || b.dataset.kapsam === durum.kapsam) return;
      durum.kapsam = b.dataset.kapsam;
      durum.veri = null;
      sayfaYukle();
    });

    // Kutuya tıkla → analiz akışına düş, sektör başlığına tıkla → sektör
    // detayı. Harita iki yerde çiziliyor (tam sayfa + dashboard paneli),
    // o yüzden belge düzeyinde delege.
    document.addEventListener('click', e => {
      const bas = e.target.closest('.hm-sarmal .hm-sek-bas[data-sektor]');
      if (bas) { sektorAc(bas.dataset.sektor); return; }
      const el = e.target.closest('.hm-sarmal .hm-kutu');
      if (!el) return;
      hisseAc(el.dataset.t, el.dataset.x);
    });

    const kap = document.getElementById('hmHarita');
    const oz = document.getElementById('hmOzet');
    if (oz) oz.addEventListener('click', e => {
      const sek = e.target.closest('[data-sektor]');
      if (sek) { sektorAc(sek.dataset.sektor); return; }
      const r = e.target.closest('[data-t]');
      if (r) hisseAc(r.dataset.t, r.dataset.x);
    });

    // Mini şerit: bir sektör kutusuna basıldıysa o sektörün detayı,
    // şeridin boşluğuna basıldıysa haritanın tamamı
    const mini = document.getElementById('hmMiniSar') || document.getElementById('hmMini');
    if (mini) mini.addEventListener('click', e => {
      const sek = e.target.closest('[data-sektor]');
      if (sek) { sektorAc(sek.dataset.sektor, 'us'); return; }
      if (typeof window.showPage === 'function') window.showPage('harita');
    });

    boyutIzle(kap, () => durum.veri, yukseklikHesapla);
  }

  /* Yeniden boyutlanma — sadece yeniden çiz, veriyi tekrar çekme.
     ResizeObserver şart: pencere olayı, sayfa uzayınca beliren dikey
     kaydırma çubuğunun konteyneri daraltmasını yakalamıyor; harita
     eski genişlikle çizilip sağdan ~9px taşıyordu. */
  const izlenenKaplar = new WeakSet();

  function boyutIzle(kap, veriAl, yukseklikAl) {
    // Aynı konteynere birden fazla kez bağlanma: panelCiz her çizimde
    // çağrılıyor, gözlemciler birikmesin
    if (!kap || izlenenKaplar.has(kap)) return;
    izlenenKaplar.add(kap);

    let sonGenislik = 0, zaman = null;
    const yenidenCiz = () => {
      const g = kap.clientWidth;
      const veri = veriAl();
      if (!g || !veri || Math.abs(g - sonGenislik) < 2) return;
      sonGenislik = g;
      clearTimeout(zaman);
      zaman = setTimeout(() => {
        const v = veriAl();
        if (v && kap.clientWidth) ciz(kap, v, { yukseklik: yukseklikAl() });
      }, 120);
    };

    // ResizeObserver konteynerin kendi genişlik değişimini yakalar
    // (kenar çubuğu daralması, sayfa uzayınca beliren kaydırma çubuğu).
    if (typeof ResizeObserver === 'function') new ResizeObserver(yenidenCiz).observe(kap);
    // Pencere olayı yedek: bazı ortamlarda ResizeObserver geri çağrısı
    // gelmiyor, o zaman en azından viewport değişimini yakalayalım.
    window.addEventListener('resize', yenidenCiz);
  }

  function hisseAc(tk, borsa) {
    if (!tk) return;
    if (typeof window.qFill !== 'function') return;
    // Borsa evren tablosundan geliyor; yoksa kapsama göre varsayılan
    const ex = borsa || (durum.kapsam === 'bist' ? 'BIST' : 'NASDAQ');
    window.qFill(tk, '', ex);
    // qFill tek başına analiz sayfasını açmıyor (switchTab sadece sekmeyi
    // değiştiriyor) — anaFromPt'deki desen: sonrasında analiz sayfasına geç.
    if (typeof window.showPage === 'function') window.showPage('analiz');
    window.scrollTo(0, 0);
  }

  /* ═══ SEKTÖR DETAY SAYFASI ═══════════════════════════════════
     Haritada sektör başlığına (veya özet panelindeki sektör satırına)
     tıklayınca açılır: o sektördeki şirketlerin 1A/3A/6A/1Y getirileri.
     Veri: /api/market?type=sektor — tek yıllık seriden dört dönem. */
  const SEK_UC = '/api/market?type=sektor';
  const sekDurum = { kapsam: 'us', sektor: null, veri: null, anahtar: 'v', yon: -1, istek: 0 };
  const sekOnbellek = new Map();   // "kapsam|sektör" → { veri, ts }

  const SEK_SUTUN = [
    { k: 's', ad: '#', sinif: 'sk-sira', siralanir: false },
    { k: 't', ad: 'Hisse', sinif: 'sk-isim' },
    { k: 'f', ad: 'Fiyat', sinif: 'sk-sayi' },
    { k: 'v', ad: 'Değer', sinif: 'sk-sayi' },
    { k: '1a', ad: '1 Ay', sinif: 'sk-getiri' },
    { k: '3a', ad: '3 Ay', sinif: 'sk-getiri' },
    { k: '6a', ad: '6 Ay', sinif: 'sk-getiri' },
    { k: '1y', ad: '1 Yıl', sinif: 'sk-getiri' },
  ];

  async function sektorGetir(kapsam, sektor) {
    const anahtar = `${kapsam}|${sektor}`;
    const onbl = sekOnbellek.get(anahtar);
    if (onbl && (Date.now() - onbl.ts) < ONBELLEK_MS) return onbl.veri;
    const r = await fetch(`${SEK_UC}&scope=${encodeURIComponent(kapsam)}&sector=${encodeURIComponent(sektor)}`);
    const j = await r.json();
    if (!j || j.error) throw new Error((j && j.error) || 'Veri yok');
    sekOnbellek.set(anahtar, { veri: j, ts: Date.now() });
    return j;
  }

  function sektorAc(sektor, kapsam) {
    if (!sektor) return;
    sekDurum.kapsam = kapsam || durum.kapsam;
    sekDurum.sektor = sektor;
    sekDurum.veri = null;
    sekDurum.anahtar = 'v';
    sekDurum.yon = -1;
    if (typeof window.showPage === 'function') window.showPage('sektor');
    window.scrollTo(0, 0);
    sektorYukle();
  }

  async function sektorYukle() {
    const tablo = document.getElementById('skTablo');
    if (!tablo) return;
    const baslik = document.getElementById('skBaslik');
    const kapsamEl = document.getElementById('skKapsam');
    const durumEl = document.getElementById('skDurum');
    const ozetEl = document.getElementById('skOzet');
    const notEl = document.getElementById('skNot');

    if (baslik) baslik.innerHTML = `${esc(sekDurum.sektor)} <span>Sektörü</span>`;
    if (kapsamEl) {
      const k = KAPSAMLAR.find(x => x.k === sekDurum.kapsam) || KAPSAMLAR[0];
      kapsamEl.innerHTML = `<svg class="chip-f" style="width:14px;height:9px"><use href="${k.bayrak}"/></svg>${k.ad}`;
    }
    if (ozetEl) ozetEl.innerHTML = '';
    if (notEl) notEl.textContent = '';
    tablo.innerHTML = '<div class="sk-yukleniyor">Sektör verisi hazırlanıyor…</div>';
    if (durumEl) durumEl.textContent = 'yükleniyor…';

    // Kullanıcı yüklenirken başka sektöre geçebiliyor — geç gelen yanıt
    // yeni sektörün üstüne yazmasın
    const bilet = ++sekDurum.istek;
    try {
      const veri = await sektorGetir(sekDurum.kapsam, sekDurum.sektor);
      if (bilet !== sekDurum.istek) return;
      sekDurum.veri = veri;
      sektorCiz();
      if (durumEl) {
        const saat = new Date(veri.ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
        durumEl.textContent = `${veri.hisseSayisi} şirket · ${saat}`;
      }
      if (notEl) {
        const eksik = veri.evrenSayisi - veri.hisseSayisi;
        notEl.textContent = `Getiriler kapanış fiyatlarına göre · veri: Yahoo Finance`
          + (eksik > 0 ? ` · ${eksik} şirketin verisi alınamadı` : '');
      }
    } catch (e) {
      if (bilet !== sekDurum.istek) return;
      tablo.innerHTML = '<div class="sk-yukleniyor">Sektör verisi alınamadı. Birazdan tekrar dene.</div>';
      if (durumEl) durumEl.textContent = '';
    }
  }

  function sektorCiz() {
    const veri = sekDurum.veri;
    const tablo = document.getElementById('skTablo');
    if (!veri || !tablo) return;

    const ozetEl = document.getElementById('skOzet');
    if (ozetEl) {
      ozetEl.innerHTML = veri.donemler.map(d => {
        const v = veri.ozet[d.k];
        return `<div class="sk-oz">
            <div class="sk-oz-l">${esc(d.ad)}</div>
            <div class="sk-oz-v" style="color:${v == null ? 'var(--muted2)' : (v >= 0 ? 'var(--success)' : 'var(--danger)')}">${yuzde(v)}</div>
          </div>`;
      }).join('');
    }

    // Sıralama: boş getiriler her zaman en sona
    const hisseler = veri.hisseler.slice().sort((a, b) => {
      const k = sekDurum.anahtar;
      if (k === 't') return a.t.localeCompare(b.t, 'tr') * sekDurum.yon;
      const av = a[k], bv = b[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * sekDurum.yon;
    });

    const ok = (k) => k === sekDurum.anahtar ? (sekDurum.yon < 0 ? ' ▾' : ' ▴') : '';
    const bas = `<div class="sk-satir sk-bas">` + SEK_SUTUN.map(c =>
      c.siralanir === false
        ? `<div class="${c.sinif}">${c.ad}</div>`
        : `<div class="${c.sinif}"><span data-sut="${c.k}" class="${c.k === sekDurum.anahtar ? 'sk-aktif' : ''}">${c.ad}${ok(c.k)}</span></div>`
    ).join('') + `</div>`;

    const getiri = (v) => v == null
      ? `<div class="sk-getiri sk-bos">—</div>`
      : `<div class="sk-getiri" style="color:${v >= 0 ? 'var(--success)' : 'var(--danger)'}">${yuzde(v)}</div>`;

    const satirlar = hisseler.map((h, i) => `
      <div class="sk-satir sk-hisse" data-t="${esc(h.t)}" data-x="${esc(h.x || '')}">
        <div class="sk-sira">${i + 1}</div>
        <div class="sk-isim"><div class="sk-tk">${esc(h.t)}</div><div class="sk-ad">${esc(h.n)}</div></div>
        <div class="sk-sayi">${veri.paraBirimi === 'TRY' ? '₺' : '$'}${h.f != null ? esc(h.f.toFixed(2)) : '—'}</div>
        <div class="sk-sayi">${buyukSayi(h.v, veri.paraBirimi)}</div>
        ${veri.donemler.map(d => getiri(h[d.k])).join('')}
      </div>`).join('');

    tablo.innerHTML = bas + satirlar;
  }

  function sektorOlaylari() {
    const tablo = document.getElementById('skTablo');
    if (!tablo) return;
    tablo.addEventListener('click', e => {
      const sut = e.target.closest('[data-sut]');
      if (sut) {
        const k = sut.dataset.sut;
        // Aynı sütuna tekrar basınca yön değişir; yeni sütun sembolde
        // A→Z, sayısal alanlarda büyükten küçüğe başlar
        if (sekDurum.anahtar === k) sekDurum.yon *= -1;
        else { sekDurum.anahtar = k; sekDurum.yon = k === 't' ? 1 : -1; }
        sektorCiz();
        return;
      }
      const satir = e.target.closest('.sk-hisse');
      if (satir) hisseAc(satir.dataset.t, satir.dataset.x);
    });
  }

  /* ── Dashboard paneli — aynı motor, ayrı konteyner ──────────── */
  let _panelVeri = null;

  function panelYukseklik() {
    const g = window.innerWidth;
    return g < 600 ? 380 : g < 1000 ? 430 : 470;
  }

  async function panelCiz(kapId, durumId) {
    const kap = document.getElementById(kapId || 'dbHarita');
    if (!kap) return;
    const durumEl = durumId ? document.getElementById(durumId) : null;
    kap.style.height = panelYukseklik() + 'px';
    kap.innerHTML = '<div class="hm-yukleniyor">Isı haritası hazırlanıyor…</div>';
    try {
      const veri = await getir(durum.kapsam, durum.donem);
      _panelVeri = veri;
      const cizilen = ciz(kap, veri, { yukseklik: panelYukseklik() });
      ipucuKur(kap, veri.paraBirimi);
      if (durumEl) {
        const adet = (cizilen && cizilen < veri.hisseSayisi) ? `en büyük ${cizilen}` : `${veri.hisseSayisi}`;
        durumEl.textContent = `${veri.kapsam === 'bist' ? 'BİST' : 'ABD'} · ${veri.donemAd} · ${adet} hisse`;
      }
      boyutIzle(kap, () => _panelVeri, panelYukseklik);
    } catch (e) {
      kap.innerHTML = '<div class="hm-yukleniyor">Isı haritası verisi alınamadı.</div>';
      if (durumEl) durumEl.textContent = '';
    }
  }

  /* ── Dışa açılan uçlar ──────────────────────────────────────── */
  window.hmSayfaAc = function () { sayfaYukle(); };
  window.hmMiniYukle = miniYukle;
  window.hmPanelCiz = panelCiz;
  window.hmSektorAc = sektorAc;

  function lejantCiz() {
    const el = document.getElementById('hmLejant');
    if (!el) return;
    let s = '';
    for (let i = 0; i <= 20; i++) s += `<span style="background:${renk(-3 + i * 0.3)}"></span>`;
    el.innerHTML = s;
  }

  function baslat() {
    if (!document.getElementById('hmHarita') && !document.getElementById('hmMini')) return;
    olaylariKur();
    sektorOlaylari();
    kontrolleriCiz();
    lejantCiz();
    miniYukle();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', baslat);
  else baslat();
})();
