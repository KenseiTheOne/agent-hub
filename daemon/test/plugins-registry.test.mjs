// Stage 8, modules without the daemon: minisign signature, plugin archive, permissions and the linter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { generateKeyPair, parsePublicKey, sign, verify } from "../lib/registry/minisign.mjs";
import { packTarGz, readTarGz } from "../lib/registry/tarball.mjs";
import { LOCAL_EFFECTS, THIRD_PARTY_EFFECTS, lintPlugin, pathViolation, permissionGrowth, permissionsFromMeta } from "../lib/registry/perms.mjs";
import * as core from "../lib/core.mjs";
import { parseMetaText } from "../lib/meta.mjs";

test("minisign: our own signature passes; a foreign key, an edited file and the trusted comment — do not", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const msg = Buffer.from('{"version":1}\n');
  const sig = sign(msg, a.secretKey, { trustedComment: "t=1" });
  assert.deepEqual(verify(msg, sig, a.publicKey), { ok: true, keyId: a.keyId, trustedComment: "t=1" });
  assert.equal(verify(msg, sig, b.publicKey).reason, "key-mismatch");
  assert.equal(verify(Buffer.from('{"version":2}\n'), sig, a.publicKey).reason, "signature");
  assert.equal(verify(msg, sig.replace(/^trusted comment: .*$/m, "trusted comment: t=2"), a.publicKey).reason, "global-signature");
  assert.equal(verify(msg, "garbage", a.publicKey).reason, "sig-format");
  assert.equal(verify(msg, sig, "not a key").reason, "key-format");
  // public key — both as a two-line file and as a single base64 line
  assert.equal(parsePublicKey(a.publicKey.split("\n")[1]).keyIdHex, a.keyId);
});

test("minisign: a foreign key under the same keyId — the signature does not match", () => {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const msg = Buffer.from("x");
  const sig = sign(msg, b.secretKey);
  const rawB = Buffer.from(b.publicKey.split("\n")[1], "base64");
  const rawA = Buffer.from(a.publicKey.split("\n")[1], "base64");
  rawB.copy(rawA, 2, 2, 10); // key A with key B's keyId
  assert.equal(verify(msg, sig, rawA.toString("base64")).reason, "signature");
});

// Edits a tar header after packing (name/type) and recomputes the checksum.
function patchTar(gz, index, { name, type, linkname }) {
  const tar = Buffer.from(gunzipSync(gz));
  let off = 0;
  let i = -1;
  while (off < tar.length) {
    const size = parseInt(tar.toString("utf8", off + 124, off + 135).replace(/\0.*$/, "") || "0", 8);
    if (tar[off + 156] === 0x30 && ++i === index) {
      if (name !== undefined) {
        tar.fill(0, off, off + 100);
        tar.fill(0, off + 345, off + 500);
        tar.write(name, off);
      }
      if (type !== undefined) tar[off + 156] = type.charCodeAt(0);
      if (linkname !== undefined) tar.write(linkname, off + 157);
      tar.fill(0x20, off + 148, off + 156);
      let sum = 0;
      for (let k = off; k < off + 512; k++) sum += tar[k];
      tar.write(sum.toString(8).padStart(6, "0") + "\0 ", off + 148);
      return gzipSync(tar);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("no such file in the archive");
}

test("tar: round trip, determinism, modes 0644/0755", () => {
  const files = [
    { path: "p/p.5m.sh", data: "#!/bin/sh\necho hi\n", mode: 0o755 },
    { path: "p/lib/a.txt", data: "a" },
  ];
  const gz = packTarGz(files);
  assert.ok(packTarGz(files).equals(gz));
  const back = readTarGz(gz, { root: "p" });
  assert.deepEqual(back.map((f) => [f.path, f.mode, f.data.toString()]), [
    ["p/lib/a.txt", 0o644, "a"],
    ["p/p.5m.sh", 0o755, "#!/bin/sh\necho hi\n"],
  ]);
});

test("tar: rejects `..`, an absolute path, a foreign root, links, a bad checksum, oversize", () => {
  const gz = packTarGz([{ path: "p/p.sh", data: "x" }]);
  assert.throws(() => readTarGz(patchTar(gz, 0, { name: "p/../../etc/x" }), { root: "p" }), /invalid path/);
  assert.throws(() => readTarGz(patchTar(gz, 0, { name: "/etc/passwd" }), { root: "p" }), /invalid path/);
  assert.throws(() => readTarGz(patchTar(gz, 0, { name: "q/p.sh" }), { root: "p" }), /outside p/);
  assert.throws(() => readTarGz(patchTar(gz, 0, { type: "2", linkname: "/etc/passwd" }), { root: "p" }), /entry type "2" is not allowed/);
  assert.throws(() => readTarGz(patchTar(gz, 0, { type: "1" }), { root: "p" }), /not allowed/);
  const t = Buffer.from(gunzipSync(gz));
  t[600] ^= 1; // a byte of the second header's name → the checksum does not match
  assert.throws(() => readTarGz(gzipSync(t), { root: "p" }), /checksum|not ustar/);
  assert.throws(() => readTarGz(packTarGz([{ path: "p/big", data: Buffer.alloc(100) }]), { root: "p", limits: { maxFiles: 10, maxFileBytes: 10, maxTotalBytes: 1000 } }), /over the limit/);
  assert.throws(() => readTarGz(Buffer.from("not gzip"), { root: "p" }), /gzip/);
});

test("the effects ceiling in perms.mjs matches the core", () => {
  assert.deepEqual(THIRD_PARTY_EFFECTS, core.THIRD_PARTY_EFFECTS);
  assert.deepEqual(LOCAL_EFFECTS, core.LOCAL_EFFECTS);
});

const META = (extra = "") =>
  parseMetaText(`# <agenthub.title>T</agenthub.title><agenthub.version>1.0.0</agenthub.version>
# <agenthub.author.github>a</agenthub.author.github><agenthub.platforms>macos</agenthub.platforms>
# <agenthub.fsRead>~/.config/t — состояние</agenthub.fsRead>
${extra}`).meta;

test("linter: effects=session.stop is rejected for both third-party and official; official actions — immediate only without network", () => {
  const meta = META("# <agenthub.effects>open.url,session.stop</agenthub.effects>");
  const r = lintPlugin({ id: "t", meta });
  assert.ok(r.errors.some((e) => e.includes("session.stop")), r.errors.join("\n"));
  assert.ok(lintPlugin({ id: "t", meta, official: true }).errors.some((e) => e.includes("session.stop")), "effects ceiling — for official too");
  const act = (level, arg = "") => META(`# <agenthub.action id="go" level="${level}"${arg}>t.1m.mjs --action go</agenthub.action>`);
  // G3: community actions are accepted, with a note for the reviewer
  assert.deepEqual(lintPlugin({ id: "t", meta: act("confirm") }).errors, []);
  assert.ok(lintPlugin({ id: "t", meta: act("confirm") }).warnings.some((w) => w.includes("плагина сообщества")));
  assert.deepEqual(lintPlugin({ id: "t", meta: act("confirm"), official: true }).errors, []);
  // (decision 2026-11-09): official immediate without network is allowed (no dialog, only from the app); with network — an error
  assert.deepEqual(lintPlugin({ id: "t", meta: act("immediate"), official: true }).errors, []);
  const netMeta = META(`# <agenthub.net>api.example.com — данные</agenthub.net>\n# <agenthub.action id="go" level="immediate">t.1m.mjs --action go</agenthub.action>`);
  assert.ok(lintPlugin({ id: "t", meta: netMeta, official: true }).errors.some((e) => e.includes("immediate — только у плагина без сети")));
  assert.ok(lintPlugin({ id: "t", meta: act("immediate") }).warnings.some((w) => w.includes("поднимет immediate до confirm")));
  // review 2026-11-09 (low): immediate with a cost — an error (the core would ask with the cost); without a cost — a warning for the reviewer
  for (const cost of [' cost="квота"', ' cost-en="quota"']) {
    const r = lintPlugin({ id: "t", meta: act("immediate", cost), official: true });
    assert.ok(r.errors.some((e) => e.includes('id="go"') && e.includes("immediate с ценой")), cost);
  }
  const plain = lintPlugin({ id: "t", meta: act("immediate"), official: true });
  assert.ok(plain.warnings.some((w) => w.includes('id="go"') && w.includes("ревьюер проверяет")), plain.warnings.join("\n"));
  assert.deepEqual(lintPlugin({ id: "t", meta: act("confirm"), official: true }).warnings, [], "confirm — no note");
  // lowering the level in an update — a permission increase (consent dialog)
  assert.equal(permissionGrowth(permissionsFromMeta(act("confirm")), permissionsFromMeta(act("immediate"))).length, 1);
  // the argument pattern is part of the permission: changing it is a permission increase
  const p1 = permissionsFromMeta(act("confirm", ' arg="id:^[a-z]{1,8}$"'));
  const p2 = permissionsFromMeta(act("confirm", ' arg="id:^.{1,64}$"'));
  assert.equal(permissionGrowth(p1, p2).length, 1);
  assert.match(permissionGrowth(p1, p2)[0].what, /\{id:\^\.\{1,64\}\$\}$/);
  // forbidden locations in the source — an error for official too (no exception any more)
  assert.ok(lintPlugin({ id: "t", meta: META(), source: "readFileSync(home + '/.claude/projects/x')", official: true }).errors.some((e) => e.includes("~/.claude/projects")));
  assert.ok(lintPlugin({ id: "t", meta: META("# <agenthub.effects>cmux.focus</agenthub.effects>"), local: true }).errors.some((e) => e.includes("cmux.focus")));
  assert.deepEqual(lintPlugin({ id: "t", meta: META("# <agenthub.effects>open.*,cmux.focus</agenthub.effects>") }).errors, []);
  // session.focus — switching to a session tab without knowing the terminal: the same harmless ceiling; not for local ones
  assert.deepEqual(lintPlugin({ id: "t", meta: META("# <agenthub.effects>open.url,session.focus</agenthub.effects>") }).errors, []);
  assert.ok(lintPlugin({ id: "t", meta: META("# <agenthub.effects>session.focus</agenthub.effects>"), local: true }).errors.some((e) => e.includes("session.focus")));
});

test("permission growth: a new permission is growth, a changed \"why\" is not", () => {
  const a = permissionsFromMeta(META());
  const b = permissionsFromMeta(META("# <agenthub.exec>/usr/bin/true — проверка</agenthub.exec>"));
  const c = permissionsFromMeta(parseMetaText(`# <agenthub.fsRead>~/.config/t — другое пояснение</agenthub.fsRead>`).meta);
  assert.deepEqual(permissionGrowth(a, b).map((p) => p.key), ["exec:/usr/bin/true"]);
  assert.deepEqual(permissionGrowth(a, c), []);
  assert.ok(pathViolation("~/.claude/projects/x"));
  assert.equal(pathViolation("~/.claude/sessions/*.json"), null);
});
