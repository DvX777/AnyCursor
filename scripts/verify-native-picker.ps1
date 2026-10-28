param(
  [int]$Port = 43111,
  [string]$Config = "",
  [switch]$NoCursor
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if ([string]::IsNullOrWhiteSpace($Config)) {
  $Config = Join-Path $root "config\anycursor.json"
  if (-not (Test-Path $Config)) {
    Copy-Item (Join-Path $root "config\anycursor.example.json") $Config
    Write-Host "created $Config from the example" -ForegroundColor Yellow
  }
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  throw "port $Port is already in use by pid $($existing.OwningProcess -join ',')"
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node not found on PATH" }

$logDir = Join-Path $env:LOCALAPPDATA "AnyCursor\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "gateway.out.log"
$errLog = Join-Path $logDir "gateway.err.log"

$env:ANY_CURSOR_CONFIG = $Config
$env:ANY_CURSOR_PORT = "$Port"
$proc = Start-Process -FilePath $node `
  -ArgumentList @("$root\src\gateway\index.js") `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 300
  try {
    $health = Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:$Port/health" -TimeoutSec 2
    $ready = $true
    break
  } catch { }
}

if (-not $ready) {
  throw "gateway did not become ready on port $Port; see $errLog"
}

Write-Host ""
Write-Host "AnyCursor gateway: http://127.0.0.1:$Port" -ForegroundColor Green
Write-Host "Dashboard:         http://127.0.0.1:$Port/"
Write-Host "Config:            $Config"
Write-Host "Models:            $($health.models.Count)"
Write-Host ""

if ($NoCursor) {
  Write-Host "Gateway only. Launch Cursor manually with --test-backend-url http://127.0.0.1:$Port"
  exit 0
}

if (Get-Process Cursor -ErrorAction SilentlyContinue) {
  Write-Host "Cursor is already running. Fully quit it, then launch:" -ForegroundColor Yellow
  Write-Host "  & `"$env:LOCALAPPDATA\Programs\cursor\Cursor.exe`" --test-backend-url http://127.0.0.1:$Port" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "This test script does not kill Cursor." -ForegroundColor Yellow
  exit 0
}

$exe = Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"
if (-not (Test-Path $exe)) { throw "Cursor.exe not found at $exe" }
Start-Process -FilePath $exe -ArgumentList @("--test-backend-url", "http://127.0.0.1:$Port")
Write-Host "Cursor launched with --test-backend-url http://127.0.0.1:$Port"
Write-Host "Open the model picker and check the AnyCursor entries."
Write-Host "Stop the gateway with: powershell -ExecutionPolicy Bypass -File .\scripts\stop-gateway.ps1 -Port $Port"
