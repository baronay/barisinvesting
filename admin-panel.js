// ================================================================
// admin-panel.js — Barış Investing
// ================================================================

let _adminSecret   = null;
let _adminAllUsers = [];
let _tezSecret     = null;

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
        ${u.is_admin          ? '<span style="font-size:8px;padding:1px 4px;background:rgba(184,112,10,0.15);color:var(--warn);border:1px solid rgba(184,112,10,0.3);margin-left:4px">admin</span>' : ''}
        ${u.marketing_consent ? '<span style="font-size:10px;color:var(--success);margin-left:3px" title="Mail izni var">✉</span>' : ''}
        ${u.referred_by       ? '<span style="font-size:10px;color:var(--muted2);margin-left:3px" title="Davet ile katıldı">⤷</span>' : ''}
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

// ── TEZ EDİTÖRÜ ──────────────────────────────────────────────────

let _tezKapakUrl = null; // upload sonrası URL burada tutulur

async function openTezEditor() {
  _tezSecret = prompt('Tez editörü şifresi:');
  if (!_tezSecret) return;

  const eski = document.getElementById('tezEditorModal');
  if (eski) eski.remove();
  _tezKapakUrl = null;

  const modal = document.createElement('div');
  modal.id = 'tezEditorModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:10000;display:flex;align-items:stretch;justify-content:center;padding:16px;overflow:hidden;';

  modal.innerHTML = `
    <div style="background:#0e1220;border:1px solid rgba(77,142,240,0.25);border-radius:12px;width:100%;max-width:900px;display:flex;flex-direction:column;overflow:hidden;">
      <!-- STICKY HEADER -->
      <div style="flex-shrink:0;display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid rgba(255,255,255,0.07);">
        <h2 style="font-size:15px;font-weight:700;color:#e8edf8;font-family:'IBM Plex Serif',serif;">&#9997; Tez Editörü</h2>
        <button onclick="document.getElementById('tezEditorModal').remove()" style="background:none;border:none;color:#5a6a8a;cursor:pointer;font-size:22px;line-height:1;">&#215;</button>
      </div>
      <!-- SCROLLABLE BODY -->
      <div style="flex:1;overflow-y:auto;padding:20px;min-height:0;">

      <!-- LISTE ALANI -->
      <div id="tezListeArea">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-size:11px;color:#5a6a8a;font-family:'IBM Plex Mono',monospace;">MEVCUT TEZLER</span>
          <button onclick="tezFormAc(null)" style="background:rgba(77,142,240,0.15);border:1px solid rgba(77,142,240,0.3);color:#4d8ef0;font-size:11px;padding:5px 12px;border-radius:6px;cursor:pointer;">+ Yeni Tez</button>
        </div>
        <div id="tezListeIcerik" style="color:#5a6a8a;font-size:12px;">Yükleniyor...</div>
      </div>

      <!-- FORM ALANI -->
      <div id="tezFormArea" style="display:none;">
        <div style="font-size:11px;color:#5a6a8a;font-family:'IBM Plex Mono',monospace;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
          <span id="tezFormBaslik">YENİ TEZ</span>
          <button onclick="tezListeYukle()" style="background:none;border:none;color:#5a6a8a;cursor:pointer;font-size:11px;">&#8592; Listeye dön</button>
        </div>
        <input type="hidden" id="tezFormId"/>

        <!-- Satır 1: Başlık + Ticker -->
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="font-size:10px;color:#5a6a8a;display:block;margin-bottom:4px;letter-spacing:1px;">BAŞLIK</label>
            <input id="tezBaslik" style="width:100%;background:#13182a;border:1px solid rgba(255,255,255,0.1);color:#e8edf8;padding:8px 10px;border-radius:6px;font-size:13px;" placeholder="Tez başlığı"/>
          </div>
          <div>
            <label style="font-size:10px;color:#5a6a8a;display:block;margin-bottom:4px;letter-spacing:1px;">TICKER</label>
            <input id="tezTicker" style="width:100%;background:#13182a;border:1px solid rgba(255,255,255,0.1);color:#e8edf8;padding:8px 10px;border-radius:6px;font-size:13px;font-family:'IBM Plex Mono',monospace;text-transform:uppercase;" placeholder="THYAO"/>
          </div>
        </div>

        <!-- Satır 2: Sinyal + Kapak Görseli -->
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:12px;margin-bottom:12px;">
          <div>
            <label style="font-size:10px;color:#5a6a8a;display:block;margin-bottom:4px;letter-spacing:1px;">SİNYAL</label>
            <select id="tezSinyal" style="width:100%;background:#13182a;border:1px solid rgba(255,255,255,0.1);color:#e8edf8;padding:8px 10px;border-radius:6px;font-size:13px;">
              <option value="">—</option>
              <option value="AL">AL</option>
              <option value="IZLE">İZLE</option>
              <option value="NOTR">NÖTR</option>
              <option value="KACIN">KAÇIN</option>
            </select>
          </div>
          <div>
            <label style="font-size:10px;color:#5a6a8a;display:block;margin-bottom:4px;letter-spacing:1px;">KAPAK GÖRSELİ</label>
            <div style="display:flex;gap:8px;align-items:center;">
              <!-- Gizli file input -->
              <input type="file" id="tezKapakFile" accept="image/*" style="display:none;" onchange="tezKapakOnizle(this)"/>
              <button onclick="document.getElementById('tezKapakFile').click()" style="background:rgba(77,142,240,0.1);border:1px solid rgba(77,142,240,0.3);color:#4d8ef0;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap;">
                📁 Görsel Seç
              </button>
              <span id="tezKapakDurum" style="font-size:11px;color:#5a6a8a;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Henüz seçilmedi</span>
            </div>
            <!-- Preview + mevcut URL göstergesi -->
            <div id="tezKapakPreviewWrap" style="margin-top:8px;display:none;align-items:center;">
              <img id="tezKapakPreview" style="height:56px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);object-fit:cover;max-width:140px;" />
              <button onclick="tezKapakTemizle()" style="background:none;border:none;color:#f05252;cursor:pointer;font-size:11px;margin-left:8px;">✕ Kaldır</button>
            </div>
            <!-- Mevcut kayıtlı URL -->
            <input type="hidden" id="tezKapakMevcut"/>
          </div>
        </div>

        <!-- Özet -->
        <div style="margin-bottom:12px;">
          <label style="font-size:10px;color:#5a6a8a;display:block;margin-bottom:4px;letter-spacing:1px;">ÖZET</label>
          <textarea id="tezOzet" rows="2" style="width:100%;background:#13182a;border:1px solid rgba(255,255,255,0.1);color:#e8edf8;padding:8px 10px;border-radius:6px;font-size:13px;resize:vertical;" placeholder="Kısa özet..."></textarea>
        </div>

        <!-- İçerik -->
        <div style="margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <label style="font-size:10px;color:#5a6a8a;letter-spacing:1px;">İÇERİK (HTML destekler)</label>
            <button onclick="tezIcerikTemizle()" title="\\n karakterlerini temizle" style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);color:#f59e0b;font-size:10px;padding:2px 8px;border-radius:4px;cursor:pointer;">🧹 \\n Temizle</button>
          </div>
          <textarea id="tezIcerik" rows="16" style="width:100%;box-sizing:border-box;background:#13182a;border:1px solid rgba(255,255,255,0.1);color:#e8edf8;padding:10px 12px;border-radius:6px;font-size:12px;resize:vertical;font-family:'IBM Plex Mono',monospace;line-height:1.7;white-space:pre-wrap;word-break:break-word;overflow-wrap:break-word;" placeholder="Tez içeriği... (HTML etiketleri kullanılabilir)"></textarea>
        </div>

        <!-- Yayında -->
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="tezYayinda" style="width:14px;height:14px;"/>
            <span style="font-size:12px;color:#e8edf8;">Yayında</span>
          </label>
        </div>

        <!-- Butonlar -->
        <div style="display:flex;gap:8px;">
          <button onclick="tezKaydet()" style="background:#4d8ef0;border:none;color:#fff;padding:10px 22px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Kaydet</button>
          <button id="tezSilBtn" onclick="tezSil()" style="display:none;background:none;border:1px solid #f05252;color:#f05252;padding:10px 20px;border-radius:6px;cursor:pointer;font-size:13px;">Sil</button>
          <span id="tezKaydetDurum" style="font-size:12px;color:#5a6a8a;align-self:center;margin-left:8px;"></span>
        </div>
      </div><!-- /tezFormArea -->

      </div><!-- /scrollable body -->
    </div>
  `;

  document.body.appendChild(modal);
  await tezListeYukle();
}

// Kapak görseli dosya seçilince önizleme
function tezKapakOnizle(input) {
  const file = input.files[0];
  if (!file) return;
  const durum = document.getElementById('tezKapakDurum');
  const wrap  = document.getElementById('tezKapakPreviewWrap');
  const img   = document.getElementById('tezKapakPreview');
  durum.textContent = file.name;
  durum.style.color = '#22c55e';
  const reader = new FileReader();
  reader.onload = e => {
    img.src = e.target.result;
    wrap.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function tezKapakTemizle() {
  document.getElementById('tezKapakFile').value = '';
  document.getElementById('tezKapakDurum').textContent = 'Henüz seçilmedi';
  document.getElementById('tezKapakDurum').style.color = '#5a6a8a';
  document.getElementById('tezKapakPreviewWrap').style.display = 'none';
  document.getElementById('tezKapakMevcut').value = '';
  _tezKapakUrl = null;
}

// \n karakterlerini içerikten temizle
function tezIcerikTemizle() {
  const ta = document.getElementById('tezIcerik');
  if (!ta) return;
  // Literal \n string'ini gerçek newline'a çevir, sonra çift boş satırları tek'e indir
  ta.value = ta.value
    .replace(/\\n\\n/g, '\n\n')
    .replace(/\\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  showToast('✓ \\n karakterleri temizlendi');
}

// Kapak görselini upload et, URL döndür
async function tezKapakUpload() {
  const input = document.getElementById('tezKapakFile');
  const file  = input?.files[0];
  if (!file) return null; // yeni dosya yoksa null dön

  const durum = document.getElementById('tezKaydetDurum');
  if (durum) durum.textContent = 'Görsel yükleniyor...';

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async e => {
      try {
        const r = await fetch('/api/tez-admin?action=upload_image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tezSecret },
          body: JSON.stringify({ filename: file.name, base64: e.target.result })
        });
        const d = await r.json();
        if (d.url) resolve(d.url);
        else reject(new Error(d.error || 'Upload başarısız'));
      } catch(err) {
        reject(err);
      }
    };
    reader.readAsDataURL(file);
  });
}

// Global tez haritası — onclick'te JSON.stringify kullanmamak için
let _tezMap = {};

async function tezListeYukle() {
  document.getElementById('tezFormArea').style.display = 'none';
  document.getElementById('tezListeArea').style.display = 'block';
  const el = document.getElementById('tezListeIcerik');
  el.innerHTML = 'Yukleniyor...';

  try {
    const r = await fetch('/api/tez-admin', {
      headers: { Authorization: 'Bearer ' + _tezSecret }
    });
    const tezler = await r.json();

    if (!Array.isArray(tezler) || !tezler.length) {
      el.innerHTML = '<div style="color:#3d4f6e;font-size:12px;">Henuz tez yok.</div>';
      return;
    }

    // ID → nesne haritası — onclick'te sadece ID geçiyoruz
    _tezMap = {};
    tezler.forEach(t => { _tezMap[t.id] = t; });

    el.innerHTML = tezler.map(t => {
      const baslik = (t.baslik || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const ticker = (t.ticker || '').replace(/</g,'&lt;');
      return `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#13182a;border-radius:6px;margin-bottom:6px;border:1px solid rgba(255,255,255,0.06);">
        <div style="flex:1;min-width:0;overflow:hidden;">
          <span style="font-size:13px;color:#e8edf8;font-weight:500;">${baslik}</span>
          ${t.ticker ? `<span style="font-size:10px;color:#4d8ef0;margin-left:6px;font-family:IBM Plex Mono,monospace;">${ticker}</span>` : ''}
          <span style="font-size:10px;color:${t.yayinda ? '#22c55e' : '#5a6a8a'};margin-left:6px;">${t.yayinda ? '● Yayında' : '○ Taslak'}</span>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;margin-left:12px;">
          <button onclick="tezFormAcId(${t.id})" style="background:rgba(77,142,240,0.1);border:1px solid rgba(77,142,240,0.2);color:#4d8ef0;font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;">Düzenle</button>
          <button onclick="tezSilDogrudan(${t.id})" style="background:none;border:1px solid rgba(240,82,82,0.3);color:#f05252;font-size:11px;padding:4px 10px;border-radius:4px;cursor:pointer;">Sil</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="color:#f05252;font-size:12px;">Hata: ' + e.message + '</div>';
  }
}

// ID üzerinden tezFormAc — onclick'te güvenli
function tezFormAcId(id) {
  const tez = _tezMap[id];
  if (tez) tezFormAc(tez);
}

function tezFormAc(tez) {
  document.getElementById('tezListeArea').style.display = 'none';
  document.getElementById('tezFormArea').style.display = 'block';
  _tezKapakUrl = null;

  // Kapak alanını sıfırla
  const kapakFile  = document.getElementById('tezKapakFile');
  const kapakDurum = document.getElementById('tezKapakDurum');
  const kapakWrap  = document.getElementById('tezKapakPreviewWrap');
  const kapakImg   = document.getElementById('tezKapakPreview');
  const kapakMevcut= document.getElementById('tezKapakMevcut');
  if (kapakFile)   kapakFile.value = '';
  if (kapakWrap)   kapakWrap.style.display = 'none';

  if (tez) {
    document.getElementById('tezFormBaslik').textContent = 'TEZ DÜZENLE';
    document.getElementById('tezFormId').value    = tez.id;
    document.getElementById('tezBaslik').value    = tez.baslik || '';
    document.getElementById('tezTicker').value    = tez.ticker || '';
    document.getElementById('tezSinyal').value    = tez.sinyal || '';
    document.getElementById('tezOzet').value      = tez.ozet || '';
    document.getElementById('tezIcerik').value    = tez.icerik || '';
    document.getElementById('tezYayinda').checked = tez.yayinda || false;
    document.getElementById('tezSilBtn').style.display = 'inline-block';

    // Mevcut kapak görseli varsa göster
    if (tez.kapak_gorseli) {
      _tezKapakUrl = tez.kapak_gorseli;
      if (kapakMevcut)  kapakMevcut.value = tez.kapak_gorseli;
      if (kapakDurum)   { kapakDurum.textContent = 'Mevcut görsel'; kapakDurum.style.color = '#22c55e'; }
      if (kapakImg)     kapakImg.src = tez.kapak_gorseli;
      if (kapakWrap)    kapakWrap.style.display = 'block';
    } else {
      if (kapakDurum)   { kapakDurum.textContent = 'Henüz seçilmedi'; kapakDurum.style.color = '#5a6a8a'; }
      if (kapakMevcut)  kapakMevcut.value = '';
    }
  } else {
    document.getElementById('tezFormBaslik').textContent = 'YENİ TEZ';
    document.getElementById('tezFormId').value    = '';
    document.getElementById('tezBaslik').value    = '';
    document.getElementById('tezTicker').value    = '';
    document.getElementById('tezSinyal').value    = '';
    document.getElementById('tezOzet').value      = '';
    document.getElementById('tezIcerik').value    = '';
    document.getElementById('tezYayinda').checked = false;
    document.getElementById('tezSilBtn').style.display = 'none';
    if (kapakDurum)  { kapakDurum.textContent = 'Henüz seçilmedi'; kapakDurum.style.color = '#5a6a8a'; }
    if (kapakMevcut) kapakMevcut.value = '';
  }
}

async function tezKaydet() {
  const id     = document.getElementById('tezFormId').value;
  const durum  = document.getElementById('tezKaydetDurum');
  if (durum) durum.textContent = '';

  // Kapak görseli — önce yeni dosya seçili mi kontrol et
  let kapakUrl = _tezKapakUrl || document.getElementById('tezKapakMevcut')?.value || null;
  const kapakFile = document.getElementById('tezKapakFile');
  if (kapakFile?.files[0]) {
    try {
      const uploadedUrl = await tezKapakUpload();
      if (uploadedUrl) {
        kapakUrl = uploadedUrl;
        _tezKapakUrl = kapakUrl;
      } else {
        showToast('⚠ Görsel yüklenemedi, tez görselsiz kaydedilecek');
      }
    } catch(e) {
      // Upload hatası — görselsiz kaydetmeye devam et
      showToast('⚠ Görsel yüklenemedi: ' + e.message.slice(0,60) + ' — tez görselsiz kaydediliyor');
      kapakUrl = _tezKapakUrl || null; // mevcut URL varsa koru
    } finally {
      if (durum) durum.textContent = '';
    }
  }

  const body = {
    baslik:        document.getElementById('tezBaslik').value,
    ticker:        document.getElementById('tezTicker').value?.toUpperCase() || null,
    sinyal:        document.getElementById('tezSinyal').value || null,
    kapak_gorseli: kapakUrl || null,
    ozet:          document.getElementById('tezOzet').value || null,
    icerik:        document.getElementById('tezIcerik').value || null,
    yayinda:       document.getElementById('tezYayinda').checked,
  };

  if (!body.baslik) { showToast('Başlık zorunlu'); return; }

  try {
    if (id) {
      body.id = parseInt(id);
      await fetch('/api/tez-admin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tezSecret },
        body: JSON.stringify(body)
      });
      showToast('✓ Tez güncellendi');
    } else {
      await fetch('/api/tez-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tezSecret },
        body: JSON.stringify(body)
      });
      showToast('✓ Tez oluşturuldu');
    }
    tezListeYukle();
  } catch(e) {
    showToast('Hata: ' + e.message);
  }
}

async function tezSilDogrudan(id) {
  if (!id || !confirm('Bu tez silinsin mi?')) return;
  try {
    await fetch('/api/tez-admin', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tezSecret },
      body: JSON.stringify({ id: parseInt(id) })
    });
    showToast('Tez silindi');
    tezListeYukle();
  } catch(e) {
    showToast('Hata: ' + e.message);
  }
}

async function tezSil() {
  const id = document.getElementById('tezFormId').value;
  if (!id || !confirm('Bu tez silinsin mi?')) return;
  try {
    await fetch('/api/tez-admin', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + _tezSecret },
      body: JSON.stringify({ id: parseInt(id) })
    });
    showToast('Tez silindi');
    tezListeYukle();
  } catch(e) {
    showToast('Hata: ' + e.message);
  }
}
