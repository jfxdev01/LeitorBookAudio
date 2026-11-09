'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, globalShortcut, nativeTheme, screen
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { Library } = require('./library');
const { EdgeTTSService } = require('./edge-tts');
const { Translator } = require('./translator');

const APP_ROOT = path.join(__dirname, '..', '..');
const ALLOWED_DIRS = [
  path.join(APP_ROOT, 'src', 'renderer'),
  path.join(APP_ROOT, 'node_modules', 'pdfjs-dist'),
  path.join(APP_ROOT, 'build')
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.icc': 'application/octet-stream'
};

const isDev = process.argv.includes('--dev');

// Permite apontar a pasta de dados (usado pelos testes automatizados).
const userDataArg = process.argv.find((a) => a.startsWith('--user-data='));
if (userDataArg) app.setPath('userData', userDataArg.slice('--user-data='.length));

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let library = null;
let edge = null;
let translator = null;
let pendingOpenPaths = [];
const exportStreams = new Map();
let exportSeq = 0;

function pdfPathsFromArgv(argv) {
  return argv.slice(1).filter((a) => !a.startsWith('--') && a.toLowerCase().endsWith('.pdf') && fs.existsSync(a));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function openExternalPdfs(paths) {
  if (!paths.length) return;
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingOpenPaths.push(...paths);
    return;
  }
  const result = await library.addFiles(paths);
  sendToRenderer('library:external-open', result);
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let filePath;
      if (url.host === 'local') {
        filePath = path.normalize(path.join(APP_ROOT, rel));
        if (!ALLOWED_DIRS.some((dir) => filePath.startsWith(dir + path.sep))) {
          return new Response('Proibido', { status: 403 });
        }
      } else if (url.host === 'covers') {
        filePath = library.coverPath(rel);
      } else {
        return new Response('Não encontrado', { status: 404 });
      }
      const data = await fsp.readFile(filePath);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache'
        }
      });
    } catch {
      return new Response('Não encontrado', { status: 404 });
    }
  });
}

function windowStateIsVisible(state) {
  if (!state || state.x === undefined) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    state.x >= a.x - 50 && state.y >= a.y - 50 && state.x < a.x + a.width - 100 && state.y < a.y + a.height - 100);
}

function createWindow() {
  const settings = library.getSettings();
  const state = settings.windowState || {};
  const useSaved = windowStateIsVisible(state);
  mainWindow = new BrowserWindow({
    width: state.width || 1320,
    height: state.height || 860,
    x: useSaved ? state.x : undefined,
    y: useSaved ? state.y : undefined,
    minWidth: 940,
    minHeight: 620,
    show: false,
    title: 'LeitorBook Áudio',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#f5f2ec',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (state.maximized) mainWindow.maximize();
    if (!process.argv.includes('--hidden')) mainWindow.show();
  });

  const saveState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? (library.getSettings().windowState || {}) : mainWindow.getBounds();
    library.setSettings({ windowState: { ...bounds, maximized } });
  };
  mainWindow.on('resize', debounce(saveState, 600));
  mainWindow.on('move', debounce(saveState, 600));
  mainWindow.on('close', saveState);
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('app://local/')) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const devtools = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (devtools && input.type === 'keyDown' && (isDev || !app.isPackaged)) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingOpenPaths.length) {
      const paths = pendingOpenPaths;
      pendingOpenPaths = [];
      setTimeout(() => openExternalPdfs(paths), 800);
    }
  });

  mainWindow.loadURL('app://local/src/renderer/index.html');
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function registerIpc() {
  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('library:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Adicionar livros PDF',
      buttonLabel: 'Adicionar à biblioteca',
      filters: [{ name: 'Livros PDF', extensions: ['pdf'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (res.canceled || !res.filePaths.length) return { added: [], skipped: [] };
    return library.addFiles(res.filePaths);
  });
  ipcMain.handle('library:addPaths', (_e, paths) => library.addFiles(Array.isArray(paths) ? paths : []));
  ipcMain.handle('library:update', (_e, id, patch) => library.update(id, patch));
  ipcMain.handle('library:remove', (_e, id) => library.remove(id));
  ipcMain.handle('library:readPdf', (_e, id) => library.readPdf(id));
  ipcMain.handle('library:saveCover', (_e, id, bytes) => library.saveCover(id, bytes));
  ipcMain.handle('library:reveal', (_e, id) => {
    shell.showItemInFolder(library.pdfPath(id));
    return true;
  });

  ipcMain.handle('settings:get', () => library.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => library.setSettings(patch));

  ipcMain.handle('tts:voices', (_e, force) => edge.getVoices(!!force));
  ipcMain.handle('tts:synthesize', (_e, req) => edge.synthesize(req || {}));

  ipcMain.handle('translate:text', (_e, req) => translator.translate(req || {}));
  ipcMain.handle('translate:detect', (_e, text) => translator.detect(text));

  ipcMain.handle('export:begin', async (_e, { suggestedName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Salvar audiolivro',
      defaultPath: path.join(app.getPath('music'), `${(suggestedName || 'audiolivro').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.mp3`),
      filters: [{ name: 'Áudio MP3', extensions: ['mp3'] }]
    });
    if (res.canceled || !res.filePath) return null;
    const id = ++exportSeq;
    exportStreams.set(id, { stream: fs.createWriteStream(res.filePath), filePath: res.filePath });
    return { id, filePath: res.filePath };
  });
  ipcMain.handle('export:append', (_e, id, bytes) => new Promise((resolve, reject) => {
    const entry = exportStreams.get(id);
    if (!entry) return reject(new Error('Exportação não encontrada'));
    entry.stream.write(Buffer.from(bytes), (err) => (err ? reject(err) : resolve(true)));
  }));
  ipcMain.handle('export:end', (_e, id, { cancel } = {}) => new Promise((resolve) => {
    const entry = exportStreams.get(id);
    if (!entry) return resolve(false);
    exportStreams.delete(id);
    entry.stream.end(async () => {
      if (cancel) await fsp.rm(entry.filePath, { force: true }).catch(() => {});
      resolve(true);
    });
  }));
  ipcMain.handle('export:reveal', (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('media:keys', (_e, enable) => {
    const keys = { MediaPlayPause: 'playpause', MediaNextTrack: 'next', MediaPreviousTrack: 'prev', MediaStop: 'stop' };
    for (const accel of Object.keys(keys)) {
      if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
    }
    if (enable) {
      for (const [accel, action] of Object.entries(keys)) {
        try { globalShortcut.register(accel, () => sendToRenderer('media:key', action)); } catch { /* tecla ocupada */ }
      }
    }
    return true;
  });

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), userData: app.getPath('userData'), dev: isDev }));
  ipcMain.handle('app:openExternal', (_e, url) => {
    if (/^https:\/\//i.test(String(url))) shell.openExternal(url);
    return true;
  });
  ipcMain.handle('app:setTitle', (_e, title) => {
    if (mainWindow) mainWindow.setTitle(title ? `${title} — LeitorBook Áudio` : 'LeitorBook Áudio');
    return true;
  });
  ipcMain.handle('app:fullscreen', () => {
    if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow?.isFullScreen() || false;
  });
}

app.on('second-instance', (_event, argv) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  openExternalPdfs(pdfPathsFromArgv(argv));
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const dataDir = app.getPath('userData');
  library = new Library(dataDir);
  edge = new EdgeTTSService(dataDir);
  translator = new Translator(dataDir, () => library.getSettings());
  registerProtocol();
  registerIpc();
  pendingOpenPaths = pdfPathsFromArgv(process.argv);
  createWindow();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  library?.flush();
  translator?.flush();
  edge?.closeAll();
});

app.on('window-all-closed', () => app.quit());
