// scripts/prebuilt.mjs: the prebuilt app from a release is used only when every check passes; anything else falls back
// to the local build (exit 3 from build-release.sh's point of view).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoPrebuilt, assetNames, dirFetch, fetchPrebuilt, writeManifest } from "../../scripts/prebuilt.mjs";

const VERSION = "9.8.7";
const COMMIT = "a".repeat(40);
const CDHASH = "c".repeat(40);
const codeOf = () => ({ identifier: "com.kensei.agenthub", cdhash: CDHASH });

// a release directory: AgentHub.app (a stub bundle), its zip, the manifest
function release() {
  const dir = mkdtempSync(join(tmpdir(), "ah-pb-"));
  const app = join(dir, "build", "AgentHub.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "AgentHub"), "#!/bin/sh\n", { mode: 0o755 });
  const zip = join(dir, assetNames(VERSION).zip);
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  writeManifest({ app, zip, out: dir, version: VERSION, commit: COMMIT, codeOf });
  return { dir, out: join(dir, "out") };
}

const opts = (r, extra = {}) => ({ base: r.dir, fetchImpl: dirFetch, version: VERSION, commit: COMMIT, codeOf, log: () => {}, ...extra });

async function rejects(r, extra, re) {
  await assert.rejects(fetchPrebuilt(r.out, opts(r, extra)), (e) => e instanceof NoPrebuilt && re.test(e.message));
  assert.equal(existsSync(join(r.out, "AgentHub.app")), false, "nothing is left in --out after a rejection");
}

test("prebuilt: a release with matching version, commit, sha256 and cdhash is unpacked into --out", async () => {
  const r = release();
  try {
    const { manifest } = await fetchPrebuilt(r.out, opts(r));
    assert.equal(manifest.commit, COMMIT);
    assert.ok(existsSync(join(r.out, "AgentHub.app", "Contents", "MacOS", "AgentHub")));
    assert.deepEqual(readFileSync(join(r.out, "AgentHub.app", "Contents", "MacOS", "AgentHub"), "utf8"), "#!/bin/sh\n");
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("prebuilt: another commit or version, a swapped zip or app, a broken manifest → no prebuilt app", async () => {
  const r = release();
  try {
    await rejects(r, { commit: "b".repeat(40) }, /manifest commit/);
    await rejects(r, { version: "9.8.8", base: r.dir }, /no release asset/);
    await rejects(r, { codeOf: () => ({ identifier: "com.kensei.agenthub", cdhash: "d".repeat(40) }) }, /cdhash/);

    const names = assetNames(VERSION);
    const zip = readFileSync(join(r.dir, names.zip));
    writeFileSync(join(r.dir, names.zip), Buffer.concat([zip, Buffer.from("x")]));
    await rejects(r, {}, /sha256/);
    writeFileSync(join(r.dir, names.zip), zip);

    const m = readFileSync(join(r.dir, names.manifest), "utf8");
    writeFileSync(join(r.dir, names.manifest), m.replace(/"version": "[^"]+"/, '"version": "1.0.0"'));
    await rejects(r, {}, /manifest version/);
    writeFileSync(join(r.dir, names.manifest), "{not json");
    await rejects(r, {}, /not JSON/);
    writeFileSync(join(r.dir, names.manifest), m.replace(/"sha256": "[^"]+"/, '"sha256": "x"'));
    await rejects(r, {}, /sha256\/cdhash/);
    writeFileSync(join(r.dir, names.manifest), m);

    rmSync(join(r.dir, names.zip));
    await rejects(r, {}, /no release asset/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("prebuilt: no git commit, an Intel Mac, a network error → no prebuilt app", async () => {
  const r = release();
  try {
    await rejects(r, { commit: undefined, root: r.dir }, /not a git checkout/);
    await rejects(r, { arch: "x64" }, /arm64/);
    await rejects(r, { fetchImpl: async () => { throw new TypeError("fetch failed"); } }, /fetch failed/);
    await rejects(r, { fetchImpl: async () => new Response("", { status: 503 }) }, /HTTP 503/);
  } finally {
    rmSync(r.dir, { recursive: true, force: true });
  }
});

test("prebuilt: CLI fetch exits 3 (local build follows) when AGENTHUB_PREBUILT=0", () => {
  const script = join(import.meta.dirname, "..", "..", "scripts", "prebuilt.mjs");
  const env = { ...process.env, AGENTHUB_PREBUILT: "0" };
  delete env.NODE_OPTIONS;
  const p = spawnSync(process.execPath, [script, "fetch", "--out", tmpdir()], { env, encoding: "utf8" });
  assert.equal(p.status, 3);
  assert.match(p.stdout, /AGENTHUB_PREBUILT=0/);
});
