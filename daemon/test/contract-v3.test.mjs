// Contract 3 (2026-11-10): metadata of live Claude Code sessions for trusted plugins (the sessions service →
// AGENTHUB_CLAUDE_SESSIONS_FILE), the hub pause flag AGENTHUB_PAUSED and restarting plugins on pause, a loud warning for
// writes to Claude Code and system hijack locations (consent window, registry linter, terminal window).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_DIR } from "../lib/config.mjs";
import { CONTRACT_VERSION, parseMetaText, readPluginMeta } from "../lib/meta.mjs";
import { lintPlugin, permissionList, permissionsFromMeta, writeRisk, writeRiskText, WRITE_RISKS } from "../lib/registry/perms.mjs";
import { consentText } from "../lib/registry/terminal.mjs";
import { ENV_NAME, FILE_NAME, SessionsFileService, modelIdOf, sessionRecord } from "../lib/services/sessions.mjs";
import { scanTail } from "../../plugins/claude-sessions/claude-sessions.mjs";
import { FILE_MODES, cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const CLAUDE = "/Users/u/.local/share/claude/versions/9.9.9";
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function sys({ dead = new Set() } = {}) {
  const procs = { 40: { ppid: 1, path: CLAUDE }, 41: { ppid: 1, path: CLAUDE }, 42: { ppid: 1, path: CLAUDE }, 20: { ppid: 1, path: "/usr/bin/curl" } };
  const alive = (pid) => procs[pid] && !dead.has(pid);
  return {
    available: true,
    peerPid: () => 20,
    peerUid: () => 501,
    pidPath: (pid) => (alive(pid) ? procs[pid].path : null),
    pidInfo: (pid) => (alive(pid) ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === CLAUDE,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

test("core contract version is 3", () => {
  assert.equal(CONTRACT_VERSION, 3);
});

// ---------- model and effort from the transcript tail (built-in sessions plugin) ----------

const rec = (o) => JSON.stringify(o);
const turn = (model, effort, ts, extra = {}) => rec({ type: "assistant", timestamp: ts, message: { model, role: "assistant", content: [{ type: "text", text: "Set effort level to low — ловушка в тексте" }] }, effort, ...extra });
const cmd = (text, ts, extra = {}) => rec({ type: "user", timestamp: ts, message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` }, ...extra });

test("scanTail: model and effort come from the last turn, and /model and /effort commands after it take precedence", () => {
  const t1 = "2026-11-10T10:00:00.000Z";
  const t2 = "2026-11-10T10:05:00.000Z";
  const t3 = "2026-11-10T10:06:00.000Z";
  // turn only
  let r = scanTail(["", turn("claude-opus-5-5", "high", t1)].join("\n"));
  assert.deepEqual([r.model, r.modelSource, r.modelAt, r.effort, r.effortSource, r.at], ["claude-opus-5-5", "turn", t1, "high", "turn", t1]);
  // after the turn — /effort and /model: the commands decide
  r = scanTail(["", turn("claude-opus-5-5", "high", t1), cmd("Set effort level to max (this session only): Maximum capability", t2), cmd("Set model to `Fable 5.2` and saved as your default for new sessions", t3)].join("\n"));
  assert.deepEqual([r.model, r.modelSource, r.modelAt, r.effort, r.effortSource, r.at], ["Fable 5.2", "command", t3, "max", "command", t2]);
  // a command before the turn — the turn decides
  r = scanTail(["", cmd("Set effort level to low (this session only): x", t1), cmd("Set model to `Fable 5.2` and saved", t1), turn("claude-opus-5-5", "xhigh", t2)].join("\n"));
  assert.deepEqual([r.model, r.modelSource, r.effort, r.effortSource], ["claude-opus-5-5", "turn", "xhigh", "turn"]);
  // "Kept model as" is a model too; ANSI codes in the name are stripped
  r = scanTail(["", turn("claude-opus-5-5", "high", t1), cmd("Kept model as `\u001b[1mOpus 5.5 (default)\u001b[22m`", t2)].join("\n"));
  assert.deepEqual([r.model, r.modelSource], ["Opus 5.5 (default)", "command"]);
  // Claude Code 2.1.3xx writes command output as a system/local_command record too (content is a string)
  const sysCmd = (text, ts) => rec({ type: "system", subtype: "local_command", timestamp: ts, content: `<local-command-stdout>${text}</local-command-stdout>`, isSidechain: false });
  r = scanTail(["", turn("claude-opus-5-5", "high", t1), sysCmd("Kept model as `Opus 5.5 (default)`", t2), sysCmd("Set effort level to xhigh (this session only): x", t3)].join("\n"));
  assert.deepEqual([r.model, r.modelSource, r.modelAt, r.effort, r.effortSource, r.at], ["Opus 5.5 (default)", "command", t2, "xhigh", "command", t3]);
  // system of another subtype and sidechain — not commands
  r = scanTail(["", turn("claude-opus-5-5", "high", t1), rec({ type: "system", subtype: "informational", timestamp: t2, content: "<local-command-stdout>Set effort level to low: x</local-command-stdout>" }), rec({ type: "system", subtype: "local_command", isSidechain: true, timestamp: t3, content: "<local-command-stdout>Set model to `X` </local-command-stdout>" })].join("\n"));
  assert.deepEqual([r.model, r.modelSource, r.effort, r.effortSource], ["claude-opus-5-5", "turn", "high", "turn"]);
  // /effort with an unknown level — the result is "unknown", the previous turn is not substituted
  r = scanTail(["", turn("claude-opus-5-5", "high", t1), cmd("Set effort level to auto: x", t2)].join("\n"));
  assert.deepEqual([r.effort, r.effortSource, r.decided], [null, null, true]);
  // "<synthetic>" is not a model: the earlier turn is taken
  r = scanTail(["", turn("claude-opus-5-5", "high", t1), turn("<synthetic>", undefined, t2)].join("\n"));
  assert.deepEqual([r.model, r.modelAt], ["claude-opus-5-5", t1]);
});

test("scanTail: traps — a tool result, a sidechain and message text are not treated as commands", () => {
  const t1 = "2026-11-10T10:00:00.000Z";
  const t2 = "2026-11-10T10:05:00.000Z";
  const lines = [
    "",
    turn("claude-opus-5-5", "high", t1),
    // tool output with the same text — an array, not a string
    rec({ type: "user", timestamp: t2, message: { role: "user", content: [{ type: "tool_result", content: "<local-command-stdout>Set effort level to max (x)</local-command-stdout>" }] } }),
    // a subagent typed /model — not this session
    cmd("Set model to `Haiku 9`", t2, { isSidechain: true }),
    // a command inside ordinary text
    rec({ type: "user", timestamp: t2, message: { role: "user", content: "смотри: <local-command-stdout>Set model to `X`</local-command-stdout>" } }),
  ];
  const r = scanTail(lines.join("\n"));
  assert.deepEqual([r.model, r.modelSource, r.effort, r.effortSource], ["claude-opus-5-5", "turn", "high", "turn"]);
});

test("the built-in sessions plugin declares contract 3 and model reading in fsRead", () => {
  const pm = readPluginMeta(join(REPO_DIR, "plugins", "claude-sessions", "claude-sessions.mjs"));
  assert.equal(pm.meta.contract, 3);
  assert.ok(pm.meta.fsRead.some((e) => /projects\/\*\/<sessionId>\.jsonl — только модель и effort/.test(e)));
});

// ---------- session registry: contract 3 fields ----------

const SESSIONS_PLUGIN = `#!/bin/sh
echo "S | status=ok"
echo "---"
echo "A | session=${A} pid=40 sessionStatus=busy sessionName=\\"Сборка\\" sessionCwd=\\"~/Projects/secret\\" waitingFor=\\"permission: rm -rf\\" surfaceId=AAAA-1 workspaceId=BBBB-2 sessionEffort=max sessionEffortSource=command sessionModel=\\"Opus 5.5 (default)\\" sessionModelSource=command sessionAt=2026-11-10T10:06:00.000Z sessionUltracode=true"
echo "B | session=${B} pid=41 sessionStatus=idle sessionName=\\"Почини вход по паролю\\" sessionNameSource=auto sessionEffort=high sessionEffortSource=whatever sessionModel=\\"bad<model>\\" sessionModelSource=turn sessionAt=yesterday"
`;

test("session registry: model, sources and time from a trusted plugin's output; anything unfamiliar is dropped", async () => {
  const plugins = tempHome("ah-v3r-");
  writePlugin(plugins, "s.1h.sh", SESSIONS_PLUGIN);
  const h = await startHub({ pluginsDir: plugins, sys: sys() });
  try {
    const list = await waitFor(() => (h.core.sessionList().length === 2 ? h.core.sessionList() : null));
    const a = list.find((s) => s.pid === 40);
    const b = list.find((s) => s.pid === 41);
    assert.deepEqual([a.model, a.modelSource, a.effort, a.effortSource, a.metaAt], ["Opus 5.5 (default)", "command", "max", "command", "2026-11-10T10:06:00.000Z"]);
    assert.deepEqual([b.model, b.modelSource, b.effort, b.effortSource, b.metaAt], [null, "turn", "high", null, null]);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- sessions service: the metadata file ----------

const WATCHER = `#!/bin/sh
# <agenthub.title>W</agenthub.title>
# <agenthub.watch>$AGENTHUB_CLAUDE_SESSIONS_FILE — сессии изменились</agenthub.watch>
echo "run $AGENTHUB_REFRESH_REASON file=\${AGENTHUB_CLAUDE_SESSIONS_FILE:-none} | status=ok"
`;

test("sessions service: Cache/claude-sessions.json (0600, metadata only), the variable — trusted plugins only, watch on it", async () => {
  const plugins = tempHome("ah-v3s-");
  writePlugin(plugins, "s.1h.sh", SESSIONS_PLUGIN);
  writePlugin(plugins, "w.1h.sh", WATCHER);
  const h = await startHub({ pluginsDir: plugins, sys: sys(), services: "sessions", overrides: { services: { sessions: { minIntervalMs: 100 } } } });
  const file = join(h.config.paths.pluginCache, FILE_NAME);
  try {
    const title = (id) => h.core.pluginState(id)?.header?.[0]?.title || "";
    // the built-in one gets the file path
    await waitFor(() => title("w").startsWith("run "));
    assert.match(title("w"), new RegExp(`file=${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    assert.equal(h.core.pluginEnvFor({ source: "builtin" })[ENV_NAME], file);
    assert.equal(h.core.pluginEnvFor({ source: "installed", granted: { tier: "community" } })[ENV_NAME], undefined);
    assert.equal(h.core.pluginEnvFor({ source: "local" })[ENV_NAME], undefined);
    const doc = await waitFor(() => {
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        return j.sessions.length === 2 ? j : null;
      } catch {
        return null;
      }
    });
    if (FILE_MODES) assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(doc.version, 1);
    assert.ok(Number.isFinite(Date.parse(doc.updatedAt)));
    const a = doc.sessions.find((s) => s.sessionId === A);
    assert.deepEqual(a, {
      sessionId: A,
      pid: 40,
      verified: true,
      status: "busy",
      model: "Opus 5.5 (default)",
      modelId: "claude-opus-5-5",
      modelSource: "command",
      effort: "max",
      effortSource: "command",
      ultracode: true,
      surfaceId: "AAAA-1",
      workspaceId: "BBBB-2",
      name: "Сборка",
      at: "2026-11-10T10:06:00.000Z",
    });
    const b = doc.sessions.find((s) => s.sessionId === B);
    assert.deepEqual([b.model, b.modelId, b.modelSource, b.effort, b.effortSource, b.ultracode, b.at], [null, null, null, "high", null, false, null]);
    // the auto-title (nameSource auto — Claude Code composed it from the conversation) does not go into the file; the registry has it
    assert.equal(b.name, null);
    assert.equal(h.core.sessionList().find((s) => s.pid === 41).name, "Почини вход по паролю");
    // neither the folder, nor what the session is waiting for (text), nor anything else — metadata only
    const raw = readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /secret|rm -rf|permission|cwd|waitingFor|паролю|nameSource/);
    // writing the file — a run of the watching plugin
    await waitFor(() => title("w").startsWith("run FileChanged"), { timeoutMs: 5000 });
    // a local plugin with the same watch does not get the variable
    writePlugin(h.config.paths.pluginsLocal, "lw.1h.sh", WATCHER.replace("<agenthub.title>W", "<agenthub.title>LW"));
    await h.core.host.rescan();
    await waitFor(() => title("lw") === "run FirstLaunch file=none");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
  // service stopped — the variable is removed
});

test("sessions file: modelId — the id from a turn as is, from a /model name — normalized, unknown — null", () => {
  assert.equal(modelIdOf("Opus 5.5 (default)"), "claude-opus-5-5");
  assert.equal(modelIdOf("Fable 5.2"), "claude-fable-5-2");
  assert.equal(modelIdOf("Sonnet 4.5 (1M context)"), "claude-sonnet-4-5");
  assert.equal(modelIdOf("Haiku 4"), "claude-haiku-4");
  assert.equal(modelIdOf("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(modelIdOf("Claude Opus 5.5"), "claude-opus-5-5");
  for (const bad of ["Default (recommended)", "opus", "Opus", "Gizmo 1.0", "Opus 5.5 extra", "", null, 5]) assert.equal(modelIdOf(bad), null, String(bad));
  const rec = (model, modelSource) => sessionRecord({ sessionId: "x", pid: 1, model, modelSource });
  assert.equal(rec("claude-opus-5-5", "turn").modelId, "claude-opus-5-5");
  assert.equal(rec("claude-opus-5-5[1m]", "turn").modelId, "claude-opus-5-5[1m]");
  assert.equal(rec("Opus 5.5 (default)", "command").modelId, "claude-opus-5-5");
  assert.equal(rec("Something new", "command").modelId, null);
  assert.equal(rec(null, "turn").modelId, null);
});

test("sessions service: no more often than once per minIntervalMs, no changes — no write; verified by signature now; stop removes the variable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ah-v3t-"));
  const handlers = new Map();
  const env = {};
  let list = [];
  const dead = new Set();
  const ctx = {
    config: { testMode: true, services: { sessions: { minIntervalMs: 150 } }, paths: { pluginCache: dir } },
    on: (t, f) => handlers.set(t, f),
    off: (t) => handlers.delete(t),
    providePluginEnv: (n, v) => (v === null ? delete env[n] : (env[n] = v)),
    sessions: { list: () => list },
    peer: { verifySigned: async (pid) => (dead.has(pid) ? { ok: false, reason: "no-process" } : { ok: true, startSec: 7 }) },
    journal: { write() {} },
  };
  const flushes = [];
  class Probe extends SessionsFileService {
    async flush() {
      flushes.push(Date.now());
      return super.flush();
    }
  }
  const svc = new Probe(ctx);
  try {
    svc.start();
    assert.equal(env[ENV_NAME], join(dir, FILE_NAME));
    await waitFor(() => existsSync(join(dir, FILE_NAME)));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8")).sessions, []);
    // 12 events over ~240 ms with a changing registry
    for (let i = 0; i < 12; i++) {
      list = [{ sessionId: A, pid: 40, startSec: 7, status: i % 2 ? "busy" : "idle", effort: "high", effortSource: "turn", metaAt: `2026-11-10T10:00:${String(i).padStart(2, "0")}.000Z` }];
      handlers.get("sessions")();
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 400));
    for (let i = 1; i < flushes.length; i++) assert.ok(flushes[i] - flushes[i - 1] >= 140, `interval ${flushes[i] - flushes[i - 1]} ms`);
    assert.ok(flushes.length <= 4, `builds ${flushes.length}`);
    const last = JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8"));
    assert.equal(last.sessions[0].at, "2026-11-10T10:00:11.000Z", "the latest state is written");
    // no changes — the file is not rewritten
    const before = readFileSync(join(dir, FILE_NAME), "utf8");
    handlers.get("sessions")();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(readFileSync(join(dir, FILE_NAME), "utf8"), before);
    // the process exited — verified:false (the plugin does not type into such a session)
    dead.add(40);
    handlers.get("sessions")();
    await waitFor(() => JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8")).sessions[0].verified === false, { timeoutMs: 2000 });
    // pid reused (different start time) — also false
    dead.delete(40);
    list = [{ ...list[0], startSec: 3 }];
    handlers.get("sessions")();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(JSON.parse(readFileSync(join(dir, FILE_NAME), "utf8")).sessions[0].verified, false);
  } finally {
    svc.stop();
    assert.equal(env[ENV_NAME], undefined);
    assert.equal(handlers.has("sessions"), false);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- AGENTHUB_PAUSED and restart on pause ----------

const PAUSE_STD = `#!/bin/sh
echo "paused=$AGENTHUB_PAUSED reason=$AGENTHUB_REFRESH_REASON | status=ok"
`;
const PAUSE_STREAM = `#!/bin/sh
# <agenthub.type>streamable</agenthub.type>
echo "paused=$AGENTHUB_PAUSED reason=$AGENTHUB_REFRESH_REASON | status=ok"
echo "~~~"
while read -r l; do :; done
`;

test("AGENTHUB_PAUSED: 0|1 on every run; pausing and resuming restart plugins (Paused|Resumed), both from the app and via the ESTOP file", async () => {
  const plugins = tempHome("ah-v3p-");
  writePlugin(plugins, "p.1h.sh", PAUSE_STD);
  writePlugin(plugins, "st.sh", PAUSE_STREAM);
  // a third-party (local) plugin gets the pause flag too: it is not a service variable but the core environment
  const h = await startHub({ pluginsDir: plugins });
  try {
    const title = (id) => h.core.pluginState(id)?.header?.[0]?.title || "";
    writePlugin(h.config.paths.pluginsLocal, "lp.1h.sh", PAUSE_STD);
    await h.core.host.rescan();
    for (const id of ["p", "st", "lp"]) await waitFor(() => title(id) === "paused=0 reason=FirstLaunch");
    h.core.setEstop(true, { class: "app", pid: 1 });
    for (const id of ["p", "st", "lp"]) await waitFor(() => title(id) === "paused=1 reason=Paused");
    h.core.setEstop(false, { class: "app", pid: 1 });
    for (const id of ["p", "st", "lp"]) await waitFor(() => title(id) === "paused=0 reason=Resumed");
    // pause via the file (agenthub pause from the terminal, another process) — the same
    writeFileSync(h.config.paths.estop, "x\n", { mode: 0o600 });
    for (const id of ["p", "st"]) await waitFor(() => title(id) === "paused=1 reason=Paused", { timeoutMs: 8000 });
    unlinkSync(h.config.paths.estop);
    for (const id of ["p", "st"]) await waitFor(() => title(id) === "paused=0 reason=Resumed", { timeoutMs: 8000 });
    // a streamable restart is not a plugin failure
    assert.ok(!h.core.journal.tail(2000).some((e) => e.type === "plugin-exit" && e.plugin === "st"), "an exit on restart is not counted as a failure");
    assert.equal(h.core.pluginState("st").status, "ok");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

// ---------- hijack locations in fsWrite ----------

test("writeRisk: Claude Code settings, autostart, shell, PATH, ssh, git, the hub directory; ordinary locations — no", () => {
  const cases = {
    "~/.claude/settings.json": "claude-code",
    "~/.claude/settings.local.json": "claude-code",
    "~/.claude.json": "claude-code",
    "~/.claude/hooks": "claude-code",
    "~/.claude/hooks/pre.sh": "claude-code",
    "~/.claude": "claude-code",
    "~/.claude/*.json": "claude-code",
    "$HOME/.claude/settings.json": "claude-code",
    "/Users/someone/.claude/settings.json": "claude-code",
    "~/Projects/app/.claude/settings.json": "claude-code",
    "~/Projects/**/.mcp.json": "claude-code",
    "~": "claude-code",
    "~/Library/LaunchAgents": "autostart",
    "~/Library/LaunchAgents/com.x.plist": "autostart",
    "~/Library": "autostart",
    "~/.zshrc": "shell",
    "~/.bash_profile": "shell",
    "~/.config/fish/config.fish": "shell",
    "~/.local/bin/claude": "bin",
    "~/.ssh/authorized_keys": "ssh",
    "~/.gitconfig": "git",
    "~/Library/Application Support/AgentHub/config.json": "hub",
    "~/Library/Application Support/AgentHub": "hub",
  };
  for (const [p, kind] of Object.entries(cases)) assert.equal(writeRisk(p), kind, p);
  // review 2026-11-10: masks inside a dangerous directory, a wildcard in the middle, the root and its ancestors, firmlink, all of ~/.claude,
  // a project's whole .claude, cmux tab bindings and terminal configs, global npm packages, the hub's shared files
  const more = {
    "~/Library/LaunchAgents/*.plist": "autostart",
    "~/Library/LaunchAgents/com.x.*": "autostart",
    "~/Library/*/*.plist": "autostart",
    "~/.ssh/authorized_*": "ssh",
    "~/.local/bin/c*": "bin",
    "~/projects/**/.claude/**": "claude-code",
    "/": "claude-code",
    "/Users": "claude-code",
    "/Users/*/.zshrc": "shell",
    "/System/Volumes/Data/Users/someone/.zshrc": "shell",
    "~/.claude/statusline.sh": "claude-code",
    "~/.claude/local/claude": "claude-code",
    "~/.claude/ide/123.lock": "claude-code",
    "~/.claude/sessions/x.json": "claude-code",
    "~/.claude/backups/../settings.json": "claude-code",
    "~/projects/x/.claude": "claude-code",
    "~/projects/x/.claude/*": "claude-code",
    "~/.cmuxterm/claude-hook-sessions.json": "terminals",
    "~/.config/ghostty/config": "terminals",
    "~/.tmux.conf": "terminals",
    "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js": "bin",
    "~/.hammerspoon/init.lua": "autostart",
    "~/Library/Application Support/AgentHub/PluginData": "hub",
    "~/Library/Application Support/AgentHub/Cache/claude-sessions.json": "hub",
    "~/Library/Application Support/AgentHub/Cache/usage.json": "hub",
    "~/Library/Application Support/AgentHub/PluginData/x/state.json": "hub",
  };
  for (const [p, kind] of Object.entries(more)) assert.equal(writeRisk(p), kind, p);
  // our own PluginData/<id> and Cache/<id> — not loud; someone else's id — loud
  const own = { pluginId: "x" };
  assert.equal(writeRisk("~/Library/Application Support/AgentHub/PluginData/x/state.json", own), null);
  assert.equal(writeRisk("~/Library/Application Support/AgentHub/Cache/x/a/*.json", own), null);
  assert.equal(writeRisk("~/Library/Application Support/AgentHub/PluginData/claude-code/queue.json", own), "hub");
  assert.equal(writeRisk("~/Library/Application Support/AgentHub/PluginData/*", own), "hub");
  for (const p of ["~/Documents/notes.md", "~/.claude/task-runs/batch/STOP", "~/.claude/task-runs/batch/SKIP-*", "~/.claude/backups/settings.json.*-agenthub", "~/*.txt", "/tmp/x", "$AGENTHUB_PLUGIN_DATA_PATH/x", "~/src/my-runner/.config.json.agenthub-*.tmp"]) {
    assert.equal(writeRisk(p), null, p);
  }
  for (const kind of Object.keys(WRITE_RISKS)) {
    assert.ok(writeRiskText(kind, "ru"));
    assert.ok(writeRiskText(kind, "en"));
  }
});

const RISKY = `#!/bin/sh
# <agenthub.title>Settings</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>macos</agenthub.platforms>
# <agenthub.fsWrite>~/.claude/settings.json — модель и effort по умолчанию</agenthub.fsWrite>
# <agenthub.fsWrite>~/Library/Caches/settings-plugin — свой кэш</agenthub.fsWrite>
echo "ok"
`;

test("permissions: fsWrite into a hijack location — risk in the list (same key), a ru/en linter warning, a line in the terminal window", () => {
  const meta = parseMetaText(RISKY).meta;
  const list = permissionList(permissionsFromMeta(meta));
  const risky = list.find((p) => p.what === "~/.claude/settings.json");
  assert.equal(risky.risk, "claude-code");
  assert.equal(risky.key, "fsWrite:~/.claude/settings.json");
  assert.equal(list.find((p) => p.what === "~/Library/Caches/settings-plugin").risk, undefined);
  const ru = lintPlugin({ id: "settings", meta, source: RISKY, official: true });
  assert.deepEqual(ru.errors, []);
  assert.ok(ru.warnings.some((w) => /^<agenthub\.fsWrite>~\/\.claude\/settings\.json: место перехвата \(claude-code\) — настройки Claude Code: через хуки, env, apiKeyHelper/.test(w)), ru.warnings.join("\n"));
  assert.equal(ru.warnings.filter((w) => /место перехвата/.test(w)).length, 1);
  const en = lintPlugin({ id: "settings", meta, source: RISKY, official: false, lang: "en" });
  assert.ok(en.warnings.some((w) => /takeover location \(claude-code\) — Claude Code settings/.test(w)));
  const text = consentText({ entry: { tier: "official", title: "Settings", version: "1.0.0", sha256: "a".repeat(64) }, list: list.map(({ key, ...p }) => p), update: false }, "en");
  assert.match(text, /write: ~\/\.claude\/settings\.json — модель и effort по умолчанию\n {4}!!! DANGEROUS LOCATION: Claude Code settings/);
  assert.equal(text.match(/DANGEROUS LOCATION/g).length, 1);
});

test("built-in plugins do not write to hijack locations (their permissions are not shown in the window, but the rule is the same for all)", () => {
  for (const f of [["claude-sessions", "claude-sessions.mjs"], ["agents", "agents.mjs"], ["quota", "quota.5m.mjs"]]) {
    const pm = readPluginMeta(join(REPO_DIR, "plugins", ...f));
    for (const e of permissionList(permissionsFromMeta(pm.meta))) assert.equal(e.risk, undefined, `${f[0]}: ${e.what}`);
  }
});

test("pathViolation: the root and ancestors of the home directory, firmlink — cover the forbidden locations (review 2026-11-10)", async () => {
  const { pathViolation } = await import("../lib/registry/perms.mjs");
  for (const p of ["/", "/Users", "/System/Volumes/Data/Users/u", "~"]) assert.match(pathViolation(p) || "", /охватывает/, p);
  assert.match(pathViolation("/System/Volumes/Data/Users/u/.claude/projects/x/y.jsonl") || "", /запрещено/);
  for (const p of ["~/.claude/sessions/*.json", "~/.claude/settings.json", "/tmp/x", "~/Projects/x"]) assert.equal(pathViolation(p), null, p);
});

test("hijack locations on this machine's real paths: ~/.zshrc and ~/.claude — symlinks into dotfiles", async () => {
  const { localWritePlaces, refreshLocalWritePlaces } = await import("../lib/registry/local-places.mjs");
  const { mkdirSync, symlinkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "ah-v3lp-"));
  try {
    const home = join(root, "Users", "u");
    mkdirSync(join(root, "dotfiles", "claude"), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, "dotfiles", "zshrc"), "");
    symlinkSync(join(root, "dotfiles", "zshrc"), join(home, ".zshrc"));
    symlinkSync(join(root, "dotfiles", "claude"), join(home, ".claude"));
    const list = localWritePlaces({ home });
    const real = (p) => p.toLowerCase();
    assert.ok(list.some((e) => e.kind === "shell" && real(e.place).endsWith("/dotfiles/zshrc")), JSON.stringify(list));
    assert.ok(list.some((e) => e.kind === "claude-code" && real(e.place).endsWith("/dotfiles/claude")), JSON.stringify(list));
    refreshLocalWritePlaces({ home });
    const zreal = list.find((e) => e.kind === "shell").place;
    assert.equal(writeRisk(zreal), "shell");
    assert.equal(writeRisk(list.find((e) => e.kind === "claude-code").place + "/settings.json"), "claude-code");
  } finally {
    const { setLocalWritePlaces } = await import("../lib/registry/perms.mjs");
    setLocalWritePlaces([]);
    rmSync(root, { recursive: true, force: true });
  }
});
