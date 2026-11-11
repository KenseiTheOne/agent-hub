// session.launch primitive: starts a new Claude Code session in a new terminal tab (the terminal layer, lib/terminals/: cmux —
// through the bridge, tmux — new-window, iTerm2 and Terminal.app — AppleScript). Which terminal: services.terminal.launch
// (an adapter id) or "auto" — the terminal most live sessions run in, otherwise the first installed (launchAdapter).
//
// The folder, name and prompt are entered by a human in the app form; plugin suggestions are not accepted
// (ctx.plugin ≠ null → refusal). The prompt never goes to the journal, the confirmation text or the terminal's command
// line: it is written to <AgentHub>/launch/<uuid>.prompt (0600), the new tab runs bridge/launch.sh, and launch.sh reads the file,
// deletes it and runs
//   claude --session-id <uuid> --remote-control -n <name> -- <prompt>
// (no --allow-dangerously-skip-permissions or other bypasses). After the terminal replies, the actions service waits for the
// session to appear (cmux: its entry in ~/.cmuxterm/claude-hook-sessions.json; other terminals: the core session registry;
// event bridge.launch.registered / bridge.launch.timeout) and deletes the prompt file if launch.sh never read it.
// Level "confirm with cost", from app only (the core enforces this for session.*), from the Mac only.
//
// Refusals (facts:<code>): actions-off, no-launch-dir, bad-name, bad-cwd, forbidden-cwd, no-launch-terminal (no terminal can
// open a tab), launch-unsupported, the adapter's code when it is unavailable (bridge-offline), offer-not-allowed.

import { t } from "../i18n.mjs";
import { mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_NAME_RE, bridgeOf, cfgOf, isDir } from "./_actions-support.mjs";
import { availability, launchFor, supports } from "../terminals/index.mjs";

export const name = "session.launch";
export const level = "confirm-cost";
export const remoteAllowed = false;
export const appOnly = true;

export const argsSchema = {
  cwd: { type: "string", required: true, maxLength: 1024 },
  name: { type: "string", required: true, maxLength: 64 },
  prompt: { type: "string", maxLength: 16_000, default: "" },
};

function inside(p, dir) {
  return Boolean(dir) && (p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep));
}

function check(args, facts) {
  const cfg = cfgOf(facts);
  if (!cfg) return { ok: false, reason: "actions-off" };
  if (!cfg.launchDir) return { ok: false, reason: "no-launch-dir" };
  if (!SESSION_NAME_RE.test(args.name)) return { ok: false, reason: "bad-name" };
  if (!isAbsolute(args.cwd) || !isDir(args.cwd)) return { ok: false, reason: "bad-cwd" };
  let real;
  try {
    real = realpathSync(args.cwd);
  } catch {
    return { ok: false, reason: "bad-cwd" };
  }
  if (/[\0\n\r]/.test(real)) return { ok: false, reason: "bad-cwd" };
  // Never start sessions inside the Claude Code or hub directories.
  for (const d of [cfg.claudeHome, cfg.agenthubHome]) {
    let rd = d;
    try {
      rd = realpathSync(d);
    } catch {}
    if (inside(real, rd)) return { ok: false, reason: "forbidden-cwd" };
  }
  const l = launchFor(facts);
  if (!l) return { ok: false, reason: "no-launch-terminal" };
  if (!supports(l.adapter, "launch")) return { ok: false, reason: "launch-unsupported" };
  const av = availability(l.adapter, facts);
  if (av.error) return { ok: false, reason: av.error };
  // the launch tracker lives in the actions service (bridge.channel), whether or not the bridge is connected
  const ch = bridgeOf(facts);
  if (!ch) return { ok: false, reason: "actions-off" };
  return { ok: true, cfg, ch, cwd: real, adapter: l.adapter };
}

// The core's third argument: { peer, plugin, config }. Only a human enters the prompt; a plugin suggestion
// is rejected before the confirmation dialog.
export function verifyFacts(args, facts, { plugin = null } = {}) {
  if (plugin) return { ok: false, reason: "offer-not-allowed" };
  const r = check(args, facts);
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

export function describe(args, facts, lang = "ru") {
  const n = (args.prompt || "").length;
  let terminal = null;
  try {
    const l = launchFor(facts);
    terminal = l ? l.adapter.label || l.adapter.id : null;
  } catch {}
  return {
    text: t(lang, "prim.session.launch", { name: args.name, cwd: args.cwd, n, terminal }),
    cost: t(lang, "prim.session.launch.cost"),
  };
}

export async function run(args, ctx) {
  if (ctx.plugin) return { ok: false, error: "offer-not-allowed" };
  const r = check(args, ctx.facts);
  if (!r.ok) return { ok: false, error: r.reason };
  const sessionId = randomUUID();
  mkdirSync(r.cfg.launchDir, { recursive: true, mode: 0o700 });
  chmodSync(r.cfg.launchDir, 0o700);
  const promptFile = join(r.cfg.launchDir, `${sessionId}.prompt`);
  writeFileSync(promptFile, args.prompt || "", { mode: 0o600, flag: "wx" });
  let res;
  try {
    res = await r.adapter.launch({ cwd: r.cwd, name: args.name, sessionId, promptFile }, ctx.facts);
  } catch {
    res = { ok: false, error: "terminal-failed" };
  }
  if (!res?.ok) {
    rmSync(promptFile, { force: true });
    return { ok: false, error: res?.error ?? null, code: res?.code ?? null, sessionId, terminal: r.adapter.id };
  }
  const adapter = r.adapter;
  const facts = ctx.facts;
  const workspaceId = res.workspaceId || null;
  // the session has appeared: the adapter knows (cmux — its session file), otherwise the core registry
  const registered = typeof adapter.registered === "function" ? () => adapter.registered(sessionId, facts, { workspaceId }) : () => {
    const s = facts.session?.(sessionId);
    return s ? { pid: s.pid ?? null, surfaceId: null, workspaceId: null } : null;
  };
  r.ch.trackLaunch({ sessionId, promptFile, workspaceId, registered, terminal: adapter.id });
  return { ok: true, sessionId, workspaceId, terminal: adapter.id };
}
