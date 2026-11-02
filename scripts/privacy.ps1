param(
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Status,
  [switch]$DryRun
)

# Optional, reversible OS-level block for Cursor's direct telemetry host.
# AnyCursor's gateway already blocks analytics that Cursor routes through the
# backend URL. This covers the one endpoint Cursor contacts directly.
#
# Deliberately does NOT block generic Sentry (*.ingest.sentry.io): that domain
# is shared with other applications. Cursor's crash reporter can be turned off
# in Cursor Settings instead.

$ErrorActionPreference = "Stop"
$hosts = Join-Path $env:SystemRoot "System32\drivers\etc\hosts"
$begin = "# BEGIN AnyCursor telemetry block"
$end = "# END AnyCursor telemetry block"
$blockedHosts = @("metrics.cursor.sh")

function Test-Admin {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-Hosts {
  return [IO.File]::ReadAllText($hosts)
}

function Get-BlockPresent([string]$Text) {
  return $Text.Contains($begin) -and $Text.Contains($end)
}

function Remove-Block([string]$Text) {
  $pattern = "(?ms)^" + [regex]::Escape($begin) + "\r?\n.*?^" + [regex]::Escape($end) + "\r?\n?"
  return [regex]::Replace($Text, $pattern, "")
}

if ($Status -or (-not $Enable -and -not $Disable)) {
  $text = Read-Hosts
  $present = Get-BlockPresent $text
  Write-Host "Cursor telemetry hosts block: $(if ($present) { 'enabled' } else { 'disabled' })"
  if ($present) {
    foreach ($name in $blockedHosts) {
      $hit = $text -split "`r?`n" | Where-Object { $_ -match "^\s*0\.0\.0\.0\s+$([regex]::Escape($name))\s*$" }
      if ($hit) { Write-Host "  $name -> 0.0.0.0" }
    }
  }
  Write-Host "Note: telemetry.cursor.sh does not resolve (checked Nov 2026); metrics.cursor.sh is the active host."
  Write-Host "Sentry is not blocked because the domain is shared with other apps."
  exit 0
}

if (-not (Test-Admin)) {
  if ($DryRun) {
    Write-Host "Would update $hosts (administrator required)." -ForegroundColor Yellow
    exit 0
  }
  Write-Host "Administrator approval is required to edit the hosts file..." -ForegroundColor Cyan
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Enable) { $arguments += '-Enable' }
  if ($Disable) { $arguments += '-Disable' }
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
  exit $process.ExitCode
}

$text = Read-Hosts
$present = Get-BlockPresent $text

if ($Enable) {
  $next = Remove-Block $text
  $lines = @($begin) + ($blockedHosts | ForEach-Object { "0.0.0.0 $_" }) + @($end)
  $next = $next.TrimEnd() + "`r`n`r`n" + ($lines -join "`r`n") + "`r`n"
  if ($next -eq $text) {
    Write-Host "Telemetry block is already enabled." -ForegroundColor Green
    exit 0
  }
  if ($DryRun) {
    Write-Host "Would add the AnyCursor telemetry block to $hosts"
    exit 0
  }
  $backupDir = Join-Path $env:LOCALAPPDATA "AnyCursor\backups"
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  $backup = Join-Path $backupDir ("hosts-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") + ".bak")
  Copy-Item $hosts $backup
  [IO.File]::WriteAllText($hosts, $next)
  & ipconfig /flushdns | Out-Null
  Write-Host "Blocked $($blockedHosts -join ', ') for Cursor." -ForegroundColor Green
  Write-Host "Backup: $backup"
  exit 0
}

if ($Disable) {
  if (-not $present) {
    Write-Host "Telemetry block is not present." -ForegroundColor Yellow
    exit 0
  }
  if ($DryRun) {
    Write-Host "Would remove the AnyCursor telemetry block from $hosts"
    exit 0
  }
  $next = (Remove-Block $text).TrimEnd() + "`r`n"
  [IO.File]::WriteAllText($hosts, $next)
  & ipconfig /flushdns | Out-Null
  Write-Host "Removed the AnyCursor telemetry block." -ForegroundColor Green
  exit 0
}
