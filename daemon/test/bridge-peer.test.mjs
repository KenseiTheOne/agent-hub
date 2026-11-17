// Peer class "bridge" (lib/peer.mjs bridgeCandidate). A script has no code signature, so the class cannot rest on what the
// app class rests on; these are the rules that close the cheap ways of posing as the bridge:
//   - the script is the interpreter's first argument — no --require / --import / --eval= before it (peer:bridge-launch);
//   - only the script's realpath counts: a symlink with the bridge's name that leads elsewhere is refused (peer:bridge-file);
//   - the file is inside the hub's own tree whatever config lists, a regular file of this user that nobody else can write,
//     and so are the directories above it up to the tree's root (peer:bridge-file).
// A refused process is class cli; the routes answer it with the reason instead of the bare peer:cli.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { createPeer, defaultSys, scriptProblem } from "../lib/peer.mjs";
import { denyCode } from "../lib/server.mjs";
import { cleanup, tempHome } from "./helpers.mjs";

const UID = process.getuid();
const NODE = "/opt/homebrew/bin/node";

// One process (pid 400) on fd 1; problem — what the file check answers for a realpath (null — fine).
function peerFor({ path = NODE, argv, bridgePaths, problem = undefined }) {
  const procs = { 400: { ppid: 1, path, argv } };
  const sys = {
    available: true,
    peerPid: () => 400,
    peerUid: () => UID,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: 1, uid: UID, startSec: 1000, startUsec: 0, comm: "x" } : null),
    procArgv: (pid) => procs[pid]?.argv ?? null,
    codesignVerify: async () => false,
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
    ...(problem === undefined ? {} : { scriptProblem: problem }),
  };
  const config = { ...structuredClone(DEFAULTS), claudeHome: "/Users/u/.claude", peer: { ...DEFAULTS.peer, hookPaths: [], bridgePaths } };
  return createPeer({ config, sys }).classifyFd(1);
}

// A hub tree in a temporary directory: <root>/bridge/agenthub-bridge.mjs.
function tree() {
  const root = realpathSync(tempHome("ah-tree-"));
  mkdirSync(join(root, "bridge"), { mode: 0o755 });
  chmodSync(root, 0o755);
  const file = join(root, "bridge", "agenthub-bridge.mjs");
  writeFileSync(file, "// bridge\n", { mode: 0o755 });
  chmodSync(file, 0o755);
  return { root, file };
}

test("bridge: the script run directly by an interpreter — class bridge; interpreter options before it — refused", async () => {
  const B = "/r/bridge/agenthub-bridge.mjs";
  const ok = await peerFor({ argv: ["node", B], bridgePaths: [B] });
  assert.equal(ok.class, "bridge");
  assert.equal((await peerFor({ argv: ["node", B, "--verbose"], bridgePaths: [B] })).class, "bridge", "the bridge's own arguments come after it");
  // someone else's code under the bridge's name
  for (const argv of [
    ["node", "--require", "/tmp/evil.js", B],
    ["node", "--require=/tmp/evil.js", B],
    ["node", "--import=/tmp/evil.mjs", B],
    ["node", "--eval=process.exit()", B],
    ["node", "-r", "/tmp/evil.js", B],
    ["node", "--inspect", B],
  ]) {
    const r = await peerFor({ argv, bridgePaths: [B] });
    // `--require <file> <bridge>`: the first non-option argument is the other file, so the process does not even look like
    // the bridge; `--require=<file> <bridge>` does, and is refused by the launch rule
    assert.equal(r.class, "cli", JSON.stringify(argv));
    if (r.reason) assert.deepEqual([r.reason, r.detail], ["peer:bridge-launch", "interpreter-options"], JSON.stringify(argv));
  }
  assert.equal((await peerFor({ argv: ["node", "--import=/tmp/evil.mjs", B], bridgePaths: [B] })).reason, "peer:bridge-launch");
  // not an interpreter the hub knows, a relative path, another script: plain cli, as before
  assert.deepEqual([(await peerFor({ path: "/tmp/mytool", argv: ["mytool", B], bridgePaths: [B] })).class, (await peerFor({ path: "/tmp/mytool", argv: ["mytool", B], bridgePaths: [B] })).reason], ["cli", undefined]);
  assert.equal((await peerFor({ argv: ["node", "bridge/agenthub-bridge.mjs"], bridgePaths: [B] })).class, "cli");
  assert.equal((await peerFor({ argv: ["node", "/elsewhere/agenthub-bridge.mjs"], bridgePaths: [B] })).class, "cli");
});

test("bridge: a symlink with the bridge's name that leads elsewhere is not the bridge", async () => {
  const t = tree();
  const other = realpathSync(tempHome("ah-other-"));
  try {
    const evil = join(other, "evil.mjs");
    writeFileSync(evil, "// not the bridge\n");
    // the file of the hub's tree is fine
    assert.equal((await peerFor({ argv: ["node", t.file], bridgePaths: [t.file] })).class, "bridge");
    // a link next to it, listed by a wildcard entry, leads out of the tree
    const link = join(t.root, "bridge", "agenthub-bridge-link.mjs");
    symlinkSync(evil, link);
    const r = await peerFor({ argv: ["node", link], bridgePaths: [join(t.root, "bridge", "agenthub-bridge*.mjs")] });
    assert.deepEqual([r.class, r.reason, r.detail], ["cli", "peer:bridge-file", "symlink"]);
    // the listed path itself replaced by a link
    const t2 = tree();
    try {
      const listed = join(t2.root, "bridge", "agenthub-bridge");
      symlinkSync(evil, listed);
      const r2 = await peerFor({ argv: ["node", listed], bridgePaths: [listed] });
      assert.deepEqual([r2.class, r2.reason, r2.detail], ["cli", "peer:bridge-file", "symlink"]);
    } finally {
      cleanup(t2.root);
    }
    // a tree reached through a directory link (an install's Versions/current) is the same file: accepted
    const cur = join(other, "current");
    symlinkSync(t.root, cur);
    const via = join(cur, "bridge", "agenthub-bridge.mjs");
    assert.equal((await peerFor({ argv: ["node", via], bridgePaths: [via] })).class, "bridge");
    assert.equal((await peerFor({ argv: ["node", t.file], bridgePaths: [via] })).class, "bridge", "listed through the link, started by the real path");
  } finally {
    cleanup(t.root);
    cleanup(other);
  }
});

test("bridge: the file check decides — a problem with the file is peer:bridge-file with the detail", async () => {
  const B = "/r/bridge/agenthub-bridge.mjs";
  const seen = [];
  const fine = await peerFor({ argv: ["node", B], bridgePaths: [B], problem: (real) => (seen.push(real), null) });
  assert.equal(fine.class, "bridge");
  assert.deepEqual(seen, [B], "the check gets the script's realpath");
  for (const detail of ["outside-tree", "writable", "dir-writable", "owner", "not-a-file", "stat"]) {
    const r = await peerFor({ argv: ["node", B], bridgePaths: [B], problem: () => detail });
    assert.deepEqual([r.class, r.reason, r.detail], ["cli", "peer:bridge-file", detail]);
  }
  // the real system functions carry the check (a double without it is the only way to skip it)
  assert.equal(typeof defaultSys().scriptProblem, "function");
});

test("scriptProblem: inside the hub's tree, a regular file of this user, nobody else can write it or the directories above", () => {
  const t = tree();
  const outside = realpathSync(tempHome("ah-out-"));
  try {
    assert.equal(scriptProblem(t.file, [t.root]), null);
    assert.equal(scriptProblem(t.file, [t.root + "/"]), null, "a root with a trailing separator");
    // config.json can list any path in peer.bridgePaths; a file outside the hub's own tree is never the bridge
    const far = join(outside, "agenthub-bridge.mjs");
    writeFileSync(far, "// elsewhere\n", { mode: 0o755 });
    assert.equal(scriptProblem(far, [t.root]), "outside-tree");
    assert.equal(scriptProblem(t.root + "-x/bridge/agenthub-bridge.mjs", [t.root]), "outside-tree", "a sibling directory with the same prefix");
    assert.equal(scriptProblem(t.file, []), "outside-tree");
    assert.equal(scriptProblem(join(t.root, "bridge", "missing.mjs"), [t.root]), "stat");
    assert.equal(scriptProblem(join(t.root, "bridge"), [t.root]), "not-a-file");
    // another account owns it (seen from a different uid)
    assert.equal(scriptProblem(t.file, [t.root], UID + 1), UID === 0 ? null : "owner");
    for (const mode of [0o775, 0o757, 0o777]) {
      chmodSync(t.file, mode);
      assert.equal(scriptProblem(t.file, [t.root]), "writable", mode.toString(8));
    }
    chmodSync(t.file, 0o700);
    assert.equal(scriptProblem(t.file, [t.root]), null);
    // the directory holding it, or the tree's root: whoever can write there can swap the file
    chmodSync(join(t.root, "bridge"), 0o775);
    assert.equal(scriptProblem(t.file, [t.root]), "dir-writable");
    chmodSync(join(t.root, "bridge"), 0o755);
    chmodSync(t.root, 0o777);
    assert.equal(scriptProblem(t.file, [t.root]), "dir-writable");
    chmodSync(t.root, 0o700);
    assert.equal(scriptProblem(t.file, [t.root]), null);
  } finally {
    cleanup(t.root);
    cleanup(outside);
  }
});

test("a refused bridge is told why: the route's 403 carries the reason, other classes keep peer:<class>", () => {
  assert.equal(denyCode({ class: "cli", reason: "peer:bridge-file", detail: "writable" }), "peer:bridge-file");
  assert.equal(denyCode({ class: "cli", reason: "peer:bridge-launch" }), "peer:bridge-launch");
  assert.equal(denyCode({ class: "cli" }), "peer:cli");
  assert.equal(denyCode({ class: "cli", reason: "peer:app-signature" }), "peer:cli");
  assert.equal(denyCode({ class: "hook" }), "peer:hook");
});
