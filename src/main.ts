import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc } from './backend/ipc';
import { stopServer } from './backend/engines/whisper';
import { stopWorker } from './backend/engines/voiceClone';

function stopEngines() {
  stopServer();
  stopWorker();
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'STS — Fala local',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Permite captura de microfone (getUserMedia) a partir do renderer.
  // Precisa dos DOIS handlers: request (ao pedir) e check (verificação síncrona).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media'); // getUserMedia (microfone) usa a permissão 'media'
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    const p = permission as string;
    return p === 'media' || p === 'microphone' || p === 'audioCapture';
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) =>
    console.error('[renderer] did-fail-load', code, desc),
  );
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    // Em dev, espelha o console do renderer no stdout para facilitar diagnóstico.
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) =>
      console.log(`[renderer:${level}] ${message} (${source}:${line})`),
    );
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.on('ready', () => {
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  stopEngines();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => stopEngines());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
