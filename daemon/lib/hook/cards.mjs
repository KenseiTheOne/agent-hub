// Stage 6: session replies. Shared state for the services/hook.mjs service, the routes/hook.mjs routes
// and the primitives/session.respond.mjs primitive.
//
// What lives here:
//   - the registry of interactive sessions: SessionStart from the hook (a peer of class hook, session_id matched
//     ~/.claude/sessions/<Claude pid>.json) + a live pid with a Claude Code signature + properties of the process itself
//     that an agent inside the session can't fake: a controlling terminal and argv without -p/--print/--output-format
//     (peer.interactiveProcess). kind/entrypoint from the file are only an extra hint: the file is writable
//     by any process of the same UID. Only such sessions get a card; for the rest the hook answers {}
//     right away;
//   - a session_id already bound to another live signed pid isn't moved to a new pid; a session_id change
//     for the same pid — only with source ∈ {clear, resume, compact};
//   - after a daemon restart the registry is empty: the first PermissionRequest from a verified hook registers the session
//     lazily with the same checks as SessionStart (source=lazy);
//   - cards of pending PermissionRequest requests: they wait for a decision from the app no longer than waitMs;
//   - a narrow reply: "once" (allow), "deny" (deny), choosing an option (allow + updatedInput with answers
//     for AskUserQuestion). No updatedPermissions, "always", bypass, setMode, interrupt;
//   - removing a card: a repeated identical request (dedup), Stop, SessionEnd, process death, session status
//     "waiting" → "not waiting" (answered in the terminal or in Remote Control), the hook connection dropped
//     (if the core passes a signal), ESTOP, a rate-limit pause, timeout;
//   - approval rate limit: more than N per minute → pause + hook.paused event (for push).
//
// tool_input is kept only in card memory (needed for updatedInput) and is never written to the log
// or to bus events. Events carry only requestId, sessionId, kind, tool; the server sends hook.* events
// over SSE only to the app. requestId is the reply key, so nobody but app sees it:
// the log (GET /journal is open to cli too) has only its hash (request), /hook/status for cli has only counters.
//
// State is bound to the core via ctx.facts (one object per core instance): this way the primitive,
// route and service of one daemon see the same thing, and several daemons in tests don't interfere.

import { t as tr } from "../i18n.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOOK_DEFAULTS = Object.freeze({
  // How long a card waits for a decision. Less than the agenthub-hook timeout (118 s) and the hook in hooks.json (125 s).
  waitMs: 110_000,
  // Approval limit (once/answer) across all sessions in a sliding minute; exceeding it → pause.
  maxApprovalsPerMinute: 10,
  pauseMs: 10 * 60_000,
  // Request limit from one session per minute and the cap on concurrently waiting cards.
  maxRequestsPerMinute: 30,
  maxPending: 32,
  // Which sessions count as interactive (kind/entrypoint fields of ~/.claude/sessions/<pid>.json).
  interactiveKinds: ["interactive"],
  interactiveEntrypoints: ["cli"],
  // Tools for which a card is never created (reply only in the terminal).
  // ExitPlanMode changes the session's permission mode — that's closer to setMode, the hub doesn't interfere.
  skipTools: ["ExitPlanMode"],
  // How often to check whether interactive sessions are alive.
  sweepMs: 30_000,
});

export const DECISIONS = ["once", "deny", "answer"];
// SessionStart sources with which the same Claude process legitimately changes session_id.
export const REBIND_SOURCES = ["clear", "resume", "compact"];
export const denyMessage = (lang) => tr(lang, "hook.deny");
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

const states = new WeakMap();

// State for the core that owns facts (or undefined if the hook service isn't running).
export function hookStateFor(facts) {
  return facts ? states.get(facts) : undefined;
}

export function isRequestId(s) {
  return typeof s === "string" && REQUEST_ID_RE.test(s);
}

// JSON with sorted keys — for the dedup key (identical request → identical string).
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

// requestId goes to the log only as a hash: cli reads the log too, and requestId is the card reply key.
export function requestRef(requestId) {
  return sha(`agenthub-request|${requestId}`).slice(0, 16);
}

function str(v, max) {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function tildify(p) {
  const h = homedir();
  return p === h || p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

// A safe request summary: command name or path, without the body. Sent only to the app (GET /hook/cards).
export function safeSummary(tool, input, lang = "ru") {
  const t = String(tool || "?").slice(0, 128);
  const inp = input && typeof input === "object" ? input : {};
  if (t === "Bash" || t === "PowerShell") {
    const cmd = typeof inp.command === "string" ? inp.command : "";
    const words = cmd.trim().split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) i++; // VAR=value in front
    const prog = (words[i] || "").split("/").pop();
    const name = /^[\w.+-]{1,40}$/.test(prog) ? prog : tr(lang, "hook.command");
    return `${t}: ${name}`;
  }
  const path = inp.file_path ?? inp.notebook_path ?? null;
  if (typeof path === "string" && path && ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(t)) {
    const p = tildify(path);
    return `${t}: ${p.length > 200 ? "…" + p.slice(-199) : p}`;
  }
  if (t === "WebFetch" && typeof inp.url === "string") {
    try {
      return `WebFetch: ${new URL(inp.url).host}`;
    } catch {
      return "WebFetch";
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
  if (mcp) return `MCP ${mcp[1]}: ${mcp[2]}`.slice(0, 160);
  return t;
}

// AskUserQuestion questions → card view. Unknown shape → null (no card is created, the hook → {}).
export function sanitizeQuestions(questions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 8) return null;
  const out = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") return null;
    if (typeof q.question !== "string" || !q.question.trim() || q.question.length > 4000) return null;
    if (!Array.isArray(q.options) || q.options.length < 1 || q.options.length > 16) return null;
    const options = [];
    for (const o of q.options) {
      if (!o || typeof o !== "object" || typeof o.label !== "string" || !o.label.trim() || o.label.length > 1000) return null;
      options.push({ label: o.label.slice(0, 500), description: str(o.description, 1000) });
    }
    out.push({ question: q.question.slice(0, 1000), header: str(q.header, 100), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

// answers from the app (JSON string) → { answers: {<question text>: <answer>} } | { error }.
// Format: an array per question; an element is an array of option indexes (multiSelect — one or more,
// otherwise exactly one) or an "Other" string (1–2000 characters).
export function buildAnswers(rawQuestions, answersJson) {
  if (typeof answersJson !== "string") return { error: "answers" };
  let arr;
  try {
    arr = JSON.parse(answersJson);
  } catch {
    return { error: "answers" };
  }
  if (!Array.isArray(arr) || arr.length !== rawQuestions.length) return { error: "answers" };
  const answers = {};
  for (let i = 0; i < arr.length; i++) {
    const q = rawQuestions[i];
    const a = arr[i];
    if (typeof a === "string") {
      if (!a.trim() || a.length > 2000) return { error: "answers" };
      answers[q.question] = a;
      continue;
    }
    if (!Array.isArray(a) || !a.length) return { error: "answers" };
    if (q.multiSelect !== true && a.length !== 1) return { error: "answers" };
    const seen = new Set();
    for (const n of a) {
      if (!Number.isInteger(n) || n < 0 || n >= q.options.length || seen.has(n)) return { error: "answers" };
      seen.add(n);
    }
    answers[q.question] = a.map((n) => q.options[n].label).join(", ");
  }
  return { answers };
}

function allowOutput(updatedInput) {
  const decision = { behavior: "allow" };
  if (updatedInput) decision.updatedInput = updatedInput;
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision } };
}
function denyOutput(lang = "ru") {
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: denyMessage(lang) } } };
}

export class HookState {
  lang() {
    try {
      return this.ctx?.lang?.() || "ru";
    } catch {
      return "ru";
    }
  }
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.opts = { ...HOOK_DEFAULTS, ...opts };
    this.interactive = new Map(); // sessionId → { pid, startSec, at }
    this.cards = new Map(); // requestId → card
    this.approvals = []; // approval times within the last minute
    this.requests = new Map(); // sessionId → [request times]
    this.pausedUntil = 0;
    this.stopped = false;
    states.set(ctx.facts, this);
  }

  detach() {
    this.stopped = true;
    for (const c of [...this.cards.values()]) this.cancel(c, "service-stop");
    if (states.get(this.ctx.facts) === this) states.delete(this.ctx.facts);
  }

  paused(now = Date.now()) {
    return this.pausedUntil > now;
  }

  log(entry) {
    this.ctx.journal.write(entry);
  }

  // ---------- POST /hook handler ----------
  // → the reply object for the hook; undefined — not our event (the core asks others or answers {}).
  async onHook(body, { peer, signal } = {}) {
    if (this.stopped) return undefined;
    const ev = body?.hook_event_name;
    const sid = typeof body?.session_id === "string" ? body.session_id : null;
    if (!sid || !peer || peer.class !== "hook" || !Number.isInteger(peer.claudePid)) return {};
    // the session_id already belongs to another Claude process: a foreign hook doesn't remove or replace its cards
    const owner = this.interactive.get(sid);
    if (owner && owner.pid !== peer.claudePid && ev !== "SessionStart") {
      this.log({ type: "hook-foreign-session", sessionId: sid, claudePid: peer.claudePid, event: str(ev, 64) });
      return {};
    }
    switch (ev) {
      case "SessionStart":
        await this.sessionStart(sid, peer.claudePid, body);
        return {};
      case "SessionEnd":
        await this.endSession(sid, "session-end");
        return {};
      case "Stop":
        this.cancelSession(sid, "stop");
        return {};
      case "PermissionRequest":
        return this.permission(sid, peer.claudePid, body, signal);
      default:
        return undefined;
    }
  }

  // ---------- interactive session registry ----------
  readSessionFile(pid) {
    try {
      return JSON.parse(readFileSync(join(this.ctx.config.claudeHome, "sessions", `${pid}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  // the session_id already belongs to another live signed Claude process (same start) → true.
  async boundElsewhere(sid, pid) {
    const cands = [];
    const e = this.interactive.get(sid);
    if (e && e.pid !== pid) cands.push(e);
    const reg = this.ctx.sessions.get(sid);
    if (reg && reg.pid !== pid) cands.push(reg);
    for (const c of cands) {
      const v = await this.ctx.peer.verifySigned(c.pid, "claudeCode");
      if (v.ok && (c.startSec == null || v.startSec == null || v.startSec === c.startSec)) return true;
    }
    return false;
  }

  // → true if the session is registered as interactive. lazy — registration by the first PermissionRequest
  // (after a daemon restart SessionStart won't come anymore).
  async sessionStart(sid, pid, body, { lazy = false } = {}) {
    const source = lazy ? "lazy" : str(body?.source, 32);
    const data = this.readSessionFile(pid);
    const kind = str(data?.kind, 32);
    const entrypoint = str(data?.entrypoint, 32);
    let reason = null;
    let keepExisting = false;
    if (!data || data.sessionId !== sid) reason = "no-session-file";
    else if (!this.opts.interactiveKinds.includes(kind)) reason = "kind";
    else if (!this.opts.interactiveEntrypoints.includes(entrypoint)) reason = "entrypoint";
    if (!reason) {
      const proc = this.ctx.peer.interactiveProcess ? this.ctx.peer.interactiveProcess(pid) : { ok: false, reason: "no-check" };
      if (!proc.ok) reason = `proc:${proc.reason}`;
    }
    if (!reason && (await this.boundElsewhere(sid, pid))) {
      reason = "sid-bound";
      keepExisting = true; // the real session on another pid stays as is
    }
    // One Claude process — one current session: /clear, resume and compact change session_id for the same pid.
    const samePid = [...this.interactive].filter(([other, e]) => e.pid === pid && other !== sid).map(([other]) => other);
    if (!reason && samePid.length && !REBIND_SOURCES.includes(source)) {
      reason = "rebind-source";
      keepExisting = true;
    }
    if (reason) {
      if (!keepExisting && this.interactive.get(sid)?.pid === pid) await this.endSession(sid, reason);
      this.log({ type: "hook-session", sessionId: sid, claudePid: pid, interactive: false, reason, kind, entrypoint, source });
      return false;
    }
    for (const other of samePid) await this.endSession(other, "replaced");
    const r = await this.ctx.sessions.register(sid, { pid, source: "hook", interactive: true });
    if (!r.verified) {
      if (this.interactive.get(sid)?.pid === pid) this.interactive.delete(sid);
      this.log({ type: "hook-session", sessionId: sid, claudePid: pid, interactive: false, reason: r.reason || "unverified", source });
      return false;
    }
    const startSec = this.ctx.sessions.get(sid)?.startSec ?? null;
    this.interactive.set(sid, { pid, startSec, at: Date.now() });
    this.log({ type: "hook-session", sessionId: sid, claudePid: pid, interactive: true, kind, entrypoint, source });
    return true;
  }

  async endSession(sid, reason) {
    const e = this.interactive.get(sid);
    this.interactive.delete(sid);
    this.requests.delete(sid);
    this.cancelSession(sid, reason);
    const entry = this.ctx.sessions.get(sid);
    if (entry?.sources?.includes("hook")) {
      // We also clear the interactive flag in the shared registry, even if the plugin still sees the session.
      if (entry.sources.length > 1 && entry.interactive) {
        await this.ctx.sessions.register(sid, { pid: entry.pid, source: "hook", interactive: false }).catch(() => {});
      }
      this.ctx.sessions.unregister(sid, "hook");
    }
    if (e) this.log({ type: "hook-session-end", sessionId: sid, claudePid: e.pid, reason });
  }

  // The session is interactive: registered by SessionStart, the same pid, the process is alive, Claude Code signature,
  // the start time didn't change (the pid wasn't reused).
  async isInteractive(sid, pid) {
    const e = this.interactive.get(sid);
    if (!e || e.pid !== pid) return false;
    const r = await this.ctx.peer.verifySigned(pid, "claudeCode");
    if (!r.ok || (e.startSec != null && r.startSec != null && r.startSec !== e.startSec)) {
      await this.endSession(sid, r.ok ? "pid-reused" : "dead");
      return false;
    }
    return true;
  }

  async sweep() {
    for (const [sid, e] of [...this.interactive]) await this.isInteractive(sid, e.pid);
  }

  // ---------- cards ----------
  skip(sid, pid, tool, reason) {
    this.log({ type: "hook-skip", sessionId: sid, claudePid: pid, tool, reason });
    return {};
  }

  rateOk(sid, now) {
    const arr = (this.requests.get(sid) || []).filter((t) => now - t < 60_000);
    if (arr.length >= this.opts.maxRequestsPerMinute) {
      this.requests.set(sid, arr);
      return false;
    }
    arr.push(now);
    this.requests.set(sid, arr);
    return true;
  }

  async permission(sid, pid, body, signal) {
    const now = Date.now();
    const tool = str(body.tool_name, 128) || "?";
    const input = body.tool_input;
    if (this.paused(now)) return this.skip(sid, pid, tool, "paused");
    let interactive = await this.isInteractive(sid, pid);
    // The daemon restarted (the in-memory registry is empty): the same verified hook, the same checks as SessionStart.
    if (!interactive && !this.interactive.has(sid)) interactive = await this.sessionStart(sid, pid, body, { lazy: true });
    if (!interactive) return this.skip(sid, pid, tool, "not-interactive");
    if (this.opts.skipTools.includes(tool)) return this.skip(sid, pid, tool, "skip-tool");
    if (!input || typeof input !== "object" || Array.isArray(input)) return this.skip(sid, pid, tool, "bad-input");
    if (!this.rateOk(sid, now)) return this.skip(sid, pid, tool, "rate");
    const kind = tool === "AskUserQuestion" ? "question" : "permission";
    let questions = null;
    if (kind === "question") {
      questions = sanitizeQuestions(input.questions);
      if (!questions) return this.skip(sid, pid, tool, "bad-questions");
    }
    const agentId = str(body.agent_id, 128);
    const dedupKey = sha(`${sid}|${agentId || ""}|${tool}|${stableStringify(input)}`);
    // A repeated identical request — the previous one no longer waits (answered in another channel or Claude asked again).
    for (const c of [...this.cards.values()]) if (c.dedupKey === dedupKey) this.cancel(c, "superseded");
    if (this.cards.size >= this.opts.maxPending) return this.skip(sid, pid, tool, "too-many");

    const requestId = randomBytes(16).toString("hex");
    let resolveFn;
    const promise = new Promise((r) => (resolveFn = r));
    const card = {
      requestId,
      sessionId: sid,
      claudePid: pid,
      agentId,
      kind,
      tool,
      summary: kind === "question" ? tr(this.lang(), "hook.question", { n: questions.length }) : safeSummary(tool, input, this.lang()),
      questions,
      toolInput: input, // memory only: needed for updatedInput
      dedupKey,
      createdAt: now,
      expiresAt: now + this.opts.waitMs,
      // The sessions plugin may have seen "waiting" before the hook arrived.
      sawWaiting: this.ctx.sessions.get(sid)?.status === "waiting",
      resolve: resolveFn,
      timer: null,
    };
    if (signal?.aborted) return this.skip(sid, pid, tool, "hook-gone");
    card.timer = setTimeout(() => this.cancel(card, "timeout"), this.opts.waitMs);
    card.timer.unref?.();
    signal?.addEventListener("abort", () => this.cancel(card, "hook-gone"), { once: true });
    this.cards.set(requestId, card);
    this.log({ type: "hook-card", request: requestRef(requestId), sessionId: sid, claudePid: pid, kind, tool, agent: Boolean(agentId) });
    this.ctx.emit({ type: "hook.card", requestId, sessionId: sid, kind, tool });
    return promise;
  }

  finish(card, output, entry) {
    if (!this.cards.has(card.requestId)) return false;
    this.cards.delete(card.requestId);
    clearTimeout(card.timer);
    card.resolve(output);
    this.log({ request: requestRef(card.requestId), sessionId: card.sessionId, claudePid: card.claudePid, tool: card.tool, ...entry });
    this.ctx.emit({ type: "hook.card.removed", requestId: card.requestId, sessionId: card.sessionId, reason: entry.reason });
    return true;
  }

  cancel(card, reason) {
    return this.finish(card, {}, { type: "hook-cancel", reason });
  }

  cancelSession(sid, reason) {
    for (const c of [...this.cards.values()]) if (c.sessionId === sid) this.cancel(c, reason);
  }

  cancelAll(reason) {
    for (const c of [...this.cards.values()]) this.cancel(c, reason);
  }

  pause(now = Date.now()) {
    this.pausedUntil = now + this.opts.pauseMs;
    this.cancelAll("paused");
    this.log({ type: "hook-paused", until: new Date(this.pausedUntil).toISOString(), limit: this.opts.maxApprovalsPerMinute });
    this.ctx.emit({ type: "hook.paused", until: new Date(this.pausedUntil).toISOString(), limit: this.opts.maxApprovalsPerMinute });
  }

  // Checking a decision without executing it (for the primitive's verifyFacts). → { ok, reason?, answers? }
  check(requestId, decision, answersJson) {
    if (!isRequestId(requestId)) return { ok: false, reason: "not-pending" };
    const card = this.cards.get(requestId);
    if (!card) return { ok: false, reason: "not-pending" };
    if (this.paused()) return { ok: false, reason: "paused" };
    if (!this.interactive.has(card.sessionId)) return { ok: false, reason: "not-interactive" };
    if (!DECISIONS.includes(decision)) return { ok: false, reason: "decision" };
    if (card.kind === "permission" && decision === "answer") return { ok: false, reason: "decision" };
    if (card.kind === "question" && decision === "once") return { ok: false, reason: "decision" };
    if (decision === "answer") {
      const a = buildAnswers(card.toolInput.questions, answersJson);
      if (a.error) return { ok: false, reason: a.error };
      return { ok: true, card, answers: a.answers };
    }
    if (answersJson !== undefined && answersJson !== null && answersJson !== "") return { ok: false, reason: "answers" };
    return { ok: true, card };
  }

  // A decision from the app. requester — the verified peer (class app). → { ok, error? }
  resolve(requestId, decision, answersJson, requester) {
    if (requester?.class !== "app") return { ok: false, error: "peer" };
    if (this.ctx.estop()) return { ok: false, error: "estop" };
    const c = this.check(requestId, decision, answersJson);
    if (!c.ok) return { ok: false, error: c.reason };
    const card = c.card;
    let output;
    if (decision === "deny") output = denyOutput(this.lang());
    else {
      const now = Date.now();
      this.approvals = this.approvals.filter((t) => now - t < 60_000);
      if (this.approvals.length >= this.opts.maxApprovalsPerMinute) {
        this.pause(now);
        return { ok: false, error: "rate-limit" };
      }
      this.approvals.push(now);
      output = decision === "answer" ? allowOutput({ ...card.toolInput, answers: c.answers }) : allowOutput(null);
    }
    this.finish(card, output, { type: "hook-answer", reason: "answered", decision, appPid: requester.pid ?? null });
    return { ok: true };
  }

  // Session statuses from the registry (claude agents --json via the plugin): was "waiting" → became something else,
  // so the request was already resolved in the terminal or Remote Control. (Claude Code 2.1.319: the PermissionRequest hook runs
  // in parallel with the open dialog, and an open dialog gives status=waiting, waitingFor "permission prompt".)
  onSessions(list) {
    if (!this.cards.size || !Array.isArray(list)) return;
    const byId = new Map(list.map((s) => [s.sessionId, s]));
    for (const c of [...this.cards.values()]) {
      const s = byId.get(c.sessionId);
      if (!s) continue;
      if (s.status === "waiting") c.sawWaiting = true;
      else if (c.sawWaiting && s.status) this.cancel(c, "answered-elsewhere");
    }
  }

  // ---------- views for routes ----------
  cardView(c) {
    const s = this.ctx.sessions.get(c.sessionId);
    return {
      requestId: c.requestId,
      sessionId: c.sessionId,
      sessionName: s?.name ?? null,
      surfaceId: s?.surfaceId ?? null,
      claudePid: c.claudePid,
      subagent: Boolean(c.agentId),
      kind: c.kind,
      tool: c.tool,
      summary: c.summary,
      questions: c.questions,
      decisions: c.kind === "question" ? ["answer", "deny"] : ["once", "deny"],
      createdAt: new Date(c.createdAt).toISOString(),
      expiresAt: new Date(c.expiresAt).toISOString(),
    };
  }

  cardsView() {
    return [...this.cards.values()].sort((a, b) => a.createdAt - b.createdAt).map((c) => this.cardView(c));
  }

  // Metadata only. full=true — for app and internal facts (card requestIds); cli — counters only:
  // requestId is the reply key, only the app sees it.
  statusView({ full = false } = {}) {
    const cards = [...this.cards.values()];
    const counts = { total: cards.length, permission: cards.filter((c) => c.kind === "permission").length, question: cards.filter((c) => c.kind === "question").length };
    return {
      // subagent — a request from a subagent (agent_id in the hook): so the session has ongoing work (idle service)
      ...(full ? { pending: cards.map((c) => ({ requestId: c.requestId, sessionId: c.sessionId, kind: c.kind, tool: c.tool, subagent: Boolean(c.agentId) })) } : {}),
      pendingCount: counts,
      interactiveSessions: [...this.interactive.keys()],
      paused: this.paused(),
      pausedUntil: this.paused() ? new Date(this.pausedUntil).toISOString() : null,
      limits: { waitMs: this.opts.waitMs, maxApprovalsPerMinute: this.opts.maxApprovalsPerMinute, pauseMs: this.opts.pauseMs },
    };
  }

  // The hook.pending fact for other extensions (push etc.): metadata only.
  pendingFact(requestId) {
    if (requestId === undefined) return this.statusView({ full: true }).pending;
    const c = this.cards.get(requestId);
    return c ? { requestId: c.requestId, sessionId: c.sessionId, kind: c.kind, tool: c.tool, subagent: Boolean(c.agentId), createdAt: c.createdAt } : null;
  }
}
