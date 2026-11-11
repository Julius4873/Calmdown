$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$drive = 'R:'
if (Test-Path "$drive\") { throw "Laufwerk $drive ist bereits belegt." }
$previous = @{}
foreach ($name in @('ARDUINO_DIRECTORIES_DATA', 'ARDUINO_DIRECTORIES_USER', 'ARDUINO_DIRECTORIES_DOWNLOADS')) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
subst.exe $drive $workspace
if ($LASTEXITCODE) { throw 'Kurzer Buildpfad konnte nicht eingerichtet werden.' }
try {
  $tool = "$drive\.arduino-local"
  $env:ARDUINO_DIRECTORIES_DATA = "$tool\data"
  $env:ARDUINO_DIRECTORIES_USER = "$tool\user"
  $env:ARDUINO_DIRECTORIES_DOWNLOADS = "$tool\downloads"
  $sketch = "$drive\StressMonitorBLE-Uhr-Display\StressMonitorBLE"
  $output = "$drive\StressMonitorBLE-Uhr-Display\artifacts"
  $log = Join-Path $PSScriptRoot 'Uhr-Historie-build.log'
  $argsForBuild = @('compile', '--fqbn', 'esp32:esp32:XIAO_ESP32C6:CDCOnBoot=cdc,PartitionScheme=default',
    '--warnings', 'all', '--build-path', "$tool\build\StressMonitorBLE-Uhr-Historie",
    '--output-dir', $output, $sketch)
  $preference = $ErrorActionPreference
  try {
    # Windows PowerShell 5 represents native stderr lines as error records.
    # Compiler warnings must not abort the pipeline before the real exit code.
    $ErrorActionPreference = 'Continue'
    & "$tool\arduino-cli.exe" @argsForBuild 2>&1 | ForEach-Object { $_.ToString() } | Tee-Object -FilePath $log
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $preference
  }
  if ($exitCode) { throw "Kompilierung fehlgeschlagen, Exitcode $exitCode." }
} finally {
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  subst.exe $drive /d
}
