import {
  app, BrowserWindow, Menu, Tray, nativeImage, powerMonitor, screen, ipcMain, shell,
} from "electron";
import path from "path";
import fs from "fs";
import { configPath, loadConfig, saveConfig, Config } from "./config";
import { createIdleDetector, IdleDetector } from "./idle";
import { createActivityGate, ActivityGate } from "./activity";
import { AssetPicker, createAssetPicker, listImages } from "./content";
import { createPlacer, popupSize } from "./position";
import { setAutoStart } from "./autostart";

const POLL_MS = 5000;
const GRACE_MS = 1500; // ignore input right after the popup appears
const MAX_AGE_MS = 60 * 60 * 1000;

let cfg: Config;
let detector: IdleDetector;
let gate: ActivityGate;
let content: AssetPicker;
let tray: Tray | null = null;
let popup: BrowserWindow | null = null;
let control: BrowserWindow | null = null;
let currentImage: string | null = null;
let paused = false;
let locked = false;
let armed = true;          // re-arms once the user is active again
let lastShown = Date.now(); // don't pop up just because the app (re)started
let recentShows: number[] = [];
let closeTimer: NodeJS.Timeout | null = null;
let inputWatch: NodeJS.Timeout | null = null;
let ticking = false;
let showing = false;

const placer = createPlacer();

// Single instance, and keep running in the tray with no windows. Launching the
// app a second time is also how you get at the controls on desktops where the
// tray icon is hidden (GNOME without the AppIndicator extension).
const gotLock = app.requestSingleInstanceLock();
app.on("window-all-closed", () => { /* stay alive in the background */ });

function appPath(...p: string[]) {
  return path.join(app.getAppPath(), ...p);
}

/** Console plus a small file, so a tray-only app can be diagnosed later. */
function log(message: string): void {
  console.log(message);
  try {
    const file = path.join(app.getPath("userData"), "idle-popup.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.unlinkSync(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging must never break the app */ }
}

/**
 * The tray icon is app branding, not content. It deliberately lives outside
 * assets/ so pictures dropped there can never become the tray icon (and this
 * never shows up in the popup deck). Falls back gracefully: a missing icon
 * must not keep the scheduler from running.
 */
function loadTrayImage() {
  for (const file of [appPath("build", "icon.png"), appPath("assets", "tray.png")]) {
    try {
      const image = nativeImage.createFromPath(file);
      if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
    } catch { /* try the next candidate */ }
  }
  return nativeImage.createEmpty();
}

function closePopup() {
  if (closeTimer) clearTimeout(closeTimer);
  if (inputWatch) clearInterval(inputWatch);
  closeTimer = inputWatch = null;
  if (popup && !popup.isDestroyed()) popup.close();
  popup = null;
  currentImage = null;
}

function controlStatus() {
  return {
    paused,
    images: listImages(appPath("assets")).length,
    idle: detector.detail,
    idleThresholdSec: cfg.idleThresholdSec,
    cooldownSec: cfg.cooldownSec,
    displaySec: cfg.displaySec,
    suppress: cfg.suppressMedia && cfg.suppressFullscreen,
    startAtLogin: cfg.startAtLogin,
  };
}

/**
 * A small window with the same actions as the tray menu. It is opened by
 * launching the app again, which is the only way to reach the controls on
 * GNOME installs without the AppIndicator extension (where the tray icon is
 * created but never drawn).
 */
function openControl() {
  if (control && !control.isDestroyed()) {
    control.show();
    control.focus();
    return;
  }
  control = new BrowserWindow({
    width: 400,
    height: 360,
    resizable: false,
    maximizable: false,
    minimizable: false,
    autoHideMenuBar: true,
    title: "Idle Popup",
    backgroundColor: "#10141a",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "control-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  control.on("closed", () => { control = null; });
  control.once("ready-to-show", () => {
    if (control && !control.isDestroyed()) control.show();
  });
  void control.loadFile(appPath("renderer", "control.html"));
}

async function showPopup(manual = false) {
  if (showing || popup || locked) return;
  if (!manual && (paused || !armed)) return;

  showing = true;
  try {
    // Last-moment check: typing or moving the mouse must never be interrupted,
    // so re-read idle time right before the window is created. The scheduler
    // already checked, but this closes the gap if the user came back meanwhile.
    if (!manual) {
      const idle = await detector.getIdleSeconds();
      if (idle !== null && idle < cfg.idleThresholdSec) return;
      if (cfg.suppressMedia && (await gate.isMediaPlaying())) return;
      if (cfg.suppressFullscreen && (await gate.isFullscreen())) return;
    }

    const data = content.next();
    if (!data) return;

    lastShown = Date.now();
    recentShows = recentShows.filter((t) => lastShown - t < MAX_AGE_MS);
    if (!manual) recentShows.push(lastShown);
    armed = false;

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = popupSize(display.workArea);
    const spot = placer.next(display.workArea, size, screen.getCursorScreenPoint());

    popup = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: spot.x,
      y: spot.y,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      show: false,
      backgroundColor: "#10141a",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    try {
      popup.setAlwaysOnTop(true, "floating");
      popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    } catch { /* not supported on every platform, popup still shows */ }

    popup.on("closed", () => { popup = null; });
    await popup.loadFile(appPath("renderer", "popup.html"));
    currentImage = data.image;
    popup.webContents.send("content", {
      image: data.image,
      displaySec: cfg.displaySec,
    });
    popup.showInactive(); // do not steal keyboard focus from whatever is open
    log(`[idle-popup] showing ${currentImage}`);

    closeTimer = setTimeout(closePopup, cfg.displaySec * 1000);

    // Any real keyboard or mouse activity resets the OS idle time to ~0.
    if (detector.mode === "system") {
      const shownAt = Date.now();
      let checking = false;
      inputWatch = setInterval(async () => {
        if (checking || Date.now() - shownAt < GRACE_MS) return;
        checking = true;
        try {
          const idle = await detector.getIdleSeconds();
          if (idle !== null && idle < 1) closePopup();
        } finally {
          checking = false;
        }
      }, 500);
    }
  } finally {
    showing = false;
  }
}

function rateLimited(now: number): boolean {
  recentShows = recentShows.filter((t) => now - t < MAX_AGE_MS);
  return recentShows.length >= Math.max(1, cfg.maxPerHour);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!cfg || paused || popup) return;

    // The lock/unlock events are not reliable on every Wayland compositor.
    // While we believe the screen is locked, verify it so a missed "unlock"
    // cannot silently disable the popup for the rest of the session.
    if (locked) {
      const actuallyLocked = await gate.isScreenLocked();
      if (actuallyLocked !== false) return;
      locked = false;
      armed = false;
      log("[idle-popup] screen unlock detected, resuming");
    }

    const now = Date.now();
    if (now - lastShown < cfg.cooldownSec * 1000) return;
    if (rateLimited(now)) return;

    const idle = await detector.getIdleSeconds();

    if (idle === null) {
      // No idle signal at all: fall back to a slow fixed interval.
      if ((now - lastShown) / 1000 >= cfg.fallbackIntervalSec) await showPopup();
      return;
    }

    if (idle < cfg.idleThresholdSec) {
      armed = true; // user is back; next distraction may earn a popup
      return;
    }
    if (!armed) return;

    // Idle does not mean free: watching a video or a fullscreen app also
    // produces no input. Stay away in those cases.
    if (cfg.suppressMedia && await gate.isMediaPlaying()) return;
    if (cfg.suppressFullscreen && await gate.isFullscreen()) return;

    await showPopup();
  } finally {
    ticking = false;
  }
}

function update(patch: Partial<Config>) {
  cfg = { ...cfg, ...patch };
  saveConfig(cfg);
  buildMenu();
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec} seconds`;
  return `${Math.round(sec / 60)} minute${sec >= 120 ? "s" : ""}`;
}

function buildMenu() {
  if (!tray) return;

  const idleChoice = (sec: number) => ({
    label: formatSeconds(sec),
    type: "radio" as const,
    checked: cfg.idleThresholdSec === sec,
    click: () => update({ idleThresholdSec: sec }),
  });

  const cooldownChoice = (sec: number) => ({
    label: formatSeconds(sec),
    type: "radio" as const,
    checked: cfg.cooldownSec === sec,
    click: () => update({ cooldownSec: sec }),
  });

  const displayChoice = (sec: number) => ({
    label: formatSeconds(sec),
    type: "radio" as const,
    checked: cfg.displaySec === sec,
    click: () => update({ displaySec: sec }),
  });

  const imageCount = listImages(appPath("assets")).length;

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show now", click: () => { armed = false; void showPopup(true); } },
    {
      label: paused ? "Resume" : "Pause",
      click: () => { paused = !paused; buildMenu(); },
    },
    { type: "separator" },
    { label: "Show after idle for", submenu: [30, 60, 120, 300, 600].map(idleChoice) },
    { label: "At most once every", submenu: [120, 300, 600, 1800].map(cooldownChoice) },
    { label: "Show each image for", submenu: [15, 30, 45, 60].map(displayChoice) },
    {
      label: "Stay quiet during video and fullscreen",
      type: "checkbox",
      checked: cfg.suppressMedia && cfg.suppressFullscreen,
      click: (item) => update({ suppressMedia: item.checked, suppressFullscreen: item.checked }),
    },
    {
      label: "Start at login",
      type: "checkbox",
      checked: cfg.startAtLogin,
      click: (item) => { setAutoStart(item.checked); update({ startAtLogin: item.checked }); },
    },
    { type: "separator" },
    { label: `Images in assets: ${imageCount}`, enabled: false },
    { label: `Idle detection: ${detector.detail}`, enabled: false },
    { label: "Open config folder", click: () => void shell.showItemInFolder(configPath()) },
    { label: "Quit", click: () => app.quit() },
  ]));
}

if (!gotLock) {
  // A previous instance owns the scheduler. `pnpm start` would otherwise look
  // like it instantly exited with nothing happening.
  log("[idle-popup] already running; opening its controls");
  app.quit();
} else {
  app.on("second-instance", () => {
    log("[idle-popup] already running; opening controls");
    if (app.isReady()) openControl();
    else app.once("ready", openControl);
  });

  app.whenReady().then(async () => {
    if (process.platform === "darwin") app.dock?.hide();
    if (process.platform === "win32") app.setAppUserModelId("com.example.idlepopup");

    cfg = loadConfig();
    saveConfig(cfg); // creates config.json on first run and drops retired keys
    detector = await createIdleDetector(cfg);
    gate = createActivityGate();
    content = createAssetPicker(appPath("assets"));
    lastShown = Date.now(); // do not greet the user the instant they launch the app

    const icon = loadTrayImage();
    try {
      tray = new Tray(icon);
      tray.setToolTip("Idle Popup");
      buildMenu();
    } catch (err) {
      // No tray on this desktop: keep the idle scheduler alive anyway.
      log(`[idle-popup] tray unavailable: ${err}`);
    }

    ipcMain.on("dismiss", closePopup);
    ipcMain.on("image-failed", () => {
      if (!popup || !currentImage) return;
      log(`[idle-popup] skipping unreadable image: ${currentImage}`);
      content.skip(currentImage);
      closePopup();
    });
    ipcMain.handle("control-status", () => controlStatus());
    ipcMain.handle("control-toggle-pause", () => {
      paused = !paused;
      buildMenu();
      return controlStatus();
    });
    ipcMain.handle("control-toggle-autostart", () => {
      setAutoStart(!cfg.startAtLogin);
      update({ startAtLogin: !cfg.startAtLogin });
      return controlStatus();
    });
    ipcMain.on("control-show", () => {
      if (control && !control.isDestroyed()) control.close();
      void showPopup(true);
    });
    ipcMain.on("control-quit", () => app.quit());
    powerMonitor.on("lock-screen", () => { locked = true; closePopup(); });
    powerMonitor.on("unlock-screen", () => { locked = false; armed = false; });
    powerMonitor.on("suspend", () => { locked = true; closePopup(); });
    powerMonitor.on("resume", () => { locked = false; armed = false; });

    const imageCount = listImages(appPath("assets")).length;
    log(
      `[idle-popup] running: ${imageCount} image(s), ${detector.detail}, ` +
      `idle ${cfg.idleThresholdSec}s, at most once every ${cfg.cooldownSec}s`
    );
    if (imageCount === 0) {
      log(`[idle-popup] no images in ${appPath("assets")}; the popup will not open`);
    }

    setInterval(tick, POLL_MS);

    // Checks are async; run one immediately so status is fresh in the tray.
    void tick();
  });
}
