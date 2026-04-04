// ================================================================
// analyze-features.js — Barış Investing
// 1. Master Selection / Strong Consensus rozeti
// 2. Şirket Snapshot kartı (stock-hdr altına, üst konumda)
// 3. X paylaşım optimizasyonu
// ================================================================

// ── CSS ──────────────────────────────────────────────────────────
(function() {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes masterPulse {
      0%,100% { box-shadow:0 0 0 0 rgba(154,125,58,0); }
      50%      { box-shadow:0 0 0 8px rgba(154,125,58,0.15); }
    }
    @keyframes snapIn {
      from { opacity:0; transform:translateY(-4px); }
      to   { opacity:1; transform:translateY(0); }
    }
    #snapshotCard { animation: snapIn 0.35s ease forwards; }

    #snapshotCard .snap-col {
      background:var(--sidebar2,#222840);
      border:1px solid var(--border-s,#3a4260);
      padding:10px 14px;
    }
    #snapshotCard .snap-col-lbl {
      font-size:8px;letter-spacing:2px;text-transform:uppercase;
      color:var(--muted-s,#8892b0);font-family:'IBM Plex Mono',monospace;
      margin-bottom:5px;
    }
    #snapshotCard .snap-col-val {
      font-size:12px;color:#ccd6f6;font-weight:500;
      font-family:'IBM Plex Sans',sans-serif;line-height:1.5;
    }
    #snapshotCard .snap-peer {
      font-size:9px;padding:3px 8px;
      background:rgba(168,184,216,0.08);
      border:1px solid var(--border-s,#3a4260);
      color:#a8b8d8;font-family:'IBM Plex Mono',monospace;
      cursor:pointer;transition:all 0.15s;letter-spacing:0.5px;
    }
    #snapshotCard .snap-peer:hover {
      background:rgba(168,184,216,0.18);color:#ccd6f6;
      border-color:#a8b8d8;
    }
    #snapshotCard .snap-alert {
      background:rgba(192,57,43,0.08);
      border:1px solid rgba(192,57,43,0.25);
      border-left:3px solid rgba(192,57,43,0.6);
      padding:8px 12px;
      font-size:10px;color:#e07060;
      font-family:'IBM Plex Sans',sans-serif;
      line-height:1.6;
    }
    .snap-logo-placeholder {
      width:36px;height:36px;border-radius:4px;
      background:var(--sidebar3,#2d3452);
      border:1px solid var(--border-s,#3a4260);
      display:flex;align-items:center;justify-content:center;
      font-family:'Playfair Display',serif;
      font-size:14px;font-weight:700;color:#a8b8d8;
      flex-shrink:0;overflow:hidden;
    }
  `;
  document.head.appendChild(s);
})();


// ── 1. MASTER SELECTION ROZETİ ───────────────────────────────────
const _masterScores = {};

function trackMasterScore(ticker, exchange, fw, score) {
  const key = `${ticker}:${exchange}`;
  if (!_masterScores[key]) _masterScores[key] = {};
  _masterScores[key][fw] = score;
  checkMasterBadge(ticker, exchange);
}

function checkMasterBadge(ticker, exchange) {
  const key    = `${ticker}:${exchange}`;
  const scores  = _masterScores[key] || {};
  const b = scores.buffett ?? -1;
  const l = scores.lynch   ?? -1;
  const d = scores.dalio   ?? -1;

  const isMaster    = b >= 5 && l >= 5;
  const isConsensus = b >= 4 && l >= 4 && d >= 4;

  const old = document.getElementById('masterBadge');
  if (old) old.remove();
  if (!isMaster && !isConsensus) return;

  const badge = document.createElement('div');
  badge.id = 'masterBadge';

  if (isMaster) {
    badge.style.cssText = `
      display:inline-flex;align-items:center;gap:8px;
      padding:8px 16px;margin:10px 0 2px;
      background:linear-gradient(135deg,rgba(154,125,58,0.15),rgba(212,175,55,0.06));
      border:1px solid rgba(154,125,58,0.4);
      animation:masterPulse 2s ease-in-out 2;
    `;
    badge.innerHTML = `
      <span style="font-size:18px">⭐</span>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#c8a951;font-family:'IBM Plex Mono',monospace">Master Selection</div>
        <div style="font-size:9px;color:#9a7d3a;font-family:'IBM Plex Mono',monospace;margin-top:1px">Buffett ${b}/7 · Lynch ${l}/7 — Çift ekol konsensüsü</div>
      </div>
    `;
  } else {
    badge.style.cssText = `
      display:inline-flex;align-items:center;gap:8px;
      padding:8px 16px;margin:10px 0 2px;
      background:rgba(36,81,163,0.1);
      border:1px solid rgba(168,184,216,0.25);
    `;
    badge.innerHTML = `
      <span style="font-size:18px">✦</span>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#a8b8d8;font-family:'IBM Plex Mono',monospace">Strong Consensus</div>
        <div style="font-size:9px;color:#8892b0;font-family:'IBM Plex Mono',monospace;margin-top:1px">Buffett ${b}/7 · Lynch ${l}/7 · Dalio ${d}/7</div>
      </div>
    `;
  }

  const vbox = document.getElementById('verdictBox');
  if (vbox) vbox.after(badge);
}


// ── 2. ŞİRKET SNAPSHOT KARTI ────────────────────────────────────
const CLEARBIT_DOMAINS = {
  THYAO:'turkishairlines.com', EREGL:'erdemir.com.tr', SAHOL:'sabanci.com',
  KCHOL:'koc.com.tr', ASELS:'aselsan.com.tr', BIMAS:'bim.com.tr',
  TUPRS:'tupras.com.tr', AKBNK:'akbank.com', ISCTR:'isbank.com.tr',
  FROTO:'fordotosan.com.tr', GARAN:'garantibbva.com.tr', TCELL:'turkcell.com.tr',
  AAPL:'apple.com', MSFT:'microsoft.com', GOOGL:'google.com', AMZN:'amazon.com',
  NVDA:'nvidia.com', META:'meta.com', TSLA:'tesla.com', NFLX:'netflix.com',
  AMD:'amd.com', INTC:'intel.com', JPM:'jpmorganchase.com', V:'visa.com',
};

function makeLogoEl(ticker, company) {
  const domain = CLEARBIT_DOMAINS[ticker];
  const initial = (company || ticker || '?')[0].toUpperCase();
  const wrap = document.createElement('div');
  wrap.className = 'snap-logo-placeholder';

  if (domain) {
    const img = document.createElement('img');
    img.src = `https://logo.clearbit.com/${domain}`;
    img.alt = ticker;
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:none;';
    img.onload  = () => { wrap.innerHTML = ''; wrap.style.background = '#fff'; wrap.style.padding = '4px'; wrap.appendChild(img); img.style.display = 'block'; };
    img.onerror = () => { wrap.textContent = initial; };
    wrap.textContent = initial;
    wrap.appendChild(img);
  } else {
    wrap.textContent = initial;
  }
  return wrap;
}

async function injectCompanySnapshot(ticker, company, exchange, fwKey) {
  const old = document.getElementById('snapshotCard');
  if (old) old.remove();

  // Kart iskeleti — hemen göster
  const card = document.createElement('div');
  card.id = 'snapshotCard';
  card.style.cssText = `
    background:var(--sidebar,#1a1f2e);
    border:1px solid var(--border-s,#3a4260);
    border-top:3px solid var(--accent2,#2451a3);
    margin-bottom:1px;
  `;

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = `
    display:flex;align-items:center;gap:12px;
    padding:14px 18px 12px;
    border-bottom:1px solid var(--border-s,#3a4260);
  `;

  const logoEl = makeLogoEl(ticker, company);
  const titleWrap = document.createElement('div');
  titleWrap.innerHTML = `
    <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted-s,#8892b0);font-family:'IBM Plex Mono',monospace;margin-bottom:3px">Şirket Profili</div>
    <div style="font-size:14px;font-weight:700;color:#e8e6e0;font-family:'Playfair Display',serif">${company || ticker}</div>
    <div style="font-size:9px;color:#8892b0;font-family:'IBM Plex Mono',monospace;margin-top:2px">${exchange} · ${ticker}</div>
  `;

  hdr.appendChild(logoEl);
  hdr.appendChild(titleWrap);
  card.appendChild(hdr);

  // Body — loading state
  const body = document.createElement('div');
  body.id = 'snapshotBody';
  body.style.cssText = 'padding:14px 18px;';
  body.innerHTML = `
    <div style="font-size:10px;color:var(--muted-s,#8892b0);font-family:'IBM Plex Mono',monospace;letter-spacing:1px">
      Profil yükleniyor<span id="snapDots">.</span>
    </div>
  `;
  card.appendChild(body);

  // stock-hdr'ın hemen ardına ekle (en üste)
  const stockHdr = document.getElementById('stockHdr');
  if (stockHdr) {
    stockHdr.after(card);
  } else {
    const aSection = document.getElementById('analysisSection');
    if (aSection) aSection.prepend(card);
  }

  // Loading animasyonu
  let dotCount = 1;
  const dotTimer = setInterval(() => {
    const el = document.getElementById('snapDots');
    if (el) { dotCount = (dotCount % 3) + 1; el.textContent = '.'.repeat(dotCount); }
  }, 400);

  // AI'dan veri çek
  try {
    const prompt = `${exchange} borsasındaki "${ticker}"${company ? ` (${company})` : ''} şirketini analiz et.

Kesinlikle sadece şu formatı kullan, başka hiçbir şey yazma:

BUSINESS: [Ne iş yaptığını 2 cümleyle anlat. Sade, anlaşılır Türkçe.]
SECTOR: [Sektör — örn: Havacılık, Bankacılık, Teknoloji, Perakende]
MOAT: [Rekabet avantajı 1 cümle — varsa somut belirt, yoksa "Sınırlı hendek" de]
PEERS: [3-4 rakip ticker virgülle — örn: PGSUS, TAVHL, AEFES]
RISK: [En kritik 1 risk cümlesi]`;

    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, exchange, prompt })
    });
    const data = await r.json();
    const text = data.result || '';

    const get = (key) => {
      const m = text.match(new RegExp(`${key}:\\s*([^\n]+)`));
      return m ? m[1].trim() : '—';
    };

    const business = get('BUSINESS');
    const sector   = get('SECTOR');
    const moat     = get('MOAT');
    const peers    = get('PEERS').split(',').map(p => p.trim()).filter(Boolean);
    const risk     = get('RISK');

    clearInterval(dotTimer);

    const bodyEl = document.getElementById('snapshotBody');
    if (!bodyEl) return;

    bodyEl.innerHTML = `
      <!-- İş açıklaması -->
      <p style="font-size:12px;color:#ccd6f6;font-family:'IBM Plex Sans',sans-serif;line-height:1.8;margin:0 0 14px">${business}</p>

      <!-- Sektör + Hendek grid -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">
        <div class="snap-col">
          <div class="snap-col-lbl">Sektör</div>
          <div class="snap-col-val">${sector}</div>
        </div>
        <div class="snap-col">
          <div class="snap-col-lbl">Rekabet Avantajı</div>
          <div class="snap-col-val">${moat}</div>
        </div>
      </div>

      <!-- Rakipler -->
      ${peers.length ? `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <span style="font-size:8px;letter-spacing:2px;text-transform:uppercase;color:var(--muted-s,#8892b0);font-family:'IBM Plex Mono',monospace">Rakipler</span>
        ${peers.map(p => `<button class="snap-peer" onclick="qFill('${p}','','${exchange}')">${p}</button>`).join('')}
      </div>` : ''}

      <!-- Risk alert -->
      <div class="snap-alert">⚠ ${risk}</div>
    `;

  } catch(e) {
    clearInterval(dotTimer);
    const bodyEl = document.getElementById('snapshotBody');
    if (bodyEl) bodyEl.innerHTML = `<div style="font-size:10px;color:var(--muted-s);font-family:'IBM Plex Mono',monospace">Profil yüklenemedi.</div>`;
  }
}


// ── 3. X PAYLAŞIM OPTİMİZASYONU ────────────────────────────────
function dlAndTweet() {
  dlShare();
  setTimeout(() => {
    const fw = FW[curFW];
    const d  = analysisData;
    if (!d) return;

    const em         = d.verdict === 'AL' ? '🟢' : d.verdict === 'UZAK_DUR' ? '🔴' : '🟡';
    const fwEmoji    = curFW === 'buffett' ? '🎩' : curFW === 'lynch' ? '📈' : '🌍';
    const key        = `${d.ticker}:${curEX}`;
    const scores     = _masterScores[key] || {};
    const isMaster   = scores.buffett >= 5 && scores.lynch >= 5;
    const verdictTR  = d.verdict === 'AL' ? 'AL' : d.verdict === 'UZAK_DUR' ? 'UZAK DUR' : 'BEKLE';

    const passItems = fw.criteria.filter((_,i) => d.statuses[i]==='pass').map(c=>c.name.split(' ')[0]).slice(0,3);
    const failItems = fw.criteria.filter((_,i) => d.statuses[i]==='fail').map(c=>c.name.split(' ')[0]).slice(0,2);

    const lines = [
      `${fwEmoji} ${curEX}: $${d.ticker}${curCo ? ' — ' + curCo : ''}`,
      `${fw.name} Analizi: ${d.score}/${fw.criteria.length} ${em} ${verdictTR}`,
      isMaster ? '⭐ Master Selection — Buffett + Lynch onayı' : '',
      '',
      passItems.length ? '✅ ' + passItems.join(' · ') : '',
      failItems.length ? '❌ ' + failItems.join(' · ') : '',
      '',
      'Barış Investing ile analiz et 👇',
      'barisinvesting.vercel.app',
      '',
      `#Borsa #Yatırım #${d.ticker} #${curFW==='buffett'?'Buffett':curFW==='lynch'?'Lynch':'Dalio'}`,
    ].filter(l => l !== null).join('\n').trim();

    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(lines)}`, '_blank');
    closeShr();
  }, 800);
}


// ── parseAndRender HOOK ──────────────────────────────────────────
const _origParseAndRender = window.parseAndRender;
window.parseAndRender = function(ticker, company, text, fd, fwKey) {
  _origParseAndRender(ticker, company, text, fd, fwKey);

  const fw    = fwKey || (typeof curFW !== 'undefined' ? curFW : 'buffett');
  const ex    = typeof curEX !== 'undefined' ? curEX : 'BIST';
  const sm    = text.match(/TOTAL_SCORE:\s*(\d+)/);
  const score = sm ? Math.min(7, Math.max(0, parseInt(sm[1]))) : 0;

  trackMasterScore(ticker, ex, fw, score);
  injectCompanySnapshot(ticker, company, ex, fw);
};
