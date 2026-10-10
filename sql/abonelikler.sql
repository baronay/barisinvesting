-- Abonelikler — yazı sonu kutusundan gelen kayıtlar.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Neden ayrı tablo: bir kişi birden fazla teze abone olabilsin ve her kaydın
-- hangi yazıdan, hangi kampanyadan geldiği görünsün. users tablosu kimlik ve
-- kredi tutuyor; "hangi teze abone" bilgisi oraya sığmıyor.
-- users tablosu OLDUĞU GİBİ kalıyor: abone olan kişiye terminal kredisi
-- verilmeye devam ediyor, bu tablo onun yerine değil yanına geliyor.

create table if not exists abonelikler (
  id            bigserial primary key,
  email         text not null,
  tez_id        bigint references tezler(id) on delete set null,  -- null = genel bülten
  kaynak_sayfa  text,          -- '/tez/33' gibi; hangi sayfadan abone oldu
  utm_source    text,
  utm_medium    text,
  utm_campaign  text,
  olusturma     timestamptz not null default now()
);

-- Aynı kişi aynı teze iki kez abone olmasın. Genel abonelik için ayrı indeks
-- gerekiyor: SQL'de null = null karşılaştırması false döndüğü için tek indeks
-- genel kayıtların tekrarını engellemiyor.
create unique index if not exists abonelikler_email_tez_idx
  on abonelikler (email, tez_id) where tez_id is not null;
create unique index if not exists abonelikler_email_genel_idx
  on abonelikler (email) where tez_id is null;

create index if not exists abonelikler_tez_idx on abonelikler (tez_id, olusturma desc);

-- Servis anahtarı RLS'i bypass eder; yine de tabloyu kapalı tutuyoruz.
alter table abonelikler enable row level security;

-- ── MEVCUT ABONELERİ TAŞI ────────────────────────────────────────────
-- users tablosundaki marketing_consent=true kayıtları genel abonelik olarak
-- kopyalar. users'tan hiçbir şey silinmez; hesaplar ve krediler yerinde kalır.
insert into abonelikler (email, tez_id, kaynak_sayfa, olusturma)
select u.email, null, 'eski-kayit', coalesce(u.joined_at, now())
from users u
where u.marketing_consent = true
on conflict do nothing;

-- ── Kontrol ──────────────────────────────────────────────────────────
--   select count(*) from abonelikler;                       -- taşınan sayısı
--   select tez_id, count(*) from abonelikler group by tez_id order by 2 desc;
