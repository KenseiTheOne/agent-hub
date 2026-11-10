// The server on a real socket with real peer verification (peercred addon + codesign).
// If the addon is missing, on macOS scripts/build-native.sh builds it before the tests (ensureNative); outside macOS there is none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { cleanup, curl, ensureNative, FILE_MODES, FIXTURES, onlyDarwin, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

// Without the peercred addon (macOS only) the peer cannot be identified: every client is cli (peer:no-peercred).
const NATIVE = ensureNative();

const HOOK_CLIENT = join(FIXTURES, "hook-client.mjs");
const childEnv = () => {
  const e = { ...process.env };
  delete e.NODE_OPTIONS;
  return e;
};

const PLUGIN = `#!/bin/sh
# <agenthub.title>T</agenthub.title>
# <agenthub.action id="danger" level="confirm">/bin/echo danger</agenthub.action>
echo "T | status=ok"
echo "---"
echo "Danger | action=danger"
`;

async function hub(overrides = {}, setup) {
  const plugins = tempHome("ah-pl-");
  writePlugin(plugins, "t.1h.sh", PLUGIN);
  setup?.(plugins);
  const h = await startHub({ pluginsDir: plugins, overrides: { peer: { hookPaths: [HOOK_CLIENT] }, ...overrides } });
  await waitFor(() => h.core.pluginState("t")?.body.length);
  h.danger = () => h.core.pluginState("t").body.find((b) => b.title === "Danger").offer.id;
  const stop = h.stop;
  h.stop = async () => {
    await stop();
    cleanup(plugins);
  };
  return h;
}

function buildApp(dir) {
  const app = join(dir, "AgentHub.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const exe = join(app, "Contents", "MacOS", "AgentHub");
  execFileSync("/usr/bin/clang", ["-O1", "-o", exe, join(FIXTURES, "native", "client.c")]);
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.kensei.agenthub</string>
<key>CFBundleExecutable</key><string>AgentHub</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  // ad hoc: no identity, identifier only
  execFileSync("/usr/bin/codesign", ["--force", "-s", "-", "-i", "com.kensei.agenthub", app], { stdio: "ignore" });
  return exe;
}

function runApp(exe, sock, method, path, body = "") {
  return new Promise((resolve, reject) => {
    execFile(exe, [sock, method, path, body], { timeout: 10_000 }, (err, out) => {
      if (err) return reject(err);
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1]);
      const json = out.slice(out.indexOf("\r\n\r\n") + 4);
      let parsed = null;
      try {
        parsed = JSON.parse(json);
      } catch {}
      resolve({ status, body: parsed });
    });
  });
}

test("socket 0600 in a 0700 directory; no TCP ports", async () => {
  const h = await hub();
  try {
    if (FILE_MODES) {
      assert.equal(statSync(h.sock).mode & 0o777, 0o600);
      assert.equal(statSync(h.home).mode & 0o777, 0o700);
    }
    assert.ok(statSync(h.sock).isSocket());
    // lsof exits with 1 when it finds nothing
    const out = await new Promise((res) => execFile("/usr/sbin/lsof", ["-nP", "-iTCP", "-a", "-p", String(process.pid)], (err, stdout) => res(stdout)));
    assert.equal(out.trim(), "");
  } finally {
    await h.stop();
  }
});

test("curl: GET /state 200 (cli), POST of a confirm action → 403 peer:cli, /hook → 403", async () => {
  const h = await hub();
  try {
    const st = await curl(h.sock, "GET", "/state");
    assert.equal(st.status, 200);
    assert.equal(st.body.peer.class, "cli");
    const a = await curl(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(a.status, 403);
    assert.equal(a.body.error, NATIVE ? "peer:cli" : "peer:no-peercred");
    const hk = await curl(h.sock, "POST", "/hook", { session_id: "x" });
    assert.equal(hk.status, 403);
  } finally {
    await h.stop();
  }
});

test("ad hoc signed app → 403; the same app under a requirement it satisfies gets class app", { skip: onlyDarwin("clang, codesign and peercred") }, async () => {
  const dir = tempHome("ah-app-");
  try {
    const exe = buildApp(dir);
    // a requirement with a certificate (as for a local build) rejects ad hoc
    let h = await hub({ requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"' } });
    try {
      const r = await runApp(exe, h.sock, "POST", `/actions/${h.danger()}`);
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "peer:app-signature");
      const peer = await runApp(exe, h.sock, "GET", "/peer");
      assert.equal(peer.body.class, "cli");
    } finally {
      await h.stop();
    }
    // an identifier-only requirement: the same verification chain lets it through → 428 (confirmation needed) instead of 403
    h = await hub({ requirements: { app: 'identifier "com.kensei.agenthub"' } });
    try {
      const peer = await runApp(exe, h.sock, "GET", "/peer");
      assert.equal(peer.body.class, "app");
      const r = await runApp(exe, h.sock, "POST", `/actions/${h.danger()}`);
      assert.equal(r.status, 428);
      // the confirmation token is bound to the requester's pid: another process (even the same binary) cannot use it
      const other = await runApp(exe, h.sock, "POST", `/actions/${h.danger()}`, JSON.stringify({ confirmToken: r.body.token }));
      assert.equal(other.status, 403);
      assert.equal(other.body.error, "confirm:invalid");
      // curl against the same daemon is still cli
      assert.equal((await curl(h.sock, "POST", `/actions/${h.danger()}`)).status, 403);
    } finally {
      await h.stop();
    }
  } finally {
    cleanup(dir);
  }
});

test("agenthub-hook started from a shell with no Claude ancestor → 403 peer:no-claude-ancestor", { skip: onlyDarwin("peercred (peer ancestors) and an orphan with ppid=1") }, async () => {
  const h = await hub();
  const out = join(h.home, "hook.out");
  try {
    // sh starts the client in the background and exits: the client is orphaned (launchd is its only ancestor)
    execFileSync("/bin/sh", ["-c", `'${process.execPath}' '${HOOK_CLIENT}' '${h.sock}' '${out}' >/dev/null 2>&1 &`], { env: childEnv() });
    const res = await waitFor(() => existsSync(out) && JSON.parse(readFileSync(out, "utf8")), { timeoutMs: 8000 });
    assert.equal(res.ppid, 1);
    assert.equal(res.status, 403);
    assert.equal(JSON.parse(res.body).error, "peer:no-claude-ancestor");
  } finally {
    await h.stop();
  }
});

test("a fake ~/.claude/sessions/<pid>.json with the pid of a plain sleep → \"not Claude Code\", not in the registry", async () => {
  const sleeper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const sid = "66666666-6666-4666-8666-666666666666";
  let h;
  try {
    h = await hub();
    writeFileSync(join(h.claudeHome, "sessions", `${sleeper.pid}.json`), JSON.stringify({ pid: sleeper.pid, sessionId: sid, kind: "interactive", status: "waiting" }));
    writePlugin(
      join(h.home, "builtin2"),
      "sess.1h.mjs",
      `import { readdirSync, readFileSync } from "node:fs";
const dir = ${JSON.stringify(join(h.claudeHome, "sessions"))};
console.log("Сессии | status=ok");
console.log("---");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const s = JSON.parse(readFileSync(dir + "/" + f, "utf8"));
  console.log(\`S \${s.pid} | session=\${s.sessionId} pid=\${s.pid} sessionStatus=\${s.status}\`);
}
`,
    );
    h.core.config.builtinPluginsDir = join(h.home, "builtin2");
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("sess")?.body.find((b) => b.session)?.session.verified === false, { timeoutMs: 15_000 });
    const item = h.core.pluginState("sess").body.find((b) => b.session);
    assert.equal(item.session.label, "подпись не подтверждена");
    assert.equal(h.core.sessions.list().length, 0);
    const st = await curl(h.sock, "GET", "/state");
    assert.equal(st.body.waitingSessions, 0);
  } finally {
    sleeper.kill();
    await h?.stop();
  }
});

test("SSE /events: snapshot on connect, plugin and estop events", async () => {
  const h = await hub();
  try {
    const events = [];
    const res = await new Promise((resolve, reject) => {
      const r = request({ socketPath: h.sock, path: "/events", agent: false }, resolve);
      r.on("error", reject);
      r.end();
    });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"], /text\/event-stream/);
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (ev) events.push({ ev, data: JSON.parse(data) });
      }
    });
    await waitFor(() => events.length >= 1);
    assert.equal(events[0].ev, "snapshot");
    assert.ok(Array.isArray(events[0].data.state.plugins));
    // plugin output change → plugin event
    writeFileSync(h.core.pluginMeta.get("t").file, PLUGIN.replace("status=ok", "status=block"));
    h.core.host.refresh("t");
    await waitFor(() => events.some((e) => e.ev === "plugin" && e.data.plugin.status === "block"));
    assert.equal(events.find((e) => e.ev === "plugin" && e.data.plugin.status === "block").data.status, "block");
    await curl(h.sock, "POST", "/estop", { on: true });
    await waitFor(() => events.some((e) => e.ev === "estop" && e.data.on === true));
    res.destroy();
  } finally {
    await h.stop();
  }
});

test("a second daemon on the same socket does not start", async () => {
  const h = await hub();
  try {
    const { startServer } = await import("../lib/server.mjs");
    await assert.rejects(() => startServer(h.core), /уже слушает/);
  } finally {
    await h.stop();
  }
});
