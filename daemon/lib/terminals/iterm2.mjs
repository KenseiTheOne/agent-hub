// The iTerm2 terminal adapter (lib/terminals/index.mjs describes the interface).
//
// Where the session is: the nearest terminal among the ancestors of the Claude Code process is iTerm2 (iTerm2 or its iTermServer
// process, lib/terminals/_proc.mjs); the tab is found by the process's controlling terminal (tty of session in iTerm2's
// AppleScript dictionary) only when an operation runs.
//
// Operations go through /usr/bin/osascript with the arguments in argv (`on run argv`): no value is ever pasted into the
// script text. Supported: switch to the tab and open a new tab with a session. Reading the screen, typing a line and Esc are
// not: iTerm2's `write text` and `contents` give no reliable way to check the input field before and after typing, so the
// adapter does not declare them (the hub answers terminal:unsupported, the shell disables the buttons).
// The first call asks macOS for permission to control iTerm2 (Privacy & Security → Automation).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hostOf, ttyOf } from "./_proc.mjs";
import { execError, execOf, LAUNCH_SH, shQuote } from "./_exec.mjs";

export const id = "iterm2";
export const label = "iTerm2";
// The place in the adapter list (lib/terminals/index.mjs): a session two adapters could claim goes to the lower one.
export const order = 30;
export const capabilities = Object.freeze(["focus", "launch"]);
export const APP_PATHS = Object.freeze(["/Applications/iTerm.app", join(homedir(), "Applications", "iTerm.app")]);
export const OSASCRIPT = "/usr/bin/osascript";

const FOCUS_SCRIPT = [
  "on run argv",
  "set want to item 1 of argv",
  'tell application "iTerm2"',
  "repeat with w in windows",
  "repeat with t in tabs of w",
  "repeat with s in sessions of t",
  "if (tty of s) is want then",
  "select w",
  "tell t to select",
  "tell s to select",
  "activate",
  'return "ok"',
  "end if",
  "end repeat",
  "end repeat",
  "end repeat",
  "end tell",
  'return "no-tab"',
  "end run",
];

const LAUNCH_SCRIPT = [
  "on run argv",
  "set cmd to item 1 of argv",
  'tell application "iTerm2"',
  "if (count of windows) is 0 then",
  "set w to (create window with default profile)",
  "else",
  "set w to current window",
  "tell w to create tab with default profile",
  "end if",
  "tell current session of w to write text cmd",
  "end tell",
  'return "ok"',
  "end run",
];

export const osa = (lines) => lines.flatMap((l) => ["-e", l]);

// → { target: {terminal, tab, pid} } | null
export function locate(session, facts) {
  const h = hostOf(session.pid, facts);
  if (h?.id !== id) return null;
  return { target: { terminal: id, tab: `pid:${session.pid}`, pid: session.pid } };
}

export function idle() {
  return false; // iTerm2 knows nothing about Claude Code turns: no hint
}

export function installed({ exists = existsSync } = {}) {
  return APP_PATHS.some((p) => exists(p));
}

// Switch to the iTerm2 session on this tty (also used by tmux for the window its client runs in). → { ok, error? }
export async function focusTty(tty, facts) {
  const r = await execOf(facts)(OSASCRIPT, [...osa(FOCUS_SCRIPT), "--", tty]);
  if (r.code !== 0) return { ok: false, error: execError(r, "osascript") };
  return r.stdout.trim() === "ok" ? { ok: true } : { ok: false, error: "no-tab" };
}

export async function focus(target, facts) {
  const tty = ttyOf(target.pid, facts);
  if (!tty) return { ok: false, error: "no-tab" };
  return focusTty(tty, facts);
}

// The shell command of the new tab: go to the folder and hand over to bridge/launch.sh (it reads and deletes the prompt file).
export function launchCommand({ cwd, name, sessionId, promptFile }, launchSh = LAUNCH_SH) {
  return ` cd ${shQuote(cwd)} && exec ${shQuote(launchSh)} ${shQuote(sessionId)} ${shQuote(name)} ${shQuote(promptFile)}`;
}

// → { ok, error? }
export async function launch(args, facts) {
  const r = await execOf(facts)(OSASCRIPT, [...osa(LAUNCH_SCRIPT), "--", launchCommand(args)], { timeoutMs: 15_000 });
  if (r.code !== 0) return { ok: false, error: execError(r, "osascript") };
  return { ok: true };
}
