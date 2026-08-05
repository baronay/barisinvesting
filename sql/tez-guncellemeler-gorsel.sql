-- Güncellemelere kendi görseli (ana sayfadaki "GÜNCELLEME YAYINDA" kartı bunu kullanır)
-- Supabase → SQL Editor'de bir kez çalıştır.
-- Not: tez-guncellemeler.sql'i daha önce çalıştırmış olman gerekiyor.

alter table tez_guncellemeler
  add column if not exists gorsel text;
