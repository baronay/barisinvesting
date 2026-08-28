import crypto from 'node:crypto';

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

// ── Resend (hoş geldin maili) ──
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Barış Investing <bulten@barisinvesting.com>';
const SITE_URL = process.env.SITE_URL || 'https://barisinvesting.com';

function welcomeEmailHTML() {
  return `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"></head>
<body style="margin:0;padding:0;background:#080b10;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#080b10;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#0f141d;border:1px solid rgba(194,173,132,0.22);border-radius:16px;overflow:hidden;">
  <tr><td style="padding:34px 34px 22px;border-bottom:1px solid rgba(255,255,255,0.06);">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#8a94a6;">Finansal Araştırma &amp; Medya</div>
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:#ece4d4;margin-top:4px;">Barış <span style="color:#c2ad84;">Investing</span></div>
  </td></tr>
  <tr><td style="padding:34px;">
    <h1 style="margin:0 0 14px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.3;color:#ffffff;font-weight:700;">Aramıza hoş geldin 👋</h1>
    <p style="margin:0 0 18px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#cbd5e1;">
      Listeye eklendin. Bundan sonra <strong style="color:#ece4d4;">yeni yatırım tezleri</strong>, <strong style="color:#ece4d4;">haftalık seçimler</strong> ve piyasa notları doğrudan e-postana gelecek.
    </p>
    <p style="margin:0 0 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#cbd5e1;">
      Dilersen hemen Terminal'e geçip BIST, NYSE ve NASDAQ hisselerini Barış Investing çerçevesiyle analiz etmeye başlayabilirsin.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>
      <td style="border-radius:12px;background:#c2ad84;">
        <a href="${SITE_URL}/terminal" style="display:inline-block;padding:13px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#0b0f15;text-decoration:none;border-radius:12px;">Terminal'e Giriş →</a>
      </td>
    </tr></table>
    <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(255,255,255,0.06);font-family:Arial,Helvetica,sans-serif;">
      <a href="${SITE_URL}/tezler" style="color:#c2ad84;font-size:13px;text-decoration:none;margin-right:18px;">Yatırım Tezleri</a>
      <a href="${SITE_URL}/arastirmalar" style="color:#c2ad84;font-size:13px;text-decoration:none;">Şirket Araştırmaları</a>
    </div>
  </td></tr>
  <tr><td style="padding:20px 34px 30px;">
    <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.6;color:#5b6472;">
      Bu e-postayı barisinvesting.com'a e-posta bıraktığın için aldın. İçerikler yalnızca araştırma ve bilgi amaçlıdır, yatırım tavsiyesi değildir. Listeden çıkmak için bu e-postayı yanıtlaman yeterli.
    </p>
  </td></tr>
</table>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#5b6472;margin-top:16px;">© Barış Investing</div>
</td></tr></table></body></html>`;
}

// Fire-and-forget: mail hatası hiçbir zaman kaydı/girişi bozmaz
async function sendWelcomeEmail(to) {
  if (!RESEND_API_KEY) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject: 'Barış Investing — Aramıza hoş geldin',
        html: welcomeEmailHTML(),
      }),
    });
  } catch (e) {
    console.error('welcome email error:', e.message);
  }
}

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

function makeRefCode() {
  return 'BI' + crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 6);
}

const ALLOWED_ORIGINS = new Set([
  'https://barisinvesting.com',
  'https://www.barisinvesting.com',
  'https://barisinvesting.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
]);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const isAllowed = !origin || ALLOWED_ORIGINS.has(origin);
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
    const myRefCode = makeRefCode();

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

      // Yeni kullanıcıya hoş geldin maili (mailini bırakan herkes ilk kez eklendiğinde)
      // await şart: Vercel serverless, res dönünce fonksiyonu dondurur — await'siz fetch tamamlanmadan kesilir
      if (isNew) { await sendWelcomeEmail(em); }

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
      if (!user.ref_code) {
        user.ref_code = makeRefCode();
        await sb('PATCH', 'users', { 'email': `eq.${em}` }, { ref_code: user.ref_code }).catch(() => null);
      }
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

  /* ── GEÇMİŞ ANALİZLERİ KURTAR ────────────────────────────────────
     Sunucuda geçmiş yok (istek gövdeyle geliyor, erişim logunda ticker
     durmuyor). Ama ziyaretçinin tarayıcısında duruyor: terminal her
     analizi localStorage'a yazıyor. İstemci bu listeyi bir kez buraya
     gönderiyor, geçmiş geri dönen her ziyaretçiyle birlikte doluyor.

     Dışarıya açık bir yazma ucu olduğu için dar tutuldu: istek başına
     en fazla 60 satır, ticker/kod temizleniyor, tarih gelecekte ya da
     iki yıldan eski olamaz, satırlar 'gecmis' olarak işaretleniyor ve
     tekil indeks sayesinde aynı kayıt iki kez düşmüyor. */
  if (action === 'gecmis_yukle' && req.method === 'POST') {
    const { oturum, email, kayitlar } = req.body || {};
    const ot = String(oturum || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    if (!ot) return res.status(400).json({ error: 'oturum gerekli' });
    if (!Array.isArray(kayitlar) || !kayitlar.length) return res.status(200).json({ eklendi: 0 });

    const simdi = Date.now();
    const enEski = simdi - 730 * 86400000;   // 2 yıl
    const em = email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? norm(email).slice(0, 200) : null;

    const satirlar = kayitlar.slice(0, 60).map(k => {
      const ticker = String(k.ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '').slice(0, 12);
      const ts = Number(k.ts);
      if (!ticker || !Number.isFinite(ts) || ts > simdi || ts < enEski) return null;
      const skor = Number.isFinite(Number(k.skor)) ? Math.max(0, Math.min(7, parseInt(k.skor, 10))) : null;
      return {
        ticker,
        exchange: ['BIST', 'NYSE', 'NASDAQ'].includes(k.exchange) ? k.exchange : null,
        email: em,
        oturum: ot,
        sirket: k.sirket ? String(k.sirket).slice(0, 120) : null,
        verdict: ['AL', 'BEKLE', 'UZAK_DUR', 'KACIN'].includes(k.verdict) ? k.verdict : null,
        skor,
        durum: 'ok',
        kaynak: 'gecmis',
        olusturma: new Date(ts).toISOString(),
      };
    }).filter(Boolean);

    if (!satirlar.length) return res.status(200).json({ eklendi: 0 });

    try {
      const r = await fetch(`${SB_URL}/rest/v1/analiz_kayitlari?on_conflict=oturum,ticker,olusturma`, {
        method: 'POST',
        headers: {
          apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal,resolution=ignore-duplicates',
        },
        body: JSON.stringify(satirlar),
      });
      if (!r.ok) {
        const detay = await r.text();
        return res.status(200).json({ eklendi: 0, uyari: detay.slice(0, 200) });
      }
      return res.status(200).json({ eklendi: satirlar.length });
    } catch (e) {
      return res.status(200).json({ eklendi: 0, uyari: e.message });
    }
  }

  /* ── ADMIN: analiz kayıtları ─────────────────────────────────────
     "Hangi hisseye bakılıyor" sorusunun cevabı. users.total_used sadece
     adet sayıyordu; ticker bilgisi analiz_kayitlari tablosunda.
     Dönüş: son istekler + en çok analiz edilenler + günlük dağılım. */
  if (action === 'admin_analiz' && req.method === 'POST') {
    const { email, secret, gun } = req.body || {};
    if (!isAdminRequest(email, secret)) return res.status(403).json({ error: 'Yetkisiz erişim' });
    const pencere = Math.min(365, Math.max(1, parseInt(gun, 10) || 30));
    const baslangic = new Date(Date.now() - pencere * 86400000).toISOString();
    try {
      const kayitlar = await sb('GET', 'analiz_kayitlari', {
        'select': 'ticker,exchange,email,oturum,verdict,skor,durum,maliyet,olusturma,kaynak',
        'olusturma': `gte.${baslangic}`,
        'order': 'olusturma.desc',
        'limit': '2000',
      });
      const liste = Array.isArray(kayitlar) ? kayitlar : [];

      const hisseler = {};
      const gunler = {};
      const oturumlar = new Set();
      for (const k of liste) {
        const anahtar = `${k.ticker}|${k.exchange || ''}`;
        const h = hisseler[anahtar] || (hisseler[anahtar] = { ticker: k.ticker, exchange: k.exchange, adet: 0, son: k.olusturma, kisi: new Set() });
        h.adet++;
        if (k.olusturma > h.son) h.son = k.olusturma;
        h.kisi.add(k.email || k.oturum || '?');
        const g = String(k.olusturma).slice(0, 10);
        gunler[g] = (gunler[g] || 0) + 1;
        oturumlar.add(k.email || k.oturum || '?');
      }

      return res.status(200).json({
        pencereGun: pencere,
        toplam: liste.length,
        tekilKisi: oturumlar.size,
        hatali: liste.filter(k => k.durum && k.durum !== 'ok').length,
        gecmisten: liste.filter(k => k.kaynak === 'gecmis').length,
        maliyet: Number(liste.reduce((t, k) => t + (Number(k.maliyet) || 0), 0).toFixed(2)),
        hisseler: Object.values(hisseler)
          .map(h => ({ ...h, kisi: h.kisi.size }))
          .sort((a, b) => b.adet - a.adet)
          .slice(0, 40),
        gunluk: Object.entries(gunler).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 30)
          .map(([gun, adet]) => ({ gun, adet })),
        son: liste.slice(0, 60),
      });
    } catch (e) {
      // Tablo henüz kurulmadıysa panel kırılmasın
      return res.status(200).json({ hata: e.message, kurulum: "sql/analiz-kayitlari.sql dosyasini Supabase SQL Editor'de calistir." });
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
