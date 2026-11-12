// Daemon configuration: paths and settings.
//
// State directory: ~/Library/Application Support/AgentHub, or AGENTHUB_HOME (test mode).
// Settings file: <home>/config.json (optional) — merged on top of the defaults.
// Signature requirement strings (requirements.*) live here, not in the verification code. The daemon re-reads
// requirements.app from config.json without a restart (lib/app-pin.mjs); the rest — at startup.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLiveStateDir, standardPath as platformPath, stateDir, transportPath } from "./platform.mjs";
import { isLabel } from "./version.mjs";
import { msg } from "./i18n.mjs";

export const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(DAEMON_DIR, "..");

// Is the code running from a standalone install <home>/Versions/<label>/src (docs/hub-updates.md)? → { home, label, versions,
// stableRepo } | null (developer working copy, tests). launchd starts the daemon through the symlink
// Versions/current, and Node resolves the main module symlink — so REPO_DIR here is always the real version directory.
export function installOf(repoDir) {
  const m = /^(.*)[/\\]Versions[/\\]([^/\\]+)[/\\]src$/.exec(String(repoDir || ""));
  if (!m || !isLabel(m[2])) return null;
  const versions = join(m[1], "Versions");
  return { home: m[1], label: m[2], versions, stableRepo: join(versions, "current", "src") };
}
export const INSTALL = installOf(REPO_DIR);
// Directories the hook and the bridge may be launched from: via Versions/current (that is how they are launched after install) and
// the real directory of this version. Outside an install — REPO_DIR only.
const RUN_DIRS = INSTALL ? [INSTALL.stableRepo, REPO_DIR] : [REPO_DIR];

// PATH like that of agents launched by launchd (Homebrew and ~/.local/bin ahead of the system ones), without NODE_OPTIONS. Platform layer.
export function standardPath(home = homedir()) {
  return platformPath({ home });
}

export const DEFAULTS = Object.freeze({
  // codesign requirements (strings for `codesign --verify --strict -R=<string>`).
  requirements: {
    // null — the app build is not pinned: the `app` class is unreachable (everything is treated as cli).
    // By default (2026-11-05) — an ad hoc build pinned by cdhash: identifier "com.kensei.agenthub" and cdhash H"<cdhash>"
    // (scripts/bundle.sh → agenthub pin-app, re-read on the fly — lib/app-pin.mjs). Optional mode
    // with a certificate: identifier "com.kensei.agenthub" and certificate leaf = H"<sha1>" (bundle.sh --cert).
    app: null,
    claudeCode:
      'identifier "com.anthropic.claude-code" and anchor apple generic and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
  },
  peer: {
    // The app executable must live inside a bundle with this name.
    appBundleName: "AgentHub.app",
    // Hook and bridge scripts (the interpreter's argv[1] or the executable itself). ~ is expanded.
    // The third path — the hook copy in the Claude Code plugin from this repo (`claude --plugin-dir <repo>/claude-plugin`).
    // From an install (Versions/<label>) — both through the Versions/current symlink and the real version path (installOf).
    hookPaths: ["~/.claude/plugins/**/agenthub-hook", ...RUN_DIRS.flatMap((d) => [`${d}/hook/agenthub-hook`, `${d}/claude-plugin/hook/agenthub-hook`])],
    // The shell shows the first path as the bridge launch command: for an install — via Versions/current, so that
    // a running bridge survives a hub update.
    bridgePaths: RUN_DIRS.flatMap((d) => [`${d}/bridge/agenthub-bridge`, `${d}/bridge/agenthub-bridge.mjs`]),
    // Interpreters whose argv[1] we inspect (by file name).
    interpreters: ["node", "bun", "python3", "sh", "bash", "zsh"],
    hookAncestorDepth: 4,
  },
  // The ~/.claude directory (synthetic in tests).
  claudeHome: "~/.claude",
  // Built-in plugins. null → <repo>/plugins.
  builtinPluginsDir: null,
  plugins: {
    standardTimeoutMs: 5000,
    actionTimeoutMs: 30000,
    // Background actions (<agenthub.action background="true">): at most this many jobs per plugin at once.
    maxJobsPerPlugin: 4,
    // `plugin` SSE events of one plugin are coalesced to at most one per this interval (≤ 4/s), the latest state always
    // arrives (trailing edge); the first frame after a quiet period and the first after an action go out at once. 0 — off.
    emitMinIntervalMs: 250,
    maxOutputBytes: 1024 * 1024,
    minIntervalMs: 1000,
    // Safety rescan of plugin directories: fs.watch (FSEvents) sometimes loses events.
    rescanIntervalMs: 60_000,
  },
  journal: { maxBytes: 8 * 1024 * 1024 },
  // services.<name>.enabled = false — the service does not start. services.push.channels — extra push delivery channels
  // (lib/push/channels.mjs): [{type: "webhook"|"ntfy", url, id?, label?, events?, security?, enabled?}], none by default.
  services: {},
  // External daemon extensions <home>/Extensions/{services,routes,primitives,terminals}/*.mjs (G4, lib/extensions.mjs): loaded
  // only after a human approved the file's sha256 in the app. enabled: false — the folder is not even scanned.
  extensions: { enabled: true, rescanMs: 30_000 },
});

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

export function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export function expandHome(p, home = homedir()) {
  if (typeof p !== "string") return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function defaultHome(env = process.env) {
  return stateDir({ env });
}

// JSON that a human edits by hand (config.json, settings.json). Editors also write UTF-8 with a BOM (VS Code "UTF-8
// with BOM", PowerShell 5.1 Set-Content): the BOM is stripped. UTF-16 (BOM FF FE / FE FF) is not parsed, but we say so plainly.
export function readJsonFile(path) {
  const buf = readFileSync(path);
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) throw new Error(msg("err.json.utf16"));
  const text = buf.toString("utf8");
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

// Paths inside the state directory.
export function pathsFor(home) {
  return {
    home,
    socket: transportPath(home),
    journal: join(home, "journal.jsonl"),
    config: join(home, "config.json"),
    settings: join(home, "settings.json"),
    estop: join(home, "ESTOP"),
    plugins: join(home, "Plugins"),
    pluginsLocal: join(home, "Plugins", "local"),
    pluginsLock: join(home, "plugins.lock"),
    pluginData: join(home, "PluginData"),
    pluginCache: join(home, "Cache"),
    logs: join(home, "logs"),
  };
}

// File signature (ino, size, mtime, ctime) — whether config.json has changed (lib/app-pin.mjs).
export function fileSig(path) {
  try {
    const st = statSync(path);
    return `${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
  } catch {
    return "absent";
  }
}

// overrides — for tests (an object on top of config.json).
export function loadConfig({ env = process.env, overrides = null } = {}) {
  const home = defaultHome(env);
  const paths = pathsFor(home);
  // signature before reading: if the file changes after it, AppPinWatcher.reconcile() sees the mismatch and re-reads
  const loadedSig = fileSig(paths.config);
  let fileCfg = {};
  if (existsSync(paths.config)) {
    try {
      fileCfg = readJsonFile(paths.config);
    } catch (e) {
      throw new Error(msg("err.config.parse", { why: e.message }));
    }
  }
  let cfg = deepMerge(deepMerge(structuredClone(DEFAULTS), fileCfg), overrides || {});
  if (env.AGENTHUB_CLAUDE_HOME) cfg.claudeHome = env.AGENTHUB_CLAUDE_HOME;
  cfg.claudeHome = resolve(expandHome(cfg.claudeHome));
  cfg.builtinPluginsDir = resolve(expandHome(cfg.builtinPluginsDir || join(REPO_DIR, "plugins")));
  if (env.AGENTHUB_BUILTIN_PLUGINS) cfg.builtinPluginsDir = resolve(env.AGENTHUB_BUILTIN_PLUGINS);
  // AGENTHUB_SERVICES=none | a,b — which services to start (for tests).
  cfg.servicesFilter = env.AGENTHUB_SERVICES ?? null;
  // AGENTHUB_TEST_EXEC_LOG=<file> — primitives' external programs are not run but written to the file.
  cfg.testExecLog = env.AGENTHUB_TEST_EXEC_LOG || null;
  cfg.paths = paths;
  cfg.configLoadedSig = loadedSig;
  cfg.testMode = Boolean(env.AGENTHUB_HOME);
  cfg.testTier = testTierOf(env, home);
  cfg.testExtensions = testExtensionsOf(env, home);
  // AGENTHUB_PLUGIN_HOME=<dir> — plugins' HOME (a synthetic ~ for checks). Test mode only.
  cfg.pluginHome = cfg.testMode && env.AGENTHUB_PLUGIN_HOME ? resolve(env.AGENTHUB_PLUGIN_HOME) : null;
  cfg.systemLang = systemLangOverride(env);
  return cfg;
}

// AGENTHUB_TEST_TIER=own (G15): plugins from Plugins/local of a TEST hub get the own tier — actions, own push rules, hub
// variables — and their actions may also be pressed by cli (scripts, curl), so a plugin can be tested end to end without the
// pinned app. Honoured only when AGENTHUB_HOME points to a directory other than the live state directory: the live hub never
// has it. → "own" | null
export function testTierOf(env = process.env, home = defaultHome(env)) {
  if (env.AGENTHUB_TEST_TIER !== "own" || !env.AGENTHUB_HOME) return null;
  return isLiveStateDir(home, { env }) ? null : "own";
}

// AGENTHUB_TEST_EXTENSIONS=1 (G4): every file in <home>/Extensions counts as approved — for tests of extensions only. Honoured
// only when AGENTHUB_HOME points to a directory other than the live state directory: the live hub always asks a human.
export function testExtensionsOf(env = process.env, home = defaultHome(env)) {
  if (env.AGENTHUB_TEST_EXTENSIONS !== "1" || !env.AGENTHUB_HOME) return false;
  return !isLiveStateDir(home, { env });
}

// The "system" language (lib/settings.mjs): AGENTHUB_SYSTEM_LANG=ru|en overrides the OS language, =os — ask the OS.
// In test mode (AGENTHUB_HOME) without the variable — ru: texts in tests do not depend on the machine's language.
// → "ru" | "en" | null (ask the OS)
export function systemLangOverride(env = process.env) {
  const sl = env.AGENTHUB_SYSTEM_LANG;
  return sl === "ru" || sl === "en" ? sl : sl === "os" ? null : env.AGENTHUB_HOME ? "ru" : null;
}
