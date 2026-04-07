// Admin brute force koruması
const _adminAttempts = new Map();
function checkAdminRateLimit(ip) {
  const now = Date.now();
  const window = 15 * 60 * 1000; // 15 dakika
  const max = 10;
  const hits = (_adminAttempts.get(ip) || []).filter(t => now - t < window);
  hits.push(now);
  _adminAttempts.set(ip, hits);
  return hits.length <= max;
}

// /api/auth.js — Barış Investing Auth
// Yenilikler: Referans sistemi, günlük bonus (+1 hak), gelişmiş admin istatistikleri

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const FREE_CREDITS = 5;
const REFERRAL_BONUS = 2;   // davet eden kazanır
const REFERRED_BONUS = 1;   // davet edilen kazanır
const DAILY_BONUS = 1;      // günlük ilk giriş bonusu
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();

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

  const r = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
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

function isAdminRequest(email, secret) {
  if (!email || !secret) return false;
  const emailMatch = ADMIN_EMAIL && norm(email) === ADMIN_EMAIL;
  const secretMatch = process.env.ADMIN_SECRET && secret === process.env.ADMIN_SECRET;
  return emailMatch && secretMatch; // IKISI DE gerekli
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

function makeRefCode(email) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash) + email.charCodeAt(i);
    hash |= 0;
  }
  return 'BI' + Math.abs(hash).toString(36).toUpperCase().slice(0, 6);
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed = !origin || origin.includes('barisinvesting.com') || origin.includes('vercel.app') || origin.includes('localhost');
  res.setHeader('Access-Control-Allow-Origin', isAllowed ? (origin || '*') : 'https://www.barisinvesting.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── LOGIN / KAYIT ──
  if (action === 'login' && req.method === 'POST') {
    const { email, marketingConsent, refCode } = req.body || {};
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    if (!email || !emailRegex.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Geçerli bir e-posta girin.' });
    }

    const em = norm(email);
    const isAdminUser = ADMIN_EMAIL ? em === ADMIN_EMAIL : false;
    const myRefCode = makeRefCode(em);

    if (!SB_URL || !SB_KEY) {
      return res.status(200).json({
        user: { email: em, credits: isAdminUser ? 9999 : 3, is_admin: isAdminUser, total_used: 0, ref_code: myRefCode },
        isNew: true,
        warning: 'Supabase kurulmamış.'
      });
    }

    try {
      let user = await getUser(em);
      const isNew = !user;
      let dailyBonus = false;
      let refBonus = false;

      if (!user) {
        // YENİ KULLANICI
        let startCredits = FREE_CREDITS;
        let referredBy = null;

        if (refCode && refCode !== myRefCode) {
          const refRows = await sb('GET', 'users', { 'ref_code': `eq.${refCode}`, 'select': 'email,credits,ref_count' }).catch(() => null);
          const refUser = refRows?.[0];
          if (refUser) {
            referredBy = refUser.email;
            startCredits += REFERRED_BONUS;
            refBonus = true;
            // Davet edene bonus ver
            await sb('PATCH', 'users', { 'email': `eq.${refUser.email}` }, {
              credits: (refUser.credits || 0) + REFERRAL_BONUS,
              ref_count: (refUser.ref_count || 0) + 1,
            }).catch(() => null);
          }
        }

        const now = new Date().toISOString();
        const rows = await sb('POST', 'users', { 'on_conflict': 'email' }, {
          email: em,
          credits: startCredits,
          total_used: 0,
          is_admin: isAdminUser,
          marketing_consent: !!marketingConsent,
          joined_at: now,
          last_seen: now,
          last_bonus_at: now,
          ref_code: myRefCode,
          referred_by: referredBy,
          ref_count: 0,
        });
        user = rows?.[0] || { email: em, credits: startCredits, is_admin: isAdminUser, total_used: 0, ref_code: myRefCode };

      } else {
        // MEVCUT KULLANICI
        const updates = {
          last_seen: new Date().toISOString(),
          is_admin: isAdminUser,
          ref_code: user.ref_code || myRefCode,
          ...(marketingConsent !== undefined ? { marketing_consent: !!marketingConsent } : {})
        };

        // Günlük bonus
        if (!isAdminUser && !isToday(user.last_bonus_at)) {
          updates.credits = (user.credits || 0) + DAILY_BONUS;
          updates.last_bonus_at = new Date().toISOString();
          dailyBonus = true;
          user.credits = updates.credits;
        }

        await sb('PATCH', 'users', { 'email': `eq.${em}` }, updates);
        user.last_seen = updates.last_seen;
        user.is_admin = isAdminUser;
        user.ref_code = updates.ref_code;
      }

      return res.status(200).json({ user, isNew, dailyBonus, refBonus });

    } catch (e) {
      console.error('login error:', e.message);
      return res.status(200).json({
        user: { email: em, credits: isAdminUser ? 9999 : 3, is_admin: isAdminUser, total_used: 0, ref_code: myRefCode, offline: true },
        isNew: false,
        warning: 'DB hatası: ' + e.message
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
      user.is_admin = ADMIN_EMAIL ? em === ADMIN_EMAIL : user.is_admin;
      if (!user.ref_code) user.ref_code = makeRefCode(em);
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
        return res.status(403).json({ error: 'Analiz hakkınız doldu.', credits: 0 });
      }
      const newCredits = isAdminUser ? user.credits : Math.max(0, user.credits - 1);
      const newTotal = (user.total_used || 0) + 1;
      await sb('PATCH', 'users', { 'email': `eq.${em}` }, {
        credits: newCredits, total_used: newTotal, last_seen: new Date().toISOString(),
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
        await sb('PATCH', 'portfolios', { 'email': `eq.${em}` }, { data: payload, updated_at: new Date().toISOString() });
      } else {
        await sb('POST', 'portfolios', {}, { email: em, data: payload, updated_at: new Date().toISOString() });
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
    const adminIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    if (!checkAdminRateLimit(adminIp)) return res.status(429).json({ error: 'Çok fazla deneme.' });
    const { email, secret } = req.body || {};
    if (!isAdminRequest(email, secret)) {
      return res.status(403).json({ error: 'Yetkisiz erişim' });
    }
    try {
      const users = await sb('GET', 'users', { 'select': '*', 'order': 'joined_at.desc', 'limit': '500' });
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const stats = {
        total: users?.length || 0,
        totalAnalyze: users?.reduce((s, u) => s + (u.total_used || 0), 0) || 0,
        todayNew: users?.filter(u => new Date(u.joined_at) >= today).length || 0,
        weekNew: users?.filter(u => new Date(u.joined_at) >= week).length || 0,
        totalCredits: users?.reduce((s, u) => s + (u.credits || 0), 0) || 0,
        marketingConsent: users?.filter(u => u.marketing_consent).length || 0,
        totalReferrals: users?.reduce((s, u) => s + (u.ref_count || 0), 0) || 0,
        activeToday: users?.filter(u => isToday(u.last_seen)).length || 0,
      };
      return res.status(200).json({ users: users || [], stats });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── ADMIN: hak ekle ──
  if (action === 'admin_credits' && req.method === 'POST') {
    const { email, secret, targetEmail, credits } = req.body || {};
    if (!isAdminRequest(email, secret)) return res.status(403).json({ error: 'Yetkisiz erişim' });
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
    if (!isAdminRequest(email, secret)) return res.status(403).json({ error: 'Yetkisiz erişim' });
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
