// Built-in plugins (exactly three: claude-sessions, agents, quota) and the core contract: metadata (permissions with why), discovery
// by the host, a run through the real daemon on a synthetic HOME — sessions, workflows and quota are visible in GET /state with
// tier builtin; a session with the pid of a plain sleep is "not Claude Code". hermes and clickup are official plugins from the
// agent-hub-plugins registry; third-party plugins (e.g. a runner plugin) come from an own source (tier own, a folder in their repository);
// none of them are in the application's catalog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readPluginMeta, splitWhy } from "../lib/meta.mjs";
import { scanDir } from "../lib/host.mjs";
import { startHub, req, waitFor, IS_DARWIN } from "./helpers.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS = join(REPO, "plugins");
const FILES = {
  agents: join(PLUGINS, "agents/agents.mjs"),
  "claude-sessions": join(PLUGINS, "claude-sessions/claude-sessions.mjs"),
  quota: join(PLUGINS, "quota/quota.5m.mjs"),
};
// claude-sessions is declared for macOS only (agenthub.platforms): the host doesn't run it on other platforms.
const LIVE = Object.keys(FILES).filter((id) => IS_DARWIN || id !== "claude-sessions");

test("built-in plugins: metadata per contract, permissions with why, effects only open.* (claude-sessions — sessions too)", () => {
  for (const [id, file] of Object.entries(FILES)) {
    const pm = readPluginMeta(file);
    assert.ok(pm, id);
    assert.equal(pm.id, id);
    assert.deepEqual(pm.warnings, [], id);
    const m = pm.meta;
    assert.ok(m.title && m.version && m.desc, id);
    assert.ok(m.platforms.includes("macos"), id);
    assert.deepEqual(m.actions, [], `${id}: read-only plugins have no actions`);
    // the built-in claude-sessions also offers switching to the tab, interrupting and stopping a session; agents — the tab
    const allowed =
      id === "claude-sessions" ? /^(open\.(url|file)|cmux\.focus|session\.(interrupt|stop))$/ : id === "agents" ? /^cmux\.focus$/ : /^open\.(url|file)$/;
    for (const e of m.effects) assert.match(e, allowed, id);
    for (const k of ["fsRead", "fsWrite", "exec", "secrets", "net", "watch"]) {
      for (const entry of m[k]) assert.ok(splitWhy(entry).why, `${id}: ${k} without why: ${entry}`);
    }
    assert.deepEqual(m.fsWrite, [], `${id}: plugins only read`);
    assert.deepEqual(m.net, [], `${id}: no network`);
    // no conversations, no keys (agents is built in and not part of the registry: workflow metadata lives in
    // ~/.claude/projects, but only results, usage and requestId are read)
    // claude-sessions reads only the last turn's effort fields from the session transcript (file tail, no text)
    for (const entry of m.fsRead) {
      const what = splitWhy(entry).what;
      if (id === "claude-sessions" && what === "~/.claude/projects/*/<sessionId>.jsonl") continue;
      assert.doesNotMatch(what, id === "agents" ? /workstream\.jsonl|\.key$|\.env|auth\.json/ : /\.claude\/projects|workstream\.jsonl|\.key$|\.env|auth\.json/, id);
    }
  }
  assert.equal(readPluginMeta(FILES["claude-sessions"]).meta.type, "streamable");
  assert.equal(readPluginMeta(FILES.agents).meta.type, "streamable");
  assert.equal(readPluginMeta(FILES.quota).intervalMs, 300_000);
});

test("built-in plugins: the host finds all three, fixtures aren't picked up", () => {
  const { plugins } = scanDir(PLUGINS, "builtin");
  const ids = plugins.map((p) => p.id);
  for (const id of Object.keys(FILES)) assert.equal(ids.filter((x) => x === id).length, 1, id);
  for (const p of plugins) assert.doesNotMatch(p.file, /\/fixtures\//);
  for (const [id, file] of Object.entries(FILES)) assert.equal(plugins.find((p) => p.id === id).file, file);
  assert.deepEqual(ids.sort(), Object.keys(FILES).sort(), "exactly three built-ins");
});

test("built-in plugins via the daemon: sessions, workflows and quota in /state, tier builtin; sleep pid — not Claude Code", { timeout: 60_000 }, async () => {
  // synthetic HOME: the daemon passes its own process's HOME to plugins
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-pl-")));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude/sessions"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  // quota comes from the core's usage service: a security double and an api.anthropic.com double on 127.0.0.1
  const fx = JSON.parse(readFileSync(join(PLUGINS, "quota/fixtures/usage-normal.json"), "utf8"));
  const api = createServer((rq, rs) => {
    rs.writeHead(200, { "content-type": "application/json" });
    rs.end(JSON.stringify({ limits: fx.rows.map((r) => ({ ...r, resets_at: r.kind === "session" ? new Date(Date.now() + 3_600_000).toISOString() : new Date(Date.now() + 3 * 86_400_000).toISOString() })) }));
  });
  const sleeper = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
  const prevHome = process.env.HOME;
  let h;
  // everything after listen is under finally: if setup fails, an unclosed server would keep the file's run from finishing
  try {
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    writeFileSync(join(root, "cred.json"), JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: Date.now() + 3_600_000 } }));
    writeFileSync(join(root, "security"), `#!/bin/sh\ncat '${join(root, "cred.json")}'\n`);
    chmodSync(join(root, "security"), 0o755);
    const agents = JSON.parse(readFileSync(join(PLUGINS, "claude-sessions/fixtures/agents.json"), "utf8").replaceAll("{{HOME}}", home).replace(/\{\{PID_\w+\}\}/g, String(sleeper.pid))).slice(0, 1);
    writeFileSync(join(root, "agents.out"), JSON.stringify(agents));
    // claude double in ~/.local/bin — first in the plugin's PATH
    writeFileSync(join(home, ".local/bin/claude"), `#!/bin/sh\ncat '${join(root, "agents.out")}'\n`);
    chmodSync(join(home, ".local/bin/claude"), 0o755);
    // only these three plugins (plugins/ also has others — they don't belong here)
    const only = join(root, "plugins");
    for (const id of Object.keys(FILES)) cpSync(join(PLUGINS, id), join(only, id), { recursive: true });
    process.env.HOME = home;
    h = await startHub({ pluginsDir: only, services: "usage", overrides: { services: { usage: { securityPath: join(root, "security"), url: `http://127.0.0.1:${api.address().port}/api/oauth/usage`, firstDelayMs: 10 } } } });
    const st = await waitFor(
      async () => {
        const r = await req(h.sock, "GET", "/state");
        const ids = Object.fromEntries(r.body.plugins.map((p) => [p.id, p]));
        if (ids.quota && ids.quota.header?.[0]?.params?.tile !== "20%") h.core.host.refresh("quota", "Manual");
        const ready = LIVE.every((id) => ids[id]?.lastRunAt) && ids.quota.header?.[0]?.params?.tile === "20%";
        const sess = ids["claude-sessions"]?.body?.find((i) => i.session);
        return ready && (!IS_DARWIN || (sess && sess.session.verified === false)) ? ids : null;
      },
      { timeoutMs: 30_000, stepMs: 200 },
    );
    for (const id of LIVE) {
      assert.equal(st[id].tier, "builtin", id);
      assert.equal(st[id].trusted, true, id);
    }
    assert.match(st.agents.header[0].title, /прогон|Прогон/);
    assert.equal(st.agents.title, "Фоновые агенты");
    assert.match(st.quota.header[0].title, /Неделя 20%/);
    assert.equal(st.quota.header[0].params.tile, "20%");
    if (IS_DARWIN) {
      assert.equal(st["claude-sessions"].type, "streamable");
      assert.match(st["claude-sessions"].header[0].title, /работает|работают|ждёт|ждут|свободны|Сессий нет/);
      const sess = st["claude-sessions"].body.find((i) => i.session);
      assert.equal(sess.session.pid, sleeper.pid);
      assert.equal(sess.session.label, "подпись не подтверждена");
    } else {
      assert.equal(st["claude-sessions"], undefined, "claude-sessions is macOS only");
    }
    // didn't get into the session registry
    const r = await req(h.sock, "GET", "/state");
    assert.deepEqual(r.body.sessions, []);
  } finally {
    process.env.HOME = prevHome;
    sleeper.kill("SIGKILL");
    await h?.stop();
    await new Promise((r) => api.close(r));
    rmSync(root, { recursive: true, force: true });
  }
});

// Migration pass review: before running, the action is checked against the file's current metadata on disk, not against
// the snapshot in the proposal (the file was replaced before a rescan).
test("action: the argument pattern changed on disk before a rescan — 409 facts:bad-arg; the command changed — facts:action-changed", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ah-recheck-")));
  const dir = join(root, "builtin", "demo");
  mkdirSync(dir, { recursive: true });
  const text = (pat, cmd = "demo.1h.sh --act {x}") => `#!/bin/sh
# <agenthub.title>Demo</agenthub.title>
# <agenthub.action id="go" level="immediate" arg="x:${pat}">${cmd}</agenthub.action>
if [ "$1" = "--act" ]; then echo "$2" >> "$AGENTHUB_PLUGIN_DATA_PATH/ran.txt"; exit 0; fi
echo "Demo | status=ok"
echo "---"
echo "Go | action=go arg=abc"
`;
  const f = join(dir, "demo.1h.sh");
  writeFileSync(f, text("^[a-z]+$"));
  chmodSync(f, 0o755);
  const h = await startHub({ pluginsDir: join(root, "builtin") });
  try {
    const st = await waitFor(() => h.core.pluginState("demo")?.body.find((i) => i.offer) && h.core.pluginState("demo"));
    const offer = st.body.find((i) => i.offer).offer;
    const ran = join(h.config.paths.pluginData, "demo", "ran.txt");
    // there will be no rescan: the call comes right after the file is written
    writeFileSync(f, text("^[0-9]+$"));
    const r1 = await req(h.sock, "POST", `/actions/${offer.id}`, {});
    assert.deepEqual([r1.status, r1.body.error], [409, "facts:bad-arg"]);
    writeFileSync(f, text("^[a-z]+$", "demo.1h.sh --act {x} --other"));
    const r2 = await req(h.sock, "POST", `/actions/${offer.id}`, {});
    assert.deepEqual([r2.status, r2.body.error], [409, "facts:action-changed"]);
    let ranText = "";
    try {
      ranText = readFileSync(ran, "utf8");
    } catch {}
    assert.equal(ranText, "", "nothing was run");
    // the file was restored — the same proposal runs again
    writeFileSync(f, text("^[a-z]+$"));
    const r3 = await req(h.sock, "POST", `/actions/${offer.id}`, {});
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
    assert.equal(readFileSync(ran, "utf8").trim(), "abc");
  } finally {
    await h.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
