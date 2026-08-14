// /api/logo.js — Barış Investing
// Sunucu taraflı logo proxy — CORS sorununu ortadan kaldırır
// GET /api/logo?domain=thy.com
// GET /api/logo?domain=apple.com&sz=128
// Canvas'ta crossOrigin sorunu olmadan kullanılabilir

const DEBUG_LOGS = process.env.DEBUG_LOGS === '1';
function dlog(...args) { if (DEBUG_LOGS) console.log(...args); }

const CACHE = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 saat — logolar sık değişmez

// Bilinen şirketler için fallback domain haritası
const DOMAIN_MAP = {
  // ── BIST — Bankalar & Holdingler ──
  'AKBNK': 'akbank.com',
  'GARAN': 'garantibbva.com.tr',
  'ISCTR': 'isbank.com.tr',
  'YKBNK': 'yapikredi.com.tr',
  'HALKB': 'halkbank.com.tr',
  'VAKBN': 'vakifbank.com.tr',
  'TSKB':  'tskb.com.tr',
  'SKBNK': 'sekerbank.com.tr',
  'ALBRK': 'albaraka.com.tr',
  'ICBCT': 'icbc.com.tr',
  'KCHOL': 'koc.com.tr',
  'SAHOL': 'sabanci.com',
  'AGHOL': 'anadolugrubu.com.tr',
  'DOHOL': 'doganholding.com.tr',
  'GLYHO': 'globalyatirim.com.tr',
  'ALARK': 'alarko.com.tr',
  'TKFEN': 'tekfen.com.tr',
  'ENKAI': 'enka.com',
  'SISE':  'sisecam.com',
  // ── BIST — Sanayi & Enerji ──
  'EREGL': 'erdemir.com.tr',
  'ISDMR': 'isdemir.com.tr',
  'KRDMD': 'kardemir.com.tr',
  'TUPRS': 'tupras.com.tr',
  'PETKM': 'petkim.com.tr',
  'SASA':  'sasa.com.tr',
  'AKSA':  'aksa.com',
  'ALKIM': 'alkim.com.tr',
  'BAGFS': 'bagfas.com.tr',
  'GUBRF': 'gubretas.com.tr',
  'HEKTS': 'hektas.com.tr',
  'KORDS': 'kordsa.com',
  'BRISA': 'brisa.com.tr',
  'CIMSA': 'cimsa.com.tr',
  'AKCNS': 'akcansa.com.tr',
  'OYAKC': 'oyakcimento.com',
  'BRSAN': 'borusanboru.com',
  'EGEEN': 'egeendustri.com.tr',
  'PARSN': 'parsan.com.tr',
  'KARTN': 'kartonsan.com.tr',
  'ECILC': 'eczacibasi.com.tr',
  // Enerji
  'ENJSA': 'enerjisa.com.tr',
  'AKSEN': 'aksaenerji.com.tr',
  'ZOREN': 'zorluenerji.com.tr',
  'AYDEM': 'aydemenerji.com.tr',
  'GWIND': 'galatawind.com',
  'ASTOR': 'astor.com.tr',
  'KONTR': 'kontrolmatik.com',
  // ── BIST — Otomotiv & Ulaştırma ──
  'FROTO': 'fordotosan.com.tr',
  'TOASO': 'tofas.com.tr',
  'OTKAR': 'otokar.com.tr',
  'KARSN': 'karsan.com.tr',
  'TTRAK': 'turktraktor.com.tr',
  'TMSN':  'tumosan.com.tr',
  'DOAS':  'doas.com.tr',
  'THYAO': 'thy.com',
  'PGSUS': 'flypgs.com',
  'TAVHL': 'tav.aero',
  'CLEBI': 'celebi.com',
  // ── BIST — Perakende & Tüketim ──
  'BIMAS': 'bim.com.tr',
  'MGROS': 'migros.com.tr',
  'SOKM':  'sok.com.tr',
  'BIZIM': 'bizimtoptan.com.tr',
  'CRFSA': 'carrefoursa.com',
  'MAVI':  'mavicompany.com',
  'YATAS': 'yatas.com.tr',
  'ULKER': 'ulker.com.tr',
  'AEFES': 'anadoluefes.com',
  'CCOLA': 'coca-colaic.com',
  'BANVT': 'banvit.com',
  'PNSUT': 'pinar.com.tr',
  'TATGD': 'tatgida.com',
  'SELEC': 'selcukecza.com.tr',
  'MPARK': 'mlpcare.com',
  'ARCLK': 'arcelik.com',
  'VESTL': 'vestel.com.tr',
  'VESBE': 'vestel.com.tr',
  // ── BIST — Telekom & Teknoloji ──
  'TCELL': 'turkcell.com.tr',
  'TTKOM': 'turktelekom.com.tr',
  'ASELS': 'aselsan.com.tr',
  'LOGO':  'logo.com.tr',
  'KAREL': 'karel.com.tr',
  'NETAS': 'netas.com.tr',
  'ARENA': 'arena.com.tr',
  // ── BIST — GYO & Madencilik ──
  'EKGYO': 'emlakkonut.com.tr',
  'ISGYO': 'isgyo.com.tr',
  'TRGYO': 'torunlargyo.com.tr',
  'KOZAL': 'koza-altin.com.tr',
  // ── BIST — evrendeki kalan hisseler (domain'i doğrulananlar) ──
  'TURSG': 'turkiyesigorta.com.tr',
  'ANSGR': 'anadolusigorta.com.tr',
  'ISMEN': 'isyatirim.com.tr',
  'ZRGYO': 'ziraatgyo.com.tr',
  'ENERY': 'enerya.com.tr',
  'ODAS':  'odasenerji.com.tr',
  'SDTTR': 'sdt.com.tr',
  'REEDR': 'reeder.com.tr',
  'MIATK': 'miateknoloji.com',
  'PENTA': 'penta.com.tr',
  'KRDMA': 'kardemir.com',
  'BRYAT': 'borusanyatirim.com',
  'TUKAS': 'tukas.com.tr',
  'OBAMS': 'obamakarna.com.tr',
  'ULUUN': 'ulusoyun.com.tr',
  'TABGD': 'tabgida.com.tr',
  'ALFAS': 'alfasolar.com.tr',
  'GESAN': 'girisimelektrik.com',
  'SMRTG': 'smartsolar.com.tr',
  'FENER': 'fenerbahce.org',
  // Domain'i doğrulayamadığım hisseler bilerek eklenmedi — yanlış logo
  // göstermektense baş harf avatarı daha dürüst:
  // CANTE, AGROT, BINHO, PASEU, KLSER, RALYH, CWENE, KCAER, NTHOL,
  // QUAGR, YEOTK, YYLGD
  // ── NYSE / NASDAQ ──
  'AAPL':  'apple.com',
  'MSFT':  'microsoft.com',
  'NVDA':  'nvidia.com',
  'GOOGL': 'google.com',
  'META':  'meta.com',
  'AMZN':  'amazon.com',
  'TSLA':  'tesla.com',
  'AMD':   'amd.com',
  'PLTR':  'palantir.com',
  'CRWD':  'crowdstrike.com',
  'XOM':    'exxonmobil.com',
  'KMI':    'kindermorgan.com',
  'CVX':    'chevron.com',
  'SLB':    'slb.com',
  'WMB':    'williams.com',
  'COP':    'conocophillips.com',
  'OXY':    'oxy.com',
  'OKE':    'oneok.com',
  'EOG':    'eogresources.com',
  'PSX':    'phillips66.com',
  'MPC':    'marathonpetroleum.com',
  'VLO':    'valero.com',
  'BAC':    'bankofamerica.com',
  'WFC':    'wellsfargo.com',
  'JPM':    'jpmorganchase.com',
  'SCHW':   'schwab.com',
  'V':      'visa.com',
  'C':      'citigroup.com',
  'MS':     'morganstanley.com',
  'KKR':    'kkr.com',
  'MA':     'mastercard.com',
  'BX':     'blackstone.com',
  'AXP':    'americanexpress.com',
  'COF':    'capitalone.com',
  'PGR':    'progressive.com',
  'ICE':    'ice.com',
  'CB':     'chubb.com',
  'CME':    'cmegroup.com',
  'SPGI':   'spglobal.com',
  'GS':     'goldmansachs.com',
  'AON':    'aon.com',
  'BLK':    'blackrock.com',
  'PLD':    'prologis.com',
  'O':      'realtyincome.com',
  'WELL':   'welltower.com',
  'AMT':    'americantower.com',
  'CCI':    'crowncastle.com',
  'DLR':    'digitalrealty.com',
  'SPG':    'simon.com',
  'PSA':    'publicstorage.com',
  'EQIX':   'equinix.com',
  'T':      'att.com',
  'NFLX':   'netflix.com',
  'VZ':     'verizon.com',
  'CMCSA':  'comcast.com',
  'DIS':    'disney.com',
  'TMUS':   't-mobile.com',
  'EA':     'ea.com',
  'NEE':    'nexteraenergy.com',
  'SO':     'southerncompany.com',
  'EXC':    'exeloncorp.com',
  'D':      'dominionenergy.com',
  'DUK':    'duke-energy.com',
  'SRE':    'sempra.com',
  'XEL':    'xcelenergy.com',
  'AEP':    'aep.com',
  'PEG':    'pseg.com',
  'ED':     'coned.com',
  'PFE':    'pfizer.com',
  'MRK':    'merck.com',
  'JNJ':    'jnj.com',
  'BMY':    'bms.com',
  'ABBV':   'abbvie.com',
  'ABT':    'abbott.com',
  'BSX':    'bostonscientific.com',
  'MDT':    'medtronic.com',
  'CVS':    'cvshealth.com',
  'GILD':   'gilead.com',
  'UNH':    'unitedhealthgroup.com',
  'LLY':    'lilly.com',
  'DHR':    'danaher.com',
  'AMGN':   'amgen.com',
  'ZTS':    'zoetis.com',
  'SYK':    'stryker.com',
  'TMO':    'thermofisher.com',
  'ISRG':   'intuitive.com',
  'CI':     'cigna.com',
  'VRTX':   'vrtx.com',
  'HCA':    'hcahealthcare.com',
  'ELV':    'elevancehealth.com',
  'REGN':   'regeneron.com',
  'CSX':    'csx.com',
  'RTX':    'rtx.com',
  'GE':     'ge.com',
  'BA':     'boeing.com',
  'UPS':    'ups.com',
  'UNP':    'up.com',
  'EMR':    'emerson.com',
  'CAT':    'caterpillar.com',
  'WM':     'wm.com',
  'ETN':    'eaton.com',
  'HON':    'honeywell.com',
  'ITW':    'itw.com',
  'GD':     'gd.com',
  'DE':     'deere.com',
  'FDX':    'fedex.com',
  'LMT':    'lockheedmartin.com',
  'TT':     'tranetechnologies.com',
  'NOC':    'northropgrumman.com',
  'PH':     'parker.com',
  'INTC':   'intel.com',
  'AVGO':   'broadcom.com',
  'CSCO':   'cisco.com',
  'ORCL':   'oracle.com',
  'KLAC':   'kla.com',
  'LRCX':   'lamresearch.com',
  'MU':     'micron.com',
  'QCOM':   'qualcomm.com',
  'NOW':    'servicenow.com',
  'IBM':    'ibm.com',
  'TXN':    'ti.com',
  'CRM':    'salesforce.com',
  'PANW':   'paloaltonetworks.com',
  'AMAT':   'appliedmaterials.com',
  'ACN':    'accenture.com',
  'ADI':    'analog.com',
  'ADBE':   'adobe.com',
  'ADP':    'adp.com',
  'CDNS':   'cadence.com',
  'INTU':   'intuit.com',
  'SNPS':   'synopsys.com',
  'FCX':    'fcx.com',
  'NEM':    'newmont.com',
  'DOW':    'dow.com',
  'LIN':    'linde.com',
  'ECL':    'ecolab.com',
  'SHW':    'sherwin-williams.com',
  'NUE':    'nucor.com',
  'APD':    'airproducts.com',
  'VMC':    'vulcanmaterials.com',
  'MLM':    'martinmarietta.com',
  'WMT':    'walmart.com',
  'KO':     'coca-colacompany.com',
  'PG':     'pg.com',
  'MO':     'altria.com',
  'PM':     'pmi.com',
  'PEP':    'pepsico.com',
  'MDLZ':   'mondelezinternational.com',
  'CL':     'colgatepalmolive.com',
  'KR':     'kroger.com',
  'GIS':    'generalmills.com',
  'SYY':    'sysco.com',
  'TGT':    'target.com',
  'COST':   'costco.com',
  'KMB':    'kimberly-clark.com',
  'F':      'ford.com',
  'CMG':    'chipotle.com',
  'NKE':    'nike.com',
  'SBUX':   'starbucks.com',
  'TJX':    'tjx.com',
  'HD':     'homedepot.com',
  'GM':     'gm.com',
  'BKNG':   'bookingholdings.com',
  'ABNB':   'airbnb.com',
  'MAR':    'marriott.com',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // domain veya ticker'dan domain türet
  let domain = req.query?.domain || '';
  const ticker = (req.query?.ticker || '').toUpperCase().replace('.IS', '');
  const sz = parseInt(req.query?.sz || '128');

  // Ticker → domain haritasından al
  if (!domain && ticker && DOMAIN_MAP[ticker]) {
    domain = DOMAIN_MAP[ticker];
  }

  // Domain temizle — sadece gecerli hostname karakterleri kalsin
  // (domain ucuncu taraf URL'lerine gomuluyor; ?/&/@ ile query/SSRF enjeksiyonunu engelle)
  domain = domain
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '');

  if (!domain) {
    // Domain bilinmiyor → 404 ki <img> onerror tetiklensin, çağıran avatar/baş harf göstersin
    return res.status(404).json({ error: 'domain bilinmiyor' });
  }

  const cacheKey = `logo:${domain}:${sz}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    res.setHeader('Content-Type', cached.mime);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(cached.buf);
  }

  // Kaynak sırası: DuckDuckGo → DuckDuckGo (www) → Google S2
  //
  // Clearbit (logo.clearbit.com) kaldırıldı: servis kapanmış, üç denemede de
  // bağlantı kurulamadı — zincirin başında boşuna bekletiyordu.
  // DuckDuckGo gerçek boyutlu ikon veriyor (evrendeki 155 ABD domain'inin
  // 144'ünde çalıştı); "www." öneki üçünü daha kurtarıyor. Google S2 son
  // çare: sadece 16x16 favicon veriyor ama bilmediği domain'e de bir şey
  // ürettiği için YALNIZCA haritadaki (doğrulanmış) domain'lerde güvenli.
  const sources = [
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://icons.duckduckgo.com/ip3/www.${domain}.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=${sz}`,
  ];

  for (const url of sources) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BarisInvesting/1.0)' },
        signal: AbortSignal.timeout(6000),
        redirect: 'follow',
      });

      if (!r.ok) continue;

      const mime = r.headers.get('content-type') || 'image/png';
      // SVG veya HTML döndüyse atla (Clearbit bazen 1x1 SVG döner)
      if (mime.includes('text') || mime.includes('svg')) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) continue; // Çok küçük = placeholder

      // Cache'e al
      CACHE.set(cacheKey, { buf, mime, ts: Date.now() });
      if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value);

      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      dlog(`[Logo] ${domain} → ${url} (${buf.length} bytes)`);
      return res.status(200).send(buf);

    } catch (e) {
      dlog(`[Logo] ${domain} ${url} hata: ${e.message}`);
    }
  }

  // Hiçbiri çalışmadı → 404 (çağıran <img> onerror ile avatar/baş harf gösterir)
  return res.status(404).json({ error: 'logo bulunamadı' });
}
