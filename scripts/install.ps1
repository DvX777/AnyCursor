param(
  [int]$Port = 0,
  [string]$Config = "",
  [string]$TaskName = "AnyCursor Gateway",
  [switch]$SkipPackage,
  [switch]$SkipExtension,
  [switch]$SkipTask,
  [switch]$SkipShortcuts,
  [switch]$RequestAdmin
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

function Install-StartupFallback {
  param([string]$Node, [string]$Gateway, [string]$ConfigFile)
  $dataDir = Join-Path $env:LOCALAPPDATA 'AnyCursor'
  $startup = [Environment]::GetFolderPath('Startup')
  New-Item -ItemType Directory -Force -Path $dataDir, $startup | Out-Null

  $link = Join-Path $startup 'AnyCursor Gateway.lnk'
  $launcher = Join-Path $dataDir 'AnyCursor Gateway.exe'
  $launcherOk = $false
  try {
    & (Join-Path $PSScriptRoot 'build-launcher.ps1') -Node $Node -OutDir $dataDir | Out-Null
    $launcherOk = Test-Path $launcher
  } catch {
    Write-Warning "Could not build AnyCursor Gateway.exe ($($_.Exception.Message)); using the script launcher."
  }

  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($link)
  $shortcut.WorkingDirectory = $dataDir
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'Pre-warms the AnyCursor gateway at login.'

  if ($launcherOk) {
    $shortcut.TargetPath = $launcher
    $shortcut.Arguments = ''
    $shortcut.IconLocation = "$launcher,0"
    $shortcut.Save()
    foreach ($old in @('gateway-start.vbs', 'AnyCursor.exe')) {
      $path = Join-Path $dataDir $old
      if (Test-Path $path) { Remove-Item $path -Force }
    }
  } else {
    $vbs = Join-Path $dataDir 'gateway-start.vbs'
    $command = "`"$Node`" `"$Gateway`" --config `"$ConfigFile`""
    $escaped = $command.Replace('"', '""')
    $content = 'CreateObject("WScript.Shell").Run "' + $escaped + '", 0, False' + "`r`n"
    Set-Content -Path $vbs -Value $content -Encoding ASCII
    (Get-Item $vbs).Attributes = 'Hidden'
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = "//B `"$vbs`""
    $shortcut.IconLocation = "$Node,0"
    $shortcut.Save()
  }

  $legacy = Join-Path $startup 'AnyCursor Gateway.vbs'
  if (Test-Path $legacy) { Remove-Item $legacy -Force }
  Write-Host "Created startup shortcut: $link" -ForegroundColor Green
  return $link
}

function Test-IsAdmin {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Quote-Argument([string]$Value) {
  return "'" + $Value.Replace("'", "''") + "'"
}

function Remove-StartupFallback {
  $startup = [Environment]::GetFolderPath('Startup')
  foreach ($name in @('AnyCursor Gateway.lnk', 'AnyCursor Gateway.vbs')) {
    $path = Join-Path $startup $name
    if (Test-Path $path) { Remove-Item $path -Force }
  }
  $dataDir = Join-Path $env:LOCALAPPDATA 'AnyCursor'
  foreach ($name in @('gateway-start.vbs', 'AnyCursor.exe', 'AnyCursor Gateway.exe', 'AnyCursorLauncher.cs')) {
    $path = Join-Path $dataDir $name
    if (Test-Path $path) { Remove-Item $path -Force }
  }
}

function Register-TaskElevated {
  param([string]$Node, [string]$Gateway, [string]$ConfigFile, [string]$WorkingDir)
  $helper = Join-Path $PSScriptRoot 'register-gateway-task.ps1'
  if (-not (Test-Path $helper)) { throw "task helper not found: $helper" }
  $command = '& ' + (Quote-Argument $helper) +
    ' -TaskName ' + (Quote-Argument $TaskName) +
    ' -Node ' + (Quote-Argument $Node) +
    ' -Gateway ' + (Quote-Argument $Gateway) +
    ' -Config ' + (Quote-Argument $ConfigFile) +
    ' -WorkingDirectory ' + (Quote-Argument $WorkingDir)
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $process = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
    -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  return $process.ExitCode -eq 0
}

if (-not $SkipTask) {
  $taskOk = $false
  $taskFailure = ''
  try {
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
    $taskOk = $true
  } catch {
    $taskFailure = $_.Exception.Message
  }

  if (-not $taskOk -and $RequestAdmin -and -not (Test-IsAdmin)) {
    Write-Host "Administrator approval requested for the login task (one-time UAC prompt)..." -ForegroundColor Cyan
    try {
      if (Register-TaskElevated -Node $node -Gateway $gateway -ConfigFile $Config -WorkingDir $gatewayRoot) {
        $taskOk = $true
      } else {
        Write-Warning "The elevated task helper failed."
      }
    } catch {
      Write-Warning "Administrator approval was cancelled or failed: $($_.Exception.Message)"
    }
  }

  if ($taskOk) {
    Remove-StartupFallback
    Write-Host "Task registered and started." -ForegroundColor Green
  } else {
    if ($taskFailure) {
      Write-Warning "Scheduled task registration is not permitted ($taskFailure)."
    }
    Write-Host "Falling back to a hidden Startup shortcut (no admin required)." -ForegroundColor Yellow
    Install-StartupFallback -Node $node -Gateway $gateway -ConfigFile $Config | Out-Null

    $healthy = $false
    try {
      $probePort = if ($Port -gt 0) { $Port } else { 43110 }
      Invoke-RestMethod -UseBasicParsing "http://127.0.0.1:$probePort/health" -TimeoutSec 2 | Out-Null
      $healthy = $true
    } catch { }
    if (-not $healthy) {
      Start-Process -FilePath $node `
        -ArgumentList @("`"$gateway`"", '--config', "`"$Config`"") `
        -WorkingDirectory $gatewayRoot -WindowStyle Hidden
    }
    Write-Host "Gateway is pre-warmed and will start hidden at every login." -ForegroundColor Green
  }
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
