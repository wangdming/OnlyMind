<#
  Remove the OnlyMind Windows Scheduled Task.
  Usage: .\scripts\autostart-uninstall.ps1
#>
$ErrorActionPreference = "SilentlyContinue"
$TaskName = "OnlyMind"
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "OK Removed scheduled task '$TaskName' (if it existed)."
Write-Host "   You may also clear ONLYMIND_TOKEN/ONLYMIND_PORT from your User environment variables."
