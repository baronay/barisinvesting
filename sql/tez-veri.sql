-- Manuel tez verisi — TradingView'da olmayan, elle derlenen bilgi.
-- Supabase → SQL Editor'de çalıştır.
--
-- Neden ayrı tablo: TradingView bir GYO'nun EPRA net aktif değerini, kira
-- endeksini, değerleme raporunu ya da tezin senaryolarını bilmiyor. Bunlar
-- çeyrekte bir değişiyor, canlı çekilecek veri değil.
--
-- SÜRÜMLEME: tekil indeks (ticker, guncelleme_tarihi) üzerinde. Veri
-- güncellenince ESKİ KAYIT SİLİNMİYOR, yeni tarihle yeni satır ekleniyor;
-- bot her zaman o ticker'ın en güncel satırını okuyor. Böylece "tez o gün
-- neye dayanıyordu" sorusu geriye dönük cevaplanabiliyor.

create table if not exists tez_veri (
  id                bigserial primary key,
  tez_id            bigint references tezler(id) on delete set null,
  ticker            text not null,
  guncelleme_tarihi date not null,
  rapor_tarihi      date,
  kaynak            text not null default 'Barış Investing tezi',

  -- ── SAYISAL: bot bunlarla hesap yapıyor ──
  epra_nad_eur             numeric,
  gav_eur                  numeric,
  hisse_sayisi             numeric,
  rapor_kuru_eur_try       numeric,
  giris_bandi_al_ust       numeric,
  giris_bandi_olculu_ust   numeric,
  tez_fiyati               numeric,
  beklenen_deger           numeric,
  tez_kapanis_nad_orani    numeric,
  net_borc_favok           numeric,
  ltv_yuzde                numeric,
  doluluk_yuzde            numeric,
  ocr_yuzde                numeric,
  net_doviz_yukumluluk_eur numeric,
  -- GYO statüsünde DEĞİLSE bilançoda ertelenmiş vergi yükümlülüğü var,
  -- defter değeri net aktif değeri olduğundan düşük gösterir.
  gyo_statusu              boolean,

  -- ── BÖLÜMLER ──
  kira_yapisi       jsonb,
  degerleme         jsonb,
  tez               jsonb,
  kirilma_esikleri  jsonb,
  kontrol_noktalari jsonb,
  hissedar_yapisi   jsonb,

  olusturma timestamptz not null default now()
);

create unique index if not exists tez_veri_ticker_tarih_idx
  on tez_veri (ticker, guncelleme_tarihi);

-- Bot sorgusu: ticker=eq.X&order=guncelleme_tarihi.desc&limit=1
create index if not exists tez_veri_guncel_idx
  on tez_veri (ticker, guncelleme_tarihi desc);

alter table tez_veri enable row level security;


-- ══════════════════════════════════════════════════════════════════
-- RGYAS — 10.10.2026
-- ══════════════════════════════════════════════════════════════════
insert into tez_veri (
  tez_id, ticker, guncelleme_tarihi, rapor_tarihi,
  epra_nad_eur, gav_eur, hisse_sayisi, rapor_kuru_eur_try,
  giris_bandi_al_ust, giris_bandi_olculu_ust, tez_fiyati, beklenen_deger,
  tez_kapanis_nad_orani, net_borc_favok, ltv_yuzde, doluluk_yuzde, ocr_yuzde,
  net_doviz_yukumluluk_eur, gyo_statusu,
  kira_yapisi, degerleme, tez, kirilma_esikleri, kontrol_noktalari, hissedar_yapisi
)
select
  (select id from tezler where ticker = 'RGYAS' order by olusturma desc limit 1),
  'RGYAS', date '2026-10-10', date '2026-06-30',
  3643000000, 4345000000, 331000000, 53.2,
  200, 211, 193.20, 253,
  0.50, 1.9, 11, 99.1, 9.3,
  488000000, false,

  '{
    "para_birimi": "%100 TL, döviz kira yok",
    "endeks": "son 12 aylık TÜFE + kiracı cirosuna bağlı ciro payı",
    "kiraci_ciro_artisi_6a26": 35,
    "ortalama_tufe": 32,
    "avm_sektoru": 32,
    "hazir_giyim_ciro_artisi": 28.6,
    "hazir_giyim_tufe": 31.7,
    "noi_6a25_eur": 92800000,
    "noi_6a26_eur": 116000000,
    "noi_buyume_yuzde": 25,
    "noi_satin_alma_katkisi_eur": 11000000,
    "noi_organik_katki_eur": 12200000,
    "noi_organik_buyume_yuzde": 13,
    "fcf_6a26_eur": 82000000,
    "fcf_getirisi_yillik_yuzde": 14,
    "borc_eur": 584000000,
    "borc_usd": 31500000,
    "faiz_bandi": "%3,5-4,6",
    "fitch": "BB-, durağan",
    "temettu_brut_tl": 7.82,
    "temettu_toplam_tl": 2590000000,
    "stopaj_yuzde": 15,
    "avro_bazli_uretim": "kiralar TL ama TL''nin reel değerlenmesi nedeniyle avro bazında büyüyor",
    "ana_risk": "ani devalüasyonda TL kiralar kurun gerisinde kalır, avro borcun TL karşılığı büyür"
  }'::jsonb,

  '{
    "sirket": "TSKB Gayrimenkul Değerleme",
    "portfoy": "12 AVM + 4 ofis, 7 şehir, 737 bin m² kiralanabilir alan",
    "ilk_yil_getiri_yuzde": "7,7-8,8",
    "cikis_kap_orani_yuzde": "6,75-7,75",
    "varsayim": "kira artışı = TCMB enflasyon beklentisi, reel artış yok",
    "optimum_istanbul": "9 Eylül 2026''dan itibaren %100; kalan %50 pay 68,9 mn €, AVM''nin tamamının rapor değeri 302 mn €",
    "piyasa_ima_firma_degeri_eur": 1700000000,
    "piyasa_ima_m2_eur": 2300,
    "rapor_m2_eur": 5800,
    "piyasa_ima_noi_getirisi_yuzde": 14
  }'::jsonb,

  '{
    "sinyal": "AL",
    "tip": "Yanlış fiyatlama",
    "tarih": "2026-10-10",
    "varsayimlar_12ay": "EUR/TRY +%15, temettü ~8 TL/hisse, enflasyon ~%20",
    "senaryolar": [
      {"ad": "Kötümser", "olasilik": 0.30, "nad_degisim": -0.10, "iskonto": 0.72, "fiyat": 185, "getiri": -0.04},
      {"ad": "Baz",      "olasilik": 0.50, "nad_degisim": 0.00,  "iskonto": 0.64, "fiyat": 260, "getiri": 0.35},
      {"ad": "İyimser",  "olasilik": 0.20, "nad_degisim": 0.05,  "iskonto": 0.55, "fiyat": 340, "getiri": 0.76}
    ],
    "beklenen_deger_nominal_yuzde": 31,
    "beklenen_deger_reel_yuzde": 9,
    "not": "faiz indirimleri beklenenden sert gelirse iyimser senaryonun olasılığı artar",
    "kapanis_kurali": "fiyat ≥ EPRA NAD''ın %50''si"
  }'::jsonb,

  '[
    {"ad": "Kiracı ciro artışı", "metrik": "kiraci_ciro_vs_tufe", "yon": "alt", "esik": 0, "birim": "2 çeyrek üst üste TÜFE altı", "canli_kontrol": false},
    {"ad": "Doluluk", "metrik": "doluluk_yuzde", "yon": "alt", "esik": 97, "birim": "%", "canli_kontrol": false},
    {"ad": "Organik NOI (€)", "metrik": "noi_organik_buyume_yuzde", "yon": "alt", "esik": 0, "birim": "% yıllık", "canli_kontrol": false},
    {"ad": "Net borç/FAVÖK", "metrik": "net_borc_favok", "yon": "ust", "esik": 3.5, "birim": "x", "canli_kontrol": true},
    {"ad": "LTV", "metrik": "ltv_yuzde", "yon": "ust", "esik": 25, "birim": "%", "canli_kontrol": true},
    {"ad": "Ana ortak pay satışı", "metrik": "ana_ortak_pay", "yon": "alt", "esik": 70.6, "birim": "% (satışa başlarsa)", "canli_kontrol": false}
  ]'::jsonb,

  '[
    {"tarih": "2026-10-22", "olay": "TCMB faiz kararı", "izlenecek": "faiz indirimi gelip gelmediği ve büyüklüğü (karar öncesi politika faizi %37)"},
    {"tarih": "2026-11-05", "olay": "3Ç26 sonuçları", "izlenecek": "Optimum İstanbul''un tamamının konsolide edildiği ilk dönem; kiracı cirosu vs TÜFE, hazır giyim cirosu, € bazında organik NOI, satın alma ve temettü sonrası net borç"}
  ]'::jsonb,

  '{
    "ana_ortak": "Rönesans Varlık",
    "ana_ortak_pay": 70.6,
    "ana_ortak_not": "Mayıs 2026''da GIC''ten 8,35 mn payı 163 TL''den aldı, önceki pay %68,1",
    "gic": "Mayıs 2026''da %13,85''lik payının tamamını sattı, Optimum İstanbul ortaklığından da çıktı",
    "yabanci_payi": {"yil_basi": 54, "2026-09-07": 29.1, "2026-10-06": 40.7, "kaynak": "İş Yatırım, takas bazlı"}
  }'::jsonb
on conflict (ticker, guncelleme_tarihi) do nothing;


-- ── Kontrol ──────────────────────────────────────────────────────────
--   select ticker, guncelleme_tarihi, epra_nad_eur, hisse_sayisi, gyo_statusu
--   from tez_veri order by ticker, guncelleme_tarihi desc;
--
--   -- botun okuduğu satır:
--   select * from tez_veri where ticker = 'RGYAS'
--   order by guncelleme_tarihi desc limit 1;
