-- Abonelik kutusu üç yerleşime çıktı: inline / end / slidein.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Neden: yazının %75'ine gelen okurun yaklaşık yarısı sondaki kutuyu hiç
-- görmüyordu. Teklif artık yazının içinde, kapanışın altında ve %75'te
-- açılan alt barda duruyor; hangi yerleşimin işe yaradığını ölçebilmek
-- için hem abonelik hem olay kaydına yerleşim yazılıyor.

alter table abonelikler add column if not exists ticker   text;
alter table abonelikler add column if not exists yerlesim text;
alter table olaylar     add column if not exists yerlesim text;

-- "Şu hisseye abone olanlara toplu mail at" sorgusu tez_id üzerinden
-- dolaşmak zorunda kalmasın.
create index if not exists abonelikler_ticker_idx
  on abonelikler (ticker, olusturma desc) where ticker is not null;

-- ── ESKİ KAYITLAR ────────────────────────────────────────────────────
-- Bu tarihe kadar tek yerleşim sondaki kutuydu. Satırları GÜNCELLEMİYORUZ
-- (boş kalması "ölçüm öncesi" demek); admin paneli boş yerleşimi zaten
-- 'end' sayıyor. Geriye dönük doldurmak istersen:
--   update abonelikler set yerlesim = 'end' where yerlesim is null;
--   update olaylar     set yerlesim = 'end' where yerlesim is null;

-- ── Kontrol ──────────────────────────────────────────────────────────
--   select yerlesim, count(*) from abonelikler group by 1 order by 2 desc;
--   select tur, yerlesim, count(*) from olaylar group by 1,2 order by 1,2;
--   -- bir hissenin aboneleri:
--   select email from abonelikler where ticker = 'RGYAS' order by olusturma desc;
