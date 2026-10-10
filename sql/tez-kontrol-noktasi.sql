-- Tezin bir sonraki kontrol noktası.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Yazı sonundaki abonelik kutusunda kullanılıyor:
--   "{Tez adı} tezini {kontrol noktası} sonrasında güncelleyeceğim."
-- Boş bırakılırsa kutu genel metne düşüyor, yani doldurmak zorunlu değil.
-- Serbest metin: 'Q3 bilançosu, 28 Ekim 2026' gibi.

alter table tezler add column if not exists kontrol_noktasi text;

-- ── Kontrol ──────────────────────────────────────────────────────────
--   select ticker, baslik, kontrol_noktasi from tezler where yayinda order by olusturma desc;
