-- İçerik olayları — mail kapısını kaldırmanın etkisini ölçmek için.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Umami zaten çalışıyor ama verisi admin panelinden sorgulanamıyor; bu tablo
-- "yazı bazında dört sayı" görünümünü beslemek için var. İkisi paralel duruyor.

create table if not exists olaylar (
  id           bigserial primary key,
  tur          text not null,   -- goruntuleme | kaydirma75 | kutu_gorundu | abone_oldu
  tez_id       bigint references tezler(id) on delete cascade,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  olusturma    timestamptz not null default now()
);

create index if not exists olaylar_tez_tur_idx on olaylar (tez_id, tur);
create index if not exists olaylar_tarih_idx   on olaylar (olusturma desc);

alter table olaylar enable row level security;

-- ── Kontrol ──────────────────────────────────────────────────────────
--   select tez_id, tur, count(*) from olaylar group by 1,2 order by 1,2;
