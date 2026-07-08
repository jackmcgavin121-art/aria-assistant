// Preload: the only surface the renderer gets. Narrow, promise-based, no Node access.
const { contextBridge, ipcRenderer } = require("electron");

let streamSeq = 0;
const streamHandlers = new Map(); // id -> {onChunk,onDone,onError,onAborted}

ipcRenderer.on("api:stream:event", (_e, { id, type, data }) => {
  const h = streamHandlers.get(id);
  if (!h) return;
  if (type === "chunk") h.onChunk && h.onChunk(data);
  else {
    streamHandlers.delete(id);
    if (type === "done") h.onDone && h.onDone();
    else if (type === "aborted") h.onAborted && h.onAborted();
    else if (type === "error") h.onError && h.onError(data);
  }
});

contextBridge.exposeInMainWorld("aria", {
  store: {
    load: () => ipcRenderer.invoke("store:load"),
    save: (json) => ipcRenderer.invoke("store:save", json),
    wipe: () => ipcRenderer.invoke("store:wipe"),
    autoBackup: (json, label) => ipcRenderer.invoke("store:autoBackup", json, label),
    exportBackup: (json, defaultName) => ipcRenderer.invoke("store:exportBackup", json, defaultName),
    importBackup: () => ipcRenderer.invoke("store:importBackup"),
    restoreLatestBackup: () => ipcRenderer.invoke("store:restoreLatestBackup"),
    replaceFromFile: () => ipcRenderer.invoke("store:replaceFromFile"),
  },
  secrets: {
    set: (name, value) => ipcRenderer.invoke("secret:set", name, value),
    has: (name) => ipcRenderer.invoke("secret:has", name),
    preview: (name) => ipcRenderer.invoke("secret:preview", name),
  },
  api: {
    stream: (payload, handlers) => {
      const id = "s" + ++streamSeq;
      streamHandlers.set(id, handlers || {});
      ipcRenderer.invoke("api:stream:start", id, payload);
      return id;
    },
    abort: (id) => {
      streamHandlers.delete(id);
      return ipcRenderer.invoke("api:stream:abort", id);
    },
    call: (payload) => ipcRenderer.invoke("api:call", payload),
  },
  net: {
    fetchText: (url, init) => ipcRenderer.invoke("net:fetchText", url, init),
  },
  stt: {
    transcribe: (audioBuffer, mimeType) => ipcRenderer.invoke("stt:transcribe", audioBuffer, mimeType),
  },
  updates: {
    onEvent: (cb) => {
      ipcRenderer.on("update:event", (_e, payload) => cb(payload));
    },
    install: () => ipcRenderer.invoke("update:install"),
    check: () => ipcRenderer.invoke("update:check"),
  },
  app: {
    info: () => ipcRenderer.invoke("app:info"),
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
    setCloseToTray: (on) => ipcRenderer.invoke("app:setCloseToTray", on),
    setTrayTooltip: (text) => ipcRenderer.invoke("app:setTrayTooltip", text),
    openBackups: () => ipcRenderer.invoke("app:openBackups"),
    exportPdf: (html, title) => ipcRenderer.invoke("export:pdf", html, title),
  },
});
