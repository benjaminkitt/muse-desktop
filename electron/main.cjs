const { app, BrowserWindow, session, shell } = require('electron');
const path = require('node:path');

const MUSE_URL = 'https://muse.ai/';
const { isTrustedNavigation, uniqueDownloadPath } = require('./utils.cjs');

function configureSession(ses) {
  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === 'notifications' && isTrustedNavigation(requestingOrigin);
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requestingUrl = details?.requestingUrl ?? '';
    callback(permission === 'notifications' && isTrustedNavigation(requestingUrl));
  });

  ses.on('will-download', (_event, item) => {
    item.setSavePath(uniqueDownloadPath(app.getPath('downloads'), item.getFilename()));
  });
}

function createMuseWindow() {
  const window = new BrowserWindow({
    title: 'Muse',
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: '#101117',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:muse',
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedNavigation(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedNavigation(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.once('ready-to-show', () => window.show());
  void window.loadURL(MUSE_URL);
  return window;
}

function start() {
  // Keep browser profile data in a predictable, product-specific directory.
  app.setPath('userData', path.join(app.getPath('appData'), 'Muse'));

  app.whenReady().then(() => {
    configureSession(session.fromPartition('persist:muse'));
    createMuseWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMuseWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

start();
