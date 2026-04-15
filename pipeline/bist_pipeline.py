"""
bist_pipeline.py — Baris Investing Otonom Ajan MVP
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
}

@dataclass
class RawRatios:
    ticker:       str
    fiyat:        Optional[float] = None
    fk:           Optional[float] = None
    pddd:         Optional[float] = None
    piyasa_degeri:Optional[float] = None
    fd_favok:     Optional[float] = None
    roe:          Optional[float] = None
    de:           Optional[float] = None
    eps:          Optional[float] = None
    buyume_yoy:   Optional[float] = None
    net_kar:      Optional[float] = None
    toplam_borc:  Optional[float] = None
    ozsermaye:    Optional[float] = None
    ts:           str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

@dataclass
class ValidatedRatios:
    ticker:          str
    fk:              Optional[float] = None
    pddd:            Optional[float] = None
    fd_favok:        Optional[float] = None
    roe:             Optional[float] = None
    de:              Optional[float] = None
    buyume_yoy:      Optional[float] = None
    fiyat:           Optional[float] = None
    pddd_computed:   Optional[float] = None
    pddd_delta_pct:  Optional[float] = None
    pddd_guvenis:    str  = "LOW"
    fk_computed:     Optional[float] = None
    flags:           list = field(default_factory=list)
    garp_skoru:      Optional[float] = None
    sinyal:          str  = "NOTR"
    ts:              str  = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

BIST_API_URL = os.getenv("BIST_API_URL", "https://barisinvesting.com/api/bist-ratios")

def _safe(val, decimals=2):
    if val is None or val == "":
        return None
    try:
        n = float(val)
        return None if (math.isnan(n) or math.isinf(n)) else round(n, decimals)
    except (TypeError, ValueError):
        return None

async def fetch_data(tickers: list) -> dict:
    ticker_str = ",".join([t.upper().replace(".IS","").replace("BIST:","") for t in tickers])
    url = f"{BIST_API_URL}?ticker={ticker_str}"
    print(f"  GET {url}")

    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()

    results = {}

    if len(tickers) == 1:
        t = tickers[0].upper().replace(".IS","").replace("BIST:","")
        data = {t: data}

    for sym, d in data.items():
        if not isinstance(d, dict) or d.get("hata"):
            print(f"  SKIP {sym}: veri yok")
            continue
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
        )
        results[sym] = raw

    return results

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

    v.fk = gate(raw.fk, "fk")
    if raw.fiyat and raw.eps and raw.eps > 0:
        v.fk_computed = round(raw.fiyat / raw.eps, 2)
        if v.fk and abs(v.fk - v.fk_computed) / max(abs(v.fk), 0.01) > 0.30:
            flags.append(f"FK_MISMATCH(api={v.fk} vs hesap={v.fk_computed})")
            v.fk = v.fk_computed

    v.pddd = gate(raw.pddd, "pddd")
    USDT_TRY = float(os.getenv("USDT_TRY", "32.5"))

    if raw.piyasa_degeri and raw.ozsermaye and raw.ozsermaye != 0:
        mc_try = raw.piyasa_degeri * USDT_TRY
        computed = round(mc_try / raw.ozsermaye, 2)
        v.pddd_computed = computed
        if v.pddd is not None:
            delta = abs(v.pddd - computed) / max(abs(computed), 0.01)
            v.pddd_delta_pct = round(delta * 100, 1)
            if delta < 0.15:
                v.pddd_guvenis = "HIGH"
            elif delta < 0.40:
                v.pddd_guvenis = "MEDIUM"
                flags.append(f"PDDD_SOFT_MISMATCH(api={v.pddd} hesap={computed} D%{v.pddd_delta_pct})")
            else:
                v.pddd_guvenis = "LOW"
                flags.append(f"PDDD_HARD_MISMATCH(api={v.pddd} hesap={computed} D%{v.pddd_delta_pct})")
                v.pddd = computed
        else:
            v.pddd = computed
            v.pddd_guvenis = "COMPUTED"

    v.fd_favok   = gate(raw.fd_favok, "fd_favok")
    v.roe        = gate(raw.roe, "roe")
    v.de         = gate(raw.de, "de")
    v.buyume_yoy = gate(raw.buyume_yoy, "buyume")
    v.flags = flags
    return v

def garp_score(v: ValidatedRatios):
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
        return 0.0, "VERI_YOK"

    normalized = (score / max_score) * 100
    if v.de and v.de > 3.0:
        normalized *= 0.85

    sinyal = (
        "AL"    if normalized >= 70 else
        "IZLE"  if normalized >= 50 else
        "NOTR"  if normalized >= 30 else
        "KACIN"
    )
    return round(normalized, 1), sinyal

async def run_pipeline(tickers: list, save_to_supabase: bool = False) -> list:
    print(f"\n{'='*55}")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Pipeline -- {len(tickers)} hisse")
    print(f"{'='*55}")

    raw_data = await fetch_data(tickers)
    print(f"  {len(raw_data)}/{len(tickers)} hisse alindi")

    results = []
    for ticker in tickers:
        raw = raw_data.get(ticker)
        if not raw:
            print(f"  SKIP {ticker}")
            continue

        v = validate(raw)
        v.garp_skoru, v.sinyal = garp_score(v)

        pddd_str = f"{v.pddd:.2f} [{v.pddd_guvenis}]" if v.pddd is not None else "N/A"
        print(f"\n  [{ticker}]")
        print(f"    F/K:     {v.fk or 'N/A'}")
        print(f"    PD/DD:   {pddd_str}")
        print(f"    FD/FAVOK:{v.fd_favok or 'N/A'}")
        print(f"    ROE:     {'%'+str(round(v.roe,1)) if v.roe is not None else 'N/A'}")
        print(f"    Buyume:  {'%'+str(round(v.buyume_yoy,1)) if v.buyume_yoy is not None else 'N/A'}")
        if v.flags:
            print(f"    Flags:   {' | '.join(v.flags)}")
        print(f"    GARP:    {v.garp_skoru}/100 -> {v.sinyal}")

        results.append(asdict(v))

    if save_to_supabase and SUPABASE_URL and SUPABASE_KEY:
        await upsert_supabase(results)

    print(f"\n[Tamamlandi] {len(results)} hisse islendi\n")
    return results

async def upsert_supabase(results: list):
    print("\n[Supabase] Yaziliyor...")
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
            print(f"  HATA {r.status_code}: {r.text[:200]}")

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
