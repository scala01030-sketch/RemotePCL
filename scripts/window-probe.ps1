param(
    [ValidateSet('List', 'Watch')][string]$Action = 'List',
    [switch]$IncludeAll,
    [UInt64]$Hwnd = 0,
    [int]$TargetPid = 0,
    [Int64]$StartTimeUtcTicks = 0,
    [int]$Width = 0,
    [int]$Height = 0
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowProbeNative {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    public static IntPtr[] Enumerate() {
        var result = new List<IntPtr>();
        EnumWindows((h, l) => { result.Add(h); return true; }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@

function Get-WindowInfo([IntPtr]$Handle) {
    if (-not [WindowProbeNative]::IsWindow($Handle)) { return $null }
    [uint32]$ownerPid = 0
    [void][WindowProbeNative]::GetWindowThreadProcessId($Handle, [ref]$ownerPid)
    try { $process = Get-Process -Id $ownerPid -ErrorAction Stop } catch { return $null }
    $titleBuffer = [Text.StringBuilder]::new(2048)
    [void][WindowProbeNative]::GetWindowText($Handle, $titleBuffer, $titleBuffer.Capacity)
    $rect = [WindowProbeNative+RECT]::new()
    [void][WindowProbeNative]::GetClientRect($Handle, [ref]$rect)
    $dpi = [WindowProbeNative]::GetDpiForWindow($Handle)
    if ($dpi -le 0) { $dpi = 96 }
    $clientWidth = $rect.Right - $rect.Left
    $clientHeight = $rect.Bottom - $rect.Top
    try {
        $startUtc = $process.StartTime.ToUniversalTime()
    } catch {
        return $null
    }
    [pscustomobject]@{
        pid = [int]$ownerPid
        hwnd = $Handle.ToInt64().ToString()
        hwndHex = ('0x{0:X}' -f $Handle.ToInt64())
        processName = $process.ProcessName
        title = $titleBuffer.ToString()
        width = $clientWidth
        height = $clientHeight
        captureWidth = [Math]::Round($clientWidth * $dpi / 96.0)
        captureHeight = [Math]::Round($clientHeight * $dpi / 96.0)
        dpi = $dpi
        startTimeUtc = $startUtc.ToString('o')
        # JSON numbers cannot preserve all Int64 tick values in JavaScript.
        startTimeUtcTicks = $startUtc.Ticks.ToString()
        executablePath = $(try { $process.Path } catch { $null })
    }
}

if ($Action -eq 'List') {
    $handles = [Collections.Generic.List[IntPtr]]::new()
    foreach ($handle in [WindowProbeNative]::Enumerate()) { $handles.Add($handle) }
    if (-not $IncludeAll) {
        foreach ($javaProcess in Get-Process -Name java, javaw -ErrorAction SilentlyContinue) {
            if ($javaProcess.MainWindowHandle -ne 0) { $handles.Add([IntPtr]::new([Int64]$javaProcess.MainWindowHandle)) }
        }
    }
    $seenHandles = [Collections.Generic.HashSet[Int64]]::new()
    $items = foreach ($handle in $handles) {
        if (-not $seenHandles.Add($handle.ToInt64())) { continue }
        $isVisible = [WindowProbeNative]::IsWindowVisible($handle)
        $item = Get-WindowInfo $handle
        if ($null -eq $item -or [string]::IsNullOrWhiteSpace($item.title) -or $item.width -le 0 -or $item.height -le 0) { continue }
        if (-not $IncludeAll -and $item.processName -notin @('java', 'javaw')) { continue }
        if (-not $IncludeAll -and $item.title -match '^(__wglDummyWindowFodder|NVOGLDC invisible)$') { continue }
        # Exclusive/borderless fullscreen Java windows can temporarily report
        # IsWindowVisible=false even though their main HWND remains capturable.
        # Keep the visibility restriction for diagnostic all-window scans, but
        # trust the explicit Java process/title/client-size checks for Minecraft.
        if ($IncludeAll -and -not $isVisible) { continue }
        $item
    }
    @($items) | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

$handle = [IntPtr]::new([Int64]$Hwnd)
while ($true) {
    if (-not [WindowProbeNative]::IsWindow($handle)) { exit 20 }
    [uint32]$currentPid = 0
    [void][WindowProbeNative]::GetWindowThreadProcessId($handle, [ref]$currentPid)
    if ($currentPid -ne $TargetPid) { exit 20 }
    try {
        $process = Get-Process -Id $TargetPid -ErrorAction Stop
        if ($process.StartTime.ToUniversalTime().Ticks -ne $StartTimeUtcTicks) { exit 20 }
    } catch { exit 20 }
    $rect = [WindowProbeNative+RECT]::new()
    if (-not [WindowProbeNative]::GetClientRect($handle, [ref]$rect)) { exit 20 }
    if (($rect.Right - $rect.Left) -ne $Width -or ($rect.Bottom - $rect.Top) -ne $Height) { exit 21 }
    Start-Sleep -Milliseconds 500
}
