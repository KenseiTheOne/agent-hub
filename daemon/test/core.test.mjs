// The core over HTTP on a socket, with a system double (the peer class is set by the test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { sanitize } from "../lib/journal.mjs";
import { setLangSource } from "../lib/i18n.mjs";
import { loadRoutes } from "../lib/server.mjs";
import { actionLevel } from "../lib/core.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const HOOK = "/Users/u/.claude/plugins/x/agenthub-hook";

// Double: every connection is process `who` (app | cli | hook).
function sysAs(state) {
  const procs = {
    10: { ppid: 1, path: APP },
    20: { ppid: 1, path: "/usr/bin/curl" },
    30: { ppid: 31, path: "/opt/homebrew/bin/node", argv: ["node", HOOK] },
    31: { ppid: 1, path: CLAUDE },
    40: { ppid: 1, path: CLAUDE }, // a Claude Code session
    41: { ppid: 1, path: "/bin/sleep" }, // a "session" with a forged file
  };
  const pidOf = { app: 10, cli: 20, hook: 30 };
  return {
    available: true,
    peerPid: () => pidOf[state.who],
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codesignVerify: async (path) => path === APP || path === CLAUDE,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

const overrides = {
  requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' },
  peer: { hookPaths: [HOOK] },
};

const PLUGIN = `#!/bin/sh
# <agenthub.title>T</agenthub.title>
# <agenthub.effects>open.url,session.stop</agenthub.effects>
# <agenthub.action id="ping" level="immediate">/bin/echo ping</agenthub.action>
# <agenthub.action id="danger" level="confirm" cost="наружу">/bin/echo danger</agenthub.action>
echo "T | status=wait"
echo "---"
echo "Ping | action=ping"
echo "Danger | action=danger"
echo "Open | effect='open.url https://example.com/p'"
echo "Stop | effect='session.stop pid=40'"
echo "Сессия | session=11111111-1111-4111-8111-111111111111 pid=40 sessionStatus=waiting"
echo "Фальшивка | session=22222222-2222-4222-8222-222222222222 pid=41 sessionStatus=waiting"
echo "Ev | event=run-blocked"
`;

const THIRD = `#!/bin/sh
# <agenthub.title>Чужой</agenthub.title>
# <agenthub.effects>open.url,cmux.focus,session.focus,session.stop,batch.stop</agenthub.effects>
# <agenthub.action id="x" level="immediate">/bin/echo x</agenthub.action>
echo "Чужой | status=ok"
echo "---"
echo "A | effect='session.stop pid=40'"
echo "B | action=x"
echo "C | effect='open.url https://example.com'"
`;

async function hub(state, extra = {}) {
  const plugins = tempHome("ah-pl-");
  writePlugin(plugins, "t.1h.sh", PLUGIN);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state), ...extra });
  const origStop = h.stop;
  h.stop = async () => {
    await origStop();
    cleanup(plugins);
  };
  h.offer = (pluginId, title) => {
    const p = h.core.pluginState(pluginId);
    return p?.body.find((b) => b.title === title)?.offer;
  };
  // setup failure — stop the hub: otherwise the server and timers hold the process, and the file hangs instead of failing
  try {
    await waitFor(() => h.core.pluginState("t")?.header.length);
  } catch (e) {
    await h.stop();
    throw e;
  }
  return h;
}

// a test double of session.stop: the module declares immediate, the core still requires app.
// The real lib/primitives/session.stop.mjs (stage 5) is already loaded at init — remove it, otherwise it is a duplicate.
function registerFakeStop(core, calls) {
  core.primitives.delete("session.stop");
  core.registerPrimitive({
    name: "session.stop",
    level: "immediate",
    argsSchema: { pid: { type: "integer", required: true } },
    verifyFacts: (args, facts) => (facts.sessionByPid(args.pid) ? { ok: true } : { ok: false, reason: "unknown-session" }),
    run: async (args) => {
      calls.push(args);
      return { ok: true };
    },
  });
}

test("worst status, waiting sessions, authenticity of sessions from plugin output", async () => {
  const state = { who: "cli" };
  const h = await hub(state);
  try {
    const st = (await req(h.sock, "GET", "/state")).body;
    assert.equal(st.status, "wait");
    assert.equal(st.peer.class, "cli");
    await waitFor(() => h.core.sessions.list().length === 1);
    const s = (await req(h.sock, "GET", "/state")).body;
    assert.equal(s.waitingSessions, 1);
    assert.deepEqual(
      s.sessions.map((x) => x.sessionId),
      ["11111111-1111-4111-8111-111111111111"],
    );
    await waitFor(() => h.core.pluginState("t").body.find((b) => b.title === "Фальшивка").session.verified === false);
    const fake = h.core.pluginState("t").body.find((b) => b.title === "Фальшивка");
    assert.equal(fake.session.label, "подпись не подтверждена");
    assert.equal(h.core.pluginState("t").body.find((b) => b.title === "Сессия").session.verified, true);
    assert.deepEqual(h.core.pluginState("t").events, ["run-blocked"]);
  } finally {
    await h.stop();
  }
});

test("levels: cli — immediate only; confirm and app-only primitives — 403 peer:cli", async () => {
  const state = { who: "cli" };
  const h = await hub(state);
  const calls = [];
  registerFakeStop(h.core, calls);
  try {
    h.core.host.refresh("t");
    await waitFor(() => h.offer("t", "Stop"));
    assert.equal((await req(h.sock, "POST", `/actions/${h.offer("t", "Ping").id}`)).status, 200);
    const d = await req(h.sock, "POST", `/actions/${h.offer("t", "Danger").id}`);
    assert.equal(d.status, 403);
    assert.equal(d.body.error, "peer:cli");
    const s = await req(h.sock, "POST", `/actions/${h.offer("t", "Stop").id}`);
    assert.equal(s.status, 403);
    assert.equal(s.body.error, "peer:cli");
    const direct = await req(h.sock, "POST", "/actions/session.stop", { args: { pid: 40 } });
    assert.equal(direct.status, 403);
    assert.equal(calls.length, 0);
    const o = await req(h.sock, "POST", `/actions/${h.offer("t", "Open").id}`);
    assert.equal(o.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, "exec.log"), "utf8").trim()), { file: "/usr/bin/open", args: ["https://example.com/p"] });
    assert.equal((await req(h.sock, "POST", "/actions/nope")).status, 404);
  } finally {
    await h.stop();
  }
});

test("app: confirmation — the token is one-time, the core writes the text; checking against facts", async () => {
  const state = { who: "app" };
  const h = await hub(state);
  const calls = [];
  registerFakeStop(h.core, calls);
  try {
    const id = h.offer("t", "Danger").id;
    const first = await req(h.sock, "POST", `/actions/${id}`);
    assert.equal(first.status, 428);
    assert.equal(first.body.needsConfirm, true);
    assert.match(first.body.text, /echo danger/);
    assert.equal(first.body.cost, "наружу");
    const ok = await req(h.sock, "POST", `/actions/${id}`, { confirmToken: first.body.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    const again = await req(h.sock, "POST", `/actions/${id}`, { confirmToken: first.body.token });
    assert.equal(again.status, 403);
    assert.equal(again.body.error, "confirm:invalid");
    // a token from one action does not fit another
    const t2 = (await req(h.sock, "POST", `/actions/${id}`)).body.token;
    const other = await req(h.sock, "POST", `/actions/${h.offer("t", "Ping").id}`, { confirmToken: t2 });
    assert.equal(other.status, 200); // immediate needs no token
    // an app-only primitive from app passes, but the facts are checked
    await waitFor(() => h.core.sessions.list().length === 1);
    assert.equal((await req(h.sock, "POST", "/actions/session.stop", { args: { pid: 40 } })).status, 200);
    const bad = await req(h.sock, "POST", "/actions/session.stop", { args: { pid: 41 } });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error, "facts:unknown-session");
    const badArgs = await req(h.sock, "POST", "/actions/session.stop", { args: { pid: "x" } });
    assert.equal(badArgs.status, 400);
    assert.equal((await req(h.sock, "POST", "/actions/session.stop", { args: { pid: 40, extra: 1 } })).body.error, "args:extra:unknown");
    assert.deepEqual(calls, [{ pid: 40 }]);
  } finally {
    await h.stop();
  }
});

test("ESTOP: the file blocks actions except the safe open.*; clearing it — app only", async () => {
  const state = { who: "app" };
  const h = await hub(state);
  try {
    const events = [];
    h.core.on("estop", (e) => events.push(e.on));
    writeFileSync(h.config.paths.estop, "manual\n");
    await waitFor(() => events.includes(true), { timeoutMs: 7000 });
    const ping = await req(h.sock, "POST", `/actions/${h.offer("t", "Ping").id}`);
    assert.equal(ping.status, 423);
    assert.equal(ping.body.error, "estop");
    assert.equal((await req(h.sock, "POST", `/actions/${h.offer("t", "Open").id}`)).status, 200);
    state.who = "cli";
    assert.equal((await req(h.sock, "POST", "/estop", { on: false })).status, 403);
    state.who = "app";
    // a new connection to change the class
    assert.equal((await req(h.sock, "POST", "/estop", { on: false })).status, 200);
    assert.equal(existsSync(h.config.paths.estop), false);
    assert.equal((await req(h.sock, "POST", `/actions/${h.offer("t", "Ping").id}`)).status, 200);
  } finally {
    await h.stop();
  }
});

// 2026-11-09: a plugin mode switch without a window — an official plugin without network may declare immediate
const OFFI = `#!/bin/sh
# <agenthub.title>Официальный</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.action id="mode" level="immediate" title="Режим">/bin/echo mode</agenthub.action>
# <agenthub.action id="spend" level="confirm-cost" title="Потратить" cost="квота">/bin/echo spend</agenthub.action>
echo "Официальный | status=ok"
echo "---"
echo "M | action=mode"
echo "S | action=spend"
`;

test("official plugin: immediate without network — no confirmation window, but only from the app and journaled", async () => {
  const state = { who: "app" };
  const plugins = tempHome("ah-pl-");
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state) });
  try {
    h.core.setPluginPolicy(async () => ({ allowed: true, effects: [], tier: "official" }));
    mkdirSync(join(h.config.paths.plugins, "offi"), { recursive: true });
    writePlugin(join(h.config.paths.plugins, "offi"), "offi.1h.sh", OFFI);
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("offi")?.body.length);
    const st = h.core.pluginState("offi");
    assert.equal(st.tier, "official");
    assert.deepEqual(st.actions.map((a) => [a.id, a.level]), [["mode", "immediate"], ["spend", "confirm-cost"]]);
    const mode = st.body.find((b) => b.title === "M").offer;
    assert.equal(mode.level, "immediate");
    assert.equal(mode.appOnly, true, "the shell knows: only the pinned build");
    // app — 200 right away, without 428 and a token
    const ok = await req(h.sock, "POST", `/actions/${mode.id}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    const j = h.core.journal.tail(50);
    assert.ok(j.some((e) => e.type === "action" && e.plugin === "offi" && e.actionId === "mode" && e.peer === "app"), "the run is in the journal");
    assert.ok(!j.some((e) => e.type === "action-confirm-requested" && e.actionId === "mode"));
    // cost — still with a window
    const spend = st.body.find((b) => b.title === "S").offer;
    assert.equal((await req(h.sock, "POST", `/actions/${spend.id}`)).status, 428);
    // cli (an agent, a script) cannot press even immediate
    state.who = "cli";
    const cli = await req(h.sock, "POST", `/actions/${mode.id}`);
    assert.equal(cli.status, 403);
    assert.equal(cli.body.error, "peer:cli");
    // not official (community) — immediate is raised to confirm (and it has no actions at all)
    assert.equal(actionLevel({ source: "installed", meta: { net: [] }, granted: { official: false } }, { level: "immediate" }), "confirm");
    assert.equal(actionLevel({ source: "installed", meta: { net: ["api.x — y"] }, granted: { official: true } }, { level: "immediate" }), "confirm-cost", "with network — the core adds the cost");
    // review 2026-11-09 (low): a declared cost (cost= in any language) — a window with the cost even without network; without a cost — as declared
    const offi = { source: "installed", meta: { net: [] }, granted: { official: true } };
    assert.equal(actionLevel(offi, { level: "immediate", cost: "квота Claude" }), "confirm-cost");
    assert.equal(actionLevel(offi, { level: "immediate", cost: null, i18n: { en: { cost: "Claude quota" } } }), "confirm-cost");
    assert.equal(actionLevel(offi, { level: "confirm", cost: "квота" }), "confirm-cost");
    assert.equal(actionLevel(offi, { level: "immediate", cost: null, i18n: { en: { title: "Mode" } } }), "immediate");
    assert.equal(actionLevel({ source: "builtin", meta: { net: [] } }, { level: "immediate", cost: "x" }), "immediate", "builtin — as declared");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("third-party plugin: effects are cut down to open.*, cmux.focus and session.focus; community actions at least confirm, local — none", async () => {
  const state = { who: "app" };
  const plugins = tempHome("ah-pl-");
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state) });
  try {
    // there is no plugins service in this setup: without a policy installed plugins are not admitted (policy:no-manager) — we provide
    // a policy double that overrides nothing (like the manager for a lock entry without official)
    h.core.setPluginPolicy(async () => null);
    mkdirSync(join(h.config.paths.plugins, "third"), { recursive: true });
    writePlugin(join(h.config.paths.plugins, "third"), "third.1h.sh", THIRD);
    mkdirSync(h.config.paths.pluginsLocal, { recursive: true });
    writePlugin(h.config.paths.pluginsLocal, "loc.1h.sh", THIRD.replace("Чужой", "Локальный"));
    await h.core.host.rescan();
    await waitFor(() => h.core.pluginState("third")?.body.length && h.core.pluginState("loc")?.body.length);
    const t = h.core.pluginState("third");
    assert.equal(t.source, "installed");
    assert.equal(t.trusted, false);
    assert.deepEqual(t.effects, ["open.url", "cmux.focus", "session.focus"]);
    // G3: a community plugin has actions — immediate raised to confirm, app only
    assert.deepEqual(t.actions, [{ id: "x", level: "confirm", title: null, arg: null }]);
    assert.equal(t.body.find((b) => b.title === "A").offer, undefined);
    const b = t.body.find((x) => x.title === "B").offer;
    assert.equal(b.level, "confirm");
    assert.equal(b.appOnly, true);
    assert.equal(t.body.find((b) => b.title === "C").offer.primitive, "open.url");
    const l = h.core.pluginState("loc");
    assert.equal(l.source, "local");
    assert.deepEqual(l.effects, ["open.url"]);
    assert.deepEqual(l.actions, [], "local — no actions");
    const warn = h.core.journal.tail(200).filter((e) => e.type === "warning" && e.plugin === "third").map((e) => e.detail);
    assert.ok(warn.some((w) => w.includes("session.stop")));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("hook: hook class only, session_id must match; the response comes from the extension's handler", async () => {
  const state = { who: "hook" };
  const h = await hub(state);
  try {
    writeFileSync(join(h.claudeHome, "sessions", "31.json"), JSON.stringify({ pid: 31, sessionId: "33333333-3333-4333-8333-333333333333" }));
    const body = { session_id: "33333333-3333-4333-8333-333333333333", hook_event_name: "PermissionRequest", tool_input: { command: "секрет" } };
    let r = await req(h.sock, "POST", "/hook", body);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, {});
    h.core.onHook((b, { peer }) => (b.hook_event_name === "PermissionRequest" ? { seen: peer.claudePid } : undefined));
    r = await req(h.sock, "POST", "/hook", body);
    assert.deepEqual(r.body, { seen: 31 });
    const mism = await req(h.sock, "POST", "/hook", { ...body, session_id: "44444444-4444-4444-8444-444444444444" });
    assert.equal(mism.status, 403);
    assert.equal(mism.body.error, "peer:session-mismatch");
    // hook does not read the state
    assert.equal((await req(h.sock, "GET", "/state")).status, 403);
    // ESTOP → {}
    writeFileSync(h.config.paths.estop, "x");
    r = await req(h.sock, "POST", "/hook", body);
    assert.deepEqual(r.body, {});
    rmSync(h.config.paths.estop);
    // no tool_input in the journal
    const j = readFileSync(h.config.paths.journal, "utf8");
    assert.ok(!j.includes("секрет"));
    assert.ok(j.includes('"claudePid":31'));
  } finally {
    await h.stop();
  }
});

test("journal: metadata only", () => {
  const s = sanitize({ type: "x", tool_input: { command: "rm" }, prompt: "текст", nested: { a: 1 }, long: "a".repeat(500), list: [1, "b", { c: 1 }], ok: true });
  assert.equal(s.tool_input, "[hidden]");
  assert.equal(s.prompt, "[hidden]");
  // the placeholder is written in the hub language
  setLangSource(() => "ru");
  try {
    assert.equal(sanitize({ prompt: "x" }).prompt, "[скрыто]");
  } finally {
    setLangSource(null);
  }
  assert.equal("nested" in s, false);
  assert.ok(s.long.length <= 201);
  assert.deepEqual(s.list, [1, "b"]);
  assert.equal(s.ok, true);
});

test("extension points: a route with classes, services, primitives from a directory", async () => {
  const state = { who: "cli" };
  const h = await hub(state);
  const ext = tempHome("ah-ext-");
  try {
    writeFileSync(
      join(ext, "demo.mjs"),
      `export const routes = [
  { method: "GET", path: "/demo/:x", peers: ["app"], handler: ({ params }) => ({ status: 200, body: { x: params.x } }) },
  { method: "GET", path: "/demo-cli", peers: ["cli"], handler: ({ ctx }) => ({ status: 200, body: { name: ctx.name, keys: Object.keys(ctx).sort() } }) },
  { method: "GET", path: "/state", peers: ["cli"], handler: () => ({ status: 200, body: {} }) },
];`,
    );
    writeFileSync(join(ext, "_skip.mjs"), `throw new Error("не должен грузиться")`);
    const routes = await loadRoutes(h.core, ext);
    assert.ok(routes.some((r) => r.path === "/demo/:x"));
    assert.equal(routes.filter((r) => r.path === "/state").length, 1, "a builtin route is not overridden");
    const svc = tempHome("ah-svc-");
    writeFileSync(join(svc, "svc.mjs"), `export const name = "svc"; export let got = null; export async function start(ctx) { got = ctx; ctx.emit({ type: "svc.hello" }); } export async function stop() {}`);
    writeFileSync(join(svc, "off.mjs"), `export const name = "off"; export async function start() { throw new Error("не должен стартовать"); }`);
    const seen = [];
    h.core.on("svc.hello", (e) => seen.push(e));
    h.core.config.servicesFilter = null;
    h.core.config.services = { off: { enabled: false } };
    await h.core.startServices(svc);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, "service:svc");
    const prim = tempHome("ah-prim-");
    writeFileSync(join(prim, "demo.ping.mjs"), `export const name = "demo.ping"; export const level = "immediate"; export const argsSchema = {}; export async function run() { return { ok: true, n: 1 }; }`);
    await h.core.loadPrimitives(prim);
    const r = await req(h.sock, "POST", "/actions/demo.ping", {});
    assert.equal(r.status, 200);
    assert.equal(r.body.result.n, 1);
    cleanup(svc);
    cleanup(prim);
  } finally {
    await h.stop();
    cleanup(ext);
  }
});

test("corrupted plugin output gives unknown, a crash gives error and a plugin-error event", async () => {
  const state = { who: "cli" };
  const plugins = tempHome("ah-pl-");
  writePlugin(plugins, "empty.1h.sh", "#!/bin/sh\nexit 0\n");
  writePlugin(plugins, "crash.1h.sh", "#!/bin/sh\necho 'X | status=ok'\nexit 2\n");
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs(state) });
  try {
    await waitFor(() => h.core.pluginState("empty")?.lastRunAt && h.core.pluginState("crash")?.lastRunAt);
    assert.equal(h.core.pluginState("empty").status, "unknown");
    assert.equal(h.core.pluginState("crash").status, "error");
    assert.equal(h.core.pluginState("crash").error, "exit 2");
    assert.deepEqual(h.core.pluginState("crash").events, ["plugin-error"]);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("stopping the daemon in the middle of a standard run kills the plugin's process group", async () => {
  const plugins = tempHome("ah-pl-");
  const pidFile = join(plugins, "child.pid");
  writePlugin(plugins, "slow.1h.sh", `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nsleep 30\n`);
  const h = await startHub({ pluginsDir: plugins, overrides, sys: sysAs({ who: "cli" }) });
  try {
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
    const child = Number(readFileSync(pidFile, "utf8").trim());
    await h.stop();
    await waitFor(() => {
      try {
        process.kill(child, 0);
        return false;
      } catch {
        return true;
      }
    });
  } finally {
    cleanup(plugins);
  }
});
