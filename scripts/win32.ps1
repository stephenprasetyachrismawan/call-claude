# Shared Win32 helpers for the desktop-control scripts (dot-source this file).
if (-not ('CallClaude.Win' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace CallClaude {
  public static class Win {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    public static List<IntPtr> Windows() {
      var list = new List<IntPtr>();
      EnumWindows((h, l) => { if (IsWindowVisible(h) && Title(h).Length > 0) list.Add(h); return true; }, IntPtr.Zero);
      return list;
    }
    public static bool Focus(IntPtr h) {
      if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
      else ShowWindow(h, 5);             // SW_SHOW
      // Tapping Alt lets this process take the foreground (Windows focus-stealing rule).
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      BringWindowToTop(h);
      SetForegroundWindow(h);
      return GetForegroundWindow() == h;
    }
  }
}
'@
}
[CallClaude.Win]::SetProcessDPIAware() | Out-Null

function Get-AppWindows([string]$Name) {
  $pattern = [regex]::Escape($Name)
  foreach ($h in [CallClaude.Win]::Windows()) {
    $title = [CallClaude.Win]::Title($h)
    $procId = 0; [CallClaude.Win]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $proc = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
    if ($title -match $pattern -or $proc -match $pattern) {
      [pscustomobject]@{ Handle = $h; Title = $title; Process = $proc; Minimized = [CallClaude.Win]::IsIconic($h) }
    }
  }
}
