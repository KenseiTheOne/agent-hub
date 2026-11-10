// `agenthub hub …` — standalone hub installation from the terminal (docs/hub-updates.md):
//
//   hub status                         where the hub lives: current and previous versions, pointer, plist, installation
//   hub migrate [--apply] [--from <repo>] [--allow-dirty] [--no-launchd] [--under-estop]
//                                      initial move of the live hub from the working folder to Versions/<label>
//   hub rollback [--apply] [--under-estop]
//                                      emergency rollback to Versions/previous without the daemon (files + kickstart -k)
//
// migrate --apply and rollback --apply pin the app build, so, like the buttons in the shell, they work
// only from a human's terminal (stdin is a TTY; agents in Bash run without a TTY) and not while the hub is paused (ESTOP;
// an explicit --under-estop lets a human skip lifting the pause). Every pin is a hub-update-cli entry in the log (and audit).
//   hub install [--apply] [--origin <url|path>] [--no-launchd] [--yes] [--under-estop]
//                                      install from scratch (called by the installer scripts/install.sh): latest release
//                                      tag vX.Y.Z on origin main (no tags — main, label X.Y.Z-dev.<commit>), built by
//                                      the same builder as updates, pin, Versions/current, copy of the
//                                      built-ins, launchd job, start. A hub running from the working folder is moved to
//                                      Versions (like migrate); the same version already installed — repairs it (pin, plist,
//                                      start); a different one — refusal with the hint "update with the button"
//   hub install --brew [<dir>] [--apply] [--no-launchd] [--yes]   (agenthub setup = hub install --brew --apply)
//                                      install from a Homebrew formula's source tree (docs/hub-updates.md §8b): the brew
//                                      keg this CLI runs from (<prefix>/opt/agent-hub/libexec) or <dir>; the same builder,
//                                      pin, launchd job; updates then come from `brew upgrade agent-hub`, not git tags
//   uninstall [--apply] [--purge] [--no-launchd] [--yes]   (agenthub uninstall; hub uninstall is the same)
//                                      stop the daemon and the app, remove the launchd job, delete versions, the copy of
//                                      built-ins and update state; settings, log, plugins and their data —
//                                      only with --purge
//
// install --apply and uninstall --apply also run only from a human's terminal (confirm by typing "y"); --yes
// (no prompt and no TTY) only in a test directory (AGENTHUB_HOME). launchd from a test directory only with
// a launchctl double (AGENTHUB_TEST_LAUNCHCTL) and a temporary HOME: the plist goes to $HOME/Library/LaunchAgents.
//   hub build …                        internal: builds a version (run by the daemon as a separate process)
//   hub watch --home <dir>             internal: watchdog for the trial run of a new version (run by the daemon)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { readJsonFile, REPO_DIR } from "../config.mjs";
import { msg } from "../i18n.mjs";
import { Journal } from "../journal.mjs";
import { pinFingerprint, requirementSha } from "../app-pin.mjs";
import { builtinCopyDir, builtinStatus } from "../builtin-copy.mjs";
import { daemonLocation, hasLaunchd, installPlan, LABEL, launchdNode, plistXml } from "../launchd.mjs";
import { appControl, samePath } from "../platform.mjs";
import { compareVersions, isLabel, parseVersionFile } from "../version.mjs";
import { parseFileName, readPluginMeta } from "../meta.mjs";
import { buildVersion, HubUpdateError, liveCodeOf, testCodeOf, verifyApp } from "./build.mjs";
import { currentLabel, ensureDir, hubPaths, listVersions, pinnedCdhash, previousLabel, readBuild, readJson, rememberPin, rememberPrevious, versionApp, versionDir, versionPlugins } from "./layout.mjs";
import { GIT, gitEnv, hasUserinfo, listTags, redactText, redactUrl } from "./remote.mjs";
import { BREW_FORMULA, brewDirOf, brewSetting, readBrewSource, writeBrewSetting } from "./brew.mjs";
import { applySwitch, capturePrev } from "./switch.mjs";
import { readInstall, runWatch, writeInstall } from "./trial.mjs";

// Default install source (installer, hub install). The repository is public: no credentials needed, and we hold no
// tokens (a private origin uses the user's git credentials from the keychain). A different URL or a local clone — --origin.
export const DEFAULT_ORIGIN = "https://github.com/KenseiTheOne/agent-hub.git";

// Time in the build log name is local, same as the update service (updater.mjs).
const pad2 = (n) => String(n).padStart(2, "0");
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`;

// Builder steps in human terms (migration and install print them as they go), in the hub language.
const STEPS = new Set(["clone", "build", "verify", "selftest", "promote"]);
const stepText = (s) => (STEPS.has(s) ? msg(`cli.hub.step.${s}`) : s);
// Phases in which a hub update is in progress: the installer and uninstall wait for it to finish.
const BUSY_PHASES = ["building", "ready", "switching", "trial", "rolling-back"];

function git(repo, args) {
  try {
    return execFileSync(GIT, ["-C", repo, ...args], { encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function healthy(socket) {
  return healthInfo(socket).then((h) => h !== null);
}

// Daemon /health: { pid } (pid comes from a real daemon; old ones and doubles may lack it) or null — not responding.
function healthInfo(socket) {
  return new Promise((done) => {
    if (!existsSync(socket)) return done(null);
    const r = request({ socketPath: socket, path: "/health", agent: false, timeout: 1500 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (body.length < 4096) body += c;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return done(null);
        let pid = null;
        try {
          const j = JSON.parse(body);
          if (Number.isInteger(j?.pid) && j.pid > 0) pid = j.pid;
        } catch {}
        done({ pid });
      });
      res.on("error", () => done(null));
    });
    r.on("error", () => done(null));
    r.on("timeout", () => {
      r.destroy();
      done(null);
    });
    r.end();
  });
}

// GET /hub-update (allowed for cli): which version the responding daemon runs from — { installed, label } or null (not
// responding, not a hub daemon, update service disabled).
function hubUpdateInfo(socket) {
  return new Promise((done) => {
    if (!existsSync(socket)) return done(null);
    const r = request({ socketPath: socket, path: "/hub-update", agent: false, timeout: 3000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (body.length < 256 * 1024) body += c;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return done(null);
        try {
          const j = JSON.parse(body);
          done(j && typeof j === "object" ? { installed: j.installed === true, label: typeof j.label === "string" ? j.label : null } : null);
        } catch {
          done(null);
        }
      });
      res.on("error", () => done(null));
    });
    r.on("error", () => done(null));
    r.on("timeout", () => {
      r.destroy();
      done(null);
    });
    r.end();
  });
}

// launchd job: whether it is loaded and its process pid (`launchctl print`: "pid = N"; a double may print nothing).
function launchdJob() {
  const plan = installPlan();
  const r = spawnSync(plan.print[0], plan.print.slice(1), { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  if (r.error || r.status !== 0) return { loaded: false, pid: null };
  const m = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(r.stdout || "");
  return { loaded: true, pid: m ? Number(m[1]) : null };
}

// Whether the daemon of this installation answers on the socket: from Versions/<label> and the one launchd started. → null — yes, otherwise
// why not (human-readable).
async function foreignDaemon(socket, label, health) {
  const hu = await hubUpdateInfo(socket);
  if (!hu) return msg("cli.hub.foreign.noApi");
  if (!hu.installed) return msg("cli.hub.foreign.notInstalled");
  if (hu.label !== label) return msg("cli.hub.foreign.otherLabel", { running: hu.label ?? "?", label });
  const job = launchdJob();
  if (!job.loaded) return msg("cli.hub.foreign.noJob");
  if (job.pid && health?.pid && job.pid !== health.pid) return msg("cli.hub.foreign.pid", { pid: health.pid, job: job.pid });
  return null;
}

// A human's terminal: stdin is a TTY. In a test directory AGENTHUB_TEST_TTY=1 simulates it (never in the live one).
function humanTerminal(isLiveHome) {
  if (process.stdin.isTTY) return true;
  return !isLiveHome && process.env.AGENTHUB_TEST_TTY === "1";
}

// Refusals before pinning from the CLI. → exit code or null (allowed). yes — non-interactive mode of a test directory
// (--yes): in the live directory we never get here (refused earlier).
function pinGuard(name, { config, isLiveHome, has, yes = false, estop = true }) {
  if (!humanTerminal(isLiveHome) && !(yes && !isLiveHome)) {
    console.error(msg("cli.hub.guard.tty", { name }));
    return 3;
  }
  if (estop && existsSync(config.paths.estop) && !has("--under-estop")) {
    console.error(msg("cli.hub.guard.estop", { name, estop: config.paths.estop }));
    return 4;
  }
  return null;
}

function cliJournal(config, entry) {
  try {
    new Journal(config.paths.journal).write({ type: "hub-update-cli", ...entry });
  } catch {}
}

// The daemon is responding — wait until it notices the new pin itself (app-pin.json): otherwise kickstart -k may
// kill it before it records the change and sends the push. → true if it noticed.
async function waitPinSeen(config, requirement, ms = 5000) {
  if (!(await healthy(config.paths.socket))) return false;
  const want = requirementSha(requirement);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (readJson(join(config.paths.home, "app-pin.json"))?.requirementSha === want) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Origin URL from the builder's stdin: one JSON line {remote}.
async function readStdinJson(limit = 64 * 1024) {
  let data = "";
  for await (const c of process.stdin) {
    data += c;
    if (data.length > limit) break;
  }
  try {
    return JSON.parse(data.trim().split("\n")[0] || "null");
  } catch {
    return null;
  }
}

// launchctl against the live job only from the live directory; in tests — the AGENTHUB_TEST_LAUNCHCTL double.
function launchctlFor(live) {
  if (process.env.AGENTHUB_TEST_LAUNCHCTL) return process.env.AGENTHUB_TEST_LAUNCHCTL;
  return live ? "/bin/launchctl" : null;
}

// Whether install and uninstall may touch launchd from this directory. Live — yes. Test (AGENTHUB_HOME) — only
// with a launchctl double and a temporary HOME: the plist is written to $HOME/Library/LaunchAgents, and that must not be
// the user's real directory. → { ok, why? }
export function launchdAllowed(isLiveHome, env = process.env) {
  if (isLiveHome) return { ok: true };
  if (!env.AGENTHUB_TEST_LAUNCHCTL) return { ok: false, why: msg("cli.hub.ld.noDouble") };
  let real = null;
  try {
    real = userInfo().homedir;
  } catch {}
  if (!real || resolve(homedir()) === resolve(real)) return { ok: false, why: msg("cli.hub.ld.realHome") };
  return { ok: true };
}

// The node that will run the daemon: live — launchdNode() (like `agenthub install --apply`), test — this node.
// It also builds the addon and runs the new version's self-test (buildAndSwitch), so the node in the plist is the one checked.
function daemonNode(isLiveHome) {
  return isLiveHome ? launchdNode() : process.execPath;
}

// The test launchd job points to the test directory (AGENTHUB_HOME in the environment) and to this node; the live one — like
// `agenthub install --apply` (node — launchdNode(), environment — PATH only).
function plistFor(home, isLiveHome) {
  return plistXml({ stateDir: home, node: daemonNode(isLiveHome), ...(isLiveHome ? {} : { env: { AGENTHUB_HOME: home } }) });
}

// Yes/no question in the terminal. yes — answer yes right away (--yes in a test directory). End of input — no.
async function confirm(question, { yes = false } = {}) {
  if (yes) return true;
  process.stdout.write(question);
  return new Promise((done) => {
    let buf = "";
    const finish = (v) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.pause();
      done(v);
    };
    const onData = (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      finish(["y", "yes", "д", "да"].includes(buf.slice(0, nl).trim().toLowerCase()));
    };
    const onEnd = () => finish(["y", "yes", "д", "да"].includes(buf.trim().toLowerCase()));
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
  });
}

// App processes by bundle paths — SIGTERM (live directory only: there are no real apps in a test one).
async function stopApps(paths, isLiveHome) {
  if (!isLiveHome) return 0;
  const apps = appControl({ testMode: false });
  let n = 0;
  for (const app of new Set(paths.filter((p) => typeof p === "string" && p))) {
    for (const pid of (await apps.processes(app)) || []) {
      try {
        process.kill(pid, "SIGTERM");
        n++;
      } catch {}
    }
  }
  return n;
}

// Wait until the daemon on the socket stops responding (after bootout). → true — it stopped.
async function waitDown(socket, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!(await healthy(socket))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !(await healthy(socket));
}

// setup — `agenthub setup`: hub install from the Homebrew keg, --apply implied unless --plan (the "y/N" question stays).
export async function hubCli({ args, config, isLiveHome, opt, has, setup = false }) {
  const sub = args[1] && !args[1].startsWith("-") ? args[1] : "status";
  const home = config.paths.home;
  const p = hubPaths(home);
  const codeOf = isLiveHome ? liveCodeOf : testCodeOf;

  if (sub === "status") {
    const cur = currentLabel(home);
    const prev = previousLabel(home);
    const loc = daemonLocation(home);
    console.log(msg("cli.hub.home", { home, test: !isLiveHome }));
    if (!cur) {
      console.log(msg("cli.hub.status.noInstall"));
    } else {
      const b = readBuild(home, cur);
      console.log(msg("cli.hub.status.current", { label: cur, tag: b?.tag, commit: b?.commit?.slice(0, 7), builtAt: b?.builtAt }));
      console.log(msg("cli.hub.status.previous", { label: prev ?? "—" }));
      console.log(msg("cli.hub.status.versions", { list: listVersions(home).join(", ") || "—" }));
    }
    console.log(msg("cli.hub.status.daemon", { path: loc.daemon }));
    const target = installPlan().target;
    if (existsSync(target) && isLiveHome) {
      const t = readFileSync(target, "utf8");
      console.log(msg("cli.hub.status.plist", { ok: t.includes(join(p.current, "src")) }));
    }
    const st = readInstall(home);
    if (st) console.log(msg("cli.hub.status.install", { phase: st.phase, op: st.op, label: st.label ?? "", error: st.error, log: st.log }));
    const ch = readJson(p.check);
    const brew = brewSetting(readJson(config.paths.config));
    if (brew) {
      const s = readBrewSource(brew);
      console.log(msg("cli.hub.status.brew", { dir: brew, version: s.ok ? s.version : null, why: s.ok ? null : s.why, formula: BREW_FORMULA }));
    } else if (ch?.latest) console.log(msg("cli.hub.status.latest", { tag: ch.latest.tag, at: ch.checkedAt ?? "?" }));
    return 0;
  }

  if (sub === "build") {
    // internal: the daemon runs it as a separate process; one JSON line in stdout is the result
    const label = opt("--label");
    const version = opt("--version");
    const outHome = opt("--home");
    if (!outHome || resolve(outHome) !== resolve(home) || !isLabel(label) || !version) {
      process.stdout.write(JSON.stringify({ ok: false, code: "hub-update:bad-args" }) + "\n");
      return 64;
    }
    // origin URL comes from stdin (in argv anyone sees it via ps); --remote is kept for manual runs. A Homebrew source
    // (--brew <dir>) is a local path, not a secret: no origin at all
    const brew = opt("--brew");
    const remote = brew ? null : has("--remote-stdin") ? (await readStdinJson())?.remote : opt("--remote");
    try {
      const build = await buildVersion({
        home,
        label,
        version,
        source: brew ? { kind: "brew", dir: brew, commit: opt("--commit") || null } : { kind: "tag", remote, tag: opt("--tag"), commit: opt("--commit") || null, branch: opt("--branch") || "main" },
        origin: remote || null,
        logPath: opt("--log") || null,
        codeOf,
        requireNative: isLiveHome,
        // each step is a separate JSON line: the daemon shows build progress (the result is the last line, as before)
        onStep: (step) => process.stdout.write(JSON.stringify({ step }) + "\n"),
      });
      process.stdout.write(JSON.stringify({ ok: true, build }) + "\n");
      return 0;
    } catch (e) {
      process.stdout.write(JSON.stringify({ ok: false, code: e.code || "hub-update:build-failed", detail: e.detail || e.message }) + "\n");
      return 1;
    }
  }

  if (sub === "watch") {
    const lc = launchctlFor(isLiveHome);
    const uid = process.getuid();
    const apps = appControl({ testMode: !isLiveHome, test: config.services?.app?.test });
    const log = (s) => process.stderr.write(`[hub watch ${new Date().toISOString()}] ${s}\n`);
    const r = await runWatch({
      home,
      health: () => healthy(config.paths.socket),
      restart: async (kind) => {
        if (!lc) return log(msg("cli.hub.watch.noDouble", { kind }));
        const argv = kind === "restart" ? ["kickstart", "-k", `gui/${uid}/${LABEL}`] : ["kickstart", `gui/${uid}/${LABEL}`];
        try {
          execFileSync(lc, argv, { stdio: "ignore" });
        } catch (e) {
          log(`launchctl ${argv.join(" ")}: ${e.status ?? e.message}`);
        }
      },
      killApp: async (app) => {
        if (!isLiveHome) return;
        for (const pid of (await apps.processes(app)) || []) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        }
      },
      log,
    });
    log(msg("cli.hub.watch.result", { result: r.result }));
    return 0;
  }

  if (sub === "migrate") return migrate({ args, config, isLiveHome, opt, has, home, codeOf });
  if (sub === "rollback") return emergencyRollback({ config, isLiveHome, has, home, codeOf });
  if (sub === "install") return install({ config, isLiveHome, opt, has, home, codeOf, setup });
  if (sub === "uninstall") return uninstallCli({ config, isLiveHome, has, home });

  console.error(msg("cli.hub.usage"));
  return 64;
}

// Building a version and switching to it — the shared path of migration and install: buildVersion (the same builder as
// the button update) → pin, Versions/current (previous — the old one), copy of built-ins from the version; pin
// history, install.json, hub-update-cli entry. → { code, build?, prev?, logPath? }
async function buildAndSwitch({ config, home, label, version, source, origin, codeOf, isLiveHome, cur, op, by, name }) {
  const logPath = join(hubPaths(home).logs, `hub-update-${label}-${stamp()}.log`);
  console.log(msg("cli.hub.building", { log: logPath }));
  let build;
  try {
    build = await buildVersion({ home, label, version, source, origin, logPath, codeOf, requireNative: isLiveHome, node: daemonNode(isLiveHome), onStep: (s) => console.log(`  ${stepText(s)}`) });
  } catch (e) {
    console.error(msg("cli.hub.buildFailed", { name, code: e instanceof HubUpdateError ? e.code : msg("cli.hub.error"), detail: e.detail, log: logPath }));
    return { code: 1 };
  }
  const prev = capturePrev(home, config.paths.config);
  const under = process.stdin.isTTY ? "terminal" : "no-tty";
  try {
    applySwitch({ home, label, build, prev, configPath: config.paths.config, by, under });
  } catch (e) {
    console.error(msg("cli.hub.restored", { name, why: e.message }));
    return { code: 1 };
  }
  const commit = build.commit ?? source.commit ?? null;
  const now = new Date().toISOString();
  ensureDir(hubPaths(home).dir);
  rememberPin(home, label, { cdhash: build.cdhash, commit, op });
  rememberPrevious(home, prev);
  writeInstall(home, { phase: "done", op, label, version, tag: source.tag ?? null, commit, from: cur, startedAt: now, finishedAt: now, log: logPath });
  cliJournal(config, { op, label, from: cur, old: pinFingerprint(prev.requirement).label, new: pinFingerprint(build.requirement).label, under, estop: existsSync(config.paths.estop) });
  console.log(msg("cli.hub.installed", { label, cdhash: build.cdhash }));
  return { code: 0, build, prev, logPath };
}

// Initial migration (docs/hub-updates.md §8).
async function migrate({ config, isLiveHome, opt, has, home, codeOf }) {
  const from = resolve(opt("--from") || REPO_DIR);
  const apply = has("--apply");
  const launchd = !has("--no-launchd");
  const head = git(from, ["rev-parse", "HEAD"]);
  if (!head || !/^[0-9a-f]{40}$/.test(head)) {
    console.error(msg("cli.hub.mig.noRepo", { from }));
    return 1;
  }
  const version = parseVersionFile(existsSync(join(from, "VERSION")) ? readFileSync(join(from, "VERSION"), "utf8") : "");
  if (!version) {
    console.error(msg("cli.hub.mig.noVersion", { from }));
    return 1;
  }
  const dirty = Boolean(git(from, ["status", "--porcelain", "--untracked-files=normal"]));
  const tags = (git(from, ["tag", "--points-at", "HEAD"]) || "").split("\n").filter(Boolean);
  const tag = tags.find((t) => t === `v${version}`) || null;
  const short = head.slice(0, 7);
  if (dirty && !has("--allow-dirty")) {
    console.error(msg("cli.hub.mig.dirty", { from }));
    return 1;
  }
  const label = dirty ? `${version}-dev.${short}.dirty` : tag ? version : `${version}-dev.${short}`;
  const source = dirty ? { kind: "dir", repo: from, commit: head } : { kind: "commit", repo: from, commit: head, tag };
  const origin = git(from, ["remote", "get-url", "origin"]) || null;
  // a token in the URL would end up in build.json, the log and build logs — let git pick up credentials itself
  if (origin && hasUserinfo(origin)) {
    console.error(msg("cli.hub.mig.credentials", { url: redactUrl(origin) }));
    return 1;
  }
  const cur = currentLabel(home);
  console.log(msg("cli.hub.mig.source", { from, short, tag, dirty }));
  console.log(msg("cli.hub.mig.version", { label, dir: join(hubPaths(home).versions, label) }));
  console.log(msg("cli.hub.mig.origin", { origin }));
  if (cur) console.log(msg("cli.hub.mig.now", { cur, same: cur === label }));
  const testShell = launchd && !isLiveHome;
  if (testShell) {
    console.error(msg("cli.hub.mig.testHome", { home }));
    if (apply) return 2;
  }
  if (!apply) {
    console.log(msg("cli.hub.mig.planHead"));
    console.log(msg("cli.hub.mig.planBuild"));
    console.log(msg("cli.hub.mig.planPin"));
    if (launchd && !testShell) console.log(msg("cli.hub.mig.planPlist"));
    return 0;
  }
  if (cur === label) {
    console.error(msg("cli.hub.mig.isCurrent", { label }));
    return 1;
  }
  const denied = pinGuard("migrate", { config, isLiveHome, has });
  if (denied !== null) return denied;
  const r = await buildAndSwitch({ config, home, label, version, source, origin, codeOf, isLiveHome, cur, op: "migrate", by: "agenthub hub migrate", name: "migrate" });
  if (r.code) return r.code;
  if (!launchd) return 0;
  const lc = await reinstallLaunchd(home, { isLiveHome, repoTemplate: true });
  if (lc === 0) console.log(msg("cli.hub.mig.done", { label: LABEL }));
  return lc;
}

// plist via Versions/current and job restart (like agenthub install --apply): bootout, wait for the old
// daemon to exit, oldApps — apps of the previous installation (supervision won't restart them: there is no daemon) get SIGTERM,
// bootstrap, wait for /health. repoTemplate — also the launchd/ template in the repository (agenthub install does this;
// the installer, which runs from a temporary clone, doesn't need it). → exit code.
async function reinstallLaunchd(home, { isLiveHome, repoTemplate = false, oldApps = [] } = {}) {
  const plan = installPlan();
  const xml = plistFor(home, isLiveHome);
  if (repoTemplate) {
    mkdirSync(dirname(plan.repoPlist), { recursive: true });
    writeFileSync(plan.repoPlist, xml);
  }
  // launchd does not create the directory for StandardOutPath/StandardErrorPath — without it the job won't start (78)
  ensureDir(home);
  ensureDir(join(home, "logs"));
  mkdirSync(dirname(plan.target), { recursive: true });
  writeFileSync(plan.target, xml);
  try {
    execFileSync(plan.bootout[0], plan.bootout.slice(1), { stdio: "ignore" });
  } catch {}
  const sock = join(home, "hub.sock");
  // the old daemon exits normally (SIGTERM); while it responds, "the daemon came up" could be confused with it. If it didn't exit (not started
  // via launchd or hung) — we skip bootstrap: the new daemon would see a live socket and exit with code 1, launchd
  // would restart it every 10 s, and /health would be answered by the old one — "Done" would be a lie.
  const before = await healthInfo(sock);
  if (!(await waitDown(sock, parseInt(process.env.AGENTHUB_INSTALL_DOWN_MS || "", 10) || 10_000))) {
    console.error(msg("cli.hub.ld.oldAlive", { socket: sock, pid: before?.pid }));
    return 1;
  }
  const killed = await stopApps(oldApps, isLiveHome);
  if (killed) console.log(msg("cli.hub.ld.appsClosed", { n: killed }));
  try {
    execFileSync(plan.bootstrap[0], plan.bootstrap.slice(1), { stdio: "inherit" });
  } catch (e) {
    console.error(msg("cli.hub.ld.bootstrapFailed", { cmd: plan.bootstrap.join(" "), why: e.status ?? e.message, print: plan.print.join(" ") }));
    return 1;
  }
  const until = Date.now() + (parseInt(process.env.AGENTHUB_INSTALL_WAIT_MS || "", 10) || 15_000);
  while (Date.now() < until) {
    const h = await healthInfo(sock);
    // the same process as before bootout is responding — this is not a new daemon
    if (h && !(before?.pid && h.pid === before.pid)) return 0;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(msg("cli.hub.ld.noAnswer", { label: LABEL, socket: sock, print: plan.print.join(" "), logs: join(home, "logs", "agenthubd.err.log") }));
  return 1;
}

// Emergency rollback without the daemon: Versions/current → previous (files), new app processes, kickstart -k.
// Only a build that the hub itself installed for this label is pinned (history.json), and only if the bundle on disk
// is that build (cdhash) and matches build.json.
async function emergencyRollback({ config, isLiveHome, has, home, codeOf }) {
  const cur = currentLabel(home);
  const prev = previousLabel(home);
  const b = prev ? readBuild(home, prev) : null;
  if (!cur || !prev || !b) {
    console.error(msg("cli.hub.rb.noPrev"));
    return 1;
  }
  console.log(msg("cli.hub.rb.plan", { cur, prev, newer: compareVersions(prev, cur) > 0 }));
  if (!has("--apply")) {
    console.log(msg("cli.hub.rb.planApply", { prev, cur }));
    return 0;
  }
  const denied = pinGuard("rollback", { config, isLiveHome, has });
  if (denied !== null) return denied;
  const known = pinnedCdhash(home, prev);
  let code;
  try {
    code = await verifyApp(versionApp(home, prev), codeOf);
  } catch (e) {
    console.error(msg("cli.hub.rb.verifyFailed", { prev, why: e.detail || e.message }));
    return 1;
  }
  if (code.cdhash !== b.cdhash || (known && code.cdhash !== known)) {
    console.error(msg("cli.hub.rb.notPinned", { app: versionApp(home, prev), cdhash: code.cdhash.slice(0, 12), known: Boolean(known), prev, expect: (known || b.cdhash || "?").slice(0, 12) }));
    return 1;
  }
  if (!known) console.log(msg("cli.hub.rb.noHistory", { prev }));
  const build = { ...b, cdhash: code.cdhash, requirement: code.requirement };
  const snap = capturePrev(home, config.paths.config);
  try {
    applySwitch({ home, label: prev, build, prev: snap, configPath: config.paths.config, by: "agenthub hub rollback", under: process.stdin.isTTY ? "terminal" : "no-tty" });
  } catch (e) {
    console.error(msg("cli.hub.restored", { name: "rollback", why: e.message }));
    return 1;
  }
  ensureDir(hubPaths(home).dir);
  rememberPin(home, prev, { cdhash: code.cdhash, commit: b.commit ?? null, op: "rollback" });
  rememberPrevious(home, snap);
  writeInstall(home, { phase: "done", op: "rollback", label: prev, version: b.version, from: cur, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  cliJournal(config, { op: "rollback", label: prev, from: cur, old: pinFingerprint(snap.requirement).label, new: pinFingerprint(build.requirement).label, under: process.stdin.isTTY ? "terminal" : "no-tty", estop: existsSync(config.paths.estop) });
  // the live daemon must get the chance to record the pin change itself (log, push) — before kickstart -k
  const seen = await waitPinSeen(config, build.requirement);
  if (!seen) console.log(msg("cli.hub.rb.notSeen"));
  // the app of the version we're leaving: otherwise two icons would end up next to the old one
  if (isLiveHome) {
    const apps = appControl({ testMode: false });
    for (const pid of (await apps.processes(versionApp(home, cur))) || []) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  const lc = launchctlFor(isLiveHome);
  if (lc) {
    try {
      execFileSync(lc, ["kickstart", "-k", `gui/${process.getuid()}/${LABEL}`], { stdio: "inherit" });
    } catch {}
  }
  console.log(msg("cli.hub.rb.done", { prev, restarted: Boolean(lc) }));
  return 0;
}

// ---------- install from scratch (installer scripts/install.sh, docs/hub-updates.md §8a) ----------

// Origin URL: a URL (https://, ssh://, file://) or scp form (git@host:path) — as is; otherwise it's a path to a local
// repository — made absolute.
function normalizeOrigin(origin) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin) || /^[^/\s]+@[^/\s:]+:/.test(origin)) return origin;
  return resolve(origin.replace(/^~(?=\/|$)/, homedir()));
}

function gitSync(args, { timeoutMs = 60_000 } = {}) {
  const r = spawnSync(GIT, args, { encoding: "utf8", env: gitEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { code: r.status ?? -1, out: String(r.stdout || "").trim(), err: redactText(String(r.stderr || "").trim().split("\n").pop() || ""), timedOut: r.error?.code === "ETIMEDOUT" };
}

// What to install: the latest release tag vX.Y.Z (no pre-release — like the update check) whose commit is in
// the history of origin's release branch; if none — the branch itself (label X.Y.Z-dev.<commit7>, X.Y.Z from its VERSION).
// mirror — an empty directory ($TMPDIR): a bare mirror of the branch goes there (used to check "tag is on main"; for a branch — also
// the build source). → { kind: "tag"|"branch", label, version, commit, tag?, skipped: [tags not on the branch] }
export async function resolveInstallTarget({ remote, mirror, branch = "main", list = listTags }) {
  const init = gitSync(["init", "--quiet", "--bare", mirror]);
  if (init.code !== 0) throw new HubUpdateError("hub-update:clone-failed", "git init");
  const f = gitSync(["-C", mirror, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `+refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 5 * 60_000 });
  if (f.code !== 0) throw new HubUpdateError("hub-update:clone-failed", f.timedOut ? "timeout" : `git fetch ${branch}: ${f.err || f.code}`);
  const head = gitSync(["-C", mirror, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).out;
  if (!/^[0-9a-f]{40}$/.test(head)) throw new HubUpdateError("hub-update:clone-failed", `no branch ${branch}`);
  const tags = (await list({ remote })).filter((t) => !t.version.includes("-") && /^[0-9a-f]{40}$/.test(t.commit));
  tags.sort((a, b) => -(compareVersions(a.version, b.version) ?? 0));
  const skipped = [];
  for (const t of tags) {
    // the tag's commit is not on the branch — its object is missing from the mirror or it's not an ancestor: we don't install such a tag (same as the builder)
    if (gitSync(["-C", mirror, "merge-base", "--is-ancestor", t.commit, `refs/heads/${branch}`]).code === 0) {
      return { kind: "tag", tag: t.tag, version: t.version, label: t.version, commit: t.commit, skipped };
    }
    skipped.push(t.tag);
  }
  const v = gitSync(["-C", mirror, "show", `refs/heads/${branch}:VERSION`]);
  const version = v.code === 0 ? parseVersionFile(v.out) : null;
  if (!version) throw new HubUpdateError("hub-update:version-mismatch", `no VERSION file in ${branch}`);
  return { kind: "branch", branch, version, label: `${version}-dev.${head.slice(0, 7)}`, commit: head, skipped };
}

// How the installed build's commit relates to the target by branch history (mirror): "newer" — the target is newer
// (the installed commit is its ancestor), "older" — the installed one is newer, "diverged" — unrelated or no commit.
export function historyRelation(mirror, installed, target) {
  if (!/^[0-9a-f]{40}$/.test(installed || "") || !/^[0-9a-f]{40}$/.test(target || "")) return "diverged";
  if (installed === target) return "same";
  if (gitSync(["-C", mirror, "merge-base", "--is-ancestor", installed, target]).code === 0) return "newer";
  if (gitSync(["-C", mirror, "merge-base", "--is-ancestor", target, installed]).code === 0) return "older";
  return "diverged";
}

// Where the hub currently runs from, if not from Versions: the plist in LaunchAgents (daemon path) and config.json.
function workdirInstall(config, plistText) {
  const m = plistText ? /<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/.exec(plistText) : null;
  return { daemon: m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : null, config: existsSync(config.paths.config) };
}

function hookHint(home) {
  const plugin = join(hubPaths(home).current, "src", "claude-plugin");
  console.log(msg("cli.hub.hook", { plugin }));
}

async function launchApp(config, home, label, isLiveHome) {
  const apps = appControl({ testMode: !isLiveHome, test: config.services?.app?.test });
  const r = await apps.launch(versionApp(home, label));
  if (r.ok) console.log(msg("cli.hub.app.launched", { app: versionApp(home, label) }));
  else if (r.skipped === "test-mode") console.log(msg("cli.hub.app.test"));
  else console.log(msg("cli.hub.app.failed", { why: r.code ?? r.skipped, app: versionApp(home, label) }));
}

// Command Line Tools for building from a Homebrew tree (the installer script checks the same before running us;
// `agenthub setup` has no script in front of it). → [missing: human-readable lines]
export function buildToolProblems({ run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim(), minSdk = 26 } = {}) {
  const missing = [];
  const ok = (cmd, args) => {
    try {
      return run(cmd, args);
    } catch {
      return null;
    }
  };
  if (ok("xcode-select", ["-p"]) === null) return [msg("cli.hub.brew.noClt")];
  if (!ok("xcrun", ["--find", "swift"])) missing.push(msg("cli.hub.brew.noSwift"));
  if (!ok("xcrun", ["--find", "clang"])) missing.push(msg("cli.hub.brew.noClang"));
  const sdk = ok("xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
  const major = Number.parseInt(String(sdk || "0"), 10);
  if (!(major >= minSdk)) missing.push(msg("cli.hub.brew.oldSdk", { sdk: sdk || "?", min: minSdk }));
  return missing;
}

// Where `hub install --brew` takes the tree: --brew <dir>, otherwise the brew keg this CLI runs from (via the stable opt link).
function brewSourceDir(opt, has, setup) {
  const v = opt("--brew");
  if (v && !v.startsWith("-")) return { dir: resolve(v.replace(/^~(?=\/|$)/, homedir())), explicit: true };
  if (!setup && !has("--brew")) return null;
  return { dir: brewDirOf(REPO_DIR), explicit: false };
}

async function install({ config, isLiveHome, opt, has, home, codeOf, setup = false }) {
  // setup applies by default (the "y/N" question stays); --plan only shows the plan
  const apply = setup ? !has("--plan") : has("--apply");
  const yes = has("--yes");
  const launchd = !has("--no-launchd");
  const branch = "main";
  if (yes && isLiveHome) {
    console.error(msg("cli.hub.inst.yesLive"));
    return 2;
  }
  const brewSrc = brewSourceDir(opt, has, setup);
  if (brewSrc && opt("--origin")) {
    console.error(msg("cli.hub.brew.withOrigin"));
    return 64;
  }
  let brew = null;
  if (brewSrc) {
    if (!brewSrc.dir) {
      console.error(msg("cli.hub.brew.notBrew", { repo: REPO_DIR }));
      return 2;
    }
    brew = readBrewSource(brewSrc.dir);
    if (!brew.ok) {
      console.error(msg("cli.hub.brew.badDir", { dir: brewSrc.dir, why: brew.why }));
      return 1;
    }
  }
  const raw = brew ? null : opt("--origin") || DEFAULT_ORIGIN;
  if (raw?.startsWith("-")) {
    console.error(msg("cli.hub.inst.originUsage"));
    return 64;
  }
  if (raw && hasUserinfo(raw)) {
    console.error(msg("cli.hub.inst.credentials", { url: redactUrl(raw) }));
    return 2;
  }
  const origin = raw ? normalizeOrigin(raw) : null;
  const ld = launchd ? launchdAllowed(isLiveHome) : { ok: true };
  if (!ld.ok) {
    console.error(msg("cli.hub.inst.testHome", { home, why: ld.why }));
    if (apply) return 2;
  }
  const cur = currentLabel(home);
  const plan = installPlan();
  const plistNow = existsSync(plan.target) ? readFileSync(plan.target, "utf8") : null;
  console.log(msg("cli.hub.inst.home", { home, test: !isLiveHome }));
  if (brew) console.log(msg("cli.hub.brew.source", { dir: brew.dir }));
  else console.log(msg("cli.hub.inst.origin", { origin: redactUrl(origin) }));

  // temporary bare mirror of main — in the private $TMPDIR (0700), not in the hub directory: the plan creates nothing there.
  // A Homebrew tree needs none: it is a local directory with VERSION.
  const mirror = brew ? null : mkdtempSync(join(tmpdir(), "agenthub-install-"));
  try {
    let target;
    if (brew) {
      target = { kind: "brew", label: brew.version, version: brew.version, commit: brew.commit, dir: brew.dir, skipped: [] };
      console.log(msg("cli.hub.brew.version", { label: target.label, commit: target.commit?.slice(0, 7) ?? null }));
    } else {
      try {
        target = await resolveInstallTarget({ remote: origin, mirror, branch });
      } catch (e) {
        console.error(msg("cli.hub.inst.fetchFailed", { origin: redactUrl(origin), code: e.code || msg("cli.hub.error"), detail: e.detail }));
        return 1;
      }
      if (target.skipped.length) console.log(msg("cli.hub.inst.skipped", { branch, list: target.skipped.join(", ") }));
      console.log(msg("cli.hub.inst.version", { label: target.label, tag: target.kind === "tag" ? target.tag : null, branch, commit: target.commit.slice(0, 7) }));
    }
    // where updates will come from: the brew tree, or git tags (a git install switches a brew-managed hub back)
    const brewDir = brew ? brew.dir : null;

    if (cur) {
      console.log(msg("cli.hub.inst.installed", { cur }));
      if (cur === target.label) return await repair({ config, isLiveHome, has, home, codeOf, label: cur, apply, yes, launchd, brewDir });
      // a branch without tags and the installed build is also a branch build (X.Y.Z-dev.<commit>): hashes can't be compared as strings — use history
      if (target.kind === "branch" && /-dev\./.test(cur)) {
        const rel = historyRelation(mirror, readBuild(home, cur)?.commit, target.commit);
        if (rel === "newer") {
          console.error(msg("cli.hub.inst.branchNewer", { cur, branch, label: target.label, version: target.version }));
        } else {
          console.error(msg("cli.hub.inst.branchOther", { cur, older: rel === "older", branch, label: target.label }));
        }
        return 5;
      }
      const c = compareVersions(target.label, cur);
      if (c !== null && c > 0 && brew) {
        // brew has a newer version than the installed hub: it goes in with the Update button (trial run, rollback) — the hub
        // only has to know that its versions now come from brew
        if (!apply) {
          console.log(msg("cli.hub.brew.followPlan", { cur, label: target.label }));
          console.log(msg("cli.hub.nothingDone"));
          return 0;
        }
        const changed = writeBrewSetting(config.paths.config, brewDir);
        if (changed) cliJournal(config, { op: "brew-source", label: cur, brew: brewDir });
        console.log(msg("cli.hub.brew.follow", { cur, label: target.label, changed }));
        return 0;
      }
      if (c !== null && c > 0) {
        console.error(msg("cli.hub.inst.useUpdate", { cur, label: target.label }));
      } else {
        console.error(msg("cli.hub.inst.otherBuild", { cur, newer: c !== null && c < 0, label: target.label }));
      }
      return 5;
    }

    const wd = workdirInstall(config, plistNow);
    const oldApp = typeof config.appPin?.path === "string" ? config.appPin.path : null;
    if (wd.daemon || wd.config) {
      console.log(msg("cli.hub.inst.nowWorkdir", { daemon: wd.daemon }));
    } else {
      console.log(msg("cli.hub.inst.nowNone"));
    }
    if (brew) {
      const missing = buildToolProblems();
      if (missing.length) {
        console.error(msg("cli.hub.brew.missing", { list: missing.map((m) => `  - ${m}`).join("\n") }));
        return 3;
      }
    }
    console.log(msg("cli.hub.planHead"));
    console.log(brew ? msg("cli.hub.brew.plan1", { label: target.label, dir: join(hubPaths(home).versions, target.label), from: brew.dir }) : msg("cli.hub.inst.plan1", { label: target.label, dir: join(hubPaths(home).versions, target.label) }));
    console.log(msg("cli.hub.inst.plan2"));
    if (launchd) {
      console.log(msg("cli.hub.inst.plan3", { target: plan.target, oldApp }));
      console.log(msg("cli.hub.inst.plan4"));
    }
    console.log(brew ? msg("cli.hub.brew.planAfter", { formula: BREW_FORMULA }) : msg("cli.hub.inst.planAfter"));
    if (!apply) {
      console.log(setup ? msg("cli.hub.brew.planOnly") : msg("cli.hub.nothingDone"));
      return 0;
    }
    const denied = pinGuard("install", { config, isLiveHome, has, yes });
    if (denied !== null) return denied;
    if (!(await confirm(msg("cli.hub.inst.ask"), { yes }))) {
      console.log(msg("cli.hub.cancelled"));
      return 1;
    }
    const source = brew
      ? { kind: "brew", dir: brew.dir, commit: brew.commit, tag: null }
      : target.kind === "tag"
        ? { kind: "tag", remote: origin, tag: target.tag, commit: target.commit, branch }
        : { kind: "commit", repo: mirror, commit: target.commit, tag: null };
    const r = await buildAndSwitch({ config, home, label: target.label, version: target.version, source, origin, codeOf, isLiveHome, cur: null, op: "setup", by: "agenthub hub install", name: "install" });
    if (r.code) return r.code;
    // after the switch (it rewrites config.json): the update source — brew or git tags
    try {
      if (writeBrewSetting(config.paths.config, brewDir)) cliJournal(config, { op: "brew-source", label: target.label, brew: brewDir });
    } catch (e) {
      console.error(msg("cli.hub.brew.settingFailed", { why: e.code || e.message }));
    }
    if (launchd) {
      const lc = await reinstallLaunchd(home, { isLiveHome, oldApps: [r.prev?.appPin?.path].filter((p) => p && p !== versionApp(home, target.label)) });
      if (lc !== 0) {
        console.error(msg("cli.hub.inst.daemonDown"));
        return lc;
      }
      console.log(msg("cli.hub.runs", { label: LABEL }));
      await launchApp(config, home, target.label, isLiveHome);
    }
    finishText(home, target.label, origin, launchd, brewDir);
    return 0;
  } finally {
    if (mirror) rmSync(mirror, { recursive: true, force: true });
  }
}

function finishText(home, label, origin, launchd, brewDir = null) {
  const cli = join(hubPaths(home).current, "src", "daemon", "bin", "agenthub");
  console.log(msg("cli.hub.done.title", { label, dir: versionDir(home, label), launchd }));
  if (brewDir) {
    console.log(msg("cli.hub.brew.done.updates", { formula: BREW_FORMULA }));
    console.log(msg("cli.hub.brew.done.cli"));
    console.log(msg("cli.hub.brew.done.uninstall", { formula: BREW_FORMULA }));
  } else {
    console.log(msg("cli.hub.done.updates", { origin: redactUrl(origin) }));
    console.log(msg("cli.hub.done.cli", { cli }));
    console.log(msg("cli.hub.done.uninstall", { cli }));
  }
  hookHint(home);
}

// The same version is already installed: verify and finish — build pin and copy of built-ins, launchd job, start.
// No rebuild (we never rebuild the current version).
// brewDir — where updates must come from after this run: the Homebrew tree (`agenthub setup`) or null (git tags, the installer).
async function repair({ config, isLiveHome, has, home, codeOf, label, apply, yes, launchd, brewDir = null }) {
  const st = readInstall(home);
  if (st && BUSY_PHASES.includes(st.phase)) {
    console.error(msg("cli.hub.rep.busy", { phase: st.phase, label: st.label }));
    return 5;
  }
  const b = readBuild(home, label);
  let code;
  try {
    if (!b) throw new Error("no build.json");
    code = await verifyApp(versionApp(home, label), codeOf);
  } catch (e) {
    console.error(msg("cli.hub.rep.verifyFailed", { label, why: e.detail || e.message }));
    return 1;
  }
  const known = pinnedCdhash(home, label);
  if (code.cdhash !== b.cdhash || (known && code.cdhash !== known)) {
    console.error(msg("cli.hub.rep.notPinned", { app: versionApp(home, label), cdhash: code.cdhash.slice(0, 12), expect: (known || b.cdhash || "?").slice(0, 12) }));
    return 1;
  }
  const pinOk = config.requirements?.app === code.requirement && config.appPin?.path === versionApp(home, label);
  const bst = builtinStatus({ src: versionPlugins(home, label), home });
  const builtinOk = bst.exists && !(bst.added.length + bst.updated.length + bst.removed.length) && config.builtinPluginsDir === builtinCopyDir(home);
  const plan = installPlan();
  const plistOk = !launchd || (existsSync(plan.target) && readFileSync(plan.target, "utf8") === plistFor(home, isLiveHome));
  const health = launchd ? await healthInfo(config.paths.socket) : null;
  // responding doesn't mean "ours": an old daemon started by hand (or from the working folder) also responds
  const foreign = launchd && health ? await foreignDaemon(config.paths.socket, label, health) : null;
  const up = !launchd || (health !== null && !foreign);
  const brewNow = brewSetting(readJson(config.paths.config));
  const sourceOk = brewNow === brewDir;
  console.log(msg("cli.hub.rep.pin", { ok: pinOk }));
  console.log(msg("cli.hub.rep.builtin", { ok: builtinOk }));
  console.log(msg("cli.hub.rep.source", { ok: sourceOk, brew: brewDir, was: brewNow }));
  if (launchd) {
    console.log(msg("cli.hub.rep.launchd", { ok: plistOk }));
    console.log(msg("cli.hub.rep.daemon", { up, foreign, pid: health?.pid }));
  }
  if (pinOk && builtinOk && plistOk && up && sourceOk) {
    console.log(msg("cli.hub.rep.fine", { label, brew: Boolean(brewDir), formula: BREW_FORMULA }));
    return 0;
  }
  if (!apply) {
    console.log(msg("cli.hub.rep.planHead"));
    return 0;
  }
  const denied = pinGuard("install", { config, isLiveHome, has, yes });
  if (denied !== null) return denied;
  if (!(await confirm(msg("cli.hub.rep.ask", { label }), { yes }))) {
    console.log(msg("cli.hub.cancelled"));
    return 1;
  }
  let oldApp = null;
  if (!pinOk || !builtinOk) {
    const prev = capturePrev(home, config.paths.config);
    oldApp = prev.appPin?.path ?? null;
    try {
      applySwitch({ home, label, build: { ...b, cdhash: code.cdhash, requirement: code.requirement }, prev, configPath: config.paths.config, by: "agenthub hub install", under: process.stdin.isTTY ? "terminal" : "no-tty" });
    } catch (e) {
      console.error(msg("cli.hub.restored", { name: "install", why: e.message }));
      return 1;
    }
    rememberPin(home, label, { cdhash: code.cdhash, commit: b.commit ?? null, op: "setup" });
    cliJournal(config, { op: "setup-repair", label, old: pinFingerprint(prev.requirement).label, new: pinFingerprint(code.requirement).label, under: process.stdin.isTTY ? "terminal" : "no-tty", estop: existsSync(config.paths.estop) });
    console.log([!pinOk && msg("cli.hub.rep.pinned", { label, cdhash: code.cdhash.slice(0, 12) }), !builtinOk && msg("cli.hub.rep.builtinUpdated")].filter(Boolean).join("; "));
  }
  if (!sourceOk) {
    // where versions come from: the daemon reads this setting fresh, no restart needed
    try {
      writeBrewSetting(config.paths.config, brewDir);
      cliJournal(config, { op: "brew-source", label, brew: brewDir });
      console.log(msg("cli.hub.rep.sourceSet", { brew: brewDir }));
    } catch (e) {
      console.error(msg("cli.hub.brew.settingFailed", { why: e.code || e.message }));
      return 1;
    }
  }
  const staleApp = oldApp && oldApp !== versionApp(home, label) ? oldApp : null;
  if (launchd && (!plistOk || !up)) {
    const lc = await reinstallLaunchd(home, { isLiveHome, oldApps: [staleApp].filter(Boolean) });
    if (lc !== 0) return lc;
    console.log(msg("cli.hub.runs", { label: LABEL }));
  } else if (staleApp) {
    // the daemon is alive, the job isn't restarted: close the old copy here (its pin is removed, to the daemon it's now cli),
    // otherwise there are two icons in the menu bar
    const killed = await stopApps([staleApp], isLiveHome);
    console.log(msg("cli.hub.rep.staleApp", { app: staleApp, killed, live: isLiveHome }));
  }
  if (launchd) await launchApp(config, home, label, isLiveHome);
  finishText(home, label, readBuild(home, label)?.origin || DEFAULT_ORIGIN, launchd, brewDir);
  return 0;
}

// ---------- uninstall (agenthub uninstall) ----------

// What the hub itself puts in its directory (top level). --purge deletes the whole directory only if it contains
// nothing else: a typo in `--home ~/Projects` must not wipe the projects folder.
const HUB_TOP = new Set(["config.json", "settings.json", "journal.jsonl", "journal.jsonl.1", "journal-audit.jsonl", "journal-audit.jsonl.1", "app-pin.json", "verified-code.json", "push-state.json", "plugins.lock", "hub.sock", "ESTOP", "Versions", "HubUpdate", "Builtin", "Plugins", "PluginData", "Cache", "Registry", "logs", "launch", ".DS_Store"]);
// Signs of a hub directory: at least one of these.
const HUB_SIGNS = ["config.json", "journal.jsonl", "Versions", "HubUpdate"];

// The directory may be deleted entirely (--purge): not home, not its ancestor, not root; has a hub sign, and everything at the top
// level is a hub entry (or their temporary copies *.tmp-<pid>). → { ok, why? }
export function purgeable(home, isLiveHome) {
  const h = resolve(home);
  if (h === resolve(homedir()) || h === sep || h.split(sep).filter(Boolean).length < 2) return { ok: false, why: msg("cli.hub.purge.home") };
  if (!isLiveHome && resolve(homedir()).startsWith(h + sep)) return { ok: false, why: msg("cli.hub.purge.hasHome") };
  let names;
  try {
    names = readdirSync(h);
  } catch (e) {
    return e?.code === "ENOENT" ? { ok: true } : { ok: false, why: e.message };
  }
  if (!HUB_SIGNS.some((n) => names.includes(n))) return { ok: false, why: msg("cli.hub.purge.noSigns", { list: HUB_SIGNS.join(", ") }) };
  const foreign = names.filter((n) => !HUB_TOP.has(n) && !/^[^/]+\.tmp-\d+$/.test(n));
  if (foreign.length) return { ok: false, why: msg("cli.hub.purge.foreign", { list: foreign.slice(0, 5).join(", "), more: foreign.length > 5 ? foreign.length - 5 : 0 }) };
  return { ok: true };
}

// Keychain services the hub and its plugins may have created: Telegram (push service), connection logins
// (agent-hub.oauth, if a plugin has <agenthub.connection>) and `agent-hub.<service>` from the plugins' <agenthub.secrets> in
// <home>/Plugins. → ["agent-hub.telegram", …]
export function keychainServices(home) {
  // telegram (push bot) and oauth (connection logins, lib/services/secrets.mjs STORE_SERVICE) are the core's own services:
  // a connection login outlives plugin removal, so oauth is always listed
  const out = new Set(["agent-hub.telegram", "agent-hub.oauth"]);
  const dir = join(home, "Plugins");
  let ids = [];
  try {
    ids = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch {}
  for (const id of ids.slice(0, 200)) {
    let files = [];
    try {
      files = readdirSync(join(dir, id)).filter((f) => parseFileName(f)?.id === id);
    } catch {}
    for (const f of files.slice(0, 4)) {
      try {
        const m = readPluginMeta(join(dir, id, f))?.meta;
        if (!m) continue;
        for (const e of m.secrets || []) {
          const key = String(e).split(/\s+[—–-]{1,2}\s+/)[0].trim();
          const svc = key.split(".")[0];
          if (/^[a-z][\w-]{0,63}$/.test(svc)) out.add(`agent-hub.${svc}`);
        }
      } catch {}
    }
  }
  return [...out];
}

export async function uninstallCli({ config, isLiveHome, has, home }) {
  const apply = has("--apply");
  const yes = has("--yes");
  const purge = has("--purge");
  const launchd = !has("--no-launchd");
  if (launchd && !hasLaunchd()) {
    // on Linux and Windows there is no job: nothing to remove, and installPlan/launchctl don't work there
    console.error(msg("cli.un.noLaunchd"));
    return 2;
  }
  if (!launchd && isLiveHome && process.platform === "darwin") {
    // the job would stay loaded with a plist pointing at the deleted Versions/current: launchd won't start the daemon until the plist
    // is deleted by hand. By platform, not hasLaunchd(): the test AGENTHUB_TEST_NO_LAUNCHD doesn't lift this guard
    console.error(msg("cli.un.noLaunchdLive"));
    return 2;
  }
  if (yes && isLiveHome) {
    console.error(msg("cli.un.yesLive"));
    return 2;
  }
  const ld = launchd ? launchdAllowed(isLiveHome) : { ok: true };
  if (!ld.ok) {
    console.error(msg("cli.un.testHome", { home, why: ld.why }));
    if (apply) return 2;
  }
  const p = hubPaths(home);
  const plan = installPlan();
  const versions = listVersions(home);
  const appPaths = [...new Set([...versions.map((l) => versionApp(home, l)), typeof config.appPin?.path === "string" ? config.appPin.path : null].filter(Boolean))];
  const copy = builtinCopyDir(home);
  // installed with Homebrew (setup recorded the source, or this CLI runs from the keg): the formula is removed separately —
  // brew does not know about the hub's directory and launchd job, so `agenthub uninstall` goes first
  const brew = brewSetting(readJson(p.config)) || brewDirOf(REPO_DIR);
  console.log(msg("cli.hub.inst.home", { home, test: !isLiveHome }));
  console.log(msg("cli.un.versions", { list: versions.join(", ") }));
  console.log(msg("cli.hub.planHead"));
  if (launchd && ld.ok) {
    console.log(msg("cli.un.planStop", { bootout: plan.bootout.join(" "), target: plan.target }));
  }
  if (appPaths.length) console.log(msg("cli.un.planApps", { list: appPaths.join(", ") }));
  if (purge) {
    console.log(msg("cli.un.planPurge", { home }));
  } else {
    console.log(msg("cli.un.planDelete", { list: `${p.versions}, ${p.dir}, ${copy}` }));
    console.log(msg("cli.un.planKeep"));
  }
  if (brew) console.log(msg("cli.un.planBrew", { formula: BREW_FORMULA }));
  if (!apply) {
    console.log(msg("cli.un.nothing"));
    return 0;
  }
  const pg = purge ? purgeable(home, isLiveHome) : { ok: true };
  if (!pg.ok) {
    console.error(msg("cli.un.notHub", { home, why: pg.why }));
    return 2;
  }
  const st = readInstall(home);
  if (st && BUSY_PHASES.includes(st.phase) && !has("--force")) {
    console.error(msg("cli.un.busy", { phase: st.phase, label: st.label }));
    return 5;
  }
  const denied = pinGuard("uninstall", { config, isLiveHome, has, yes, estop: false });
  if (denied !== null) return denied;
  if (!(await confirm(msg("cli.un.ask"), { yes }))) {
    console.log(msg("cli.un.cancelled"));
    return 1;
  }
  // 1. daemon: bootout — SIGTERM, normal shutdown; KeepAlive won't restart it anymore
  if (launchd) {
    try {
      execFileSync(plan.bootout[0], plan.bootout.slice(1), { stdio: "ignore" });
    } catch {}
    rmSync(plan.target, { force: true });
    console.log(msg("cli.un.jobRemoved", { label: LABEL }));
  }
  if (!(await waitDown(config.paths.socket, parseInt(process.env.AGENTHUB_INSTALL_DOWN_MS || "", 10) || 10_000))) {
    const h = await healthInfo(config.paths.socket);
    const who = h?.pid ? ` (pid ${h.pid})` : "";
    if (!has("--force")) {
      // deleting Versions, Builtin and the socket under a live daemon leaves a ghost: the CLI and the app won't connect to it, its
      // plugins run from the deleted copy, and the next install would start a second daemon alongside
      console.error(msg("cli.un.alive", { socket: config.paths.socket, who, launchd, pid: h?.pid }));
      return 1;
    }
    console.log(msg("cli.un.forced", { socket: config.paths.socket, who }));
  }
  // 2. app: the daemon is gone — supervision won't restart it; the app won't start the daemon either (there's no job)
  const killed = await stopApps(appPaths, isLiveHome);
  if (killed) console.log(msg("cli.un.appClosed", { n: killed }));
  // keychain entries come from the installed plugins' declarations (<agenthub.secrets>): collect before deleting files (with --purge
  // the Plugins/ directory is gone after that)
  const services = keychainServices(home);
  // 3. files
  if (purge) {
    rmSync(home, { recursive: true, force: true });
    console.log(msg("cli.un.deletedHome", { home }));
  } else {
    for (const d of [p.versions, p.dir, copy]) rmSync(d, { recursive: true, force: true });
    try {
      for (const n of readdirSync(p.logs)) if (n.startsWith("hub-update-")) rmSync(join(p.logs, n), { force: true });
    } catch {}
    // we don't touch the socket of a responding daemon (--force): without it the CLI and the app can no longer reach the daemon
    if (!(await healthy(config.paths.socket))) rmSync(config.paths.socket, { force: true });
    // the hub no longer follows the Homebrew tree: a later install from git must not inherit the brew source
    try {
      writeBrewSetting(p.config, null);
    } catch {}
    // the copy of built-ins is gone — config.json must not point to it (the rest of it is the human's settings)
    try {
      const cfg = readJsonFile(p.config);
      if (cfg.builtinPluginsDir && samePath(cfg.builtinPluginsDir, copy)) {
        delete cfg.builtinPluginsDir;
        const tmp = `${p.config}.tmp-${process.pid}`;
        writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
        renameSync(tmp, p.config);
      }
    } catch {}
    cliJournal(config, { op: "uninstall", labels: versions, under: process.stdin.isTTY ? "terminal" : "no-tty" });
    console.log(msg("cli.un.deleted", { list: versions.join(", ") || "—" }));
    console.log(msg("cli.un.remaining", { home }));
  }
  console.log("");
  // the core doesn't know plugin service names — only from their declarations; plus a general hint on finding all hub entries
  console.log(msg("cli.un.keychain", { cmds: services.map((x) => `security delete-generic-password -s ${x}`).join("; ") }));
  console.log(msg("cli.un.keychainAll"));
  console.log(msg("cli.un.hook"));
  console.log(msg("cli.un.hookSafe"));
  if (brew) console.log(msg("cli.un.brew", { formula: BREW_FORMULA }));
  return 0;
}
