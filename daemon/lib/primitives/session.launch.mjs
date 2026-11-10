// session.launch primitive: starts a new Claude Code session in a new cmux tab via the bridge.
//
// The folder, name and prompt are entered by a human in the app form; plugin suggestions are not accepted
// (ctx.plugin ≠ null → refusal). The prompt never goes to the journal, the confirmation text or the cmux command
// line: it is written to <AgentHub>/launch/<uuid>.prompt (0600), the bridge opens a tab with bridge/launch.sh,
// and launch.sh reads the file, deletes it and runs
//   claude --session-id <uuid> --remote-control -n <name> -- <prompt>
// (no --allow-dangerously-skip-permissions or other bypasses). After the bridge replies, the actions service waits
// for the session entry in ~/.cmuxterm/claude-hook-sessions.json (event bridge.launch.registered / bridge.launch.timeout)
// and deletes the prompt file if launch.sh never read it.
// Level "confirm with cost", from app only (the core enforces this for session.*), from the Mac only.

import { t } from "../i18n.mjs";
import { mkdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { SESSION_NAME_RE, bridgeOf, cfgOf, isDir } from "./_actions-support.mjs";

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
  const ch = bridgeOf(facts);
  if (!ch?.online()) return { ok: false, reason: "bridge-offline" };
  return { ok: true, cfg, ch, cwd: real };
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
  return {
    text: t(lang, "prim.session.launch", { name: args.name, cwd: args.cwd, n }),
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
  const res = await r.ch.call({ op: "new-workspace", cwd: r.cwd, name: args.name, sessionId, promptFile }, { resultMs: 20_000 });
  if (!res.ok) {
    rmSync(promptFile, { force: true });
    return { ok: false, error: res.error ?? null, code: res.code ?? null, sessionId };
  }
  r.ch.trackLaunch({ sessionId, promptFile, workspaceId: res.workspaceId || null });
  return { ok: true, sessionId, workspaceId: res.workspaceId || null };
}
