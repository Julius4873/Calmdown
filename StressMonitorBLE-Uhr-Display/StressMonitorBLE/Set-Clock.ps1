param([ValidatePattern('^COM[0-9]+$')][string]$Port = 'COM6')
$ErrorActionPreference = 'Stop'
$serial = [System.IO.Ports.SerialPort]::new($Port, 115200)
$serial.DtrEnable = $true
$serial.ReadTimeout = 300
$serial.WriteTimeout = 2000
try {
  $serial.Open()
  Start-Sleep -Milliseconds 1200
  $serial.DiscardInBuffer()
  $now = [DateTimeOffset]::Now
  $serial.Write("T $($now.ToUnixTimeSeconds()) $([int]$now.Offset.TotalMinutes)`n")
  $until = [DateTime]::UtcNow.AddSeconds(5)
  $reply = ''
  while ([DateTime]::UtcNow -lt $until) {
    $reply += $serial.ReadExisting()
    if ($reply -match 'CLOCK [^\r\n]+') { Write-Output $Matches[0]; return }
    Start-Sleep -Milliseconds 100
  }
  throw 'Keine CLOCK-Bestaetigung erhalten. Richtige Firmware und COM-Port pruefen.'
} finally {
  if ($serial.IsOpen) { $serial.Close() }
  $serial.Dispose()
}
