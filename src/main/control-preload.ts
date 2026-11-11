import { contextBridge, ipcRenderer } from "electron";

export interface ControlStatus {
  paused: boolean;
  images: number;
  idle: string;
  idleThresholdSec: number;
  cooldownSec: number;
  displaySec: number;
  suppress: boolean;
  startAtLogin: boolean;
}

contextBridge.exposeInMainWorld("control", {
  status: () => ipcRenderer.invoke("control-status") as Promise<ControlStatus>,
  togglePause: () => ipcRenderer.invoke("control-toggle-pause") as Promise<ControlStatus>,
  toggleAutoStart: () => ipcRenderer.invoke("control-toggle-autostart") as Promise<ControlStatus>,
  showNow: () => ipcRenderer.send("control-show"),
  quit: () => ipcRenderer.send("control-quit"),
});
