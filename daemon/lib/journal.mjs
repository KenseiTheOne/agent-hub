// The journal.jsonl journal: metadata only.
//
// Entries are sanitized: values are only scalars (string ≤ 200 characters, number, bool, null) and arrays
// of scalars (≤ 20); nested objects are dropped; keys that look like content (tool_input, prompt,
// text, body, content, token, secret, password, transcript, stdout, stderr, env, message, input),
// are replaced with "[hidden]" ("[скрыто]" — in the hub language at write time). This keeps conversation text, tool_input and secrets out of the journal
// even if an extension passes them by mistake.

import { appendFileSync, closeSync, existsSync, openSync, readSync, renameSync, statSync, chmodSync } from "node:fs";
import { msg } from "./i18n.mjs";

const DENY = /^(tool_input|tool_response|prompt|text|body|content|token|secret|secrets|password|transcript|stdout|stderr|env|message|input|output|answer|updatedinput|cookie|authorization)$/i;
const MAX_STR = 200;
const MAX_ARR = 20;
const MAX_KEYS = 40;

function cleanScalar(v) {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.length > MAX_STR ? v.slice(0, MAX_STR) + "…" : v;
  return undefined;
}

export function sanitize(entry) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(entry || {})) {
    if (n++ >= MAX_KEYS) break;
    if (!/^[\w.-]{1,64}$/.test(k)) continue;
    if (DENY.test(k)) {
      out[k] = msg("journal.hidden");
      continue;
    }
    if (Array.isArray(v)) {
      const arr = v.slice(0, MAX_ARR).map(cleanScalar).filter((x) => x !== undefined);
      out[k] = arr;
      continue;
    }
    const s = cleanScalar(v);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

// Entries that a flood of others must not push out (hub pause, build pin change): they are duplicated to
// <journal>-audit.jsonl (journal-audit.jsonl next to the journal; its own rotation, 1 MB). A flood of plugin warnings
// can push anything out of journal.jsonl and .1, but only these types are written here.
// terminal-send and bridge-op-late (contract 3): every line sent to a tab, and every bridge reply that arrived after
// the daemon stopped waiting; typing is rate-limited (sendPerMin), so a flood of screen reads cannot push them out.
export const AUDIT_TYPES = new Set(["estop", "estop-set", "app-requirement-changed", "app-pin-path-changed", "shutdown-requested", "app-restart-stopped", "hub-update-cli", "hub-update-tag-moved", "terminal-send", "bridge-op-late"]);

function appendRotating(path, line, maxBytes) {
  if (existsSync(path) && statSync(path).size + line.length > maxBytes) renameSync(path, path + ".1");
  const fresh = !existsSync(path);
  appendFileSync(path, line, { mode: 0o600 });
  if (fresh) chmodSync(path, 0o600);
}

// The last n entries of the file (reads the tail).
function tailFile(path, n) {
  if (n <= 0 || !existsSync(path)) return [];
  const size = statSync(path).size;
  const want = Math.min(size, Math.max(64 * 1024, n * 400));
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    if (want < size) lines.shift(); // the first line may have been cut off
    const out = [];
    for (const l of lines.slice(-n)) {
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    return out;
  } finally {
    closeSync(fd);
  }
}

export class Journal {
  constructor(path, { maxBytes = 8 * 1024 * 1024, onWrite = null, auditPath, auditMaxBytes = 1024 * 1024 } = {}) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.onWrite = onWrite;
    this.auditPath = auditPath !== undefined ? auditPath : path ? path.replace(/(\.jsonl)?$/, "-audit.jsonl") : null;
    this.auditMaxBytes = auditMaxBytes;
  }
  write(entry) {
    const clean = { ts: new Date().toISOString(), ...sanitize(entry) };
    const line = JSON.stringify(clean) + "\n";
    try {
      appendRotating(this.path, line, this.maxBytes);
    } catch {
      // the journal must not crash the daemon
    }
    if (this.auditPath && AUDIT_TYPES.has(clean.type)) {
      try {
        appendRotating(this.auditPath, line, this.auditMaxBytes);
      } catch {}
    }
    this.onWrite?.(clean);
    return clean;
  }
  // The last n entries: the tail of journal.jsonl, and if it has fewer than n (just rotated), the tail of
  // journal.jsonl.1.
  tail(n = 100) {
    const cur = tailFile(this.path, n);
    if (cur.length >= n) return cur;
    return [...tailFile(this.path + ".1", n - cur.length), ...cur];
  }
  // The last n entries of the audit journal (AUDIT_TYPES).
  auditTail(n = 100) {
    if (!this.auditPath) return [];
    const cur = tailFile(this.auditPath, n);
    if (cur.length >= n) return cur;
    return [...tailFile(this.auditPath + ".1", n - cur.length), ...cur];
  }
}
