const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const {
  isTrustedNavigation,
  isAllowedExternalUrl,
  isNotificationOrigin,
  uniqueDownloadPath,
} = require("./utils.cjs");

test("permits Muse and its narrowly scoped Meta sign-in redirects", () => {
  assert.equal(isTrustedNavigation("https://muse.ai/chat"), true);
  assert.equal(isTrustedNavigation("https://auth.muse.ai/aymh/"), true);
  assert.equal(
    isTrustedNavigation("https://www.facebook.com/aymh/redirect-cycle"),
    true,
  );
  assert.equal(
    isTrustedNavigation("https://www.instagram.com/aymh/redirect-cycle"),
    true,
  );
  assert.equal(
    isTrustedNavigation("https://auth.meta.com/aymh/redirect-cycle"),
    true,
  );
  assert.equal(isTrustedNavigation("https://www.facebook.com/settings"), false);
  assert.equal(isTrustedNavigation("https://muse.ai.evil.example"), false);
  assert.equal(isTrustedNavigation("http://muse.ai"), false);
});

test("only permits HTTP(S) external links and exact application-origin notifications", () => {
  for (const url of ["https://example.com", "http://example.com"]) {
    assert.equal(isAllowedExternalUrl(url), true);
  }
  for (const url of [
    "file:///tmp/test",
    "smb://host/share",
    "custom:launch",
    "javascript:alert(1)",
    "not a URL",
  ]) {
    assert.equal(isAllowedExternalUrl(url), false);
  }
  assert.equal(isNotificationOrigin("https://muse.ai/chat"), true);
  for (const url of [
    "https://auth.muse.ai",
    "https://muse.ai:8443",
    "http://muse.ai",
    "https://muse.ai.evil.test",
    "https://auth.meta.com/aymh/",
    "invalid",
  ]) {
    assert.equal(isNotificationOrigin(url), false);
  }
});

// Exercise the actual startup/handler wiring without launching a GUI or loading Muse.
async function startWithMocks(downloadsDir) {
  const windows = [];
  const externalUrls = [];
  const ses = new EventEmitter();
  ses.setPermissionCheckHandler = (handler) => {
    ses.checkPermission = handler;
  };
  ses.setPermissionRequestHandler = (handler) => {
    ses.requestPermission = handler;
  };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.loadedUrls = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => {
        this.openWindow = handler;
      };
      windows.push(this);
    }
    loadURL(url) {
      this.loadedUrls.push(url);
      return Promise.resolve();
    }
    show() {}
  }
  const app = new EventEmitter();
  app.getPath = () => downloadsDir ?? os.tmpdir();
  app.setPath = () => {};
  app.whenReady = () => Promise.resolve();
  const electron = {
    app,
    BrowserWindow,
    session: { fromPartition: () => ses },
    shell: {
      openExternal: (url) => {
        externalUrls.push(url);
        return Promise.resolve();
      },
    },
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8"),
    {
      require: (name) => (name === "electron" ? electron : require(name)),
      process,
      console,
    },
  );
  await Promise.resolve();
  return { windows, externalUrls, ses };
}

test("guards direct navigation and redirects and never creates child windows", async () => {
  const { windows, externalUrls } = await startWithMocks();
  const window = windows[0];
  for (const eventName of ["will-navigate", "will-redirect"]) {
    for (const url of [
      "https://muse.ai/chat",
      "https://example.com",
      "file:///tmp/test",
      "custom:launch",
    ]) {
      let prevented = false;
      const before = externalUrls.length;
      window.webContents.emit(
        eventName,
        {
          preventDefault() {
            prevented = true;
          },
        },
        url,
        false,
        true,
      );
      assert.equal(prevented, !isTrustedNavigation(url));
      assert.equal(
        externalUrls.length - before,
        url === "https://example.com" ? 1 : 0,
      );
    }
  }
  for (const url of [
    "https://muse.ai/chat",
    "https://auth.meta.com/aymh/login",
  ]) {
    assert.equal(window.openWindow({ url }).action, "deny");
    assert.equal(window.loadedUrls.at(-1), url);
  }
  const before = externalUrls.length;
  assert.equal(
    window.openWindow({ url: "https://example.com/popup" }).action,
    "deny",
  );
  assert.equal(externalUrls.at(-1), "https://example.com/popup");
  assert.equal(window.openWindow({ url: "smb://host/share" }).action, "deny");
  assert.equal(externalUrls.length, before + 1);
  assert.equal(windows.length, 1);
});

test("both session permission handlers restrict notifications to the application origin", async () => {
  const { ses } = await startWithMocks();
  for (const url of [
    "https://muse.ai/chat",
    "https://auth.muse.ai",
    "https://muse.ai:8443",
    "invalid",
  ]) {
    for (const permission of ["notifications", "camera"]) {
      const expected =
        permission === "notifications" && isNotificationOrigin(url);
      assert.equal(ses.checkPermission(null, permission, url), expected);
      let granted;
      ses.requestPermission(
        null,
        permission,
        (value) => {
          granted = value;
        },
        { requestingUrl: url },
      );
      assert.equal(granted, expected);
    }
  }
  ses.requestPermission(null, "notifications", (granted) =>
    assert.equal(granted, false),
  );
});

test("reserves distinct paths for simultaneous downloads before either writes data", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-session-"));
  try {
    const { ses } = await startWithMocks(directory);
    const destinations = [];
    for (let index = 0; index < 2; index += 1) {
      ses.emit(
        "will-download",
        {},
        {
          getFilename: () => "report.pdf",
          setSavePath: (destination) => destinations.push(destination),
          cancel: () => assert.fail("download unexpectedly cancelled"),
        },
      );
    }
    assert.equal(new Set(destinations).size, 2);
    assert.ok(destinations.every((destination) => fs.existsSync(destination)));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("cancels downloads when destination reservation fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-failure-"));
  try {
    const { ses } = await startWithMocks(path.join(directory, "missing"));
    let cancelled = false;
    ses.emit(
      "will-download",
      {},
      {
        getFilename: () => "report.pdf",
        setSavePath: () => assert.fail("should not assign an unreserved path"),
        cancel: () => {
          cancelled = true;
        },
      },
    );
    assert.equal(cancelled, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("makes a safe non-overwriting download name", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "muse-download-"));
  try {
    fs.writeFileSync(path.join(directory, "report.pdf"), "existing");
    assert.equal(
      uniqueDownloadPath(directory, "../../report.pdf"),
      path.join(directory, "report (1).pdf"),
    );
    assert.equal(
      uniqueDownloadPath(directory, "report.pdf"),
      path.join(directory, "report (2).pdf"),
    );
    assert.equal(
      fs.readFileSync(path.join(directory, "report.pdf"), "utf8"),
      "existing",
    );
    assert.equal(fs.statSync(path.join(directory, "report (1).pdf")).size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
