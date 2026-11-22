// The agents whose hooks the hub answers: one table instead of per-agent branches spread over peer.mjs and cards.mjs.
//
// A hook peer (lib/peer.mjs) is agenthub-hook with a signed agent process among its ancestors; the agent kind is the
// first table entry whose requirement that ancestor passes. Everything that differs between agents is looked up here:
//
//   requirement   — the config.requirements key the ancestor must pass (codesign on the running process);
//   label         — the agent's name in the app (the card badge "<label> ✓": the hub verified this signature);
//   verifySession — whether the hook's session_id really belongs to that ancestor (POST /hook, before any handler);
//   process       — whether the ancestor was started by a human and is worth a card (SessionStart / lazy registration):
//                   properties of the process itself, which an agent inside the session cannot change;
//   sessionFile   — Claude Code only: kind/entrypoint from ~/.claude/sessions/<pid>.json as an extra hint;
//   registry      — the session goes into the core's Claude Code registry (ctx.sessions.register accepts only signed
//                   Claude Code pids); other agents are kept in the hook service only, keyed by session_id;
//   oneSessionPerProcess — one process hosts one current session (Claude Code: /clear, resume, compact rebind the pid).
//                   false (Codex): one process hosts many threads — the shared app-server daemon hosts the threads of
//                   every TUI, and even a TUI hosts its subagents' threads, whose hooks carry the root thread's
//                   session_id. Any tool command under that process can send hooks naming another of its threads, so
//                   lib/hook/cards.mjs lets a lifecycle event (Stop, SessionEnd) from such a process neither cancel cards
//                   nor close a session for good, never replaces a pending card by a new connection, and caps the cards
//                   pending per process (maxPendingPerProcess);
//   sharedProcess(argv) — this launch hosts several conversations at once (Codex: the daemon, an IDE app-server): the
//                   session proof is not cached for it (lib/peer.mjs);
//   questions     — AskUserQuestion-style answers (allow + updatedInput) are possible. Codex rejects updatedInput and
//                   updatedPermissions in a PermissionRequest answer (the decision is dropped), so a Codex card only ever
//                   answers allow / deny / "decide in terminal".
//
// The response shape is the same for both agents: {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
// "decision":{"behavior":"allow"}}} or behavior "deny" + message; {} (exit 0) — no decision, the agent asks in its own
// terminal prompt.

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

// A Codex thread id (= the rollout id; session_id is the root thread's id): a UUID exactly as Codex prints it — lowercase
// (ThreadId's Display). Checked before it becomes part of a lock file path; any other spelling is refused, so one thread
// never has two names in the hub.
export const CODEX_THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The rollout file Codex reports as transcript_path: sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl[.zst].
export const codexRolloutName = (threadId) => new RegExp(`^rollout-[0-9A-Za-z:.T_-]{1,64}-${threadId.replace(/[^0-9a-f-]/g, "")}\\.jsonl(?:\\.zst)?$`);

// How a codex process was started, from its argv. The first token that is not an option (or an option's value) is a
// subcommand or the TUI's prompt:
//   tui        — `codex [PROMPT]`, `codex resume …`, `codex fork …`: the terminal UI; hosts its threads in-process when it
//                does not use the shared daemon (`--no-daemon`, `-c` overrides, --dangerously-bypass-hook-trust, …);
//   daemon     — `codex app-server [--remote-control] --listen unix:// [-c features.…]`: the shared app-server daemon a
//                default TUI starts and hosts its threads in (tui/src/startup_orchestration.rs,
//                app-server-daemon/src/backend/pid.rs). Exactly `unix://` — the default control socket; a listener on
//                any other socket path is some other app-server ("app-server"). It runs under setsid, without a
//                terminal, so it is recognised by argv alone;
//   exec       — `codex exec` / `codex e`: non-interactive, no human at the terminal;
//   app-server — `codex app-server` on stdio or another transport (IDE extensions, the desktop app): not ours by default;
//   other      — any other subcommand (review, mcp, cloud, …).
const CODEX_VALUE_OPTS = new Set([
  "-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-i", "--image", "-m", "--model",
  "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);
const CODEX_SUBCOMMANDS = new Set([
  "agents", "exec", "e", "review", "login", "logout", "mcp", "plugin", "app-server", "remote-control", "app", "completion",
  "update", "doctor", "sandbox", "debug", "execpolicy", "apply", "a", "resume", "queue", "archive", "delete",
  "migrate-rollouts", "unarchive", "fork", "cloud", "cloud-tasks", "responses-api-proxy", "stdio-to-uds", "exec-server",
  "features", "tcp-tunnel", "mcp-server", "help",
]);
export function codexMode(argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const args = argv.slice(1).map((a) => (typeof a === "string" ? a : ""));
  let i = 0;
  let sub = null;
  while (i < args.length) {
    const a = args[i];
    if (a === "--") {
      i++;
      break;
    }
    if (a.startsWith("-")) {
      i += CODEX_VALUE_OPTS.has(a) ? 2 : 1;
      continue;
    }
    sub = a;
    i++;
    break;
  }
  if (sub === null || !CODEX_SUBCOMMANDS.has(sub)) return "tui";
  if (sub === "resume" || sub === "fork") return "tui";
  if (sub === "exec" || sub === "e") return "exec";
  if (sub === "app-server") {
    const rest = args.slice(i);
    if (rest.length && !rest[0].startsWith("-")) return "other"; // `app-server proxy`, `app-server generate-…`
    for (let k = 0; k < rest.length; k++) {
      const v = rest[k] === "--listen" ? rest[k + 1] : rest[k].startsWith("--listen=") ? rest[k].slice(9) : null;
      if (v === "unix://") return "daemon";
    }
    return "app-server";
  }
  return "other";
}

// A path inside dir after resolving symlinks. The file itself may not exist yet (Codex creates the rollout file with the
// first record): then its nearest existing ancestor is resolved and the rest appended. "." and ".." segments — never.
function realInside(path, dir, fs) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096) return null;
  if (path.split(/[\\/]+/).some((s) => s === "." || s === "..")) return null;
  let root;
  try {
    root = fs.realpath(dir);
  } catch {
    return null;
  }
  let head = path;
  const tail = [];
  for (let n = 0; n < 8; n++) {
    try {
      const real = join(fs.realpath(head), ...tail);
      return real.startsWith(root + sep) ? real : null;
    } catch {
      tail.unshift(basename(head));
      const up = dirname(head);
      if (up === head) return null;
      head = up;
    }
  }
  return null;
}

const DEFAULT_FS = { realpath: (p) => realpathSync(p), lstat: (p) => lstatSync(p) };

// Codex session proof: the thread's writer lock — $CODEX_HOME/thread-writer-locks/<thread id>.lock, which the process
// hosting the thread keeps open (and flock-ed) for the thread's lifetime (rollout/src/writer_lock.rs) — is open in that
// very ancestor (`lsof -Fp`; the hub never takes the lock itself), and transcript_path is that thread's rollout under
// $CODEX_HOME/sessions. lsof on macOS does not report flock state, so "open by the agent pid" stands for "held": Codex
// opens the file only to take the lock (or to probe it for a moment).
//
// A thread-spawn subagent's hooks carry the ROOT thread's id as session_id (core/src/session/session.rs: one session
// identity for the root and its descendants), the subagent's own thread id as agent_id and the subagent's rollout as
// transcript_path (core/src/hook_runtime.rs). Such a hook is accepted when the subagent's lock and rollout pass the check
// above and the root thread's lock is open in the same ancestor too. That is no more than the plain check already grants
// a process: it may name any thread it hosts.
async function heldBy(home, threadId, pid, sys, fs) {
  const lock = join(home, "thread-writer-locks", `${threadId}.lock`);
  try {
    if (!fs.lstat(lock).isFile()) return { ok: false, reason: "peer:no-session-file" };
  } catch {
    return { ok: false, reason: "peer:no-session-file" };
  }
  const holders = await sys.fileHolders(lock);
  if (!Array.isArray(holders)) return { ok: false, reason: "peer:no-session-file" };
  return holders.includes(pid) ? { ok: true } : { ok: false, reason: "peer:session-mismatch" };
}

async function verifyCodexSession({ config, sys, pid, sessionId, body, fs = DEFAULT_FS }) {
  if (typeof sessionId !== "string" || !CODEX_THREAD_RE.test(sessionId)) return { ok: false, reason: "peer:session-mismatch" };
  const home = config.codexHome;
  if (!home || typeof sys.fileHolders !== "function") return { ok: false, reason: "peer:no-session-file" };
  // the thread that runs the hook: the session's own, or a subagent's (agent_id)
  const agentId = body?.agent_id;
  const sub = typeof agentId === "string" && agentId !== sessionId ? agentId : null;
  if (sub !== null && !CODEX_THREAD_RE.test(sub)) return { ok: false, reason: "peer:session-mismatch" };
  const thread = sub ?? sessionId;
  const transcript = realInside(body?.transcript_path, join(home, "sessions"), fs);
  if (!transcript || !codexRolloutName(thread).test(basename(transcript))) return { ok: false, reason: "peer:session-mismatch" };
  const own = await heldBy(home, thread, pid, sys, fs);
  if (!own.ok || sub === null) return own;
  return heldBy(home, sessionId, pid, sys, fs);
}

// Claude Code session proof: the hook's session_id is the one in ~/.claude/sessions/<Claude pid>.json.
async function verifyClaudeSession({ config, sys, pid, sessionId }) {
  let data;
  try {
    data = sys.readJson(join(config.claudeHome, "sessions", `${pid}.json`));
  } catch {
    return { ok: false, reason: "peer:no-session-file" };
  }
  if (typeof sessionId !== "string" || !sessionId || data?.sessionId !== sessionId) return { ok: false, reason: "peer:session-mismatch" };
  if (data.pid !== undefined && data.pid !== pid) return { ok: false, reason: "peer:session-mismatch" };
  return { ok: true };
}

// argv flags with which Claude Code runs without a human (background `claude -p`, SDK).
export function isPrintArgv(argv) {
  return (argv || []).slice(1).some((a) => {
    if (typeof a !== "string") return false;
    if (a === "--") return false;
    if (a === "-p" || a === "--print") return true;
    if (/^--(print|output-format|input-format)(=|$)/.test(a)) return true;
    return /^-[A-Za-z]*p[A-Za-z]*$/.test(a) && !a.startsWith("--");
  });
}

export const CODEX_MODES_DEFAULT = Object.freeze(["tui", "daemon"]);

export const AGENTS = Object.freeze({
  claude: Object.freeze({
    requirement: "claudeCode",
    label: "Claude Code",
    registry: true,
    oneSessionPerProcess: true,
    sharedProcess: () => false,
    questions: true,
    sessionFile: true,
    verifySession: verifyClaudeSession,
    // a controlling terminal and argv without -p/--print/--output-format
    process(info, argv) {
      if (info.tty !== true) return { ok: false, reason: "no-tty" };
      if (isPrintArgv(argv)) return { ok: false, reason: "print" };
      return { ok: true, mode: "cli" };
    },
  }),
  codex: Object.freeze({
    requirement: "codex",
    label: "Codex",
    registry: false,
    oneSessionPerProcess: false,
    // the launch modes whose process hosts threads of several conversations at once (the shared daemon, an app-server
    // serving an IDE or the desktop app): a positive session proof is not cached for them (lib/peer.mjs)
    sharedProcess: (argv) => !["tui", "exec"].includes(codexMode(argv)),
    questions: false,
    sessionFile: false,
    verifySession: verifyCodexSession,
    // the launch mode is one of opts.codexModes (services.hook.codexModes; tui + daemon by default); the TUI must have a
    // controlling terminal, the daemon never has one (setsid)
    process(info, argv, opts = {}) {
      const mode = codexMode(argv);
      const modes = Array.isArray(opts.codexModes) ? opts.codexModes : CODEX_MODES_DEFAULT;
      if (!mode || !modes.includes(mode)) return { ok: false, reason: `mode-${mode || "unknown"}`, mode };
      if (mode === "tui" && info.tty !== true) return { ok: false, reason: "no-tty", mode };
      return { ok: true, mode };
    },
  }),
});
export const AGENT_KINDS = Object.freeze(Object.keys(AGENTS));

// The agent of a hook peer. Peers made before the table (and test doubles) carry only claudePid: that is Claude Code.
export function peerAgent(peer) {
  if (!peer || peer.class !== "hook") return null;
  const kind = peer.agent ?? (Number.isInteger(peer.claudePid) ? "claude" : null);
  const pid = Number.isInteger(peer.agentPid) ? peer.agentPid : Number.isInteger(peer.claudePid) ? peer.claudePid : null;
  if (!kind || !AGENTS[kind] || !pid) return null;
  return { kind, pid, spec: AGENTS[kind] };
}

// The agent's pid under the journal key the hub has always used for Claude Code (claudePid), and agent + agentPid for
// the others.
export function pidFields(kind, pid) {
  return !kind || kind === "claude" ? { claudePid: pid } : { agent: kind, agentPid: pid };
}
