// Installing a registry plugin from the terminal: `agenthub plugins install <id>`.
//
// Why: while the app build is not pinned (requirements.app, scripts/bundle.sh), class app is unreachable and the manager in the shell
// cannot install plugins (POST /registry/install is app only). This path is the same PluginManager as in the
// daemon: the index.json catalog is verified with the public key from config.json (services.plugins.publicKey), the archive
// by sha256 from the signed index, the same linter, the plugins.lock entry, tier from the index. There is one difference:
// the permissions window is printed to the terminal, and consent is typing the plugin id by hand.
//
// Only with a terminal (stdin and stdout are TTYs) and only not from under Claude Code: among the process's ancestors (by ppid,
// up to the root) there must be no Claude process — neither by signature (requirements.claudeCode, as in the hook check) nor by
// executable name/argv; a CLAUDECODE variable in the environment is also a refusal. A TTY by itself does not prove a
// human: `script -q /dev/null …` gives a program a pty, so an agent from a Claude session (the Bash tool) would otherwise
// install and remove plugins even though POST /registry/install|remove is closed to it (class cli). The limit is the same as for
// the peer check (design §3, accepted risk v1): a process detached from the Claude tree (a new terminal
// window via open/osascript, launchd) cannot be told apart this way. If there is no way to learn the ancestors (no addon and no ps) — refusal.
// Only what the registry owner signed gets installed; network only if indexUrl is https:// and allowNetwork is not false.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { currentLang, t } from "../i18n.mjs";
import { Journal } from "../journal.mjs";
import { createPeer, defaultSys } from "../peer.mjs";
import { myUid, psCommand } from "../platform.mjs";
import { PluginManager, RegistryError } from "../plugins.mjs";
import { writeRiskText } from "./perms.mjs";

const KINDS = new Set(["fsRead", "fsWrite", "watch", "exec", "secrets", "net", "effects", "actions", "connections", "terminal", "subscribe"]);

// Moving from an own plugin (the same id from an own folder) to a registry plugin is not an "Update": a "Replace" line and
// what follows from it (watching the folder stops), as in the app window. lang — the hub language (the CLI's by default).
export function consentText(prep, lang = currentLang()) {
  const tr = (key, params) => t(lang, key, params);
  const lines = [];
  const tier = tr(prep.entry.tier === "official" ? "cli.term.tier.official" : "cli.term.tier.community");
  const head = tr(prep.migrate ? "cli.term.head.replace" : prep.update ? "cli.term.head.update" : "cli.term.head.install");
  lines.push(tr("cli.term.title", { head, title: prep.entry.title, from: prep.fromVersion, version: prep.entry.version, tier, sha: prep.entry.sha256.slice(0, 16) }));
  if (prep.migrate?.from === "own") {
    lines.push(tr("cli.term.replacesOwn", { title: prep.entry.title, version: prep.migrate.version || "", path: prep.migrate.path || "?" }));
  }
  lines.push(tr("cli.term.perms"));
  for (const p of prep.list) {
    lines.push(`  ${p.added && prep.update ? tr("cli.term.new") : ""}${KINDS.has(p.kind) ? tr(`cli.term.kind.${p.kind}`) : p.kind}: ${p.what}${p.why ? ` — ${p.why}` : ""}`);
    // writing to a takeover location of Claude Code or the system (contract 3) — as a separate loud line
    if (p.risk) lines.push(tr("cli.term.danger", { text: writeRiskText(p.risk, lang) || p.risk }));
  }
  return lines.join("\n");
}

// The executable or argv looks like Claude Code: `claude`, the native build ~/.local/share/claude/versions/<v>,
// the @anthropic-ai/claude-code package.
const CLAUDE_NAME = /(?:^|[\/\\])claude(?:-code)?(?:\.exe)?$|[\/\\]claude[\/\\]versions[\/\\]|@anthropic-ai[\/\\]claude-code(?:[\/\\]|$)/i;

// The process table via ps — when there is no peercred addon (POSIX). Windows: null (ancestors cannot be determined).
export function psSys() {
  const bin = psCommand();
  if (!bin) return null;
  const ps = (pid, ...fields) => {
    try {
      return execFileSync(bin, [...fields.flatMap((f) => ["-o", `${f}=`]), "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  };
  return {
    available: true,
    pidInfo: (pid) => {
      const line = ps(pid, "ppid", "uid");
      const m = /^(\d+)\s+(\d+)$/.exec(line || "");
      return m ? { pid, ppid: Number(m[1]), uid: Number(m[2]), startSec: 0, startUsec: 0 } : null;
    },
    pidPath: (pid) => ps(pid, "comm") || null,
    procArgv: (pid) => (ps(pid, "args") || "").split(/\s+/).filter(Boolean).slice(0, 4),
    codeInfo: null,
    codesignVerify: async () => ({ ok: false, definite: true }),
    fileId: () => null,
    myUid,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}

// A Claude Code process among the ancestors of pid. → { pid, by: "signature"|"name"|"env" } | null; ancestors cannot be determined — throw.
export async function claudeAncestor({ config, sys = null, pid = process.pid, env = process.env, maxDepth = 64 } = {}) {
  if (env?.CLAUDECODE) return { pid: null, by: "env" };
  let s = sys;
  if (!s) {
    s = defaultSys();
    if (!s.available) s = psSys();
  }
  if (!s || !s.available) throw new RegistryError(403, "terminal:no-ancestry");
  const peer = config.requirements?.claudeCode ? createPeer({ config, sys: s }) : null;
  const named = (p) => {
    const path = s.pidPath(p);
    const argv = s.procArgv(p) || [];
    return [path, ...argv.slice(0, 2)].some((x) => typeof x === "string" && CLAUDE_NAME.test(x));
  };
  let cur = s.pidInfo(pid);
  if (!cur) throw new RegistryError(403, "terminal:no-ancestry");
  for (let i = 0; i < maxDepth && cur; i++) {
    const ppid = cur.ppid;
    if (!ppid || ppid <= 1) return null;
    if (named(ppid)) return { pid: ppid, by: "name" };
    if (peer && (await peer.verifySigned(ppid, "claudeCode")).ok) return { pid: ppid, by: "signature" };
    cur = s.pidInfo(ppid);
  }
  return null;
}

// A shared check before install and removal from the terminal.
async function terminalGuard({ config, isTTY, sys, pid, env }) {
  if (!isTTY) throw new RegistryError(403, "terminal:no-tty");
  const a = await claudeAncestor({ config, sys, pid, env });
  if (a) throw new RegistryError(403, "terminal:agent", { by: a.by, pid: a.pid });
}

// → { ok, id, version, update } ; ask(question) → Promise<string> ; out(text)
// sys, pid, env — replacing the process table and the environment in tests (claudeAncestor).
export async function terminalInstall({ config, id, ask, out = console.log, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), sys = null, pid = process.pid, env = process.env }) {
  await terminalGuard({ config, isTTY, sys, pid, env });
  const journal = new Journal(config.paths.journal, { maxBytes: config.journal?.maxBytes });
  const mgr = new PluginManager({ config, journal, estop: () => existsSync(config.paths.estop) });
  await mgr.init({ cleanTemp: "stale" });
  if (mgr.estop()) throw new RegistryError(423, "estop");
  const f = await mgr.fetchCatalog();
  out(t(currentLang(), "cli.term.catalog", { n: f.plugins, at: mgr.catalog.generatedAt }));
  const prep = await mgr.prepare(id);
  out(consentText(prep));
  if (prep.needsConsent) {
    const answer = String(await ask(t(currentLang(), prep.migrate ? "cli.term.askReplace" : "cli.term.askAgree", { id }))).trim();
    if (answer !== id) {
      journal.write({ type: "plugin-consent-declined", plugin: id, via: "terminal" });
      return { ok: false, id, declined: true };
    }
  }
  const r = mgr.commit(prep, { pid: process.pid });
  journal.write({ type: "plugin-installed-terminal", plugin: id, version: r.version, tier: prep.entry.tier, pid: process.pid });
  return r;
}

// `agenthub plugins remove <id>`: the same removal as POST /registry/remove (files, lock entry, cache).
export async function terminalRemove({ config, id, ask, purge = false, out = console.log, isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY), sys = null, pid = process.pid, env = process.env }) {
  await terminalGuard({ config, isTTY, sys, pid, env });
  const journal = new Journal(config.paths.journal, { maxBytes: config.journal?.maxBytes });
  const mgr = new PluginManager({ config, journal, estop: () => existsSync(config.paths.estop) });
  await mgr.init({ cleanTemp: "stale" });
  if (!mgr.lockEntry(id)) throw new RegistryError(404, "not-found");
  out(t(currentLang(), "cli.term.remove", { id, version: mgr.lockEntry(id).version, purge }));
  const answer = String(await ask(t(currentLang(), "cli.term.askRemove", { id }))).trim();
  if (answer !== id) return { ok: false, id, declined: true };
  return mgr.remove(id, { purge, peer: { pid: process.pid } });
}
