param(
  [switch]$Force,
  [switch]$NoLaunch
)

# Recovers from a stuck Cursor update where the updater cannot move
# "resources" because Cursor or an installer process is still alive.
#
# This does not patch Cursor and does not delete user data. It closes Cursor,
# ends leftover Cursor/installer processes, and optionally relaunches Cursor so
# the updater can retry from a clean state.

$ErrorActionPreference = "Stop"
$root = Join-Path $env:LOCALAPPDATA "Programs\cursor"
$exe = Join-Path $root "Cursor.exe"

if (-not $Force) {
  Write-Host "This will close every Cursor window and end leftover Cursor," -ForegroundColor Yellow
  Write-Host "CodeSetup and inno_updater processes. Save your work first." -ForegroundColor Yellow
  $answer = Read-Host "Type YES to continue"
  if ($answer -ne "YES") {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 1
  }
}

function Stop-CursorProcesses {
  $main = Get-Process -Name Cursor -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
  foreach ($process in $main) {
    try { $process.CloseMainWindow() | Out-Null } catch { }
  }
  if ($main) {
    Write-Host "Waiting for Cursor to close..."
    Start-Sleep -Seconds 10
  }

  $remaining = @(Get-Process -Name Cursor -ErrorAction SilentlyContinue)
  if ($remaining) {
    Write-Host "Stopping $($remaining.Count) remaining Cursor process(es)..." -ForegroundColor Yellow
    foreach ($process in $remaining) {
      try { Stop-Process -Id $process.Id -Force -ErrorAction Stop } catch { }
    }
    Start-Sleep -Seconds 3
  }

  $left = @(Get-Process -Name Cursor -ErrorAction SilentlyContinue)
  if ($left) {
    throw "Cursor processes are still running: $($left.Id -join ', ')"
  }
  Write-Host "Cursor processes: none." -ForegroundColor Green
}

function Stop-StuckInstallers {
  $stuck = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -match '^(inno_updater|unins000|CodeSetup|is-)'
  })
  if (-not $stuck) {
    Write-Host "Updater/installer processes: none." -ForegroundColor Green
    return
  }
  foreach ($process in $stuck) {
    Write-Host "Stopping stuck $($process.Name) (pid $($process.ProcessId))..." -ForegroundColor Yellow
    try { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop } catch { }
  }
  Start-Sleep -Seconds 3
}

Stop-CursorProcesses
Stop-StuckInstallers

$installed = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { "" }
$staged = Join-Path $root "_"
$backup = Join-Path $root "_bak"

Write-Host ""
Write-Host "Installed Cursor: $(if ($installed) { $installed } else { 'missing' })"
Write-Host "Staged update:    $(if (Test-Path $staged) { 'present' } else { 'none' })"
Write-Host "Backup:           $(if (Test-Path $backup) { 'present' } else { 'none' })"

if (-not $installed) {
  Write-Host ""
  Write-Host "Cursor.exe is missing from the install directory." -ForegroundColor Yellow
  Write-Host "Run the official Cursor installer once to repair the application." -ForegroundColor Yellow
  exit 2
}

if (-not $NoLaunch) {
  $shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Cursor.lnk"
  if (Test-Path $shortcut) {
    Write-Host "Launching Cursor from the Desktop shortcut..."
    Start-Process -FilePath $shortcut
  } else {
    Write-Host "Launching Cursor..."
    Start-Process -FilePath $exe
  }
}

Write-Host ""
Write-Host "Cleanup complete. If the update still fails, run the official Cursor installer." -ForegroundColor Green
exit 0
