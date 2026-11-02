param(
  [string]$Config = "",
  [switch]$Force,
  [switch]$DryRun,
  [switch]$Quiet
)

# Keeps Cursor's shortcuts and running client pointed at the AnyCursor gateway
# across Cursor's forced desktop updates. Cursor's updater (Squirrel/Inno) can
# recreate Start Menu and Desktop shortcuts without --test-backend-url, and a
# Cursor instance launched without the flag bypasses the gateway entirely.
#
# This guard never touches Cursor's binaries, app.asar or extension bundles.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if ([string]::IsNullOrWhiteSpace($Config)) {
  $local = Join-Path $env:LOCALAPPDATA "AnyCursor\config.json"
  $repo = Join-Path $root "config\anycursor.json"
  if (Test-Path $local) { $Config = $local }
  elseif (Test-Path $repo) { $Config = $repo }
}

function Write-Quiet([string]$Text, [string]$Color = "Green") {
  if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}

function Write-GuardLog([string]$Text) {
  try {
    $logDir = Join-Path $env:LOCALAPPDATA "AnyCursor\logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Add-Content -Path (Join-Path $logDir "shortcut-guard.log") `
      -Value ((Get-Date).ToUniversalTime().ToString("o") + " " + $Text) -Encoding UTF8
  } catch { }
}

function Show-Alert([string]$Title, [string]$Message) {
  # Prefer a Windows toast; fall back to a tray balloon. Both are best effort:
  # the persistent alert file and dashboard warning do not depend on either.
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $safeTitle = [System.Security.SecurityElement]::Escape($Title)
    $safeMessage = [System.Security.SecurityElement]::Escape($Message)
    $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeMessage</text></binding></visual></toast>")
    $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    return
  } catch { }

  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Warning
    $icon.Visible = $true
    $icon.ShowBalloonTip(10000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Warning)
    Start-Sleep -Seconds 3
    $icon.Dispose()
  } catch { }
}

function Resolve-CursorExe {
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe"),
    (Join-Path $env:ProgramFiles "Cursor\Cursor.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $cmd = Get-Command cursor -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    $exe = Join-Path (Split-Path (Split-Path $cmd.Source -Parent) -Parent) "Cursor.exe"
    if (Test-Path $exe) { return $exe }
  }
  return $null
}

$exe = Resolve-CursorExe
if (-not $exe) {
  Write-Quiet "Cursor.exe not found; nothing to guard." "Yellow"
  exit 0
}

$version = (Get-Item $exe).VersionInfo.ProductVersion
$backendUrl = ""
$patchShortcuts = $true
if ($Config -and (Test-Path $Config)) {
  try {
    $json = Get-Content $Config -Raw | ConvertFrom-Json
    if ($json.cursor -and $json.cursor.backendUrl) { $backendUrl = [string]$json.cursor.backendUrl }
    if ($json.cursor -and $json.cursor.patchShortcuts -eq $false) { $patchShortcuts = $false }
    if (-not $backendUrl -and $json.gateway) {
      $hostName = if ($json.gateway.host) { [string]$json.gateway.host } else { '127.0.0.1' }
      $port = if ($json.gateway.port) { [int]$json.gateway.port } else { 43110 }
      $backendUrl = "http://${hostName}:${port}"
    }
  } catch {
    Write-Quiet "Could not read $Config; leaving shortcuts alone." "Yellow"
    exit 1
  }
}
if (-not $patchShortcuts) { exit 0 }
if ([string]::IsNullOrWhiteSpace($backendUrl)) { $backendUrl = "http://127.0.0.1:43110" }

# Accept both "--test-backend-url URL" and "--test-backend-url=URL", with or
# without quotes, so a flag written by an older AnyCursor still counts.
$flagPattern = '--test-backend-url(?:\s+|=)"?' + [regex]::Escape($backendUrl) + '"?'

# Cursor stores the current shortcut set in these three user-level locations.
$roots = @(
  [Environment]::GetFolderPath("Desktop"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
  (Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
) | Where-Object { $_ -and (Test-Path $_) }

$shell = New-Object -ComObject WScript.Shell
$total = 0
$missing = 0
foreach ($dir in $roots) {
  Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'cursor' } |
    ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        if (-not $shortcut.TargetPath) { return }
        if ([IO.Path]::GetFileName($shortcut.TargetPath) -ne [IO.Path]::GetFileName($exe)) { return }
        $total += 1
        if ([string]$shortcut.Arguments -notmatch $flagPattern) { $missing += 1 }
      } catch { }
    }
}

# A running Cursor only reads its command line once. If it is already running
# without the flag, fixing shortcuts is not enough: the user must restart it.
#
# Cursor spawns helpers that are also called Cursor.exe: Electron helpers carry
# --type=, and the cursor-always-local git worker runs a .js entry point with a
# Cursor parent. Only root app processes own the backend flag.
$allCursor = @(Get-CimInstance Win32_Process -Filter "Name='Cursor.exe'" -ErrorAction SilentlyContinue)
$cursorPids = @($allCursor | ForEach-Object { [int]$_.ProcessId })
$cursorMains = @($allCursor | Where-Object {
  $_.CommandLine -and
  ($_.CommandLine -notmatch '--type=') -and
  ($_.CommandLine -notmatch '\.js(?:\s|$|")') -and
  ($cursorPids -notcontains [int]$_.ParentProcessId)
})
$unpatched = @($cursorMains | Where-Object { $_.CommandLine -notmatch $flagPattern })

$stateDir = Join-Path $env:LOCALAPPDATA "AnyCursor\state"
$stateFile = Join-Path $stateDir "shortcuts.json"
$alertFile = Join-Path $stateDir "client-alert.json"
$knownVersion = ""
$knownUrl = ""
if (Test-Path $stateFile) {
  try {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    $knownVersion = [string]$state.cursorVersion
    $knownUrl = [string]$state.backendUrl
  } catch { }
}

$upToDate = ($knownVersion -eq $version) -and ($knownUrl -eq $backendUrl) -and ($missing -eq 0)
if ($upToDate -and $unpatched.Count -eq 0 -and -not $Force) {
  if (-not $DryRun -and (Test-Path $alertFile)) {
    Remove-Item $alertFile -Force -ErrorAction SilentlyContinue
    Write-GuardLog "cleared stale alert: Cursor is now running with the backend flag"
  }
  if (-not $DryRun) {
    @{
      cursorVersion = $version
      backendUrl = $backendUrl
      shortcuts = $total
      missing = $missing
      unpatchedRunning = 0
      checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    } | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding UTF8
  }
  Write-Quiet "Cursor ${version}: $total shortcut(s), $($cursorMains.Count) running with the backend flag."
  exit 0
}

if ($DryRun) {
  Write-Host "Cursor ${version}: $missing of $total shortcut(s) need repair; $($unpatched.Count) running Cursor process(es) bypass the gateway."
  exit 0
}

$repair = Join-Path $PSScriptRoot "repair-shortcuts.ps1"
if (-not (Test-Path $repair)) {
  Write-Quiet "repair-shortcuts.ps1 not found next to this guard." "Yellow"
  exit 1
}

# repair-shortcuts resolves the backend URL from the same config and is
# idempotent: it removes any previous flag before adding the current one.
try {
  & $repair -Config $Config -BackendUrl $backendUrl 6>$null | Out-Null
} catch {
  Write-Quiet "Shortcut repair failed: $($_.Exception.Message)" "Yellow"
  Write-GuardLog "repair failed: $($_.Exception.Message)"
  exit 1
}

# Re-count after the repair so the state file reflects reality.
$missing = 0
foreach ($dir in $roots) {
  Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match 'cursor' } |
    ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        if (-not $shortcut.TargetPath) { return }
        if ([IO.Path]::GetFileName($shortcut.TargetPath) -ne [IO.Path]::GetFileName($exe)) { return }
        if ([string]$shortcut.Arguments -notmatch $flagPattern) { $missing += 1 }
      } catch { }
    }
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
@{
  cursorVersion = $version
  backendUrl = $backendUrl
  shortcuts = $total
  missing = $missing
  unpatchedRunning = $unpatched.Count
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding UTF8

if ($unpatched.Count -gt 0) {
  $pidValue = $unpatched[0].ProcessId
  $now = (Get-Date).ToUniversalTime()
  $last = $null
  if (Test-Path $alertFile) {
    try { $last = Get-Content $alertFile -Raw | ConvertFrom-Json } catch { }
  }

  $sameProcess = $last -and ([int]$last.pid -eq [int]$pidValue) -and ([string]$last.backendUrl -eq $backendUrl)
  $recent = $false
  if ($last -and $last.toastAt) {
    try { $recent = ($now - [datetime]::Parse($last.toastAt).ToUniversalTime()).TotalMinutes -lt 60 } catch { }
  }

  $message = if ($missing -eq 0) {
    'Cursor is running without the AnyCursor backend. Shortcuts were repaired; restart Cursor to use AnyCursor.'
  } else {
    'Cursor is running without the AnyCursor backend and shortcut repair was incomplete. Run AnyCursor: Doctor, then restart Cursor.'
  }

  $alert = @{
    kind = 'cursor-unpatched'
    pid = [int]$pidValue
    backendUrl = $backendUrl
    cursorVersion = $version
    detectedAt = $(if ($last -and $sameProcess -and $last.detectedAt) { [string]$last.detectedAt } else { $now.ToString("o") })
    toastAt = $(if ($sameProcess -and $recent) { [string]$last.toastAt } else { $now.ToString("o") })
    message = $message
  }
  $alert | ConvertTo-Json -Depth 4 | Set-Content -Path $alertFile -Encoding UTF8

  if (-not ($sameProcess -and $recent)) {
    Show-Alert 'AnyCursor: Cursor bypassed the gateway' $message
    Write-GuardLog "alerted: pid $pidValue has no backend flag"
  }
  Write-Quiet "Cursor is running without the AnyCursor backend (pid $pidValue). Restart Cursor after the shortcuts were repaired." "Yellow"
  exit 0
}

if (Test-Path $alertFile) { Remove-Item $alertFile -Force -ErrorAction SilentlyContinue }

if ($missing -gt 0) {
  Write-Quiet "Cursor ${version}: $missing of $total shortcut(s) still lack the flag." "Yellow"
  Write-GuardLog "repair incomplete: $missing of $total shortcuts missing the flag"
  exit 1
}
Write-Quiet "Cursor ${version}: repaired $total shortcut(s) -> $backendUrl."
Write-GuardLog "repaired $total shortcut(s) for Cursor $version -> $backendUrl"
exit 0
