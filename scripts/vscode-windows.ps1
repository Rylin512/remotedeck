param(
  [ValidateSet("list", "close", "focus")]
  [string]$Action = "list",
  [long]$Hwnd = 0
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RemoteDeckWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@

function Get-CodeWindows {
  $result = New-Object System.Collections.ArrayList
  $seen = New-Object System.Collections.Generic.HashSet[long]
  $callback = {
    param([IntPtr]$handle, [IntPtr]$state)
    if (-not [RemoteDeckWin]::IsWindowVisible($handle)) { return $true }
    $length = [RemoteDeckWin]::GetWindowTextLength($handle)
    if ($length -le 0) { return $true }
    $builder = New-Object System.Text.StringBuilder ($length + 2)
    [void][RemoteDeckWin]::GetWindowText($handle, $builder, $builder.Capacity)
    $title = $builder.ToString().Trim()
    if (-not $title) { return $true }
    [uint32]$ownerPid = 0
    [void][RemoteDeckWin]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
    $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -ne "Code") { return $true }
    $id = $handle.ToInt64()
    if ($seen.Add($id)) {
      [void]$result.Add([pscustomobject]@{
        id = [string]$id
        title = $title
        pid = [int]$ownerPid
      })
    }
    return $true
  }
  [void][RemoteDeckWin]::EnumWindows($callback, [IntPtr]::Zero)
  return @($result.ToArray())
}

if ($Action -eq "list") {
  $windows = Get-CodeWindows
  ConvertTo-Json -InputObject @($windows) -Compress -Depth 4
  exit 0
}

$target = Get-CodeWindows | Where-Object { $_.id -eq [string]$Hwnd } | Select-Object -First 1
if (-not $target) {
  ConvertTo-Json -InputObject @{ ok = $false; reason = "not_found" } -Compress
  exit 0
}

if ($Action -eq "focus") {
  $handle = [IntPtr]::new($Hwnd)
  [void][RemoteDeckWin]::ShowWindow($handle, 9)
  [void][RemoteDeckWin]::SetForegroundWindow($handle)
  ConvertTo-Json -InputObject @{ ok = $true; id = [string]$Hwnd; title = $target.title } -Compress
  exit 0
}

if ($Hwnd -le 0) {
  ConvertTo-Json -InputObject @{ ok = $false; reason = "invalid_hwnd" } -Compress
  exit 1
}

$handle = [IntPtr]::new($Hwnd)
[void][RemoteDeckWin]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$closed = $false
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Milliseconds 250
  if (-not [RemoteDeckWin]::IsWindow($handle)) { $closed = $true; break }
  if (-not [RemoteDeckWin]::IsWindowVisible($handle)) { $closed = $true; break }
}
ConvertTo-Json -InputObject @{
  ok = $true
  closed = $closed
  pending = (-not $closed)
  id = [string]$Hwnd
  title = $target.title
  pid = $target.pid
} -Compress
exit 0
