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

const SEC_UA = process.env.SEC_UA || 'BarisInvesting/1.0 (info@barisinvesting.com)';
const BASLIK = { 'User-Agent': SEC_UA, 'Accept': 'application/json' };

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
    etiketler: ['PaymentsToAcquirePropertyPlantAndEquipment'] },
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
    const kayit = await cikBul(ticker);
    if (!kayit) {
      return res.status(404).json({
        error: 'Bu hisse SEC kayıtlarında bulunamadı',
        detay: 'Şirket profili şimdilik yalnızca ABD borsalarına kayıtlı şirketler için var.',
      });
    }
    const cik = String(kayit.cik).padStart(10, '0');

    const [subR, factR] = await Promise.all([
      fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: BASLIK, signal: AbortSignal.timeout(15000) }),
      fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: BASLIK, signal: AbortSignal.timeout(20000) }),
    ]);
    if (!subR.ok) throw new Error('SEC künye verisi alınamadı');
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
          uyari = 'Bu ticker SEC\'te yeni kurulmuş bir tüzel kişilik altında kayıtlı; yıllık tablolar henüz bu kayıtta yok. Geçmiş yıllar için aşağıdaki SEC dosyaları bağlantısını kullan.';
        }
      } else {
        uyari = 'Şirketin XBRL finansal verisi bulunamadı.';
      }
    } else {
      uyari = 'Finansal tablolar şu an alınamadı; künye bilgisi gösteriliyor.';
    }

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    return res.status(200).json({ kunye, yillik, ceyreklik, uyari, kaynak: 'SEC EDGAR', ts: Date.now() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
