// cmux bridge: the operation allowlist, launch.sh, and an end-to-end check — a real bridge process on the daemon
// socket (class bridge via peercred) with a cmux CLI double and a claude double. The live cmux is never called.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../lib/config.mjs";
import { loadNative } from "../lib/native.mjs";
import { buildArgv, runOp, shQuote, childEnv } from "../../bridge/agenthub-bridge.mjs";
import { cleanup, curl, onlyDarwin, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const BRIDGE = join(REPO_DIR, "bridge", "agenthub-bridge.mjs");
const LAUNCH = join(REPO_DIR, "bridge", "launch.sh");
const SURF = "C0FFEE00-1111-4111-8111-111111111111";
const WS = "DEADBEEF-2222-4222-8222-222222222222";
const SID = "aaaaaaaa-1111-4111-8111-111111111111";
// The bridge works only next to cmux (macOS): prompt file owner uid, mode 0600, launch.sh on sh.
const CMUX = onlyDarwin("cmux bridge");

test("allowlist: only surface.focus, send-key escape, new-workspace; the target is always explicit", { skip: CMUX }, () => {
  assert.deepEqual(buildArgv({ op: "surface.focus", surfaceId: SURF, workspaceId: WS }).argvs, [
    ["select-workspace", "--workspace", WS],
    ["focus-panel", "--panel", SURF, "--workspace", WS],
  ]);
  assert.deepEqual(buildArgv({ op: "send-key", key: "escape", surfaceId: SURF, workspaceId: WS }).argvs, [["send-key", "--workspace", WS, "--surface", SURF, "escape"]]);
  assert.equal(buildArgv({ op: "send-key", key: "ctrl+c", surfaceId: SURF, workspaceId: WS }).error, "bad-key");
  assert.equal(buildArgv({ op: "send-key", key: "escape", surfaceId: SURF }).error, "bad-workspace");
  assert.equal(buildArgv({ op: "send-key", key: "escape", surfaceId: "surface:1", workspaceId: WS }).error, "bad-surface");
  assert.equal(buildArgv({ op: "send", text: "rm -rf ~" }).error, "not-allowed");
  assert.equal(buildArgv({ op: "surface.focus", surfaceId: SURF, workspaceId: WS, command: "x" }).error, "bad-field:command");
  assert.equal(buildArgv(null).error, "not-allowed");
});

test("new-workspace: prompt file must be our own, 0600, named by session; command — launch.sh quoted", { skip: CMUX }, () => {
  const home = tempHome("ah-br-");
  try {
    const launchDir = join(home, "launch");
    mkdirSync(launchDir, { mode: 0o700 });
    const sid = "0f0f0f0f-1111-4111-8111-111111111111";
    const pf = join(launchDir, `${sid}.prompt`);
    const op = { op: "new-workspace", cwd: home, name: "Моя сессия (1)", sessionId: sid, promptFile: pf };
    assert.equal(buildArgv(op, { launchDir }).error, "no-prompt-file");
    writeFileSync(pf, "p", { mode: 0o644 });
    chmodSync(pf, 0o644);
    assert.equal(buildArgv(op, { launchDir }).error, "bad-prompt-file");
    chmodSync(pf, 0o600);
    const b = buildArgv(op, { launchDir, launchSh: "/a b/launch.sh" });
    assert.deepEqual(b.argvs[0].slice(0, 5), ["new-workspace", "--name", "Моя сессия (1)", "--cwd", home]);
    assert.equal(b.argvs[0][6], `'/a b/launch.sh' '${sid}' 'Моя сессия (1)' '${pf}'`);
    assert.equal(buildArgv({ ...op, promptFile: join(home, "x.prompt") }, { launchDir }).error, "bad-prompt-file");
    assert.equal(buildArgv({ ...op, name: "a'b" }, { launchDir }).error, "bad-name");
    assert.equal(buildArgv({ ...op, name: "a$(id)" }, { launchDir }).error, "bad-name");
    assert.equal(buildArgv({ ...op, cwd: "rel" }, { launchDir }).error, "bad-cwd");
    assert.equal(buildArgv({ ...op, sessionId: "X" }, { launchDir }).error, "bad-session");
    assert.equal(shQuote("a'b"), `'a'\\''b'`);
  } finally {
    cleanup(home);
  }
});

test("runOp: an expired operation is not executed; cmux error — ok:false; environment without its own tab", { skip: CMUX }, async () => {
  const calls = [];
  const exec = async (cmux, argv) => {
    calls.push(argv);
    return { code: argv[0] === "focus-panel" ? 1 : 0, stdout: "" };
  };
  assert.deepEqual(await runOp({ op: "send-key", key: "escape", surfaceId: SURF, workspaceId: WS, expiresAt: Date.now() - 1 }, { cmux: "/x", exec }), { ok: false, code: null, error: "expired" });
  assert.equal(calls.length, 0);
  const r = await runOp({ op: "surface.focus", surfaceId: SURF, workspaceId: WS, expiresAt: Date.now() + 5000 }, { cmux: "/x", exec });
  assert.deepEqual(r, { ok: false, code: 1, error: "cmux-failed" });
  const env = childEnv({ NODE_OPTIONS: "--require x", CMUX_SURFACE_ID: "s", CMUX_PANEL_ID: "p", CMUX_TAB_ID: "t", CMUX_WORKSPACE_ID: "w", PATH: "/bin" });
  assert.deepEqual(Object.keys(env).sort(), ["CMUX_WORKSPACE_ID", "PATH"]);
});

function fakeTools(dir) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  // claude double: writes argv one per line and (if FAKE_HOOK_FILE is set) a cmux session entry
  writePlugin(
    bin,
    "claude",
    `#!/bin/sh
: > "$FAKE_CLAUDE_LOG"
for a in "$@"; do printf '%s\\n--\\n' "$a" >> "$FAKE_CLAUDE_LOG"; done
if [ -n "\${FAKE_HOOK_FILE-}" ]; then
  printf '{"version":1,"sessions":{"%s":{"sessionId":"%s","pid":%s,"surfaceId":"${SURF}","workspaceId":"${WS}","agentLifecycle":"idle","lastBody":"x"}}}' "$2" "$2" "$$" > "$FAKE_HOOK_FILE"
fi
`,
  );
  // cmux CLI double: writes argv; new-workspace runs --command in --cwd (as the tab's first command)
  const cmux = writePlugin(
    bin,
    "cmux",
    `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CMUX_LOG"
if [ "$1" = "new-workspace" ]; then
  cwd=; cmd=
  while [ $# -gt 0 ]; do
    case "$1" in --cwd) cwd=$2; shift 2 ;; --command) cmd=$2; shift 2 ;; *) shift ;; esac
  done
  echo "OK ${WS}"
  (cd "$cwd" && PATH="$FAKE_BIN:/usr/bin:/bin" sh -c "$cmd") > /dev/null 2>&1 &
fi
exit 0
`,
  );
  return { bin, cmux };
}

function sh(file, args, env) {
  return new Promise((res) => execFile(file, args, { env }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout, stderr })));
}

test("launch.sh: reads and deletes the 0600 prompt, runs claude --session-id --remote-control -n -- prompt", { skip: CMUX }, async () => {
  const dir = tempHome("ah-ls-");
  try {
    const { bin } = fakeTools(dir);
    const log = join(dir, "claude.log");
    const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_CLAUDE_LOG: log, HOME: dir };
    const sid = "0f0f0f0f-1111-4111-8111-111111111111";
    const pf = join(dir, `${sid}.prompt`);
    const prompt = "строка 1 'кавычки' $(id) `x`\n--settings evil\n";
    writeFileSync(pf, prompt, { mode: 0o600 });
    const r = await sh(LAUNCH, [sid, "Имя сессии", pf], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!existsSync(pf), "prompt file deleted");
    const argv = readFileSync(log, "utf8").split("\n--\n").slice(0, -1);
    assert.deepEqual(argv, ["--session-id", sid, "--remote-control", "-n", "Имя сессии", "--", prompt]);
    // no prompt — no positional argument
    writeFileSync(pf, "", { mode: 0o600 });
    await sh(LAUNCH, [sid, "N", pf], env);
    assert.deepEqual(readFileSync(log, "utf8").split("\n--\n").slice(0, -1), ["--session-id", sid, "--remote-control", "-n", "N"]);
    // permissions other than 0600 — refusal and deletion
    writeFileSync(pf, "x", { mode: 0o644 });
    chmodSync(pf, 0o644);
    writeFileSync(log, "");
    assert.equal((await sh(LAUNCH, [sid, "N", pf], env)).code, 2);
    assert.ok(!existsSync(pf));
    assert.equal(readFileSync(log, "utf8"), "");
    // foreign file name and bad id — refusal
    writeFileSync(join(dir, "other.prompt"), "x", { mode: 0o600 });
    assert.equal((await sh(LAUNCH, [sid, "N", join(dir, "other.prompt")], env)).code, 2);
    assert.equal((await sh(LAUNCH, ["../../x", "N", pf], env)).code, 2);
  } finally {
    cleanup(dir);
  }
});

test("end-to-end: a real bridge on the socket (class bridge), cmux.focus from curl, session.launch from app", { skip: CMUX || (!loadNative() && "no peercred addon") }, async () => {
  const tools = tempHome("ah-tl-");
  const project = tempHome("ah-pj-");
  const { bin, cmux } = fakeTools(tools);
  const hookFile = join(tools, "claude-hook-sessions.json");
  writeFileSync(hookFile, JSON.stringify({ version: 1, sessions: { [SID]: { sessionId: SID, pid: 1, surfaceId: SURF, workspaceId: WS, agentLifecycle: "idle" } } }));
  const h = await startHub({
    services: "actions",
    overrides: { actions: { cmuxHookSessions: hookFile, launch: { registerTimeoutMs: 5000, pollMs: 50 } } },
  });
  const cmuxLog = join(tools, "cmux.log");
  const claudeLog = join(tools, "claude.log");
  const child = spawn(process.execPath, [BRIDGE], {
    env: { HOME: tools, PATH: "/usr/bin:/bin", AGENTHUB_HOME: h.home, AGENTHUB_CMUX: cmux, FAKE_CMUX_LOG: cmuxLog, FAKE_BIN: bin, FAKE_CLAUDE_LOG: claudeLog, FAKE_HOOK_FILE: hookFile },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  try {
    await waitFor(() => h.core.facts.get("bridge.online"), { timeoutMs: 8000 });
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "bridge-hello"));
    // other classes are not admitted to the bridge channel
    const denied = await curl(h.sock, "GET", "/bridge/next?wait=0");
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "peer:cli");
    // cmux.focus — level "immediate", available to cli
    const f = await curl(h.sock, "POST", "/actions/cmux.focus", { args: { surfaceId: SURF } });
    assert.equal(f.status, 200, f.text);
    assert.equal(f.body.ok, true);
    assert.deepEqual(readFileSync(cmuxLog, "utf8").trim().split("\n"), [`select-workspace --workspace ${WS}`, `focus-panel --panel ${SURF} --workspace ${WS}`]);
    // session.interrupt from curl — 403
    assert.equal((await curl(h.sock, "POST", "/actions/session.interrupt", { args: { sessionId: SID } })).body.error, "peer:cli");

    // session.launch from app (the peer is given explicitly: the app class is checked by signature, which is absent here)
    const app = { class: "app", pid: process.pid };
    const registered = [];
    h.core.on("bridge.launch.registered", (e) => registered.push(e));
    const prompt = "сделай 'это'\nи то";
    const args = { cwd: project, name: "Тест запуска", prompt };
    const t = await h.core.invoke({ id: "session.launch", args, peer: app });
    assert.equal(t.status, 428);
    const r = await h.core.invoke({ id: "session.launch", args, confirmToken: t.body.token, peer: app });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.result.workspaceId, WS);
    const sid = r.body.result.sessionId;
    await waitFor(() => registered.length === 1, { timeoutMs: 8000 });
    assert.equal(registered[0].sessionId, sid);
    const argv = readFileSync(claudeLog, "utf8").split("\n--\n").slice(0, -1);
    assert.deepEqual(argv, ["--session-id", sid, "--remote-control", "-n", "Тест запуска", "--", prompt]);
    assert.ok(!existsSync(join(h.home, "launch", `${sid}.prompt`)));
    const cmuxLines = readFileSync(cmuxLog, "utf8");
    assert.ok(!cmuxLines.includes("сделай"), "prompt is not on the cmux command line");
    const journal = readFileSync(h.config.paths.journal, "utf8");
    assert.ok(!journal.includes("сделай"), "prompt is not in the journal");
    assert.ok(journal.includes('"op":"new-workspace"'));
    assert.ok(!/CMUX_SOCKET|PASSWORD/.test(stderr));
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    await h.stop();
    cleanup(tools);
    cleanup(project);
  }
});
