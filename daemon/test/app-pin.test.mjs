// App build pinning (decision 2026-11-05): ad hoc signature + requirements.app by the build's cdhash.
// System doubles (process table, csops, codesign) and the real codesign/peercred with an ad hoc client.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { cdhashRequirement, pinFingerprint, requirementSha, writeAppRequirement } from "../lib/app-pin.mjs";
import { parseCodesignDisplay } from "../lib/app-sign.mjs";
import { cleanup, curl, ensureNative, FILE_MODES, FIXTURES, onlyDarwin, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

// Hub notification: the subtitle is the gist (label), the body is the detail; the full text is "subtitle: body"
const bannerText = (c) => (c.args[8] ? `${c.args[8]}: ${c.args[6]}` : c.args[6]);

before(() => {
  ensureNative();
});

const AGENTHUB = join(DAEMON_DIR, "bin", "agenthub");
const REAL_CODESIGN = onlyDarwin("real codesign, clang and the peercred addon");
const BANNER = onlyDarwin("hub banner via osascript");
const APP_EXE = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const A = "a".repeat(40);
const B = "b".repeat(40);

const PLUGIN = `#!/bin/sh
# <agenthub.title>T</agenthub.title>
# <agenthub.action id="danger" level="confirm">/bin/echo danger</agenthub.action>
echo "T | status=ok"
echo "---"
echo "Danger | action=danger"
`;

const childEnv = (extra = {}) => {
  const e = { ...process.env, ...extra };
  delete e.NODE_OPTIONS;
  return e;
};

// ---------- pure functions ----------

test("cdhash requirement and fingerprints: cdhash, cert, other, none", () => {
  assert.equal(cdhashRequirement(A.toUpperCase()), `identifier "com.kensei.agenthub" and cdhash H"${A}"`);
  assert.throws(() => cdhashRequirement("abc"));
  assert.deepEqual(pinFingerprint(cdhashRequirement(A)), { kind: "cdhash", value: A, label: `cdhash:${A}` });
  assert.equal(pinFingerprint(`identifier "com.kensei.agenthub" and certificate leaf = H"${B}"`).label, `cert:${B}`);
  // the same cdhash but a broader requirement (or …) is not the canonical form: a different fingerprint
  const wide = `identifier "com.kensei.agenthub" and cdhash H"${A}" or identifier "x"`;
  assert.equal(pinFingerprint(wide).kind, "other");
  assert.notEqual(requirementSha(wide), requirementSha(cdhashRequirement(A)));
  assert.equal(pinFingerprint(null).label, "none");
});

test("parsing codesign -dvvv: identifier, CDHash, ad hoc", () => {
  const text = `Executable=/x/AgentHub.app/Contents/MacOS/AgentHub
Identifier=com.kensei.agenthub
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=48372 flags=0x10002(adhoc,runtime) hashes=1505+3 location=embedded
CandidateCDHash sha256=1347dd31e6cd68e8bc2f1d14281796fcecc09afd
CDHash=1347dd31e6cd68e8bc2f1d14281796fcecc09afd
Signature=adhoc
TeamIdentifier=not set
`;
  assert.deepEqual(parseCodesignDisplay(text), { identifier: "com.kensei.agenthub", cdhash: "1347dd31e6cd68e8bc2f1d14281796fcecc09afd", adhoc: true, authority: null, teamId: "not set" });
});

// ---------- doubles ----------

// The double's world: pid 10 is the old build (cdhash A), pid 11 the new one (B), pid 20 curl. state.who is who is on the socket.
function pinSys(state) {
  const procs = {
    10: { path: APP_EXE, cdhash: A },
    11: { path: APP_EXE, cdhash: B },
    20: { path: "/usr/bin/curl", cdhash: null },
  };
  const calls = [];
  return {
    calls,
    available: true,
    peerPid: () => state.who,
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: 1, uid: 501, startSec: 1, startUsec: 0, tty: false } : null),
    procArgv: () => null,
    // ad hoc: CS_VALID | CS_ADHOC, no Team ID
    codeInfo: (pid) => (procs[pid]?.cdhash ? { flags: 0x3, cdhash: procs[pid].cdhash, identity: "com.kensei.agenthub", teamId: null } : null),
    codesignVerify: async (target, requirement) => {
      calls.push({ target: String(target), requirement });
      const p = procs[Number(target)];
      return Boolean(p?.cdhash) && requirement === cdhashRequirement(p.cdhash);
    },
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
    writeJson: () => {},
  };
}

async function pinHub(state, opts = {}) {
  const plugins = tempHome("ah-pinpl-");
  writePlugin(plugins, "t.1h.sh", PLUGIN);
  const sys = pinSys(state);
  const h = await startHub({ pluginsDir: plugins, sys, ...opts });
  await waitFor(() => h.core.pluginState("t")?.body.length);
  h.sys = sys;
  h.danger = () => h.core.pluginState("t").body.find((b) => b.title === "Danger").offer.id;
  h.pin = (cdhash, meta = { by: "agenthub pin-app", under: "terminal" }) => writeAppRequirement(h.config.paths.config, cdhashRequirement(cdhash), meta);
  h.as = (pid) => {
    state.who = pid;
  };
  const stop = h.stop;
  h.stop = async () => {
    await stop();
    cleanup(plugins);
  };
  return h;
}

const changes = (h) => h.core.journal.tail(500).filter((e) => e.type === "app-requirement-changed");

test("double: the pinned build is app and gets 428; a new unpinned one gets 403 peer:app-signature; re-pinning without a restart", async () => {
  const state = { who: 10 };
  const h = await pinHub(state);
  try {
    // no requirement: a build from AgentHub.app is cli with a reason
    let r = await req(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:app-requirement-missing");

    h.pin(A);
    // the daemon was not restarted: the check before app classification reread config.json
    assert.equal((await req(h.sock, "GET", "/peer")).body.class, "app");
    r = await req(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(r.status, 428, JSON.stringify(r.body));
    assert.equal(r.body.error, "confirm-required");

    // rebuild without pinning: the new binary (pid 11, cdhash B) gets 403
    h.as(11);
    r = await req(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:app-signature");

    // re-pin to B: the new build is app, the old one (pid 10) gets 403
    h.pin(B);
    assert.equal((await req(h.sock, "POST", `/actions/${h.danger()}`)).status, 428);
    h.as(10);
    r = await req(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:app-signature");
    // curl is cli under any pin
    h.as(20);
    r = await req(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:cli");

    // journal: every change has the old and new fingerprint and "who"
    // Who noticed first, the check before classification (check) or the config.json watch (watch),
    // depends on whether fs.watch fired before the request; what matters is that each change is logged exactly once.
    const c = changes(h);
    const noticed = (src) => (src === "watch" ? "check" : src);
    assert.deepEqual(
      c.map((e) => [e.old, e.new, e.by, e.under, noticed(e.source)]),
      [
        ["none", `cdhash:${A}`, "agenthub pin-app", "terminal", "check"],
        [`cdhash:${A}`, `cdhash:${B}`, "agenthub pin-app", "terminal", "check"],
      ],
    );
    // the bus event (and SSE) and the snapshot
    const evs = h.core.recent.filter((e) => e.type === "app-pin.changed");
    assert.equal(evs.length, 2);
    assert.equal(evs[1].appPin.fingerprint, `cdhash:${B}`);
    assert.equal(evs[1].old, `cdhash:${A}`);
    const snap = (await req(h.sock, "GET", "/state")).body;
    assert.equal(snap.appPin.kind, "cdhash");
    assert.equal(snap.appPin.fingerprint, `cdhash:${B}`);
    assert.ok(Date.parse(snap.appPin.changedAt) > Date.now() - 60_000);
    assert.equal(snap.appPin.by, "agenthub pin-app");
    // the last seen requirement is in app-pin.json 0600
    const st = join(h.home, "app-pin.json");
    if (FILE_MODES) assert.equal(statSync(st).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(st, "utf8")).fingerprint, `cdhash:${B}`);
  } finally {
    await h.stop();
  }
});

test("double: the old build's connection is closed on re-pin (SSE too) and is no longer app", async () => {
  const state = { who: 10 };
  const h = await pinHub(state);
  try {
    h.pin(A);
    const ended = new Promise((resolve, reject) => {
      const r = request({ socketPath: h.sock, path: "/events", headers: { host: "hub" } }, (res) => {
        let first = true;
        res.on("data", () => {
          if (first) {
            first = false;
            h.pin(B); // fs.watch or polling will notice; the request below surely will
            req(h.sock, "GET", "/health").catch(() => {});
          }
        });
        res.on("close", () => resolve(true));
        res.on("error", () => resolve(true));
      });
      r.on("error", () => resolve(true));
      r.end();
      setTimeout(() => reject(new Error("the old build's SSE was not closed")), 8000).unref();
    });
    // /health from pid 10 is an app class candidate: the check before the request rereads the config
    assert.equal(await ended, true);
    const r = await req(h.sock, "POST", `/actions/${h.danger()}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:app-signature");
  } finally {
    await h.stop();
  }
});

test("double: a requirements.app change bypassing pin-app has an unknown \"who\"; a broken config.json does not remove the pin", async () => {
  const state = { who: 10 };
  const h = await pinHub(state);
  try {
    h.pin(A);
    assert.equal((await req(h.sock, "GET", "/peer")).body.class, "app");
    // config.json rewritten by hand or by an agent: appPin is from the previous requirement
    const cfg = JSON.parse(readFileSync(h.config.paths.config, "utf8"));
    cfg.requirements.app = cdhashRequirement(B);
    writeFileSync(h.config.paths.config, JSON.stringify(cfg));
    h.as(11);
    assert.equal((await req(h.sock, "GET", "/peer")).body.class, "app");
    const last = changes(h).at(-1);
    assert.equal(last.new, `cdhash:${B}`);
    assert.equal(last.by, "manual");
    // broken file: the requirement stays the same
    writeFileSync(h.config.paths.config, "{ не json");
    assert.equal((await req(h.sock, "GET", "/peer")).body.class, "app");
    // file deleted: the requirement is removed (as without config.json), so class app is unreachable
    writeFileSync(h.config.paths.config, "{}");
    const r = await req(h.sock, "GET", "/peer");
    assert.equal(r.body.class, "cli");
    assert.equal(r.body.reason, "peer:app-requirement-missing");
    assert.equal(changes(h).at(-1).new, "none");
  } finally {
    await h.stop();
  }
});

test("a change made while the daemon was down is noticed at start (source=start); a first run without a requirement is silent", async () => {
  const state = { who: 10 };
  const h = await pinHub(state);
  try {
    assert.equal(changes(h).length, 0, "no requirement and no app-pin.json: no entry");
    assert.equal(JSON.parse(readFileSync(join(h.home, "app-pin.json"), "utf8")).fingerprint, "none");
  } finally {
    await h.stop();
  }
  // a directory where app-pin.json remembers A but config.json already has B (rewritten while the daemon was stopped)
  const { loadConfig } = await import("../lib/config.mjs");
  const { Core } = await import("../lib/core.mjs");
  const { createPeer } = await import("../lib/peer.mjs");
  const dir = tempHome("ah-pinst-");
  try {
    writeFileSync(join(dir, "app-pin.json"), JSON.stringify({ requirementSha: requirementSha(cdhashRequirement(A)), fingerprint: `cdhash:${A}`, kind: "cdhash", changedAt: "2026-11-01T00:00:00.000Z" }), { mode: 0o600 });
    writeAppRequirement(join(dir, "config.json"), cdhashRequirement(B), { by: "agenthub pin-app", under: "claude-code" });
    const config = loadConfig({ env: { AGENTHUB_HOME: dir, AGENTHUB_BUILTIN_PLUGINS: join(dir, "none"), AGENTHUB_SERVICES: "none" } });
    const core = new Core({ config, peer: createPeer({ config, sys: pinSys(state) }) });
    const seen = [];
    core.on("app-pin.changed", (ev) => seen.push(ev));
    await core.init({ startPlugins: false });
    try {
      const c = core.journal.tail(50).filter((e) => e.type === "app-requirement-changed");
      assert.equal(c.length, 1);
      assert.deepEqual([c[0].old, c[0].new, c[0].by, c[0].under, c[0].source], [`cdhash:${A}`, `cdhash:${B}`, "agenthub pin-app", "claude-code", "start"]);
      assert.equal(seen.length, 1);
      assert.equal(core.snapshot().appPin.under, "claude-code");
    } finally {
      await core.stop();
    }
    // the same directory again: no change, no entry
    const core2 = new Core({ config: loadConfig({ env: { AGENTHUB_HOME: dir, AGENTHUB_BUILTIN_PLUGINS: join(dir, "none"), AGENTHUB_SERVICES: "none" } }), peer: createPeer({ config, sys: pinSys(state) }) });
    await core2.init({ startPlugins: false });
    try {
      assert.equal(core2.journal.tail(100).filter((e) => e.type === "app-requirement-changed").length, 1);
    } finally {
      await core2.stop();
    }
  } finally {
    cleanup(dir);
  }
});

function execLog(home) {
  const f = join(home, "exec.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("push: every requirements.app change notifies (first \"pinned\", then \"pinned again\", removal \"removed\")", { skip: BANNER }, async () => {
  const state = { who: 10 };
  const h = await pinHub(state, { services: "push", overrides: { services: { push: { ackTimeoutMs: 100 } } } });
  try {
    const { _engine } = await import("../lib/services/push.mjs");
    h.pin(A);
    await req(h.sock, "GET", "/peer");
    const osa = () => execLog(h.home).filter((c) => c.file === "/usr/bin/osascript");
    await waitFor(() => osa().length === 1);
    // the first pin (was none) is not "again"
    assert.match(bannerText(osa()[0]), /^Agent Hub закреплён: Из терминала · \d\d:\d\d\. Если это были не вы — откройте журнал$/);
    assert.equal(osa()[0].args[8], "Agent Hub закреплён", "the subtitle is the gist, not \"Agent Hub\" a second time");
    assert.equal(osa()[0].args[7], "Agent Hub");
    assert.equal(h.core.snapshot().appPin.old, "none");
    await _engine().idle();
    assert.equal(_engine().entries.get("@hub:app-pin-changed").active, false, "raised and cleared right away");
    // the next change notifies again (the rule has no debounce window)
    h.pin(B);
    h.as(11);
    await req(h.sock, "GET", "/peer");
    await waitFor(() => osa().length === 2);
    assert.match(bannerText(osa()[1]), /^Agent Hub закреплён заново: Из терминала/);
    assert.match(h.core.snapshot().appPin.old, /^cdhash:/);
    // removal (requirements.app removed bypassing pin-app) gives the removal title, with no repetition in the text
    const cfg = JSON.parse(readFileSync(h.config.paths.config, "utf8"));
    delete cfg.requirements.app;
    writeFileSync(h.config.paths.config, JSON.stringify(cfg), { mode: 0o600 });
    await req(h.sock, "GET", "/peer");
    await waitFor(() => osa().length === 3);
    assert.equal(bannerText(osa()[2]), "Закрепление Agent Hub снято: Подтверждения отключены. Если это были не вы — откройте журнал");
    // the banner bypasses the app: push.notify (and notifyId for /push/ack) is not sent, nothing to clear
    assert.equal(h.core.recent.some((e) => e.type === "push.notify" && e.key === "@hub:app-pin-changed"), false);
  } finally {
    await h.stop();
  }
});

test("push: a re-pin notification is not cleared by /push/ack from the pinned build; a change from under Claude Code shows in the text", { skip: BANNER }, async () => {
  const state = { who: 10 };
  // an ack would be awaited for a minute: an earlier banner means no waiting for confirmation
  const h = await pinHub(state, { services: "push", overrides: { services: { push: { ackTimeoutMs: 60_000, acceptCliAck: true } } } });
  try {
    const notifies = [];
    h.core.on("push.notify", (ev) => notifies.push(ev));
    const osa = () => execLog(h.home).filter((c) => c.file === "/usr/bin/osascript");
    h.pin(A, { by: "agenthub pin-app", under: "claude-code" });
    assert.equal((await req(h.sock, "GET", "/peer")).body.class, "app");
    await waitFor(() => osa().length === 1);
    assert.equal(notifies.length, 0, "the app has nothing to acknowledge");
    assert.match(bannerText(osa()[0]), /^Agent Hub закреплён: Из сессии Claude Code · \d\d:\d\d\. Если это были не вы — откройте журнал$/);
    // an ack with a foreign id clears nothing (and breaks nothing)
    const r = await req(h.sock, "POST", "/push/ack", { id: "0123456789abcdef" });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    // with an unknown under, the source is unknown
    h.pin(B, { by: "agenthub pin-app" });
    h.as(11);
    await req(h.sock, "GET", "/peer");
    await waitFor(() => osa().length === 2);
    assert.match(bannerText(osa()[1]), /: Откуда — неизвестно · \d\d:\d\d\. /);
  } finally {
    await h.stop();
  }
});

test("start: config.json changed between loadConfig and init: the new pin applies, in the journal and in the event", async () => {
  const { loadConfig } = await import("../lib/config.mjs");
  const { Core } = await import("../lib/core.mjs");
  const { createPeer } = await import("../lib/peer.mjs");
  const dir = tempHome("ah-pinrace-");
  const state = { who: 10 };
  const env = { AGENTHUB_HOME: dir, AGENTHUB_BUILTIN_PLUGINS: join(dir, "none"), AGENTHUB_SERVICES: "none" };
  try {
    // the daemon's previous life saw A
    writeAppRequirement(join(dir, "config.json"), cdhashRequirement(A), { by: "agenthub pin-app", under: "terminal" });
    writeFileSync(join(dir, "app-pin.json"), JSON.stringify({ requirementSha: requirementSha(cdhashRequirement(A)), fingerprint: `cdhash:${A}`, kind: "cdhash", changedAt: "2026-11-01T00:00:00.000Z" }), { mode: 0o600 });
    const config = loadConfig({ env });
    assert.equal(config.requirements.app, cdhashRequirement(A));
    // bundle.sh coincided with the restart: pin-app wrote B after loadConfig, before init
    writeAppRequirement(join(dir, "config.json"), cdhashRequirement(B), { by: "agenthub pin-app", under: "terminal" });
    const peer = createPeer({ config, sys: pinSys(state) });
    const core = new Core({ config, peer });
    const seen = [];
    core.on("app-pin.changed", (ev) => seen.push(ev));
    await core.init({ startPlugins: false });
    try {
      assert.equal(config.requirements.app, cdhashRequirement(B));
      const c = core.journal.tail(50).filter((e) => e.type === "app-requirement-changed");
      assert.deepEqual(c.map((e) => [e.old, e.new, e.source]), [[`cdhash:${A}`, `cdhash:${B}`, "start"]]);
      assert.equal(seen.length, 1);
      assert.equal(core.snapshot().appPin.fingerprint, `cdhash:${B}`);
      // the old build is not app, the new one is; a repeated check writes no duplicate
      assert.equal((await peer.classifyPid(10)).class, "cli");
      assert.equal((await peer.classifyPid(11)).class, "app");
      assert.equal(core.appPin.check("check"), false);
      assert.equal(core.journal.tail(50).filter((e) => e.type === "app-requirement-changed").length, 1);
    } finally {
      await core.stop();
    }
    // the file did not change after loadConfig: nothing is reread or written
    const config2 = loadConfig({ env });
    const core2 = new Core({ config: config2, peer: createPeer({ config: config2, sys: pinSys(state) }) });
    await core2.init({ startPlugins: false });
    try {
      assert.equal(core2.journal.tail(100).filter((e) => e.type === "app-requirement-changed").length, 1);
    } finally {
      await core2.stop();
    }
  } finally {
    cleanup(dir);
  }
});

// Requests over one keep-alive connection (like the app's URLSession).
function keepAliveClient(sock) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const send = (method, path) =>
    new Promise((resolve, reject) => {
      const r = request({ socketPath: sock, agent, method, path, headers: { host: "hub" } }, (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(s);
          } catch {}
          resolve({ status: res.statusCode, body, socket: r.socket });
        });
      });
      r.on("error", reject);
      r.end();
    });
  return { send, close: () => agent.destroy() };
}

test("double: the request itself noticed the change, so it gets a reply under the new pin, not ECONNRESET", async () => {
  const state = { who: 11 };
  const h = await pinHub(state);
  const c = keepAliveClient(h.sock);
  try {
    h.pin(A);
    const first = await c.send("GET", "/peer");
    assert.equal(first.body.class, "cli");
    assert.equal(first.body.reason, "peer:app-signature");
    // fs.watch and polling are off: only the check before this request will notice the change
    h.core.appPin.stop();
    for (let i = 0; i < 3; i++) {
      h.pin(i % 2 ? A : B);
      const r = await c.send("POST", `/actions/${h.danger()}`);
      if (i % 2) {
        assert.equal(r.status, 403);
        assert.equal(r.body.error, "peer:app-signature");
      } else {
        assert.equal(r.status, 428, JSON.stringify(r.body));
      }
      assert.equal(r.socket, first.socket, "the same connection");
    }
    assert.equal(changes(h).length, 4);
  } finally {
    c.close();
    await h.stop();
  }
});

// ---------- real codesign ----------

// An ad hoc client inside AgentHub.app; tag changes the binary content, giving another cdhash (like a rebuild).
function buildApp(dir, tag) {
  const app = join(dir, "AgentHub.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const exe = join(app, "Contents", "MacOS", "AgentHub");
  const tagFile = join(dir, "tag.txt");
  writeFileSync(tagFile, `build ${tag}\n`);
  execFileSync("/usr/bin/clang", ["-O1", "-o", exe, join(FIXTURES, "native", "client.c"), `-Wl,-sectcreate,__TEXT,__agtag,${tagFile}`]);
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
  execFileSync("/usr/bin/codesign", ["--force", "--options", "runtime", "-s", "-", "-i", "com.kensei.agenthub", app], { stdio: "ignore" });
  return { app, exe };
}

function runApp(exe, sock, method, path, body = "") {
  return new Promise((resolve, reject) => {
    execFile(exe, [sock, method, path, body], { timeout: 10_000 }, (err, out) => {
      if (err) return reject(err);
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1]);
      let parsed = null;
      try {
        parsed = JSON.parse(out.slice(out.indexOf("\r\n\r\n") + 4));
      } catch {}
      resolve({ status, body: parsed });
    });
  });
}

const pinApp = (home, app, ...extra) => spawnSync(process.execPath, [AGENTHUB, "pin-app", app, ...extra], { encoding: "utf8", env: childEnv({ AGENTHUB_HOME: home, AGENTHUB_SYSTEM_LANG: "en" }) });
const cdhashOf = (app) => /^CDHash=([0-9a-f]{40})$/m.exec(spawnSync("/usr/bin/codesign", ["-dvvv", app], { encoding: "utf8" }).stderr)?.[1];

test("agenthub pin-app: identifier + build CDHash in config.json (0600), --dry-run writes nothing, a foreign identifier is refused", { skip: REAL_CODESIGN }, () => {
  const dir = tempHome("ah-pinc-");
  try {
    const { app } = buildApp(dir, "one");
    const home = join(dir, "home");
    let r = pinApp(home, app, "--dry-run");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--dry-run: nothing written/);
    assert.equal(existsSync(join(home, "config.json")), false);
    r = pinApp(home, app);
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    assert.equal(cfg.requirements.app, cdhashRequirement(cdhashOf(app)));
    assert.equal(cfg.appPin.by, "agenthub pin-app");
    assert.equal(cfg.appPin.requirementSha, requirementSha(cfg.requirements.app));
    assert.equal(statSync(join(home, "config.json")).mode & 0o777, 0o600);
    // a repeat changes nothing; --dry-run says the same
    r = pinApp(home, app, "--dry-run");
    assert.match(r.stdout, /already pinned/);
    r = pinApp(home, app);
    assert.match(r.stdout, /already pinned/);
    // identifier is not com.kensei.agenthub: refused, the config is unchanged
    execFileSync("/usr/bin/codesign", ["--force", "-s", "-", "-i", "com.example.other", app], { stdio: "ignore" });
    r = pinApp(home, app);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /identifier/);
    assert.equal(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).requirements.app, cfg.requirements.app);
  } finally {
    cleanup(dir);
  }
});

test("real codesign: the pinned ad hoc build is app and gets 428; a rebuild without pinning gets 403; re-pinning without a restart; curl gets 403", { skip: REAL_CODESIGN }, async () => {
  const dir = tempHome("ah-pinr-");
  const plugins = tempHome("ah-pinrp-");
  writePlugin(plugins, "t.1h.sh", PLUGIN);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("t")?.body.length);
    const danger = h.core.pluginState("t").body.find((b) => b.title === "Danger").offer.id;
    mkdirSync(join(dir, "one"));
    mkdirSync(join(dir, "two"));
    const one = buildApp(join(dir, "one"), "one");
    const two = buildApp(join(dir, "two"), "two");
    assert.notEqual(cdhashOf(one.app), cdhashOf(two.app));

    // pinning via the CLI into this daemon's directory
    assert.equal(pinApp(h.home, one.app).status, 0);
    assert.equal((await runApp(one.exe, h.sock, "GET", "/peer")).body.class, "app");
    const c428 = await runApp(one.exe, h.sock, "POST", `/actions/${danger}`);
    assert.equal(c428.status, 428);
    assert.equal(c428.body.error, "confirm-required");

    // a new unpinned build gets 403 peer:app-signature
    let r = await runApp(two.exe, h.sock, "POST", `/actions/${danger}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:app-signature");

    // re-pin: the daemon was not restarted
    assert.equal(pinApp(h.home, two.app).status, 0);
    assert.equal((await runApp(two.exe, h.sock, "POST", `/actions/${danger}`)).status, 428);
    r = await runApp(one.exe, h.sock, "POST", `/actions/${danger}`);
    assert.equal(r.status, 403, "the old build after re-pinning gets 403");
    assert.equal(r.body.error, "peer:app-signature");

    // curl gets 403 under any pin
    r = await curl(h.sock, "POST", `/actions/${danger}`);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:cli");

    const c = changes(h);
    assert.deepEqual(c.map((e) => e.new), [`cdhash:${cdhashOf(one.app)}`, `cdhash:${cdhashOf(two.app)}`]);
    assert.ok(c.every((e) => e.by === "agenthub pin-app"));
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(dir);
  }
});

test("real codesign: a copy of the pinned build with a modified Info.plist gets 403 even after the real one has connected", { skip: REAL_CODESIGN }, async () => {
  const dir = tempHome("ah-pincp-");
  const plugins = tempHome("ah-pincpp-");
  const h = await startHub({ pluginsDir: plugins });
  try {
    mkdirSync(join(dir, "one"));
    const one = buildApp(join(dir, "one"), "one");
    assert.equal(pinApp(h.home, one.app).status, 0);
    // the real build connected first: the verdict is cached
    assert.equal((await runApp(one.exe, h.sock, "GET", "/peer")).body.class, "app");
    // a bundle copy: the same executable (same cdhash), Info.plist with an extra key, so the seal does not match
    const copy = join(dir, "copy", "AgentHub.app");
    mkdirSync(join(dir, "copy"));
    execFileSync("/bin/cp", ["-R", one.app, copy]);
    const plist = join(copy, "Contents", "Info.plist");
    writeFileSync(plist, readFileSync(plist, "utf8").replace("</dict>", "<key>NSMainNibFile</key><string>X</string>\n</dict>"));
    const exe = join(copy, "Contents", "MacOS", "AgentHub");
    assert.equal(cdhashOf(copy), cdhashOf(one.app));
    const r = await runApp(exe, h.sock, "GET", "/peer");
    assert.equal(r.body.class, "cli");
    assert.equal(r.body.reason, "peer:app-signature");
    // the real one is still app
    assert.equal((await runApp(one.exe, h.sock, "GET", "/peer")).body.class, "app");
  } finally {
    await h.stop();
    cleanup(plugins);
    cleanup(dir);
  }
});
