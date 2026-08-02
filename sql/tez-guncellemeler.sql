-- Tez güncellemeleri (pozisyon geçmişi / zaman çizelgesi)
-- Supabase → SQL Editor'de bir kez çalıştır.

create table if not exists tez_guncellemeler (
  id          bigserial primary key,
  tez_id      bigint not null references tezler(id) on delete cascade,
  tarih       timestamptz not null default now(),   -- gelişmenin tarihi (bilanço tarihi vb.)
  tur         text not null default 'not',          -- bilanco | haber | revizyon | fiyat | kapanis | not
  baslik      text not null,
  icerik      text,                                 -- HTML destekler (tez içeriğiyle aynı mantık)
  sinyal      text,                                 -- opsiyonel: bu gelişmeyle sinyal değiştiyse (AL/IZLE/NOTR/KACIN)
  fiyat       numeric,                              -- opsiyonel: o tarihteki fiyat
  yayinda     boolean not null default true,
  olusturma   timestamptz not null default now()
);

create index if not exists tez_guncellemeler_tez_id_idx
  on tez_guncellemeler (tez_id, tarih desc);

create index if not exists tez_guncellemeler_yayinda_idx
  on tez_guncellemeler (yayinda, tarih desc);

-- Servis anahtarı RLS'i bypass eder; yine de tabloyu kapalı tutuyoruz.
alter table tez_guncellemeler enable row level security;
