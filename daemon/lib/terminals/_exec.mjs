// Running a terminal's command-line tool (tmux, osascript) for the terminal layer. The file starts with `_`: a helper, not an adapter.
//
// The core hands the runner to adapters as the terminalExec fact (Core opts.terminalExec). A test hub (config.testMode)
// without an explicit runner gets refuseExec: no real tmux or osascript is ever started from a test copy — like the app
// service, which leaves the real app alone in test mode. Commands run with execFile (no shell), a timeout and an environment
// without NODE_OPTIONS; the output never goes to the journal.

import { execFile } from "node:child_process";
import { join } from "node:path";
import { REPO_DIR } from "../config.mjs";

// The first command of a new tab for session.launch (reads and deletes the prompt file, starts claude): the same script the
// cmux bridge runs, next to it in the hub's tree.
export const LAUNCH_SH = join(REPO_DIR, "bridge", "launch.sh");

export const EXEC_TIMEOUT_MS = 8_000;

// → Promise<{ code, stdout, timedOut }>
export function realExec(file, args, { timeoutMs = EXEC_TIMEOUT_MS } = {}) {
  return new Promise((res) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      res({ code, stdout: String(stdout ?? ""), timedOut: Boolean(err?.killed) });
    });
  });
}

// Test mode without a runner double: nothing is started.
export async function refuseExec() {
  return { code: -1, stdout: "", timedOut: false, refused: "test-mode" };
}

// The runner from the facts; none → refuseExec (fail closed).
export function execOf(facts) {
  const fn = facts?.terminalExec;
  return typeof fn === "function" ? fn : refuseExec;
}

// Runner result → the layer's error code.
export function execError(r, tool) {
  if (r?.refused) return "terminal-test-mode";
  if (r?.timedOut) return `${tool}-timeout`;
  return `${tool}-failed`;
}

// Shell single quotes: ' → '\''.
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}
