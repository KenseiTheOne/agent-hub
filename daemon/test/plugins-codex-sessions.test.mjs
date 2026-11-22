// The codex-sessions plugin: live = a held lock in ~/.codex/thread-writer-locks (holder from lsof, never opened), metadata
// from state_5.sqlite (allowed columns only), working/idle from the rollout tail, the tab process (the holder with a tty, or a
// unique terminal codex in the same folder when the background server holds the lock), cmux without a switch button,
// exec runs tagged, subagents nested, effort fallbacks, and no conversation text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseOutput, splitFrames } from "../lib/output.mjs";
import { readPluginMeta } from "../lib/meta.mjs";
import { SECRET, writer, rolloutPath, writeRollout } from "./fixtures/codex/rollouts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FILE = join(REPO, "plugins/codex-sessions/codex-sessions.mjs");
const C = await import(FILE);

const ID = {
  tab: "cccccccc-0000-4000-8000-000000000001", // a terminal codex holds its own lock (tty) — working
  hosted: "cccccccc-0000-4000-8000-000000000002", // the background server holds it; a unique codex in the same folder, in cmux
  exec: "cccccccc-0000-4000-8000-000000000003", // codex exec
  sub: "cccccccc-0000-4000-8000-000000000004", // a subagent spawned by `tab`
  orphan: "cccccccc-0000-4000-8000-000000000005", // the server holds it, no terminal codex in its folder
  stale: "cccccccc-0000-4000-8000-000000000006", // a lock file nobody holds
};
const SPAWNED = { subagent: { thread_spawn: { parent_thread_id: ID.tab, depth: 1 } } };
const NOW = Date.parse("2026-11-22T10:30:00.000Z");

// lsof / ps doubles: they read world.json next to them (the plugin runs tools with a clean environment)
const FAKE_TOOLS = `
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const [, , self, ...args] = process.argv;
const w = JSON.parse(readFileSync(join(dirname(self), "world.json"), "utf8"));
const tool = basename(self);
if (tool === "ps") {
  // pid ppid tty lstart comm — lstart as macOS prints it with LANG=C, in local time
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p2 = (n) => String(n).padStart(2, "0");
  const lstart = (iso) => { const d = new Date(iso); return \`\${WD[d.getDay()]} \${MO[d.getMonth()]} \${String(d.getDate()).padStart(2)} \${p2(d.getHours())}:\${p2(d.getMinutes())}:\${p2(d.getSeconds())} \${d.getFullYear()}\`; };
  for (const p of w.procs) console.log(\`\${String(p.pid).padStart(6)} \${String(p.ppid).padStart(6)} \${p.tty || "??"} \${lstart(p.start || "2026-11-22T07:00:00.000Z")} \${p.comm}\`);
} else if (tool === "lsof") {
  if (args.includes("cwd")) {
    const pids = args[args.indexOf("-p") + 1].split(",").map(Number);
    let any = false;
    for (const pid of pids) if (w.cwd[pid]) { console.log(\`p\${pid}\\nfcwd\\nn\${w.cwd[pid]}\`); any = true; }
    process.exit(any ? 0 : 1);
  } else {
    const files = args.slice(args.indexOf("--") + 1);
    let any = false;
    for (const f of files) {
      const pid = w.locks[basename(f, ".lock")];
      if (pid) { console.log(\`p\${pid}\\nf7\\nn\${f}\`); any = true; }
    }
    process.exit(any && files.every((f) => w.locks[basename(f, ".lock")]) ? 0 : 1);
  }
}
`;

function world({ configEffort = "medium", hostedSource = "cli" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ah-cxss-"));
  const codex = join(root, ".codex");
  const bin = join(root, "bin");
  mkdirSync(join(codex, "thread-writer-locks"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(bin, "fake-tools.mjs"), FAKE_TOOLS);
  for (const t of ["lsof", "ps"]) {
    writeFileSync(join(bin, t), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-tools.mjs" "$0" "$@"\n`);
    chmodSync(join(bin, t), 0o755);
  }
  symlinkSync("/usr/bin/sqlite3", join(bin, "sqlite3"));
  writeFileSync(join(codex, "config.toml"), `model = "gpt-6.1-terra"\n${configEffort ? `model_reasoning_effort = "${configEffort}"\n` : ""}\n[profiles.fast]\nmodel_reasoning_effort = "low"\n`);
  writeFileSync(join(codex, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-terra", default_reasoning_level: "high", description: SECRET }, { slug: "gpt-6.1-sol", default_reasoning_level: "low" }] }));
  for (const id of [...Object.values(ID)]) writeFileSync(join(codex, "thread-writer-locks", `${id}.lock`), "");
  writeFileSync(join(codex, "thread-writer-locks", ".coordination.lock"), "");

  // rollouts
  const paths = {};
  const tab = writer({ start: "2026-11-22T10:00:00.000Z" });
  tab.meta({ id: ID.tab, cwd: "/Users/test/Projects/one" });
  tab.userMessage();
  tab.turnContext({ turn: "a1", model: "gpt-6.1-terra", effort: "xhigh" });
  tab.taskStarted({ turn: "a1" });
  tab.agentMessage();
  tab.taskComplete({ turn: "a1" });
  tab.turnContext({ turn: "a2", model: "gpt-6.1-sol", effort: "xhigh" });
  tab.taskStarted({ turn: "a2", startedAt: Math.floor(Date.parse("2026-11-22T10:18:00.000Z") / 1000) });
  tab.agentMessage();
  paths.tab = writeRollout(rolloutPath(codex, ID.tab, "2026-11-22T10:00:00.000Z"), tab.text());
  const hosted = writer({ start: "2026-11-22T09:00:00.000Z" });
  hosted.meta({ id: ID.hosted, cwd: "/Users/test/Projects/two" });
  hosted.turnContext({ turn: "b1", model: "gpt-6.1-terra", settingsEffort: null });
  hosted.taskStarted({ turn: "b1" });
  hosted.turnAborted({ turn: "b1" });
  paths.hosted = writeRollout(rolloutPath(codex, ID.hosted, "2026-11-22T09:00:00.000Z"), hosted.text());
  const ex = writer({ start: "2026-11-22T10:10:00.000Z" });
  ex.meta({ id: ID.exec, source: "exec", cwd: "/Users/test/Projects/one" });
  ex.turnContext({ turn: "e1", model: "gpt-6.1-terra" });
  ex.taskStarted({ turn: "e1" });
  paths.exec = writeRollout(rolloutPath(codex, ID.exec, "2026-11-22T10:10:00.000Z"), ex.text());
  const sub = writer({ start: "2026-11-22T10:20:00.000Z" });
  sub.meta({ id: ID.sub, source: SPAWNED, cwd: "/Users/test/Projects/one", parent: ID.tab });
  sub.turnContext({ turn: "s1", model: "gpt-6.1-sol", settingsEffort: null });
  sub.taskStarted({ turn: "s1" });
  sub.taskComplete({ turn: "s1" });
  paths.sub = writeRollout(rolloutPath(codex, ID.sub, "2026-11-22T10:20:00.000Z"), sub.text());
  const orphan = writer({ start: "2026-11-22T08:00:00.000Z" });
  orphan.meta({ id: ID.orphan, cwd: "/Users/test/Projects/three" });
  orphan.turnContext({ turn: "o1", model: "gpt-6.1-terra", settingsEffort: null });
  paths.orphan = writeRollout(rolloutPath(codex, ID.orphan, "2026-11-22T08:00:00.000Z"), orphan.text());

  // the database: the columns the plugin may read plus the text columns it must never select
  const db = new DatabaseSync(join(codex, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, source TEXT, model TEXT, reasoning_effort TEXT, name TEXT, agent_nickname TEXT, agent_role TEXT, updated_at_ms INTEGER, title TEXT, preview TEXT, first_user_message TEXT, archived INTEGER, created_at_ms INTEGER);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT);`);
  const ins = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)");
  const ms = (iso) => Date.parse(iso);
  ins.run(ID.tab, paths.tab, "/Users/test/Projects/one", "cli", "gpt-6.1-terra", null, "Refactor", null, null, ms("2026-11-22T10:25:00Z"), SECRET, SECRET, SECRET, ms("2026-11-22T10:00:00Z"));
  ins.run(ID.hosted, paths.hosted, "/Users/test/Projects/two", hostedSource, "gpt-6.1-terra", null, null, null, null, ms("2026-11-22T09:05:00Z"), SECRET, SECRET, SECRET, ms("2026-11-22T09:00:00Z"));
  ins.run(ID.exec, paths.exec, "/Users/test/Projects/one", "exec", "gpt-6.1-terra", "low", null, null, null, ms("2026-11-22T10:11:00Z"), SECRET, SECRET, SECRET, ms("2026-11-22T10:10:00Z"));
  ins.run(ID.sub, paths.sub, "/Users/test/Projects/one", JSON.stringify(SPAWNED), "gpt-6.1-sol", null, null, "Reviewer", null, ms("2026-11-22T10:21:00Z"), SECRET, SECRET, SECRET, ms("2026-11-22T10:20:00Z"));
  ins.run(ID.orphan, "/etc/passwd.jsonl", "/Users/test/Projects/three", "cli", "gpt-6.1-terra", null, null, null, null, ms("2026-11-22T08:01:00Z"), SECRET, SECRET, SECRET, ms("2026-11-22T08:00:00Z"));
  ins.run(ID.stale, null, "/Users/test/Projects/four", "cli", null, null, null, null, null, 0, SECRET, SECRET, SECRET, null);
  db.prepare("INSERT INTO thread_spawn_edges VALUES (?,?,?)").run(ID.tab, ID.sub, "open");
  db.close();

  const procs = [
    { pid: 90, ppid: 1, tty: null, comm: "/Applications/cmux.app/Contents/MacOS/cmux" },
    { pid: 400, ppid: 1, tty: null, comm: "/Applications/Ghostty.app/Contents/MacOS/ghostty" },
    { pid: 500, ppid: 400, tty: "ttys001", comm: "-zsh" },
    { pid: 501, ppid: 500, tty: "ttys001", comm: "codex" },
    { pid: 600, ppid: 1, tty: null, comm: "/opt/homebrew/bin/codex" }, // the background server
    { pid: 699, ppid: 90, tty: "ttys002", comm: "/bin/zsh" },
    { pid: 700, ppid: 699, tty: "ttys002", comm: "codex", start: "2026-11-22T08:59:00.000Z" },
    { pid: 701, ppid: 700, tty: "ttys002", comm: "codex-helper" }, // a helper under codex — not a candidate
    { pid: 800, ppid: 500, tty: "ttys001", comm: "codex" }, // codex exec
  ];
  const state = { procs, locks: { [ID.tab]: 501, [ID.sub]: 501, [ID.hosted]: 600, [ID.orphan]: 600, [ID.exec]: 800 }, cwd: { 700: "/Users/test/Projects/two", 701: "/Users/test/Projects/two" } };
  writeFileSync(join(bin, "world.json"), JSON.stringify(state));
  return { root, codex, bin, paths };
}
const setWorld = (w, change) => {
  const state = JSON.parse(readFileSync(join(w.bin, "world.json"), "utf8"));
  change(state);
  writeFileSync(join(w.bin, "world.json"), JSON.stringify(state));
};

async function collectIn(w) {
  const prev = process.env.AGENTHUB_TEST_BIN_DIR;
  process.env.AGENTHUB_TEST_BIN_DIR = w.bin;
  try {
    return await C.collect({ codex: w.codex, home: w.root });
  } finally {
    if (prev === undefined) delete process.env.AGENTHUB_TEST_BIN_DIR;
    else process.env.AGENTHUB_TEST_BIN_DIR = prev;
  }
}

test("codex-sessions: metadata — session.focus, lsof/ps declared, locks never opened, forbidden columns never selected", () => {
  const { meta } = readPluginMeta(FILE);
  assert.equal(meta.type, "streamable");
  assert.deepEqual(meta.effects, ["session.focus"]);
  assert.ok(meta.exec.some((x) => x.startsWith("/usr/sbin/lsof ")));
  assert.ok(meta.exec.some((x) => x.startsWith("/bin/ps ")));
  assert.ok(meta.watch.some((x) => x.startsWith("~/.codex/thread-writer-locks/")));
  const src = readFileSync(FILE, "utf8");
  assert.doesNotMatch(src, /SELECT[^`]*\b(title|preview|first_user_message)\b/i);
  assert.doesNotMatch(src, /flock|auth\.json|app-server|codex agents/);
  // lock files are only listed: no open/read of a path under thread-writer-locks
  assert.doesNotMatch(src, /(openSync|readFileSync)\([^)]*\.lock/);
});

test("codex-sessions: collect — held locks only, holders, tab by tty or by a unique folder match, cmux, effort fallbacks", async () => {
  const w = world();
  try {
    const r = await collectIn(w);
    assert.deepEqual(r.problems, []);
    const by = Object.fromEntries(r.sessions.map((s) => [s.id, s]));
    assert.equal(by[ID.stale], undefined, "a lock nobody holds is not a session");
    assert.equal(r.sessions.length, 5);
    // the terminal codex holds its own lock: working since 10:18, last turn's model and effort
    assert.equal(by[ID.tab].pid, 501);
    assert.equal(by[ID.tab].via, "holder");
    assert.equal(by[ID.tab].busy, true);
    assert.equal(by[ID.tab].turnStartedMs, Date.parse("2026-11-22T10:18:00.000Z"));
    assert.equal(by[ID.tab].model, "gpt-6.1-sol");
    assert.deepEqual([by[ID.tab].effort, by[ID.tab].effortFrom], ["xhigh", "turn"]);
    assert.equal(by[ID.tab].cmux, false);
    // the server holds it, the only terminal codex in /Users/test/Projects/two is 700 (in cmux); turn aborted → idle
    assert.equal(by[ID.hosted].holder, 600);
    assert.equal(by[ID.hosted].pid, 700);
    assert.equal(by[ID.hosted].via, "cwd");
    assert.equal(by[ID.hosted].cmux, true);
    assert.equal(by[ID.hosted].busy, false);
    assert.deepEqual([by[ID.hosted].effort, by[ID.hosted].effortFrom], ["medium", "config"]);
    // no terminal codex in its folder → no pid; a rollout path outside ~/.codex is ignored, found by id instead
    assert.equal(by[ID.orphan].pid, null);
    assert.equal(by[ID.orphan].model, "gpt-6.1-terra");
    // exec and the subagent
    assert.equal(by[ID.exec].kind, "exec");
    assert.equal(by[ID.exec].busy, true);
    assert.equal(by[ID.exec].pid, null);
    assert.equal(by[ID.sub].kind, "sub");
    assert.equal(by[ID.sub].parent, ID.tab);
    assert.equal(by[ID.sub].nickname, "Reviewer");
    assert.equal(JSON.stringify(r).includes(SECRET), false, "no text from the database, rollouts or caches");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-sessions: Codex's auto_review threads are not sessions — a guardian rollout, or an anonymous lock beside a known session", async () => {
  const w = world();
  try {
    const guardian = "cccccccc-0000-4000-8000-000000000007"; // auto_review of `tab`, its rollout already written
    const helper = "cccccccc-0000-4000-8000-000000000008"; // a lock of the exec process with no rollout and no row yet
    const fresh = "cccccccc-0000-4000-8000-000000000009"; // a lone terminal codex, nothing written yet — still a session
    const g = writer({ start: "2026-11-22T10:22:00.000Z" });
    g.meta({ id: guardian, source: { subagent: { other: "guardian" } }, cwd: "/Users/test/Projects/one", parent: ID.tab });
    writeRollout(rolloutPath(w.codex, guardian, "2026-11-22T10:22:00.000Z"), g.text());
    for (const id of [guardian, helper, fresh]) writeFileSync(join(w.codex, "thread-writer-locks", `${id}.lock`), "");
    setWorld(w, (st) => {
      st.procs.push({ pid: 900, ppid: 500, tty: "ttys003", comm: "codex" });
      Object.assign(st.locks, { [guardian]: 501, [helper]: 800, [fresh]: 900 });
    });
    const r = await collectIn(w);
    const ids = r.sessions.map((s) => s.id);
    assert.equal(ids.includes(guardian), false, "a guardian rollout is not a session");
    assert.equal(ids.includes(helper), false, "an anonymous lock of a process that holds a known session is its helper");
    assert.equal(ids.includes(fresh), true, "an anonymous lock of a process with no other session stays");
    assert.equal(r.sessions.length, 6);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-sessions: effort falls back to the model's default when config.toml has none", async () => {
  const w = world({ configEffort: null });
  try {
    const r = await collectIn(w);
    const s = r.sessions.find((x) => x.id === ID.hosted);
    assert.deepEqual([s.effort, s.effortFrom], ["high", "model"]);
    const sub = r.sessions.find((x) => x.id === ID.sub);
    assert.deepEqual([sub.effort, sub.effortFrom], ["low", "model"]);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-sessions: frame — working first, externalSessions params only for sessions with a tab, no switch in cmux, exec tagged, subagent nested", async () => {
  const w = world();
  try {
    const r = await collectIn(w);
    const text = C.render(r, NOW, "en", w.root);
    const parsed = parseOutput(text);
    assert.equal(parsed.status, "ok");
    assert.match(parsed.header[0].title, /^Codex: 1 working · 2 idle$/);
    const rows = parsed.body.filter((i) => i.level === 0 && /—/.test(i.title));
    assert.deepEqual(rows.map((i) => i.title), ["Refactor — working · 12 min", "two — idle", "three — idle", "one — working · 19 min · background (codex exec)"]);
    const tab = rows[0];
    assert.equal(tab.params.agentSession, ID.tab);
    assert.equal(tab.params.pid, "501");
    assert.equal(tab.params.agent, "codex");
    assert.equal(tab.params.agentName, "Refactor");
    assert.match(text, new RegExp(`\\n--Switch to tab \\| effect="session\\.focus ${ID.tab}"`));
    // hosted in cmux: registered (pid 700) but no switch button
    assert.equal(rows[1].params.agentSession, ID.hosted);
    assert.equal(rows[1].params.pid, "700");
    assert.doesNotMatch(text, new RegExp(`session\\.focus ${ID.hosted}`));
    assert.match(text, /The tab is in cmux/);
    // the orphan and exec: no registration
    assert.equal(rows[2].params.agentSession, undefined);
    assert.equal(rows[3].params.agentSession, undefined);
    assert.match(text, /no tab process found: the Codex background server holds the session/);
    // the subagent under its parent, never registered
    assert.match(text, /\n--Reviewer — idle \| sfimage=moon\n----Model: gpt-6.1-sol/);
    assert.doesNotMatch(text, new RegExp(`agentSession=${ID.sub}`));
    assert.match(text, /\n--Folder: ~\/Projects\/one|\n--Folder: \/Users\/test\/Projects\/one/);
    assert.match(text, /\n--Effort: xhigh \(as of the last turn\)/);
    assert.match(text, /\n--Effort: medium \(from config\.toml\)/);
    assert.doesNotMatch(text, new RegExp(SECRET));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-sessions: no ~/.codex → 'not installed'; no locks → 'no sessions'; lsof missing → unknown + source-broken", async () => {
  const empty = mkdtempSync(join(tmpdir(), "ah-cxss-"));
  try {
    const r = await C.collect({ codex: join(empty, ".codex"), home: empty });
    assert.equal(r.installed, false);
    assert.match(C.render(r, NOW, "en"), /^Codex isn't installed \| status=ok tile="0"/);
    mkdirSync(join(empty, ".codex/thread-writer-locks"), { recursive: true });
    const r2 = await C.collect({ codex: join(empty, ".codex"), home: empty });
    assert.match(C.render(r2, NOW, "en"), /^No Codex sessions \| status=ok/);
    assert.doesNotMatch(C.render(r2, NOW, "en"), /^---\n---$/m, "no empty section");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  const w = world();
  try {
    unlinkSync(join(w.bin, "lsof"));
    const r = await collectIn(w);
    const p = parseOutput(C.render(r, NOW, "en"));
    assert.equal(p.status, "unknown");
    assert.ok(p.events.includes("source-broken"));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-sessions: lock files nobody holds (lsof exits 1, prints nothing) → 'no sessions', not source-broken", async () => {
  const w = world();
  try {
    setWorld(w, (s) => (s.locks = {}));
    const r = await collectIn(w);
    assert.deepEqual(r.problems, []);
    assert.equal(r.sessions.length, 0);
    const p = parseOutput(C.render(r, NOW, "en"));
    assert.equal(p.status, "ok");
    assert.equal(p.events.includes("source-broken"), false);
    assert.match(p.header[0].title, /^No Codex sessions$/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test("codex-sessions: the folder match — terminal sessions only, and only a process that was running when the session was created", async () => {
  const late = world();
  try {
    setWorld(late, (s) => (s.procs.find((p) => p.pid === 700).start = "2026-11-22T09:30:00.000Z"));
    const s = (await collectIn(late)).sessions.find((x) => x.id === ID.hosted);
    assert.equal(s.pid, null, "started after the session was created");
  } finally {
    rmSync(late.root, { recursive: true, force: true });
  }
  const ide = world({ hostedSource: "vscode" });
  try {
    const s = (await collectIn(ide)).sessions.find((x) => x.id === ID.hosted);
    assert.equal(s.kind, "ide");
    assert.equal(s.pid, null, "an editor session is never matched by folder");
  } finally {
    rmSync(ide.root, { recursive: true, force: true });
  }
  assert.equal(C.parsePs("  700   699 ttys002 Sun Nov  2 09:00:05 2026 /opt/homebrew/bin/codex\n").get(700).startMs, new Date(2026, 10, 2, 9, 0, 5).getTime());
  assert.equal(C.parsePs("  700   699 ttys002 Sun Nov  2 09:00:05 2026 /opt/homebrew/bin/codex\n").get(700).comm, "/opt/homebrew/bin/codex");
});

test("codex-sessions: a turn longer than the tail stays working; appended lines are read incrementally; a rewrite resets", async () => {
  const w = world();
  try {
    // the tab's turn a2 grows by ~600 KB of output: task_started is far before the last 256 KB
    const more = writer({ start: "2026-11-22T10:19:00.000Z" });
    for (let i = 0; i < 2500; i++) more.agentMessage();
    appendFileSync(w.paths.tab, more.text());
    assert.ok(statSync(w.paths.tab).size > 512 * 1024);
    const turns = new C.RolloutTurns();
    const prev = process.env.AGENTHUB_TEST_BIN_DIR;
    process.env.AGENTHUB_TEST_BIN_DIR = w.bin;
    try {
      let r = await C.collect({ codex: w.codex, home: w.root, turns });
      let tab = r.sessions.find((x) => x.id === ID.tab);
      assert.equal(tab.busy, true);
      assert.equal(tab.turnStartedMs, Date.parse("2026-11-22T10:18:00.000Z"));
      assert.equal(tab.model, "gpt-6.1-sol");
      // the turn ends: only the appended part is read
      const end = writer({ start: "2026-11-22T10:29:00.000Z" });
      end.taskComplete({ turn: "a2" });
      appendFileSync(w.paths.tab, end.text());
      r = await C.collect({ codex: w.codex, home: w.root, turns });
      tab = r.sessions.find((x) => x.id === ID.tab);
      assert.equal(tab.busy, false);
      assert.equal(tab.model, "gpt-6.1-sol");
    } finally {
      if (prev === undefined) delete process.env.AGENTHUB_TEST_BIN_DIR;
      else process.env.AGENTHUB_TEST_BIN_DIR = prev;
    }
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
  // the tracker itself, with small chunks: the scan-back cap, a partial last line, a rewrite in place
  const dir = mkdtempSync(join(tmpdir(), "ah-cxss-"));
  try {
    const f = join(dir, "r.jsonl");
    const x = writer();
    x.turnContext({ turn: "k1", model: "m-one" });
    x.taskStarted({ turn: "k1" });
    for (let i = 0; i < 200; i++) x.agentMessage();
    writeFileSync(f, x.text());
    assert.equal(new C.RolloutTurns({ chunk: 4096 }).state(f).busy, true, "scanned back to task_started");
    assert.equal(new C.RolloutTurns({ chunk: 4096, cap: 8192 }).state(f).busy, false, "the cap bounds the first scan");
    const t = new C.RolloutTurns({ chunk: 4096 });
    assert.equal(t.state(f).busy, true);
    const done = writer({ start: "2026-11-22T11:00:00.000Z" });
    done.taskComplete({ turn: "k1" });
    const line = done.lines[0];
    appendFileSync(f, line.slice(0, 40));
    assert.equal(t.state(f).busy, true, "a partial line waits");
    appendFileSync(f, `${line.slice(40)}\n`);
    assert.equal(t.state(f).busy, false);
    // rewritten in place with a different, longer history: the bytes before the offset changed → a fresh scan
    const y = writer({ start: "2026-11-22T12:00:00.000Z" });
    y.turnContext({ turn: "k2", model: "m-two" });
    for (let i = 0; i < 220; i++) y.agentMessage();
    y.taskStarted({ turn: "k2" });
    writeFileSync(f, y.text());
    const st = t.state(f);
    assert.deepEqual([st.busy, st.model], [true, "m-two"]);
    assert.equal(JSON.stringify([...t.files.values()].map((v) => ({ ...v, check: null }))).includes(SECRET), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex-sessions: tailState — open turns, aborted turns, traps inside text don't count", () => {
  const w = writer();
  w.turnContext({ turn: "x1", model: "m-one", settingsEffort: "low" });
  w.taskStarted({ turn: "x1" });
  w.taskComplete({ turn: "x1" });
  w.turnContext({ turn: "x2", model: "m-two", settingsEffort: null });
  w.taskStarted({ turn: "x2" });
  w.turnAborted({ turn: "x2" });
  const st = C.tailState(w.lines);
  assert.equal(st.busy, false);
  assert.equal(st.model, "m-two", "the top-level model, not the one inside developer instructions");
  assert.equal(st.effort, null, "an escaped \"effort\" inside text is not an effort");
  w.taskStarted({ turn: "x3" });
  assert.equal(C.tailState(w.lines).busy, true);
  assert.deepEqual(C.sourceKind('{"subagent":{"thread_spawn":{"parent_thread_id":"ABC","depth":1}}}'), { kind: "sub", parent: "abc", what: "thread_spawn" });
  assert.equal(C.sourceKind("exec").kind, "exec");
  assert.equal(C.inCmux(3, C.parsePs("1 0 ?? launchd\n2 1 ?? /Applications/cmux.app/Contents/MacOS/cmux\n3 2 ttys001 codex\n")), true);
});

test("codex-sessions: the process — sqlite3 fallback, one frame, refresh from stdin, exits on stdin close", async () => {
  const w = world();
  try {
    const env = { HOME: w.root, PATH: "/usr/bin:/bin", AGENTHUB_LANG: "en", AGENTHUB_TEST_BIN_DIR: w.bin, AGENTHUB_TEST_NOW: "2026-11-22T10:30:00.000Z", AGENTHUB_TEST_POLL_MS: "60000", AGENTHUB_CODEX_NO_NODE_SQLITE: "1" };
    const p = spawn(process.execPath, [FILE], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const until = async (pred, ms = 8000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error(`timeout; out=${out} err=${err}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until(() => splitFrames(out).length >= 1);
    const f = parseOutput(splitFrames(out)[0]);
    assert.match(f.header[0].title, /^Codex: 1 working · 2 idle$/);
    assert.match(out, /Refactor — working/);
    // the hosted session leaves: refresh → a new frame
    const state = JSON.parse(readFileSync(join(w.bin, "world.json"), "utf8"));
    delete state.locks[ID.hosted];
    writeFileSync(join(w.bin, "world.json"), JSON.stringify(state));
    p.stdin.write('{"type":"refresh"}\n');
    await until(() => splitFrames(out).length >= 2);
    assert.match(parseOutput(splitFrames(out)[1]).header[0].title, /^Codex: 1 working · 1 idle$/);
    assert.doesNotMatch(out, new RegExp(SECRET));
    const exited = new Promise((r) => p.on("exit", r));
    p.stdin.end();
    await exited;
    assert.equal(err, "");
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});
