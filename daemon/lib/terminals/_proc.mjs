// Which terminal a Claude Code process runs in — by the executables of its ancestors (the terminal layer, lib/terminals/).
// The file starts with `_`: it is a helper of the layer, not an adapter.
//
// Only the process table is read (native pidInfo and proc_pidpath via the core facts processInfo and processPath): no
// command is run and no terminal is asked, so detection is cheap enough for every /state. The nearest known host wins:
//   claude → zsh → tmux (server)                 → tmux
//   claude → zsh → login → iTermServer-… | iTerm2 → iterm2
//   claude → zsh → login → Terminal              → terminal-app
//   claude → zsh → login → cmux | Ghostty | kitty | WezTerm | … → that host (no chain adapter: cmux finds its tabs
//                                                  from its own session file; the others have no adapter yet)
// The process environment (TERM_PROGRAM, TMUX) is not read: it may hold secrets of the session.

import { basename } from "node:path";

const MAX_DEPTH = 16;
const TTL_MS = 30_000;

// [id, test(path)] in the order they are checked against each ancestor. Hosts without an adapter stop the walk too, so that
// a terminal started from another terminal's shell is not attributed to the outer one.
export const HOSTS = Object.freeze([
  ["tmux", (p) => /^tmux(?:[-.].*)?$/.test(basename(p))],
  ["iterm2", (p) => p.includes("/iTerm.app/Contents/") || /^iTermServer/.test(basename(p))],
  ["terminal-app", (p) => p.endsWith("/Terminal.app/Contents/MacOS/Terminal")],
  ["cmux", (p) => p.includes("/cmux.app/Contents/")],
  ["ghostty", (p) => p.includes("/Ghostty.app/Contents/")],
  ["kitty", (p) => p.includes("/kitty.app/Contents/")],
  ["wezterm", (p) => p.includes("/WezTerm.app/Contents/") || basename(p) === "wezterm-gui"],
  ["alacritty", (p) => p.includes("/Alacritty.app/Contents/")],
  ["warp", (p) => p.includes("/Warp.app/Contents/")],
  ["vscode", (p) => /\/(?:Visual Studio Code|Cursor|Windsurf)[^/]*\.app\/Contents\//.test(p)],
]);

const cache = new Map(); // `${pid}:${startSec}` → { at, host }

export function hostOfPath(path) {
  if (typeof path !== "string" || !path) return null;
  for (const [id, test] of HOSTS) if (test(path)) return id;
  return null;
}

// The nearest terminal host among the ancestors of pid. → { id, pid, path } | null.
// facts: processInfo(pid) → {ppid, startSec} | null, processPath(pid) → string | null.
export function hostOf(pid, facts, { now = Date.now() } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || typeof facts?.processInfo !== "function" || typeof facts?.processPath !== "function") return null;
  let info = null;
  try {
    info = facts.processInfo(pid);
  } catch {}
  if (!info) return null;
  const key = `${pid}:${info.startSec ?? ""}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.host;
  let host = null;
  let cur = info;
  for (let i = 0; i < MAX_DEPTH && cur; i++) {
    const ppid = cur.ppid;
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    let path = null;
    try {
      path = facts.processPath(ppid);
    } catch {}
    const id = hostOfPath(path);
    if (id) {
      host = { id, pid: ppid, path };
      break;
    }
    try {
      cur = facts.processInfo(ppid);
    } catch {
      cur = null;
    }
  }
  if (cache.size > 256) cache.clear();
  cache.set(key, { at: now, host });
  return host;
}

// The controlling terminal device of a process ("/dev/ttys004") — for the adapters that find a tab by its tty (tmux, iTerm2,
// Terminal.app). facts.processTty(pid) → "ttys004" | "/dev/ttys004" | null. Asked only when an operation runs.
export function ttyOf(pid, facts) {
  let t = null;
  try {
    t = facts?.processTty?.(pid) ?? null;
  } catch {}
  if (typeof t !== "string") return null;
  t = t.trim();
  if (!t || t === "??" || t === "-") return null;
  if (!t.startsWith("/dev/")) t = `/dev/${t}`;
  return /^\/dev\/tty[A-Za-z0-9]{1,12}$/.test(t) ? t : null;
}

export function clearCache() {
  cache.clear();
}
