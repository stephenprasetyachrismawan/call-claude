<#
.SYNOPSIS
  Type text (or press keys) into the window that is currently in the foreground.
  Uses SendKeys syntax for -Keys, e.g. "{ENTER}", "^a" (Ctrl+A), "%{F4}" (Alt+F4).
#>
param([string]$Text = '', [string]$Keys = '')
Add-Type -AssemblyName System.Windows.Forms
if ($Text) {
  # Escape SendKeys special characters so the text is typed literally.
  $escaped = [regex]::Replace($Text, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
  [System.Windows.Forms.SendKeys]::SendWait($escaped)
}
if ($Keys) { [System.Windows.Forms.SendKeys]::SendWait($Keys) }
'{"typed":true}'
