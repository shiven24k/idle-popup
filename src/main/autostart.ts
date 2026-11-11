import { app } from "electron";
import fs from "fs";
import os from "os";
import path from "path";

const DESKTOP_FILE = path.join(os.homedir(), ".config", "autostart", "idle-popup.desktop");

/** Windows and macOS use Electron's login item API. Linux needs an XDG autostart file. */
export function setAutoStart(enabled: boolean): void {
  try {
    if (process.platform === "linux") {
      if (enabled) {
        // Packaged builds point at the executable; running from source needs
        // the app directory too, otherwise Electron starts with no app.
        const exec = process.env.APPIMAGE
          ? `"${process.env.APPIMAGE}"`
          : app.isPackaged
            ? `"${process.execPath}"`
            : `"${process.execPath}" "${app.getAppPath()}"`;
        fs.mkdirSync(path.dirname(DESKTOP_FILE), { recursive: true });
        fs.writeFileSync(
          DESKTOP_FILE,
          `[Desktop Entry]\nType=Application\nName=Idle Popup\nExec=${exec}\nX-GNOME-Autostart-enabled=true\n`
        );
      } else if (fs.existsSync(DESKTOP_FILE)) {
        fs.unlinkSync(DESKTOP_FILE);
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled });
    }
  } catch (err) {
    console.error("Auto-start change failed:", err);
  }
}
