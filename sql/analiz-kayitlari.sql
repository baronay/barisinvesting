-- Analiz kayıtları: hangi hisseye, ne zaman, kim baktı.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Neden gerekli: kota kapısı yalnızca "kaç analiz yapıldı" sayısını
-- tutuyordu (users.total_used). Hangi hissenin analiz edildiği hiçbir
-- yerde yazılmıyordu; bu tablo o boşluğu dolduruyor.

create table if not exists analiz_kayitlari (
  id          bigserial primary key,
  ticker      text not null,                      -- THYAO, NVDA…
  exchange    text,                               -- BIST | NYSE | NASDAQ
  email       text,                               -- kayıtlı kullanıcıysa
  oturum      text,                               -- anonim oturum kimliği (localStorage)
  sirket      text,                               -- şirket adı (veri geldiyse)
  verdict     text,                               -- AL | BEKLE | UZAK_DUR
  skor        smallint,                           -- 0-7
  garp        smallint,                           -- 0-100
  model       text,                               -- claude-sonnet-5 / haiku yedeği
  giris_token integer,
  cikis_token integer,
  maliyet     numeric(10,5),                      -- USD
  sure_ms     integer,                            -- uçtan uca süre
  durum       text not null default 'ok',         -- ok | hata | sure_doldu
  hata        text,
  olusturma   timestamptz not null default now()
);

-- "Bugün ne analiz edildi", "son 30 gün en çok bakılan" sorguları için
create index if not exists analiz_kayitlari_tarih_idx
  on analiz_kayitlari (olusturma desc);
create index if not exists analiz_kayitlari_ticker_idx
  on analiz_kayitlari (ticker, olusturma desc);

-- Servis anahtarı RLS'i bypass eder; tablo dışarıya kapalı kalsın.
alter table analiz_kayitlari enable row level security;

-- ── Örnek sorgular ────────────────────────────────────────────────
-- En çok analiz edilen 20 hisse (son 30 gün):
--   select ticker, exchange, count(*) adet, max(olusturma) son
--   from analiz_kayitlari
--   where olusturma > now() - interval '30 days'
--   group by ticker, exchange order by adet desc limit 20;
--
-- Günlük analiz sayısı:
--   select date_trunc('day', olusturma) gun, count(*) adet
--   from analiz_kayitlari group by gun order by gun desc limit 30;
--
-- Tekil ziyaretçi (oturum) başına analiz:
--   select oturum, count(*) adet, min(olusturma) ilk, max(olusturma) son
--   from analiz_kayitlari group by oturum order by adet desc limit 50;
