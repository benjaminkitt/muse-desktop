const { app, BrowserWindow, dialog, session, shell } = require("electron");
const path = require("node:path");

const MUSE_URL = "https://muse.ai/";
const {
  isTrustedNavigation,
  isAllowedExternalUrl,
  isNotificationOrigin,
  uniqueDownloadPath,
} = require("./utils.cjs");

function openExternalUrl(url) {
  if (isAllowedExternalUrl(url)) {
    void shell
      .openExternal(url)
      .catch(() => console.warn("Could not open external link"));
  }
}

function configureSession(ses) {
  ses.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) => {
      return (
        permission === "notifications" && isNotificationOrigin(requestingOrigin)
      );
    },
  );

  ses.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl ?? "";
      callback(
        permission === "notifications" && isNotificationOrigin(requestingUrl),
      );
    },
  );

  ses.on("will-download", (_event, item) => {
    try {
      item.setSavePath(
        uniqueDownloadPath(app.getPath("downloads"), item.getFilename()),
      );
    } catch {
      item.cancel();
      console.warn("Could not reserve download destination");
    }
  });
}

function createMuseWindow() {
  const window = new BrowserWindow({
    title: "Muse",
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: "#101117",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "persist:muse",
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedNavigation(url)) {
      void window
        .loadURL(url)
        .catch(() => console.warn("Could not load Muse link"));
    } else {
      openExternalUrl(url);
    }
    return { action: "deny" };
  });

  const guardNavigation = (event, url, _isInPlace, isMainFrame = true) => {
    if (!isTrustedNavigation(url)) {
      event.preventDefault();
      if (isMainFrame) openExternalUrl(url);
    }
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);

  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show();
  });
  async function loadMuse() {
    while (!window.isDestroyed()) {
      try {
        await window.loadURL(MUSE_URL);
        return;
      } catch {
        if (window.isDestroyed()) return;
        // A failed first request may never emit ready-to-show.
        window.show();
        const { response } = await dialog.showMessageBox(window, {
          type: "error",
          title: "Could not load Muse",
          message: "Muse could not be reached.",
          detail: "Check your internet connection, then try again.",
          buttons: ["Retry", "Close"],
          defaultId: 0,
          cancelId: 1,
        });
        if (window.isDestroyed()) return;
        if (response !== 0) {
          window.close();
          return;
        }
      }
    }
  }
  void loadMuse().catch(() =>
    console.warn("Could not show Muse load recovery"),
  );
  return window;
}

function start() {
  // Keep browser profile data in a predictable, product-specific directory.
  app.setPath("userData", path.join(app.getPath("appData"), "Muse"));

  app.whenReady().then(() => {
    configureSession(session.fromPartition("persist:muse"));
    createMuseWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMuseWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

start();
