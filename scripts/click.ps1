<#
.SYNOPSIS
  Click at screen coordinates. Use -FromImage with coordinates read from a
  screenshot.ps1 image (they are scaled back to real screen pixels).
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\click.ps1 -X 640 -Y 1050 -FromImage
#>
param([Parameter(Mandatory = $true)][int]$X, [Parameter(Mandatory = $true)][int]$Y, [switch]$FromImage, [switch]$Double, [switch]$Right, [int]$MaxWidth = 1600)
. "$PSScriptRoot\win32.ps1"
Add-Type -AssemblyName System.Windows.Forms
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($FromImage) {
  $scale = [Math]::Min(1.0, $MaxWidth / $b.Width)
  $X = [int]($X / $scale) + $b.Left
  $Y = [int]($Y / $scale) + $b.Top
}
[CallClaude.Win]::SetCursorPos($X, $Y) | Out-Null
Start-Sleep -Milliseconds 80
$down = 0x0002; $up = 0x0004
if ($Right) { $down = 0x0008; $up = 0x0010 }
$times = 1; if ($Double) { $times = 2 }
for ($i = 0; $i -lt $times; $i++) {
  [CallClaude.Win]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  [CallClaude.Win]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 90
}
$fg = [CallClaude.Win]::GetForegroundWindow()
[pscustomobject]@{ clicked = "$X,$Y"; foreground = [CallClaude.Win]::Title($fg) } | ConvertTo-Json -Compress
