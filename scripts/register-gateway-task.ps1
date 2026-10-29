param(
  [string]$TaskName = "AnyCursor Gateway",
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Gateway,
  [Parameter(Mandatory = $true)][string]$Config,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory
)

$ErrorActionPreference = "Stop"

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object System.Security.Principal.WindowsPrincipal($identity)
if (-not $principalCheck.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "This helper must run elevated."
}

$action = New-ScheduledTaskAction -Execute $Node `
  -Argument "`"$Gateway`" --config `"$Config`"" -WorkingDirectory $WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force `
  -Description "Pre-warms the AnyCursor gateway at login." | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Task '$TaskName' registered and started." -ForegroundColor Green
