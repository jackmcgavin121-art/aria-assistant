// ARIA — Electron main process.
// Owns: window lifecycle, on-disk persistence (userData), encrypted secrets
// (safeStorage), and all outbound network calls (Anthropic streaming + an
// allowlisted fetch proxy) so the renderer never needs CORS workarounds.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, session, screen, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const isDev = !app.isPackaged;
const DEV_URL = "http://127.0.0.1:5173";

// ---------------------------------------------------------------- paths
const userData = () => app.getPath("userData");
const STATE_FILE = () => path.join(userData(), "aria-state.json");
const SECRETS_FILE = () => path.join(userData(), "aria-secrets.json");
const BACKUP_DIR = () => path.join(userData(), "backups");
const WINSTATE_FILE = () => path.join(userData(), "window-state.json");

// ---------------------------------------------------------------- state store
async function readState() {
  try {
    const raw = await fsp.readFile(STATE_FILE(), "utf8");
    return raw;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    // Corrupt/unreadable state: don't overwrite it silently — surface to renderer.
    return { __error: String(e) };
  }
}

// Atomic write: tmp file + rename, so a crash mid-write can't corrupt the store.
async function writeState(json) {
  const file = STATE_FILE();
  const tmp = file + ".tmp";
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, json, "utf8");
  await fsp.rename(tmp, file).catch(async () => {
    // rename over existing can fail on some AV-locked systems; fall back to copy
    await fsp.writeFile(file, json, "utf8");
    await fsp.unlink(tmp).catch(() => {});
  });
  return true;
}

// ---------------------------------------------------------------- auto backups
// Daily rotating snapshot of the state file (keeps the newest 7). Runs shortly
// after launch — capturing the previous session's data — and every 6 hours.
async function runAutoBackup() {
  try {
    const raw = await fsp.readFile(STATE_FILE(), "utf8").catch(() => null);
    if (!raw) return;
    const dir = BACKUP_DIR();
    await fsp.mkdir(dir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `aria-auto-${today}.json`);
    if (!fs.existsSync(file)) await fsp.writeFile(file, raw, "utf8");
    const files = (await fsp.readdir(dir)).filter((f) => /^aria-auto-.*\.json$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 7))) {
      await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch (e) {
    console.warn("[backup]", String(e && e.message ? e.message : e));
  }
}

// ---------------------------------------------------------------- window state
function readWinState() {
  try {
    return JSON.parse(fs.readFileSync(WINSTATE_FILE(), "utf8"));
  } catch {
    return null;
  }
}
function saveWinState(win) {
  try {
    const maximized = win.isMaximized();
    const b = maximized ? win.getNormalBounds() : win.getBounds();
    fs.writeFileSync(WINSTATE_FILE(), JSON.stringify({ ...b, maximized }), "utf8");
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------- secrets
function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE(), "utf8"));
  } catch {
    return {};
  }
}
function writeSecrets(obj) {
  fs.mkdirSync(path.dirname(SECRETS_FILE()), { recursive: true });
  fs.writeFileSync(SECRETS_FILE(), JSON.stringify(obj), "utf8");
}
function setSecret(name, value) {
  const s = readSecrets();
  if (!value) {
    delete s[name];
  } else if (safeStorage.isEncryptionAvailable()) {
    s[name] = { enc: true, v: safeStorage.encryptString(value).toString("base64") };
  } else {
    // No DPAPI available (rare) — store obfuscated, flagged as plaintext.
    s[name] = { enc: false, v: Buffer.from(value, "utf8").toString("base64") };
  }
  writeSecrets(s);
}
function getSecret(name) {
  const rec = readSecrets()[name];
  if (!rec) return null;
  try {
    if (rec.enc) return safeStorage.decryptString(Buffer.from(rec.v, "base64"));
    return Buffer.from(rec.v, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- network
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const PROXY_ALLOWLIST = new Set([
  "r.jina.ai",
  "s.jina.ai",
  "api.search.brave.com",
  "duckduckgo.com",
  "html.duckduckgo.com",
  "api.duckduckgo.com",
]);

const activeStreams = new Map(); // id -> AbortController

function anthropicHeaders(apiKey) {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

async function startAnthropicStream(event, id, payload) {
  const apiKey = getSecret("anthropicApiKey");
  const send = (type, data) => {
    if (!event.sender.isDestroyed()) event.sender.send("api:stream:event", { id, type, data });
  };
  if (!apiKey) {
    send("error", { message: "No API key set. Add your Anthropic API key in Settings → AI & API." });
    return;
  }
  const ac = new AbortController();
  activeStreams.set(id, ac);
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({ ...payload, stream: true }),
      signal: ac.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      send("error", { status: res.status, message: extractApiError(body, res.status) });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      send("chunk", decoder.decode(value, { stream: true }));
    }
    send("done", null);
  } catch (e) {
    if (e.name === "AbortError") send("aborted", null);
    else send("error", { message: String(e && e.message ? e.message : e) });
  } finally {
    activeStreams.delete(id);
  }
}

async function anthropicCall(payload) {
  const apiKey = getSecret("anthropicApiKey");
  if (!apiKey) return { ok: false, error: "No API key set." };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({ ...payload, stream: false }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: extractApiError(text, res.status) };
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

function extractApiError(body, status) {
  try {
    const j = JSON.parse(body);
    if (j.error && j.error.message) return `${j.error.type || status}: ${j.error.message}`;
  } catch {}
  return `API error (HTTP ${status})`;
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle("store:load", () => readState());
  ipcMain.handle("store:save", (_e, json) => writeState(json));
  ipcMain.handle("store:wipe", async () => {
    await fsp.unlink(STATE_FILE()).catch(() => {});
    await fsp.unlink(SECRETS_FILE()).catch(() => {});
    return true;
  });
  ipcMain.handle("store:autoBackup", async (_e, json, label) => {
    const dir = BACKUP_DIR();
    await fsp.mkdir(dir, { recursive: true });
    const name = `aria-backup-${label || "auto"}-${new Date().toISOString().slice(0, 10)}.json`;
    const file = path.join(dir, name);
    await fsp.writeFile(file, json, "utf8");
    return file;
  });
  ipcMain.handle("store:exportBackup", async (e, json, defaultName) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export ARIA data",
      defaultPath: typeof defaultName === "string" && defaultName
        ? defaultName.replace(/[^\w.\- ]+/g, "")
        : `aria-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, json, "utf8");
    return filePath;
  });
  ipcMain.handle("store:importBackup", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Import ARIA backup",
      filters: [{ name: "JSON", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (canceled || !filePaths.length) return null;
    return fsp.readFile(filePaths[0], "utf8");
  });

  ipcMain.handle("secret:set", (_e, name, value) => {
    if (typeof name !== "string") return false;
    setSecret(name, typeof value === "string" ? value : "");
    return true;
  });
  ipcMain.handle("secret:has", (_e, name) => !!getSecret(name));
  // Only a masked preview ever goes back to the renderer.
  ipcMain.handle("secret:preview", (_e, name) => {
    const v = getSecret(name);
    if (!v) return null;
    return v.length <= 8 ? "••••" : `${v.slice(0, 7)}…${v.slice(-4)}`;
  });

  ipcMain.handle("api:stream:start", (e, id, payload) => {
    startAnthropicStream(e, String(id), payload);
    return true;
  });
  ipcMain.handle("api:stream:abort", (_e, id) => {
    const ac = activeStreams.get(String(id));
    if (ac) ac.abort();
    return !!ac;
  });
  ipcMain.handle("api:call", (_e, payload) => anthropicCall(payload));

  ipcMain.handle("net:fetchText", async (_e, url, init) => {
    let host;
    try {
      host = new URL(url).hostname;
    } catch {
      return { ok: false, error: "Invalid URL" };
    }
    if (!PROXY_ALLOWLIST.has(host)) return { ok: false, error: `Host not allowed: ${host}` };
    try {
      // Inject optional research API keys here so the renderer never sees them.
      const headers = { ...((init && init.headers) || {}) };
      if (host === "api.search.brave.com") {
        const k = getSecret("braveApiKey");
        if (k) headers["X-Subscription-Token"] = k;
      }
      if (host === "r.jina.ai" || host === "s.jina.ai") {
        const k = getSecret("jinaApiKey");
        if (k) headers["Authorization"] = "Bearer " + k;
      }
      const res = await fetch(url, {
        method: (init && init.method) || "GET",
        headers,
        body: init && init.body ? init.body : undefined,
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // Optional speech-to-text via OpenAI Whisper (user-supplied key, encrypted like the rest).
  ipcMain.handle("stt:transcribe", async (_e, audioBuffer, mimeType) => {
    const key = getSecret("openaiApiKey");
    if (!key) return { ok: false, error: "No OpenAI API key set (Settings → Voice)." };
    try {
      const form = new FormData();
      const ext = /ogg/.test(mimeType) ? "ogg" : /mp4|m4a/.test(mimeType) ? "m4a" : "webm";
      form.append("file", new Blob([Buffer.from(audioBuffer)], { type: mimeType }), "audio." + ext);
      form.append("model", "whisper-1");
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key },
        body: form,
      });
      const text = await res.text();
      if (!res.ok) return { ok: false, error: `Whisper error (HTTP ${res.status})` };
      return { ok: true, text: JSON.parse(text).text || "" };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("app:setCloseToTray", (_e, on) => {
    closeToTray = !!on;
    return true;
  });
  ipcMain.handle("app:setTrayTooltip", (_e, text) => {
    if (tray) tray.setToolTip(String(text || "ARIA").slice(0, 120));
    return true;
  });

  // Manual "check for updates now" from Settings → About.
  ipcMain.handle("update:check", async () => {
    if (!app.isPackaged) return { ok: false, error: "Update checks only work in the installed app." };
    try {
      const { autoUpdater } = require("electron-updater");
      const r = await autoUpdater.checkForUpdates();
      const latest = r && r.updateInfo ? r.updateInfo.version : null;
      return {
        ok: true,
        current: app.getVersion(),
        latest,
        updateAvailable: !!latest && latest !== app.getVersion(),
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle("app:openBackups", async () => {
    await fsp.mkdir(BACKUP_DIR(), { recursive: true });
    return shell.openPath(BACKUP_DIR());
  });

  // Render a self-contained HTML document to PDF via a hidden window.
  ipcMain.handle("export:pdf", async (e, html, title) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: "Export PDF",
      defaultPath: String(title || "aria-export").replace(/[^\w\- ]+/g, "").trim().slice(0, 40) + ".pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (canceled || !filePath) return null;
    const tmp = path.join(app.getPath("temp"), `aria-print-${Date.now()}.html`);
    const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    try {
      await fsp.writeFile(tmp, String(html), "utf8");
      await printWin.loadFile(tmp);
      const pdf = await printWin.webContents.printToPDF({ printBackground: true });
      await fsp.writeFile(filePath, pdf);
      return filePath;
    } catch (err) {
      return { __error: String(err && err.message ? err.message : err) };
    } finally {
      printWin.destroy();
      fsp.unlink(tmp).catch(() => {});
    }
  });

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: userData(),
    packaged: app.isPackaged,
  }));
  ipcMain.handle("shell:openExternal", (_e, url) => {
    if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url);
  });
}

// ---------------------------------------------------------------- auto-updates
// Uses the GitHub releases feed configured in package.json ("build.publish").
// Fails quietly when offline or when no feed is reachable — never blocks the app.
function setupAutoUpdates(win) {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch {
    return;
  }
  const send = (type, info) => {
    if (!win.isDestroyed()) win.webContents.send("update:event", { type, info });
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => send("available", { version: info.version }));
  autoUpdater.on("update-downloaded", (info) => send("downloaded", { version: info.version }));
  autoUpdater.on("error", (err) => console.warn("[updater]", String(err && err.message ? err.message : err)));
  ipcMain.handle("update:install", () => {
    quitting = true;
    autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000); // don't compete with startup
  setInterval(check, 4 * 3600_000);
}

// ---------------------------------------------------------------- window & tray
let tray = null;
let closeToTray = false;
let quitting = false;

function createTray(win) {
  const icon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.ico"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("ARIA");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open ARIA", click: () => { win.show(); win.focus(); } },
      { type: "separator" },
      { label: "Quit", click: () => { quitting = true; app.quit(); } },
    ])
  );
  tray.on("click", () => {
    win.show();
    win.focus();
  });
}

// A saved position is only reused if it still lands on a connected display
// (monitors get unplugged; never restore the window somewhere invisible).
function savedPositionVisible(b) {
  if (!b || typeof b.x !== "number" || typeof b.y !== "number") return false;
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return (
      b.x < a.x + a.width - 40 &&
      b.x + (b.width || 1360) > a.x + 40 &&
      b.y >= a.y - 10 &&
      b.y < a.y + a.height - 40
    );
  });
}

function createWindow() {
  const saved = readWinState();
  const onScreen = savedPositionVisible(saved);
  const win = new BrowserWindow({
    width: saved?.width || 1360,
    height: saved?.height || 860,
    x: onScreen ? saved.x : undefined,
    y: onScreen ? saved.y : undefined,
    minWidth: 960,
    minHeight: 620,
    title: "ARIA",
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    backgroundColor: "#0e0e12",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Microphone permission for voice features.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "media" || permission === "speaker-selection");
  });

  // Open target=_blank / external links in the OS browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (saved?.maximized) win.maximize();

  // Remember size/position across launches (debounced).
  let winStateTimer;
  const queueSaveWinState = () => {
    clearTimeout(winStateTimer);
    winStateTimer = setTimeout(() => saveWinState(win), 500);
  };
  win.on("resize", queueSaveWinState);
  win.on("move", queueSaveWinState);

  // Close-to-tray (opt-in from Settings): hide instead of quit.
  win.on("close", (e) => {
    saveWinState(win);
    if (closeToTray && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  if (isDev) {
    // Surface renderer console output on stdout during development.
    win.webContents.on("console-message", (ev) => {
      console.log("[renderer]", ev.message);
    });
    win.loadURL(DEV_URL).catch(() => {
      win.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
    });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  }
  return win;
}

// Single instance only: two ARIA processes would fight over aria-state.json.
// A second launch just focuses (or un-trays) the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    const win = createWindow();
    createTray(win);
    setupAutoUpdates(win);
    setTimeout(runAutoBackup, 30_000);
    setInterval(runAutoBackup, 6 * 3600_000);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
