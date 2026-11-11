// The Terminal.app terminal adapter (lib/terminals/index.mjs describes the interface).
//
// Where the session is: the nearest terminal among the ancestors of the Claude Code process is Terminal.app
// (lib/terminals/_proc.mjs); the tab is found by the process's controlling terminal (tty of tab in Terminal's AppleScript
// dictionary) only when an operation runs.
//
// Operations go through /usr/bin/osascript with the arguments in argv (`on run argv`). Supported: switch to the tab and open a
// new window with a session (`do script`). Reading the screen, typing a line and Esc are not: Terminal.app can type only
// through `do script` (always with Enter) or System Events keystrokes into whatever window is in front — neither can check
// the input field first, so the adapter does not declare them.
// The first call asks macOS for permission to control Terminal (Privacy & Security → Automation).

import { existsSync } from "node:fs";
import { hostOf, ttyOf } from "./_proc.mjs";
import { execError, execOf } from "./_exec.mjs";
import { launchCommand, osa, OSASCRIPT } from "./iterm2.mjs";

export const id = "terminal-app";
export const label = "Terminal";
export const capabilities = Object.freeze(["focus", "launch"]);
export const APP_PATHS = Object.freeze(["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"]);

const FOCUS_SCRIPT = [
  "on run argv",
  "set want to item 1 of argv",
  'tell application "Terminal"',
  "repeat with w in windows",
  "repeat with t in tabs of w",
  "if (tty of t) is want then",
  "set selected of t to true",
  "set index of w to 1",
  "activate",
  'return "ok"',
  "end if",
  "end repeat",
  "end repeat",
  "end tell",
  'return "no-tab"',
  "end run",
];

const LAUNCH_SCRIPT = ["on run argv", 'tell application "Terminal" to do script (item 1 of argv)', 'return "ok"', "end run"];

export function locate(session, facts) {
  const h = hostOf(session.pid, facts);
  if (h?.id !== id) return null;
  return { target: { terminal: id, tab: `pid:${session.pid}`, pid: session.pid } };
}

export function idle() {
  return false;
}

export function installed({ exists = existsSync } = {}) {
  return APP_PATHS.some((p) => exists(p));
}

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

export async function launch(args, facts) {
  const r = await execOf(facts)(OSASCRIPT, [...osa(LAUNCH_SCRIPT), "--", launchCommand(args)], { timeoutMs: 15_000 });
  if (r.code !== 0) return { ok: false, error: execError(r, "osascript") };
  return { ok: true };
}
