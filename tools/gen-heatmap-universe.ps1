# Isı haritası evren tablosu üreteci — Yahoo quote (crumb) ile gerçek
# sharesOutstanding + sector + isim çeker, api/_heatmap-universe.js yazar.
#
# Runtime'da KULLANILMAZ; yılda bir elle çalıştırılır:
#   powershell -ExecutionPolicy Bypass -File tools\gen-heatmap-universe.ps1
#
# NOT: Windows PowerShell 5.1 BOM'suz .ps1 dosyalarını ANSI okur ve
# Türkçe karakterleri bozar — bu dosya UTF-8 BOM ile kaydedilmeli.
#
# Evrene hisse eklemek/çıkarmak için aşağıdaki $US / $BIST listelerini
# düzenleyip betiği tekrar çalıştır.
$ErrorActionPreference = 'Stop'
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

$US = @(
 'AAPL','MSFT','NVDA','AVGO','ORCL','CRM','AMD','ADBE','CSCO','ACN','TXN','QCOM','INTU','IBM','NOW','AMAT','MU','INTC','PANW','LRCX','ADI','KLAC','SNPS','CDNS',
 'GOOGL','META','NFLX','DIS','CMCSA','T','VZ','TMUS','EA',
 'AMZN','TSLA','HD','MCD','BKNG','LOW','NKE','SBUX','TJX','ABNB','GM','F','MAR','ORLY','CMG',
 'WMT','PG','COST','KO','PEP','PM','MO','MDLZ','CL','TGT','KMB','GIS','SYY','KR',
 'LLY','UNH','JNJ','ABBV','MRK','TMO','ABT','DHR','PFE','AMGN','BSX','SYK','VRTX','GILD','ISRG','ELV','CVS','MDT','REGN','ZTS','BMY','CI','HCA',
 'BRK-B','JPM','V','MA','BAC','WFC','MS','GS','SPGI','AXP','BLK','C','SCHW','CB','PGR','MMC','AON','COF','ICE','CME','BX','KKR',
 'GE','CAT','RTX','HON','UNP','UPS','BA','LMT','DE','ADP','ETN','ITW','CSX','NOC','WM','EMR','GD','FDX','PH','TT',
 'XOM','CVX','COP','EOG','SLB','MPC','PSX','OXY','WMB','VLO','KMI','OKE',
 'NEE','DUK','SO','D','AEP','SRE','EXC','XEL','ED','PEG',
 'PLD','AMT','EQIX','CCI','PSA','SPG','O','WELL','DLR',
 'LIN','SHW','APD','ECL','FCX','NEM','DOW','NUE','VMC','MLM'
)

$BIST = @(
 'THYAO','ASELS','KCHOL','SAHOL','GARAN','AKBNK','ISCTR','YKBNK','VAKBN','HALKB','TUPRS','EREGL','BIMAS','FROTO','TOASO','TCELL','TTKOM','SISE','PGSUS','TAVHL',
 'ENKAI','PETKM','KOZAL','KRDMD','SOKM','MGROS','ULKER','CCOLA','ARCLK','VESTL','EKGYO','ENJSA','TURSG','AEFES','DOHOL','KOZAA','ODAS','ALARK','GUBRF','HEKTS',
 'ISMEN','KONTR','SASA','SMRTG','TKFEN','TTRAK','ZOREN','AGHOL','AKSA','AKSEN','ANSGR','ASTOR','BRSAN','BRYAT','CIMSA','EGEEN','ENERY','EUPWR','GESAN','GWIND',
 'ISDMR','KARSN','KCAER','KLSER','MAVI','MPARK','OTKAR','OYAKC','PENTA','REEDR','SAHOL','SELEC','SKBNK','TABGD','TSKB','TUKAS','VESBE','YEOTK','AGROT','ALFAS',
 'BINHO','CANTE','CWENE','ECILC','FENER','IPEKE','KRDMA','LOGO','MIATK','NTHOL','OBAMS','PASEU','QUAGR','RALYH','SDTTR','TMSN','TRGYO','ULUUN','YYLGD','ZRGYO'
) | Select-Object -Unique

function Get-Crumb {
  $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try { Invoke-WebRequest -Uri 'https://fc.yahoo.com' -WebSession $s -UserAgent $UA -UseBasicParsing -TimeoutSec 20 | Out-Null } catch {}
  $c = Invoke-WebRequest -Uri 'https://query1.finance.yahoo.com/v1/test/getcrumb' -WebSession $s -UserAgent $UA -UseBasicParsing -TimeoutSec 20
  return @{ session = $s; crumb = $c.Content }
}

$ctx = Get-Crumb
Write-Host "crumb: $($ctx.crumb)"

function Fetch-Quotes($symbols) {
  $out = @()
  for ($i = 0; $i -lt $symbols.Count; $i += 40) {
    $chunk = $symbols[$i..([Math]::Min($i + 39, $symbols.Count - 1))]
    $q = ($chunk -join ',')
    $u = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=$q&crumb=$([uri]::EscapeDataString($ctx.crumb))&fields=symbol,shortName,longName,sector,sharesOutstanding,marketCap,regularMarketPrice,currency,fullExchangeName"
    try {
      $r = Invoke-WebRequest -Uri $u -WebSession $ctx.session -UserAgent $UA -UseBasicParsing -TimeoutSec 30
      $out += ($r.Content | ConvertFrom-Json).quoteResponse.result
      Write-Host "  batch $i ok (+$((($r.Content|ConvertFrom-Json).quoteResponse.result).Count))"
    } catch { Write-Host "  batch $i ERR $($_.Exception.Message)" }
    Start-Sleep -Milliseconds 400
  }
  return $out
}

Write-Host "ABD cekiliyor..."
$usq = Fetch-Quotes $US
Write-Host "BIST cekiliyor..."
$bistq = Fetch-Quotes ($BIST | ForEach-Object { "$_.IS" })

$SEKTOR = @{
  'Technology' = 'Teknoloji'; 'Financial Services' = 'Finans'; 'Healthcare' = 'Sağlık';
  'Consumer Cyclical' = 'Tüketici'; 'Communication Services' = 'İletişim'; 'Industrials' = 'Sanayi';
  'Consumer Defensive' = 'Temel Tüketim'; 'Energy' = 'Enerji'; 'Utilities' = 'Kamu Hizmetleri';
  'Real Estate' = 'Gayrimenkul'; 'Basic Materials' = 'Temel Materyal'
}

function To-Rows($quotes, $stripIS) {
  $rows = @()
  foreach ($q in $quotes) {
    if (-not $q.symbol) { continue }
    $sh = $q.sharesOutstanding
    if (-not $sh -and $q.marketCap -and $q.regularMarketPrice) { $sh = [math]::Round($q.marketCap / $q.regularMarketPrice) }
    if (-not $sh -or $sh -le 0) { Write-Host "  ATLANDI (pay yok): $($q.symbol)"; continue }
    $sec = $SEKTOR[[string]$q.sector]
    if (-not $sec) { $sec = if ($q.sector) { [string]$q.sector } else { 'Diğer' } }
    $ad = if ($q.longName) { [string]$q.longName } elseif ($q.shortName) { [string]$q.shortName } else { [string]$q.symbol }
    # Kurumsal son ekleri temizle — kutu üstünde/tooltip'te kısa ad okunsun
    $ad = $ad -replace '\s*\(The\)\s*$', ''
    $ad = $ad -replace '\s+(Incorporated|Corporation|Company|Limited|Holdings|Holding)\b', ''
    $ad = $ad -replace ',?\s+(Inc|Corp|Co|Ltd|plc|PLC|LLC|SA|NV|AS|A\.S|N\.V|S\.A)\.?\b', ''
    $ad = $ad -replace '\s+(Class\s+[A-C]|New|Common Stock|Ser(ies)?\s+[A-C])\b', ''
    $ad = ($ad -replace '[\s,\.\(\-]+$', '').Trim()
    if ($ad.Length -gt 24) {
      # Kelime sınırından kes, ortadan bölme
      $kes = $ad.Substring(0, 24)
      $bosluk = $kes.LastIndexOf(' ')
      if ($bosluk -ge 12) { $kes = $kes.Substring(0, $bosluk) }
      $ad = $kes.Trim()
    }
    if (-not $ad) { $ad = [string]$q.symbol }
    $tk = [string]$q.symbol
    if ($stripIS) { $tk = $tk -replace '\.IS$', '' }
    # Borsa: analiz ekranındaki rozet doğru yazsın (JPM NYSE, AAPL NASDAQ)
    $borsa = if ($stripIS) { 'BIST' }
             elseif ([string]$q.fullExchangeName -match 'Nasdaq') { 'NASDAQ' }
             else { 'NYSE' }
    $rows += [pscustomobject]@{ t = $tk; n = $ad; s = $sec; sh = [long]$sh; x = $borsa }
  }
  return $rows | Sort-Object s, @{Expression = 'sh'; Descending = $true }
}

$usRows = To-Rows $usq $false
$bistRows = To-Rows $bistq $true
Write-Host "ABD: $($usRows.Count) satir, BIST: $($bistRows.Count) satir"

function Emit($rows) {
  ($rows | ForEach-Object {
    $n = $_.n -replace '\\', '\\' -replace "'", "\'"
    "  { t: '$($_.t)', n: '$n', s: '$($_.s)', sh: $($_.sh), x: '$($_.x)' },"
  }) -join "`n"
}

$header = @"
/* ═══════════════════════════════════════════════════════════════
   ISI HARİTASI EVRENİ — statik referans tablosu
   Alanlar: t = sembol, n = kısa ad, s = sektör, sh = ödenmiş pay adedi,
            x = borsa (NASDAQ / NYSE / BIST).

   Kutu boyutu = sh × canlı fiyat (piyasa değeri). Pay adedi yavaş
   değişir (geri alım ~%1-3/yıl), fiyat Yahoo spark'tan canlı gelir —
   bu yüzden tablo statik olabiliyor.

   ÜRETİM: scratchpad/gen-universe.ps1 (Yahoo quote + crumb).
   Yılda bir çalıştırıp bu dosyayı yenilemek yeterli.
   Üretim tarihi: $(Get-Date -Format 'yyyy-MM-dd')
   ═══════════════════════════════════════════════════════════════ */

export const US_EVREN = [
$(Emit $usRows)
];

export const BIST_EVREN = [
$(Emit $bistRows)
];
"@

$hedef = Join-Path (Split-Path $PSScriptRoot -Parent) 'api\_heatmap-universe.js'
[System.IO.File]::WriteAllText($hedef, $header, (New-Object System.Text.UTF8Encoding $false))
Write-Host "YAZILDI -> $hedef"
