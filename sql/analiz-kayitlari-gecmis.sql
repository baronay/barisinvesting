-- Geçmiş analizlerin kurtarılması.
-- Supabase → SQL Editor'de bir kez çalıştır (analiz-kayitlari.sql'den sonra).
--
-- Sunucuda geçmiş veri yok: istekler POST gövdesiyle geldiği için erişim
-- loglarında ticker durmuyor. AMA ziyaretçilerin KENDİ tarayıcılarında
-- duruyor: terminal her analizi localStorage'a yazıyor (bi_history →
-- ticker, borsa, skor, karar, tarih). Kullanıcı siteye tekrar girdiğinde
-- istemci bu listeyi bir kez sunucuya gönderiyor; böylece geçmiş,
-- geri dönen her ziyaretçiyle birlikte doluyor.

-- Satır canlı mı, geçmişten mi kurtarıldı — ikisi karışmasın
alter table analiz_kayitlari
  add column if not exists kaynak text not null default 'canli';   -- canli | gecmis

-- Aynı geçmiş kaydı iki kez düşmesin (aynı ziyaretçi + hisse + tarih).
-- oturum NULL olan canlı satırlar bu indekste çakışmaz (Postgres'te
-- NULL'lar birbirine eşit sayılmaz), yani canlı akış etkilenmiyor.
create unique index if not exists analiz_kayitlari_tekil_idx
  on analiz_kayitlari (oturum, ticker, olusturma);

-- ── Kontrol sorguları ─────────────────────────────────────────────
-- Kurtarılan geçmiş kayıt sayısı:
--   select kaynak, count(*) from analiz_kayitlari group by kaynak;
--
-- Geçmiş dahil en çok analiz edilen hisseler:
--   select ticker, exchange, count(*) adet,
--          count(distinct coalesce(email, oturum)) kisi,
--          min(olusturma) ilk, max(olusturma) son
--   from analiz_kayitlari
--   group by ticker, exchange order by adet desc limit 30;
