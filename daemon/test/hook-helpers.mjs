// Stage 6 test helpers: a system double on top of the real addon and running the real agenthub-hook.
//
// Double: real peerPid/peerUid/procArgv (the peer on the socket is determined honestly), while the process
// table can be extended with fictitious pids (Claude Code, AgentHub.app) and the real hook process can be reparented
// to a fictitious Claude. codesign for fictitious paths answers from the signed list.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR, DEFAULTS } from "../lib/config.mjs";
import { defaultSys } from "../lib/peer.mjs";

export const HOOK_SCRIPT = join(REPO_DIR, "hook", "agenthub-hook");
export const FAKE_CLAUDE = "/fake/.local/share/claude/versions/9.9.9";
export const FAKE_APP = "/fake/Applications/AgentHub.app/Contents/MacOS/AgentHub";
export const APP_REQ = 'identifier "com.kensei.agenthub" and certificate leaf = H"0000000000000000000000000000000000000000"';

export function sysDouble() {
  const real = defaultSys();
  const procs = new Map(); // pid → { ppid, path?, startSec? }
  const signed = new Map([
    [FAKE_CLAUDE, DEFAULTS.requirements.claudeCode],
    [FAKE_APP, APP_REQ],
  ]);
  const uid = process.getuid();
  return {
    ...real,
    procs,
    signed,
    pidInfo(pid) {
      const p = procs.get(pid);
      if (!p) return real.pidInfo(pid);
      if (p.dead) return null;
      const r = p.path ? null : real.pidInfo(pid);
      return { pid, ppid: p.ppid, uid, startSec: p.startSec ?? r?.startSec ?? 1000, startUsec: 0, comm: "x", tty: p.tty ?? (p.path ? true : r?.tty ?? false) };
    },
    procArgv(pid) {
      const p = procs.get(pid);
      return p?.argv ?? real.procArgv(pid);
    },
    // The core's signature info (csops) for fictitious processes — only if set explicitly.
    codeInfo(pid) {
      return procs.get(pid)?.code ?? null;
    },
    pidPath(pid) {
      const p = procs.get(pid);
      if (p?.dead) return null;
      return p?.path ?? real.pidPath(pid);
    },
    async codesignVerify(path, requirement) {
      if (signed.has(path)) return signed.get(path) === requirement;
      if (path.startsWith("/fake/")) return false;
      return real.codesignVerify(path, requirement);
    },
    fileId(path) {
      return path.startsWith("/fake/") ? `${path}|fake` : real.fileId(path);
    },
  };
}

// A fictitious Claude Code process with a session file.
// argv and tty are what the daemon looks at in the process itself: an interactive session has a terminal and no -p.
export function fakeClaude(h, sys, pid, sessionId, { kind = "interactive", entrypoint = "cli", startSec = 1000, argv = null, tty = null } = {}) {
  const print = kind !== "interactive";
  sys.procs.set(pid, { ppid: 1, path: FAKE_CLAUDE, startSec, argv: argv ?? (print ? ["claude", "-p", "x"] : ["claude"]), tty: tty ?? !print });
  writeFileSync(join(h.claudeHome, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, kind, entrypoint, status: "idle", version: "9.9.9" }));
}

// The test process is the "app": req() requests from the test come as if from AgentHub.app.
export function asApp(sys) {
  sys.procs.set(process.pid, { ppid: 1, path: FAKE_APP });
}

// An environment without NODE_OPTIONS (the cmux preload crashes child node processes).
export function childEnv(extra = {}) {
  const e = { ...process.env, ...extra };
  delete e.NODE_OPTIONS;
  return e;
}

// Runs the real agenthub-hook (via #!), reparents it to the fictitious Claude (claudePid),
// writes body to stdin. → Promise<{ code, out, json, ms }>
export function runHook({ home, body, claudePid = null, sys = null, env = {}, script = HOOK_SCRIPT }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(script, [], { env: childEnv({ AGENTHUB_HOME: home, ...env }), stdio: ["pipe", "pipe", "pipe"] });
    if (sys && claudePid) sys.procs.set(child.pid, { ppid: claudePid });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (sys) sys.procs.delete(child.pid);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {}
      resolve({ code, out, err, json, ms: Date.now() - t0 });
    });
    child.stdin.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}
