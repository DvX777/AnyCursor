param(
  [switch]$List,
  [string]$Pin = "",
  [switch]$Previous,
  [switch]$Restore
)

$ErrorActionPreference = "Stop"
$root = Join-Path $env:APPDATA "Cursor\agent-harness"
$currentFile = Join-Path $root "current"
$backupFile = Join-Path $root "current.anycursor.bak"

if (-not (Test-Path $root)) { throw "Cursor agent harness directory not found: $root" }

$versions = Get-ChildItem (Join-Path $root "versions") -Directory -ErrorAction SilentlyContinue |
  Sort-Object CreationTime

if ($List -or (-not $Pin -and -not $Previous -and -not $Restore)) {
  $current = if (Test-Path $currentFile) { (Get-Content $currentFile -Raw).Trim() } else { "" }
  Write-Host "Current harness: $current"
  Write-Host ""
  foreach ($version in $versions) {
    $mark = if ($version.Name -eq $current) { "  <- current" } else { "" }
    Write-Host ("{0}  {1}  {2}{3}" -f $version.Name.Substring(0, 12), $version.CreationTime.ToString("yyyy-MM-dd HH:mm:ss"), $version.Name, $mark)
  }
  Write-Host ""
  Write-Host "Use -Previous to pin the version before the current one, or -Pin <hash prefix>."
  return
}

if (-not (Test-Path $backupFile) -and (Test-Path $currentFile)) {
  Copy-Item $currentFile $backupFile
  Write-Host "Backed up current pointer to $backupFile"
}

if ($Restore) {
  if (-not (Test-Path $backupFile)) { throw "No backup found: $backupFile" }
  Copy-Item $backupFile $currentFile -Force
  Write-Host "Restored harness pointer: $((Get-Content $currentFile -Raw).Trim())"
  return
}

$current = if (Test-Path $currentFile) { (Get-Content $currentFile -Raw).Trim() } else { "" }
$target = $null

if ($Previous) {
  $index = -1
  for ($i = 0; $i -lt $versions.Count; $i++) {
    if ($versions[$i].Name -eq $current) { $index = $i; break }
  }
  if ($index -lt 1) { throw "No previous harness version before the current one." }
  $target = $versions[$index - 1]
} elseif ($Pin) {
  $target = $versions | Where-Object { $_.Name.StartsWith($Pin, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  if (-not $target) { throw "No harness version starts with '$Pin'." }
} else {
  throw "Choose -Previous, -Pin <hash prefix>, -Restore or -List."
}

Set-Content -Path $currentFile -Value $target.Name -Encoding ASCII
Write-Host "Pinned agent harness to $($target.Name.Substring(0, 12)) ($($target.CreationTime))" -ForegroundColor Green
Write-Host "Fully quit and reopen Cursor for the harness change to load."
