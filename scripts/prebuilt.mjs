#!/usr/bin/env node
// Prebuilt AgentHub.app from the GitHub release of a tag: CI builds it, the hub downloads it instead of compiling swift.
//
//   node scripts/prebuilt.mjs fetch --out <dir>
//       Called by build-release.sh. Downloads AgentHub-<version>.{json,zip} from the release of the tag of these
//       sources and puts a verified <dir>/AgentHub.app. Exit 0 — done; exit 3 — no usable prebuilt app (the reason is
//       printed), build-release.sh then builds locally as before. AGENTHUB_PREBUILT=0 skips the download;
//       AGENTHUB_PREBUILT_BASE=<url> takes the files from another place (tests).
//   node scripts/prebuilt.mjs manifest --app <AgentHub.app> --zip <zip> --out <dir>
//       CI only: writes the manifest AgentHub-<version>.json next to the zip.
//
// Trust: the files come over HTTPS from the release of this repository, and the release is published immutable
// (draft → upload → publish with release immutability on): its assets cannot be swapped later. There is no signing
// key on purpose — its public half would live in this same repository, so anyone able to change the releases could
// replace the key as well. The manifest names the version, the commit, the zip's sha256 and the app's cdhash; the
// version and the commit must be exactly those of these sources (the tag the hub has already checked: on main,
// VERSION), the zip and the app must match the hashes. Anything else — exit 3 and a local build.
//
// Backward compatibility: every hub builds a new version by running the NEW tag's scripts/build-release.sh, so hubs
// released before this script also get the prebuilt app — nothing on their side needs to change.
//
// Self-contained (node:* only) — it runs under whatever node the installed hub uses.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASES = "https://github.com/KenseiTheOne/agent-hub/releases/download";
export const MAX_ZIP = 300 * 1024 * 1024;
const FORMAT = 1;

export const assetNames = (version) => ({
  zip: `AgentHub-${version}.zip`,
  manifest: `AgentHub-${version}.json`,
});

export class NoPrebuilt extends Error {}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// identifier and cdhash of a signed bundle; codesign -dvvv writes them to stderr even on success
function codesignInfo(app) {
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], { stdio: "pipe" });
  const r = execFileSync("/bin/sh", ["-c", '/usr/bin/codesign -dvvv "$1" 2>&1', "sh", app], { encoding: "utf8" });
  const get = (k) => (r.match(new RegExp(`^${k}=(.+)$`, "m")) || [])[1]?.trim();
  return { identifier: get("Identifier"), cdhash: get("CDHash") };
}

export const defaultCodeOf = (app) => {
  try {
    return codesignInfo(app);
  } catch (e) {
    throw new NoPrebuilt(`codesign: ${String(e.stderr || e.message).trim().split("\n").pop()}`);
  }
};

async function download(url, { fetchImpl, timeoutMs, max }) {
  let res;
  try {
    res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new NoPrebuilt(`download ${url}: ${e.name === "TimeoutError" ? "timeout" : e.message}`);
  }
  if (res.status === 404) throw new NoPrebuilt(`no release asset ${url}`);
  if (!res.ok) throw new NoPrebuilt(`download ${url}: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > max) throw new NoPrebuilt(`download ${url}: ${len} bytes is too large`);
  let buf;
  try {
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    throw new NoPrebuilt(`download ${url}: ${e.name === "TimeoutError" ? "timeout" : e.message}`);
  }
  if (buf.length > max) throw new NoPrebuilt(`download ${url}: too large`);
  return buf;
}

function headCommit(root) {
  try {
    return execFileSync("/usr/bin/git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// Download, verify and put <out>/AgentHub.app. Throws NoPrebuilt when there is nothing usable (a local build follows).
// opts (tests): arch, root, version, commit, base, fetchImpl, codeOf, log
export async function fetchPrebuilt(out, opts = {}) {
  const root = opts.root ?? ROOT;
  // CI builds for arm64 only (the runner's architecture); an Intel Mac builds its own app, as before
  if ((opts.arch ?? process.arch) !== "arm64") throw new NoPrebuilt(`the prebuilt app is arm64, this Mac is ${opts.arch ?? process.arch}`);
  const log = opts.log ?? ((s) => console.log(s));
  const version = opts.version ?? readFileSync(join(root, "VERSION"), "utf8").trim();
  const commit = opts.commit ?? headCommit(root);
  if (!commit) throw new NoPrebuilt("the sources are not a git checkout — no commit to match");
  const base = (opts.base ?? process.env.AGENTHUB_PREBUILT_BASE ?? `${RELEASES}/v${version}`).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const codeOf = opts.codeOf ?? defaultCodeOf;
  const names = assetNames(version);

  log(`==> prebuilt app: ${base}/${names.zip}`);
  const manifestBuf = await download(`${base}/${names.manifest}`, { fetchImpl, timeoutMs: 30_000, max: 64 * 1024 });
  let m;
  try {
    m = JSON.parse(manifestBuf.toString("utf8"));
  } catch {
    throw new NoPrebuilt("manifest is not JSON");
  }
  if (m.format !== FORMAT) throw new NoPrebuilt(`manifest format ${m.format}`);
  if (m.version !== version) throw new NoPrebuilt(`manifest version ${m.version}, sources ${version}`);
  if (m.commit !== commit) throw new NoPrebuilt(`manifest commit ${m.commit}, sources ${commit}`);
  if (!/^[0-9a-f]{64}$/.test(m.sha256 || "") || !/^[0-9a-f]{40}$/.test(m.cdhash || "")) throw new NoPrebuilt("manifest without sha256/cdhash");

  const zip = await download(`${base}/${names.zip}`, { fetchImpl, timeoutMs: 10 * 60_000, max: MAX_ZIP });
  if (sha256(zip) !== m.sha256) throw new NoPrebuilt("zip sha256 does not match the manifest");

  mkdirSync(out, { recursive: true });
  const tmp = mkdtempSync(join(out, ".prebuilt-"));
  try {
    const zipPath = join(tmp, names.zip);
    writeFileSync(zipPath, zip);
    try {
      execFileSync("/usr/bin/ditto", ["-x", "-k", zipPath, join(tmp, "x")], { stdio: "pipe" });
    } catch (e) {
      throw new NoPrebuilt(`unzip: ${String(e.stderr || e.message).trim()}`);
    }
    const app = join(tmp, "x", "AgentHub.app");
    if (!existsSync(app)) throw new NoPrebuilt("the zip has no AgentHub.app");
    const code = await codeOf(app);
    if (code?.cdhash !== m.cdhash) throw new NoPrebuilt(`app cdhash ${code?.cdhash}, manifest ${m.cdhash}`);
    const dest = join(out, "AgentHub.app");
    rmSync(dest, { recursive: true, force: true });
    renameSync(app, dest);
    log(`==> prebuilt app ${version} (${commit.slice(0, 7)}, cdhash ${m.cdhash}) — verified, no local swift build`);
    return { dest, manifest: m };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// CI: the manifest for a built app and its zip.
export function writeManifest({ app, zip, out, version, commit, codeOf = defaultCodeOf }) {
  const code = codeOf(app);
  if (!/^[0-9a-f]{40}$/.test(code?.cdhash || "")) throw new Error("no cdhash for " + app);
  if (!/^[0-9a-f]{40}$/.test(commit || "")) throw new Error("no commit");
  const manifest = {
    format: FORMAT,
    version,
    commit,
    sha256: sha256(readFileSync(zip)),
    cdhash: code.cdhash,
    identifier: code.identifier,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(join(out, assetNames(version).manifest), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// fetch() over local files: "<dir>/<name>" → a Response (404 when missing). For verify-local and the tests.
export async function dirFetch(path) {
  try {
    const buf = readFileSync(path);
    return new Response(buf, { status: 200, headers: { "content-length": String(buf.length) } });
  } catch {
    return new Response("", { status: 404 });
  }
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === "fetch") {
    const out = arg(args, "--out");
    if (!out) return console.error("prebuilt.mjs fetch --out <dir>"), 2;
    if (process.env.AGENTHUB_PREBUILT === "0") return console.log("==> prebuilt app: off (AGENTHUB_PREBUILT=0)"), 3;
    try {
      await fetchPrebuilt(resolve(out));
      return 0;
    } catch (e) {
      if (!(e instanceof NoPrebuilt)) console.error(e.stack || String(e));
      console.log(`==> prebuilt app not used: ${e.message} — building locally`);
      return 3;
    }
  }
  if (cmd === "manifest") {
    const app = arg(args, "--app");
    const zip = arg(args, "--zip");
    const out = arg(args, "--out");
    if (!app || !zip || !out) return console.error("prebuilt.mjs manifest --app <AgentHub.app> --zip <zip> --out <dir>"), 2;
    const version = readFileSync(join(ROOT, "VERSION"), "utf8").trim();
    const m = writeManifest({ app: resolve(app), zip: resolve(zip), out: resolve(out), version, commit: headCommit(ROOT) });
    console.log(`manifest ${version} ${m.commit} cdhash ${m.cdhash} sha256 ${m.sha256}`);
    return 0;
  }
  if (cmd === "verify-local") {
    // CI: the exact checks a hub runs, on the files about to be uploaded (served from a directory instead of HTTPS)
    const dir = arg(args, "--dir");
    if (!dir) return console.error("prebuilt.mjs verify-local --dir <dir>"), 2;
    const out = mkdtempSync(join(resolve(dir), ".verify-"));
    try {
      await fetchPrebuilt(out, { base: resolve(dir), fetchImpl: dirFetch });
      return 0;
    } catch (e) {
      console.error(`verify-local: ${e.message}`);
      return 1;
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  console.error("prebuilt.mjs fetch --out <dir> | manifest --app <app> --zip <zip> --out <dir> | verify-local --dir <dir>");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
