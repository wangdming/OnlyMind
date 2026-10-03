<#
  Install OnlyMind as a Windows Scheduled Task that auto-starts at logon.

  Usage (PowerShell):
    $env:ONLYMIND_TOKEN = "your-strong-token"
    .\scripts\autostart-install.ps1
    # or
    .\scripts\autostart-install.ps1 -Token "your-strong-token" -Port 8787

  A fixed token is REQUIRED: a background task can't show you a random one.
#>
param(
  [string]$Token = $env:ONLYMIND_TOKEN,
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
$TaskName   = "OnlyMind"
$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Node       = (Get-Command node -ErrorAction SilentlyContinue).Source
$Entry      = Join-Path $ProjectDir "src\index.js"

if (-not $Node)  { Write-Error "node not found on PATH." }
if (-not $Token) { Write-Error "Provide a token via -Token or `$env:ONLYMIND_TOKEN." }

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectDir "data") | Out-Null

# Pass env vars through a tiny wrapper so the task runs with the right config.
$argStr = "`"$Entry`""
$action = New-ScheduledTaskAction -Execute $Node -Argument $argStr -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

# Environment variables for the task: set them at user scope so the task inherits them.
[Environment]::SetEnvironmentVariable("ONLYMIND_TOKEN", $Token, "User")
[Environment]::SetEnvironmentVariable("ONLYMIND_PORT",  "$Port", "User")

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "OnlyMind: phone-to-computer task runner for Claude Code / Codex" | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "OK Installed scheduled task '$TaskName'."
Write-Host "   OnlyMind runs on port $Port and auto-starts at logon."
Write-Host "   Uninstall: .\scripts\autostart-uninstall.ps1"
Write-Host "   Note: ONLYMIND_TOKEN/PORT were saved to your User environment variables."
