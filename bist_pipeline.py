"""
bist_pipeline.py — Barış Investing Otonom Ajan MVP
====================================================
Katman 1: TradingView Scanner API → ham veri
Katman 2: Validation (sanity gates, cross-check, outlier)
Katman 3: Normalize + GARP skoru + Supabase upsert

Kullanım:
    pip install httpx supabase python-dotenv
    python bist_pipeline.py --tickers THYAO,ASELS,EREGL
    python bist_pipeline.py --universe  # watchlist'teki tüm hisseler
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

# ── CONFIG ───────────────────────────────────────────────────────
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")   # service_role key — server-side only

TV_URL     = "https://scanner.tradingview.com/turkey/scan"
TV_COLUMNS = [
    "close",                         # 0
    "price_earnings_ttm",            # 1  F/K
    "price_book_ratio",              # 2  PD/DD
    "market_cap_basic",              # 3  Piyasa Değeri (USD bazlı döner — dikkat!)
    "enterprise_value_ebitda_ttm",   # 4  FD/FAVÖK
    "return_on_equity",              # 5  ROE (TV zaten % cinsinden verir, x100 yapma)
    "debt_to_equity",                # 6  Borç/Özsermaye
    "earnings_per_share_basic_ttm",  # 7  EPS
    "revenue_growth_rate_1y",        # 8  Ciro büyümesi YoY
    "net_income",                    # 9  Net kâr (cross-check için)
    "total_debt",                    # 10 Toplam borç
    "total_equity",                  # 11 Özsermaye (PD/DD cross-check)
]

IDX = {col: i for i, col in enumerate(TV_COLUMNS)}

# Evrensel BIST tarama listesi (genişletilebilir)
BIST_UNIVERSE = [
    "THYAO", "ASELS", "EREGL", "KCHOL", "SASA", "TOASO", "BIMAS",
    "AKBNK", "GARAN", "YKBNK", "TUPRS", "SAHOL", "FROTO", "PGSUS",
    "VESTL", "TTKOM", "TCELL", "DOHOL", "KOZAL", "ENKAI",
]

# ── VALIDATION GATES ──────────────────────────────────────────────
# Her rasyo için (min, max) güvenli aralık.
# Bu sınırların dışı → flag veya None
GATES = {
    "fk":      (0.5,   80.0),   # negatif = zarar şirketi, >80 = büyüme premium
    "pddd":    (0.05,  25.0),   # <0.05 muhtemelen veri hatası; >25 çok nadir
    "fd_favok":(-50.0, 60.0),   # negatif FAVÖK mümkün ama -50 altı genelde hata
    "roe":     (-100.0, 200.0), # % cinsinden; >200 kaldıraç etkisi veya hata
    "de":      (0.0,   50.0),   # 50x üzeri kaldıraç pratikte imkânsız
    "buyume":  (-80.0, 500.0),  # %500 büyüme mümkün ama üstü şüpheli
}

# ── DATA CLASSES ─────────────────────────────────────────────────
@dataclass
class RawRatios:
    ticker:       str
    fiyat:        Optional[float] = None
    fk:           Optional[float] = None
    pddd:         Optional[float] = None
    piyasa_degeri:Optional[float] = None  # USD — normalize gerekli
    fd_favok:     Optional[float] = None
    roe:          Optional[float] = None  # % (TV'den geliyor)
    de:           Optional[float] = None
    eps:          Optional[float] = None
    buyume_yoy:   Optional[float] = None
    net_kar:      Optional[float] = None
    toplam_borc:  Optional[float] = None
    ozsermaye:    Optional[float] = None
    kaynak:       str             = "TradingView"
    ts:           str             = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

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
    # Hesaplanan / cross-check değerleri
    pddd_computed:   Optional[float] = None   # MC / Özsermaye manuel hesap
    pddd_delta_pct:  Optional[float] = None   # API vs hesap farkı %
    pddd_guvenis:    str             = "LOW"  # LOW | MEDIUM | HIGH
    fk_computed:     Optional[float] = None   # Fiyat / EPS
    flags:           list            = field(default_factory=list)
    garp_skoru:      Optional[float] = None
    sinyal:          str             = "NÖTR"  # AL / İZLE / NÖTR / KAÇIN
    ts:              str             = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

# ── KATMAN 1: VERİ ÇEKME ─────────────────────────────────────────
async def fetch_tradingview(tickers: list[str]) -> dict[str, RawRatios]:
    syms = [f"BIST:{t.upper().replace('.IS','').replace('BIST:','')}" for t in tickers]
    payload = {
        "symbols": {"tickers": syms, "query": {"types": []}},
        "columns": TV_COLUMNS,
    }
    headers = {
        "Content-Type": "application/json",
        "Accept":       "application/json",
        "Origin":       "https://www.tradingview.com",
        "Referer":      "https://www.tradingview.com/",
        "User-Agent":   "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(TV_URL, json=payload, headers=headers)
        r.raise_for_status()
        data = r.json()

    def _safe(val, decimals=2):
        if val is None or val == "":
            return None
        try:
            n = float(val)
            return None if (math.isnan(n) or math.isinf(n)) else round(n, decimals)
        except (TypeError, ValueError):
            return None

    results: dict[str, RawRatios] = {}
    for row in data.get("data", []):
        sym = row.get("s", "").replace("BIST:", "").upper()
        d   = row.get("d", [])

        def col(name):
            i = IDX.get(name)
            return d[i] if (i is not None and i < len(d)) else None

        raw = RawRatios(
            ticker        = sym,
            fiyat         = _safe(col("close")),
            fk            = _safe(col("price_earnings_ttm")),
            pddd          = _safe(col("price_book_ratio")),
            piyasa_degeri = _safe(col("market_cap_basic"), 0),
            fd_favok      = _safe(col("enterprise_value_ebitda_ttm")),
            roe           = _safe(col("return_on_equity")),     # TV → zaten %, x100 yapma
            de            = _safe(col("debt_to_equity")),
            eps           = _safe(col("earnings_per_share_basic_ttm")),
            buyume_yoy    = _safe(col("revenue_growth_rate_1y")),
            net_kar       = _safe(col("net_income"), 0),
            toplam_borc   = _safe(col("total_debt"), 0),
            ozsermaye     = _safe(col("total_equity"), 0),
        )
        results[sym] = raw

    return results

# ── KATMAN 2: VALIDATION ──────────────────────────────────────────
def validate(raw: RawRatios) -> ValidatedRatios:
    flags: list[str] = []
    v = ValidatedRatios(ticker=raw.ticker, fiyat=raw.fiyat)

    def gate(value, name) -> Optional[float]:
        """Değer sınırlar içindeyse döndür, değilse None + flag ekle."""
        if value is None:
            return None
        lo, hi = GATES[name]
        if not (lo <= value <= hi):
            flags.append(f"{name.upper()}_OUT_OF_RANGE({value})")
            return None
        return value

    # ── F/K ──
    v.fk = gate(raw.fk, "fk")
    # Cross-check: API F/K vs Fiyat/EPS
    if raw.fiyat and raw.eps and raw.eps > 0:
        v.fk_computed = round(raw.fiyat / raw.eps, 2)
        if v.fk and abs(v.fk - v.fk_computed) / max(abs(v.fk), 0.01) > 0.30:
            flags.append(f"FK_MISMATCH(api={v.fk} vs hesap={v.fk_computed})")
            # Hesaplanan değeri tercih et
            v.fk = v.fk_computed

    # ── PD/DD ── (en kritik alan)
    v.pddd = gate(raw.pddd, "pddd")

    # Cross-check: market_cap / özsermaye
    # TV market_cap_basic USD döner; özsermaye TRY; bunları doğrudan karşılaştıramayız.
    # Dolaylı kontrol: ratio'nun mantıklı bir aralıkta olup olmadığına bakıyoruz.
    # Gerçek cross-check için USD/TRY kur gerekir — bunu Yahoo'dan veya env'den alırız.
    USDT_TRY = float(os.getenv("USDT_TRY", "32.5"))  # fallback kur, env'den override et

    if raw.piyasa_degeri and raw.ozsermaye and raw.ozsermaye != 0:
        mc_try = raw.piyasa_degeri * USDT_TRY  # USD → TRY
        computed = round(mc_try / raw.ozsermaye, 2)
        v.pddd_computed = computed

        if v.pddd is not None:
            delta = abs(v.pddd - computed) / max(abs(computed), 0.01)
            v.pddd_delta_pct = round(delta * 100, 1)

            if delta < 0.15:
                v.pddd_guvenis = "HIGH"
            elif delta < 0.40:
                v.pddd_guvenis = "MEDIUM"
                flags.append(f"PDDD_SOFT_MISMATCH(api={v.pddd} vs hesap={computed}, Δ%{v.pddd_delta_pct})")
            else:
                v.pddd_guvenis = "LOW"
                flags.append(f"PDDD_HARD_MISMATCH(api={v.pddd} vs hesap={computed}, Δ%{v.pddd_delta_pct})")
                # API değerine güvenme, hesaplanmış değeri kullan
                v.pddd = computed
        else:
            # API'den değer gelmediyse hesaplananı kullan
            v.pddd = computed
            v.pddd_guvenis = "COMPUTED"

    # ── Diğer rasyolar ──
    v.fd_favok   = gate(raw.fd_favok, "fd_favok")
    v.roe        = gate(raw.roe, "roe")
    v.de         = gate(raw.de, "de")
    v.buyume_yoy = gate(raw.buyume_yoy, "buyume")

    v.flags = flags
    return v

# ── KATMAN 3: GARP SKORLAMA ───────────────────────────────────────
"""
GARP puanlama mantığı:
- Her metrik 0-20 puan, toplam 100 üzerinden.
- Ağırlıklar: F/K(20) + PD/DD(20) + FD/FAVÖK(20) + ROE(20) + Büyüme(20)
- 70+ → AL, 50-70 → İZLE, 30-50 → NÖTR, <30 → KAÇIN
"""

def garp_score(v: ValidatedRatios) -> tuple[float, str]:
    score = 0.0
    max_score = 0.0

    def add(value, weight, scorer_fn):
        nonlocal score, max_score
        max_score += weight
        if value is not None:
            score += weight * scorer_fn(value)

    # F/K: 8-15 → ideal GARP bölgesi
    def fk_scorer(x):
        if x <= 0:   return 0.0
        if x <= 8:   return 0.7   # çok ucuz = muhtemelen sorun var
        if x <= 15:  return 1.0   # ideal
        if x <= 25:  return 0.7
        if x <= 40:  return 0.3
        return 0.0

    # PD/DD: <1 ucuz, 1-3 adil, >4 pahalı
    def pddd_scorer(x):
        if x <= 0:   return 0.0
        if x <= 1.0: return 1.0
        if x <= 2.0: return 0.85
        if x <= 3.5: return 0.6
        if x <= 6.0: return 0.3
        return 0.0

    # FD/FAVÖK: <8 ucuz, 8-15 adil, >20 pahalı
    def fd_favok_scorer(x):
        if x < 0:    return 0.1   # negatif FAVÖK
        if x <= 6:   return 0.9
        if x <= 10:  return 1.0
        if x <= 15:  return 0.75
        if x <= 20:  return 0.4
        return 0.0

    # ROE: >15% iyi, >25% mükemmel
    def roe_scorer(x):
        if x <= 0:   return 0.0
        if x <= 10:  return 0.3
        if x <= 20:  return 0.7
        if x <= 35:  return 1.0
        return 0.85  # çok yüksek ROE kaldıraç şüphesi

    # Büyüme YoY: GARP'ta büyüme şart
    def buyume_scorer(x):
        if x < 0:    return 0.0
        if x <= 5:   return 0.2
        if x <= 15:  return 0.6
        if x <= 30:  return 1.0
        if x <= 60:  return 0.85
        return 0.6   # çok yüksek büyüme sürdürülebilirlik sorusu

    add(v.fk,        20, fk_scorer)
    add(v.pddd,      20, pddd_scorer)
    add(v.fd_favok,  20, fd_favok_scorer)
    add(v.roe,       20, roe_scorer)
    add(v.buyume_yoy,20, buyume_scorer)

    # Veri eksikliği cezası
    if max_score == 0:
        return 0.0, "VERİ YOK"

    normalized = (score / max_score) * 100

    # Borç yükü cezası
    if v.de and v.de > 3.0:
        normalized *= 0.85
        
    sinyal = (
        "AL"    if normalized >= 70 else
        "İZLE"  if normalized >= 50 else
        "NÖTR"  if normalized >= 30 else
        "KAÇIN"
    )
    return round(normalized, 1), sinyal

# ── ANA PIPELINE ─────────────────────────────────────────────────
async def run_pipeline(tickers: list[str], save_to_supabase: bool = False) -> list[dict]:
    print(f"\n{'='*60}")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Pipeline başlatılıyor — {len(tickers)} hisse")
    print(f"{'='*60}")

    # Katman 1: Fetch
    print("\n[1/3] TradingView'den ham veriler çekiliyor...")
    raw_data = await fetch_tradingview(tickers)
    print(f"  ✓ {len(raw_data)}/{len(tickers)} hisse verisi alındı")

    results = []
    for ticker in tickers:
        raw = raw_data.get(ticker)
        if not raw:
            print(f"  ✗ {ticker}: Veri bulunamadı")
            continue

        # Katman 2: Validate
        validated = validate(raw)

        # Katman 3: GARP Skor
        validated.garp_skoru, validated.sinyal = garp_score(validated)

        # Konsol çıktısı
        flag_str = " | ".join(validated.flags) if validated.flags else "—"
        pddd_str = (
            f"{validated.pddd:.2f} "
            f"[{validated.pddd_guvenis}]"
            f"{f' ← hesap:{validated.pddd_computed}' if validated.pddd_computed else ''}"
        ) if validated.pddd is not None else "N/A"

        print(f"\n  [{ticker}]")
        print(f"    F/K:     {validated.fk or 'N/A'}")
        print(f"    PD/DD:   {pddd_str}")
        print(f"    FD/FAVÖK:{validated.fd_favok or 'N/A'}")
        print(f"    ROE:     {f'%{validated.roe:.1f}' if validated.roe is not None else 'N/A'}")
        print(f"    Büyüme:  {f'%{validated.buyume_yoy:.1f}' if validated.buyume_yoy is not None else 'N/A'}")
        print(f"    Flags:   {flag_str}")
        print(f"    ──────────────────────────────")
        print(f"    GARP:    {validated.garp_skoru}/100 → {validated.sinyal}")

        result_dict = asdict(validated)
        results.append(result_dict)

    # Supabase kayıt (opsiyonel)
    if save_to_supabase and SUPABASE_URL and SUPABASE_KEY:
        await upsert_supabase(results)

    print(f"\n{'='*60}")
    print(f"[Pipeline tamamlandı] {len(results)} hisse işlendi")
    print(f"{'='*60}\n")
    return results

async def upsert_supabase(results: list[dict]):
    """Sonuçları Supabase'e yaz. Tablo: bist_garp_scan"""
    print("\n[Supabase] Veriler yazılıyor...")
    url = f"{SUPABASE_URL}/rest/v1/bist_garp_scan"
    headers = {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",  # upsert
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(url, headers=headers, json=results)
        if r.status_code in (200, 201):
            print(f"  ✓ {len(results)} kayıt yazıldı")
        else:
            print(f"  ✗ Supabase hata: {r.status_code} — {r.text[:200]}")

# ── CLI ──────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Barış Investing — BIST GARP Pipeline")
    parser.add_argument("--tickers",   type=str, help="Virgülle ayrılmış ticker listesi. Örn: THYAO,ASELS")
    parser.add_argument("--universe",  action="store_true", help="Tüm BIST_UNIVERSE listesini tara")
    parser.add_argument("--supabase",  action="store_true", help="Sonuçları Supabase'e kaydet")
    parser.add_argument("--json",      action="store_true", help="Sonuçları JSON dosyaya yaz")
    args = parser.parse_args()

    if args.universe:
        target = BIST_UNIVERSE
    elif args.tickers:
        target = [t.strip().upper() for t in args.tickers.split(",")]
    else:
        # Demo
        target = ["THYAO", "ASELS", "EREGL", "KCHOL", "TOASO"]

    results = asyncio.run(run_pipeline(target, save_to_supabase=args.supabase))

    if args.json:
        fname = f"garp_scan_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
        with open(fname, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"JSON kaydedildi: {fname}")
