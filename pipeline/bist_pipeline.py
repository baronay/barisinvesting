"""
bist_pipeline.py — Baris Investing Otonom Ajan MVP v2
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
TV_SCANNER_URL = "https://scanner.tradingview.com/turkey/scan"

TV_TECHNICAL_COLUMNS = ["RSI","obv","SMA50","SMA200","volume","average_volume_10d_calc"]

BIST_UNIVERSE = [
    "THYAO","ASELS","EREGL","KCHOL","SASA","TOASO","BIMAS",
    "AKBNK","GARAN","YKBNK","TUPRS","SAHOL","FROTO","PGSUS",
    "VESTL","TTKOM","TCELL","DOHOL","KOZAL","ENKAI",
]

GATES = {
    "fk":(0.5,80.0),"pddd":(0.05,25.0),"fd_favok":(-50.0,60.0),
    "roe":(-100.0,200.0),"de":(0.0,50.0),"buyume":(-80.0,500.0),"rsi":(0.0,100.0),
}

@dataclass
class RawRatios:
    ticker:str
    fiyat:Optional[float]=None
    fk:Optional[float]=None
    pddd:Optional[float]=None
    piyasa_degeri:Optional[float]=None
    fd_favok:Optional[float]=None
    roe:Optional[float]=None
    de:Optional[float]=None
    eps:Optional[float]=None
    buyume_yoy:Optional[float]=None
    ozsermaye:Optional[float]=None
    rsi:Optional[float]=None
    obv:Optional[float]=None
    sma50:Optional[float]=None
    sma200:Optional[float]=None
    volume:Optional[float]=None
    avg_volume:Optional[float]=None
    ts:str=field(default_factory=lambda:datetime.now(timezone.utc).isoformat())

@dataclass
class ValidatedRatios:
    ticker:str
    fk:Optional[float]=None
    pddd:Optional[float]=None
    fd_favok:Optional[float]=None
    roe:Optional[float]=None
    de:Optional[float]=None
    buyume_yoy:Optional[float]=None
    fiyat:Optional[float]=None
    pddd_computed:Optional[float]=None
    pddd_delta_pct:Optional[float]=None
    pddd_guvenis:str="LOW"
    fk_computed:Optional[float]=None
    rsi:Optional[float]=None
    obv:Optional[float]=None
    sma50:Optional[float]=None
    sma200:Optional[float]=None
    volume:Optional[float]=None
    avg_volume:Optional[float]=None
    teknik_teyit:str="BELIRSIZ"
    teknik_notlar:list=field(default_factory=list)
    flags:list=field(default_factory=list)
    garp_skoru:Optional[float]=None
    teknik_skoru:Optional[float]=None
    final_skoru:Optional[float]=None
    sinyal:str="NOTR"
    ts:str=field(default_factory=lambda:datetime.now(timezone.utc).isoformat())

def _safe(val,decimals=2):
    if val is None or val=="":return None
    try:
        n=float(val)
        return None if(math.isnan(n) or math.isinf(n)) else round(n,decimals)
    except:return None

async def fetch_technical(tickers,client):
    syms=[f"BIST:{t.upper().replace('.IS','').replace('BIST:','')}" for t in tickers]
    payload={"symbols":{"tickers":syms,"query":{"types":[]}},"columns":TV_TECHNICAL_COLUMNS}
    headers={"Content-Type":"application/json","Accept":"application/json",
             "Origin":"https://www.tradingview.com","Referer":"https://www.tradingview.com/",
             "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        r=await client.post(TV_SCANNER_URL,json=payload,headers=headers,timeout=15.0)
        if r.status_code!=200:
            print(f"  [TV Teknik] HTTP {r.status_code} — atlanacak");return {}
        data=r.json()
    except Exception as e:
        print(f"  [TV Teknik] Hata: {e}");return {}
    idx={col:i for i,col in enumerate(TV_TECHNICAL_COLUMNS)}
    results={}
    for row in data.get("data",[]):
        sym=row.get("s","").replace("BIST:","").upper()
        d=row.get("d",[])
        def c(name):
            i=idx.get(name)
            return d[i] if(i is not None and i<len(d)) else None
        results[sym]={"rsi":_safe(c("RSI")),"obv":_safe(c("obv"),0),
                      "sma50":_safe(c("SMA50")),"sma200":_safe(c("SMA200")),
                      "volume":_safe(c("volume"),0),"avg_volume":_safe(c("average_volume_10d_calc"),0)}
    return results

async def fetch_fundamentals(tickers,client):
    ticker_str=",".join([t.upper().replace(".IS","").replace("BIST:","") for t in tickers])
    url=f"{BIST_API_URL}?ticker={ticker_str}"
    print(f"  [Temel] GET {url}")
    r=await client.get(url,timeout=20.0)
    r.raise_for_status()
    data=r.json()
    if len(tickers)==1:
        t=tickers[0].upper().replace(".IS","").replace("BIST:","")
        data={t:data}
    results={}
    for sym,d in data.items():
        if not isinstance(d,dict) or d.get("hata"):continue
        results[sym]=d
    return results

async def fetch_all(tickers):
    async with httpx.AsyncClient(follow_redirects=True) as client:
        fund_data,tech_data=await asyncio.gather(
            fetch_fundamentals(tickers,client),
            fetch_technical(tickers,client)
        )
    print(f"  [Temel] {len(fund_data)} | [Teknik] {len(tech_data)}")
    results={}
    for sym,d in fund_data.items():
        tech=tech_data.get(sym,{})
        results[sym]=RawRatios(
            ticker=sym,fiyat=_safe(d.get("GuncelFiyat")),fk=_safe(d.get("FK")),
            pddd=_safe(d.get("PDDD")),piyasa_degeri=_safe(d.get("PiyasaDegeri"),0),
            fd_favok=_safe(d.get("FD_FAVOK")),roe=_safe(d.get("ROE")),
            de=_safe(d.get("DebtEquity")),
            eps=_safe((d.get("_raw") or {}).get("earnings_per_share_basic_ttm")),
            buyume_yoy=_safe((d.get("_raw") or {}).get("revenue_growth_rate_1y")),
            rsi=tech.get("rsi"),obv=tech.get("obv"),sma50=tech.get("sma50"),
            sma200=tech.get("sma200"),volume=tech.get("volume"),avg_volume=tech.get("avg_volume"),
        )
    return results

def validate(raw):
    flags=[]
    v=ValidatedRatios(ticker=raw.ticker,fiyat=raw.fiyat)
    def gate(value,name):
        if value is None:return None
        lo,hi=GATES[name]
        if not(lo<=value<=hi):flags.append(f"{name.upper()}_OUT_OF_RANGE({value})");return None
        return value
    v.fk=gate(raw.fk,"fk")
    if raw.fiyat and raw.eps and raw.eps>0:
        v.fk_computed=round(raw.fiyat/raw.eps,2)
        if v.fk and abs(v.fk-v.fk_computed)/max(abs(v.fk),0.01)>0.30:
            flags.append(f"FK_MISMATCH(api={v.fk} hesap={v.fk_computed})");v.fk=v.fk_computed
    v.pddd=gate(raw.pddd,"pddd")
    if raw.piyasa_degeri and raw.ozsermaye and raw.ozsermaye!=0:
        computed=round(raw.piyasa_degeri*USDT_TRY/raw.ozsermaye,2)
        v.pddd_computed=computed
        if v.pddd is not None:
            delta=abs(v.pddd-computed)/max(abs(computed),0.01)
            v.pddd_delta_pct=round(delta*100,1)
            if delta<0.15:v.pddd_guvenis="HIGH"
            elif delta<0.40:v.pddd_guvenis="MEDIUM";flags.append(f"PDDD_SOFT_MISMATCH(api={v.pddd} hesap={computed})")
            else:v.pddd_guvenis="LOW";flags.append(f"PDDD_HARD_MISMATCH(api={v.pddd} hesap={computed})");v.pddd=computed
        else:v.pddd=computed;v.pddd_guvenis="COMPUTED"
    v.fd_favok=gate(raw.fd_favok,"fd_favok")
    v.roe=gate(raw.roe,"roe")
    v.de=gate(raw.de,"de")
    v.buyume_yoy=gate(raw.buyume_yoy,"buyume")
    v.rsi=gate(raw.rsi,"rsi")
    v.obv=raw.obv;v.sma50=raw.sma50;v.sma200=raw.sma200
    v.volume=raw.volume;v.avg_volume=raw.avg_volume
    v.flags=flags
    return v

def garp_score(v):
    score=0.0;max_score=0.0
    def add(val,w,fn):
        nonlocal score,max_score
        max_score+=w
        if val is not None:score+=w*fn(val)
    def fk_s(x):
        if x<=0:return 0.0
        if x<=8:return 0.7
        if x<=15:return 1.0
        if x<=25:return 0.7
        if x<=40:return 0.3
        return 0.0
    def pddd_s(x):
        if x<=0:return 0.0
        if x<=1.0:return 1.0
        if x<=2.0:return 0.85
        if x<=3.5:return 0.6
        if x<=6.0:return 0.3
        return 0.0
    def fdf_s(x):
        if x<0:return 0.1
        if x<=6:return 0.9
        if x<=10:return 1.0
        if x<=15:return 0.75
        if x<=20:return 0.4
        return 0.0
    def roe_s(x):
        if x<=0:return 0.0
        if x<=10:return 0.3
        if x<=20:return 0.7
        if x<=35:return 1.0
        return 0.85
    def buy_s(x):
        if x<0:return 0.0
        if x<=5:return 0.2
        if x<=15:return 0.6
        if x<=30:return 1.0
        if x<=60:return 0.85
        return 0.6
    add(v.fk,20,fk_s);add(v.pddd,20,pddd_s);add(v.fd_favok,20,fdf_s)
    add(v.roe,20,roe_s);add(v.buyume_yoy,20,buy_s)
    if max_score==0:return 0.0
    n=(score/max_score)*100
    if v.de and v.de>3.0:n*=0.85
    return round(n,1)

def teknik_score(v):
    notlar=[];puan=50.0;veri=0
    if v.rsi is not None:
        veri+=1
        if 30<=v.rsi<=50:puan+=20;notlar.append(f"RSI {v.rsi:.1f} — asiri satimdan donus bolgesi")
        elif v.rsi<30:puan+=12;notlar.append(f"RSI {v.rsi:.1f} — asiri satim")
        elif 50<v.rsi<=65:puan+=5;notlar.append(f"RSI {v.rsi:.1f} — notr")
        elif v.rsi>70:puan-=15;notlar.append(f"RSI {v.rsi:.1f} — asiri alim")
    if v.fiyat and v.sma50 and v.sma200:
        veri+=1
        if v.sma50>v.sma200:puan+=15;notlar.append("50MA > 200MA — yukari trend")
        else:puan-=10;notlar.append("50MA < 200MA — asagi trend")
        if v.fiyat>v.sma50:puan+=10;notlar.append(f"Fiyat > 50MA — pozitif")
        else:puan-=5;notlar.append(f"Fiyat < 50MA — negatif")
    elif v.fiyat and v.sma50:
        veri+=1
        if v.fiyat>v.sma50:puan+=8;notlar.append("Fiyat > 50MA")
        else:puan-=5;notlar.append("Fiyat < 50MA")
    if v.volume and v.avg_volume and v.avg_volume>0:
        veri+=1;oran=v.volume/v.avg_volume
        if oran>=1.5:puan+=10;notlar.append(f"Hacim {oran:.1f}x ortalamanin ustunde")
        elif oran>=1.0:puan+=3;notlar.append(f"Hacim normal ({oran:.1f}x)")
        else:puan-=5;notlar.append(f"Hacim dusuk ({oran:.1f}x)")
    if veri==0:return 50.0,"BELIRSIZ",["Teknik veri alinamadi"]
    puan=max(0.0,min(100.0,puan))
    teyit="GUCLU" if puan>=65 else "ZAYIF" if puan<=35 else "BELIRSIZ"
    return round(puan,1),teyit,notlar

def final_score(garp,teknik,teyit):
    if teyit=="GUCLU":final=garp*0.75+teknik*0.25+5.0
    elif teyit=="ZAYIF":final=garp*0.75+teknik*0.25-10.0
    else:final=garp*0.80+teknik*0.20
    final=max(0.0,min(100.0,final))
    sinyal="AL" if final>=70 else "IZLE" if final>=50 else "NOTR" if final>=30 else "KACIN"
    return round(final,1),sinyal

async def run_pipeline(tickers,save_to_supabase=False):
    print(f"\n{'='*55}\n[{datetime.now().strftime('%H:%M:%S')}] Pipeline v2 -- {len(tickers)} hisse\n{'='*55}")
    raw_data=await fetch_all(tickers)
    results=[]
    for ticker in tickers:
        raw=raw_data.get(ticker)
        if not raw:print(f"  SKIP {ticker}");continue
        v=validate(raw)
        v.garp_skoru=garp_score(v)
        v.teknik_skoru,v.teknik_teyit,v.teknik_notlar=teknik_score(v)
        v.final_skoru,v.sinyal=final_score(v.garp_skoru,v.teknik_skoru,v.teknik_teyit)
        print(f"  [{ticker}] GARP:{v.garp_skoru} TEKNIK:{v.teknik_skoru} FINAL:{v.final_skoru} -> {v.sinyal}")
        for n in v.teknik_notlar:print(f"    - {n}")
        results.append(asdict(v))
    if save_to_supabase and SUPABASE_URL and SUPABASE_KEY:
        await upsert_supabase(results)
    al=[r for r in results if r["sinyal"]=="AL"]
    print(f"\nOZET: {len(results)} hisse | AL:{len(al)}")
    for r in sorted(al,key=lambda x:x["final_skoru"],reverse=True):
        print(f"  {r['ticker']} Final:{r['final_skoru']}")
    return results

async def upsert_supabase(results):
    print("[Supabase] Yaziliyor...")
    url=f"{SUPABASE_URL}/rest/v1/bist_garp_scan"
    headers={"apikey":SUPABASE_KEY,"Authorization":f"Bearer {SUPABASE_KEY}",
             "Content-Type":"application/json","Prefer":"resolution=merge-duplicates"}
    async with httpx.AsyncClient(timeout=10.0,follow_redirects=True) as client:
        r=await client.post(url,headers=headers,json=results)
        if r.status_code in(200,201):print(f"  OK {len(results)} kayit")
        else:print(f"  HATA {r.status_code}: {r.text[:300]}")

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--tickers",type=str)
    parser.add_argument("--universe",action="store_true")
    parser.add_argument("--supabase",action="store_true")
    parser.add_argument("--json",action="store_true")
    args=parser.parse_args()
    if args.universe:target=BIST_UNIVERSE
    elif args.tickers:target=[t.strip().upper() for t in args.tickers.split(",")]
    else:target=["THYAO","ASELS","EREGL","KCHOL","TOASO"]
    results=asyncio.run(run_pipeline(target,save_to_supabase=args.supabase))
    if args.json:
        fname=f"garp_scan_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
        with open(fname,"w",encoding="utf-8") as f:json.dump(results,f,ensure_ascii=False,indent=2)
        print(f"JSON: {fname}")
