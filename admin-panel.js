// ================================================================
// admin-panel.js — Barış Investing
// Kapsam: Admin modal açma/kapama, kullanıcı listesi, istatistikler,
//         hak ekleme, kullanıcı silme, e-posta export, arama
// Bağımlılık: auth-logic.js (getEmail, showToast)
// index.html'de auth-logic.js'den SONRA yükle:
// <script src="/admin-panel.js"></script>
// ================================================================

let _adminSecret  = null; // şifre session boyunca hatırlanır
let _adminAllUsers = [];

// ── Modal aç/kapat ──
function openAdmin() {
  document.getElementById('adminModal').style.display = 'flex';
  loadAdminUsers();
}
function closeAdmin() {
  document.getElementById('adminModal').style.display = 'none';
}

// ── Kullanıcı listesini yükle ──
async function loadAdminUsers() {
  const email  = getEmail();
  const secret = _adminSecret || prompt('Admin şifresi:');
  if (!secret) return;
  _adminSecret = secret;

  const body = document.getElementById('adminUserBody');
  const note = document.getElementById('adminNote');
  if (body) body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--muted2)">Yükleniyor...</td></tr>';

  try {
    const r = await fetch('/api/auth?action=admin_users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, secret })
    });
    const data = await r.json();

    if (data.error) {
      _adminSecret = null;
      if (note) note.textContent = '⚠ ' + data.error;
      if (body) body.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:16px;color:var(--danger)">Yetkisiz erişim</td></tr>';
      return;
    }

    // İstatistikleri doldur
    const s   = data.stats;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val ?? '—'; };
    set('aStatUsers',     s.total);
    set('aStatAnalyze',   s.totalAnalyze);
    set('aStatToday',     s.todayNew);
    set('aStatWeek',      s.weekNew);
    set('aStatActive',    s.activeToday);
    set('aStatCredits',   s.totalCredits);
    set('aStatReferrals', s.totalReferrals);
    set('aStatConsent',   s.marketingConsent);

    if (note) note.textContent = `Toplam ${s.total} kullanıcı · ${s.marketingConsent} mail izni`;

    // E-posta export butonu
    const exportBtn = document.getElementById('adminExportEmailsBtn');
    if (exportBtn) {
      const consentEmails = (data.users || []).filter(u => u.marketing_consent).map(u => u.email);
      exportBtn.style.display = consentEmails.length > 0 ? 'block' : 'none';
      exportBtn.textContent   = `↓ ${consentEmails.length} mail indir`;
      exportBtn.onclick = () => {
        const blob = new Blob([consentEmails.join('\n')], { type: 'text/plain' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = 'barisinvesting_emails.txt';
        a.click();
      };
    }

    _adminAllUsers = data.users || [];
    renderAdminTable(_adminAllUsers, secret);

  } catch (e) {
    if (note) note.textContent = '⚠ Hata: ' + e.message;
  }
}

// ── Tabloyu çiz ──
function renderAdminTable(users, secret) {
  const body = document.getElementById('adminUserBody');
  if (!body) return;
  body.innerHTML = '';

  users.forEach(u => {
    const tr          = document.createElement('tr');
    const joined      = u.joined_at  ? new Date(u.joined_at).toLocaleDateString('tr-TR')  : '—';
    const seen        = u.last_seen  ? new Date(u.last_seen).toLocaleDateString('tr-TR')   : '—';
    const isActive    = u.last_seen && (Date.now() - new Date(u.last_seen).getTime() < 86400000);
    const safeId      = u.email.replace(/[@.]/g, '_');
    const creditColor = (u.credits || 0) <= 1 && !u.is_admin ? 'var(--danger)' : 'var(--accent2)';

    tr.innerHTML = `
      <td>
        <span style="font-family:'IBM Plex Mono',monospace;font-size:10px">${u.email}</span>
        ${u.is_admin         ? '<span style="font-size:8px;padding:1px 4px;background:rgba(184,112,10,0.15);color:var(--warn);border:1px solid rgba(184,112,10,0.3);margin-left:4px">admin</span>' : ''}
        ${u.marketing_consent? '<span style="font-size:10px;color:var(--success);margin-left:3px" title="Mail izni var">✉</span>' : ''}
        ${u.referred_by      ? '<span style="font-size:10px;color:var(--muted2);margin-left:3px" title="Davet ile katıldı">⤷</span>' : ''}
      </td>
      <td style="font-size:10px;color:var(--muted2)">${joined}</td>
      <td style="font-size:10px;color:${isActive ? 'var(--success)' : 'var(--muted2)'}">${seen}</td>
      <td style="text-align:center;font-family:'Playfair Display',serif;font-size:13px">${u.total_used || 0}</td>
      <td style="text-align:center;font-family:'Playfair Display',serif;font-size:13px;color:${creditColor}">${u.is_admin ? '∞' : u.credits}</td>
      <td style="text-align:center;font-size:11px;color:var(--muted2)">${u.ref_count || 0}</td>
      <td>
        <div style="display:flex;gap:4px;align-items:center">
          <input type="number" id="cr_${safeId}"
            style="width:44px;background:var(--bg2);border:1px solid var(--border);padding:3px 5px;font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--text);text-align:center"
            value="3" min="1" max="100"/>
          <button onclick="addCredits('${u.email}','${secret}')"
            style="background:var(--accent2);color:#fff;border:none;padding:3px 8px;cursor:pointer;font-size:9px;font-family:'IBM Plex Mono',monospace">+Ekle</button>
        </div>
      </td>
      <td>
        <button onclick="deleteUser('${u.email}','${secret}')"
          style="background:none;border:1px solid var(--danger);color:var(--danger);padding:3px 7px;cursor:pointer;font-size:9px;font-family:'IBM Plex Mono',monospace">Sil</button>
      </td>
    `;
    body.appendChild(tr);
  });
}

// ── Arama ──
function filterAdminTable(query) {
  const q        = query.toLowerCase().trim();
  const filtered = q ? _adminAllUsers.filter(u => u.email.toLowerCase().includes(q)) : _adminAllUsers;
  renderAdminTable(filtered, _adminSecret);
}

// ── Hak ekle ──
async function addCredits(targetEmail, secret) {
  const safeId  = targetEmail.replace(/[@.]/g, '_');
  const inp     = document.getElementById('cr_' + safeId);
  const credits = parseInt(inp?.value || 3);
  const email   = getEmail();
  try {
    const r = await fetch('/api/auth?action=admin_credits', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, secret, targetEmail, credits })
    });
    const d = await r.json();
    if (d.ok) showToast(`✓ ${targetEmail} → ${d.credits} hak`, 'success');
    else      showToast('⚠ ' + d.error, 'error');
  } catch (e) { showToast('Hata: ' + e.message, 'error'); }
}

// ── Kullanıcı sil ──
async function deleteUser(targetEmail, secret) {
  if (!confirm(`${targetEmail} silinsin mi? Bu işlem geri alınamaz.`)) return;
  const email = getEmail();
  try {
    const r = await fetch('/api/auth?action=admin_delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, secret, targetEmail })
    });
    const d = await r.json();
    if (d.ok) {
      showToast('✓ Kullanıcı silindi', 'success');
      _adminAllUsers = _adminAllUsers.filter(u => u.email !== targetEmail);
      renderAdminTable(_adminAllUsers, secret);
    } else showToast('⚠ ' + d.error, 'error');
  } catch (e) { showToast('Hata: ' + e.message, 'error'); }
}
