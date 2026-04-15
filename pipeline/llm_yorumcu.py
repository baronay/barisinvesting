"""
llm_yorumcu.py — Baris Investing LLM Yorum Motoru
Supabase'den gunluk scan sonuclarini cekip Claude'a besler,
uretilen yorumlari geri yazar.
"""

import httpx
import asyncio
import os
import json
from datetime import datetime, timezone, date
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL     = os.getenv("SUPABASE_URL")
SUPABASE_KEY     = os.getenv("SUPABASE_SERVICE_KEY")
ANTHROPIC_KEY    = os.getenv("ANTHROPIC_API_KEY")
ANTHROPIC_URL    = "https://api.anthropic.com/v1/messages"

SYSTEM_PROMPT = """Sen Baris Investing platformunun yapay zeka analistisisin.
GARP (Growth at a Reasonable Price) yatirim felsefesiyle calisiyorsun.
Gorev: Sana verilen finansal verileri analiz edip net, aksiyona donuk bir yatirim tezi uretmek.

Kurallarin:
- Akademik veya uzun yazma. Maksimum 3-4 cumle.
- Rakamları yorumla, tekrar etme. "F/K 11.49" deme, "makul degerlenmiş" de.
- Teknik teyit varsa bunu vurgula, yoksa temel analize odaklan.
- Sinyal AL ise neden al, IZLE ise ne beklenmeli, KACIN ise neden kacin.
- Turkce yaz, sade ve net ol.
- Hicbir zaman "kesin al" veya "kesin sat" deme, "guclu GARP adayi" gibi ifadeler kullan."""

def build_prompt(hisse: dict) -> str:
    return f"""Hisse: {hisse['ticker']}
Sinyal: {hisse['sinyal']} (Final Skor: {hisse['final_skoru']}/100)

Temel:
- F/K: {hisse.get('fk', 'N/A')}
- PD/DD: {hisse.get('pddd', 'N/A')} ({hisse.get('pddd_guvenis', 'N/A')} guven)
- FD/FAVOK: {hisse.get('fd_favok', 'N/A')}
- ROE: %{hisse.get('roe', 'N/A')}
- Buyume YoY: %{hisse.get('buyume_yoy', 'N/A')}
- Borc/Ozsermaye: {hisse.get('de', 'N/A')}

Teknik ({hisse.get('teknik_teyit', 'N/A')} - {hisse.get('teknik_skoru', 'N/A')}/100):
{chr(10).join(['- ' + n for n in (hisse.get('teknik_notlar') or ['Veri yok'])])}

Bu hisse icin kisa ve net bir yatirim tezi yaz."""

async def get_ai_yorum(hisse: dict, client: httpx.AsyncClient) -> str:
    payload = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 300,
        "system": SYSTEM_PROMPT,
        "messages": [
            {"role": "user", "content": build_prompt(hisse)}
        ]
    }
    headers = {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    }
    try:
        r = await client.post(ANTHROPIC_URL, json=payload, headers=headers, timeout=30.0)
        r.raise_for_status()
        data = r.json()
        return data["content"][0]["text"].strip()
    except Exception as e:
        print(f"  [LLM] {hisse['ticker']} hata: {e}")
        return None

async def fetch_todays_scan() -> list:
    url = f"{SUPABASE_URL}/rest/v1/bist_garp_scan?scan_date=eq.{date.today()}&select=*"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(url, headers=headers)
        r.raise_for_status()
        data = r.json()
    print(f"  {len(data)} hisse bulundu")
    return data

async def update_ai_yorum(hisse_id: int, yorum: str, client: httpx.AsyncClient):
    url = f"{SUPABASE_URL}/rest/v1/bist_garp_scan?id=eq.{hisse_id}"
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal"
    }
    payload = {
        "ai_yorum": yorum,
        "ai_ts": datetime.now(timezone.utc).isoformat()
    }
    r = await client.patch(url, json=payload, headers=headers)
    if r.status_code not in (200, 204):
        print(f"  [Supabase] Guncelleme hatasi {hisse_id}: {r.status_code}")

async def run():
    print(f"\n{'='*55}")
    print(f"[{datetime.now().strftime('%H:%M:%S')}] LLM Yorumcu basliyor")
    print(f"{'='*55}")

    hisseler = await fetch_todays_scan()
    if not hisseler:
        print("  Bugun icin scan verisi yok, once pipeline'i calistir.")
        return

    # Sadece AL ve IZLE sinyallerini yorumla (NOTR ve KACIN icin API harcama)
    hedefler = [h for h in hisseler if h.get("sinyal") in ("AL", "IZLE", "NOTR", "KACIN")]
    print(f"  {len(hedefler)} hisse yorumlanacak\n")

    async with httpx.AsyncClient() as client:
        for h in hedefler:
            print(f"  [{h['ticker']}] {h['sinyal']} ({h['final_skoru']}) yorumlanıyor...")
            yorum = await get_ai_yorum(h, client)
            if yorum:
                await update_ai_yorum(h["id"], yorum, client)
                print(f"    -> {yorum[:80]}...")
            await asyncio.sleep(0.5)  # rate limit icin kisa bekleme

    print(f"\n[Tamamlandi] {len(hedefler)} hisse yorumlandi")

if __name__ == "__main__":
    asyncio.run(run())
