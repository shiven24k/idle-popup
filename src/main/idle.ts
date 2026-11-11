import { powerMonitor } from "electron";
import { run } from "./exec";
import type { Config } from "./config";

/**
 * Seconds since the last real keyboard/mouse input, or null when the platform
 * cannot report it (the scheduler then falls back to a plain timer).
 *
 * Why not just powerMonitor everywhere: on Linux/Wayland Chromium's idle
 * counter frequently stays at 0 forever, which would both never fire and never
 * let us close the popup on input. GNOME's Mutter exposes the real value over
 * D-Bus, so we prefer that.
 */
export interface IdleDetector {
  readonly mode: "system" | "timer";
  readonly detail: string;
  getIdleSeconds(): Promise<number | null>;
}

const GNOME_IDLE_ARGS = [
  "call", "--session",
  "--dest", "org.gnome.Mutter.IdleMonitor",
  "--object-path", "/org/gnome/Mutter/IdleMonitor/Core",
  "--method", "org.gnome.Mutter.IdleMonitor.GetIdletime",
];

const KDE_IDLE_ARGS = [
  "call", "--session",
  "--dest", "org.freedesktop.ScreenSaver",
  "--object-path", "/ScreenSaver",
  "--method", "org.freedesktop.ScreenSaver.GetSessionIdleTime",
];

function isWayland(): boolean {
  return (
    process.platform === "linux" &&
    (process.env.XDG_SESSION_TYPE === "wayland" || !!process.env.WAYLAND_DISPLAY)
  );
}

async function probeGnome(): Promise<boolean> {
  const out = await run("gdbus", GNOME_IDLE_ARGS, 1500);
  return !!out && /uint64\s+\d+/.test(out);
}

async function probeKde(): Promise<boolean> {
  const out = await run("gdbus", KDE_IDLE_ARGS, 1500);
  return !!out && /\b\d+\b/.test(out);
}

async function gnomeSeconds(): Promise<number | null> {
  const out = await run("gdbus", GNOME_IDLE_ARGS, 1500);
  const m = out?.match(/uint64\s+(\d+)/);
  return m ? Number(m[1]) / 1000 : null;
}

async function kdeSeconds(): Promise<number | null> {
  const out = await run("gdbus", KDE_IDLE_ARGS, 1500);
  const m = out?.match(/\((\d+),?\)/);
  if (!m) return null;
  const value = Number(m[1]);
  // KDE reports milliseconds; some other implementations report seconds.
  return value > 86_400 ? value / 1000 : value;
}

function systemSeconds(): number | null {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch {
    return null;
  }
}

export async function createIdleDetector(cfg: Config): Promise<IdleDetector> {
  // Developer escape hatch: pretend the machine has been idle for N seconds.
  //   IDLE_POPUP_FAKE_IDLE=600 pnpm start
  // Useful for checking the popup without waiting a minute.
  const fake = Number(process.env.IDLE_POPUP_FAKE_IDLE);
  if (Number.isFinite(fake) && fake > 0) {
    return {
      mode: "system",
      detail: "forced (IDLE_POPUP_FAKE_IDLE)",
      getIdleSeconds: async () => fake,
    };
  }

  const wayland = isWayland();

  if (process.platform === "linux") {
    // GNOME (X11 or Wayland): Mutter knows the real idle time.
    if (await probeGnome()) {
      return {
        mode: "system",
        detail: "system (Mutter idle monitor)",
        getIdleSeconds: gnomeSeconds,
      };
    }
    // KDE Plasma exposes the same idea through the screen saver service.
    if (wayland && (await probeKde())) {
      return {
        mode: "system",
        detail: "system (KDE screen saver)",
        getIdleSeconds: kdeSeconds,
      };
    }
  }

  // powerMonitor is reliable on Windows, macOS and Linux/X11.
  const works = !(wayland && !cfg.forceSystemIdle) && systemSeconds() !== null;
  if (works) {
    return {
      mode: "system",
      detail: "system (power monitor)",
      getIdleSeconds: async () => systemSeconds(),
    };
  }

  return {
    mode: "timer",
    detail: "timer (idle detection unavailable)",
    getIdleSeconds: async () => null,
  };
}
