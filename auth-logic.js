// ================================================================
// auth-logic.js — Barış Investing
// Kapsam: Giriş/çıkış, kredi sistemi, portföy bulut sync,
//         referans sistemi, günlük bonus
// index.html'de </body>'den önce şu satırla yükle:
// <script src="/auth-logic.js"></script>
// ================================================================

// ── State ──
let curUser = null;
let guestCredits = parseInt(localStorage.getItem('guest_credits') ?? '1');

function getEmail() { return curUser?.email || localStorage.getItem('bi_email') || null; }

// ── Referans: URL'de ?ref= varsa kaydet ──
(function () {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) localStorage.setItem('bi_ref', ref);
})();

// ── Kredi UI ──
function updateCreditsUI() {
  const credits = curUser ? curUser.credits : guestCredits;
  const isAdmin = curUser?.is_admin;
  const cv = document.getElementById('sidebarCreditsVal');
  const cb = document.getElementById('sidebarCreditsFill');
  const cw = document.getElementById('creditsWarn');
  if (cv) {
    if (isAdmin) { cv.textContent = '∞'; cv.className = 'user-credits-val unlimited'; }
    else { cv.textContent = credits; cv.className = 'user-credits-val' + (credits <= 1 ? ' low' : ''); }
  }
  if (cb) {
    const pct = isAdmin ? 100 : Math.max(0, (credits / 3) * 100);
    cb.style.width = pct + '%';
    cb.className = 'credits-fill' + (credits <= 1 && !isAdmin ? ' low' : '');
  }
  if (cw) cw.style.display = (!isAdmin && credits <= 1) ? 'block' : 'none';
  const badge = document.getElementById('userCreditsBadge');
  if (badge) badge.textContent = isAdmin ? '∞' : credits + ' hak';
  const anaBtn = document.getElementById('anaBtn');
  if (anaBtn) anaBtn.disabled = (!isAdmin && credits <= 0);
}

// ── Auth Modal ──
function showAuthModal() { document.getElementById('authModal').style.display = 'flex'; }
function hideAuthModal() { document.getElementById('authModal').style.display = 'none'; }

// ── Giriş ──
async function doAuth() {
  const refCode = localStorage.getItem('bi_ref') || null;
  const emailIn = document.getElementById('authEmailIn');
  const errEl = document.getElementById('authErr');
  const marketingEl = document.getElementById('marketingConsent');
  const email = (emailIn?.value || '').trim();
  if (!email || !email.includes('@')) {
    if (errEl) { errEl.textContent = 'Geçerli bir e-posta girin.'; errEl.style.display = 'block'; }
    return;
  }
  const btn = document.querySelector('.auth-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor...'; }
  if (errEl) errEl.style.display = 'none';

  const fallback = { email, credits: 5, is_admin: false, total_used: 0, offline: true };

  try {
    const r = await fetch('/api/auth?action=login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, marketingConsent: marketingEl?.checked ?? false, refCode })
    });
    const data = await r.json();
    if (data.user) {
      curUser = data.user;
      localStorage.removeItem('bi_ref');
      if (data.refBonus)   showToast('🎁 Davet bonusu! +1 ekstra hak kazandın.', 'success');
      if (data.dailyBonus) showToast('☀ Günlük bonus! +1 analiz hakkı eklendi.', 'success');
    } else {
      curUser = fallback;
    }
  } catch {
    curUser = fallback;
  }

  localStorage.setItem('bi_email', email);
  hideAuthModal();
  updateSidebarUserUI();
  updateCreditsUI();
  loadPortfolioFromCloud();
  showRefSection();

  if (curUser.offline)                              showToast('✓ Mail kaydedildi. Çevrimdışı mod.', 'warn');
  else if (curUser.credits === 3 && !curUser.total_used) showToast('✓ Hoş geldin! 3 analiz hakkın hazır.', 'success');
  else                                              showToast(`✓ Tekrar hoş geldin! ${curUser.credits} hakkın var.`, 'success');

  if (btn) { btn.disabled = false; btn.textContent = 'Giriş Yap'; }
}

function skipAuth() {
  hideAuthModal();
  sessionStorage.setItem('auth_skipped', '1');
  showToast('Misafir olarak devam ediyorsunuz. 3 analiz hakkınız var.', 'warn');
}

function logout() {
  curUser = null;
  localStorage.removeItem('bi_email');
  guestCredits = 1;
  localStorage.setItem('guest_credits', '1');
  document.getElementById('refSection') && (document.getElementById('refSection').style.display = 'none');
  updateCreditsUI();
  updateSidebarUserUI();
  showToast('Çıkış yapıldı.', 'warn');
}

// ── Sidebar kullanıcı UI ──
function updateSidebarUserUI() {
  const userSec  = document.getElementById('sidebarUserSec');
  const loginBtn = document.getElementById('sidebarLoginBtn');
  const emailEl  = document.getElementById('sidebarUserEmail');
  const adminBtn = document.getElementById('sidebarAdminBtn');
  const avatarEl = document.getElementById('sidebarAvatar');
  const email    = curUser?.email || localStorage.getItem('bi_email');

  if (email) {
    if (userSec)  userSec.style.display  = 'block';
    if (loginBtn) loginBtn.style.display = 'none';
    if (emailEl)  emailEl.textContent    = email;
    if (adminBtn) adminBtn.style.display = curUser?.is_admin ? 'block' : 'none';
    if (avatarEl) { avatarEl.textContent = email[0].toUpperCase(); avatarEl.title = email; avatarEl.style.display = 'flex'; }
  } else {
    if (userSec)  userSec.style.display  = 'none';
    if (loginBtn) loginBtn.style.display = 'flex';
    if (adminBtn) adminBtn.style.display = 'none';
    if (avatarEl) avatarEl.style.display = 'none';
  }
  updateCreditsUI();
  if (typeof updateMobileAccountUI === 'function') updateMobileAccountUI();
}

// ── Toast ──
function showToast(msg, type = 'success') {
  let t = document.getElementById('toastEl');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toastEl';
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);padding:9px 16px;font-size:11px;font-family:"IBM Plex Mono",monospace;border:1px solid;z-index:9999;transition:opacity 0.4s;pointer-events:none;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;opacity:0';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  const styles = {
    success: 'background:#f4f1ec;color:var(--success,#1a6b3a);border-color:rgba(26,107,58,0.3)',
    warn:    'background:#f4f1ec;color:var(--warn,#b8700a);border-color:rgba(184,112,10,0.3)',
    error:   'background:#f4f1ec;color:var(--danger,#c0392b);border-color:rgba(192,57,43,0.3)'
  };
  t.style.cssText += ';' + (styles[type] || styles.success);
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// ── Portföy bulut sync ──
let portfolioSaveTimer = null;

async function savePortfolioToCloud() {
  const email = getEmail();
  if (!email) return;
  try {
    await fetch('/api/auth?action=save_portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, portfolio })
    });
  } catch {}
}

function triggerPortfolioSave() {
  localStorage.setItem('bi_portfolio', JSON.stringify(portfolio));
  clearTimeout(portfolioSaveTimer);
  portfolioSaveTimer = setTimeout(() => savePortfolioToCloud(), 1500);
}

async function loadPortfolioFromCloud() {
  const email = getEmail();
  if (!email) {
    const saved = localStorage.getItem('bi_portfolio');
    if (saved) { try { portfolio = JSON.parse(saved); if (typeof renderPt === 'function') renderPt(); } catch {} }
    return;
  }
  try {
    const r = await fetch('/api/auth?action=load_portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await r.json();
    if (data.portfolio && Array.isArray(data.portfolio)) {
      portfolio = data.portfolio;
      if (typeof renderPt === 'function') renderPt();
      if (data.updatedAt) {
        const el = document.getElementById('ptCloudSync');
        if (el) el.textContent = '☁ ' + new Date(data.updatedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      }
    }
  } catch {}
}

// ── Analiz hakkı kullan ──
async function consumeCredit() {
  const email = getEmail();
  if (email && curUser) {
    try {
      const r = await fetch('/api/auth?action=use', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      if (!r.ok) return { ok: true };
      const d = await r.json();
      if (d.error) return { ok: false, error: d.error };
      curUser.credits = d.credits;
      updateCreditsUI();
      return { ok: true };
    } catch {
      return { ok: true };
    }
  } else {
    if (guestCredits <= 0) return { ok: false, error: 'Analiz hakkınız doldu. E-posta ile kaydolarak daha fazla hak kazanın.' };
    guestCredits--;
    localStorage.setItem('guest_credits', guestCredits);
    updateCreditsUI();
    return { ok: true };
  }
}

// ── Referans bölümü ──
function showRefSection() {
  if (!curUser?.ref_code) return;

  const old = document.getElementById('refCardInject');
  if (old) old.remove();

  if (!document.getElementById('refCardStyle')) {
    const style = document.createElement('style');
    style.id = 'refCardStyle';
    style.textContent = `
      @keyframes refSlideIn {
        from { opacity:0; transform: translateY(-6px); }
        to   { opacity:1; transform: translateY(0); }
      }
      #refCardInject { animation: refSlideIn 0.35s ease forwards; }
      #refCardInject:hover { border-color: rgba(168,184,216,0.4) !important; }
      #refCardInject .ref-copy-btn:hover { background: rgba(168,184,216,0.2) !important; color:#ccd6f6 !important; }
    `;
    document.head.appendChild(style);
  }

  const refCount = curUser.ref_count || 0;
  const card = document.createElement('div');
  card.id = 'refCardInject';
  // ── Kompakt CTA şerit widget ──
  card.style.cssText = [
    'display:flex',
    'align-items:stretch',
    'gap:0',
    'margin-top:14px',
    'max-width:580px',
    'background:#1a1f2e',
    'border:1px solid rgba(168,184,216,0.18)',
    'overflow:hidden',
    'transition:border-color 0.2s',
  ].join(';');

  // Sol ikon bloğu
  const iconCol = document.createElement('div');
  iconCol.style.cssText = 'padding:0 14px;background:#2451a3;display:flex;align-items:center;justify-content:center;flex-shrink:0;min-height:48px;';
  iconCol.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

  // Orta metin bloğu
  const textCol = document.createElement('div');
  textCol.style.cssText = 'flex:1;min-width:0;padding:9px 12px;border-left:1px solid rgba(168,184,216,0.10);';
  const subText = refCount > 0
    ? '\u2713 ' + refCount + ' davet \u00b7 +' + (refCount * 2) + ' hak kazand\u0131n'
    : 'Hen\u00fcz davet yok \u2014 ilk davetini yap!';
  textCol.innerHTML =
    '<div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;color:#a8b8d8;font-family:\'IBM Plex Mono\',monospace;font-weight:600;margin-bottom:2px;">ARKADAŞINI DAVET ET — SEN +2, O +1 HAK KAZANIR</div>' +
    '<div style="font-size:9px;color:#6b7a99;font-family:\'IBM Plex Mono\',monospace;">' + subText + '</div>';

  // Referans kodu bloğu
  const codeCol = document.createElement('div');
  codeCol.style.cssText = 'font-family:\'IBM Plex Mono\',monospace;font-size:12px;font-weight:600;color:#ccd6f6;letter-spacing:2px;padding:0 12px;border-left:1px solid rgba(168,184,216,0.10);display:flex;align-items:center;min-height:48px;flex-shrink:0;';
  codeCol.textContent = curUser.ref_code;

  // Kopyala butonu
  const copyBtn = document.createElement('button');
  copyBtn.className = 'ref-copy-btn';
  copyBtn.onclick = copyRefLink;
  copyBtn.style.cssText = 'background:#2451a3;border:none;border-left:1px solid rgba(255,255,255,0.10);color:#fff;font-family:\'IBM Plex Mono\',monospace;font-size:9px;font-weight:600;padding:0 14px;cursor:pointer;white-space:nowrap;letter-spacing:1px;text-transform:uppercase;min-height:48px;transition:background 0.15s;';
  copyBtn.textContent = 'Kopyala';
  copyBtn.onmouseover = function() { this.style.background = '#1a3a6b'; };
  copyBtn.onmouseout  = function() { this.style.background = '#2451a3'; };

  card.appendChild(iconCol);
  card.appendChild(textCol);
  card.appendChild(codeCol);
  card.appendChild(copyBtn);

  // hero-ex-row'un altına ekle (ANALİZ ET butonunun olduğu satır altı)
  const heroExRow = document.querySelector('.hero-ex-row');
  if (heroExRow) {
    heroExRow.after(card);
  } else {
    const anaBtn = document.getElementById('anaBtn');
    if (anaBtn) anaBtn.parentNode.insertBefore(card, anaBtn.nextSibling);
  }

  const old2 = document.getElementById('refSection');
  if (old2) old2.style.display = 'none';
}

function copyRefLink() {
  const code = curUser?.ref_code;
  if (!code) return;
  const link = `${location.origin}?ref=${code}`;
  navigator.clipboard.writeText(link)
    .then(() => {
      if (typeof showToast === 'function') showToast('✓ Davet linki kopyalandı!');
      const btn = document.querySelector('#refCardInject .ref-copy-btn');
      if (btn) { btn.textContent = '✓ Kopyalandı'; setTimeout(() => { btn.textContent = 'Kopyala'; }, 2000); }
    })
    .catch(() => prompt('Davet linkini kopyala:', link));
}

// ── Auth init (sayfa yüklenince) ──
(async () => {
  const savedEmail = localStorage.getItem('bi_email');
  if (savedEmail) {
    try {
      const r = await fetch('/api/auth?action=me', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: savedEmail })
      });
      const data = await r.json();
      curUser = data.user || { email: savedEmail, credits: guestCredits, is_admin: false, offline: true };
    } catch {
      curUser = { email: savedEmail, credits: guestCredits, is_admin: false, offline: true };
    }
    updateSidebarUserUI();
    loadPortfolioFromCloud();
    showRefSection();
  } else {
    updateSidebarUserUI();
    loadPortfolioFromCloud();
    if (!sessionStorage.getItem('auth_skipped')) {
      setTimeout(() => showAuthModal(), 1200);
    }
  }
})();
