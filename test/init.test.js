// init-script integration tests: run the REAL shipped files
// (tauri-adapter.js + notification-bridge.js + link-policy.js + main.js)
// inside a Node VM sandbox shaped like the Tauri webview, with:
//   - a fake __TAURI_INTERNALS__.invoke transport (real command shape),
//   - optional ABSENT web Notification (Original unavailable),
//   - controllable permission results (granted/denied/failure).
// This exercises the actual bootstrap wiring — not just the Bridge unit
// seam — including: single native delivery per construction (no duplicates),
// permission getter/requestPermission behaviour, external-link single-invoke,
// window.open patching, and the untrusted-origin guard.
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const FRONTEND = path.join(__dirname, "..", "frontend");
function load(name) {
  return fs.readFileSync(path.join(FRONTEND, name), "utf8");
}
const SOURCES = {
  adapter: load("tauri-adapter.js"),
  bridge: load("notification-bridge.js"),
  links: load("link-policy.js"),
  main: load("main.js"),
};

function makeTransport({
  granted = true,
  requestResult = "granted",
  failNotify = false,
} = {}) {
  const calls = [];
  const sent = [];
  const opened = [];
  async function invoke(cmd, args) {
    calls.push({ cmd, args });
    if (cmd === "plugin:notification|is_permission_granted") return granted;
    if (cmd === "plugin:notification|request_permission") return requestResult;
    if (cmd === "plugin:notification|notify") {
      if (failNotify) throw new Error("os busy");
      sent.push(args && args.options);
      return null;
    }
    if (cmd === "plugin:opener|open_url") {
      opened.push(args && args.url);
      return null;
    }
    throw new Error("unexpected command: " + cmd);
  }
  return { invoke, calls, sent, opened };
}

// Minimal DOM stub: document.addEventListener (capture clicks), an anchor
// factory, and window.open recording. Enough for main.js interception.
function makeDom() {
  const listeners = { click: [] };
  const openedWindows = [];
  const anchors = [];
  function makeAnchor(href, target) {
    const a = {
      href,
      target: target || "",
      getAttribute: (k) => (k === "href" ? href : null),
      closest: (sel) => (sel === "a[href]" ? a : null),
    };
    anchors.push(a);
    return a;
  }
  return {
    listeners,
    openedWindows,
    makeAnchor,
    document: {
      addEventListener: (type, fn, capture) => {
        (listeners[type] = listeners[type] || []).push({ fn, capture });
      },
    },
    fireClick(anchor, extra = {}) {
      const event = Object.assign(
        {
          target: anchor,
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          button: 0,
          defaultPrevented: false,
          preventDefault() {
            this.defaultPrevented = true;
          },
          stopPropagation() {},
        },
        extra,
      );
      for (const { fn } of listeners.click || []) fn(event);
      return event;
    },
  };
}

function runInit({
  origin = "https://muse.ai",
  withWebNotification = true,
  transport = makeTransport({}),
} = {}) {
  const dom = makeDom();
  const sandbox = {
    console,
    URL,
    Event:
      typeof Event === "undefined"
        ? class FakeEvent {
            constructor(type) {
              this.type = type;
            }
          }
        : Event,
    EventTarget: typeof EventTarget === "undefined" ? undefined : EventTarget,
    Promise,
    Object,
    String,
    Array,
    JSON,
    Math,
    location: { origin, href: origin + "/" },
    document: dom.document,
    __TAURI_INTERNALS__: { invoke: transport.invoke },
  };
  if (withWebNotification) {
    // Simulate a locked-down remote webview WITHOUT a usable web Notification
    // (or with one — both must work; absence is the critical case).
    sandbox.Notification = undefined;
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // window.open recording fallback (used when no adapter present only).
  const openedByWindowOpen = [];
  sandbox.open = (url) => {
    openedByWindowOpen.push(url);
    return null;
  };
  vm.createContext(sandbox);
  const run = (code) => vm.runInContext(code, sandbox, { filename: "init.js" });
  run(SOURCES.adapter);
  run(SOURCES.bridge);
  run(SOURCES.links);
  run(SOURCES.main);
  return { sandbox, dom, transport, openedByWindowOpen };
}

describe("init script integration (real files, VM webview)", () => {
  let ctx;
  beforeEach(() => {
    ctx = null;
  });

  test("installs on the trusted origin with status ok", () => {
    ctx = runInit({});
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(ctx.sandbox.__museBridgeStatus)),
      { installed: true, reason: "ok" },
    );
    assert.equal(typeof ctx.sandbox.Notification, "function");
  });

  test("refuses to install on untrusted origins (auth hosts pristine)", () => {
    ctx = runInit({ origin: "https://auth.meta.com" });
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(ctx.sandbox.__museBridgeStatus)),
      { installed: false, reason: "untrusted-origin" },
    );
    assert.equal(ctx.sandbox.Notification, undefined);
  });

  test("construction delivers EXACTLY ONE native toast, no web Original needed", async () => {
    ctx = runInit({
      withWebNotification: false,
      transport: makeTransport({ granted: true }),
    });
    const { sandbox, transport } = ctx;
    // Seed the async permission cache like the page would (refresh on load).
    await vm.runInContext("MuseBridge.refresh()", sandbox);
    assert.equal(
      await vm.runInContext("MuseBridge.state().permission", sandbox),
      "granted",
    );
    const notifyCallsBefore = transport.calls.filter(
      (c) => c.cmd === "plugin:notification|notify",
    ).length;
    vm.runInContext(
      `new Notification('Hi', { body: 'there', tag: 'x', data: 1 })`,
      sandbox,
    );
    // Allow the fire-and-forget delivery promise to settle.
    await new Promise((r) => setImmediate(r));
    const notifyCalls = transport.calls.filter(
      (c) => c.cmd === "plugin:notification|notify",
    );
    assert.equal(
      notifyCalls.length,
      notifyCallsBefore + 1,
      "exactly one native delivery",
    );
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(transport.sent[transport.sent.length - 1])),
      { title: "Hi", body: "there" },
    );
  });

  test("construction with denied cache invokes NOTHING (no silent send)", async () => {
    ctx = runInit({
      withWebNotification: false,
      transport: makeTransport({ granted: false }),
    });
    const { sandbox, transport } = ctx;
    await vm.runInContext("MuseBridge.refresh()", sandbox);
    assert.equal(
      await vm.runInContext("MuseBridge.state().permission", sandbox),
      "denied",
    );
    const n = transport.calls.length;
    vm.runInContext(`new Notification('Hi', { body: 'there' })`, sandbox);
    await new Promise((r) => setImmediate(r));
    assert.equal(transport.calls.length, n, "no invoke while denied");
  });

  test("permission getter reflects the async cache; requestPermission prompts once", async () => {
    ctx = runInit({
      transport: makeTransport({ granted: null, requestResult: "granted" }),
    });
    const { sandbox, transport } = ctx;
    assert.equal(
      await vm.runInContext("Notification.permission", sandbox),
      "default",
    );
    const perm = await vm.runInContext(
      "Notification.requestPermission()",
      sandbox,
    );
    assert.equal(perm, "granted");
    assert.equal(
      await vm.runInContext("Notification.permission", sandbox),
      "granted",
    );
    const reqCalls = transport.calls.filter(
      (c) => c.cmd === "plugin:notification|request_permission",
    );
    assert.equal(reqCalls.length, 1);
  });

  test("requestPermission supports legacy callback form and never rejects on failure", async () => {
    ctx = runInit({
      transport: {
        invoke: async () => {
          throw new Error("denied by capability");
        },
        calls: [],
        sent: [],
        opened: [],
      },
    });
    const { sandbox } = ctx;
    const perm = await vm.runInContext(
      `new Promise((resolve) => Notification.requestPermission((p) => resolve('cb:' + p)))`,
      sandbox,
    );
    assert.equal(perm, "cb:default");
  });

  test("unsupported surface is documented, EventTarget-shaped, close() is safe", async () => {
    ctx = runInit({});
    const { sandbox } = ctx;
    const unsupported = await vm.runInContext(
      "Notification.unsupported",
      sandbox,
    );
    assert.ok(Array.isArray(unsupported) && unsupported.length >= 3);
    assert.equal(await vm.runInContext("Notification.maxActions", sandbox), 0);
    const probe = await vm.runInContext(
      `(() => { const n = new Notification('t'); n.addEventListener('click', () => {}); n.onclick = () => {}; n.close(); return typeof n.dispatchEvent; })()`,
      sandbox,
    );
    assert.equal(probe, "function");
  });

  test("external _blank click invokes open_url EXACTLY once; trusted click untouched", () => {
    ctx = runInit({ transport: makeTransport({ granted: true }) });
    const { sandbox, dom, transport } = ctx;
    const ext = dom.makeAnchor("https://example.com/article", "_blank");
    const ev1 = dom.fireClick(ext);
    assert.equal(ev1.defaultPrevented, true);
    assert.deepStrictEqual(Array.from(transport.opened), [
      "https://example.com/article",
    ]);
    const trusted = dom.makeAnchor("https://muse.ai/chat", "_blank");
    const ev2 = dom.fireClick(trusted);
    assert.equal(ev2.defaultPrevented, false);
    assert.equal(
      transport.opened.length,
      1,
      "no second invoke for trusted URL",
    );
    const blocked = dom.makeAnchor("javascript:alert(1)", "_blank");
    const ev3 = dom.fireClick(blocked);
    assert.equal(ev3.defaultPrevented, true);
    assert.equal(transport.opened.length, 1, "blocked scheme never opens");
  });

  test("same-tab external click is left for the Rust guard (no JS invoke)", () => {
    ctx = runInit({ transport: makeTransport({}) });
    const { dom, transport } = ctx;
    const sameTab = dom.makeAnchor("https://example.com/other", "");
    const ev = dom.fireClick(sameTab);
    assert.equal(ev.defaultPrevented, false);
    assert.equal(transport.opened.length, 0);
  });

  test("window.open to external returns null + single invoke; trusted passes through", () => {
    ctx = runInit({ transport: makeTransport({}) });
    const { sandbox, transport, openedByWindowOpen } = ctx;
    const r1 = vm.runInContext(
      `window.open('https://example.com/popup', '_blank')`,
      sandbox,
    );
    assert.equal(r1, null);
    assert.deepStrictEqual(Array.from(transport.opened), [
      "https://example.com/popup",
    ]);
    const r2 = vm.runInContext(`window.open('javascript:alert(1)')`, sandbox);
    assert.equal(r2, null);
    assert.equal(transport.opened.length, 1);
    // Trusted URL falls through to the original window.open.
    vm.runInContext(`window.open('https://muse.ai/chat', '_self')`, sandbox);
    assert.deepStrictEqual(Array.from(openedByWindowOpen), [
      "https://muse.ai/chat",
    ]);
  });

  test("absent Original AND failed permission: shim still installs, degrades honestly", async () => {
    ctx = runInit({
      withWebNotification: false,
      transport: makeTransport({ granted: false }),
    });
    const { sandbox } = ctx;
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(sandbox.__museBridgeStatus)),
      { installed: true, reason: "ok" },
    );
    assert.equal(typeof sandbox.Notification, "function");
    assert.equal(
      await vm.runInContext(
        "MuseBridge.refresh().then(() => Notification.permission)",
        sandbox,
      ),
      "denied",
    );
  });
});
