param(
  [string]$TaskName = "AnyCursor Gateway",
  [switch]$RemoveData
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed login task '$TaskName'." -ForegroundColor Green
} else {
  Write-Host "Login task '$TaskName' was not registered." -ForegroundColor Yellow
}

$startupEntries = @(
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'AnyCursor Gateway.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Startup')) 'AnyCursor Gateway.vbs'),
  (Join-Path $env:LOCALAPPDATA 'AnyCursor\gateway-start.vbs')
)
foreach ($entry in $startupEntries) {
  if (Test-Path $entry) {
    Remove-Item $entry -Force
    Write-Host "Removed startup entry '$entry'." -ForegroundColor Green
  }
}

$gateways = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'gateway[\\/]index\.js' -and $_.CommandLine -match 'anycursor' }
foreach ($gateway in $gateways) {
  Stop-Process -Id $gateway.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Host "Stopped gateway process $($gateway.ProcessId)." -ForegroundColor Green
}

$cliCandidates = @(
  (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.cmd"),
  (Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.exe")
)
$cli = $cliCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $cli) {
  $cmd = Get-Command cursor -ErrorAction SilentlyContinue
  if ($cmd) { $cli = $cmd.Source }
}
if ($cli) {
  & $cli --uninstall-extension anycursor.anycursor 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Uninstalled the AnyCursor extension." -ForegroundColor Green
  } else {
    Write-Warning "The extension was not installed or could not be removed."
  }
} else {
  Write-Warning "Cursor CLI not found; remove the AnyCursor extension from Cursor manually."
}

& (Join-Path $PSScriptRoot "repair-shortcuts.ps1") -Undo

if ($RemoveData) {
  $localDir = Join-Path $env:LOCALAPPDATA "AnyCursor"
  if (Test-Path $localDir) {
    $answer = Read-Host "Delete $localDir including config and logs? Type YES to confirm"
    if ($answer -eq "YES") {
      Remove-Item $localDir -Recurse -Force
      Write-Host "Removed $localDir" -ForegroundColor Green
    } else {
      Write-Host "Kept $localDir" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "Kept your config and logs in $env:LOCALAPPDATA\AnyCursor." -ForegroundColor Yellow
}

Write-Host "Uninstall complete. Cursor will use its native backend after restart." -ForegroundColor Green
