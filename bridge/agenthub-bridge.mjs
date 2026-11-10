#!/usr/bin/env node
// Agent Hub ↔ cmux bridge (stage 5).
//
// Runs in a pinned cmux tab (where it legitimately inherits access to the cmux socket) and connects to
// the daemon's hub.sock as a peer of class bridge (the daemon recognizes it by this file's path — peer.bridgePaths).
// Executes only an allowlist of operations, each via the absolute path to the cmux CLI:
//   surface.focus  → cmux select-workspace --workspace W; cmux focus-panel --panel S --workspace W
//   send-key       → cmux send-key --workspace W --surface S escape            (escape only)
//   new-workspace  → cmux new-workspace --name N --cwd D --command '<bridge/launch.sh> <uuid> <N> <prompt file>'
//   read-screen    → cmux read-screen --workspace W --surface S                (visible screen only, no history)
//                    only Claude Code input field flags go to the daemon {promptFound, promptEmpty, busy} — not text
//   send-text      → read-screen (input field empty, session idle) → cmux send --workspace W --surface S -- <line>
//                    → read-screen (the field holds exactly this line) → cmux send-key --workspace W --surface S enter
//                    Enter only before enterBy (deadline from the daemon): later the daemon has already told the plugin the line didn't go
//                    the line — printable ASCII without "\" (cmux send treats \n, \r, \t as Enter and Tab), 1…200 chars
// The target (tab, workspace) is always given explicitly: otherwise cmux would take $CMUX_SURFACE_ID — the bridge's own tab.
// An operation with an expired expiresAt is not executed. The result is metadata only (ok, code, workspaceId, input field flags);
// neither the screen text nor the typed line gets into the result or the bridge's stderr.
// The daemon logs every operation (bridge-op); the bridge writes the same short line to its own stderr.
//
// Environment: AGENTHUB_HOME (the daemon directory, as for agenthubd), AGENTHUB_CMUX (absolute path to the cmux CLI,
// by default /Applications/cmux.app/Contents/Resources/bin/cmux). The bridge doesn't print environment values.

import { request } from "node:http";
import { execFile } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The version is the VERSION file at the repository root (the hub's single source of truth, docs/hub-updates.md).
export const VERSION = (() => {
  try {
    const v = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "VERSION"), "utf8").trim();
    return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
export const DEFAULT_CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const HERE = dirname(fileURLToPath(import.meta.url));
export const LAUNCH_SH = join(HERE, "launch.sh");

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,63}$/u;
export const OPS = ["surface.focus", "send-key", "new-workspace", "read-screen", "send-text"];
const CMUX_TIMEOUT_MS = 10_000;
// A line for send-text: printable ASCII (space … "~") without backslash, without a leading or trailing space.
// No control characters or line breaks: the bridge itself presses Enter as a single key after checking the field.
export const SEND_TEXT_RE = /^[\x21-\x5B\x5D-\x7E](?:[\x20-\x5B\x5D-\x7E]{0,198}[\x21-\x5B\x5D-\x7E])?$/;
// How many last lines of the visible screen read-screen looks at (the Claude Code input field is at the bottom).
export const SCREEN_LINES_MAX = 30;
export const SCREEN_LINES_DEFAULT = 20;
// Pause between typing the line and checking the field (lets the terminal render).
const SETTLE_MS = 250;

export function hubHome(env = process.env) {
  return env.AGENTHUB_HOME ? resolve(env.AGENTHUB_HOME) : join(homedir(), "Library", "Application Support", "AgentHub");
}

// Shell single quotes: ' → '\''.
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Daemon operation → an argv list for cmux or {error}. Anything not on the allowlist is not-allowed.
export function buildArgv(op, { launchDir, launchSh = LAUNCH_SH, uid = process.getuid() } = {}) {
  if (!op || typeof op !== "object" || !OPS.includes(op.op)) return { error: "not-allowed" };
  const known = {
    "surface.focus": ["surfaceId", "workspaceId"],
    "send-key": ["surfaceId", "workspaceId", "key", "sessionId"],
    "new-workspace": ["cwd", "name", "sessionId", "promptFile"],
    "read-screen": ["surfaceId", "workspaceId", "sessionId", "lines"],
    "send-text": ["surfaceId", "workspaceId", "sessionId", "text", "enterBy"],
  }[op.op];
  for (const k of Object.keys(op)) if (!["op", "id", "expiresAt", ...known].includes(k)) return { error: `bad-field:${k.slice(0, 32)}` };
  if (op.op === "surface.focus" || op.op === "send-key" || op.op === "read-screen" || op.op === "send-text") {
    if (!UUID_RE.test(op.surfaceId || "")) return { error: "bad-surface" };
    if (!UUID_RE.test(op.workspaceId || "")) return { error: "bad-workspace" };
    if (op.sessionId !== undefined && (typeof op.sessionId !== "string" || !SESSION_ID_RE.test(op.sessionId.toLowerCase()))) return { error: "bad-session" };
    // visible screen only: no --scrollback and no --lines (--lines includes history)
    const read = ["read-screen", "--workspace", op.workspaceId, "--surface", op.surfaceId];
    if (op.op === "read-screen") {
      if (op.lines !== undefined && (!Number.isInteger(op.lines) || op.lines < 1 || op.lines > SCREEN_LINES_MAX)) return { error: "bad-lines" };
      return { argvs: [read] };
    }
    if (op.op === "send-text") {
      if (typeof op.text !== "string" || !SEND_TEXT_RE.test(op.text)) return { error: "bad-text" };
      if (op.enterBy !== undefined && !Number.isFinite(op.enterBy)) return { error: "bad-deadline" };
      return {
        read,
        send: ["send", "--workspace", op.workspaceId, "--surface", op.surfaceId, "--", op.text],
        enter: ["send-key", "--workspace", op.workspaceId, "--surface", op.surfaceId, "enter"],
      };
    }
    if (op.op === "surface.focus") {
      return {
        argvs: [
          ["select-workspace", "--workspace", op.workspaceId],
          ["focus-panel", "--panel", op.surfaceId, "--workspace", op.workspaceId],
        ],
      };
    }
    if (op.key !== "escape") return { error: "bad-key" };
    return { argvs: [["send-key", "--workspace", op.workspaceId, "--surface", op.surfaceId, "escape"]] };
  }
  // new-workspace
  if (typeof op.cwd !== "string" || !isAbsolute(op.cwd) || /[\0\n\r]/.test(op.cwd) || op.cwd.length > 1024 || !isDir(op.cwd)) return { error: "bad-cwd" };
  if (typeof op.name !== "string" || !SESSION_NAME_RE.test(op.name)) return { error: "bad-name" };
  if (typeof op.sessionId !== "string" || !SESSION_ID_RE.test(op.sessionId)) return { error: "bad-session" };
  if (!launchDir || op.promptFile !== join(launchDir, `${op.sessionId}.prompt`)) return { error: "bad-prompt-file" };
  let st;
  try {
    st = lstatSync(op.promptFile);
  } catch {
    return { error: "no-prompt-file" };
  }
  if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) return { error: "bad-prompt-file" };
  const command = [launchSh, op.sessionId, op.name, op.promptFile].map(shQuote).join(" ");
  return { argvs: [["new-workspace", "--name", op.name, "--cwd", op.cwd, "--command", command]] };
}

// Environment for cmux: like the bridge's (access to the cmux socket), but without NODE_OPTIONS and without "its own" tab —
// so that a missing flag doesn't land in the bridge's tab.
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of ["NODE_OPTIONS", "CMUX_SURFACE_ID", "CMUX_PANEL_ID", "CMUX_TAB_ID"]) delete out[k];
  return out;
}

function execCmux(cmux, argv) {
  return new Promise((res) => {
    execFile(cmux, argv, { timeout: CMUX_TIMEOUT_MS, env: childEnv(), maxBuffer: 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      res({ code, stdout: String(stdout ?? ""), timedOut: Boolean(err?.killed) });
    });
  });
}

// ---------- Claude Code input field on screen ----------
// The input field is a line starting with ">" or "❯" (with a frame "│ > …") right under a horizontal line (─), plus continuation
// lines up to the next such line. A turn is running — "esc to interrupt" is on screen outside the field. The empty field placeholder
// (pale "Try "…"") can't be told apart from typed text on a text screen — then the field counts as non-empty: refuse, don't type.
const RULE_RE = /^\s*[╭╰┌└]?[─━]{8,}[╮╯┐┘]?\s*$/;
const PROMPT_RE = /^\s*[│┃]?\s*[>❯›](?:[ \u00a0]|$)/;
const BUSY_RE = /\besc to interrupt\b/i;
const squash = (s) => String(s).replace(/[\s\u00a0]+/g, "");

// text — read-screen output. → {promptFound, promptEmpty, busy, promptText}. promptText is only for checking the typed line
// inside the bridge: it doesn't go to the daemon (the screen may show conversation text).
export function analyzeScreen(text, maxLines = SCREEN_LINES_DEFAULT) {
  const all = String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""));
  while (all.length && !all[all.length - 1].trim()) all.pop();
  const lines = all.slice(-Math.min(Math.max(1, maxLines | 0), SCREEN_LINES_MAX));
  for (let i = lines.length - 1; i > 0; i--) {
    if (!PROMPT_RE.test(lines[i]) || !RULE_RE.test(lines[i - 1])) continue;
    let end = i + 1;
    while (end < lines.length && !RULE_RE.test(lines[end])) end++;
    if (end >= lines.length) continue; // no bottom line — not an input field
    const body = lines
      .slice(i, end)
      .map((l, k) => {
        let x = l.replace(/^\s*[│┃]/, "").replace(/[│┃]\s*$/, "");
        if (k === 0) x = x.replace(/^\s*[>❯›]/, "");
        return x;
      })
      .join(" ")
      .replace(/[\s\u00a0]+/g, " ")
      .trim();
    const busy = lines.some((l, k) => (k < i || k >= end) && BUSY_RE.test(l));
    return { promptFound: true, promptEmpty: body === "", busy, promptText: body };
  }
  return { promptFound: false, promptEmpty: null, busy: lines.some((l) => BUSY_RE.test(l)), promptText: null };
}

const flags = (a) => ({ promptFound: a.promptFound, promptEmpty: a.promptEmpty, busy: a.busy });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Execute an operation. → {ok, code, error?, workspaceId?, promptFound?, promptEmpty?, busy?}
export async function runOp(op, { cmux, launchDir, exec = execCmux, now = Date.now(), clock = Date.now, settleMs = SETTLE_MS, sleep = pause } = {}) {
  if (typeof op?.expiresAt === "number" && now > op.expiresAt) return { ok: false, code: null, error: "expired" };
  const b = buildArgv(op, { launchDir });
  if (b.error) return { ok: false, code: null, error: b.error };
  const fail = (r) => ({ ok: false, code: r.code, error: r.timedOut ? "cmux-timeout" : "cmux-failed" });
  if (op.op === "read-screen") {
    const r = await exec(cmux, b.argvs[0]);
    if (r.code !== 0) return fail(r);
    return { ok: true, code: 0, ...flags(analyzeScreen(r.stdout, op.lines ?? SCREEN_LINES_DEFAULT)) };
  }
  if (op.op === "send-text") {
    // 1) the input field is found, empty, no turn running — otherwise the line would be appended to the human's draft
    let r = await exec(cmux, b.read);
    if (r.code !== 0) return fail(r);
    let a = analyzeScreen(r.stdout);
    if (!a.promptFound) return { ok: false, code: null, error: "prompt-not-found", ...flags(a) };
    if (a.busy) return { ok: false, code: null, error: "session-busy", ...flags(a) };
    if (!a.promptEmpty) return { ok: false, code: null, error: "prompt-not-empty", ...flags(a) };
    // 2) type the line (without Enter)
    r = await exec(cmux, b.send);
    if (r.code !== 0) return fail(r);
    // 3) the field holds exactly this line (nobody typed at the same time) — only then Enter
    if (settleMs > 0) await sleep(settleMs);
    r = await exec(cmux, b.read);
    if (r.code !== 0) return fail(r);
    a = analyzeScreen(r.stdout);
    if (!a.promptFound || squash(a.promptText) !== squash(op.text)) return { ok: false, code: null, error: "prompt-mismatch" };
    // the daemon waits for a reply until the deadline: after enterBy we don't press Enter — the line stays in the field, and the daemon already said "not sent"
    if (typeof op.enterBy === "number" && clock() > op.enterBy) return { ok: false, code: null, error: "deadline" };
    r = await exec(cmux, b.enter);
    if (r.code !== 0) return fail(r);
    return { ok: true, code: 0 };
  }
  let last = { code: 0, stdout: "" };
  for (const argv of b.argvs) {
    last = await exec(cmux, argv);
    if (last.code !== 0) return { ok: false, code: last.code, error: last.timedOut ? "cmux-timeout" : "cmux-failed" };
  }
  const out = { ok: true, code: 0 };
  if (op.op === "new-workspace") {
    const m = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/.exec(last.stdout) || /workspace:\d{1,6}/.exec(last.stdout);
    if (m) out.workspaceId = m[0];
  }
  return out;
}

// ---------- HTTP over a Unix socket ----------
function call(sock, method, path, body, timeoutMs = 35_000) {
  return new Promise((res, rej) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = request(
      { socketPath: sock, agent: false, method, path, timeout: timeoutMs, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (resp) => {
        let s = "";
        resp.setEncoding("utf8");
        resp.on("data", (c) => (s += c));
        resp.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(s);
          } catch {}
          res({ status: resp.statusCode, body: json });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", rej);
    if (data) r.write(data);
    r.end();
  });
}

function log(msg) {
  process.stderr.write(`[agenthub-bridge ${new Date().toISOString()}] ${msg}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main({ env = process.env } = {}) {
  const home = hubHome(env);
  const sock = join(home, "hub.sock");
  const launchDir = join(home, "launch");
  const cmux = env.AGENTHUB_CMUX || DEFAULT_CMUX;
  if (!isAbsolute(cmux)) {
    log("AGENTHUB_CMUX must be an absolute path");
    process.exit(2);
  }
  try {
    accessSync(cmux, constants.X_OK);
  } catch {
    log(`no executable cmux CLI: ${cmux}`);
    process.exit(2);
  }
  if (!("CMUX_SOCKET_PATH" in env)) log("WARNING: the bridge is not running in a cmux tab — cmux commands may fail");

  let stopping = false;
  let registered = false;
  const bye = async () => {
    if (stopping) return;
    stopping = true;
    if (registered) await call(sock, "POST", "/bridge/bye", {}, 2000).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);

  let backoff = 1000;
  for (;;) {
    if (stopping) return;
    try {
      if (!registered) {
        const h = await call(sock, "POST", "/bridge/hello", { version: VERSION });
        if (h.status === 409) {
          log("another bridge is already connected — waiting");
          await sleep(10_000);
          continue;
        }
        if (h.status !== 200) {
          log(`hello: ${h.status} ${h.body?.error || ""}`);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30_000);
          continue;
        }
        registered = true;
        backoff = 1000;
        log(`connected to ${sock}`);
      }
      const n = await call(sock, "GET", "/bridge/next?wait=20000");
      if (n.status === 204) continue;
      if (n.status === 409) {
        registered = false;
        continue;
      }
      if (n.status !== 200 || !n.body?.op) {
        log(`next: ${n.status} ${n.body?.error || ""}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      const op = n.body.op;
      const t0 = Date.now();
      const r = await runOp(op, { cmux, launchDir });
      log(`op=${op.op} ok=${r.ok} code=${r.code ?? "-"}${r.error ? ` error=${r.error}` : ""} ms=${Date.now() - t0}`);
      await call(sock, "POST", `/bridge/result/${encodeURIComponent(String(op.id))}`, r).catch(() => {});
    } catch (e) {
      if (registered) log(`daemon connection: ${e.code || e.message}`);
      registered = false;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
