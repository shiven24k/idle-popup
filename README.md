# Idle Popup

Sits in the system tray. When you have been away from the keyboard for a
minute, it shows a picture from `assets/` in a clear off-centre spot. It
disappears as soon as you touch the mouse or keyboard.

Works on Windows, macOS and Linux from one TypeScript codebase (Electron).

## Run

```bash
pnpm install
pnpm start          # build + launch
```

There is no window when it starts; it waits in the background. To try it
immediately, run the app a second time (`pnpm start` again) and press
**Show now** in the controls that appear.

```bash
pnpm build          # type-check only
pnpm dist           # package for the current OS -> release/
pnpm dist:linux     # Linux .AppImage -> release/
pnpm dist:win:docker # Windows .exe from Linux (Docker + Wine; see below)
```

## Build installers

| Target | Command | Output |
|---|---|---|
| Linux | `pnpm dist:linux` | `release/Idle Popup-1.0.0.AppImage` |
| Windows (on Windows) | `pnpm dist:win` | `release/Idle Popup Setup 1.0.0.exe` + portable `.exe` |
| Windows (on Linux) | `pnpm dist:win:docker` | same two `.exe` files |
| macOS | `pnpm dist:mac` (on macOS) | `release/Idle Popup-1.0.0.dmg` |

`dist:win:docker` needs Docker and pulls the official
`electronuserland/builder:wine` image once; Wine then stamps the executable
inside that container, so nothing is installed on the host. The script handles
SELinux desktops (Fedora) automatically.

The AppImage includes the app icon and all files in `assets/`. On a desktop
without FUSE you can still run it with
`./"Idle Popup-1.0.0.AppImage" --appimage-extract-and-run`.

## Controls

- **With a tray icon:** click it for Show now, Pause, timings, start-at-login
  and Quit.
- **Without a tray icon** (GNOME only shows tray icons with the AppIndicator
  extension): run the app again. The already-running instance opens a small
  control window with the same main actions. Closing that window leaves the
  app running; run it again to reopen the controls.

Only one instance ever runs: a second launch never starts a duplicate
scheduler.

## Popup behaviour

Designed to be easy to ignore:

- **Wait for real idle.** Default 60 s without keyboard/mouse input. Every
  keystroke or mouse move resets the timer, so it never opens while you are
  typing or working. Tray menu: 30 s, 1, 2, 5 or 10 minutes.
- **Stay quiet during playback and fullscreen.** While audio/video is playing
  (MPRIS and GNOME session inhibitors on Linux, Windows media sessions, macOS
  display-sleep assertions) or a fullscreen app is focused, the popup stays
  away. Toggle in the tray menu.
- **At most one per distraction.** Once it closes, it will not appear again
  until you have been active and then idle again.
- **Rate limited.** Defaults: 5 minute cooldown and at most 4 per hour. Both are
  configurable in `config.json`.
- **Easy to read.** Each image stays for 30 seconds by default (15–60 in the
  tray menu) with a slow progress line along the bottom.
- **Large but not a takeover.** The window is square, roughly 36% of the screen
  width and 48% of its height, clamped between 380 and 780 px, and is placed in
  one of eight off-centre zones. A shuffled bag cycles through the zones so it
  does not keep landing in the same corner, and it avoids appearing under the
  mouse pointer.
- **Leave on input.** Moving the mouse, pressing a key, clicking or pressing
  Escape closes it.
- **Recovers from a missed unlock.** If the desktop fails to report the screen
  unlocking, the next check asks the screen saver service and resumes on its
  own instead of staying silent forever.

Idle detection is native on Windows (`powerMonitor`), macOS and Linux/X11. On
GNOME/Wayland it reads the real idle time from Mutter over D-Bus, and on KDE it
uses the screen saver service; Electron's own counter is broken on Wayland
there.

## Images

The popup only shows files that ship with the app. Drop them anywhere under
`assets/` (for example `assets/images/`):

```text
assets/
  images/
    sunrise.jpg
    dusk.png
    poster.webp
```

- Formats: `svg`, `png`, `jpg`, `jpeg`, `jpe`, `jfif`, `webp`, `gif`, `avif`,
  `bmp`, `ico` (case-insensitive). Other formats are ignored. A file that turns
  out to be corrupt or mislabeled is skipped for the rest of the session.
- The tray icon is `build/icon.png`, outside `assets/`, so every file you drop
  in is content.
- Files are used **as they are** and sent to the renderer as plain `file://`
  URLs. Nothing is copied, re-encoded or base64-encoded, so a popup costs
  almost no CPU or memory. Images are shown uncropped (`object-fit: contain`).
- New files are picked up on the next popup; no restart needed.
- Order is a shuffled bag: every image appears once before any repeats, and the
  same image never lands twice in a row.

If `assets/` has no images the popup simply does not open.

## Settings file

`config.json` lives in the app's user-data folder (`~/.config/idle-popup/` on
Linux). Tray changes are written here.

| Key | Default | Meaning |
|---|---|---|
| `idleThresholdSec` | 60 | Idle time before the popup shows |
| `cooldownSec` | 300 | Minimum gap between popups |
| `displaySec` | 30 | How long each image stays on screen |
| `maxPerHour` | 4 | Hard cap per rolling hour |
| `suppressMedia` | `true` | No popup while audio/video plays |
| `suppressFullscreen` | `true` | No popup while a fullscreen app is focused |
| `fallbackIntervalSec` | 1800 | Interval only if idle detection is unavailable |
| `startAtLogin` | `false` | Launch at login |

Retired keys from older builds are dropped the next time the app saves the
file.

## Testing without waiting

```bash
IDLE_POPUP_FAKE_IDLE=600 pnpm start
```

pretends the machine has been idle for 10 minutes. The popup still respects the
cooldown, so keep `cooldownSec` small (or set it to `15`) while testing.

## Notes

- **Linux tray:** GNOME needs the AppIndicator extension to show tray icons.
  Without it, run the app again to open the controls (see above).
- **Terminal:** if you start it with `pnpm start`, keep that terminal open or
  install the packaged app; closing the terminal ends the process.
- **Wayland:** fullscreen detection is best effort (XWayland windows only);
  media playback is covered by MPRIS and GNOME session inhibitors.
- **Content cache:** `~/.config/idle-popup/content-cache/` may exist from older
  builds. It is unused now and safe to delete.
- **Log:** `~/.config/idle-popup/idle-popup.log` records startup, the image each
  popup shows, skipped files and errors. Useful when nothing seems to happen.

## Not wired up yet

There are deliberately no quotes or remote image sources. The app only reads
local assets for now; quotes, an API and the R2 bucket come later. The
`scripts/fetch-content.mjs` helper and `.env.example` remain in the repo for
that future pipeline, but the app does not use them.
