// /api/auth.js — Supabase destekli auth + analiz hakkı + portföy kayıt
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET, ADMIN_EMAIL

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const FREE_CREDITS = 3;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

// ── Supabase REST helper ──
async function sb(method, table, params = {}, body = null) {
  if (!SB_URL || !SB_KEY) throw new Error('SUPABASE_KURULUM_BEKLIYOR');
  let url = `${SB_URL}/rest/v1/${table}`;
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => qs.set(k, v));
  const qStr = qs.toString();
  if (qStr) url += '?' + qStr;

  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation,resolution=merge-duplicates';
  if (method === 'PATCH') headers['Prefer'] = 'return=representation';

  const r = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Supabase ${method} ${table}: ${r.status} ${err}`);
  }
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

async function getUser(email) {
  const rows = await sb('GET', 'users', { 'email': `eq.${email}`, 'select': '*' });
  return rows?.[0] || null;
}

function norm(e) { return (e || '').toLowerCase().trim(); }

// ── Admin doğrulama yardımcısı ──
// DÜZELTME: Hem ADMIN_SECRET hem ADMIN_EMAIL yeterli — ikisinden biri geçerliyse admin.
function isAdminRequest(email, secret) {
  const emailMatch = ADMIN_EMAIL && norm(email) === ADMIN_EMAIL;
  const secretMatch = process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
  return emailMatch || secretMatch;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── LOGIN / KAYIT ──
  if (action === 'login' && req.method === 'POST') {
    const { email, marketingConsent } = req.body || {};
    if (!email || !email.includes('@') || !email.includes('.')) {
      return res.status(400).json({ error: 'Geçerli bir e-posta girin.' });
    }

    const em = norm(email);
    // DÜZELTME: is_admin her zaman ADMIN_EMAIL ile karşılaştırılarak hesaplanır
    const isAdminUser = ADMIN_EMAIL ? em === ADMIN_EMAIL : false;

    // Supabase kurulmamışsa — admin emaili ile giriş yapılıyorsa is_admin=true ver
    if (!SB_URL || !SB_KEY) {
      return res.status(200).json({
        user: { email: em, credits: isAdminUser ? 9999 : 3, is_admin: isAdminUser, total_used: 0 },
        isNew: true,
        warning: 'Supabase kurulmamış — veriler kaydedilmedi.'
      });
    }

    try {
      let user = await getUser(em);
      const isNew = !user;
      if (!user) {
        const rows = await sb('POST', 'users', { 'on_conflict': 'email' }, {
          email: em,
          credits: FREE_CREDITS,
          total_used: 0,
          is_admin: isAdminUser,
          marketing_consent: !!marketingConsent,
          joined_at: new Date().toISOString(),
          last_seen: new Date().toISOString(),
        });
        user = rows?.[0] || { email: em, credits: FREE_CREDITS, is_admin: isAdminUser, total_used: 0 };
      } else {
        // DÜZELTME: Mevcut kullanıcıda is_admin her girişte güncellenir
        // (ADMIN_EMAIL değiştirilirse veya önceki girişte yanlış set edildiyse düzeltilir)
        const updatePayload = {
          last_seen: new Date().toISOString(),
          is_admin: isAdminUser,
          ...(marketingConsent !== undefined ? { marketing_consent: !!marketingConsent } : {})
        };
        await sb('PATCH', 'users', { 'email': `eq.${em}` }, updatePayload);
        user.last_seen = new Date().toISOString();
        user.is_admin = isAdminUser; // Lokal state'i de güncelle
      }
      return res.status(200).json({ user, isNew });
    } catch (e) {
      console.error('login error:', e.message);
      // Supabase hatası olsa bile ADMIN_EMAIL bilgisiyle fallback ver
      return res.status(200).json({
        user: { email: em, credits: isAdminUser ? 9999 : 3, is_admin: isAdminUser, total_used: 0, offline: true },
        isNew: false,
        warning: 'Veritabanı hatası — sınırlı mod: ' + e.message
      });
    }
  }

  // ── KULLANICI BİLGİSİ ──
  if (action === 'me' && req.method === 'POST') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email gerekli' });
    if (!SB_URL || !SB_KEY) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    try {
      const em = norm(email);
      const user = await getUser(em);
      if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      // is_admin'i her zaman ENV'den hesapla — DB'deki eski değere güvenme
      user.is_admin = ADMIN_EMAIL ? em === ADMIN_EMAIL : user.is_admin;
      return res.status(200).json({ user });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ANALİZ HAKKI KULLAN ──
  if (action === 'use' && req.method === 'POST') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email gerekli' });
    if (!SB_URL || !SB_KEY) return res.status(200).json({ credits: 99, totalUsed: 0 });
    const em = norm(email);
    const isAdminUser = ADMIN_EMAIL ? em === ADMIN_EMAIL : false;
    try {
      const user = await getUser(em);
      if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      if (user.credits <= 0 && !isAdminUser) {
        return res.status(403).json({ error: 'Analiz hakkınız doldu. Daha fazlası için bizimle iletişime geçin.', credits: 0 });
      }
      const newCredits = isAdminUser ? user.credits : Math.max(0, user.credits - 1);
      const newTotal = (user.total_used || 0) + 1;
      await sb('PATCH', 'users', { 'email': `eq.${em}` }, {
        credits: newCredits,
        total_used: newTotal,
        last_seen: new Date().toISOString(),
      });
      return res.status(200).json({ credits: newCredits, totalUsed: newTotal });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PORTFÖY KAYDET ──
  if (action === 'save_portfolio' && req.method === 'POST') {
    const { email, portfolio } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email gerekli' });
    const em = norm(email);
    try {
      const user = await getUser(em);
      if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      const payload = JSON.stringify(portfolio || []);
      if (payload.length > 100000) return res.status(413).json({ error: 'Portföy çok büyük' });
      const existing = await sb('GET', 'portfolios', { 'email': `eq.${em}` });
      if (existing?.length > 0) {
        await sb('PATCH', 'portfolios', { 'email': `eq.${em}` }, {
          data: payload,
          updated_at: new Date().toISOString()
        });
      } else {
        await sb('POST', 'portfolios', {}, {
          email: em,
          data: payload,
          updated_at: new Date().toISOString()
        });
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PORTFÖY YÜKLE ──
  if (action === 'load_portfolio' && req.method === 'POST') {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email gerekli' });
    const em = norm(email);
    try {
      const user = await getUser(em);
      if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      const rows = await sb('GET', 'portfolios', { 'email': `eq.${em}`, 'select': 'data,updated_at' });
      const row = rows?.[0];
      let portfolio = [];
      if (row?.data) { try { portfolio = JSON.parse(row.data); } catch {} }
      return res.status(200).json({ portfolio, updatedAt: row?.updated_at });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ADMIN: kullanıcı listesi ──
  if (action === 'admin_users' && req.method === 'POST') {
    const { email, secret } = req.body || {};
    if (!isAdminRequest(email, secret)) {
      return res.status(403).json({ error: 'Yetkisiz erişim' });
    }
    try {
      const users = await sb('GET', 'users', { 'select': '*', 'order': 'joined_at.desc', 'limit': '500' });
      const today = new Date(); today.setHours(0,0,0,0);
      const stats = {
        total: users?.length || 0,
        totalAnalyze: users?.reduce((s, u) => s + (u.total_used || 0), 0) || 0,
        todayNew: users?.filter(u => new Date(u.joined_at) >= today).length || 0,
        totalCredits: users?.reduce((s, u) => s + (u.credits || 0), 0) || 0,
        marketingConsent: users?.filter(u => u.marketing_consent).length || 0,
      };
      return res.status(200).json({ users: users || [], stats });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ADMIN: hak ekle ──
  if (action === 'admin_credits' && req.method === 'POST') {
    const { email, secret, targetEmail, credits } = req.body || {};
    if (!isAdminRequest(email, secret)) {
      return res.status(403).json({ error: 'Yetkisiz erişim' });
    }
    try {
      const target = await getUser(norm(targetEmail));
      if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      const newCredits = (target.credits || 0) + parseInt(credits || 0);
      await sb('PATCH', 'users', { 'email': `eq.${norm(targetEmail)}` }, { credits: newCredits });
      return res.status(200).json({ ok: true, credits: newCredits });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ADMIN: kullanıcı sil ──
  if (action === 'admin_delete' && req.method === 'POST') {
    const { email, secret, targetEmail } = req.body || {};
    if (!isAdminRequest(email, secret)) {
      return res.status(403).json({ error: 'Yetkisiz erişim' });
    }
    try {
      const tEm = norm(targetEmail);
      await sb('DELETE', 'users', { 'email': `eq.${tEm}` });
      await sb('DELETE', 'portfolios', { 'email': `eq.${tEm}` });
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Geçersiz istek' });
}
