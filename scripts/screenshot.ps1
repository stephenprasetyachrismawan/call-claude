<#
.SYNOPSIS
  Save a screenshot of the whole screen (all monitors) to a PNG and print its path.
  Read the PNG afterwards to see what is really on screen.
#>
param([string]$Path = (Join-Path $env:TEMP 'call-claude-screen.png'), [int]$MaxWidth = 1600)
. "$PSScriptRoot\win32.ps1"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$scale = [Math]::Min(1.0, $MaxWidth / $b.Width)
if ($scale -lt 1.0) {
  $small = New-Object System.Drawing.Bitmap ([int]($b.Width * $scale)), ([int]($b.Height * $scale))
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = 'HighQualityBicubic'
  $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
  $bmp.Dispose(); $bmp = $small
}
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
[pscustomobject]@{ path = $Path; screenWidth = $b.Width; screenHeight = $b.Height; imageWidth = $bmp.Width; imageHeight = $bmp.Height; scale = $scale } | ConvertTo-Json -Compress
