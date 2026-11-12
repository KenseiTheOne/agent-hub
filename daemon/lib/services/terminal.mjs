// terminal service (contract 3): "read a tab's screen" and "type a line into a tab" of a Claude Code session for
// trusted plugins. Routes are in lib/routes/terminal.mjs (POST /terminal/read-screen, POST /terminal/send-text), the terminal
// layer is lib/terminals/: one adapter per terminal (cmux runs operations through the bridge — the daemon and plugins have no
// access to the cmux socket; tmux through its CLI). An adapter that does not declare the operation (iTerm2, Terminal.app) —
// 409 terminal:unsupported {terminal, capability}. The service knows nothing about specific plugins: the plugin declares the permission itself (<agenthub.terminal>), and a human sees it in
// the consent sheet.
//
// Checks (in order, all before the bridge):
//   1. the peer is a plugin process: an ongoing run, streamable or an ongoing action (pluginByPid fact: pid from the core, not
//      from the request), trusted (builtin, official, own) and has declared the operation: read-screen, or send — a slash command from
//      its own list with arguments matching TERMINAL_ARG_RE (at most 3), or any line via "*", except "!", "#", "&" at the start;
//   2. the plugin's overall request rate (requestsPerMin); the hub isn't paused (423 estop);
//   3. the line (send-text): printable ASCII without "\", no leading or trailing space, 1…200 chars (cmux send treats
//      \n, \r, \t as Enter and Tab — so no backslash at all; the bridge presses Enter itself, as a single key);
//   4. the session is in the core registry, the Claude Code signature was verified just now and the process start time is the same (pid not reused
//      by another); the terminal knows the tab, under the same pid and start time; the terminal supports the operation;
//   5. send-text: the Claude Code process isn't stopped (Ctrl+Z) and is in its terminal's foreground group (otherwise the line
//      would go to the shell); the session is free — per the registry (Claude Code's own status: idle; no status — per the terminal),
//      whether a turn is running or not, the bridge looks at the screen once more; send rate — per plugin (sendPerMin) and per tab
//      (sendPerTabPerMin);
//   6. before typing, the bridge looks at the screen once more: the input field is found, empty, no turn running; before Enter the field holds exactly
//      this line (otherwise it doesn't press Enter: prompt-mismatch).
// Journal: every send is terminal-send {plugin, sessionId, surfaceId, workspaceId, terminal, tab, len, sha, head, ok,
// error} (surfaceId and workspaceId — cmux only, tab — the adapter's tab key): head is the declared slash command at the start of the line (shown in the consent sheet), sha is the first 12 chars of the line's sha256,
// only together with head (a line sent under "*" isn't hashed: a short one could be brute-forced), otherwise both null. The line
// itself never reaches the journal, the bus or responses. terminal-send is duplicated to the audit journal (AUDIT_TYPES): the bridge-op stream
// from read-screen won't push it out. Denials are terminal-denied {plugin, op, sessionId, error}; screen reads are bridge-op.
//
// Settings (config.json → services.terminal): requestsPerMin (60), sendPerMin (12), sendPerTabPerMin (4).

import { createHash } from "node:crypto";
import { terminalGrants, terminalTextAllowed } from "../registry/perms.mjs";
import { locate, supports } from "../terminals/index.mjs";

export const name = "terminal";

export const TEXT_MAX = 200;
// Printable ASCII without "\"; no spaces at the edges (like the bridge's SEND_TEXT_RE).
export const TEXT_RE = /^[\x21-\x5B\x5D-\x7E](?:[\x20-\x5B\x5D-\x7E]{0,198}[\x21-\x5B\x5D-\x7E])?$/;
const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
// The id grammar of non-Claude agent sessions (G13, lib/core.mjs EXTERNAL_SESSION_ID_RE).
const EXTERNAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULTS = Object.freeze({ requestsPerMin: 60, sendPerMin: 12, sendPerTabPerMin: 4 });
const MINUTE = 60_000;

// Adapter error → HTTP. A denial due to the tab state — 409, an older bridge — 501, a bridge or cmux failure — 502/504.
const ADAPTER_STATUS = {
  "bridge-offline": 409,
  "prompt-not-found": 409,
  "prompt-not-empty": 409,
  "prompt-mismatch": 409,
  "session-busy": 409,
  deadline: 504,
  estop: 423,
  "bridge-outdated": 501,
  "bridge-timeout": 504,
  "bridge-pickup-timeout": 504,
  "cmux-timeout": 504,
  "tmux-timeout": 504,
  "no-tab": 409,
  "terminal-test-mode": 409,
};

const running = new Map(); // ctx → TerminalService

// Rate window: at most limit events per minute per key. → 0 (allowed) or ms until the next allowed one.
class Window {
  constructor() {
    this.map = new Map();
  }
  wait(key, limit, now = Date.now()) {
    const list = (this.map.get(key) || []).filter((t) => now - t < MINUTE);
    this.map.set(key, list);
    return list.length < limit ? 0 : MINUTE - (now - list[0]);
  }
  hit(key, now = Date.now()) {
    const list = this.map.get(key) || [];
    list.push(now);
    this.map.set(key, list);
  }
}

const shortSha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 12);
const ok = (body) => ({ status: 200, body: { ok: true, ...body } });
const err = (status, code, extra = {}) => ({ status, body: { error: code, ...extra } });

export class TerminalService {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    const cfg = { ...DEFAULTS, ...(ctx.config.services?.terminal || {}), ...opts };
    const lim = (v, d, max) => (Number.isInteger(v) && v >= 1 ? Math.min(v, max) : d);
    this.requestsPerMin = lim(cfg.requestsPerMin, DEFAULTS.requestsPerMin, 600);
    this.sendPerMin = lim(cfg.sendPerMin, DEFAULTS.sendPerMin, 120);
    this.sendPerTabPerMin = lim(cfg.sendPerTabPerMin, DEFAULTS.sendPerTabPerMin, 60);
    this.adapters = opts.adapters; // tests: their own set of adapters
    this.requests = new Window();
    this.sends = new Window();
    this.deniedNoted = new Map(); // plugin → ts: a request-rate denial is logged at most once a minute
  }

  deny(pl, op, sessionId, status, code, extra = {}) {
    if (code === "terminal:rate-limited" && extra.scope === "requests") {
      const at = this.deniedNoted.get(pl?.id) || 0;
      if (Date.now() - at < MINUTE) return err(status, code, extra);
      this.deniedNoted.set(pl?.id, Date.now());
    }
    this.ctx.journal.write({ type: "terminal-denied", plugin: pl?.id || null, op, sessionId: sessionId || null, error: code });
    return err(status, code, extra);
  }

  // Steps 1–2 and 4: peer, permission, rate, pause, session, tab. → { pl, grants, s, adapter, target } | { res }
  async prepare(peer, body, op) {
    // an ongoing run, a streamable process or an ongoing plugin action (a human started it)
    const pl = this.ctx.facts.pluginByPid?.(peer?.pid, { actions: true }) ?? null;
    const sid = typeof body?.sessionId === "string" ? body.sessionId : null;
    if (!pl) return { res: this.deny(null, op, sid, 403, "terminal:not-a-plugin") };
    if (!pl.trusted) return { res: this.deny(pl, op, sid, 403, "terminal:untrusted") };
    const grants = terminalGrants(pl.terminal);
    if (op === "read-screen" ? !grants.read : !grants.send) return { res: this.deny(pl, op, sid, 403, "terminal:not-declared") };
    const wait = this.requests.wait(pl.id, this.requestsPerMin);
    if (wait) return { res: this.deny(pl, op, sid, 429, "terminal:rate-limited", { scope: "requests", retryAfterMs: wait }) };
    this.requests.hit(pl.id);
    if (this.ctx.estop()) return { res: this.deny(pl, op, sid, 423, "estop") };
    if (!body || typeof body !== "object" || Array.isArray(body)) return { res: err(400, "body") };
    if (!sid) return { res: err(400, "args:sessionId:required") };
    // a UUID or an external agent session id (G13): the latter is refused with terminal:external-session (session(), B8)
    if (!UUID_RE.test(sid) && !EXTERNAL_ID_RE.test(sid)) return { res: err(400, "args:sessionId:pattern") };
    const allowedKeys = op === "read-screen" ? ["sessionId", "lines"] : ["sessionId", "text"];
    for (const k of Object.keys(body)) if (!allowedKeys.includes(k)) return { res: err(400, `args:${k.slice(0, 32)}:unknown`) };
    return { pl, grants, sid };
  }

  async session(pl, op, sid, cap) {
    const s = this.ctx.sessions.get(sid) || this.ctx.sessions.list().find((x) => typeof x.sessionId === "string" && x.sessionId.toLowerCase() === sid.toLowerCase()) || null;
    // a non-Claude agent session (G13, kind "external"): only session.focus works for it — no reading, no typing
    if (!s && this.ctx.sessions.external?.(sid)) return { res: this.deny(pl, op, sid, 409, "terminal:external-session") };
    if (!s || !Number.isInteger(s.pid)) return { res: this.deny(pl, op, sid, 409, "terminal:unknown-session") };
    let v = null;
    try {
      v = await this.ctx.peer.verifySigned(s.pid, "claudeCode");
    } catch {}
    const same = v?.ok && (s.startSec == null || v.startSec == null || v.startSec === s.startSec);
    if (!same) return { res: this.deny(pl, op, sid, 409, "terminal:unverified") };
    // start time — from the registry or just verified: the adapter will match it against the terminal's record
    const loc = locate({ ...s, startSec: s.startSec ?? v.startSec ?? null }, this.ctx.facts, this.adapters);
    if (loc.error) return { res: this.deny(pl, op, sid, 409, `terminal:${loc.error}`) };
    if (cap && !supports(loc.adapter, cap)) return { res: this.deny(pl, op, sid, 409, "terminal:unsupported", { terminal: loc.adapter.id, capability: cap }) };
    return { s, adapter: loc.adapter, target: loc.target };
  }

  // Whether the session is free. The registry status is Claude Code's own status (claude agents, ~/.claude/sessions): idle — free,
  // busy/waiting — not. No status — per the terminal (cmux: agentLifecycle idle; tmux knows nothing — not free). The terminal doesn't override the registry status:
  // after an Esc mid-turn the Stop hook doesn't fire and cmux stays "running", even though the session is free. Whether a turn is actually
  // running, the bridge checks on screen before typing and before Enter ("esc to interrupt").
  idle(q) {
    if (q.s.status === "idle") return true;
    if (q.s.status === "busy" || q.s.status === "waiting") return false;
    return q.adapter.idle(q.target);
  }

  // The session process isn't stopped and is in its terminal's foreground group. → true | false | null (can't tell).
  foreground(pid) {
    let st = null;
    try {
      st = this.ctx.peer?.procState?.(pid) ?? null;
    } catch {}
    if (!st) return null;
    return !st.stopped && st.foreground === true;
  }

  // POST /terminal/read-screen { sessionId, lines? } → { ok, sessionId, terminal, idle, foreground, promptFound, promptEmpty,
  // busy, ready }
  async readScreen(peer, body) {
    const p = await this.prepare(peer, body, "read-screen");
    if (p.res) return p.res;
    if (body.lines !== undefined && (!Number.isInteger(body.lines) || body.lines < 1 || body.lines > 30)) return err(400, "args:lines:range");
    const q = await this.session(p.pl, "read-screen", p.sid, "read-screen");
    if (q.res) return q.res;
    const r = await q.adapter.readScreen(q.target, this.ctx.facts, { sessionId: q.s.sessionId, lines: body.lines });
    if (!r.ok) return this.deny(p.pl, "read-screen", p.sid, ADAPTER_STATUS[r.error] || 502, `terminal:${r.error}`);
    const idle = this.idle(q);
    const foreground = this.foreground(q.s.pid) === true;
    return ok({
      sessionId: q.s.sessionId,
      terminal: q.target.terminal,
      idle,
      foreground,
      promptFound: r.promptFound,
      promptEmpty: r.promptEmpty,
      busy: r.busy,
      // can type right now (send-text will check again anyway)
      ready: idle && foreground && r.promptFound && r.promptEmpty === true && !r.busy,
    });
  }

  // POST /terminal/send-text { sessionId, text } → { ok, sessionId, terminal }
  async sendText(peer, body) {
    const p = await this.prepare(peer, body, "send-text");
    if (p.res) return p.res;
    const text = body.text;
    if (typeof text !== "string" || !text) return err(400, "args:text:required");
    if (text.length > TEXT_MAX) return err(400, "args:text:too-long");
    if (!TEXT_RE.test(text)) return this.deny(p.pl, "send-text", p.sid, 400, "terminal:bad-text");
    const head = terminalTextAllowed(p.grants, text);
    if (!head) return this.deny(p.pl, "send-text", p.sid, 403, "terminal:text-not-declared");
    const q = await this.session(p.pl, "send-text", p.sid, "send-text");
    if (q.res) return q.res;
    if (!this.idle(q)) return this.deny(p.pl, "send-text", p.sid, 409, "terminal:session-busy");
    // a stopped (Ctrl+Z) or background process: the screen shows an old input field, and the line would go to the shell
    const fg = this.foreground(q.s.pid);
    if (fg !== true) return this.deny(p.pl, "send-text", p.sid, 409, fg === false ? "terminal:not-foreground" : "terminal:process-unknown");
    const tab = `${q.target.terminal}:${q.target.tab ?? q.target.surfaceId}`;
    const wPl = this.sends.wait(p.pl.id, this.sendPerMin);
    const wTab = this.sends.wait(tab, this.sendPerTabPerMin);
    if (wPl || wTab) return this.deny(p.pl, "send-text", p.sid, 429, "terminal:rate-limited", { scope: wPl ? "plugin" : "tab", retryAfterMs: Math.max(wPl, wTab) });
    // every attempt that reached the terminal counts (a failed one too: the bridge looked at the screen)
    this.sends.hit(p.pl.id);
    this.sends.hit(tab);
    const r = await q.adapter.sendText(q.target, text, this.ctx.facts, { sessionId: q.s.sessionId });
    this.ctx.journal.write({
      type: "terminal-send",
      plugin: p.pl.id,
      sessionId: q.s.sessionId,
      surfaceId: q.target.surfaceId ?? null,
      workspaceId: q.target.workspaceId ?? null,
      terminal: q.target.terminal,
      tab: q.target.tab ?? null,
      len: text.length,
      sha: head === "*" ? null : shortSha(text),
      head: head === "*" ? null : head,
      ok: Boolean(r.ok),
      error: r.ok ? null : r.error,
    });
    this.ctx.emit({ type: "terminal.send", plugin: p.pl.id, sessionId: q.s.sessionId, ok: Boolean(r.ok), error: r.ok ? null : r.error });
    if (!r.ok) return err(ADAPTER_STATUS[r.error] || 502, `terminal:${r.error}`);
    return ok({ sessionId: q.s.sessionId, terminal: q.target.terminal });
  }
}

export async function start(ctx, opts = {}) {
  const svc = new TerminalService(ctx, opts);
  running.set(ctx, svc);
  ctx.facts.provide("terminal.api", () => svc);
}

export async function stop(ctx) {
  for (const [c] of [...running]) {
    if (ctx && c !== ctx) continue;
    running.delete(c);
  }
}
