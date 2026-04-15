"""
bist_pipeline.py — Baris Investing Otonom Ajan MVP v2
Katman 1: Vercel proxy uzerinden temel + teknik veri
Katman 2: Validation (sanity gates, cross-check)
Katman 3: GARP skoru + Teknik teyit + Supabase upsert
"""

import httpx
import asyncio
import argparse
import json
import os
import math
from datetime import datetime, timezone
from dataclasses import dataclass, field, asdict
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
BIST_API_URL = os.getenv("BIST_API_URL", "https://barisinvesting.com/api/bist-ratios")
USDT_TRY     = float(os.getenv("USDT_TRY", "32.5"))

# TradingView'e eklenecek teknik kolonlar
TV_TECHNICAL_COLUMNS = [
    "RSI",                    # RSI(14)
    "obv",                    # On Balance Volume
    "SMA50",                  # 50 gunluk hareketli ortalama
    "SMA200",                 # 200 gunluk hareketli ortalama
    "volume",                 # Gunluk hacim
    "average_volume_10d_calc" # 10 gunluk ort hacim
]

BIST_UNIVERSE = [
    "THYAO", "ASELS", "EREGL", "KCHOL", "SASA", "TOASO", "BIMAS",
    "AKBNK", "GARAN", "YKBNK", "TUPRS", "SAHOL", "FROTO", "PGSUS",
    "VESTL", "TTKOM", "TCELL", "DOHOL", "KOZAL", "ENKAI",
]

GATES = {
    "fk":      (0.5,   80.0),
    "pddd":    (0.05,  25.0),
    "fd_favok":(-50.0, 60.0),
    "roe":     (-100.0, 200.0),
    "de":      (0.0,   50.0),
    "buyume":  (-80.0, 500.0),
    "rsi":     (0.0,   100.0),
}

# ── DATA CLASSES ─────────────────────────────────────────────────
@dataclass
class RawRatios:
    ticker:        str
    fiyat:         Optional[float] = None
    fk:            Optional[float] = None
    pddd:          Optional[float] = None
    piyasa_degeri: Optional[float] = None
    fd_favok:      Optional[float] = None
    roe:           Optional[float] = None
    de:            Optional[float] = None
    eps:           Optional[float] = None
    buyume_yoy:    Optional[float] = None
    ozsermaye:     Optional[float] = None
    # Teknik
    rsi:           Optional[float] = None
    obv:           Optional[float] = None
    sma50:         Optional[float] = None
    sma200:        Optional[float] = None
    volume:        Optional[float] = None
    avg_volume:    Optional[float] = None
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

@dataclass
class ValidatedRatios:
    ticker:         str
    # Temel
    fk:             Optional[float] = None
    pddd:           Optional[float] = None
    fd_favok:       Optional[float] = None
    roe:            Optional[float] = None
    de:             Optional[float] = None
    buyume_yoy:     Optional[float] = None
    fiyat:          Optional[float] = None
    pddd_computed:  Optional[float] = None
    pddd_delta_pct: Optional[float] = None
    pddd_guvenis:   str  = "LOW"
    fk_computed:    Optional[float] = None
    # Teknik
    rsi:            Optional[float] = None
    obv:            Optional[float] = None
    sma50:          Optional[float] = None
    sma200:         Optional[float] = None
    volume:         Optional[float] = None
    avg_volume:     Optional[float] = None
    teknik_teyit:   str  = "BELIRSIZ"  # GUCLU / ZAYIF / BELIRSIZ
    teknik_notlar:  list = field(default_factory=list)
    # Sonuc
    flags:          list = field(default_factory=list)
    garp_skoru:     Optional[float] = None
    teknik_skoru:   Optional[float] = None
    final_skoru:    Optional[float] = None
    sinyal:         str  = "NOTR"
    ts: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# ── HELPERS ───────────────────────────────────────────────────────
def _safe(val, decimals=2):
    if val is None or val == "":
        return None
    try:
        n = float(val)
        return None if (math.isnan(n) or math.isinf(n)) else round(n, decimals)
    except (TypeError, ValueError):
        return None

# ── KATMAN 1: VERİ ÇEKME ─────────────────────────────────────────
# Temel rasyolar: Vercel /api/bist-ratios endpoint'i
# Teknik veriler: TradingView Scanner direkt (teknik kolonlar icin ayri istek)

TV_SCANNER_URL = "https://scanner.tradingview.com/turkey/scan"

async def fetch_technical(tickers: list, client: httpx.AsyncClient) -> dict:
    """TradingView'den teknik verileri cek. Sadece teknik kolonlar."""
    syms = [f"BIST:{t.upper().replace('.IS','').replace('BIST:','')}" for t in tickers]
    payload = {
        "symbols": {"tickers": syms, "query": {"types": []}},
        "columns": TV_TECHNICAL_COLUMNS,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept":       "application/json",
        "Origin":       "https://www.tradingview.com",
        "Referer":      "https://www.tradingview.com/",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }
    try:
        r = await client.post(TV_SCANNER_URL, json=payload, headers=headers, timeout=15.0)
        if r.status_code != 200:
            print(f"  [TV Teknik] HTTP {r.status_code} — teknik veri atlanacak")
            return {}
        data = r.json()
    except Exception as e:
        print(f"  [TV Teknik] Hata: {e} — teknik veri atlanacak")
        return {}

    idx = {col: i for i, col in enumerate(TV_TECHNICAL_COLUMNS)}
    results = {}
    for row in data.get("data", []):
        sym = row.get("s", "").replace("BIST:", "").upper()
        d   = row.get("d", [])
        def c(name):
            i = idx.get(name)
            return d[i] if (i is not None and i < len(d)) else None
        results[sym] = {
            "rsi":        _safe(c("RSI")),
            "obv":        _safe(c("obv"), 0),
            "sma50":      _safe(c("SMA50")),
            "sma200":     _safe(c("SMA200")),
            "volume":     _safe(c("volume"), 0),
            "avg_volume": _safe(c("average_volume_10d_calc"), 0),
        }
    return results

async def fetch_fundamentals(tickers: list, client: httpx.AsyncClient) -> dict:
    """Vercel proxy uzerinden temel rasyolari cek."""
    ticker_str = ",".join([t.upper().replace(".IS","").replace("BIST:","") for t in tickers])
    url = f"{BIST_API_URL}?ticker={ticker_str}"
    print(f"  [Temel] GET {url}")

    r = await client.get(url, timeout=20.0)
    r.raise_for_status()
    data = r.json()

    if len(tickers) == 1:
        t = tickers[0].upper().replace(".IS","").replace("BIST:","")
        data = {t: data}

    results = {}
    for sym, d in data.items():
        if not isinstance(d, dict) or d.get("hata"):
            print(f"  [Temel] SKIP {sym}")
            continue
        results[sym] = d
    return results

async def fetch_all(tickers: list) -> dict:
    """Temel + teknik veriyi paralel cek, birlestir."""
    async with httpx.AsyncClient(follow_redirects=True) as client:
        fund_task = fetch_fundamentals(tickers, client)
        tech_task = fetch_technical(tickers, client)
        fund_data, tech_data = await asyncio.gather(fund_task, tech_task)

    print(f"  [Temel] {len(fund_data)} hisse | [Teknik] {len(tech_data)} hisse")

    results = {}
    for sym, d in fund_data.items():
        tech = tech_data.get(sym, {})
        raw = RawRatios(
            ticker        = sym,
            fiyat         = _safe(d.get("GuncelFiyat")),
            fk            = _safe(d.get("FK")),
            pddd          = _safe(d.get("PDDD")),
            piyasa_degeri = _safe(d.get("PiyasaDegeri"), 0),
            fd_favok      = _safe(d.get("FD_FAVOK")),
            roe           = _safe(d.get("ROE")),
            de            = _safe(d.get("DebtEquity")),
            eps           = _safe((d.get("_raw") or {}).get("earnings_per_share_basic_ttm")),
            buyume_yoy    = _safe((d.get("_raw") or {}).get("revenue_growth_rate_1y")),
            rsi           = tech.get("rsi"),
            obv           = tech.get("obv"),
            sma50         = tech.get("sma50"),
            sma200        = tech.get("sma200"),
            volume        = tech.get("volume"),
            avg_volume    = tech.get("avg_volume"),
        )
        results[sym] = raw

    return results

# ── KATMAN 2: VALIDATION ──────────────────────────────────────────
def validate(raw: RawRatios) -> ValidatedRatios:
    flags = []
    v = ValidatedRatios(ticker=raw.ticker, fiyat=raw.fiyat)

    def gate(value, name):
        if value is None:
            return None
        lo, hi = GATES[name]
        if not (lo <= value <= hi):
            flags.append(f"{name.upper()}_OUT_OF_RANGE({value})")
            return None
        return value

    # F/K
    v.fk = gate(raw.fk, "fk")
    if raw.fiyat and raw.eps and raw.eps > 0:
        v.fk_computed = round(raw.fiyat / raw.eps, 2)
        if v.fk and abs(v.fk - v.fk_computed) / max(abs(v.fk), 0.01) > 0.30:
            flags.append(f"FK_MISMATCH(api={v.fk} hesap={v.fk_computed})")
            v.fk = v.fk_computed

    # PD/DD
    v.pddd = gate(raw.pddd, "pddd")
    if raw.piyasa_degeri and raw.ozsermaye and raw.ozsermaye != 0:
        mc_try  = raw.piyasa_degeri * USDT_TRY
        computed = round(mc_try / raw.ozsermaye, 2)
        v.pddd_computed = computed
        if v.pddd is not None:
            delta = abs(v.pddd - computed) / max(abs(computed), 0.01)
            v.pddd_delta_pct = round(delta * 100, 1)
            if delta < 0.15:
                v.pddd_guvenis = "HIGH"
            elif delta < 0.40:
                v.pddd_guvenis = "MEDIUM"
                flags.append(f"PDDD_SOFT_MISMATCH(api={v.pddd} hesap={computed})")
            else:
                v.pddd_guvenis = "LOW"
                flags.append(f"PDDD_HARD_MISMATCH(api={v.pddd} hesap={computed})")
                v.pddd = computed
        else:
            v.pddd = computed
            v.pddd_guvenis = "COMPUTED"

    # Diger temel
    v.fd_favok   = gate(raw.fd_favok, "fd_favok")
    v.roe        = gate(raw.roe, "roe")
    v.de         = gate(raw.de, "de")
    v.buyume_yoy = gate(raw.buyume_yoy, "buyume")

    # Teknik — gate'e sok ama silme, eksik veri normal
    v.rsi       = gate(raw.rsi, "rsi")
    v.obv       = raw.obv
    v.sma50     = raw.sma50
    v.sma200    = raw.sma200
    v.volume    = raw.volume
    v.avg_volume = raw.avg_volume

    v.flags = flags
    return v

# ── KATMAN 3A: GARP SKORU ────────────────────────────────────────
def garp_score(v: ValidatedRatios) -> float:
    score = 0.0
    max_score = 0.0

    def add(value, weight, fn):
        nonlocal score, max_score
        max_score += weight
        if value is not None:
            score += weight * fn(value)

    def fk_s(x):
        if x <= 0:  return 0.0
        if x <= 8:  return 0.7
        if x <= 15: return 1.0
        if x <= 25: return 0.7
        if x <= 40: return 0.3
        return 0.0

    def pddd_s(x):
        if x <= 0:   return 0.0
        if x <= 1.0: return 1.0
        if x <= 2.0: return 0.85
        if x <= 3.5: return 0.6
        if x <= 6.0: return 0.3
        return 0.0

    def fdf_s(x):
        if x < 0:   return 0.1
        if x <= 6:  return 0.9
        if x <= 10: return 1.0
        if x <= 15: return 0.75
        if x <= 20: return 0.4
        return 0.0

    def roe_s(x):
        if x <= 0:  return 0.0
        if x <= 10: return 0.3
        if x <= 20: return 0.7
        if x <= 35: return 1.0
        return 0.85

    def buy_s(x):
        if x < 0:   return 0.0
        if x <= 5:  return 0.2
        if x <= 15: return 0.6
        if x <= 30: return 1.0
        if x <= 60: return 0.85
        return 0.6

    add(v.fk,         20, fk_s)
    add(v.pddd,       20, pddd_s)
    add(v.fd_favok,   20, fdf_s)
    add(v.roe,        20, roe_s)
    add(v.buyume_yoy, 20, buy_s)

    if max_score == 0:
        return 0.0

    normalized = (score / max_score) * 100

    # Yuksek kaldirec cezasi
    if v.de and v.de > 3.0:
        normalized *= 0.85

    return round(normalized, 1)

# ── KATMAN 3B: TEKNİK SKOR ───────────────────────────────────────
def teknik_score(v: ValidatedRatios) -> tuple[float, str, list]:
    """
    Teknik teyit sistemi — 0 ile 100 arasi skor.
    Her sinyal +puan kazanir, negatif sinyaller -puan.
    Veri yoksa BELIRSIZ donar.
    """
    notlar = []
    puan   = 50.0  # baslangic notr
    veri_sayisi = 0

    # RSI analizi
    if v.rsi is not None:
        veri_sayisi += 1
        if 30 <= v.rsi <= 50:
            puan += 20
            notlar.append(f"RSI {v.rsi:.1f} — asiri satimdan donus bolgesi (GARP girisi icin ideal)")
        elif v.rsi < 30:
            puan += 12
            notlar.append(f"RSI {v.rsi:.1f} — asiri satim (dikkat: momentum kaybi olabilir)")
        elif 50 < v.rsi <= 65:
            puan += 5
            notlar.append(f"RSI {v.rsi:.1f} — notr bolge")
        elif v.rsi > 70:
            puan -= 15
            notlar.append(f"RSI {v.rsi:.1f} — asiri alim, giris zamani degil")

    # MA trend analizi
    if v.fiyat and v.sma50 and v.sma200:
        veri_sayisi += 1
        if v.sma50 > v.sma200:
            puan += 15
            notlar.append("50MA > 200MA — golden cross, yukari trend")
        else:
            puan -= 10
            notlar.append("50MA < 200MA — asagi trend, dikkatli ol")

        if v.fiyat > v.sma50:
            puan += 10
            notlar.append(f"Fiyat ({v.fiyat}) > 50MA ({v.sma50:.2f}) — kisa vade pozitif")
        else:
            puan -= 5
            notlar.append(f"Fiyat ({v.fiyat}) < 50MA ({v.sma50:.2f}) — kisa vade negatif")

    elif v.fiyat and v.sma50:
        veri_sayisi += 1
        if v.fiyat > v.sma50:
            puan += 8
            notlar.append(f"Fiyat > 50MA — trend destekli")
        else:
            puan -= 5
            notlar.append(f"Fiyat < 50MA — trend karsi")

    # Hacim analizi (OBV trendi yerine hacim/ort karsilastirma)
    if v.volume and v.avg_volume and v.avg_volume > 0:
        veri_sayisi += 1
        hacim_orani = v.volume / v.avg_volume
        if hacim_orani >= 1.5:
            puan += 10
            notlar.append(f"Hacim ortalamanin {hacim_orani:.1f}x ustunde — guclu ilgi")
        elif hacim_orani >= 1.0:
            puan += 3
            notlar.append(f"Hacim normal seviyelerde ({hacim_orani:.1f}x)")
        else:
            puan -= 5
            notlar.append(f"Hacim ortalamanin altinda ({hacim_orani:.1f}x) — ilgi azaliyor")

    # Veri yoksa belirsiz
    if veri_sayisi == 0:
        return 50.0, "BELIRSIZ", ["Teknik veri alinamadi"]

    # 0-100 araligina sabitle
    puan = max(0.0, min(100.0, puan))

    teyit = (
        "GUCLU"    if puan >= 65 else
        "ZAYIF"    if puan <= 35 else
        "BELIRSIZ"
    )

    return round(puan, 1), teyit, notlar

# ── KATMAN 3C: FİNAL SKOR ────────────────────────────────────────
def final_score(garp: float, teknik: float, teyit: str) -> tuple[float, str]:
    """
    GARP x Teknik birlesik skor.
    Teknik teyit yoksa GARP skoru cezalandirilir.
    Teknik guclu ise bonus.
    """
    if teyit == "GUCLU":
        final = garp * 0.75 + teknik * 0.25 + 5.0   # +5 bonus
    elif teyit == "ZAYIF":
        final = garp * 0.75 + teknik * 0.25 - 10.0  # -10 ceza
    else:
        final = garp * 0.80 + teknik * 0.20          # belirsiz: daha az teknik agirlik

    final = max(0.0, min(100.0, final))

    sinyal = (
        "AL"    if final >= 70 else
        "IZLE"  if final >= 50 else
        "NOTR"  if final >= 30 else
        "KACIN"
    )
    return round(final, 1), sinyal

# ── ANA PIPELINE ─────────────────────────────────────────────────
async def run_pipeline(tickers: list, save_to_supabase: bool = False) -> list:
    print(f"\n{'='*55}")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Pipeline v2 -- {len(tickers)} hisse")
    print(f"{'='*55}")

    raw_data = await fetch_all(tickers)
    print(f"  Toplam {len(raw_data)} hisse verisi hazir\n")

    results = []
    for ticker in tickers:
        raw = raw_data.get(ticker)
        if not raw:
            print(f"  SKIP {ticker}: veri yok")
            continue

        # Katman 2: Validate
        v = validate(raw)

        # Katman 3: Skorla
        v.garp_skoru  = garp_score(v)
        v.teknik_skoru, v.teknik_teyit, v.teknik_notlar = teknik_score(v)
        v.final_skoru, v.sinyal = final_score(v.garp_skoru, v.teknik_skoru, v.teknik_teyit)

        # Konsol ciktisi
        print(f"  [{ticker}]")
        print(f"    F/K:{v.fk or 'N/A'}  PD/DD:{v.pddd or 'N/A'}  FD/FAVOK:{v.fd_favok or 'N/A'}")
        print(f"    ROE:{'%'+str(round(v.roe,1)) if v.roe is not None else 'N/A'}  Buyume:{'%'+str(round(v.buyume_yoy,1)) if v.buyume_yoy is not None else 'N/A'}")
        print(f"    RSI:{v.rsi or 'N/A'}  50MA:{v.sma50 or 'N/A'}  200MA:{v.sma200 or 'N/A'}")
        print(f"    Teknik: {v.teknik_teyit} ({v.teknik_skoru}/100)")
        for not_ in v.teknik_notlar:
            print(f"      - {not_}")
        print(f"    GARP:{v.garp_skoru}  TEKNIK:{v.teknik_skoru}  FINAL:{v.final_skoru} -> {v.sinyal}")
        if v.flags:
            print(f"    FLAGS: {' | '.join(v.flags)}")
        print()

        results.append(asdict(v))

    if save_to_supabase and SUPABASE_URL and SUPABASE_KEY:
        await upsert_supabase(results)

    # AL sinyali ozeti
    al_list = [r for r in results if r["sinyal"] == "AL"]
    izle_list = [r for r in results if r["sinyal"] == "IZLE"]
    print(f"{'='*55}")
    print(f"OZET: {len(results)} hisse | AL:{len(al_list)} | IZLE:{len(izle_list)}")
    if al_list:
        print("AL sinyalleri:")
        for r in sorted(al_list, key=lambda x: x["final_skoru"], reverse=True):
            print(f"  {r['ticker']} — Final:{r['final_skoru']} GARP:{r['garp_skoru']} Teknik:{r['teknik_skoru']}")
    print(f"{'='*55}\n")

    return results

async def upsert_supabase(results: list):
    print("[Supabase] Yaziliyor...")
    url = f"{SUPABASE_URL}/rest/v1/bist_garp_scan"
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }
    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        r = await client.post(url, headers=headers, json=results)
        if r.status_code in (200, 201):
            print(f"  OK {len(results)} kayit yazildi")
        else:
            print(f"  HATA {r.status_code}: {r.text[:300]}")

# ── CLI ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tickers",  type=str)
    parser.add_argument("--universe", action="store_true")
    parser.add_argument("--supabase", action="store_true")
    parser.add_argument("--json",     action="store_true")
    args = parser.parse_args()

    if args.universe:
        target = BIST_UNIVERSE
    elif args.tickers:
        target = [t.strip().upper() for t in args.tickers.split(",")]
    else:
        target = ["THYAO", "ASELS", "EREGL", "KCHOL", "TOASO"]

    results = asyncio.run(run_pipeline(target, save_to_supabase=args.supabase))

    if args.json:
        fname = f"garp_scan_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
        with open(fname, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"JSON: {fname}")
