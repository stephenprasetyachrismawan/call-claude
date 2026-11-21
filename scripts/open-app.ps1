<#
.SYNOPSIS
  Open an app (or bring it to the front) and VERIFY its window is really visible
  and in the foreground. Prints a JSON result. Exit code 0 = visible, 1 = not.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\open-app.ps1 -Name WhatsApp
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\open-app.ps1 -Name Chrome -Launch chrome
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,   # part of the window title / process / Start menu name
  [string]$Launch = '',                          # optional explicit command, exe path or URL
  [int]$TimeoutSec = 20
)
$ErrorActionPreference = 'SilentlyContinue'
. "$PSScriptRoot\win32.ps1"

function Find-Window {
  Get-AppWindows $Name | Sort-Object Minimized | Select-Object -First 1
}

$win = Find-Window
$launched = $false
if (-not $win) {
  if ($Launch) {
    Start-Process $Launch
  } else {
    # Start menu entry (works for Store apps such as WhatsApp, and for Word, Chrome, ...)
    $app = Get-StartApps | Where-Object { $_.Name -like "*$Name*" } | Select-Object -First 1
    if ($app) { Start-Process "shell:AppsFolder\$($app.AppID)" }
    else { Start-Process $Name }
  }
  $launched = $true
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while (-not $win -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    $win = Find-Window
  }
}

if (-not $win) {
  [pscustomobject]@{ ok = $false; name = $Name; launched = $launched; reason = 'Jendela tidak muncul. Ambil screenshot lalu klik ikonnya di taskbar.' } | ConvertTo-Json -Compress
  exit 1
}

$focused = $false
for ($i = 0; $i -lt 5 -and -not $focused; $i++) {
  $focused = [CallClaude.Win]::Focus($win.Handle)
  if (-not $focused) { Start-Sleep -Milliseconds 300 }
}
$fg = [CallClaude.Win]::GetForegroundWindow()
$result = [pscustomobject]@{
  ok         = ($fg -eq $win.Handle)
  name       = $Name
  title      = $win.Title
  process    = $win.Process
  launched   = $launched
  minimized  = [CallClaude.Win]::IsIconic($win.Handle)
  foreground = [CallClaude.Win]::Title($fg)
}
$result | ConvertTo-Json -Compress
if ($result.ok) { exit 0 } else { exit 1 }
