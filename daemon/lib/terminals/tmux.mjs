// The tmux terminal adapter (lib/terminals/index.mjs describes the interface).
//
// Where the session is: the nearest terminal among the ancestors of the Claude Code process is a tmux server
// (lib/terminals/_proc.mjs). The pane is found when an operation runs: `tmux list-panes -a` → the pane whose pane_tty is the
// process's controlling terminal. The tmux binary is the server's own executable (an absolute path from the process table, not
// PATH); a server started with -L <name> or -S <path> is reached the same way (read from the server's argv).
//
// Operations (all through the tmux CLI, execFile without a shell):
//   focus       — select-window and select-pane of the pane, switch-client to it; then the window of the terminal the tmux
//                 client runs in (iTerm2, Terminal.app) is brought to the front if that terminal has an adapter;
//   read-screen — capture-pane of the visible pane (no history): only the input field flags leave the adapter;
//   send-text   — the same protocol as the cmux bridge (lib/terminals/_screen.mjs): the field is empty and no turn runs →
//                 send-keys -l (literal) → the field holds exactly this line → send-keys Enter;
//   send-esc    — send-keys Escape;
//   launch      — new-window -d in the default server (the most recently used session) with bridge/launch.sh.

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { hostOf, ttyOf } from "./_proc.mjs";
import { execError, execOf, LAUNCH_SH, shQuote } from "./_exec.mjs";
import { analyzeScreen, flags, typeLine } from "./_screen.mjs";
import * as iterm2 from "./iterm2.mjs";
import * as terminalApp from "./terminal-app.mjs";

export const id = "tmux";
export const label = "tmux";
export const capabilities = Object.freeze(["focus", "read-screen", "send-text", "send-esc", "launch"]);
export const BIN_PATHS = Object.freeze(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/opt/local/bin/tmux", "/usr/bin/tmux"]);

const PANE_RE = /^%\d{1,9}$/;
const SESSION_RE = /^\$\d{1,9}$/;
const SOCKET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// Server socket flags from the tmux server's argv: -L <name> or -S <path>. Anything else → the default socket.
export function socketArgs(argv) {
  if (!Array.isArray(argv)) return [];
  for (let i = 1; i < argv.length - 1; i++) {
    const a = argv[i];
    if (a === "-L" && SOCKET_NAME_RE.test(argv[i + 1])) return ["-L", argv[i + 1]];
    if (a === "-S" && isAbsolute(argv[i + 1]) && !/[\0-\x1f]/.test(argv[i + 1])) return ["-S", argv[i + 1]];
    if (!a.startsWith("-")) break; // the command (new-session …) — its own flags are not the server's
  }
  return [];
}

// → { target: {terminal, tab, pid, bin, socket} } | null
export function locate(session, facts) {
  const h = hostOf(session.pid, facts);
  if (h?.id !== id || !isAbsolute(h.path || "")) return null;
  let argv = null;
  try {
    argv = facts.processArgv?.(h.pid) ?? null;
  } catch {}
  return { target: { terminal: id, tab: `pid:${session.pid}`, pid: session.pid, bin: h.path, socket: socketArgs(argv) } };
}

export function idle() {
  return false; // tmux knows nothing about Claude Code turns: no hint
}

export function installed({ exists = existsSync } = {}) {
  return BIN_PATHS.some((p) => exists(p));
}

function run(target, facts, args, opts) {
  return execOf(facts)(target.bin, [...(target.socket || []), ...args], opts);
}

// The pane of the session's tty. → { pane, session } | { error }
export async function pane(target, facts) {
  const tty = ttyOf(target.pid, facts);
  if (!tty) return { error: "no-tab" };
  const r = await run(target, facts, ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_id}\t#{session_id}"]);
  if (r.code !== 0) return { error: execError(r, "tmux") };
  for (const line of r.stdout.split("\n")) {
    const [t, p, s] = line.split("\t");
    if (t === tty && PANE_RE.test(p || "")) return { pane: p, session: SESSION_RE.test(s || "") ? s : null };
  }
  return { error: "no-tab" };
}

// Bring the window of the terminal the tmux client runs in to the front (best effort: tmux has already switched).
async function raiseClient(target, facts, session) {
  if (!session) return;
  const r = await run(target, facts, ["list-clients", "-t", session, "-F", "#{client_tty}\t#{client_pid}"]);
  if (r.code !== 0) return;
  const [tty, pid] = (r.stdout.split("\n")[0] || "").split("\t");
  const host = hostOf(Number(pid), facts);
  if (!/^\/dev\/tty[A-Za-z0-9]{1,12}$/.test(tty || "")) return;
  try {
    if (host?.id === iterm2.id) await iterm2.focusTty(tty, facts);
    else if (host?.id === terminalApp.id) await terminalApp.focusTty(tty, facts);
  } catch {}
}

export async function focus(target, facts) {
  const p = await pane(target, facts);
  if (p.error) return { ok: false, error: p.error };
  for (const args of [["select-window", "-t", p.pane], ["select-pane", "-t", p.pane]]) {
    const r = await run(target, facts, args);
    if (r.code !== 0) return { ok: false, error: execError(r, "tmux") };
  }
  // no attached client is not an error: the pane is selected for the next attach
  await run(target, facts, ["switch-client", "-t", p.pane]);
  await raiseClient(target, facts, p.session);
  return { ok: true };
}

async function capture(target, facts, paneId) {
  const r = await run(target, facts, ["capture-pane", "-p", "-t", paneId]);
  return r.code === 0 ? { ok: true, text: r.stdout } : { ok: false, error: execError(r, "tmux") };
}

// → { ok, error?, promptFound?, promptEmpty?, busy? }
export async function readScreen(target, facts, { lines } = {}) {
  const p = await pane(target, facts);
  if (p.error) return { ok: false, error: p.error };
  const r = await capture(target, facts, p.pane);
  if (!r.ok) return r;
  return { ok: true, ...flags(analyzeScreen(r.text, lines || undefined)) };
}

export async function sendText(target, text, facts, opts = {}) {
  const p = await pane(target, facts);
  if (p.error) return { ok: false, error: p.error };
  const key = async (args) => {
    const r = await run(target, facts, ["send-keys", "-t", p.pane, ...args]);
    return r.code === 0 ? { ok: true } : { ok: false, error: execError(r, "tmux") };
  };
  return typeLine(
    {
      read: () => capture(target, facts, p.pane),
      type: (t) => key(["-l", "--", t]),
      enter: () => key(["Enter"]),
    },
    text,
    opts,
  );
}

export async function sendKey(target, k, facts) {
  if (k !== "escape") return { ok: false, error: "bad-key" };
  const p = await pane(target, facts);
  if (p.error) return { ok: false, error: p.error };
  const r = await run(target, facts, ["send-keys", "-t", p.pane, "Escape"]);
  return r.code === 0 ? { ok: true } : { ok: false, error: execError(r, "tmux") };
}

// A new window in the default tmux server, in the background. → { ok, error? }
export async function launch({ cwd, name, sessionId, promptFile }, facts, { exists = existsSync } = {}) {
  const bin = BIN_PATHS.find((p) => exists(p));
  if (!bin) return { ok: false, error: "not-installed" };
  const cmd = `exec ${shQuote(LAUNCH_SH)} ${shQuote(sessionId)} ${shQuote(name)} ${shQuote(promptFile)}`;
  const r = await execOf(facts)(bin, ["new-window", "-d", "-c", cwd, "-n", name, cmd]);
  if (r.code !== 0) return { ok: false, error: execError(r, "tmux") };
  return { ok: true };
}
