import { app } from "electron";
import fs from "fs";
import path from "path";

export interface Config {
  idleThresholdSec: number;    // idle time before the popup shows
  cooldownSec: number;         // minimum gap between popups
  displaySec: number;          // auto-close after this long
  maxPerHour: number;          // hard cap, keeps it from becoming a nuisance
  suppressMedia: boolean;      // stay quiet while audio/video is playing
  suppressFullscreen: boolean; // stay quiet while a fullscreen app is focused
  fallbackIntervalSec: number; // used when idle detection is unavailable
  forceSystemIdle: boolean;    // trust Electron's idle counter on Wayland
  startAtLogin: boolean;
}

export const DEFAULTS: Config = {
  idleThresholdSec: 60,
  cooldownSec: 300,
  displaySec: 30,
  maxPerHour: 4,
  suppressMedia: true,
  suppressFullscreen: true,
  fallbackIntervalSec: 1800,
  forceSystemIdle: false,
  startAtLogin: false,
};

const file = () => path.join(app.getPath("userData"), "config.json");

/** Only keep keys the current app understands; retired keys are dropped. */
function knownValues(raw: Record<string, unknown>): Partial<Config> {
  const picked: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULTS) as Array<keyof Config>) {
    const value = raw[key];
    if (typeof value === typeof DEFAULTS[key]) picked[key] = value;
  }
  return picked as Partial<Config>;
}

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Record<string, unknown>;
    const cfg: Config = { ...DEFAULTS, ...knownValues(raw) };
    if (cfg.maxPerHour < 1) cfg.maxPerHour = 1;
    if (cfg.idleThresholdSec < 15) cfg.idleThresholdSec = 15;
    return cfg;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: Config): void {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(cfg, null, 2));
  } catch (err) {
    console.error("Could not save config:", err);
  }
}

export function configPath(): string {
  return file();
}
