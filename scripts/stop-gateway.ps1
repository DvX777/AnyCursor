param(
  [int]$Port = 43111
)

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $conn) {
  Write-Host "nothing is listening on port $Port"
  exit 0
}

$pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $pids) {
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  Write-Host "stopped pid $id"
}
