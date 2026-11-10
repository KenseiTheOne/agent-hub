// Shared helpers for the stage 5 primitives (cmux.focus, session.*).
// The file starts with `_`, so the primitive loader skips it; the primitives and the actions service import it.
//
// Settings: config.actions (merged over ACTION_DEFAULTS). Primitives get them through the "actions.config" fact
// set by the lib/services/actions.mjs service: verifyFacts sees only facts.
// No service means no fact, and the primitives refuse (fail closed, not open).
//
// Only the needed fields are read from foreign files: claude-hook-sessions.json has lastBody (conversation text),
// which is skipped; from ~/.claude/sessions/<pid>.json only sessionId, pid, kind, procStart; nearby *.key files are not touched.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deepMerge, expandHome } from "../config.mjs";

export const UUID_SRC = "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$";
export const UUID_RE = new RegExp(UUID_SRC);
// Name of the session to launch: letters/digits, space, . _ ( ) -. No quotes or shell metacharacters.
export const SESSION_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,63}$/u;

export const ACTION_DEFAULTS = Object.freeze({
  // The cmux file mapping sessions to tabs (read-only).
  cmuxHookSessions: "~/.cmuxterm/claude-hook-sessions.json",
  launch: {
    // How long to wait for the launched session's entry in claude-hook-sessions.json.
    registerTimeoutMs: 60_000,
    pollMs: 500,
  },
});

// Merged settings with expanded paths.
export function actionsConfig(config) {
  const home = homedir();
  const a = deepMerge(structuredClone(ACTION_DEFAULTS), config?.actions || {});
  const x = (p) => (typeof p === "string" ? expandHome(p, home) : p);
  return {
    cmuxHookSessions: x(a.cmuxHookSessions),
    launch: { ...a.launch },
    claudeHome: config?.claudeHome || join(home, ".claude"),
    agenthubHome: config?.paths?.home || null,
    launchDir: config?.paths?.home ? join(config.paths.home, "launch") : null,
    logsDir: config?.paths?.logs || null,
    testExecLog: config?.testExecLog || null,
  };
}

export function cfgOf(facts) {
  const c = facts?.get?.("actions.config");
  return c && typeof c === "object" ? c : null;
}

export function bridgeOf(facts) {
  const ch = facts?.get?.("bridge.channel");
  return ch && typeof ch.call === "function" ? ch : null;
}

// ---------- cmux: session-to-tab mapping ----------
// → Map(sessionId → {sessionId, pid, pidStartSeconds, surfaceId, workspaceId, agentLifecycle}) | null
export function readCmuxSessions(cfg) {
  let data;
  try {
    data = JSON.parse(readFileSync(cfg.cmuxHookSessions, "utf8"));
  } catch {
    return null;
  }
  const s = data?.sessions;
  if (!s || typeof s !== "object") return null;
  const out = new Map();
  for (const e of Array.isArray(s) ? s : Object.values(s)) {
    if (!e || typeof e.sessionId !== "string") continue;
    out.set(e.sessionId.toLowerCase(), {
      sessionId: e.sessionId,
      pid: Number.isInteger(e.pid) ? e.pid : null,
      pidStartSeconds: typeof e.pidStartSeconds === "number" ? e.pidStartSeconds : null,
      surfaceId: typeof e.surfaceId === "string" && UUID_RE.test(e.surfaceId) ? e.surfaceId : null,
      workspaceId: typeof e.workspaceId === "string" && UUID_RE.test(e.workspaceId) ? e.workspaceId : null,
      agentLifecycle: typeof e.agentLifecycle === "string" ? e.agentLifecycle.slice(0, 32) : null,
    });
  }
  return out;
}

// Tab by surfaceId: first the core session registry, then the cmux file. → {surfaceId, workspaceId} | null
export function findSurface(surfaceId, facts, cfg) {
  const want = String(surfaceId).toLowerCase();
  for (const s of facts.sessions?.() || []) {
    if (typeof s.surfaceId === "string" && s.surfaceId.toLowerCase() === want && UUID_RE.test(s.workspaceId || "")) {
      return { surfaceId: s.surfaceId, workspaceId: s.workspaceId };
    }
  }
  const m = cfg ? readCmuxSessions(cfg) : null;
  for (const e of m?.values() || []) {
    if (e.surfaceId && e.surfaceId.toLowerCase() === want && e.workspaceId) return { surfaceId: e.surfaceId, workspaceId: e.workspaceId };
  }
  return null;
}

// ---------- ~/.claude/sessions/<pid>.json ----------
// → {exists, sessionId?, pid?, kind?, procStart?}
export function readClaudeSessionFile(cfg, pid) {
  const p = join(cfg.claudeHome, "sessions", `${pid}.json`);
  let d;
  try {
    d = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    return { exists: existsSync(p), unreadable: existsSync(p) };
  }
  return {
    exists: true,
    sessionId: typeof d?.sessionId === "string" ? d.sessionId : null,
    pid: Number.isInteger(d?.pid) ? d.pid : null,
    kind: typeof d?.kind === "string" ? d.kind.slice(0, 32) : null,
    procStart: typeof d?.procStart === "string" ? d.procStart.slice(0, 64) : null,
  };
}

// procStart is a string like `ps -o lstart` output ("Thu Oct 30 12:34:56 2026"), but in another time zone (whole-hour offset).
// It matches if the difference from the real start time is a whole number of hours (up to 14) ± 2 s.
export function procStartMatches(procStart, startSec) {
  if (typeof procStart !== "string" || !Number.isFinite(startSec)) return null;
  const t = Date.parse(procStart);
  if (!Number.isFinite(t)) return null;
  const diff = t / 1000 - startSec;
  if (Math.abs(diff) > 14 * 3600 + 2) return false;
  return Math.abs(diff - Math.round(diff / 3600) * 3600) <= 2;
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
