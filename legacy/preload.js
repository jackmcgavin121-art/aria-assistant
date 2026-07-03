const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal, safe API surface to the renderer.
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
});

// Native capabilities that the sandboxed web page cannot do itself.
contextBridge.exposeInMainWorld('ariaNative', {
  isDesktop: true,
  // Fetch any URL via the main process (bypasses browser CORS).
  // Returns { ok, status, contentType, body, error? }.
  fetchUrl: (url) => ipcRenderer.invoke('aria:fetchUrl', url),
});
