param(
  [int]$Port = 0,
  [string]$Config = "",
  [string]$BackendUrl = "",
  [switch]$Undo,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

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

if ([string]::IsNullOrWhiteSpace($Config)) {
  $repoConfig = Join-Path $root "config\anycursor.json"
  $localConfig = Join-Path $env:LOCALAPPDATA "AnyCursor\config.json"
  if (Test-Path $repoConfig) { $Config = $repoConfig }
  elseif (Test-Path $localConfig) { $Config = $localConfig }
}

if ($Port -le 0 -or [string]::IsNullOrWhiteSpace($BackendUrl)) {
  if ($Port -le 0) { $Port = 43110 }
  if ($Config -and (Test-Path $Config)) {
    try {
      $json = Get-Content $Config -Raw | ConvertFrom-Json
      if ($Port -le 0 -and $json.gateway -and $json.gateway.port) { $Port = [int]$json.gateway.port }
      if ([string]::IsNullOrWhiteSpace($BackendUrl) -and $json.cursor -and $json.cursor.backendUrl) {
        $BackendUrl = [string]$json.cursor.backendUrl
      }
    } catch { }
  }
}
if ([string]::IsNullOrWhiteSpace($BackendUrl)) { $BackendUrl = "http://127.0.0.1:$Port" }
if ($BackendUrl -notmatch '^https?://') { throw "backend URL must start with http:// or https://: $BackendUrl" }

$exe = Resolve-CursorExe
if (-not $exe) { throw "Cursor.exe not found; install Cursor first" }
$exeName = [IO.Path]::GetFileName($exe)

$roots = @(
  [Environment]::GetFolderPath("Desktop"),
  (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
  (Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
) | Where-Object { $_ -and (Test-Path $_) }

$flag = "--test-backend-url $BackendUrl"
$shell = New-Object -ComObject WScript.Shell
$changed = @()

foreach ($dir in $roots) {
  $links = Get-ChildItem -Path $dir -Filter "*.lnk" -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like "*Cursor*" -or $_.Name -like "*cursor*" }

  foreach ($link in $links) {
    try {
      $shortcut = $shell.CreateShortcut($link.FullName)
      if (-not $shortcut.TargetPath) { continue }
      if ([IO.Path]::GetFileName($shortcut.TargetPath) -ne $exeName) { continue }

      $original = $shortcut.Arguments
      $cleaned = [regex]::Replace(
        [string]$original,
        '(?i)(^|\s)--test-backend-url(?:\s+|=)(?:"[^"]*"|\S+)',
        ''
      ).Trim()

      if ($Undo) {
        if ($cleaned -eq ([string]$original).Trim()) { continue }
        $next = $cleaned
      } else {
        $next = (@($cleaned, $flag) | Where-Object { $_ }) -join ' '
      }
      if ($next -eq ([string]$original).Trim()) { continue }
      if ($DryRun) {
        $changed += "(dry run) $($link.FullName): '$original' -> '$next'"
        continue
      }

      $backupDir = Join-Path $env:LOCALAPPDATA 'AnyCursor\backups\shortcuts'
      New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
      $safeName = ($link.FullName -replace '^[A-Za-z]:\\', '' -replace '[\\/:*?"<>|]', '_')
      $backup = Join-Path $backupDir "$safeName.anycursor.bak"
      if (-not (Test-Path $backup)) { Copy-Item $link.FullName $backup }

      $shortcut.Arguments = $next
      $shortcut.Save()
      $changed += $link.FullName
    } catch {
      Write-Warning "could not update $($link.FullName): $($_.Exception.Message)"
    }
  }
}

if ($changed.Count -eq 0) {
  Write-Host "No Cursor shortcuts needed changes." -ForegroundColor Yellow
} else {
  $action = if ($Undo) { "restored" } else { "pointed at http://127.0.0.1:$Port" }
  Write-Host "Updated $($changed.Count) shortcut(s), ${action}:" -ForegroundColor Green
  $changed | ForEach-Object { Write-Host "  $_" }
  Write-Host "Backups: $env:LOCALAPPDATA\AnyCursor\backups\shortcuts"
}
