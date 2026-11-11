import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("popup", {
  onContent: (cb: (data: unknown) => void) =>
    ipcRenderer.on("content", (_e, data) => cb(data)),
  dismiss: () => ipcRenderer.send("dismiss"),
  imageFailed: () => ipcRenderer.send("image-failed"),
});
