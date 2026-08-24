// ================================================================
// analyze-features.js — Barış Investing
// Analiz ekranının üst kartı (logo + ticker + şirket künyesi).
//
// NOT: Bu kart #stockHdr'ın yerine geçiyor (onu gizliyor), yani
// kullanıcının analiz ekranında gördüğü logo/rozet BURADAKİLER.
// app.html'deki .stock-logo stilleri ekrana çıkmıyor.
//
// Künye eskiden /api/analyze'a İKİNCİ bir istek atıp AI'dan
// BUSINESS/SECTOR/MOAT/PEERS çekiyordu. api/analyze.js istemciden
// gelen prompt'u kullanmıyor (kendi çerçeve promptunu kuruyor), yani
// o istek her analizde ikinci bir tam analiz çalıştırıp sonucundan
// hiçbir alanı bulamıyor, tüm satırları "—" yazıyordu — üstelik
// 60sn'lik Vercel penceresinde iki ağır çağrı yan yana koşunca
// analizin kendisi de zaman aşımına giriyordu. Künye artık
// ansiklopedi özeti (/api/market?type=ozet, 1 gün cache) + analizin
// kendi metninden besleniyor: ek AI maliyeti yok.
// ================================================================

// ── CSS ──────────────────────────────────────────────────────────
(function() {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes snapIn {
      from { opacity:0; transform:translateY(-4px); }
      to   { opacity:1; transform:translateY(0); }
    }
    #snapshotCard { animation: snapIn 0.35s ease forwards; }

    #snapshotCard .snap-tanim {
      font-size:12px;color:rgba(255,255,255,0.86);font-family:'Inter',sans-serif;
      line-height:1.75;margin:0 0 12px;max-width:74ch;
    }
    #snapshotCard .snap-meta {
      display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;
    }
    #snapshotCard .snap-meta-l {
      font-size:8px;letter-spacing:2px;text-transform:uppercase;
      color:var(--muted-s,#7a8493);font-family:'JetBrains Mono',monospace;
      margin-left:4px;
    }
    #snapshotCard .snap-sektor {
      font-size:9px;letter-spacing:1px;font-family:'JetBrains Mono',monospace;
      color:var(--gold,#d4a843);background:rgba(194,173,132,0.10);
      border:1px solid rgba(194,173,132,0.25);border-radius:3px;padding:3px 8px;
    }
    #snapshotCard .snap-peer {
      font-size:9px;padding:3px 8px;
      background:rgba(255,255,255,0.08);
      border:1px solid var(--border-s,#3a4260);
      color:#9aa3b2;font-family:'JetBrains Mono',monospace;
      cursor:pointer;transition:all 0.15s;letter-spacing:0.5px;
    }
    #snapshotCard .snap-peer:hover {
      background:rgba(255,255,255,0.18);color:#ffffff;
      border-color:#9aa3b2;
    }
    #snapshotCard .snap-alert {
      background:rgba(165,90,82,0.08);
      border:1px solid rgba(165,90,82,0.25);
      border-left:3px solid rgba(165,90,82,0.6);
      padding:8px 12px;
      font-size:10px;color:#e07060;
      font-family:'Inter',sans-serif;
      line-height:1.6;
    }
    /* Logo: şeffaf PNG'ler koyu zeminde kayboluyordu — açık zemin + iç boşluk */
    #snapshotCard .snap-logo {
      width:48px;height:48px;flex-shrink:0;
      background:#f6f4ef;
      border:1px solid rgba(194,173,132,0.35);
      border-radius:10px;overflow:hidden;
      display:flex;align-items:center;justify-content:center;
      font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;
      color:#5a4636;letter-spacing:0;
      box-shadow:0 2px 8px rgba(0,0,0,0.25);
    }
    #snapshotCard .snap-logo img { width:100%;height:100%;object-fit:contain;padding:6px;box-sizing:border-box; }
    @media (max-width:640px){ #snapshotCard .snap-logo { width:42px;height:42px; } }
  `;
  document.head.appendChild(s);
})();


// ── ŞİRKET KÜNYE KARTI ──────────────────────────────────────────
function snapAlan(metin, anahtar) {
  const m = String(metin || '').match(new RegExp(`^${anahtar}:\\s*([^\\n]+)`, 'm'));
  return m ? m[1].split('|')[0].trim() : '';
}

async function injectCompanySnapshot(ticker, company, exchange, fwKey, fmpPeers = [], website = null, logoUrl = null, analizMetni = '', fd = null) {
  const old = document.getElementById('snapshotCard');
  if (old) old.remove();

  // stock-hdr'ı gizle — tüm künye bu kartın içinde
  const stockHdr = document.getElementById('stockHdr');
  if (stockHdr) stockHdr.style.display = 'none';

  const fwAd = (typeof FW !== 'undefined' && FW[fwKey] && FW[fwKey].name)
    ? FW[fwKey].name.toUpperCase()
    : 'BARIŞ INVESTING';

  const flagMap = { BIST: '🇹🇷', NYSE: '🇺🇸', NASDAQ: '🇺🇸', NAS: '🇺🇸' };
  const flag = flagMap[exchange] || '🌐';

  /* Kart, sonuç ızgarasının "şirket" sütununun en üstüne giriyor.
     Eskiden #analysisSection'a ekleniyordu; o blok haber akışının ALTINDA
     durduğu için şirket kartı sayfanın en dibinde kalıyordu. */
  const kap = document.getElementById('resultAnalysisCol') || document.getElementById('analysisSection');

  const card = document.createElement('div');
  card.id = 'snapshotCard';
  card.style.cssText = `
    background:var(--sidebar,#0e1220);
    border-bottom:2px solid var(--accent2,#d4a843);
    margin:-14px -14px 14px;
    padding:16px 20px 0;
  `;

  // ── Üst satır: Logo + Ticker + Rozet + Paylaş ──
  const topRow = document.createElement('div');
  topRow.style.cssText = 'display:flex;align-items:center;gap:14px;margin-bottom:12px;';

  const logoWrap = document.createElement('div');
  logoWrap.className = 'snap-logo';
  logoWrap.textContent = ticker.slice(0, 2);
  const logoSrc = `/api/logo?ticker=${encodeURIComponent(ticker)}&sz=128`;
  const logoImg = new Image();
  logoImg.crossOrigin = 'anonymous';
  logoImg.alt = ticker;
  // Yalnızca gerçekten yüklenince koy: 404'te baş harfler kalsın
  logoImg.onload = () => { logoWrap.textContent = ''; logoWrap.appendChild(logoImg); window._shareLogoImg = logoImg; };
  logoImg.src = logoSrc;

  const titleCol = document.createElement('div');
  titleCol.innerHTML = `
    <div style="font-family:'JetBrains Mono',monospace;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:2px;line-height:1">${ticker}</div>
    <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;font-family:'Inter',sans-serif;">${company || ''}</div>
    <div style="display:inline-flex;align-items:center;gap:4px;margin-top:4px;background:rgba(194,173,132,0.10);border:1px solid rgba(194,173,132,0.25);border-radius:3px;padding:2px 7px;font-family:'JetBrains Mono',monospace;font-size:9px;font-weight:600;color:var(--gold,#d4a843);letter-spacing:1px;">
      ${flag} ${exchange}
    </div>
  `;

  const badgeCol = document.createElement('div');
  badgeCol.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-left:4px;';
  badgeCol.innerHTML = `
    <span id="badgeFwKart" class="badge badge-fw ${fwKey || 'baris'}">${fwAd}</span>
    <span id="badgeLiveKart" class="badge badge-live" style="display:none">● Canlı</span>
  `;

  const xBtn = document.createElement('button');
  xBtn.className = 'x-shr-btn';
  xBtn.style.marginLeft = 'auto';
  xBtn.onclick = () => openShr();
  xBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>𝕏 Paylaş`;

  topRow.appendChild(logoWrap);
  topRow.appendChild(titleCol);
  topRow.appendChild(badgeCol);
  topRow.appendChild(xBtn);
  card.appendChild(topRow);

  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px;background:rgba(194,173,132,0.15);margin:0 -20px 14px;';
  card.appendChild(divider);

  const body = document.createElement('div');
  body.id = 'snapshotBody';
  body.style.cssText = 'padding:0 0 14px;';
  card.appendChild(body);

  if (kap) kap.prepend(card);

  // ── Gövde: ne yapıyor + sektör + rakipler + risk ──
  const risk = snapAlan(analizMetni, 'RISK');
  const ozetYedek = snapAlan(analizMetni, 'SUMMARY');
  const peers = (fmpPeers && fmpPeers.length) ? fmpPeers.slice(0, 4) : [];

  const ciz = (isTanim, sektor) => {
    const el = document.getElementById('snapshotBody');
    if (!el) return;
    /* Sektör eskiden tek başına koca bir kutuydu — iki kelime için bir
       çerçeve. Artık rakiplerle aynı satırda küçük bir etiket. */
    el.innerHTML = `
      ${isTanim ? `<p class="snap-tanim">${isTanim}</p>` : ''}
      ${(sektor || peers.length) ? `
      <div class="snap-meta">
        ${sektor ? `<span class="snap-sektor">${sektor}</span>` : ''}
        ${peers.length ? `<span class="snap-meta-l">Rakipler</span>${peers.map(p => `<button class="snap-peer" onclick="qFill('${p}','','${exchange}')">${p}</button>`).join('')}` : ''}
      </div>` : ''}
      ${risk ? `<div class="snap-alert">⚠ ${risk}</div>` : ''}
    `;
  };

  // Önce elde olanla çiz (anında), ansiklopedi özeti gelince tazele
  ciz(ozetYedek, (fd && fd.sector) || '');
  try {
    const r = await fetch(`/api/market?type=ozet&ticker=${encodeURIComponent(ticker)}`);
    if (r.ok) {
      const d = await r.json();
      if (d && (d.ozet || d.sektor)) ciz(d.ozet || ozetYedek, d.sektor || (fd && fd.sector) || '');
    }
  } catch (e) { /* özet yoksa analiz özeti kalır */ }
}


// ── parseAndRender HOOK ──────────────────────────────────────────
const _origParseAndRender = window.parseAndRender;
window.parseAndRender = function(ticker, company, text, fd, fwKey) {
  _origParseAndRender(ticker, company, text, fd, fwKey);

  const fw = fwKey || (typeof curFW !== 'undefined' ? curFW : 'baris');
  const ex = typeof curEX !== 'undefined' ? curEX : 'BIST';

  const fmpPeers = fd?.peers   || [];
  const website  = fd?.website  || null;
  const logoUrl  = fd?.logoUrl  || null;
  injectCompanySnapshot(ticker, company, ex, fw, fmpPeers, website, logoUrl, text, fd);

  // Canlı rozeti — gerçek finansal veri geldiyse göster
  // (#badgeLive gizli stock-hdr'da kaldığı için kartın kendi rozeti kullanılıyor)
  setTimeout(() => {
    const live = document.getElementById('badgeLiveKart');
    if (live && fd) live.style.display = 'block';
  }, 300);
};
