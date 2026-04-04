// ================================================================
// analyze-features.js — Barış Investing
// Kapsam:
//   1. Master Selection / Strong Consensus rozeti
//   2. Şirket Snapshot kartı (analiz altına)
//   3. X paylaşım optimizasyonu (tweet taslağı)
//
// index.html'de admin-panel.js'den SONRA yükle:
// <script src="/analyze-features.js"></script>
// ================================================================

// ── 1. MASTER SELECTION ROZETİ ──────────────────────────────────
// Her analiz tamamlandığında çağrılır.
// Hem Buffett hem Lynch aynı hisse için ≥5/7 aldıysa rozet gösterir.

const _masterScores = {}; // { "TICKER:EXCHANGE": { buffett: N, lynch: N, dalio: N } }

function trackMasterScore(ticker, exchange, fw, score) {
  const key = `${ticker}:${exchange}`;
  if (!_masterScores[key]) _masterScores[key] = {};
  _masterScores[key][fw] = score;
  checkMasterBadge(ticker, exchange);
}

function checkMasterBadge(ticker, exchange) {
  const key   = `${ticker}:${exchange}`;
  const scores = _masterScores[key] || {};
  const b = scores.buffett ?? -1;
  const l = scores.lynch   ?? -1;
  const d = scores.dalio   ?? -1;

  // Master Selection: Buffett + Lynch ikisi de ≥5
  const isMaster   = b >= 5 && l >= 5;
  // Strong Consensus: üçü de ≥4
  const isConsensus = b >= 4 && l >= 4 && d >= 4;

  // Eski rozeti kaldır
  const old = document.getElementById('masterBadge');
  if (old) old.remove();

  if (!isMaster && !isConsensus) return;

  const badge = document.createElement('div');
  badge.id = 'masterBadge';

  if (isMaster) {
    badge.style.cssText = `
      display:inline-flex;align-items:center;gap:7px;
      padding:8px 14px;margin:12px 0 4px;
      background:linear-gradient(135deg,rgba(154,125,58,0.18),rgba(212,175,55,0.08));
      border:1px solid rgba(154,125,58,0.45);border-radius:4px;
      animation:masterPulse 2s ease-in-out 2;
    `;
    badge.innerHTML = `
      <span style="font-size:16px">⭐</span>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#c8a951;font-family:'IBM Plex Mono',monospace">Master Selection</div>
        <div style="font-size:9px;color:#9a7d3a;font-family:'IBM Plex Mono',monospace;margin-top:1px">Buffett ${b}/7 · Lynch ${l}/7 — Çift ekol onayı</div>
      </div>
    `;
  } else {
    badge.style.cssText = `
      display:inline-flex;align-items:center;gap:7px;
      padding:8px 14px;margin:12px 0 4px;
      background:rgba(36,81,163,0.1);
      border:1px solid rgba(168,184,216,0.3);border-radius:4px;
    `;
    badge.innerHTML = `
      <span style="font-size:16px">✦</span>
      <div>
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#a8b8d8;font-family:'IBM Plex Mono',monospace">Strong Consensus</div>
        <div style="font-size:9px;color:#8892b0;font-family:'IBM Plex Mono',monospace;margin-top:1px">Buffett ${b}/7 · Lynch ${l}/7 · Dalio ${d}/7</div>
      </div>
    `;
  }

  // Verdict box'ın altına ekle
  const vbox = document.getElementById('verdictBox');
  if (vbox) vbox.after(badge);
}

// CSS animasyonu
(function() {
  const s = document.createElement('style');
  s.textContent = `
    @keyframes masterPulse {
      0%,100% { box-shadow:0 0 0 0 rgba(154,125,58,0); }
      50%      { box-shadow:0 0 0 8px rgba(154,125,58,0.12); }
    }
  `;
  document.head.appendChild(s);
})();


// ── 2. ŞİRKET SNAPSHOT KARTI ────────────────────────────────────
// Analiz tamamlandığında AI'dan şirket özeti çeker ve altına koyar.

async function injectCompanySnapshot(ticker, company, exchange, fwKey) {
  // Eski kartı kaldır
  const old = document.getElementById('snapshotCard');
  if (old) old.remove();

  // Placeholder göster
  const card = document.createElement('div');
  card.id = 'snapshotCard';
  card.style.cssText = `
    margin-top:16px;padding:16px 20px;
    background:var(--surface2,#f9f7f3);
    border:1px solid var(--border,#d4cfc6);
    border-left:3px solid var(--accent2,#2451a3);
  `;
  card.innerHTML = `
    <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:var(--muted2);font-family:'IBM Plex Mono',monospace;margin-bottom:10px">
      ŞİRKET PROFİLİ
    </div>
    <div id="snapshotContent" style="font-size:11px;color:var(--muted2);font-family:'IBM Plex Mono',monospace">
      Yükleniyor...
    </div>
  `;

  const analysisSection = document.getElementById('analysisSection');
  if (!analysisSection) return;
  analysisSection.appendChild(card);

  // AI'dan şirket özeti al
  try {
    const apiKey = ''; // Anthropic API key burada yok — analyze endpoint'ini kullanıyoruz
    const prompt = `${exchange} borsasındaki "${ticker}"${company ? ` (${company})` : ''} şirketi hakkında kısa bir profil oluştur.

Şu formatta yanıt ver:

BUSINESS: [Şirketin ne iş yaptığını 2 cümleyle anlat. Sade Türkçe.]
SECTOR: [Sektör adı — örn: Havacılık, Bankacılık, Teknoloji]
MOAT: [Rekabet avantajı var mı? 1 cümle.]
PEERS: [3-4 rakip şirket ticker'ı virgülle ayır — örn: THYAO, PEGASUS, AEFES]
RISK: [En önemli tek risk. 1 cümle.]

Sadece bu formatı kullan, başka hiçbir şey yazma.`;

    const r = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker, exchange, prompt })
    });
    const data = await r.json();
    const text = data.result || '';

    const get = (key) => {
      const m = text.match(new RegExp(`${key}:\\s*([^\\n]+)`));
      return m ? m[1].trim() : '—';
    };

    const business = get('BUSINESS');
    const sector   = get('SECTOR');
    const moat     = get('MOAT');
    const peers    = get('PEERS');
    const risk     = get('RISK');

    document.getElementById('snapshotContent').innerHTML = `
      <div style="margin-bottom:10px;line-height:1.8;color:var(--text,#1a1a1a);font-size:12px;font-family:'IBM Plex Sans',sans-serif">
        ${business}
      </div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px">
        <div style="background:var(--surface,#fff);border:1px solid var(--border);padding:8px 10px">
          <div style="font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:3px">Sektör</div>
          <div style="font-size:11px;color:var(--text);font-weight:600">${sector}</div>
        </div>
        <div style="background:var(--surface,#fff);border:1px solid var(--border);padding:8px 10px">
          <div style="font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2);margin-bottom:3px">Rekabet Avantajı</div>
          <div style="font-size:11px;color:var(--text)">${moat}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <span style="font-size:8px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted2)">Rakipler:</span>
        ${peers.split(',').map(p => p.trim()).filter(Boolean).map(p =>
          `<span style="font-size:9px;padding:2px 7px;background:var(--bg2,#ede9e1);border:1px solid var(--border);color:var(--accent2);font-family:'IBM Plex Mono',monospace;cursor:pointer" onclick="qFill('${p.trim()}','','${exchange}')">${p.trim()}</span>`
        ).join('')}
      </div>
      <div style="font-size:10px;color:var(--danger,#c0392b);font-family:'IBM Plex Sans',sans-serif">
        ⚠ ${risk}
      </div>
    `;
  } catch(e) {
    document.getElementById('snapshotContent').textContent = 'Şirket profili yüklenemedi.';
  }
}


// ── 3. X PAYLAŞIM OPTİMİZASYONU ────────────────────────────────
// Mevcut dlAndTweet'i override eder — daha zengin tweet taslağı

function dlAndTweet() {
  dlShare(); // önce indir

  setTimeout(() => {
    const fw = FW[curFW];
    const d  = analysisData;
    if (!d) return;

    const em = d.verdict === 'AL' ? '🟢' : d.verdict === 'UZAK_DUR' ? '🔴' : '🟡';
    const fwEmoji = curFW === 'buffett' ? '🎩' : curFW === 'lynch' ? '📈' : '🌍';

    const passItems = fw.criteria
      .filter((_, i) => d.statuses[i] === 'pass')
      .map(c => c.name.split(' ')[0])
      .slice(0, 3);

    const failItems = fw.criteria
      .filter((_, i) => d.statuses[i] === 'fail')
      .map(c => c.name.split(' ')[0])
      .slice(0, 2);

    // Master badge var mı?
    const key = `${d.ticker}:${curEX}`;
    const scores = _masterScores[key] || {};
    const isMaster = (scores.buffett >= 5 && scores.lynch >= 5);
    const masterLine = isMaster ? '\n⭐ Master Selection — Buffett + Lynch onayı' : '';

    const verdictLabel = d.verdict === 'AL' ? 'AL' : d.verdict === 'UZAK_DUR' ? 'UZAK DUR' : 'BEKLE';

    const tweetText = [
      `${fwEmoji} ${curEX}: $${d.ticker}${curCo ? ' — ' + curCo : ''}`,
      `${fw.name} Analizi: ${d.score}/${fw.criteria.length} ${em} ${verdictLabel}`,
      masterLine,
      '',
      passItems.length ? '✅ ' + passItems.join(' · ') : '',
      failItems.length ? '❌ ' + failItems.join(' · ') : '',
      '',
      'Barış Investing ile analiz et 👇',
      'barisinvesting.vercel.app',
      '',
      `#Borsa #Yatırım #${d.ticker} #${curFW === 'buffett' ? 'Buffett' : curFW === 'lynch' ? 'Lynch' : 'Dalio'}`,
    ].filter(l => l !== null).join('\n').trim();

    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`,
      '_blank'
    );
    closeShr();
  }, 800);
}


// ── parseAndRender HOOK ─────────────────────────────────────────
// Mevcut parseAndRender'ı wrap ederek rozet ve snapshot'ı ekler.
// index.html'deki orijinal fonksiyon bozulmaz.

const _origParseAndRender = window.parseAndRender;
window.parseAndRender = function(ticker, company, text, fd, fwKey) {
  // Orijinali çalıştır
  _origParseAndRender(ticker, company, text, fd, fwKey);

  const fw    = fwKey || (typeof curFW !== 'undefined' ? curFW : 'buffett');
  const sm    = text.match(/TOTAL_SCORE:\s*(\d+)/);
  const score = sm ? Math.min(7, Math.max(0, parseInt(sm[1]))) : 0;
  const ex    = typeof curEX !== 'undefined' ? curEX : 'BIST';

  // Master skoru kaydet ve rozet kontrol et
  trackMasterScore(ticker, ex, fw, score);

  // Şirket snapshot'ı yükle
  injectCompanySnapshot(ticker, company, ex, fw);
};
