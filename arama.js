/* ═══════════════════════════════════════════════════════════════
   ŞİRKET ARAMA ÖNERİLERİ — tek yerden, her arama kutusuna takılır
   Veri: /api/market?type=evren (bir kez, yerelde süzülür)
         /api/market?type=search (evren dışı kodlar için yedek)

   Kullanıcı borsa seçmiyor: kodu yaz, listeden şirketi seç, borsa
   evren tablosundan geliyor. Kutu boşken son bakılanlar çıkıyor.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const SON_ANAHTAR = 'bi_son_bakilan';
  const SON_SINIR = 6;
  const ONERI_SINIR = 7;

  let evren = null;         // [{t,n,x,s}]
  let evrenIstek = null;    // aynı anda tek istek

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function evrenGetir() {
    if (evren) return Promise.resolve(evren);
    if (!evrenIstek) {
      evrenIstek = fetch('/api/market?type=evren')
        .then(r => r.json())
        .then(j => { evren = (j && j.sirketler) || []; return evren; })
        .catch(() => { evrenIstek = null; return []; });
    }
    return evrenIstek;
  }

  /* ── Son bakılanlar ── */
  function sonAl() {
    try { const v = localStorage.getItem(SON_ANAHTAR); return v ? JSON.parse(v) : []; }
    catch (e) { return []; }
  }
  function sonEkle(t, n, x) {
    const tk = String(t || '').toUpperCase();
    if (!tk) return;
    const liste = sonAl().filter(k => k.t !== tk);
    liste.unshift({ t: tk, n: n || tk, x: x || '' });
    try { localStorage.setItem(SON_ANAHTAR, JSON.stringify(liste.slice(0, SON_SINIR))); } catch (e) {}
  }

  /* Türkçe harfleri ASCII'ye katla: "turk" yazan Türk Hava Yolları'nı
     bulsun. Ayrıca toLocaleUpperCase('tr') "i" harfini "İ" yaptığı için
     "micro" ile "Microsoft" eşleşmiyordu — katlama onu da düzeltiyor. */
  const HARF = { 'İ': 'I', 'ı': 'I', 'i': 'I', 'I': 'I', 'Ş': 'S', 'ş': 'S', 'Ğ': 'G', 'ğ': 'G', 'Ü': 'U', 'ü': 'U', 'Ö': 'O', 'ö': 'O', 'Ç': 'C', 'ç': 'C' };
  function katla(s) {
    return String(s == null ? '' : s).replace(/[İIıiŞşĞğÜüÖöÇç]/g, c => HARF[c]).toUpperCase();
  }

  /* ── Süzme: önce kod başlangıcı, sonra ad başlangıcı, en sonda
     içinde geçenler. "NV" → NVDA üstte. Tek harflik sorguda yalnızca
     baştan eşleşme var; yoksa "T" yazınca MSFT gibi alakasız kodlar
     listeye doluyor. */
  function suz(q) {
    if (!evren) return [];
    const s = katla(q);
    const kodBas = [], adBas = [], icinde = [];
    for (const h of evren) {
      const ad = katla(h.n);
      if (h.t.startsWith(s)) kodBas.push(h);
      else if (ad.startsWith(s)) adBas.push(h);
      else if (s.length >= 2 && (h.t.includes(s) || ad.includes(s))) icinde.push(h);
      if (kodBas.length >= ONERI_SINIR) break;
    }
    return kodBas.concat(adBas, icinde).slice(0, ONERI_SINIR);
  }

  // Evren dışı kodlar (POWL, SNDK gibi) için sunucu araması
  async function uzaktanAra(q) {
    try {
      const r = await fetch('/api/market?type=search&ticker=' + encodeURIComponent(q));
      const j = await r.json();
      return (j.results || []).map(x => ({ t: x.ticker, n: x.name, x: x.exchange || '', uzak: true }));
    } catch (e) { return []; }
  }

  function borsaAd(x) {
    return x === 'BIST' ? 'BİST' : (x || '');
  }

  function satirCiz(h, secili) {
    return `<div class="ar-sat${secili ? ' secili' : ''}" data-t="${esc(h.t)}" data-n="${esc(h.n)}" data-x="${esc(h.x || '')}">
      <span class="ar-logo"><img src="/api/logo?ticker=${encodeURIComponent(h.t)}&sz=64" alt="" loading="lazy" onerror="this.remove()"><i>${esc(h.t.slice(0, 2))}</i></span>
      <span class="ar-bilgi">
        <span class="ar-ad">${esc(h.n)}</span>
        <span class="ar-alt">${esc(h.t)}${h.x ? ' · ' + esc(borsaAd(h.x)) : ''}</span>
      </span>
      <span class="ar-ok">→</span>
    </div>`;
  }

  /* ── Bir arama kutusuna öneri paneli tak ──
     secim(h):  kullanıcı listeden bir şirket seçtiğinde çağrılır.
     hamEnter(): liste kapalıyken/seçim yokken Enter'a basıldığında.
     Enter'ı burada yönetiyoruz: kutuda inline onkeydown kalırsa ikisi
     birden çalışıp hem ham metinle hem seçimle istek atılıyor. */
  window.aramaKur = function (girdiId, secim, hamEnter) {
    const inp = document.getElementById(girdiId);
    if (!inp || inp.dataset.aramaKurulu) return;
    inp.dataset.aramaKurulu = '1';
    inp.setAttribute('autocomplete', 'off');

    // Panel kutunun hemen altına konumlansın diye sarmalayıcı
    const sar = document.createElement('div');
    sar.className = 'ar-sar';
    inp.parentNode.insertBefore(sar, inp);
    sar.appendChild(inp);
    const panel = document.createElement('div');
    panel.className = 'ar-panel';
    sar.appendChild(panel);

    let liste = [], sec = -1, zaman = null, sonSorgu = '';

    function kapat() { panel.classList.remove('acik'); sec = -1; }

    function ciz(baslik) {
      if (!liste.length) { kapat(); return; }
      panel.innerHTML = (baslik ? `<div class="ar-bas">${esc(baslik)}</div>` : '')
        + liste.map((h, i) => satirCiz(h, i === sec)).join('');
      panel.classList.add('acik');
    }

    function bosCiz() {
      const son = sonAl();
      liste = son;
      if (!son.length) { kapat(); return; }
      ciz('Son bakılanlar');
    }

    async function ara(q) {
      await evrenGetir();
      if (inp.value.trim().toUpperCase() !== q) return;   // kullanıcı yazmaya devam etti
      liste = suz(q);
      sec = liste.length ? 0 : -1;
      ciz(null);
      // Evrende az sonuç varsa sunucuya sor (POWL, SNDK gibi kodlar)
      if (liste.length < 3 && q.length >= 2) {
        const uzak = await uzaktanAra(q);
        if (inp.value.trim().toUpperCase() !== q) return;
        const varOlan = new Set(liste.map(h => h.t));
        liste = liste.concat(uzak.filter(h => !varOlan.has(h.t))).slice(0, ONERI_SINIR);
        if (sec < 0 && liste.length) sec = 0;
        ciz(null);
      }
    }

    function uygula(h) {
      kapat();
      inp.value = '';
      sonSorgu = '';   // aynı kodu tekrar yazınca panel yine açılsın
      sonEkle(h.t, h.n, h.x);
      secim(h);
    }

    inp.addEventListener('input', () => {
      const q = inp.value.trim().toUpperCase();
      clearTimeout(zaman);
      if (!q) { bosCiz(); return; }
      if (q === sonSorgu) return;
      sonSorgu = q;
      zaman = setTimeout(() => ara(q), 120);
    });

    inp.addEventListener('focus', () => { if (!inp.value.trim()) bosCiz(); });

    inp.addEventListener('keydown', e => {
      if (e.key === 'Escape') { kapat(); return; }
      const acik = panel.classList.contains('acik') && liste.length;
      if (e.key === 'Enter' && (!acik || sec < 0)) {
        // Panelde seçim yok — kutunun kendi işi (ham kodla ara/ekle)
        e.preventDefault();
        kapat();
        if (typeof hamEnter === 'function') hamEnter();
        return;
      }
      if (!acik) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sec = (sec + (e.key === 'ArrowDown' ? 1 : -1) + liste.length) % liste.length;
        ciz(panel.querySelector('.ar-bas') ? panel.querySelector('.ar-bas').textContent : null);
        const el = panel.querySelector('.ar-sat.secili');
        if (el) el.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); uygula(liste[sec]); }
    });

    panel.addEventListener('mousedown', e => {
      const sat = e.target.closest('[data-t]');
      if (!sat) return;
      e.preventDefault();   // input blur olup panel kapanmasın
      uygula({ t: sat.dataset.t, n: sat.dataset.n, x: sat.dataset.x });
    });

    document.addEventListener('click', e => { if (!sar.contains(e.target)) kapat(); });
  };

  /* Serbest yazılan kodun borsasını çöz — kullanıcı borsa seçmesin diye.
     Önce evren tablosu, sonra sunucu araması; ikisi de bilmiyorsa null. */
  window.aramaBorsaBul = async function (ticker) {
    const tk = String(ticker || '').toUpperCase();
    if (!tk) return null;
    await evrenGetir();
    const h = (evren || []).find(x => x.t === tk);
    if (h) return h.x;
    const uzak = await uzaktanAra(tk);
    const tam = uzak.find(x => x.t === tk);
    return tam ? (tam.x === 'BIST' ? 'BIST' : tam.x) : null;
  };

  window.aramaSonEkle = sonEkle;
  // Arama kutusu olan sayfaya girmeden evreni hazırla — ilk tuşta bekleme olmasın
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', evrenGetir);
  else evrenGetir();
})();
