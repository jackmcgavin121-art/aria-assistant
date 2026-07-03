const { app, BrowserWindow, shell, ipcMain, Menu } = require('electron');
const path = require('path');

// Keep a global reference so the window isn't garbage-collected
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'ARIA — Adaptive Role Intelligence Assistant',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow the app's own fetch calls to reach external APIs
      webSecurity: true,
    },
    backgroundColor: '#ffffff',
    show: false, // reveal after 'ready-to-show' to avoid white flash
  });

  mainWindow.loadFile('index.html');

  // Show once fully rendered
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Smoke-test mode: load the app, hold briefly to surface any startup
    // errors in the console, then quit. Triggered with ARIA_SMOKE=1.
    if (process.env.ARIA_SMOKE) {
      setTimeout(() => {
        console.log('[smoke] startup window shown without crashing — quitting');
        app.quit();
      }, 4000);
    }
  });

  // Forward renderer console messages to the terminal so the app is
  // debuggable from the command line (and so smoke tests can see errors).
  // Electron 42 passes a single event object; older builds passed
  // positional args — handle both.
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => {
    const lvl = (e && typeof e === 'object' && 'level' in e) ? e.level : level;
    const msg = (e && typeof e === 'object' && 'message' in e) ? e.message : message;
    const ln = (e && typeof e === 'object' && 'lineNumber' in e) ? e.lineNumber : line;
    const src = (e && typeof e === 'object' && 'sourceId' in e) ? e.sourceId : sourceId;
    const tag = typeof lvl === 'string' ? lvl : (['log', 'warn', 'error', 'info'][lvl] || 'log');
    const isProblem = tag === 'error' || tag === 'warning' || lvl >= 2;
    console.log(`[renderer:${tag}] ${msg}` + (isProblem ? `  (${src}:${ln})` : ''));
  });

  // Surface renderer crashes / hangs instead of failing silently
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason, details.exitCode);
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[renderer] became unresponsive');
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[renderer] failed to load:', code, desc, url);
  });

  // Open external links in the default browser, not in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Minimal menu so the app stays debuggable after packaging:
// reload, force-reload, toggle DevTools, and zoom controls.
function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [{ role: 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Native networking bridge ──────────────────────────────────────
// The renderer (a sandboxed web page) is subject to CORS. The main
// process is not, so we fetch URLs here on its behalf. Used by the
// Knowledge Hub "Add Website" feature so it can read any site.
ipcMain.handle('aria:fetchUrl', async (_e, url) => {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) ARIA-Desktop/1.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    clearTimeout(timer);
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body,
    };
  } catch (err) {
    return { ok: false, status: 0, contentType: '', body: '', error: String(err.message || err) };
  }
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // On Windows / Linux, quit when all windows are closed
  if (process.platform !== 'darwin') app.quit();
});
