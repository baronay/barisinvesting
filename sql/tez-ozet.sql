-- "3 dakikada tez" alanları.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Bu alanlar ELLE DOLDURULMAK ZORUNDA DEĞİL: admin panelindeki
-- "3 dakikalık özeti üret" düğmesi tezin kendi metnini okuyup dolduruyor
-- (api/tez-ozet.js). Yani yeni bir yazım yükü getirmiyor; sadece zaten
-- yazdığın şeyin kısa hâli çıkarılıp saklanıyor. İstersen düzenlersin.

alter table tezler add column if not exists ozet_boga    text;  -- boğa tarafı
alter table tezler add column if not exists ozet_ayi     text;  -- ayı tarafı
alter table tezler add column if not exists ozet_fark    text;  -- "benim farkım"
alter table tezler add column if not exists ozet_fiyat   text;  -- izleme/giriş bandı
alter table tezler add column if not exists ozet_kirilma text;  -- tez nerede kırılır
alter table tezler add column if not exists ozet_tarih   timestamptz;  -- ne zaman üretildi

-- Tez kapandıysa künyede "KAPANDI" yazsın (varsayılan: aktif).
alter table tezler add column if not exists durum text not null default 'aktif';  -- aktif | kapandi

-- ── Kontrol ───────────────────────────────────────────────────────
--   select ticker, baslik, (ozet_boga is not null) ozet_var, durum
--   from tezler where yayinda order by olusturma desc;
