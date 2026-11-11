import { run } from "./exec";

/**
 * "Should we keep quiet right now?" probes.
 *
 * Being idle is not the same as being free: a 40 minute video produces no
 * input, and a fullscreen game or presentation also looks idle to the OS. Both
 * must suppress the popup, otherwise it lands on top of what the user is
 * watching.
 *
 * Every probe is best effort. A missing helper or denied permission means "no
 * signal" (false), never a blocked scheduler. Results are cached because a
 * popup check runs every few seconds and spawning PowerShell on every tick
 * would be rude.
 */
export interface ActivityGate {
  isMediaPlaying(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  /** null when the desktop has no way to tell us. */
  isScreenLocked(): Promise<boolean | null>;
}

interface Signals { media: boolean; fullscreen: boolean }

const PROBE_TTL_MS = process.platform === "linux" ? 4000 : process.platform === "win32" ? 12000 : 8000;

const gdbus = (dest: string, objectPath: string, method: string, ...params: string[]) =>
  run("gdbus", ["call", "--session", "--dest", dest, "--object-path", objectPath, "--method", method, ...params], 1800);

/* ------------------------------------------------------------------ media */

async function linuxMedia(): Promise<boolean> {
  // 1. playerctl, when installed, is the cheapest and most accurate check.
  const playerctl = await run("playerctl", ["--all-players", "status"], 1200);
  if (playerctl !== null) return /\bplaying\b/i.test(playerctl);

  // 2. Otherwise ask every MPRIS player directly.
  const names = await run(
    "gdbus",
    ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus",
      "--method", "org.freedesktop.DBus.ListNames"],
    1500
  );
  if (names) {
    const players = [...new Set(names.match(/org\.mpris\.MediaPlayer2\.[A-Za-z0-9_.\-]+/g) ?? [])].slice(0, 8);
    const states = await Promise.all(
      players.map((name) =>
        gdbus(name, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties.Get",
          "org.mpris.MediaPlayer2.Player", "PlaybackStatus")
      )
    );
    if (states.some((state) => state && /'Playing'/.test(state))) return true;
  }

  // 3. GNOME session inhibitors: video players and browsers raise an idle
  //    inhibitor during playback. This also catches native-Wayland apps that
  //    MPRIS does not expose.
  const inhibited = await gdbus(
    "org.gnome.SessionManager", "/org/gnome/SessionManager",
    "org.gnome.SessionManager.IsInhibited", "8"
  );
  return !!inhibited && /\(true,?\)/.test(inhibited);
}

async function macMedia(): Promise<boolean> {
  // Apps playing video (or holding the display awake for playback) raise a
  // display-sleep assertion. Audio-only playback raises the system variant,
  // which we ignore: background music should not block a break.
  const out = await run("pmset", ["-g", "assertions"], 2000);
  return !!out && /PreventUserIdleDisplaySleep\s+1\b/.test(out);
}

/* -------------------------------------------------------------- fullscreen */

async function linuxFullscreen(): Promise<boolean> {
  if (!process.env.DISPLAY) return false;
  const active = await run("xprop", ["-root", "-notype", "_NET_ACTIVE_WINDOW"], 1000);
  const id = active?.match(/0x[0-9a-f]+/i)?.[0];
  if (!id || /^0x0+$/i.test(id)) return false;
  const state = await run("xprop", ["-id", id, "-notype", "_NET_WM_STATE"], 1000);
  return !!state && state.includes("_NET_WM_STATE_FULLSCREEN");
}

async function macFullscreen(): Promise<boolean> {
  const script = `
tell application "Finder" to set d to bounds of window of desktop
tell application "System Events" to set p to first process whose frontmost is true
tell application "System Events" to tell p to set b to size of window 1
return (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of d) & "," & (item 4 of d)
`;
  const out = await run("osascript", ["-e", script], 2500);
  const m = out?.match(/(\d+),(\d+),(\d+),(\d+)/);
  if (!m) return false;
  const [, w, h, dw, dh] = m.map(Number);
  return w >= dw * 0.97 && h >= dh * 0.97;
}

/* --------------------------------------------------------------- windows */

const WINDOWS_PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(2500)) { throw 'timeout' }
  $task.Result
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IdlePopupWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
}
"@

$state = 0
[IdlePopupWin]::SHQueryUserNotificationState([ref]$state) | Out-Null
$handle = [IdlePopupWin]::GetForegroundWindow()
$fullscreen = $false
if ($handle -ne [IdlePopupWin]::GetShellWindow() -and $handle -ne [IdlePopupWin]::GetDesktopWindow()) {
  $rect = New-Object IdlePopupWin+RECT
  [IdlePopupWin]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $screenW = [IdlePopupWin]::GetSystemMetrics(0)
  $screenH = [IdlePopupWin]::GetSystemMetrics(1)
  $covers = ($rect.Left -le 0 -and $rect.Top -le 0 -and $rect.Right -ge $screenW -and $rect.Bottom -ge $screenH)
  if ($state -eq 3 -or $state -eq 4 -or $covers) { $fullscreen = $true }
}

$playing = $false
try {
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) $managerType
  foreach ($session in $manager.GetSessions()) {
    if ($session.GetPlaybackInfo().PlaybackStatus -eq 4) { $playing = $true }
  }
} catch { }

$mediaToken = if ($playing) { 'PLAYING' } else { 'IDLE' }
$screenToken = if ($fullscreen) { 'FULLSCREEN' } else { 'WINDOWED' }
Write-Output ("{0}|{1}" -f $mediaToken, $screenToken)
`;

async function windowsSignals(): Promise<Signals> {
  const out = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE], 8000);
  if (!out) return { media: false, fullscreen: false };
  return { media: out.includes("PLAYING"), fullscreen: out.includes("FULLSCREEN") };
}

/* ------------------------------------------------------------- lock screen */

async function linuxLocked(): Promise<boolean | null> {
  // KDE (and others) implement the freedesktop interface; GNOME uses its own
  // name. Polled only while we already believe the screen is locked.
  const candidates: Array<[string, string, string]> = [
    ["org.freedesktop.ScreenSaver", "/ScreenSaver", "org.freedesktop.ScreenSaver.GetActive"],
    ["org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver.GetActive"],
  ];
  for (const [dest, objectPath, method] of candidates) {
    const out = await gdbus(dest, objectPath, method);
    if (out) return /\(true,?\)/.test(out);
  }
  return null;
}

/* ------------------------------------------------------------------ gate */

async function probe(): Promise<Signals> {
  if (process.platform === "win32") return windowsSignals();
  if (process.platform === "darwin") {
    const [media, fullscreen] = await Promise.all([macMedia(), macFullscreen()]);
    return { media, fullscreen };
  }
  const [media, fullscreen] = await Promise.all([linuxMedia(), linuxFullscreen()]);
  return { media, fullscreen };
}

export function createActivityGate(): ActivityGate {
  let at = 0;
  let value: Signals = { media: false, fullscreen: false };
  let pending: Promise<Signals> | null = null;

  function signals(): Promise<Signals> {
    const now = Date.now();
    if (now - at < PROBE_TTL_MS) return Promise.resolve(value);
    if (pending) return pending;
    pending = probe()
      .catch(() => ({ media: false, fullscreen: false }))
      .then((next) => {
        value = next;
        at = Date.now();
        return next;
      })
      .finally(() => { pending = null; });
    return pending;
  }

  return {
    isMediaPlaying: async () => (await signals()).media,
    isFullscreen: async () => (await signals()).fullscreen,
    isScreenLocked: async () => (process.platform === "linux" ? linuxLocked() : null),
  };
}
