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
    # The gateway and its supervisor live under the extension folder, so they
    # must be stopped before Cursor's CLI replaces it.
    Stop-ScheduledTask -TaskName 'AnyCursor Gateway Watchdog' -ErrorAction SilentlyContinue
    Get-Process -Name 'AnyCursor Gateway' -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'anycursor' -and $_.CommandLine -match 'vendor' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500

    Write-Host "Installing extension from $vsix..." -ForegroundColor Cyan
    & $cli --install-extension $vsix --force
    if ($LASTEXITCODE -ne 0) { throw "extension install failed" }

    # The Cursor CLI leaves the previous version next to the new one.
    $extRoot = Join-Path $env:USERPROFILE '.cursor\extensions'
    if (Test-Path $extRoot) {
      Get-ChildItem $extRoot -Directory -Filter 'anycursor.anycursor-*' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -ne "anycursor.anycursor-$version" } |
        ForEach-Object {
          try {
            Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop
            Write-Host "Removed previous extension $($_.Name)." -ForegroundColor Green
          } catch {
            Write-Warning "Could not remove $($_.FullName); it will be ignored."
          }
        }
    }
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
  # The watchdog build already produced (or failed to produce) the launcher;
  # do not rebuild while its supervisor holds the file open.
  if (-not (Test-Path $launcher)) {
    try {
      & (Join-Path $PSScriptRoot 'build-launcher.ps1') -Node $Node -OutDir $dataDir | Out-Null
    } catch {
      Write-Warning "Could not build AnyCursor Gateway.exe ($($_.Exception.Message)); using the script launcher."
    }
  }
  $launcherOk = Test-Path $launcher

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

function Install-Watchdog {
  param([string]$Node)
  $dataDir = Join-Path $env:LOCALAPPDATA 'AnyCursor'
  $launcher = Join-Path $dataDir 'AnyCursor Gateway.exe'
  $watchName = 'AnyCursor Gateway Watchdog'

  $launcherReady = $false
  # A running supervisor locks the exe; stop it before rebuilding.
  Stop-ScheduledTask -TaskName $watchName -ErrorAction SilentlyContinue
  Get-Process -Name 'AnyCursor Gateway' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  try {
    & (Join-Path $PSScriptRoot 'build-launcher.ps1') -Node $Node -OutDir $dataDir | Out-Null
    $launcherReady = Test-Path $launcher
  } catch {
    Write-Warning "Could not build AnyCursor Gateway.exe ($($_.Exception.Message))."
  }
  if (-not $launcherReady) {
    Write-Warning "Skipping the watchdog: $launcher is missing."
    return $false
  }

  try {
    $action = New-ScheduledTaskAction -Execute $launcher -Argument '--watch'
    $triggerUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @(
      (New-ScheduledTaskTrigger -AtLogOn -User $triggerUser),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1))
    )
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable `
      -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $watchName -Action $action -Trigger $triggers -Settings $settings -Force `
      -Description 'Keeps the AnyCursor gateway running, even when Cursor runs without extensions.' | Out-Null
    Start-ScheduledTask -TaskName $watchName
    Write-Host "Registered the watchdog task '$watchName' (supervises every few seconds)." -ForegroundColor Green
    return $true
  } catch {
    Write-Warning "Watchdog task registration failed ($($_.Exception.Message))."
    return $false
  }
}

function Install-ShortcutGuard {
  param([string]$ConfigFile)
  $bin = Join-Path $env:LOCALAPPDATA 'AnyCursor\bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  foreach ($file in @('shortcut-guard.ps1', 'repair-shortcuts.ps1')) {
    $source = Join-Path $PSScriptRoot $file
    if (-not (Test-Path $source)) { throw "missing $source" }
    Copy-Item $source (Join-Path $bin $file) -Force
  }

  $name = 'AnyCursor Shortcut Guard'
  $guard = Join-Path $bin 'shortcut-guard.ps1'
  try {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    $argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$guard`" -Config `"$ConfigFile`" -Quiet"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
    $triggerUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @(
      (New-ScheduledTaskTrigger -AtLogOn -User $triggerUser),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1))
    )
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Force `
      -Description 'Keeps Cursor shortcuts pointed at AnyCursor across Cursor updates.' | Out-Null
    Start-ScheduledTask -TaskName $name
    Write-Host "Registered '$name' (re-checks shortcuts after Cursor updates)." -ForegroundColor Green
    return $true
  } catch {
    Write-Warning "Shortcut guard registration failed ($($_.Exception.Message))."
    return $false
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
  # Independent of the admin-only login task: the watchdog keeps the gateway alive
  # when Cursor runs in a window that does not load third-party extensions.
  Install-Watchdog -Node $node | Out-Null

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
    Install-ShortcutGuard -ConfigFile $Config | Out-Null
  } else {
    $name = 'AnyCursor Shortcut Guard'
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Shortcut patching is disabled in $Config; removed the shortcut guard task." -ForegroundColor Yellow
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
Write-Host "Open Cursor normally; the watchdog keeps the gateway alive."
Write-Host "Uninstall with: powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1"
