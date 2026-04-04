// ================================================================
// auth-logic.js — Barış Investing
// Kapsam: Giriş/çıkış, kredi sistemi, portföy bulut sync,
//         referans sistemi, günlük bonus
// index.html'de </body>'den önce şu satırla yükle:
// <script src="/auth-logic.js"></script>
// ================================================================

// ── State ──
let curUser = null;
let guestCredits = parseInt(localStorage.getItem('guest_credits') ?? '3');

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

  const fallback = { email, credits: 3, is_admin: false, total_used: 0, offline: true };

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
  guestCredits = 3;
  localStorage.setItem('guest_credits', '3');
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
  const sec     = document.getElementById('refSection');
  const display = document.getElementById('refCodeDisplay');
  if (!curUser?.ref_code || !sec) return;
  sec.style.display = 'block';
  if (display) display.textContent = curUser.ref_code;
}

function copyRefLink() {
  const code = curUser?.ref_code;
  if (!code) return;
  const link = `${location.origin}?ref=${code}`;
  navigator.clipboard.writeText(link)
    .then(() => showToast('✓ Davet linki kopyalandı!', 'success'))
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
