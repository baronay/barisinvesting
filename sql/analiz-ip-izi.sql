-- Misafir analiz sınırı için IP izi.
-- Supabase → SQL Editor'de bir kez çalıştır.
--
-- Neden: kredi kontrolü "kullanıcıyı mail tanır" varsayımıyla yazılmıştı;
-- mail yoksa bakılacak satır da olmadığı için blok tamamen atlanıyordu.
-- Misafir sınırı yalnızca tarayıcıdaki guest_credits'te duruyordu, yani
-- site verisini temizlemek ya da doğrudan uca istek atmak onu baypas
-- ediyordu. 12 Ekim 2026'da tek bir oturumdan 14 dakikada 17 analiz geçti.
--
-- IP ADRESİ SAKLANMIYOR: yalnızca servis anahtarıyla tuzlanmış SHA-256
-- özetinin ilk 32 karakteri. Sayabilmek için yeterli, geri çevrilemez.

alter table analiz_kayitlari add column if not exists ip_iz text;

-- Sayaç sorgusu: son 24 saatteki başarılı analizler, IP izi başına.
create index if not exists analiz_ip_iz_idx
  on analiz_kayitlari (ip_iz, olusturma desc) where ip_iz is not null;

-- ── Kontrol ──────────────────────────────────────────────────────────
--   -- son 24 saatte IP izi başına analiz:
--   select ip_iz, count(*) from analiz_kayitlari
--   where olusturma > now() - interval '24 hours' and durum = 'ok'
--   group by 1 order by 2 desc;
--
--   -- kotaya takılanlar:
--   select count(*) from analiz_kayitlari where hata = 'misafir_kota';
--
--   -- var olmayan sembol yüzünden AI'a gitmeden dönenler:
--   select count(*) from analiz_kayitlari where hata = 'veri-yok';
