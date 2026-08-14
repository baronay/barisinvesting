/* ═══════════════════════════════════════════════════════════════
   ŞİRKET PROFİLİ — künye + finansal tablolar (ABD hisseleri)
   GET /api/profil?ticker=AAPL

   Kaynak: SEC EDGAR. Ücretsiz, anahtarsız, resmî XBRL verisi:
     · company_tickers.json          → ticker → CIK
     · submissions/CIK##########.json → künye (ad, SIC, borsa, adres)
     · api/xbrl/companyfacts/…json    → tüm finansal kalemler

   Neden Yahoo değil: quoteSummary "Invalid Crumb" dönüyor (ölçüldü),
   v7 quote da sunucu tarafında kısıtlı. EDGAR hem çalışıyor hem resmî.

   SEC, User-Agent'ta iletişim adresi istiyor — SEC_UA ortam
   değişkeniyle değiştirilebilir.
   ═══════════════════════════════════════════════════════════════ */

import { US_EVREN, BIST_EVREN } from './_heatmap-universe.js';

const SEC_UA = process.env.SEC_UA || 'BarisInvesting/1.0 (info@barisinvesting.com)';
const BASLIK = { 'User-Agent': SEC_UA, 'Accept': 'application/json' };
const WEB_BASLIK = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

/* ── Şirket adı temizliği ─────────────────────────────────────────
   "NVIDIA CORP" → "NVIDIA", "Apple Inc." → "Apple". Hem ansiklopedi
   hem haber aramasında ham unvan kötü sonuç veriyor. */
const SIRKET_EKI = /\b(inc|inc\.|incorporated|corp|corp\.|corporation|co|co\.|company|plc|ltd|ltd\.|llc|lp|nv|sa|ag|holdings?|group|the)\b/gi;
function adiSadelestir(ad) {
  return String(ad || '')
    .replace(/[,&]/g, ' ')
    .replace(SIRKET_EKI, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Ansiklopedi araması yanlış şirkete düşebiliyor (TR'de "NVIDIA Corp"
// araması MSI'yı, "Powell Industries" bir kaykaycıyı getirdi) — bulunan
// başlık şirket adıyla en az bir anlamlı kelimeyi paylaşmalı
function baslikUyuyor(baslik, ad) {
  const kelimeler = adiSadelestir(ad).toLowerCase().split(/\s+/).filter(k => k.length >= 4);
  if (!kelimeler.length) return false;
  const b = String(baslik || '').toLowerCase();
  return kelimeler.some(k => b.includes(k));
}

async function ozetGetir(ad) {
  const sorgu = adiSadelestir(ad);
  if (!sorgu) return null;
  for (const dil of ['tr', 'en']) {
    try {
      const u = `https://${dil}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&exchars=520&generator=search&gsrsearch=${encodeURIComponent(sorgu)}&gsrlimit=1`;
      const r = await fetch(u, { headers: BASLIK, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j = await r.json();
      const sayfalar = j?.query?.pages;
      if (!sayfalar) continue;
      const s = Object.values(sayfalar)[0];
      if (!s || !s.extract || !baslikUyuyor(s.title, ad)) continue;
      const metin = String(s.extract).replace(/\s+/g, ' ').trim();
      if (metin.length < 40) continue;
      return { metin, dil };
    } catch { /* sonraki dil */ }
  }
  return null;
}

/* ── Şirket haberleri ─────────────────────────────────────────────
   Google Haberler RSS: ücretsiz, anahtarsız ve Türkçe sorguda
   Investing.com Türkiye başlıklarını da getiriyor. */
function rssAyikla(xml, adet) {
  const cikti = [];
  const parcalar = String(xml).split('<item>').slice(1);
  for (const p of parcalar.slice(0, adet)) {
    const al = (etiket) => {
      const m = p.match(new RegExp(`<${etiket}[^>]*>([\\s\\S]*?)</${etiket}>`));
      if (!m) return '';
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .trim();
    };
    let baslik = al('title');
    if (!baslik) continue;
    // Google başlığı "Haber metni - Kaynak" biçiminde veriyor
    let kaynak = al('source');
    const ayrac = baslik.lastIndexOf(' - ');
    if (!kaynak && ayrac > 20) { kaynak = baslik.slice(ayrac + 3); baslik = baslik.slice(0, ayrac); }
    else if (kaynak && baslik.endsWith(' - ' + kaynak)) baslik = baslik.slice(0, -(kaynak.length + 3));
    const tarih = al('pubDate');
    cikti.push({ baslik, kaynak: kaynak || null, link: al('link') || null, tarih: tarih ? Date.parse(tarih) || null : null });
  }
  return cikti;
}

async function haberGetir(ad, ticker) {
  const sorgular = [
    { q: `${adiSadelestir(ad)} hisse`, dil: 'tr', bolge: 'TR' },
    { q: `"${adiSadelestir(ad)}" stock ${ticker}`, dil: 'en-US', bolge: 'US' },
  ];
  for (const s of sorgular) {
    try {
      const u = `https://news.google.com/rss/search?q=${encodeURIComponent(s.q)}&hl=${s.dil}&gl=${s.bolge}&ceid=${s.bolge}:${s.dil.slice(0, 2)}`;
      const r = await fetch(u, { headers: WEB_BASLIK, signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const liste = rssAyikla(await r.text(), 6);
      if (liste.length >= 3) return liste;
    } catch { /* sonraki sorgu */ }
  }
  return [];
}

// ticker → CIK tablosu ~1 MB; fonksiyon örneği hayatta kaldıkça bellekte tut
let _cikTablo = null;
let _cikTs = 0;
const CIK_TTL = 24 * 60 * 60 * 1000;

async function cikBul(ticker) {
  if (!_cikTablo || (Date.now() - _cikTs) > CIK_TTL) {
    const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: BASLIK, signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw new Error('SEC ticker tablosu alınamadı');
    const j = await r.json();
    const tablo = {};
    for (const k of Object.keys(j)) {
      const o = j[k];
      if (o && o.ticker) tablo[String(o.ticker).toUpperCase()] = { cik: o.cik_str, ad: o.title };
    }
    _cikTablo = tablo;
    _cikTs = Date.now();
  }
  return _cikTablo[ticker] || null;
}

/* ── Aradığımız kalemler ───────────────────────────────────────
   Bir kalemin XBRL etiketi şirketten şirkete değişiyor (Apple hasılatı
   "Revenues" değil "RevenueFromContractWithCustomer…" ile veriyor), o
   yüzden her kalem için sırayla denenecek etiket listesi tutuyoruz.
   tur: 'akis'  → dönem boyunca oluşan (gelir tablosu, nakit akışı)
        'stok'  → belirli bir tarihteki bakiye (bilanço)          */
const KALEMLER = [
  { k: 'hasilat',  ad: 'Hasılat',            tur: 'akis', birim: 'USD', tablo: 'gelir',
    etiketler: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
  { k: 'brutKar',  ad: 'Brüt Kâr',           tur: 'akis', birim: 'USD', tablo: 'gelir',
    etiketler: ['GrossProfit'] },
  { k: 'faalKar',  ad: 'Faaliyet Kârı',      tur: 'akis', birim: 'USD', tablo: 'gelir',
    etiketler: ['OperatingIncomeLoss'] },
  { k: 'netKar',   ad: 'Net Kâr',            tur: 'akis', birim: 'USD', tablo: 'gelir',
    etiketler: ['NetIncomeLoss', 'ProfitLoss'] },
  { k: 'eps',      ad: 'Seyreltilmiş EPS',   tur: 'akis', birim: 'USD/hisse', tablo: 'gelir',
    etiketler: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'] },

  { k: 'varlik',   ad: 'Toplam Varlık',      tur: 'stok', birim: 'USD', tablo: 'bilanco',
    etiketler: ['Assets'] },
  { k: 'yukumluluk', ad: 'Toplam Yükümlülük', tur: 'stok', birim: 'USD', tablo: 'bilanco',
    etiketler: ['Liabilities'] },
  { k: 'ozkaynak', ad: 'Özkaynak',           tur: 'stok', birim: 'USD', tablo: 'bilanco',
    etiketler: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  { k: 'nakit',    ad: 'Nakit ve Benzeri',   tur: 'stok', birim: 'USD', tablo: 'bilanco',
    etiketler: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
  { k: 'borc',     ad: 'Uzun Vadeli Borç',   tur: 'stok', birim: 'USD', tablo: 'bilanco',
    etiketler: ['LongTermDebtNoncurrent', 'LongTermDebt'] },

  { k: 'faalNakit', ad: 'Faaliyet Nakit Akışı', tur: 'akis', birim: 'USD', tablo: 'nakit',
    etiketler: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'] },
  { k: 'yatirim',  ad: 'Yatırım Harcaması',  tur: 'akis', birim: 'USD', tablo: 'nakit',
    // NVIDIA yeni yıllarda "ProductiveAssets" etiketine geçmiş; tek etiket
    // bırakılınca satır komple düşüyordu
    etiketler: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets', 'PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets'] },
  { k: 'finNakit', ad: 'Finansman Nakit Akışı', tur: 'akis', birim: 'USD', tablo: 'nakit',
    etiketler: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'] },
];

const GUN_MS = 86400000;

function gunFarki(a, b) {
  return Math.round((new Date(b) - new Date(a)) / GUN_MS);
}

/* Bir etiketin kayıtlarından istenen tipte dönemleri çıkarır.
   Aynı dönem birden çok kez raporlanabiliyor (düzeltmeler, sonraki yılın
   karşılaştırmalı tablosu) — en son dosyalanmış (filed) kayıt geçerli. */
function donemleriCikar(kayitlar, tur, periyot) {
  const harita = new Map();   // bitiş tarihi → kayıt
  for (const c of kayitlar) {
    if (!c || c.val == null || !isFinite(c.val) || !c.end) continue;
    const form = String(c.form || '');
    if (tur === 'akis') {
      if (!c.start) continue;
      const gun = gunFarki(c.start, c.end);
      if (periyot === 'yillik') {
        // Yıllık dönem yalnızca 10-K'da; 340–400 gün aralığı mali yıl demek
        if (!form.startsWith('10-K') || gun < 340 || gun > 400) continue;
      } else {
        // Çeyrek: 10-Q veya 10-K içindeki 80–100 günlük dönemler
        if (gun < 80 || gun > 100) continue;
      }
    } else {
      // Bilanço kalemi: 10-K yıl sonu, 10-Q çeyrek sonu bakiyesi
      if (periyot === 'yillik' ? !form.startsWith('10-K') : !form.startsWith('10-')) continue;
      if (c.start) continue;
    }
    const eski = harita.get(c.end);
    if (!eski || String(c.filed || '') > String(eski.filed || '')) harita.set(c.end, c);
  }
  return [...harita.values()].sort((a, b) => (a.end < b.end ? 1 : -1));
}

/* Bir kalemin etiketini seçerken listedeki İLK eşleşmeyi almak yetmiyor:
   şirketler zaman içinde etiket değiştiriyor (NVIDIA eski yıllarda
   "RevenueFromContractWithCustomer…", sonra başka bir etiket kullanmış).
   İlk eşleşme alınınca tablo 2018-2022'de donup kalıyordu. Bu yüzden
   dönem filtresinden geçen kayıtları olan etiketler arasından EN GÜNCEL
   verisi olanı seçiyoruz. */
function etiketBul(usGaap, etiketler, tur, periyot) {
  let enIyi = null;
  for (const e of etiketler) {
    const d = usGaap[e];
    if (!d || !d.units) continue;
    // Para birimi USD, EPS ise USD/shares
    const birimAd = Object.keys(d.units).find(u => u === 'USD' || u === 'USD/shares') || Object.keys(d.units)[0];
    if (!birimAd) continue;
    const ham = d.units[birimAd];
    if (!Array.isArray(ham) || !ham.length) continue;
    const liste = donemleriCikar(ham, tur, periyot);
    if (!liste.length) continue;
    const sonTarih = liste[0].end;
    if (!enIyi || sonTarih > enIyi.sonTarih) enIyi = { liste, etiket: e, sonTarih };
  }
  return enIyi;
}

function tabloKur(usGaap, periyot, adet) {
  // Dönem eksenini TÜM kalemlerin birleşiminden kur. Tek bir kalemin
  // dönemlerine bakıp erken çıkmak, o kalemin verisi eskiyse tabloyu
  // eski yıllara kilitliyordu.
  // Çeyreklikte nakit akışı kalemleri işe yaramıyor: şirketler bunları
  // yıl başından itibaren kümülatif veriyor (3 ay, 6 ay, 9 ay), tek bir
  // çeyreğin rakamı çoğu dönemde hiç bulunmuyor — tabloyu boş sütunlarla
  // doldurmaktansa bu bloğu çeyreklikte hiç göstermiyoruz.
  const kalemListesi = periyot === 'ceyrek' ? KALEMLER.filter(k => k.tablo !== 'nakit') : KALEMLER;

  const bulunanlar = new Map();
  const tarihler = new Set();
  for (const kalem of kalemListesi) {
    const b = etiketBul(usGaap, kalem.etiketler, kalem.tur, periyot);
    if (!b) continue;
    bulunanlar.set(kalem.k, b);
    for (const c of b.liste) tarihler.add(c.end);
  }
  // Aynı mali dönem kalemden kaleme birkaç gün kayabiliyor (bilanço 27
  // Eylül, gelir tablosu 30 Eylül gibi) — 10 gün içindeki tarihleri tek
  // dönem say, yoksa eksende aynı yıl iki kez çıkıyor
  const donemler = [];
  for (const t of [...tarihler].sort((a, b) => (a < b ? 1 : -1))) {
    if (donemler.some(v => Math.abs(gunFarki(t, v)) <= 10)) continue;
    donemler.push(t);
    if (donemler.length >= adet) break;
  }
  if (!donemler.length) return null;

  const satirlar = [];
  const deger = {};
  for (const kalem of kalemListesi) {
    const bulunan = bulunanlar.get(kalem.k);
    if (!bulunan) continue;
    const liste = bulunan.liste;
    const eslesen = new Map(liste.map(c => [c.end, c.val]));
    // Bilanço kalemleri gelir tablosuyla birkaç gün kayabiliyor: en yakın
    // (±10 gün) bakiyeyi eşleştir, yoksa boş bırak
    const degerler = donemler.map(d => {
      if (eslesen.has(d)) return eslesen.get(d);
      let enYakin = null, enKucukFark = 11;
      for (const c of liste) {
        const f = Math.abs(gunFarki(c.end, d));
        if (f < enKucukFark) { enKucukFark = f; enYakin = c.val; }
      }
      return enYakin;
    });
    if (degerler.every(v => v == null)) continue;
    deger[kalem.k] = degerler;
    satirlar.push({ k: kalem.k, ad: kalem.ad, birim: kalem.birim, tablo: kalem.tablo, tur: kalem.tur, xbrl: bulunan.etiket, d: degerler });
  }

  // Serbest nakit akışı = faaliyet nakit akışı − yatırım harcaması
  if (deger.faalNakit && deger.yatirim) {
    satirlar.push({
      k: 'fcf', ad: 'Serbest Nakit Akışı', birim: 'USD', tablo: 'nakit', xbrl: 'hesaplanan',
      d: deger.faalNakit.map((v, i) => {
        const y = deger.yatirim[i];
        return (v == null || y == null) ? null : v - y;
      }),
    });
  }

  // Gelir tablosu tarafı tamamen boş kalan dönemi sütun olarak gösterme.
  // Bunun tipik örneği 4. çeyrek: şirketler onu ayrı 10-Q ile vermiyor,
  // yıl sonu bilançosu dolu ama gelir satırları boş kalıyordu.
  const doluIndeks = donemler.map((_, i) =>
    satirlar.some(s => s.tur === 'akis' && s.d[i] != null));
  if (doluIndeks.some(v => !v) && doluIndeks.some(v => v)) {
    const kalan = donemler.filter((_, i) => doluIndeks[i]);
    for (const s of satirlar) s.d = s.d.filter((_, i) => doluIndeks[i]);
    return { donemler: kalan, satirlar };
  }

  return { donemler, satirlar };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const izinli = !origin || origin.includes('barisinvesting.com') || origin.includes('vercel.app') || origin.includes('localhost');
  res.setHeader('Access-Control-Allow-Origin', izinli ? (origin || '*') : 'https://www.barisinvesting.com');

  const ticker = String(req.query?.ticker || '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
  if (!ticker) return res.status(400).json({ error: 'Ticker belirtilmedi' });

  try {
    const kayit = await cikBul(ticker).catch(() => null);

    /* Kayıtlı olmayan hisseler (BİST dahil): finansal tablo yok ama
       şirket kartı yine de çalışsın — ad/sektör ısı haritası evreninden,
       özet ve haberler her borsa için aynı şekilde geliyor. */
    if (!kayit) {
      const yerli = [...BIST_EVREN, ...US_EVREN].find(h => h.t === ticker.replace('.IS', ''));
      if (!yerli) {
        return res.status(404).json({
          error: 'Bu hisse için şirket verisi bulunamadı',
          detay: 'Kod yanlış olabilir; BİST hisselerinde nokta ve uzantı olmadan dene (THYAO gibi).',
        });
      }
      const [ozet, haberler] = await Promise.all([
        ozetGetir(yerli.n).catch(() => null),
        haberGetir(yerli.n, ticker).catch(() => []),
      ]);
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
      return res.status(200).json({
        kunye: { ad: yerli.n, ticker, borsa: yerli.x || 'BIST', sektor: yerli.s || null },
        ozet, haberler,
        yillik: null, ceyreklik: null, finansal: false,
        uyari: 'Finansal tablolar şimdilik yalnızca ABD borsalarındaki şirketler için mevcut.',
        ts: Date.now(),
      });
    }

    const cik = String(kayit.cik).padStart(10, '0');

    const [subR, factR] = await Promise.all([
      fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: BASLIK, signal: AbortSignal.timeout(15000) }),
      fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: BASLIK, signal: AbortSignal.timeout(20000) }),
    ]);
    if (!subR.ok) throw new Error('Şirket künyesi alınamadı');
    const sub = await subR.json();

    const adr = (sub.addresses && (sub.addresses.business || sub.addresses.mailing)) || {};
    const mkAy = String(sub.fiscalYearEnd || '');
    const kunye = {
      ad: sub.name || kayit.ad,
      ticker,
      cik: Number(kayit.cik),
      borsa: Array.isArray(sub.exchanges) && sub.exchanges.length ? sub.exchanges.join(', ') : null,
      sektor: sub.sicDescription || null,
      sicKod: sub.sic || null,
      tur: sub.entityType || null,
      eyalet: sub.stateOfIncorporation || null,
      // "0926" → "26 Eylül"
      mkSonu: mkAy.length === 4 ? `${mkAy.slice(2)}.${mkAy.slice(0, 2)}` : null,
      adres: [adr.street1, adr.city, adr.stateOrCountry, adr.zipCode].filter(Boolean).join(', ') || null,
      telefon: sub.phone || null,
      eskiAdlar: (sub.formerNames || []).map(f => f.name).filter(Boolean).slice(0, 3),
      edgar: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=10`,
    };

    let yillik = null, ceyreklik = null, uyari = null;
    if (factR.ok) {
      const facts = await factR.json();
      const usGaap = (facts.facts && facts.facts['us-gaap']) || null;
      if (usGaap) {
        yillik = tabloKur(usGaap, 'yillik', 5);
        ceyreklik = tabloKur(usGaap, 'ceyrek', 6);
        // Yeniden yapılanan şirketlerde ticker yeni bir tüzel kişiliğe
        // bağlanıyor (ExxonMobil Holdings gibi) ve yıllık geçmiş selef
        // kayıtta kalıyor — sessizce boş tablo göstermek yerine söyle
        if (!yillik && ceyreklik) {
          uyari = 'Bu şirket yakın zamanda yeniden yapılandı; yıllık tablolar yeni kayıtta henüz oluşmadı, çeyreklikler gösteriliyor.';
        }
      } else {
        uyari = 'Şirketin XBRL finansal verisi bulunamadı.';
      }
    } else {
      uyari = 'Finansal tablolar şu an alınamadı; künye bilgisi gösteriliyor.';
    }

    const [ozet, haberler] = await Promise.all([
      ozetGetir(kunye.ad).catch(() => null),
      haberGetir(kunye.ad, ticker).catch(() => []),
    ]);

    // Haberler saatlik değişiyor, finansallar çeyreklik — daha kısa cache
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=21600');
    return res.status(200).json({ kunye, ozet, haberler, yillik, ceyreklik, finansal: true, uyari, ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
