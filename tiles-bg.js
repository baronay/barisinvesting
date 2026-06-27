// ================================================================
// tiles-bg.js — Barış Investing
// Hover ile aydınlanan grid arka plan
// ================================================================

(function () {
  const css = `
    .tiles-bg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-wrap: nowrap;
      z-index: 0;
      overflow: hidden;
      user-select: none;
      pointer-events: auto;
    }
    .tiles-col {
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
      border-left: 1px solid rgba(255,255,255,0.06);
    }
    .tiles-cell {
      flex-shrink: 0;
      border-right: 1px solid rgba(255,255,255,0.06);
      border-top: 1px solid rgba(255,255,255,0.06);
      background: transparent;
      transition: background 1.6s ease;
    }
    .tiles-cell:hover {
      background: var(--accent, #4d8ef0);
      transition: background 0s;
    }
    @media (max-width: 700px) {
      .tiles-bg { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .tiles-cell { transition: none; }
    }
  `;

  if (!document.getElementById('tiles-bg-styles')) {
    const s = document.createElement('style');
    s.id = 'tiles-bg-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function build(container, opts) {
    const size = opts.size || 32;
    const w = container.clientWidth || container.offsetWidth || window.innerWidth;
    const h = container.clientHeight || container.offsetHeight || 260;
    const cols = opts.cols || Math.ceil(w / size) + 2;
    const rows = opts.rows || Math.ceil(h / size) + 2;

    let wrap = container.querySelector('.tiles-bg');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'tiles-bg';
      container.appendChild(wrap);
    }
    wrap.innerHTML = '';

    const frag = document.createDocumentFragment();
    for (let i = 0; i < cols; i++) {
      const col = document.createElement('div');
      col.className = 'tiles-col';
      col.style.width = size + 'px';
      for (let j = 0; j < rows; j++) {
        const cell = document.createElement('div');
        cell.className = 'tiles-cell';
        cell.style.width = size + 'px';
        cell.style.height = size + 'px';
        col.appendChild(cell);
      }
      frag.appendChild(col);
    }
    wrap.appendChild(frag);
  }

  window.renderTilesBg = function (containerId, opts) {
    opts = opts || {};
    const c = document.getElementById(containerId);
    if (!c) return;

    // İlk render bir frame sonra (layout yerleşsin)
    requestAnimationFrame(() => build(c, opts));

    let t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(() => build(c, opts), 200);
    });
  };

  function initAll() {
    document.querySelectorAll('[data-tiles-bg]').forEach(function (el) {
      const opts = {};
      if (el.dataset.tilesRows) opts.rows = parseInt(el.dataset.tilesRows, 10);
      if (el.dataset.tilesCols) opts.cols = parseInt(el.dataset.tilesCols, 10);
      if (el.dataset.tilesSize) opts.size = parseInt(el.dataset.tilesSize, 10);
      if (!el.id) el.id = 'tiles-bg-' + Math.random().toString(36).slice(2, 8);
      window.renderTilesBg(el.id, opts);
    });
  }

  // Script body sonunda yüklendiği için DOMContentLoaded çoktan geçmiş olabilir
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
})();
