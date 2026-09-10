const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const adapter = require("../frontend/tauri-adapter.js");
const bridge = require("../frontend/notification-bridge.js");
const links = require("../frontend/link-policy.js");

// Fake invoke transport with the REAL command shape:
//   plugin:notification|is_permission_granted -> bool|null
//   plugin:notification|request_permission    -> PermissionState string
//   plugin:notification|notify                -> void (records {options})
//   plugin:opener|open_url                    -> void (records url)
function fakeTransport({
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

function invokeHost(transport, extra = {}) {
  return Object.assign(
    {
      __museTestInvoke: transport.invoke,
      Notification: { permission: "default" },
    },
    extra,
  );
}

describe("tauri-adapter (real invoke shape)", () => {
  test("detect returns null without any transport (plain browser)", () => {
    assert.equal(adapter.detect({}), null);
    assert.equal(adapter.detect({ __TAURI__: { notification: {} } }), null);
  });

  test("detect ignores the non-existent __TAURI__.notification path (blocker #1)", () => {
    // Even a fully-populated __TAURI__.notification must NOT bind: that
    // property does not exist in Tauri v2; only __TAURI_INTERNALS__.invoke.
    const host = {
      __TAURI__: {
        notification: {
          sendNotification() {},
          isPermissionGranted() {},
          requestPermission() {},
        },
        opener: { openUrl() {} },
      },
    };
    assert.equal(adapter.detect(host), null);
  });

  test("detect binds __TAURI_INTERNALS__.invoke and pins command strings", async () => {
    const t = fakeTransport({ granted: true });
    const host = { __TAURI_INTERNALS__: { invoke: t.invoke } };
    const a = adapter.detect(host);
    assert.ok(a);
    assert.deepEqual(Object.values(a.commands).sort(), [
      "plugin:notification|is_permission_granted",
      "plugin:notification|notify",
      "plugin:notification|request_permission",
      "plugin:opener|open_url",
    ]);
    await a.isGranted();
    await a.openUrl("https://example.com/");
    assert.equal(t.calls[0].cmd, "plugin:notification|is_permission_granted");
    assert.deepEqual(t.calls[1], {
      cmd: "plugin:opener|open_url",
      args: { url: "https://example.com/" },
    });
  });

  test("notify wraps payload as {options} per Rust commands::notify", async () => {
    const t = fakeTransport({});
    const a = adapter.makeAdapter(t.invoke);
    await a.notify({ title: "T", body: "B" });
    assert.deepEqual(t.sent, [{ title: "T", body: "B" }]);
  });
});

describe("notification-bridge (invoke-backed permission cache)", () => {
  test("setup without transport reports native:false and never throws", async () => {
    bridge.reset();
    const snap = bridge.setup({ Notification: { permission: "default" } });
    assert.equal(snap.native, false);
    assert.equal(snap.permission, "default");
    assert.equal(await bridge.ready(), false);
  });

  test("setup with invoke transport reports native:true", async () => {
    bridge.reset();
    const snap = bridge.setup(invokeHost(fakeTransport({})));
    assert.equal(snap.native, true);
    assert.equal(snap.canRequest, true);
    assert.equal(await bridge.ready(), true);
  });

  test("refresh maps true->granted, false->denied, null->default (undecided)", async () => {
    bridge.reset();
    bridge.setup(invokeHost(fakeTransport({ granted: true })));
    assert.equal(await bridge.refresh(), "granted");

    bridge.reset();
    bridge.setup(invokeHost(fakeTransport({ granted: false })));
    assert.equal(await bridge.refresh(), "denied");

    bridge.reset();
    bridge.setup(invokeHost(fakeTransport({ granted: null })));
    assert.equal(await bridge.refresh(), "default");
  });

  test("refresh maps transport failure to default (never denied)", async () => {
    bridge.reset();
    bridge.setup({
      __museTestInvoke: async () => {
        throw new Error("denied by capability");
      },
    });
    assert.equal(await bridge.ready(), true);
    assert.equal(await bridge.refresh(), "default");
  });

  test("request maps granted/denied through, prompt-states to default", async () => {
    for (const [result, expected] of [
      ["granted", "granted"],
      ["denied", "denied"],
      ["prompt", "default"],
      ["prompt-with-rationale", "default"],
    ]) {
      bridge.reset();
      bridge.setup(invokeHost(fakeTransport({ requestResult: result })));
      assert.equal(await bridge.request(), expected, result);
    }
  });

  test("notify delivers via invoke when granted", async () => {
    bridge.reset();
    const t = fakeTransport({ granted: true });
    bridge.setup(invokeHost(t));
    await bridge.refresh();
    const res = await bridge.notify("Hello", "world");
    assert.deepEqual(res, { delivered: true });
    assert.deepEqual(t.sent, [{ title: "Hello", body: "world" }]);
  });

  test("notify without granted cache never invokes", async () => {
    bridge.reset();
    const t = fakeTransport({ granted: false });
    bridge.setup(invokeHost(t));
    await bridge.refresh(); // -> denied
    const nCalls = t.calls.length;
    const res = await bridge.notify("Hello", "world");
    assert.equal(res.delivered, false);
    assert.match(res.reason, /permission/);
    assert.equal(t.calls.length, nCalls);
    assert.equal(t.sent.length, 0);
  });

  test("notify without transport resolves fallback:true", async () => {
    bridge.reset();
    bridge.setup({ Notification: { permission: "granted" } });
    await bridge.refresh({ Notification: { permission: "granted" } });
    const res = await bridge.notify("Hi", "there");
    assert.equal(res.delivered, false);
    assert.equal(res.fallback, true);
  });

  test("notify rejects empty titles without invoking", async () => {
    bridge.reset();
    const t = fakeTransport({ granted: true });
    bridge.setup(invokeHost(t));
    await bridge.refresh();
    const nCalls = t.calls.length;
    for (const bad of ["", "   ", null, undefined, 42]) {
      const res = await bridge.notify(bad, "body");
      assert.equal(res.delivered, false);
      assert.equal(res.reason, "invalid-title");
    }
    assert.equal(t.calls.length, nCalls);
  });

  test("notify trims and truncates overlong input", async () => {
    bridge.reset();
    const t = fakeTransport({ granted: true });
    bridge.setup(invokeHost(t));
    await bridge.refresh();
    await bridge.notify("  a  ".repeat(100), " b ".repeat(500));
    assert.ok(t.sent[0].title.length <= 120);
    assert.ok((t.sent[0].body || "").length <= 500);
    assert.ok(!/ {2}/.test(t.sent[0].title));
  });

  test("notify accepts { body } options objects like the Notification API", async () => {
    bridge.reset();
    const t = fakeTransport({ granted: true });
    bridge.setup(invokeHost(t));
    await bridge.refresh();
    const res = await bridge.notify("T", { body: "B", tag: "ignored" });
    assert.deepEqual(res, { delivered: true });
    assert.equal(t.sent[0].body, "B");
  });

  test("send failure resolves send-failed with fallback (never rejects)", async () => {
    bridge.reset();
    bridge.setup(
      invokeHost(fakeTransport({ granted: true, failNotify: true })),
    );
    await bridge.refresh();
    const res = await bridge.notify("T", "B");
    assert.equal(res.delivered, false);
    assert.equal(res.reason, "send-failed");
    assert.equal(res.fallback, true);
  });
});

describe("link-policy", () => {
  test("trusted app URLs stay in webview", () => {
    assert.equal(links.decide("https://muse.ai/"), "webview");
    assert.equal(links.decide("https://muse.ai/chat?q=1#f"), "webview");
    assert.equal(links.decide("https://www.muse.ai/x"), "webview");
    assert.ok(links.isTrusted("https://muse.ai/"));
  });

  test("auth-flow hosts stay in webview (documented surface)", () => {
    for (const h of links.AUTH_HOSTS)
      assert.equal(links.decide(`https://${h}/login`), "webview");
  });

  test("lookalike and unrelated hosts go external", () => {
    assert.equal(links.decide("https://muse.ai.evil.com/"), "external");
    assert.equal(links.decide("https://evilmuse.ai/"), "external");
    assert.equal(links.decide("https://example.com/a"), "external");
  });

  test("dangerous schemes are blocked", () => {
    for (const u of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "muse://x",
      "ftp://h/x",
    ])
      assert.equal(links.decide(u), "block", u);
  });

  test("host lists are exposed as data for review", () => {
    assert.ok(Array.isArray(links.TRUSTED_HOSTS));
    assert.ok(links.TRUSTED_HOSTS.includes("muse.ai"));
  });
});
