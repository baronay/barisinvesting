"""
global_pipeline.py — Baris Investing Global GARP Pipeline
NYSE/NASDAQ hisseleri icin Yahoo Finance veri kaynagi
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

# S&P 500 secilmis kaliteli hisseler
SP500_UNIVERSE = [
    # Teknoloji
    "AAPL","MSFT","GOOGL","META","NVDA","AMZN","CRM","ADBE","ORCL","CSCO",
    # Finans
    "BRK-B","JPM","V","MA","BAC","WFC","GS","MS",
    # Saglik
    "JNJ","UNH","LLY","ABBV","MRK","PFE","TMO","ABT",
    # Tuketici
    "PG","KO","PEP","WMT","COST","MCD","NKE","SBUX",
    # Enerji / Sanayi
    "XOM","CVX","CAT","HON","UPS","DE",
    # Diger
    "BRK-B","TSLA","NFLX","DIS",
]

GATES = {
    "fk":      (0.5,  80.0),
    "pddd":    (0.05, 25.0),
    "fd_favok":(-50.0,60.0),
    "roe":     (-100.0,200.0),
    "de":      (0.0,  50.0),
    "buyume":  (-80.0,500.0),
    "rsi":     (0.0,  100.0),
}

@dataclass
class GlobalRatios:
    ticker:      str
    exchange:    str = "NYSE"
    fiyat:       Optional[float] = None
    fk:          Optional[float] = None
    pddd:        Optional[float] = None
    fd_favok:    Optional[float] = None
    roe:         Optional[float] = None
    de:          Optional[float] = None
    buyume_yoy:  Optional[float] = None
    eps:         Optional[float] = None
    rsi:         Optional[float] = None
    sma50:       Optional[float] = None
    sma200:      Optional[float] = None
    volume:      Optional[float] = None
    avg_volume:  Optional[float] = None
    flags:       list = field(default_factory=list)
    garp_skoru:  Optional[float] = None
    teknik_skoru:Optional[float] = None
    teknik_teyit:str = "BELIRSIZ"
    final_skoru: Optional[float] = None
    sinyal:      str = "NOTR"
    ts:          str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

def _safe(val, decimals=2):
    if val is None or val == "": return None
    try:
        n = float(val)
        return None if (math.isnan(n) or math.isinf(n)) else round(n, decimals)
    except: return None

async def fetch_yahoo(ticker: str, client: httpx.AsyncClient) -> Optional[GlobalRatios]:
    """Yahoo Finance v10 ile tek hisse verisi cek."""
    try:
        url = f"https://query1.finance.yahoo.com/v10/finance/quoteSummary/{ticker}?modules=summaryDetail,defaultKeyStatistics,financialData,price"
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
            "Referer": "https://finance.yahoo.com/",
        }
        r = await client.get(url, headers=headers, timeout=10.0)
        if r.status_code != 200:
            print(f"  [{ticker}] HTTP {r.status_code}")
            return None

        j = r.json()
        result = j.get("quoteSummary", {}).get("result", [{}])[0]
        sd = result.get("summaryDetail", {})
        ks = result.get("defaultKeyStatistics", {})
        fd = result.get("financialData", {})
        pr = result.get("price", {})

        def v(d, k): return d.get(k, {}).get("raw") if isinstance(d.get(k), dict) else d.get(k)

        exchange = pr.get("exchangeName", "NYSE")
        if "NAS" in exchange.upper(): exchange = "NASDAQ"
        elif "NYQ" in exchange.upper() or "NYSE" in exchange.upper(): exchange = "NYSE"

        return GlobalRatios(
            ticker     = ticker,
            exchange   = exchange,
            fiyat      = _safe(v(pr, "regularMarketPrice")),
            fk         = _safe(v(sd, "trailingPE")),
            pddd       = _safe(v(ks, "priceToBook")),
            fd_favok   = _safe(v(ks, "enterpriseToEbitda")),
            roe        = _safe((v(fd, "returnOnEquity") or 0) * 100),
            de         = _safe(v(fd, "debtToEquity")),
            buyume_yoy = _safe((v(fd, "revenueGrowth") or 0) * 100),
            eps        = _safe(v(ks, "trailingEps")),
        )
    except Exception as e:
        print(f"  [{ticker}] Hata: {e}")
        return None

async def fetch_technical_yahoo(ticker: str, client: httpx.AsyncClient, raw: GlobalRatios) -> GlobalRatios:
    """Yahoo Finance v8 chart'tan RSI ve MA hesapla."""
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1d&range=1y"
        headers = {"User-Agent": "Mozilla/5.0","Referer": "https://finance.yahoo.com/"}
        r = await client.get(url, headers=headers, timeout=10.0)
        if r.status_code != 200: return raw

        j = r.json()
        closes = j.get("chart", {}).get("result", [{}])[0].get("indicators", {}).get("quote", [{}])[0].get("close", [])
        volumes = j.get("chart", {}).get("result", [{}])[0].get("indicators", {}).get("quote", [{}])[0].get("volume", [])

        closes = [c for c in closes if c is not None]
        volumes = [v for v in volumes if v is not None]

        if len(closes) < 14: return raw

        # RSI hesapla
        gains, losses = [], []
        for i in range(1, 15):
            diff = closes[-i] - closes[-i-1]
            if diff > 0: gains.append(diff); losses.append(0)
            else: gains.append(0); losses.append(abs(diff))
        avg_gain = sum(gains) / 14
        avg_loss = sum(losses) / 14
        if avg_loss == 0: rsi = 100.0
        else: rs = avg_gain / avg_loss; rsi = round(100 - (100 / (1 + rs)), 2)

        # MA hesapla
        sma50  = round(sum(closes[-50:]) / min(50, len(closes[-50:])), 4) if len(closes) >= 50 else None
        sma200 = round(sum(closes[-200:]) / min(200, len(closes[-200:])), 4) if len(closes) >= 200 else None

        # Hacim
        volume     = _safe(volumes[-1], 0) if volumes else None
        avg_volume = _safe(sum(volumes[-10:]) / min(10, len(volumes[-10:])), 0) if len(volumes) >= 5 else None

        raw.rsi        = rsi
        raw.sma50      = sma50
        raw.sma200     = sma200
        raw.volume     = volume
        raw.avg_volume = avg_volume

    except Exception as e:
        print(f"  [{ticker}] Teknik hata: {e}")

    return raw

def validate_and_score(raw: GlobalRatios) -> GlobalRatios:
    flags = []

    def gate(value, name):
        if value is None: return None
        lo, hi = GATES[name]
        if not (lo <= value <= hi):
            flags.append(f"{name.upper()}_OUT_OF_RANGE({value})")
            return None
        return value

    raw.fk        = gate(raw.fk, "fk")
    raw.pddd      = gate(raw.pddd, "pddd")
    raw.fd_favok  = gate(raw.fd_favok, "fd_favok")
    raw.roe       = gate(raw.roe, "roe")
    raw.de        = gate(raw.de, "de")
    raw.buyume_yoy= gate(raw.buyume_yoy, "buyume")
    raw.rsi       = gate(raw.rsi, "rsi")
    raw.flags     = flags

    # GARP skor
    score = 0.0; ms = 0.0
    def add(val, w, fn):
        nonlocal score, ms
        ms += w
        if val is not None: score += w * fn(val)

    def fk_s(x):
        if x<=0:return 0.0
        if x<=10:return 0.7
        if x<=18:return 1.0
        if x<=28:return 0.7
        if x<=45:return 0.3
        return 0.0
    def pddd_s(x):
        if x<=0:return 0.0
        if x<=2.0:return 1.0
        if x<=4.0:return 0.8
        if x<=7.0:return 0.5
        if x<=12.0:return 0.2
        return 0.0
    def fdf_s(x):
        if x<0:return 0.1
        if x<=8:return 0.9
        if x<=12:return 1.0
        if x<=18:return 0.7
        if x<=25:return 0.3
        return 0.0
    def roe_s(x):
        if x<=0:return 0.0
        if x<=10:return 0.3
        if x<=20:return 0.7
        if x<=40:return 1.0
        return 0.85
    def buy_s(x):
        if x<0:return 0.0
        if x<=5:return 0.2
        if x<=15:return 0.6
        if x<=30:return 1.0
        if x<=60:return 0.85
        return 0.6

    add(raw.fk,20,fk_s); add(raw.pddd,20,pddd_s); add(raw.fd_favok,20,fdf_s)
    add(raw.roe,20,roe_s); add(raw.buyume_yoy,20,buy_s)
    raw.garp_skoru = round((score/ms)*100, 1) if ms > 0 else 0.0
    if raw.de and raw.de > 2.0: raw.garp_skoru = round(raw.garp_skoru * 0.9, 1)

    # Teknik skor
    puan = 50.0; veri = 0
    if raw.rsi is not None:
        veri += 1
        if 30<=raw.rsi<=50: puan+=20
        elif raw.rsi<30: puan+=12
        elif 50<raw.rsi<=65: puan+=5
        elif raw.rsi>70: puan-=15
    if raw.fiyat and raw.sma50 and raw.sma200:
        veri += 1
        if raw.sma50>raw.sma200: puan+=15
        else: puan-=10
        if raw.fiyat>raw.sma50: puan+=10
        else: puan-=5
    if raw.volume and raw.avg_volume and raw.avg_volume>0:
        veri += 1; oran=raw.volume/raw.avg_volume
        if oran>=1.5: puan+=10
        elif oran>=1.0: puan+=3
        else: puan-=5

    raw.teknik_skoru = round(max(0.0, min(100.0, puan)), 1)
    raw.teknik_teyit = "GUCLU" if raw.teknik_skoru>=65 else "ZAYIF" if raw.teknik_skoru<=35 else "BELIRSIZ"

    # Final
    if raw.teknik_teyit=="GUCLU": final=raw.garp_skoru*0.75+raw.teknik_skoru*0.25+5.0
    elif raw.teknik_teyit=="ZAYIF": final=raw.garp_skoru*0.75+raw.teknik_skoru*0.25-10.0
    else: final=raw.garp_skoru*0.80+raw.teknik_skoru*0.20
    raw.final_skoru = round(max(0.0,min(100.0,final)), 1)
    raw.sinyal = "AL" if raw.final_skoru>=70 else "IZLE" if raw.final_skoru>=50 else "NOTR" if raw.final_skoru>=30 else "KACIN"

    return raw

async def get_portfolio_tickers() -> list:
    """Supabase'den kullanicilarin portfoylerindeki NYSE/NASDAQ hisselerini cek."""
    try:
        url = f"{SUPABASE_URL}/rest/v1/portfolios?select=data"
        headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.get(url, headers=headers)
            portfolios = r.json()

        tickers = set()
        for p in portfolios:
            try:
                hisseler = json.loads(p.get("data") or "[]")
                for h in hisseler:
                    if h.get("exchange") in ("NYSE", "NASDAQ"):
                        tickers.add(h["ticker"])
            except: pass
        return list(tickers)
    except Exception as e:
        print(f"  [Portfolio] Hata: {e}")
        return []

async def run_pipeline(tickers: list, save_to_supabase: bool = False):
    print(f"\n{'='*55}\n[{datetime.now().strftime('%H:%M:%S')}] Global Pipeline -- {len(tickers)} hisse\n{'='*55}")

    results = []
    # Rate limit icin 5'li batch
    for i in range(0, len(tickers), 5):
        batch = tickers[i:i+5]
        async with httpx.AsyncClient() as client:
            tasks = [fetch_yahoo(t, client) for t in batch]
            raws = await asyncio.gather(*tasks)

        for raw in raws:
            if not raw: continue
            raw = await fetch_technical_yahoo(raw.ticker, httpx.AsyncClient(), raw)
            raw = validate_and_score(raw)
            print(f"  [{raw.ticker}] {raw.exchange} GARP:{raw.garp_skoru} TEKNIK:{raw.teknik_skoru} FINAL:{raw.final_skoru} -> {raw.sinyal}")
            results.append(asdict(raw))

        await asyncio.sleep(0.5)

    if save_to_supabase and SUPABASE_URL and SUPABASE_KEY:
        await upsert_supabase(results)

    al = [r for r in results if r["sinyal"]=="AL"]
    print(f"\nOZET: {len(results)} hisse | AL:{len(al)}")
    for r in sorted(al, key=lambda x: x["final_skoru"], reverse=True):
        print(f"  {r['ticker']} ({r['exchange']}) Final:{r['final_skoru']}")
    return results

async def upsert_supabase(results):
    print("[Supabase] Yaziliyor...")
    url = f"{SUPABASE_URL}/rest/v1/global_garp_scan?on_conflict=ticker,scan_date"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"
    }
    async with httpx.AsyncClient(timeout=15.0) as client:
        r = await client.post(url, headers=headers, json=results)
        if r.status_code in (200, 201): print(f"  OK {len(results)} kayit")
        else: print(f"  HATA {r.status_code}: {r.text[:200]}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--universe", action="store_true")
    parser.add_argument("--portfolio", action="store_true")
    parser.add_argument("--tickers", type=str)
    parser.add_argument("--supabase", action="store_true")
    args = parser.parse_args()

    async def main():
        target = set()
        if args.universe: target.update(SP500_UNIVERSE)
        if args.portfolio: target.update(await get_portfolio_tickers())
        if args.tickers: target.update([t.strip().upper() for t in args.tickers.split(",")])
        if not target: target = {"AAPL","MSFT","GOOGL","AMZN","META"}
        return await run_pipeline(list(target), save_to_supabase=args.supabase)

    asyncio.run(main())
