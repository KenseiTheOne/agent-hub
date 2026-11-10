// Builds a hub version into <home>/Versions/<label> (docs/hub-updates.md §3, step 2). Runs in a separate process
// (`agenthub hub build`, launched by the daemon) or directly in the CLI (migration). Doesn't touch the live hub: everything goes into
// Versions/.staging-…, and the finished result moves into Versions/<label> with a single rename.
//
//   1. sources: a tag from origin — git init + git fetch of exactly refs/tags/<tag> and the release branches (main), without
//      clone --branch (it would take a same-named branch); the tag's commit is checked against ls-remote; the tag's commit must be
//      in the history of origin/main (otherwise hub-update:not-on-main — a tag on an unreviewed branch); the origin URL isn't
//      kept in the clone. Or a local repository commit (migration without a tag), or the working tree files
//      as is (migration --allow-dirty), or the release tree of a Homebrew formula (source kind "brew", §8b);
//   2. VERSION in the sources = the expected version (for tag vX.Y.Z — X.Y.Z);
//   3. src/scripts/build-release.sh --out <staging> — the build script from THESE sources (the new version knows how
//      to build itself): the peercred addon and AgentHub.app (bundle.sh --no-pin, ad hoc signature);
//   4. verification: bundle, signature (codesign --verify --strict, identifier com.kensei.agenthub, cdhash);
//   5. self-test of the new daemon: `node src/daemon/bin/agenthubd --self-test` in a temporary directory — loads all
//      core modules, brings up the socket, /health; the version in the reply = the expected one;
//   6. build.json, src/app/.build is deleted (hundreds of MB), rename into Versions/<label>.
// An error at any step is HubUpdateError(code); staging is deleted.

import { spawn } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_BUNDLE_ID, cdhashRequirement } from "../app-pin.mjs";
import { killProcessTree, standardPath } from "../platform.mjs";
import { msg } from "../i18n.mjs";
import { isLabel, parseVersionFile } from "../version.mjs";
import { ensureDir, freeBytes, hubPaths, promoteStaging, stagingDir, writeJsonAtomic } from "./layout.mjs";
import { GIT, gitEnv, parseTagNotes, redactText, redactUrl } from "./remote.mjs";
import { brewCopyFilter, readBrewSource } from "./brew.mjs";

export class HubUpdateError extends Error {
  constructor(code, detail = "") {
    super(`${code}${detail ? `: ${detail}` : ""}`);
    this.code = code;
    this.detail = String(detail || "").slice(0, 300);
  }
}

const MIN = 60_000;
// minFreeBytes — how much space is needed on the Versions volume before starting (sources + swift .build — hundreds of MB).
export const BUILD_DEFAULTS = Object.freeze({ cloneTimeoutMs: 5 * MIN, buildTimeoutMs: 30 * MIN, selfTestTimeoutMs: MIN, minFreeBytes: 1024 ** 3, branch: "main" });

// Build log: every line goes to a file (0600), steps as headings.
export function openLog(path) {
  if (!path) return { path: null, write: () => {}, fd: null, close: () => {} };
  ensureDir(dirname(path));
  const fd = openSync(path, "a", 0o600);
  return {
    path,
    fd,
    write: (s) => {
      try {
        writeSync(fd, String(s).endsWith("\n") ? String(s) : `${s}\n`);
      } catch {}
    },
    close: () => {
      try {
        closeSync(fd);
      } catch {}
    },
  };
}

// An external command without a shell; stdout/stderr go to the log. → Promise<{code, out, timedOut}> (out — stdout, ≤ 1 MB).
// A timeout kills the process together with its descendants (killProcessTree: git-remote-https under git fetch, swift-build and
// swift-frontend under build-release.sh), not just the direct child. The result is by process exit: the 'close' event
// is awaited no longer than closeGraceMs — a grandchild that inherited stdout/stderr doesn't hold the build after exit or timeout.
export function runLogged(argv, { cwd, env, log, timeoutMs = 10 * MIN, closeGraceMs = 2000, killTree = killProcessTree } = {}) {
  return new Promise((resolve) => {
    log?.write(redactText(`$ ${argv.map((a) => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`));
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      log?.write(msg("hub.log.notStarted", { why: e.message }));
      return resolve({ code: -1, out: "", timedOut: false });
    }
    let out = "";
    let timedOut = false;
    let done = false;
    let grace = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      clearTimeout(grace);
      // a grandchild with inherited streams: don't wait for it, close our ends
      try {
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {}
      log?.write(msg("hub.log.exit", { code, timedOut }));
      resolve({ code: typeof code === "number" && !timedOut ? code : -1, out, timedOut });
    };
    const t = setTimeout(() => {
      timedOut = true;
      try {
        killTree(child.pid, "SIGKILL");
      } catch {}
      // the process may not die (D state) — the result still comes via closeGraceMs
      grace = setTimeout(() => finish(-1), closeGraceMs);
    }, timeoutMs);
    child.stdout.on("data", (c) => {
      if (out.length < 1024 * 1024) out += c;
      log?.write(redactText(String(c).replace(/\n$/, "")));
    });
    child.stderr.on("data", (c) => log?.write(redactText(String(c).replace(/\n$/, ""))));
    child.on("error", (e) => {
      log?.write(msg("hub.log.error", { why: e.message }));
      // the process didn't start (ENOENT, EAGAIN): 'close' may never come
      if (!child.pid) finish(-1);
    });
    child.on("exit", (code) => {
      clearTimeout(grace);
      grace = setTimeout(() => finish(code), closeGraceMs);
    });
    child.on("close", (code) => finish(code));
  });
}

// Build environment: standard PATH, no NODE_OPTIONS (the cmux preload crashes child node processes), no AGENTHUB_HOME.
// node is the one that will run the daemon (launchdNode() for the installer and migration; for the update service — the daemon's own node).
export function buildEnv(base = process.env, node = process.execPath) {
  const e = gitEnv(base);
  e.PATH = standardPath();
  delete e.AGENTHUB_HOME;
  // build-native.sh builds the addon for the node that will run the daemon (headers are next to it)
  e.NODE = node;
  return e;
}

// Working tree files (tracked and non-ignored new ones) — for migration with --allow-dirty.
async function copyWorkTree(repo, dest, log) {
  const r = await runLogged([GIT, "-C", repo, "ls-files", "-co", "--exclude-standard", "-z"], { env: gitEnv(), log: null, timeoutMs: MIN });
  if (r.code !== 0) throw new HubUpdateError("hub-update:clone-failed", "git ls-files");
  let n = 0;
  for (const rel of r.out.split("\0").filter(Boolean)) {
    if (rel.startsWith("/") || rel.split("/").includes("..")) continue;
    const src = join(repo, rel);
    let st;
    try {
      st = lstatSync(src);
    } catch {
      continue; // deleted in the working tree
    }
    if (!st.isFile()) continue;
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    copyFileSync(src, to);
    chmodSync(to, st.mode & 0o777);
    n++;
  }
  log?.write(msg("hub.log.copied", { n }));
}

const HEX40 = /^[0-9a-f]{40}$/;

async function gitOut(argv, { env, log, timeoutMs = MIN }) {
  const r = await runLogged([GIT, ...argv], { env, log, timeoutMs });
  return { ...r, text: r.out.trim() };
}

// A tag from origin: only refs/tags/<tag> and the release branch. → { head, tagInfo }
async function fetchTag(source, src, log, t, env) {
  if (typeof source.remote !== "string" || !source.remote || source.remote.startsWith("-")) throw new HubUpdateError("hub-update:not-configured", "origin");
  if (typeof source.tag !== "string" || !/^v[0-9A-Za-z.+-]{1,80}$/.test(source.tag)) throw new HubUpdateError("hub-update:bad-source", msg("hub.detail.tag"));
  const want = source.branch ?? t.branch;
  const branch = typeof want === "string" && /^[A-Za-z0-9._/-]{1,100}$/.test(want) && !want.startsWith("-") ? want : "main";
  mkdirSync(src, { recursive: true, mode: 0o700 });
  const init = await gitOut(["init", "--quiet", src], { env, log });
  if (init.code !== 0) throw new HubUpdateError("hub-update:clone-failed", "git init");
  // a same-named branch in origin doesn't get in the way (we take refs/tags/), but it's worth knowing about
  const heads = await gitOut(["-C", src, "ls-remote", "--heads", source.remote, source.tag], { env, log, timeoutMs: t.cloneTimeoutMs });
  if (heads.code === 0 && heads.text) log?.write(msg("hub.log.branchNamedTag", { tag: source.tag }));
  const f = await gitOut(["-C", src, "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", source.remote, `+refs/tags/${source.tag}:refs/tags/${source.tag}`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env, log, timeoutMs: t.cloneTimeoutMs });
  if (f.code !== 0) throw new HubUpdateError("hub-update:clone-failed", f.timedOut ? "timeout" : `git fetch → ${f.code}`);
  const c = await gitOut(["-C", src, "rev-parse", "--verify", "--quiet", `refs/tags/${source.tag}^{commit}`], { env, log });
  const commit = c.text;
  if (c.code !== 0 || !HEX40.test(commit)) throw new HubUpdateError("hub-update:clone-failed", msg("hub.detail.revParseTag"));
  // the tag was rewritten between the check and the build — we'd install something other than what the human saw in "Available …"
  if (source.commit && commit !== source.commit) throw new HubUpdateError("hub-update:commit-mismatch", `${commit.slice(0, 12)} ≠ ${source.commit.slice(0, 12)}`);
  // provenance: the tag's commit is in the history of origin's release branch (a tag on an agent's unpushed branch isn't installed)
  const anc = await gitOut(["-C", src, "merge-base", "--is-ancestor", commit, `refs/remotes/origin/${branch}`], { env, log });
  if (anc.code === 1) throw new HubUpdateError("hub-update:not-on-main", msg("hub.detail.notOnBranch", { commit: commit.slice(0, 12), branch }));
  if (anc.code !== 0) throw new HubUpdateError("hub-update:clone-failed", `merge-base → ${anc.code}`);
  const co = await gitOut(["-C", src, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], { env, log, timeoutMs: t.cloneTimeoutMs });
  if (co.code !== 0) throw new HubUpdateError("hub-update:clone-failed", `git checkout → ${co.code}`);
  // info for the human: the commit subject and who created the tag (a lightweight tag has none)
  const subj = await gitOut(["-C", src, "log", "-1", "--format=%s", commit], { env, log: null });
  const tagger = await gitOut(["-C", src, "for-each-ref", "--format=%(objecttype) %(taggername) %(taggeremail)", `refs/tags/${source.tag}`], { env, log: null });
  const [kind, ...who] = tagger.text.split(" ");
  // release notes are the annotated tag's message (the same as the check showed): into build.json → Settings
  const tagMsg = kind === "tag" ? await gitOut(["-C", src, "for-each-ref", "--format=%(objecttype)%00%(contents:subject)%00%(contents:body)", `refs/tags/${source.tag}`], { env, log: null }) : null;
  const notes = tagMsg && tagMsg.code === 0 ? parseTagNotes(tagMsg.out) : null;
  const tagInfo = { subject: subj.text.slice(0, 200) || null, annotated: kind === "tag", tagger: kind === "tag" ? who.join(" ").slice(0, 120) || null : null, branch, notes };
  log?.write(msg("hub.log.tag", { tag: source.tag, commit, annotated: tagInfo.annotated, tagger: tagInfo.tagger ?? "?", branch, subject: tagInfo.subject ?? "" }));
  return { head: commit, tagInfo };
}

async function fetchSource(source, src, log, t) {
  const env = gitEnv();
  if (source.kind === "tag") return fetchTag(source, src, log, t, env);
  if (source.kind === "commit") {
    const r = await runLogged([GIT, "clone", "--quiet", "--no-checkout", source.repo, src], { env, log, timeoutMs: t.cloneTimeoutMs });
    if (r.code !== 0) throw new HubUpdateError("hub-update:clone-failed", `git clone → ${r.code}`);
    const c = await runLogged([GIT, "-C", src, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", source.commit], { env, log, timeoutMs: t.cloneTimeoutMs });
    if (c.code !== 0) throw new HubUpdateError("hub-update:clone-failed", `git checkout → ${c.code}`);
    const h = await runLogged([GIT, "-C", src, "rev-parse", "HEAD"], { env, log, timeoutMs: MIN });
    const head = h.out.trim();
    if (h.code !== 0 || !HEX40.test(head)) throw new HubUpdateError("hub-update:clone-failed", "rev-parse");
    if (source.commit && head !== source.commit) throw new HubUpdateError("hub-update:commit-mismatch", `${head.slice(0, 12)} ≠ ${source.commit.slice(0, 12)}`);
    // migration from a commit with tag vX.Y.Z: release notes are that tag's message (lightweight — no notes)
    if (typeof source.tag === "string" && /^v[0-9A-Za-z.+-]{1,80}$/.test(source.tag)) {
      const tagMsg = await gitOut(["-C", src, "for-each-ref", "--format=%(objecttype)%00%(contents:subject)%00%(contents:body)", `refs/tags/${source.tag}`], { env, log: null });
      const notes = tagMsg.code === 0 ? parseTagNotes(tagMsg.out) : null;
      return { head, tagInfo: notes ? { subject: null, annotated: true, tagger: null, branch: null, notes } : null };
    }
    return { head, tagInfo: null };
  }
  if (source.kind === "dir") {
    mkdirSync(src, { recursive: true, mode: 0o700 });
    await copyWorkTree(source.repo, src, log);
    return { head: source.commit || null, tagInfo: null };
  }
  if (source.kind === "brew") return copyBrewTree(source, src, log);
  throw new HubUpdateError("hub-update:bad-source", String(source.kind));
}

// The release tree a Homebrew formula put into <prefix>/opt/agent-hub/libexec (docs/hub-updates.md §8b): copied as is
// (no git, no network), without VCS data and old build products. The commit is the formula's COMMIT file, if any; the one
// the check saw (source.commit) must match it — otherwise brew changed the tree between the check and the build.
async function copyBrewTree(source, src, log) {
  const s = readBrewSource(source.dir);
  if (!s.ok) throw new HubUpdateError("hub-update:brew-missing", `${source.dir}: ${s.why}`);
  if (source.commit && s.commit !== source.commit) throw new HubUpdateError("hub-update:commit-mismatch", `${String(s.commit).slice(0, 12)} ≠ ${source.commit.slice(0, 12)}`);
  mkdirSync(dirname(src), { recursive: true, mode: 0o700 });
  try {
    // the real keg directory: the opt link changes on `brew upgrade`, the copy must come from one version
    const from = realpathSync(s.dir);
    cpSync(from, src, { recursive: true, filter: brewCopyFilter(from), verbatimSymlinks: true, errorOnExist: true, force: false });
  } catch (e) {
    throw new HubUpdateError("hub-update:clone-failed", `copy ${s.dir}: ${e.code || e.message}`);
  }
  // the keg may be read-only (0444/0555): the build writes into these sources (the peercred addon, swift .build)
  makeOwnerWritable(src);
  log?.write(msg("hub.log.brewCopied", { dir: s.dir, version: s.version, commit: s.commit ?? "—" }));
  return { head: s.commit, tagInfo: null };
}

function makeOwnerWritable(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    try {
      const mode = statSync(p).mode & 0o777;
      if ((mode & 0o200) === 0) chmodSync(p, mode | 0o200);
    } catch {}
    if (e.isDirectory()) makeOwnerWritable(p);
  }
}


// Bundle signature code: live — codesign (lib/app-sign.mjs, async: the daemon's event loop isn't blocked),
// test directory — a double (Contents/TEST-CDHASH).
export async function liveCodeOf(app) {
  const { readBundleCodeAsync } = await import("../app-sign.mjs");
  return readBundleCodeAsync(app);
}
export function testCodeOf(app) {
  const h = readFileSync(join(app, "Contents", "TEST-CDHASH"), "utf8").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error("TEST-CDHASH: 40 hex required");
  return { identifier: APP_BUNDLE_ID, cdhash: h, adhoc: true };
}

// Verify the built bundle. → { cdhash, requirement, identifier }
export async function verifyApp(app, codeOf) {
  const exe = join(app, "Contents", "MacOS", "AgentHub");
  let st;
  try {
    st = statSync(exe);
  } catch {
    throw new HubUpdateError("hub-update:verify-failed", msg("hub.detail.noExecutable"));
  }
  if (!st.isFile() || (st.mode & 0o111) === 0) throw new HubUpdateError("hub-update:verify-failed", msg("hub.detail.executable"));
  let code;
  try {
    code = await codeOf(app);
  } catch (e) {
    throw new HubUpdateError("hub-update:verify-failed", e.message);
  }
  if (code?.identifier !== APP_BUNDLE_ID || !/^[0-9a-f]{40}$/.test(code?.cdhash || "")) throw new HubUpdateError("hub-update:verify-failed", `identifier ${code?.identifier}`);
  return { cdhash: code.cdhash, requirement: cdhashRequirement(code.cdhash), identifier: code.identifier };
}

// Self-test of the new daemon in a temporary directory (short path: socket ≤ 103 bytes).
export async function selfTest(src, { version, requireNative, log, timeoutMs, node = process.execPath }) {
  const home = mkdtempSync(join(tmpdir(), "ah-st-"));
  try {
    const env = buildEnv(process.env, node);
    env.AGENTHUB_HOME = home;
    env.AGENTHUB_SERVICES = "none";
    const r = await runLogged([node, join(src, "daemon", "bin", "agenthubd"), "--self-test"], { cwd: src, env, log, timeoutMs });
    const line = r.out.trim().split("\n").filter(Boolean).pop() || "";
    let j = null;
    try {
      j = JSON.parse(line);
    } catch {}
    if (r.code !== 0 || !j?.ok) throw new HubUpdateError("hub-update:selftest-failed", j?.error || msg("hub.detail.code", { code: r.code, timedOut: r.timedOut }));
    if (j.version !== version) throw new HubUpdateError("hub-update:version-mismatch", msg("hub.detail.daemonVersion", { got: j.version, want: version }));
    if (requireNative && j.native !== true) throw new HubUpdateError("hub-update:selftest-failed", msg("hub.detail.noNative"));
    return j;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Main entry. opts: { home, label, version, source: {kind: tag|commit|dir, …}, origin, logPath, codeOf, requireNative,
// timeouts, onStep(step) }. → build.json (what was written). It's rebuilt every time: a ready directory
// Versions/<label> (anyone with the same UID could have put it there) isn't reused.
export async function buildVersion(opts) {
  const { home, label, version, source } = opts;
  if (!isLabel(label)) throw new HubUpdateError("hub-update:bad-label", label);
  const t = { ...BUILD_DEFAULTS, ...(opts.timeouts || {}) };
  const step = (s) => {
    try {
      opts.onStep?.(s);
    } catch {}
  };
  const log = openLog(opts.logPath);
  const free = freeBytes(ensureDir(hubPaths(home).versions));
  if (free !== null && Number.isFinite(t.minFreeBytes) && free < t.minFreeBytes) {
    const err = new HubUpdateError("hub-update:no-space", msg("hub.detail.noSpace", { free: Math.round(free / 1024 ** 2), need: Math.round(t.minFreeBytes / 1024 ** 2) }));
    log.write(msg("hub.log.failed", { code: err.code, detail: `${err.detail} (${hubPaths(home).versions})` }));
    log.close();
    throw err;
  }
  const staging = stagingDir(home, label);
  const src = join(staging, "src");
  try {
    log.write(msg("hub.log.start", { label, at: new Date().toISOString(), dir: staging }));
    step("clone");
    const { head: commit, tagInfo } = await fetchSource(source, src, log, t);
    const v = parseVersionFile(existsSync(join(src, "VERSION")) ? readFileSync(join(src, "VERSION"), "utf8") : "");
    if (v !== version) throw new HubUpdateError("hub-update:version-mismatch", msg("hub.detail.versionFile", { got: v, want: version }));
    step("build");
    const script = join(src, "scripts", "build-release.sh");
    if (!existsSync(script)) throw new HubUpdateError("hub-update:build-failed", msg("hub.detail.noBuildScript"));
    const node = opts.node || process.execPath;
    log.write(`node: ${node}`);
    const b = await runLogged(["/bin/bash", script, "--out", staging], { cwd: src, env: buildEnv(process.env, node), log, timeoutMs: t.buildTimeoutMs });
    if (b.timedOut) throw new HubUpdateError("hub-update:build-timeout", msg("hub.detail.minutes", { n: Math.round(t.buildTimeoutMs / MIN) }));
    if (b.code !== 0) throw new HubUpdateError("hub-update:build-failed", `build-release.sh → ${b.code}`);
    step("verify");
    const app = join(staging, "AgentHub.app");
    const code = await verifyApp(app, opts.codeOf);
    step("selftest");
    const st = await selfTest(src, { version, requireNative: Boolean(opts.requireNative), log, timeoutMs: t.selfTestTimeoutMs, node });
    // swift build intermediate files are hundreds of megabytes; the bundle has already been copied
    rmSync(join(src, "app", ".build"), { recursive: true, force: true });
    const build = {
      ok: true,
      label,
      version,
      tag: source.tag || null,
      commit,
      dirty: source.kind === "dir",
      origin: opts.origin ? redactUrl(opts.origin) : null,
      // built from a Homebrew tree: where it came from (the update source is config.json → services.hubUpdate.brew)
      ...(source.kind === "brew" ? { brew: source.dir } : {}),
      tagInfo: tagInfo ?? null,
      builtAt: new Date().toISOString(),
      cdhash: code.cdhash,
      requirement: code.requirement,
      selfTest: { native: st.native ?? null, version: st.version },
      log: log.path,
    };
    writeJsonAtomic(join(staging, "build.json"), build);
    step("promote");
    promoteStaging(home, staging, label);
    log.write(msg("hub.log.done", { label, cdhash: code.cdhash }));
    return build;
  } catch (e) {
    const err = e instanceof HubUpdateError ? e : new HubUpdateError(e?.code && String(e.code).startsWith("hub-update:") ? e.code : "hub-update:build-failed", e?.message || String(e));
    log.write(msg("hub.log.failed", { code: err.code, detail: err.detail }));
    rmSync(staging, { recursive: true, force: true });
    throw err;
  } finally {
    log.close();
  }
}
