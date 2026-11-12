// The session.stop primitive — stop a Claude Code session with SIGTERM (continue later: claude --resume).
//
// Who can be stopped: only a session from the core registry (only processes with Claude Code's signature get there,
// requirements.claudeCode). Before the signal:
//   0) the process was started by a human: there is a controlling terminal and argv has no -p/--print/--output-format
//      (facts.claudeProcess). Background `claude -p` runs are not stopped this way — whoever started them stops them
//      (with their own soft stop and integrity check). kind from the session file is only a hint: any process with the same UID can rewrite the file;
//   1) ~/.claude/sessions/<pid>.json exists (interactive sessions always have it; no file — refused, closed) and
//      names the same sessionId; kind, if given, is interactive;
//   2) procStart from the same file matches the process start allowing for the time zone;
//   3) the signature is verified again, and the start time of the process with this pid equals the one recorded in the registry
//      at registration — the pid was not reused by another process.
// A non-Claude agent session (G13, kind "external") is refused with facts:external-session: no signature, nothing to stop by.
// Only from app (the core enforces this for session.*).

import { t } from "../i18n.mjs";
import { EXTERNAL_SESSION_SRC, cfgOf, procStartMatches, readClaudeSessionFile } from "./_actions-support.mjs";
import { terminateCommand } from "../platform.mjs";

export const name = "session.stop";
export const level = "confirm";
export const remoteAllowed = true;
export const appOnly = true;

export const argsSchema = {
  // a UUID (Claude Code) or an external agent session id (G13; UUIDs match this pattern too): a non-Claude session must get its
  // documented refusal facts:external-session, not a pattern error (B8); any other non-UUID id is facts:unknown-session
  sessionId: { type: "string", required: true, positional: true, pattern: EXTERNAL_SESSION_SRC },
};

function check(args, facts) {
  // a non-Claude agent session (G13): only session.focus works for it — refused before anything else
  if (!facts.session(args.sessionId) && facts.externalSession?.(args.sessionId)) return { ok: false, reason: "external-session" };
  const cfg = cfgOf(facts);
  if (!cfg) return { ok: false, reason: "actions-off" };
  const s = facts.session(args.sessionId);
  if (!s) return { ok: false, reason: "unknown-session" };
  if (!Number.isInteger(s.pid) || s.pid <= 1) return { ok: false, reason: "bad-pid" };
  if (!Number.isFinite(s.startSec)) return { ok: false, reason: "no-start" };
  if (s.kind && s.kind !== "interactive") return { ok: false, reason: "non-interactive" };
  const proc = facts.claudeProcess ? facts.claudeProcess(s.pid) : { ok: false, reason: "no-check" };
  if (!proc?.ok) return { ok: false, reason: `non-interactive:${proc?.reason || "unknown"}` };
  const f = readClaudeSessionFile(cfg, s.pid);
  if (f.unreadable) return { ok: false, reason: "session-file-unreadable" };
  if (!f.exists) return { ok: false, reason: "no-session-file" };
  if (f.sessionId !== args.sessionId) return { ok: false, reason: "session-file-mismatch" };
  if (f.pid !== null && f.pid !== s.pid) return { ok: false, reason: "session-file-mismatch" };
  if (f.kind && f.kind !== "interactive") return { ok: false, reason: "non-interactive" };
  if (procStartMatches(f.procStart, s.startSec) === false) return { ok: false, reason: "proc-start-mismatch" };
  return { ok: true, s };
}

export function verifyFacts(args, facts) {
  const r = check(args, facts);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export function describe(args, facts, lang = "ru") {
  const s = facts?.session?.(args.sessionId);
  const who = s?.name || args.sessionId.slice(0, 8);
  return { text: t(lang, "prim.session.stop", { who, sessionId: args.sessionId }), cost: null };
}

export async function run(args, ctx) {
  const r = check(args, ctx.facts);
  if (!r.ok) return { ok: false, error: r.reason };
  const { pid, startSec } = r.s;
  const v = await ctx.peer.verifySigned(pid, "claudeCode");
  if (!v.ok) return { ok: false, error: `signature:${v.reason || "failed"}`, pid };
  if (v.startSec !== startSec) return { ok: false, error: "pid-reused", pid };
  const [file, ...argv] = terminateCommand(pid);
  const k = await ctx.exec(file, argv, { timeoutMs: 5000 });
  return { ok: k.code === 0, code: k.code, pid };
}
