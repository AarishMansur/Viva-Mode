// src/main/main.ts
// Electron main process.
//
// Responsibilities:
//   1. Own the window and the camera permission grant (camera only, bundled
//      page only).
//   2. Own the SmartSpectra native session via bindSmartSpectraIpc(win).
//   3. Serve the renderer's small local API: config, API key, settings,
//      session files, delete-all.
//
// The renderer never talks to the network itself. The only outbound traffic
// in the whole app is the SmartSpectra SDK's own key validation / metric
// processing, plus (opt-in) SDK telemetry.

import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SmartSpectraSDK } from '@smartspectra/node-sdk';
import { bindSmartSpectraIpc } from '@smartspectra/node-sdk/main';

import type { AppConfig, Question, SessionRecord, Settings } from '../shared/types';
import * as store from './storage';

const DEV = process.argv.includes('--dev');
const SMOKE = process.env.VIVA_SMOKE === '1';
const APP_VERSION = app.getVersion();
const SDK_VERSION = SmartSpectraSDK.version;

let mainWindow: BrowserWindow | null = null;
let questions: Question[] = [];

// ---------------------------------------------------------------------------
// Question bank
// ---------------------------------------------------------------------------

async function loadQuestions(): Promise<Question[]> {
  const candidates = [
    path.join(app.getAppPath(), 'data', 'questions.vtu-cse.json'),
    path.join(process.resourcesPath ?? '', 'data', 'questions.vtu-cse.json'),
    path.join(__dirname, '..', 'data', 'questions.vtu-cse.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as { questions?: Question[] };
      if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
        return parsed.questions;
      }
    } catch {
      /* try the next location */
    }
  }
  console.error('[viva] question bank not found — falling back to an empty bank');
  return [];
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: '#1b2430',
    title: 'Viva Mode',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // The viva timer and the room animation are the point of the app; never
      // let Chromium throttle them down when the window loses focus.
      backgroundThrottling: false,
    },
  });

  // The renderer is a bundled local page. Block popups and navigation so a
  // stray link can never inherit this window's camera grant.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  bindSmartSpectraIpc(mainWindow);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (SMOKE) {
    // Imported lazily so the smoke harness never runs in a normal session.
    void import('./smoke').then((m) => m.runSmoke(mainWindow as BrowserWindow));
  }

  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('viva:getConfig', async (): Promise<AppConfig> => {
    const [settings, key] = await Promise.all([store.loadSettings(), store.readApiKey()]);
    return {
      hasApiKey: key.key != null,
      apiKeySource: key.source,
      settings,
      questions,
      appVersion: APP_VERSION,
      sdkVersion: SDK_VERSION,
      dataDir: store.dataDir(),
      platform: `${process.platform}-${process.arch}`,
    };
  });

  // The renderer needs the key to construct its SDK proxy. It is handed over
  // IPC rather than baked into the bundle so it never lands in git.
  ipcMain.handle('viva:getApiKey', async () => {
    const { key } = await store.readApiKey();
    return key;
  });

  ipcMain.handle('viva:setApiKey', async (_e, key: string) => {
    await store.saveApiKey(String(key ?? ''));
    return { ok: true };
  });

  ipcMain.handle('viva:clearApiKey', async () => {
    await store.clearApiKey();
    return { ok: true };
  });

  ipcMain.handle('viva:saveSettings', async (_e, patch: Partial<Settings>) => {
    return store.saveSettings(patch ?? {});
  });

  ipcMain.handle('viva:saveSession', async (_e, record: SessionRecord) => {
    const id = await store.saveSession(record);
    return { id };
  });

  ipcMain.handle('viva:listSessions', async () => store.listSessions());
  ipcMain.handle('viva:getSession', async (_e, id: string) => store.getSession(id));
  ipcMain.handle('viva:deleteSession', async (_e, id: string) => ({
    ok: await store.deleteSession(id),
  }));

  ipcMain.handle('viva:deleteAllData', async () => {
    await store.deleteAllData();
    return { ok: true };
  });

  ipcMain.handle('viva:openDataFolder', async () => {
    await shell.openPath(store.dataDir());
    return { ok: true };
  });

  ipcMain.handle('viva:savePng', async (_e, dataUrl: string, suggestedName: string) => {
    const win = mainWindow;
    if (!win) return { ok: false };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save your Calm Report',
      defaultPath: path.join(app.getPath('downloads'), suggestedName),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { ok: false };
    const base64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
    await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
    return { ok: true, path: filePath };
  });

  ipcMain.on('viva:log', (_e, line: string) => {
    if (DEV) console.log(`[renderer] ${line}`);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.setName('Viva Mode');

// A single instance keeps one native SmartSpectra session per camera.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Camera only, bundled page only. Everything else is denied, so a window
    // that ever loaded remote content could not silently inherit the camera.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
      const mediaTypes =
        (details as Electron.MediaAccessPermissionRequest | undefined)?.mediaTypes ?? [];
      const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
      callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      return permission === 'media' && requestingOrigin.startsWith('file://');
    });

    questions = await loadQuestions();
    registerIpc();

    const settings = await store.loadSettings();
    if (settings.autoDeleteDays > 0) {
      const removed = await store.purgeOlderThan(settings.autoDeleteDays);
      if (removed) console.log(`[viva] auto-deleted ${removed} old session(s)`);
    }

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
