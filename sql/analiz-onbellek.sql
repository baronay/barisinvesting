-- Günlük analiz önbelleği.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Neden: aynı hisseyi aynı gün tekrar analiz etmek modeli yeniden
-- çalıştırıyor — ~40 saniye ve ~6 cent. Analiz metni gün boyu saklanıyor.
--
-- YALNIZCA METİN saklanıyor: fiyat ve çarpanlar her istekte canlı
-- çekiliyor, yani önbellekten gelen analizde de ekrandaki fiyat güncel.
--
-- GEÇERSİZLİK: imza = çeyrek dönem sonu | mali yıl sonu | tez_veri
-- güncelleme tarihi. Mali tablo dönemi değişirse ya da tezin manuel
-- verisi güncellenirse imza değişir ve önbellek kendiliğinden düşer.

create table if not exists analiz_onbellek (
  id        bigserial primary key,
  ticker    text not null,
  exchange  text not null,
  gun       date not null,
  imza      text not null,
  sonuc     jsonb not null,
  olusturma timestamptz not null default now()
);

create unique index if not exists analiz_onbellek_idx
  on analiz_onbellek (ticker, exchange, gun);

alter table analiz_onbellek enable row level security;

-- ── Bakım ────────────────────────────────────────────────────────────
-- Eski kayıtlar birikmesin (istersen ara sıra çalıştır):
--   delete from analiz_onbellek where gun < current_date - 7;
--
-- ── Kontrol ──────────────────────────────────────────────────────────
--   select ticker, exchange, gun, imza, length(sonuc::text) as boyut
--   from analiz_onbellek order by olusturma desc limit 20;
