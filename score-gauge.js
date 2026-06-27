// ================================================================
// score-gauge.js — Barış Investing
// Yarım daire animasyonlu skor göstergesi
// Terminal estetiği: IBM Plex, gold accent, küçük strength rozeti
//
// Kullanım:
//   renderScoreGauge('scoreGaugeBox', score, max);
//   renderScoreGauge('scoreGaugeBox', 5, 7, { title: 'BUFFETT SKORU' });
// ================================================================

(function () {
  // ── CSS ────────────────────────────────────────────────────────
  const css = `
    .sg-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      padding: 18px 22px 14px;
      position: relative;
      overflow: hidden;
      margin-bottom: 1px;
    }
    .sg-card::after {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      width: 120px;
      height: 100%;
      background: linear-gradient(90deg, transparent, var(--accent-dim, rgba(212,168,67,.06)));
      pointer-events: none;
    }
    .sg-hdr {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
      position: relative;
      z-index: 1;
    }
    .sg-title {
      font-size: 9px;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--muted);
      font-family: 'IBM Plex Mono', monospace;
    }
    .sg-badge {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 1.5px;
      padding: 3px 8px;
      border: 1px solid;
      font-family: 'IBM Plex Mono', monospace;
      text-transform: uppercase;
      opacity: 0;
      animation: sgFade .6s ease .9s forwards;
    }
    .sg-badge.weak {
      color: var(--danger);
      border-color: rgba(239,68,68,.3);
      background: var(--danger-dim, rgba(239,68,68,.08));
    }
    .sg-badge.moderate {
      color: var(--warn);
      border-color: rgba(245,158,11,.3);
      background: var(--warn-dim, rgba(245,158,11,.08));
    }
    .sg-badge.strong {
      color: var(--accent);
      border-color: rgba(212,168,67,.35);
      background: rgba(212,168,67,.08);
    }
    .sg-arc {
      position: relative;
      width: 100%;
      max-width: 260px;
      margin: 0 auto;
    }
    .sg-arc svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .sg-arc-bg {
      fill: none;
      stroke: var(--rule);
      stroke-width: 6;
      opacity: .35;
    }
    .sg-arc-fg {
      fill: none;
      stroke-width: 6;
      stroke-linecap: round;
    }
    .sg-val {
      position: absolute;
      bottom: 2px;
      left: 0;
      right: 0;
      text-align: center;
    }
    .sg-num {
      font-family: 'IBM Plex Serif', serif;
      font-weight: 700;
      line-height: 1;
      color: var(--text);
      letter-spacing: -1px;
      display: inline-flex;
      align-items: baseline;
      overflow: hidden;
      height: 38px;
      font-size: 34px;
    }
    .sg-num .sg-digit {
      display: inline-block;
      animation: sgSlideUp 900ms cubic-bezier(0.33, 1, 0.68, 1) both;
    }
    .sg-num .sg-slash,
    .sg-num .sg-max {
      color: var(--muted);
      font-size: 16px;
      font-family: 'IBM Plex Mono', monospace;
      font-weight: 500;
      opacity: 0;
      animation: sgFade .5s ease .7s forwards;
    }
    .sg-num .sg-slash { margin: 0 4px; }
    .sg-lbl {
      font-size: 8px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--muted);
      font-family: 'IBM Plex Mono', monospace;
      margin-top: 4px;
      opacity: 0;
      animation: sgFade .5s ease .9s forwards;
    }
    @keyframes sgSlideUp {
      from { transform: translateY(100%); opacity: 0; }
      to   { transform: translateY(0); opacity: 1; }
    }
    @keyframes sgFade {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @media (max-width: 600px) {
      .sg-card { padding: 14px 16px 10px; }
      .sg-num { font-size: 28px; height: 32px; }
      .sg-arc { max-width: 220px; }
    }
  `;

  if (!document.getElementById('sg-styles')) {
    const style = document.createElement('style');
    style.id = 'sg-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Strength logic ─────────────────────────────────────────────
  function strengthOf(score, max) {
    const pct = score / max;
    if (pct >= 0.71) return 'strong';   // 5+/7
    if (pct >= 0.43) return 'moderate'; // 3-4/7
    return 'weak';                      // 0-2/7
  }

  const STRENGTH_LBL = {
    weak: 'Zayıf',
    moderate: 'Orta',
    strong: 'Güçlü',
  };

  // Gradient stops — terminal palet
  const STRENGTH_STOPS = {
    weak:     ['#fca5a5', '#ef4444', '#7f1d1d'],
    moderate: ['#fcd34d', '#f59e0b', '#78350f'],
    strong:   ['#f0d997', '#d4a843', '#8a6a25'],
  };

  let _gradCounter = 0;

  // ── Main render ────────────────────────────────────────────────
  window.renderScoreGauge = function (containerId, score, max, opts) {
    opts = opts || {};
    const c = document.getElementById(containerId);
    if (!c) return;

    score = Math.max(0, Math.min(max, Math.round(score)));
    const strength = strengthOf(score, max);
    const stops = STRENGTH_STOPS[strength];
    const gradId = 'sg-grad-' + (++_gradCounter);

    const radius = 45;
    const circumference = 2 * Math.PI * radius;
    const distHalf = circumference / 2;
    const distForValue = (score / max) * -distHalf;

    const stopsHtml = stops.map((color, i) => {
      const offset = ((100 / (stops.length - 1)) * i).toFixed(0) + '%';
      return '<stop offset="' + offset + '" stop-color="' + color + '"/>';
    }).join('');

    const digitsHtml = String(score).split('').map((d, i) =>
      '<span class="sg-digit" style="animation-delay:' + (400 + i * 100) + 'ms">' + d + '</span>'
    ).join('');

    const title = opts.title || 'Analiz Skoru';
    const label = opts.label || (max + ' kriter üzerinden');

    c.innerHTML =
      '<div class="sg-card">' +
        '<div class="sg-hdr">' +
          '<div class="sg-title">' + title + '</div>' +
          '<div class="sg-badge ' + strength + '">' + STRENGTH_LBL[strength] + '</div>' +
        '</div>' +
        '<div class="sg-arc">' +
          '<svg viewBox="0 0 100 55" aria-hidden="true" preserveAspectRatio="xMidYMid meet">' +
            '<defs>' +
              '<linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="0">' +
                stopsHtml +
              '</linearGradient>' +
            '</defs>' +
            '<g transform="translate(50, 50.5)">' +
              '<circle class="sg-arc-bg" r="' + radius + '" ' +
                      'stroke-dasharray="' + distHalf + ' ' + distHalf + '" ' +
                      'stroke-dashoffset="' + (-distHalf) + '"/>' +
              '<circle class="sg-arc-fg" r="' + radius + '" stroke="url(#' + gradId + ')" ' +
                      'stroke-dasharray="' + distHalf + ' ' + distHalf + '" ' +
                      'stroke-dashoffset="0"/>' +
            '</g>' +
          '</svg>' +
          '<div class="sg-val">' +
            '<div class="sg-num">' +
              digitsHtml +
              '<span class="sg-slash">/</span>' +
              '<span class="sg-max">' + max + '</span>' +
            '</div>' +
            '<div class="sg-lbl">' + label + '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Stroke fill animation (empty → score)
    const fg = c.querySelector('.sg-arc-fg');
    if (fg && typeof fg.animate === 'function') {
      fg.animate(
        [
          { strokeDashoffset: '0',                       offset: 0 },
          { strokeDashoffset: '0',                       offset: 0.28 },
          { strokeDashoffset: String(distForValue),      offset: 1 }
        ],
        {
          duration: 1400,
          easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
          fill: 'forwards'
        }
      );
    } else if (fg) {
      // Fallback (eski tarayıcı)
      fg.style.transition = 'stroke-dashoffset 1s cubic-bezier(0.65, 0, 0.35, 1) 0.4s';
      fg.setAttribute('stroke-dashoffset', String(distForValue));
    }
  };
})();
