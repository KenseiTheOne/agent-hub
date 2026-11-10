// Own plugin sources (2026-11-09): a plugin from a local folder (convention — <repo>/agenthub/<id>/). Any local process
// can create a request (CLI `agenthub plugins install --from`), only a human in the pinned application installs it,
// through the consent sheet; the own tier is trusted like official; a copy in Plugins/<id>; the folder is watched:
// same permissions — a new copy by itself, permissions grew — the consent sheet, the folder is gone — the last copy keeps working.
// Plus "Requires …" in the registry catalog (<agenthub.requires>). No network needed: the registry is a temporary directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR } from "../lib/config.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { managerFor } from "../lib/plugins.mjs";
import { generateKeyPair, sign } from "../lib/registry/minisign.mjs";
import { aclWriters, fingerprintOf, inspectSource, resolveSourceDir } from "../lib/registry/own-source.mjs";
import { lintPlugin, permissionsFromMeta } from "../lib/registry/perms.mjs";
import { packTarGz } from "../lib/registry/tarball.mjs";
import { consentText } from "../lib/registry/terminal.mjs";
import { cleanup, req, startHub, tempHome, waitFor } from "./helpers.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CURL = "/usr/bin/curl";

// All connections come from process state.pid; the path state.path decides the class: AgentHub.app → app, anything else → cli.
function appSys(state) {
  const procs = () => ({ [state.pid]: { ppid: 1, path: state.path || APP } });
  return {
    available: true,
    peerPid: () => state.pid,
    peerUid: () => UID,
    pidPath: (pid) => procs()[pid]?.path ?? null,
    pidInfo: (pid) => (procs()[pid] ? { pid, ppid: 1, uid: UID, startSec: 1000, startUsec: 0, comm: "x" } : null),
    procArgv: () => state.argv || null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}

function pluginText({ id = "mine", version = "1.0.0", title = "Мой", line = "Mine v1", extra = "" } = {}) {
  return `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.title lang="en">Mine</agenthub.title>
# <agenthub.version>${version}</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>macos</agenthub.platforms>
# <agenthub.fsRead>~/.config/mine/state.json — показать состояние</agenthub.fsRead>
# <agenthub.watch>$AGENTHUB_USAGE_FILE — кэш квоты записан</agenthub.watch>
# <agenthub.effects>open.url</agenthub.effects>
# <agenthub.action id="flip" level="immediate" title="Переключить режим">${id}.5m.sh --action flip</agenthub.action>
# <agenthub.push key="mine-event" kind="runs">Моё событие</agenthub.push>
${extra}
if [ "$1" = "--action" ]; then echo "flipped"; exit 0; fi
echo "${line} usage=\${AGENTHUB_USAGE_FILE:-none} reason=\${AGENTHUB_REFRESH_REASON} | status=ok"
echo "---"
echo 'Flip | action=flip'
`;
}

// A repository with an own plugin in agenthub/<id>/ (README, test/, fixtures/ — like in the registry).
function makeRepo(id = "mine", text = pluginText({ id })) {
  const repo = tempHome("ah-own-");
  const dir = join(repo, "agenthub", id);
  mkdirSync(join(dir, "test"), { recursive: true });
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(join(dir, `${id}.5m.sh`), text);
  writeFileSync(join(dir, "README.md"), `# ${id}\n`);
  writeFileSync(join(dir, "test", `${id}.test.mjs`), "// тест — не копируется\n");
  writeFileSync(join(dir, "fixtures", "a.json"), "{}\n");
  return { repo, dir, main: join(dir, `${id}.5m.sh`) };
}

async function hub({ pinned = true, overrides = {}, services = "plugins", env = {} } = {}) {
  const state = { pid: 4242 };
  const key = generateKeyPair();
  const reg = tempHome("ah-reg-");
  const h = await startHub({
    services,
    env,
    sys: appSys(state),
    overrides: {
      requirements: { app: pinned ? 'identifier "com.kensei.agenthub"' : null },
      services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: key.publicKey, allowNetwork: false, ownCheck: { checkMs: 250, debounceMs: 100 } } },
      ...overrides,
    },
  });
  const mgr = managerFor(h.config.paths.home);
  mgr.onChange = () => h.core.host.rescan();
  const stop = h.stop;
  return Object.assign(h, {
    state,
    key,
    reg,
    mgr,
    call: (method, path, body) => req(h.sock, method, path, body),
    asCli() {
      state.path = CURL;
    },
    asApp() {
      state.path = APP;
    },
    async stop() {
      await stop();
      cleanup(reg);
    },
  });
}

async function approve(h, requestId) {
  h.asApp();
  const r1 = await h.call("POST", "/registry/own/approve", { requestId });
  assert.equal(r1.status, 428, JSON.stringify(r1.body));
  const r2 = await h.call("POST", "/registry/own/approve", { requestId, consentToken: r1.body.token });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  return { consent: r1.body, result: r2.body };
}

async function installOwn(h, path) {
  h.asCli();
  const r = await h.call("POST", "/registry/own/request", { path });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pending, true);
  return approve(h, r.body.requestId);
}

const journal = (h) => h.core.journal.tail(3000);
const title = (h, id) => h.core.pluginState(id)?.header?.[0]?.title || "";

// Registry: archives + a signed index.json (as in plugins-manager.test.mjs).
function publish(dir, plugins, { key, generatedAt = new Date().toISOString() } = {}) {
  mkdirSync(join(dir, "archives"), { recursive: true });
  const entries = [];
  for (const p of plugins) {
    const files = { [`${p.id}.5m.sh`]: p.text, "README.md": "# r\n" };
    const gz = packTarGz(Object.entries(files).map(([rel, data]) => ({ path: `${p.id}/${rel}`, data })));
    const meta = parseMetaText(p.text).meta;
    const name = `${p.id}-${meta.version}.tar.gz`;
    writeFileSync(join(dir, "archives", name), gz);
    entries.push({
      id: p.id,
      version: meta.version,
      title: meta.title,
      platforms: meta.platforms,
      type: meta.type,
      tier: p.tier || "community",
      official: p.tier === "official",
      archive: `archives/${name}`,
      sha256: sha(gz),
      size: gz.length,
      permissions: permissionsFromMeta(meta),
      ...(p.requires ? { requires: p.requires } : {}),
      ...(p.i18n ? { i18n: p.i18n } : {}),
    });
  }
  const text = JSON.stringify({ version: 1, generatedAt, plugins: entries, blocklist: [] }, null, 2) + "\n";
  writeFileSync(join(dir, "index.json"), text);
  writeFileSync(join(dir, "index.json.minisig"), sign(Buffer.from(text), key.secretKey));
  return entries;
}

test("inspectSource: plugin folder or repository root (agenthub/<id>), realpath, copy without test/ and fixtures/, fingerprint", () => {
  const { repo, dir } = makeRepo();
  const link = join(tempHome("ah-lnk-"), "link");
  try {
    assert.equal(resolveSourceDir(repo), dir, "repo root → agenthub/<id>");
    assert.equal(resolveSourceDir(dir), dir);
    symlinkSync(dir, link);
    assert.equal(resolveSourceDir(link), dir, "a link to the folder resolves to the real path");
    const src = inspectSource(link);
    assert.deepEqual(src.errors, []);
    assert.equal(src.dir, dir);
    assert.equal(src.id, "mine");
    assert.deepEqual(src.files.map((f) => f.rel).sort(), ["README.md", "mine.5m.sh"], "test/ and fixtures/ aren't in the copy");
    assert.equal(src.fingerprint, fingerprintOf(src.files));
    // editing a test doesn't change the fingerprint, editing the plugin does
    writeFileSync(join(dir, "test", "mine.test.mjs"), "// другой\n");
    assert.equal(inspectSource(dir).fingerprint, src.fingerprint);
    writeFileSync(join(dir, "README.md"), "# другой\n");
    assert.notEqual(inspectSource(dir).fingerprint, src.fingerprint);
    // two plugins in agenthub/ — specify one
    const b = join(repo, "agenthub", "other");
    mkdirSync(b);
    writeFileSync(join(b, "other.5m.sh"), pluginText({ id: "other" }));
    assert.throws(() => resolveSourceDir(repo), (e) => e.code === "own:ambiguous" && e.extra.ids.join() === "mine,other");
    assert.throws(() => resolveSourceDir(join(repo, "nope")), (e) => e.code === "own:not-found");
    assert.throws(() => resolveSourceDir("relative/path"), (e) => e.code === "own:path-relative");
  } finally {
    cleanup(repo);
    cleanup(join(link, ".."));
  }
});

test("a request from the CLI doesn't install: only the application via the consent sheet; tier own, copy in Plugins/<id>, the copy is what runs", async () => {
  const h = await hub();
  const { repo, dir } = makeRepo();
  try {
    h.asCli();
    const r = await h.call("POST", "/registry/own/request", { path: repo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.pending, true);
    assert.equal(r.body.id, "mine");
    assert.equal(r.body.path, dir);
    assert.match(r.body.fingerprint, /^[0-9a-f]{64}$/);
    // nothing installed
    assert.equal(existsSync(join(h.config.paths.plugins, "mine")), false);
    assert.equal(h.mgr.lockEntry("mine"), null);
    // the request is visible to the application and in /state
    const inst = await h.call("GET", "/registry/installed");
    assert.equal(inst.body.requests.length, 1);
    assert.equal(inst.body.requests[0].requestId, r.body.requestId);
    const st = await h.call("GET", "/state");
    assert.equal(st.body.ownPlugins.requests[0].id, "mine");
    assert.ok(journal(h).some((e) => e.type === "plugin-own-requested" && e.plugin === "mine" && e.by === "cli"));
    // the CLI can't approve by itself
    const denied = await h.call("POST", "/registry/own/approve", { requestId: r.body.requestId });
    assert.deepEqual([denied.status, denied.body.error], [403, "peer:cli"]);
    // the application: consent sheet — path, fingerprint, permissions, tier own
    const { consent, result } = await approve(h, r.body.requestId);
    assert.equal(consent.tier, "own");
    assert.equal(consent.source.kind, "own");
    assert.equal(consent.source.path, dir);
    assert.equal(consent.source.fingerprint, r.body.fingerprint);
    assert.equal(consent.source.writable.mine, true);
    assert.equal(consent.changedSinceRequest, false);
    assert.equal(consent.migrate, null);
    assert.ok(consent.permissions.some((p) => p.kind === "actions" && /flip \[immediate\]/.test(p.what)));
    assert.equal(result.source, "own");
    // a copy in Plugins/<id> without test/ and fixtures/; lock — tier own, path, fingerprint
    const live = join(h.config.paths.plugins, "mine");
    assert.ok(existsSync(join(live, "mine.5m.sh")));
    assert.equal(existsSync(join(live, "test")), false);
    const e = h.mgr.lockEntry("mine");
    assert.equal(e.tier, "own");
    assert.equal(e.own.path, dir);
    assert.equal(e.sha256, r.body.fingerprint);
    assert.equal((await h.call("GET", "/registry/installed")).body.requests.length, 0, "request cleared");
    await waitFor(() => /Mine v1/.test(title(h, "mine")));
    const ps = h.core.pluginState("mine");
    assert.equal(ps.tier, "own");
    assert.equal(ps.trusted, true);
    assert.equal(ps.official, false);
    assert.equal(ps.file, join(live, "mine.5m.sh"), "the copy runs, not the repository folder");
    // a repeat request for the same folder with the same contents — nothing to install
    h.asCli();
    const again = await h.call("POST", "/registry/own/request", { path: dir });
    assert.equal(again.body.already, true);
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("without a pinned application — a clear own:no-app refusal, no request", async () => {
  const h = await hub({ pinned: false });
  const { repo } = makeRepo();
  try {
    h.asCli();
    const r = await h.call("POST", "/registry/own/request", { path: repo });
    assert.deepEqual([r.status, r.body.error], [409, "own:no-app"]);
    assert.equal(h.mgr.ownRequests.size, 0);
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("CLI: agenthub plugins install --from <repo> — a request and a hint about the application; without the application — a refusal in words", async () => {
  const h = await hub();
  const { repo } = makeRepo();
  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, [join(DAEMON_DIR, "bin", "agenthub"), ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, AGENTHUB_HOME: h.home, AGENTHUB_SYSTEM_LANG: "en" }, timeout: 15_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, out: stdout + stderr }),
      );
    });
  try {
    h.asCli();
    const ok = await run(["plugins", "install", "--from", repo]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /Request created: "Мой" 1\.0\.0 \(mine\)/);
    assert.match(ok.out, /confirm the install in the Agent Hub app/);
    assert.equal(h.mgr.lockEntry("mine"), null, "the CLI doesn't install");
    assert.equal(h.mgr.ownRequests.size, 1);
    // a check error — the list of reasons
    writeFileSync(join(repo, "agenthub", "mine", "mine.5m.sh"), pluginText().replace("# <agenthub.author.github>someone</agenthub.author.github>\n", ""));
    const bad = await run(["plugins", "install", "--from", repo]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /failed the check[\s\S]*author\.github/);
    // without a pinned application
    h.config.requirements = { ...h.config.requirements, app: null };
    const noapp = await run(["plugins", "install", "--from", repo]);
    assert.equal(noapp.code, 1);
    assert.match(noapp.out, /No pinned Agent Hub app/);
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("same lint as the registry: forbidden place, no README, a link inside, a folder writable by everyone — no request", async () => {
  const h = await hub();
  const cases = [];
  try {
    const a = makeRepo("aa", pluginText({ id: "aa", extra: "# <agenthub.fsRead>~/.claude/projects — переписка</agenthub.fsRead>" }));
    cases.push(a.repo);
    const b = makeRepo("bb", pluginText({ id: "bb" }));
    cases.push(b.repo);
    rmSync(join(b.dir, "README.md"));
    const c = makeRepo("cc", pluginText({ id: "cc" }));
    cases.push(c.repo);
    symlinkSync("/etc/hosts", join(c.dir, "hosts"));
    const d = makeRepo("dd", pluginText({ id: "dd" }));
    cases.push(d.repo);
    chmodSync(join(d.dir, "README.md"), 0o666);
    const e = makeRepo("ee", pluginText({ id: "ee", extra: '# <agenthub.requires name="X" url="https://x.example" check="~/.claude/projects">x</agenthub.requires>' }));
    cases.push(e.repo);
    h.asCli();
    const want = { aa: /~\/\.claude\/projects/, bb: /нет README\.md/, cc: /hosts: символьные ссылки запрещены/, dd: /писать сюда могут не только вы.*README\.md/, ee: /requires name="X".*check/ };
    for (const repo of cases) {
      const r = await h.call("POST", "/registry/own/request", { path: repo });
      assert.equal(r.status, 422, JSON.stringify(r.body));
      assert.equal(r.body.error, "own:lint");
      assert.match(r.body.errors.join("\n"), want[r.body.id], r.body.id);
    }
    assert.equal(h.mgr.ownRequests.size, 0);
    // lintPlugin is the same module as in the registry CI: official mode (actions allowed), immediate — a warning,
    // the obsolete contract 1 push kind (kind="runs") — a warning, not an error: an own plugin installs as it was
    const lint = lintPlugin({ id: "mine", meta: parseMetaText(pluginText()).meta, source: pluginText(), official: true });
    assert.deepEqual(lint.errors, []);
    assert.equal(lint.warnings.length, 2);
    assert.match(lint.warnings.join("\n"), /immediate/);
    assert.match(lint.warnings.join("\n"), /kind="runs">: вид устарел \(контракт 1\)/);
  } finally {
    await h.stop();
    for (const c of cases) cleanup(c);
  }
});

test("own tier: immediate action without a sheet (app only), $AGENTHUB_USAGE_FILE in the environment and in watch, own push rules", async () => {
  const h = await hub();
  const { repo } = makeRepo();
  try {
    const usage = join(h.home, "Cache", "usage.json");
    mkdirSync(join(h.home, "Cache"), { recursive: true });
    h.core.setPluginEnv("AGENTHUB_USAGE_FILE", usage);
    await installOwn(h, repo);
    await waitFor(() => /Mine v1/.test(title(h, "mine")));
    assert.match(title(h, "mine"), new RegExp(`usage=${usage}`), "the service variable — as for official");
    const st = h.core.pluginState("mine");
    assert.deepEqual(st.actions.map((a) => [a.id, a.level]), [["flip", "immediate"]]);
    assert.equal(st.pushRules.length, 1, "own push rules");
    const flip = st.body.find((b) => b.title === "Flip").offer;
    h.asApp();
    const ok = await h.call("POST", `/actions/${flip.id}`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    h.asCli();
    assert.equal((await h.call("POST", `/actions/${flip.id}`)).status, 403, "the action — from the application only");
    // watching $AGENTHUB_USAGE_FILE: a cache write → an extra FileChanged run
    writeFileSync(usage, "{}");
    await waitFor(() => /reason=FileChanged/.test(title(h, "mine")), { timeoutMs: 8000 });
    // the same plugin as community (policy without own) — no actions and no variable
    const pl = { id: "x", source: "installed", meta: { net: [] }, granted: { tier: "community", official: false } };
    assert.deepEqual(h.core.pluginEnvFor(pl), {});
    assert.deepEqual(h.core.pluginEnvFor({ ...pl, granted: { tier: "own" } }), { AGENTHUB_HUB_SOCKET: h.sock, AGENTHUB_USAGE_FILE: usage });
    assert.deepEqual(h.core.pluginEnvFor({ ...pl, source: "local", granted: { tier: "own" } }), {}, "own only exists for plugins installed by the manager");
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("update: same permissions — a new copy by itself (journal, quiet event); permissions grew — \"Update available\" and the consent sheet", async () => {
  const h = await hub();
  const { repo, dir, main } = makeRepo();
  const events = [];
  const on = (ev) => events.push(ev);
  h.core.bus.on("event", on);
  try {
    await installOwn(h, repo);
    await waitFor(() => /Mine v1/.test(title(h, "mine")));
    // arm update checks (before the first check there are no notifications at all — otherwise "quiet" checks nothing)
    h.asApp();
    assert.equal((await h.call("POST", "/registry/check-updates")).status, 200);
    const fp1 = h.mgr.lockEntry("mine").sha256;
    // an edit without new permissions (same version — normal for an own folder)
    writeFileSync(main, pluginText({ line: "Mine v2" }));
    await waitFor(() => h.mgr.lockEntry("mine").sha256 !== fp1, { timeoutMs: 8000 });
    await waitFor(() => /Mine v2/.test(title(h, "mine")), { timeoutMs: 8000 });
    assert.ok(journal(h).some((e) => e.type === "plugin-own-updated" && e.plugin === "mine"));
    assert.ok(events.some((e) => e.type === "plugins.own-updated" && e.plugin === "mine"));
    assert.ok(!events.some((e) => e.type === "plugins.update-available"), "no notification — quiet");
    assert.ok(readFileSync(join(h.config.paths.plugins, "mine", "mine.5m.sh"), "utf8").includes("Mine v2"));
    // an edit with a new permission — doesn't install by itself (and the linter wouldn't allow network next to an immediate action at all)
    const fp2 = h.mgr.lockEntry("mine").sha256;
    writeFileSync(main, pluginText({ version: "1.1.0", line: "Mine v3", extra: "# <agenthub.fsRead>~/.config/mine/news.json — новости</agenthub.fsRead>" }));
    await waitFor(() => h.mgr.ownState.get("mine")?.status === "update", { timeoutMs: 8000 });
    assert.equal(h.mgr.lockEntry("mine").sha256, fp2);
    assert.match(title(h, "mine"), /Mine v2/, "the previous copy keeps running");
    const ups = h.mgr.pluginUpdates();
    assert.equal(ups.length, 1);
    assert.equal(ups[0].tier, "own");
    assert.equal(ups[0].version, "1.1.0");
    assert.equal(ups[0].permissionsGrow, true);
    await waitFor(() => events.some((e) => e.type === "plugins.update-available" && e.plugin === "mine"));
    assert.equal(events.filter((e) => e.type === "plugins.update-available").length, 1, "permission growth — exactly one \"Update available\"");
    assert.ok(ups[0].added.some((p) => p.kind === "fsRead" && /news\.json/.test(p.what)));
    assert.match(ups[0].notifyKey, /^mine@1\.1\.0#[0-9a-f]{12}$/);
    const inst = (await h.call("GET", "/registry/installed")).body.installed.find((x) => x.id === "mine");
    assert.equal(inst.updateAvailable, true);
    assert.equal(inst.own.status, "update");
    assert.ok(inst.own.growth.some((p) => p.kind === "fsRead"));
    // "Update" in the manager is the same /registry/install: a sheet with the new permission marked
    h.asApp();
    const r1 = await h.call("POST", "/registry/install", { id: "mine" });
    assert.equal(r1.status, 428, JSON.stringify(r1.body));
    assert.equal(r1.body.update, true);
    assert.equal(r1.body.source.path, dir);
    assert.deepEqual(r1.body.added.map((p) => p.kind), ["fsRead"]);
    const r2 = await h.call("POST", "/registry/install", { id: "mine", consentToken: r1.body.token });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(h.mgr.lockEntry("mine").version, "1.1.0");
    await waitFor(() => /Mine v3/.test(title(h, "mine")), { timeoutMs: 8000 });
    assert.equal(h.mgr.checkOwn("mine").status, "ok");
    // failed lint in the folder — not installed, the reason is visible
    writeFileSync(main, pluginText({ version: "1.1.0", line: "Mine v4", extra: "# <agenthub.fsRead>~/.config/mine/news.json — новости</agenthub.fsRead>\n# <agenthub.fsRead>~/.claude/projects — нельзя</agenthub.fsRead>" }));
    const bad = h.mgr.checkOwn("mine");
    assert.equal(bad.status, "broken");
    assert.equal(bad.error, "own:lint");
    assert.match(bad.errors.join("\n"), /\.claude\/projects/);
    assert.match(title(h, "mine"), /Mine v3/);
  } finally {
    h.core.bus.off("event", on);
    await h.stop();
    cleanup(repo);
  }
});

test("the folder is gone or replaced by a link — the plugin runs on the last copy, a warning in the interface; it's back — ok again", async () => {
  const h = await hub();
  const { repo, dir } = makeRepo();
  const elsewhere = tempHome("ah-else-");
  try {
    await installOwn(h, repo);
    await waitFor(() => /Mine v1/.test(title(h, "mine")));
    const hidden = join(repo, "agenthub", "moved");
    renameSync(dir, hidden);
    assert.equal(h.mgr.checkOwn("mine").status, "missing");
    let row = (await h.call("GET", "/registry/installed")).body.installed.find((x) => x.id === "mine");
    assert.equal(row.own.status, "missing");
    assert.equal((await h.call("GET", "/state")).body.ownPlugins.problems[0].status, "missing");
    assert.ok(h.core.pluginState("mine"), "the copy runs");
    assert.ok(journal(h).some((e) => e.type === "plugin-own-source" && e.status === "missing"));
    // in place of the folder — a link to another folder with the same plugin: the path is no longer the same (realpath) — broken
    const other = join(elsewhere, "mine");
    renameSync(hidden, other);
    symlinkSync(other, dir);
    const moved = h.mgr.checkOwn("mine");
    assert.deepEqual([moved.status, moved.error], ["broken", "own:moved"]);
    rmSync(dir);
    renameSync(other, dir);
    assert.equal(h.mgr.checkOwn("mine").status, "ok");
    row = (await h.call("GET", "/registry/installed")).body.installed.find((x) => x.id === "mine");
    assert.equal(row.own.status, "ok");
    assert.equal(row.tier, "own");
    assert.equal(row.own.pathShort.endsWith("/agenthub/mine"), true);
  } finally {
    await h.stop();
    cleanup(repo);
    cleanup(elsewhere);
  }
});

test("migrating from official to own with the same id — an explicit sheet with a mark; own doesn't become official", async () => {
  const h = await hub();
  const { repo, dir } = makeRepo("batch", pluginText({ id: "batch", title: "Прогоны" }));
  try {
    // official from the signed catalog
    publish(h.reg, [{ id: "batch", text: pluginText({ id: "batch", title: "Прогоны", version: "0.5.2", line: "Official" }), tier: "official" }], { key: h.key });
    h.asApp();
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    const i1 = await h.call("POST", "/registry/install", { id: "batch" });
    assert.equal(i1.status, 428);
    assert.equal((await h.call("POST", "/registry/install", { id: "batch", consentToken: i1.body.token })).status, 200);
    await waitFor(() => h.core.pluginState("batch")?.tier === "official");
    assert.ok(existsSync(join(h.home, "Registry", "archives", "batch.tar.gz")));
    // the official version's plugin data: settings, mode memory, copies — the migration doesn't touch them (same id)
    const data = join(h.home, "PluginData", "batch");
    const kept = { "config.json": '{"runnerDir":"/x"}\n', "batch-mode.json": '{"restore":["game"]}\n', "config-backups/1.json": "{}\n" };
    mkdirSync(join(data, "config-backups"), { recursive: true });
    for (const [f, t] of Object.entries(kept)) writeFileSync(join(data, f), t);
    // a request for an own one with the same id: a migration mark
    h.asCli();
    const r = await h.call("POST", "/registry/own/request", { path: repo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.migrate, { from: "official", version: "0.5.2" });
    const { consent } = await approve(h, r.body.requestId);
    assert.deepEqual(consent.migrate, { from: "official", version: "0.5.2" });
    assert.equal(consent.update, true);
    assert.equal(consent.tier, "own");
    const e = h.mgr.lockEntry("batch");
    assert.equal(e.tier, "own");
    assert.equal(e.own.path, dir);
    assert.equal(existsSync(join(h.home, "Registry", "archives", "batch.tar.gz")), false, "the registry archive is gone");
    assert.equal(h.mgr.officialNow("batch", e), false);
    await waitFor(() => h.core.pluginState("batch")?.tier === "own" && /Mine v1/.test(title(h, "batch")));
    for (const [f, t] of Object.entries(kept)) assert.equal(readFileSync(join(data, f), "utf8"), t, `PluginData/batch/${f} preserved`);
    // catalog: an own one is installed — the catalog doesn't update it
    const cat = (await h.call("GET", "/registry/catalog")).body.plugins.find((p) => p.id === "batch");
    assert.equal(cat.installedOwn.path, dir);
    assert.equal(cat.updateAvailable, false);
    assert.deepEqual(h.mgr.pluginUpdates(), []);
    // "Update" without source — from the own folder (nothing to install), the catalog — only explicitly and with the migration sheet
    h.asApp();
    const back = await h.call("POST", "/registry/install", { id: "batch", source: "registry" });
    assert.equal(back.status, 428);
    assert.equal(back.body.migrate.from, "own");
    assert.equal(back.body.source.kind, "registry");
    // a lock entry made by the manager after the sheet — own (not official, though the same id is official in the catalog)
    assert.equal((await h.core.policyFor(h.core.host.get("batch").plugin)).tier, "own");
    // but the same entry rewritten bypassing the manager (permissions wider than agreed) doesn't give own — community
    const lock = JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8"));
    lock.plugins.batch.granted.secrets = [{ what: "clickup.token", why: "чужой токен" }];
    writeFileSync(h.config.paths.pluginsLock, JSON.stringify(lock, null, 2));
    assert.equal((await h.core.policyFor(h.core.host.get("batch").plugin)).tier, "community");
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("requests: decline, rewriting the same folder, contents changed after the request — a mark in the sheet; paused — 423", async () => {
  const h = await hub();
  const { repo, main } = makeRepo();
  try {
    h.asCli();
    const r1 = await h.call("POST", "/registry/own/request", { path: repo });
    const r2 = await h.call("POST", "/registry/own/request", { path: repo });
    assert.notEqual(r1.body.requestId, r2.body.requestId);
    assert.equal(h.mgr.ownRequests.size, 1, "a repeat for the same folder replaces the request");
    h.asApp();
    const d = await h.call("POST", "/registry/own/decline", { requestId: r2.body.requestId });
    assert.equal(d.status, 200);
    assert.equal(h.mgr.ownRequests.size, 0);
    assert.ok(journal(h).some((e) => e.type === "plugin-own-declined"));
    h.asCli();
    const r3 = await h.call("POST", "/registry/own/request", { path: repo });
    writeFileSync(main, pluginText({ line: "Mine changed" }));
    h.asApp();
    const c = await h.call("POST", "/registry/own/approve", { requestId: r3.body.requestId });
    assert.equal(c.status, 428);
    assert.equal(c.body.changedSinceRequest, true);
    assert.notEqual(c.body.source.fingerprint, r3.body.fingerprint);
    // the token — only for its own request and only for the same application
    h.state.pid = 5151;
    assert.equal((await h.call("POST", "/registry/own/approve", { requestId: r3.body.requestId, consentToken: c.body.token })).status, 403);
    h.state.pid = 4242;
    writeFileSync(h.config.paths.estop, "");
    const paused = await h.call("POST", "/registry/own/approve", { requestId: r3.body.requestId });
    assert.equal(paused.status, 423);
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("\"Requires …\" in the catalog: a dependency from <agenthub.requires>, whether the path exists in the plugins' HOME, name and note translation", async () => {
  const phome = tempHome("ah-ph-");
  const h = await hub({ env: { AGENTHUB_PLUGIN_HOME: phome } });
  try {
    const text = pluginText({ id: "herm", title: "Hermes" }) + "";
    publish(
      h.reg,
      [
        {
          id: "herm",
          text,
          tier: "official",
          requires: [{ name: "Hermes", url: "https://github.com/NousResearch/hermes-agent", check: "~/.hermes", note: "агент, чьи задачи показывает плагин" }, { name: "Bad", url: "http://x", check: "~/x" }],
          i18n: { en: { requires: { Hermes: { note: "the agent whose jobs it shows" } } } },
        },
      ],
      { key: h.key },
    );
    h.asApp();
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    let p = (await h.call("GET", "/registry/catalog")).body.plugins[0];
    assert.deepEqual(p.requires, [{ name: "Hermes", url: "https://github.com/NousResearch/hermes-agent", note: "агент, чьи задачи показывает плагин", check: "~/.hermes", present: false }], "an invalid entry (http) is dropped");
    mkdirSync(join(phome, ".hermes"));
    p = (await h.call("GET", "/registry/catalog")).body.plugins[0];
    assert.equal(p.requires[0].present, true);
    // metadata: the tag and the translation
    const meta = parseMetaText('<agenthub.requires name="Hermes" url="https://h.example" check="~/.hermes">агент</agenthub.requires><agenthub.requires lang="en" name="Hermes">agent</agenthub.requires>').meta;
    assert.deepEqual(meta.requires, [{ name: "Hermes", url: "https://h.example", check: "~/.hermes", note: "агент" }]);
    assert.deepEqual(meta.i18n.en.requires, { Hermes: { note: "agent" } });
    assert.match(parseMetaText('<agenthub.requires name="H" url="https://h" check="~/a/*">x</agenthub.requires>').warnings[0], /без масок/);
  } finally {
    await h.stop();
    cleanup(phome);
  }
});

// ---------- fixes from the own sources review (2026-11-09) ----------

// An own plugin's lock entry "bypassing the manager": a copy in Plugins/<id> and an entry with tier own — as any user process
// could do, without a request or a sheet.
function forgeOwn(h, id, text, { path = "/nonexistent" } = {}) {
  const dir = join(h.config.paths.plugins, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.5m.sh`), text, { mode: 0o700 });
  const meta = parseMetaText(text).meta;
  const lock = existsSync(h.config.paths.pluginsLock) ? JSON.parse(readFileSync(h.config.paths.pluginsLock, "utf8")) : { version: 1, plugins: {} };
  lock.plugins[id] = {
    id,
    version: meta.version,
    sha256: "f".repeat(64),
    archive: null,
    tier: "own",
    official: false,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    granted: permissionsFromMeta(meta),
    files: { [`${id}.5m.sh`]: sha(Buffer.from(text)) },
    disabled: null,
    own: { path },
    title: meta.title,
    i18n: {},
  };
  writeFileSync(h.config.paths.pluginsLock, JSON.stringify(lock, null, 2), { mode: 0o600 });
}

test("a tier own entry in plugins.lock bypassing the manager — community (no immediate actions or own push), journal, event, a request for re-approval", async () => {
  const h = await hub();
  const { repo, dir } = makeRepo("evil", pluginText({ id: "evil", title: "Злой" }));
  const events = [];
  const on = (ev) => events.push(ev);
  h.core.bus.on("event", on);
  try {
    forgeOwn(h, "evil", pluginText({ id: "evil", title: "Злой" }), { path: dir });
    h.core.host.rescan();
    await waitFor(() => /Mine v1/.test(title(h, "evil")));
    const st = h.core.pluginState("evil");
    assert.equal(st.tier, "community", "the tier field in lock doesn't grant the tier");
    assert.equal(st.trusted, false);
    assert.deepEqual(st.actions || [], [], "community has no actions");
    assert.equal((st.pushRules || []).length, 0, "no own push rules either");
    assert.ok(journal(h).some((e) => e.type === "plugin-own-unexpected" && e.plugin === "evil"));
    assert.ok(events.some((e) => e.type === "plugins.own-unexpected" && e.plugin === "evil"));
    // a re-approval request from the entry's folder comes from the hub itself; the sheet's permissions — as for a new install
    await waitFor(() => [...h.mgr.ownRequests.values()].some((r) => r.id === "evil" && r.reason === "unexpected"));
    const rq = [...h.mgr.ownRequests.values()].find((r) => r.id === "evil");
    const { consent } = await approve(h, rq.requestId);
    assert.ok(consent.permissions.every((p) => p.added), "an entry bypassing the manager doesn't count as consent");
    await waitFor(() => h.core.pluginState("evil")?.tier === "own");
    assert.equal(h.core.pluginState("evil").trusted, true);
    // and only one message per entry
    assert.equal(journal(h).filter((e) => e.type === "plugin-own-unexpected" && e.plugin === "evil").length, 1);
  } finally {
    h.core.bus.off("event", on);
    await h.stop();
    cleanup(repo);
  }
});

test("a planted Registry/own-approvals.json consent file gives no trust while the daemon runs; the blocklist applies to an entry bypassing the manager", async () => {
  const h = await hub();
  try {
    forgeOwn(h, "evil", pluginText({ id: "evil" }));
    const e = h.mgr.lockEntry("evil");
    writeFileSync(join(h.home, "Registry", "own-approvals.json"), JSON.stringify({ version: 1, plugins: { evil: { digest: h.mgr.approvalDigest("evil", e) } } }));
    assert.equal(h.mgr.ownTrusted("evil", e), false);
    // the registry blocklist doesn't disable an own (approved) plugin, but does disable an entry bypassing the manager
    publish(h.reg, [{ id: "other", text: pluginText({ id: "other" }) }], { key: h.key });
    const idx = JSON.parse(readFileSync(join(h.reg, "index.json"), "utf8"));
    idx.blocklist = [{ id: "evil", reason: "вредонос" }];
    const text = JSON.stringify(idx, null, 2) + "\n";
    writeFileSync(join(h.reg, "index.json"), text);
    writeFileSync(join(h.reg, "index.json.minisig"), sign(Buffer.from(text), h.key.secretKey));
    h.asApp();
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    assert.deepEqual(h.mgr.checkInstalled({ id: "evil", dir: join(h.config.paths.plugins, "evil"), meta: parseMetaText(pluginText({ id: "evil" })).meta }), { ok: false, reason: "blocklist" });
    assert.equal(h.mgr.lockEntry("evil").disabled?.reason, "blocklist");
  } finally {
    await h.stop();
  }
});

test("consent survives a daemon restart (consent file); CLI removal revokes it", async () => {
  const h = await hub();
  const { repo } = makeRepo();
  try {
    await installOwn(h, repo);
    const e = h.mgr.lockEntry("mine");
    assert.equal(h.mgr.ownTrusted("mine", e), true);
    // a new manager (as after a restart) takes consents from the file
    const { PluginManager } = await import("../lib/plugins.mjs");
    const fresh = new PluginManager({ config: h.config });
    await fresh.init({ cleanTemp: "stale" });
    assert.equal(fresh.ownTrusted("mine", fresh.lockEntry("mine")), true);
    // removal (like `agenthub plugins remove` from another process) revokes consent in the running daemon too
    fresh.remove("mine");
    const again = { ...e };
    assert.equal(h.mgr.ownTrusted("mine", again), false);
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("quiet — only for exactly the same permission set and not a rollback: narrowed permissions, older version, a new push rule kind=security — \"Update available\"; one notification per content", async () => {
  const h = await hub();
  const { repo, main } = makeRepo();
  const events = [];
  const on = (ev) => events.push(ev);
  h.core.bus.on("event", on);
  try {
    await installOwn(h, "" + repo);
    await waitFor(() => /Mine v1/.test(title(h, "mine")));
    // update checks are armed (the first one passed) — otherwise there are no notifications at all and "quiet" means nothing
    h.asApp();
    assert.equal((await h.call("POST", "/registry/check-updates")).status, 200);
    const fp1 = h.mgr.lockEntry("mine").sha256;
    writeFileSync(main, pluginText({ line: "Mine v2" }));
    await waitFor(() => h.mgr.lockEntry("mine").sha256 !== fp1, { timeoutMs: 8000 });
    assert.ok(journal(h).some((e) => e.type === "plugin-own-updated" && e.files.includes("mine.5m.sh")), "which files changed — in the journal");
    assert.ok(!events.some((e) => e.type === "plugins.update-available"), "quiet update — no notification");
    // permissions narrowed (no action) — doesn't install by itself, installs with one click without a sheet
    const fp2 = h.mgr.lockEntry("mine").sha256;
    writeFileSync(main, pluginText({ line: "Mine narrow" }).replace(/^# <agenthub\.action.*\n/m, ""));
    await waitFor(() => h.mgr.ownState.get("mine")?.status === "update", { timeoutMs: 8000 });
    assert.equal(h.mgr.lockEntry("mine").sha256, fp2, "narrowing permissions doesn't install by itself (otherwise reverting means a sheet again)");
    const up = h.mgr.pluginUpdates().find((u) => u.id === "mine");
    assert.equal(up.permissionsGrow, false);
    await waitFor(() => events.filter((e) => e.type === "plugins.update-available" && e.plugin === "mine").length === 1);
    h.mgr.checkOwn("mine");
    h.mgr.noteUpdates();
    assert.equal(events.filter((e) => e.type === "plugins.update-available").length, 1, "same contents — no second notification");
    // the previous contents are back — ok again without a sheet
    writeFileSync(main, pluginText({ line: "Mine v2" }));
    await waitFor(() => h.mgr.ownState.get("mine")?.status === "ok", { timeoutMs: 8000 });
    assert.equal(h.mgr.lockEntry("mine").sha256, fp2);
    // a version rollback (git checkout of an old branch) — doesn't install by itself
    writeFileSync(main, pluginText({ version: "0.9.0", line: "Mine old" }));
    await waitFor(() => h.mgr.ownState.get("mine")?.status === "update", { timeoutMs: 8000 });
    assert.equal(h.mgr.ownState.get("mine").downgrade, true);
    assert.equal(h.mgr.lockEntry("mine").version, "1.0.0");
    // with one click on "Update" (no permissions added) — installs without a sheet
    const click = await h.call("POST", "/registry/install", { id: "mine" });
    assert.equal(click.status, 200, JSON.stringify(click.body));
    assert.equal(h.mgr.lockEntry("mine").version, "0.9.0");
    // a new push rule kind=security (delivered regardless of toggles) — permission growth: a sheet, not quiet
    const fp3 = h.mgr.lockEntry("mine").sha256;
    writeFileSync(main, pluginText({ version: "0.9.0", line: "Mine loud", extra: '# <agenthub.push key="alarm" kind="security" quiet="true">Тревога</agenthub.push>' }));
    await waitFor(() => h.mgr.ownState.get("mine")?.status === "update" && h.mgr.ownState.get("mine").fingerprint !== fp3, { timeoutMs: 8000 });
    assert.equal(h.mgr.lockEntry("mine").sha256, fp3);
    const r1 = await h.call("POST", "/registry/install", { id: "mine" });
    assert.equal(r1.status, 428);
    assert.deepEqual(r1.body.added.map((p) => [p.kind, p.what]), [["push", "alarm [security, quiet]"]]);
    assert.ok(r1.body.source.warnings.some((w) => /kind="security"/.test(w)), "the pushWarnings warning — in the sheet");
    assert.ok(r1.body.source.warnings.some((w) => /immediate/.test(w)), "and the linter warning about immediate");
  } finally {
    h.core.bus.off("event", on);
    await h.stop();
    cleanup(repo);
  }
});

test("an own plugin's id matches a catalog plugin that isn't installed — a \"catalog\" mark in the request and the sheet, a \"Replace\" button", async () => {
  const h = await hub();
  const { repo } = makeRepo("clickup", pluginText({ id: "clickup", title: "Подделка" }));
  try {
    publish(h.reg, [{ id: "clickup", text: pluginText({ id: "clickup", title: "ClickUp", version: "0.5.2" }), tier: "official" }], { key: h.key });
    h.asApp();
    assert.equal((await h.call("POST", "/registry/fetch")).status, 200);
    h.asCli();
    const r = await h.call("POST", "/registry/own/request", { path: repo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.migrate, { from: "catalog", tier: "official", version: "0.5.2", title: "ClickUp" });
    h.asApp();
    const c = await h.call("POST", "/registry/own/approve", { requestId: r.body.requestId });
    assert.equal(c.status, 428);
    assert.equal(c.body.migrate.from, "catalog");
    assert.equal(c.body.migrate.tier, "official");
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("a request is bound to its folder: the folder replaced by a link — own:path-changed; a request for the same id from another folder doesn't displace the pending one; requests survive a restart", async () => {
  const h = await hub();
  const a = makeRepo();
  const b = makeRepo();
  try {
    h.asCli();
    const ra = await h.call("POST", "/registry/own/request", { path: a.repo });
    assert.equal(ra.status, 200);
    const rb = await h.call("POST", "/registry/own/request", { path: b.repo });
    assert.deepEqual([rb.status, rb.body.error], [409, "own:request-conflict"]);
    assert.equal(rb.body.pending.path, a.dir);
    assert.equal(h.mgr.ownRequests.size, 1);
    // requests are on disk: a new manager (daemon restart) sees them
    const { PluginManager } = await import("../lib/plugins.mjs");
    const fresh = new PluginManager({ config: h.config });
    await fresh.init({ cleanTemp: "stale" });
    assert.deepEqual(fresh.ownRequestList().map((r) => [r.requestId, r.path]), [[ra.body.requestId, a.dir]]);
    // folder A was renamed, in its place — a link to B with the same contents
    renameSync(a.dir, a.dir + "-old");
    symlinkSync(b.dir, a.dir);
    h.asApp();
    const c = await h.call("POST", "/registry/own/approve", { requestId: ra.body.requestId });
    assert.deepEqual([c.status, c.body.error], [409, "own:path-changed"]);
    assert.equal(h.mgr.lockEntry("mine"), null);
  } finally {
    await h.stop();
    cleanup(a.repo);
    cleanup(b.repo);
  }
});

test("a diagnostic shell run (--snapshot-consent) changes nothing: install without permission growth — 409, the human's sheet isn't reset, remove — 403", async () => {
  const h = await hub();
  const { repo, main } = makeRepo();
  try {
    await installOwn(h, repo);
    // the folder has new contents with the same permissions, but an older version: a regular "Update" would install it right away
    h.mgr.stopOwn();
    writeFileSync(main, pluginText({ version: "0.9.0", line: "Mine old" }));
    const fp = h.mgr.lockEntry("mine").sha256;
    h.asApp();
    h.state.argv = ["/Applications/AgentHub.app/Contents/MacOS/AgentHub", "--snapshot-consent", "/tmp/x.png", "--consent-install", "mine"];
    const d = await h.call("POST", "/registry/install", { id: "mine" });
    assert.deepEqual([d.status, d.body.error], [409, "consent:nothing"]);
    assert.equal(h.mgr.lockEntry("mine").sha256, fp, "diagnostics don't install");
    assert.equal((await h.call("POST", "/registry/remove", { id: "mine" })).status, 403);
    // the human's sheet (another plugin's request) — the sheet snapshot doesn't reset it
    const other = makeRepo("other", pluginText({ id: "other" }));
    try {
      h.state.argv = null;
      h.state.pid = 4343;
      h.asCli();
      const rq = await h.call("POST", "/registry/own/request", { path: other.repo });
      h.asApp();
      const human = await h.call("POST", "/registry/own/approve", { requestId: rq.body.requestId });
      assert.equal(human.status, 428);
      h.state.pid = 4242;
      h.state.argv = ["/Applications/AgentHub.app/Contents/MacOS/AgentHub", "--snapshot-consent", "/tmp/x.png"];
      const snap = await h.call("POST", "/registry/own/approve", { requestId: rq.body.requestId });
      assert.equal(snap.status, 428);
      assert.equal((await h.call("POST", "/registry/own/approve", { requestId: rq.body.requestId, consentToken: snap.body.token })).status, 403);
      h.state.argv = null;
      h.state.pid = 4343;
      const ok = await h.call("POST", "/registry/own/approve", { requestId: rq.body.requestId, consentToken: human.body.token });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
    } finally {
      cleanup(other.repo);
    }
  } finally {
    await h.stop();
    cleanup(repo);
  }
});

test("inspectSource: a file replaced by a link between the walk and the read — an error, not a read of a foreign place; a FIFO doesn't hang the daemon", () => {
  const { repo, dir } = makeRepo();
  const outside = join(tempHome("ah-out-"), "outside.txt");
  try {
    writeFileSync(outside, "SECRET-OUTSIDE-CONTENT\n");
    writeFileSync(join(dir, "notes.txt"), "обычный файл\n");
    const src = inspectSource(dir, {
      afterWalk: () => {
        rmSync(join(dir, "notes.txt"));
        symlinkSync(outside, join(dir, "notes.txt"));
      },
    });
    assert.ok(src.errors.some((e) => /notes\.txt: файл сменился во время проверки/.test(e)), src.errors.join("\n"));
    assert.ok(!src.files.some((f) => f.data.toString().includes("SECRET-OUTSIDE")), "foreign contents not read");
    // a FIFO in place of the file (after the walk): the read doesn't block
    rmSync(join(dir, "notes.txt"));
    writeFileSync(join(dir, "notes.txt"), "снова файл\n");
    const t0 = Date.now();
    const src2 = inspectSource(dir, {
      afterWalk: () => {
        rmSync(join(dir, "notes.txt"));
        execFileSync("/usr/bin/mkfifo", [join(dir, "notes.txt")]);
      },
    });
    assert.ok(Date.now() - t0 < 3000, "didn't hang on the FIFO");
    assert.ok(src2.errors.some((e) => /notes\.txt/.test(e)), src2.errors.join("\n"));
  } finally {
    cleanup(repo);
    cleanup(join(outside, ".."));
  }
});

test("inspectSource: the full walk — 182 files in fixtures/ don't cut the check short (the main file is read); over the limit — an error; texts — in the hub language", () => {
  const { repo, dir } = makeRepo();
  try {
    for (let i = 0; i < 30; i++) {
      mkdirSync(join(dir, "fixtures", `case-${String(i).padStart(2, "0")}`));
      for (let j = 0; j < 6; j++) writeFileSync(join(dir, "fixtures", `case-${String(i).padStart(2, "0")}`, `${j}.json`), "{}\n");
    }
    const src = inspectSource(dir);
    assert.deepEqual(src.errors, []);
    assert.equal(src.main, "mine.5m.sh");
    assert.ok(src.meta && src.meta.title === "Мой");
    assert.deepEqual(src.files.map((f) => f.rel).sort(), ["README.md", "mine.5m.sh"]);
    // over the registry limit (200 files) — an error, not a silently incomplete copy
    for (let j = 0; j < 30; j++) writeFileSync(join(dir, "fixtures", `extra-${j}.json`), "{}\n");
    assert.ok(inspectSource(dir).errors.some((e) => /файлов больше 200/.test(e)));
    rmSync(join(dir, "README.md"));
    assert.ok(inspectSource(dir, { lang: "en" }).errors.includes("no README.md"));
    assert.ok(inspectSource(dir, { lang: "en" }).errors.some((e) => /more than 200 files/.test(e)));
  } finally {
    cleanup(repo);
  }
});

test("inspectSource: a macOS ACL granting write to others besides you with mode 644 — refused", { skip: process.platform !== "darwin" }, () => {
  const { repo, dir } = makeRepo();
  try {
    assert.deepEqual(aclWriters(dir), []);
    execFileSync("/bin/chmod", ["+a", "everyone allow write,append", join(dir, "README.md")]);
    execFileSync("/bin/chmod", ["+a", "everyone allow add_file,delete_child", join(dir, "fixtures")]);
    assert.deepEqual(aclWriters(dir).sort(), ["README.md", "fixtures"]);
    const src = inspectSource(dir);
    assert.ok(src.errors.some((e) => /писать сюда могут не только вы \(ACL\): .*README\.md/.test(e)), src.errors.join("\n"));
    assert.deepEqual(src.writable.others, [], "the mode bits are fine — it's the ACL that gets caught");
    // your own ACL entry (for yourself) isn't a reason
    execFileSync("/bin/chmod", ["-a#", "0", join(dir, "README.md")]);
    execFileSync("/bin/chmod", ["-a#", "0", join(dir, "fixtures")]);
    execFileSync("/bin/chmod", ["+a", `user:${process.env.USER || "nobody"} allow write`, join(dir, "README.md")]);
    if (process.env.USER) assert.deepEqual(aclWriters(dir), []);
  } finally {
    cleanup(repo);
  }
});

test("terminal: \"agenthub plugins install <id>\" over an own plugin — \"Replace\" and a line about the folder, in the hub language", () => {
  const prep = {
    entry: { tier: "official", title: "Прогоны", version: "0.5.2", sha256: "a".repeat(64) },
    update: true,
    fromVersion: "0.6.0",
    list: [{ kind: "fsRead", what: "~/x", why: "кэш", added: true }],
    migrate: { from: "own", version: "0.6.0", path: "/Users/x/repo/agenthub/batch" },
  };
  const text = consentText(prep, "en");
  assert.match(text, /^Replace "Прогоны" 0\.6\.0 → 0\.5\.2 \(official/);
  assert.match(text, /Replaces your own "Прогоны" 0\.6\.0 from the folder \/Users\/x\/repo\/agenthub\/batch with the plugin from the registry catalog\. Watching the folder stops/);
  assert.match(text, /\n {2}\[new\] read: ~\/x — кэш$/);
  const ru = consentText(prep, "ru");
  assert.match(ru, /^Заменить «Прогоны» 0\.6\.0 → 0\.5\.2 \(официальный/);
  assert.match(ru, /Заменяет ваш плагин «Прогоны» 0\.6\.0 из папки \/Users\/x\/repo\/agenthub\/batch плагином из каталога реестра/);
  assert.match(ru, /\n {2}\[новое\] чтение: ~\/x — кэш$/);
});

// ---------- contract 2 ----------
test("an own plugin requires a contract newer than the hub — no request is created: own:hub-too-old with versions; update from the folder — no either", async () => {
  const { CONTRACT_VERSION } = await import("../lib/meta.mjs");
  const h = await hub();
  const next = CONTRACT_VERSION + 1;
  // a contract N+1 plugin uses one of its capabilities — a push kind this linter doesn't know (an error for it):
  // the human still sees "requires a newer hub", not own:lint with a list of incomprehensible errors
  const future = `# <agenthub.contract>${next}</agenthub.contract>\n# <agenthub.push key="x" kind="future-kind">X</agenthub.push>`;
  const { repo, main } = makeRepo("mine", pluginText({ extra: future }));
  try {
    h.asCli();
    const r = await h.call("POST", "/registry/own/request", { path: repo });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "own:hub-too-old");
    assert.deepEqual([r.body.need, r.body.have], [next, CONTRACT_VERSION]);
    assert.throws(() => h.mgr.prepareOwn(repo), (e) => e.code === "own:hub-too-old");
    assert.equal((await h.call("GET", "/registry/installed")).body.requests.length, 0);
    // own contract — the request exists, with an icon; installed, then the folder demanded a newer contract — the copy stays
    writeFileSync(main, pluginText({ extra: `# <agenthub.contract>${CONTRACT_VERSION}</agenthub.contract>\n# <agenthub.icon symbol="moon" color="#5e5ce6"></agenthub.icon>` }));
    const r2 = await h.call("POST", "/registry/own/request", { path: repo });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.deepEqual(r2.body.icon, { symbol: "moon", color: "#5E5CE6" });
    await approve(h, r2.body.requestId);
    await waitFor(() => title(h, "mine").startsWith("Mine v1"));
    assert.deepEqual(h.core.pluginState("mine").icon, { symbol: "moon", color: "#5E5CE6" });
    writeFileSync(main, pluginText({ version: "1.1.0", line: "Mine v2", extra: future }));
    const st = await waitFor(() => {
      const s = h.mgr.checkOwn("mine", "test");
      return s?.status === "broken" ? s : null;
    });
    assert.equal(st.error, "own:hub-too-old");
    assert.deepEqual([st.need, st.have], [next, CONTRACT_VERSION]);
    assert.ok(title(h, "mine").startsWith("Mine v1"), "the previous copy keeps running");
  } finally {
    await h.stop();
    cleanup(repo);
  }
});
