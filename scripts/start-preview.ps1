param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 3105
)

$ErrorActionPreference = "Stop"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$buildId = Join-Path $workspace ".next\BUILD_ID"
if (-not (Test-Path -LiteralPath $buildId)) {
  throw "Build produksi belum tersedia. Jalankan npm.cmd run build terlebih dahulu."
}

$existing = netstat -ano |
  Select-String -Pattern "LISTENING\s+\d+\s*$" |
  Where-Object { $_.Line -match "[:.]$Port\s+" } |
  Select-Object -First 1

if ($existing) {
  $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 5
  [PSCustomObject]@{
    Started = $false
    Port = $Port
    HttpStatus = [int]$response.StatusCode
    Message = "Preview sudah aktif."
  }
  return
}

$node = (Get-Command node.exe -ErrorAction Stop).Source
$env:DUCKDB_STATE_PATH = Join-Path $workspace "db\app_state_preview_$Port.duckdb"
$env:WIOM_EMBEDDED_SYNC = "0"
$env:WIOM_API_SYNC_BOOTSTRAP = "0"
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $node
$startInfo.Arguments = "`"scripts\start-production.mjs`" --port $Port --sync-optional"
$startInfo.WorkingDirectory = $workspace
$startInfo.UseShellExecute = $true
$startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$process = [System.Diagnostics.Process]::Start($startInfo)

$response = $null
for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
    break
  } catch {
    if ($process.HasExited) {
      throw "Preview berhenti saat startup (exit code $($process.ExitCode))."
    }
  }
}

if (-not $response) {
  throw "Preview tidak merespons di port $Port dalam 10 detik."
}

[PSCustomObject]@{
  Started = $true
  SupervisorPid = $process.Id
  Port = $Port
  HttpStatus = [int]$response.StatusCode
  Message = "Preview aktif dan proses launcher sudah terlepas."
}
