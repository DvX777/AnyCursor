param(
  [int]$Port = 0,
  [string]$Config = "",
  [string]$TaskName = "AnyCursor Gateway",
  [switch]$SkipPackage,
  [switch]$SkipExtension,
  [switch]$SkipTask,
  [switch]$SkipShortcuts
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$localDir = Join-Path $env:LOCALAPPDATA "AnyCursor"
$localConfig = Join-Path $localDir "config.json"

function Get-NodePath {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw "node was not found on PATH" }
  return $node.Source
}

function Get-CursorCli {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.cmd"),
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $cmd = Get-Command cursor -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Seed-Config {
  if (Test-Path $localConfig) { return }
  New-Item -ItemType Directory -Force -Path $localDir | Out-Null
  $repoConfig = Join-Path $root "config\anycursor.json"
  $example = Join-Path $root "config\anycursor.example.json"
  if (Test-Path $repoConfig) {
    Copy-Item $repoConfig $localConfig
    Write-Host "Seeded $localConfig from the repository config." -ForegroundColor Yellow
  } elseif (Test-Path $example) {
    Copy-Item $example $localConfig
    Write-Host "Seeded $localConfig from the example; add your provider keys there or in the dashboard." -ForegroundColor Yellow
  } else {
    throw "no config found; create $localConfig from config/anycursor.example.json"
  }
}

function Find-Gateway {
  $extRoot = Join-Path $env:USERPROFILE ".cursor\extensions"
  if (Test-Path $extRoot) {
    $installed = Get-ChildItem $extRoot -Directory -Filter "anycursor.anycursor-*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending
    foreach ($ext in $installed) {
      $candidate = Join-Path $ext.FullName "vendor\anycursor\src\gateway\index.js"
      if (Test-Path $candidate) { return $candidate }
    }
  }
  $dev = Join-Path $root "src\gateway\index.js"
  if (Test-Path $dev) { return $dev }
  throw "gateway runtime not found; package and install the extension first"
}

$node = Get-NodePath
Seed-Config
if ([string]::IsNullOrWhiteSpace($Config)) { $Config = $localConfig }

if (-not $SkipPackage) {
  Write-Host "Packaging the extension..." -ForegroundColor Cyan
  Push-Location $root
  try {
    & npm run package:extension
    if ($LASTEXITCODE -ne 0) { throw "extension packaging failed" }
  } finally {
    Pop-Location
  }
}

$version = (Get-Content (Join-Path $root "extension\package.json") -Raw | ConvertFrom-Json).version
$vsix = Join-Path $root "extension\anycursor-$version.vsix"
if (-not (Test-Path $vsix) -and -not $SkipPackage) { throw "VSIX not found at $vsix" }

if (-not $SkipExtension -and (Test-Path $vsix)) {
  $cli = Get-CursorCli
  if (-not $cli) {
    Write-Warning "Cursor CLI not found; install the VSIX manually: $vsix"
  } else {
    Write-Host "Installing extension from $vsix..." -ForegroundColor Cyan
    & $cli --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw "extension install failed" }
  }
}

$gateway = Find-Gateway
$gatewayRoot = Split-Path (Split-Path $gateway -Parent) -Parent

if (-not $SkipTask) {
  Write-Host "Registering the login task '$TaskName'..." -ForegroundColor Cyan
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $node `
    -Argument "`"$gateway`" --config `"$Config`"" -WorkingDirectory $gatewayRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description "Pre-warms the AnyCursor gateway at login." | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Task registered and started." -ForegroundColor Green
}

if (-not $SkipShortcuts) {
  $json = Get-Content $Config -Raw | ConvertFrom-Json
  if (-not $json.cursor -or $json.cursor.patchShortcuts -ne $false) {
    & (Join-Path $PSScriptRoot "repair-shortcuts.ps1") -Port $Port -Config $Config
  } else {
    Write-Host "Shortcut patching is disabled in $Config." -ForegroundColor Yellow
  }
}

if ($Port -le 0) {
  $json = Get-Content $Config -Raw | ConvertFrom-Json
  $Port = if ($json.gateway -and $json.gateway.port) { [int]$json.gateway.port } else { 43110 }
}

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 400
  try {
    $health = Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:$Port/health" -TimeoutSec 2
    $ready = $true
    break
  } catch { }
}

Write-Host ""
if ($ready) {
  Write-Host "AnyCursor is installed and ready on http://127.0.0.1:$Port" -ForegroundColor Green
} else {
  Write-Warning "Gateway is not answering on port $Port yet. Check the login task or run: npm start"
}
Write-Host "Config:    $Config"
Write-Host "Dashboard: http://127.0.0.1:$Port/"
Write-Host "Open Cursor normally; the extension keeps the gateway alive."
Write-Host "Uninstall with: powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1"
