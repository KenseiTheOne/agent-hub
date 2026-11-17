// The consent rule of an own plugin's reinstall from its folder (lib/plugins.mjs prepareOwn / checkOwn): the human consented
// to a folder and to a permission set, so a changed folder installs by itself ONLY when the permission keys are exactly the
// same. Every way a permission can grow — one more path, host, command, secret, effect, action, action flag, terminal word,
// subscription, loud push rule — leaves the installed copy untouched until the consent window. What is not a permission key
// (the code, the "why" text, a title) does install by itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managerFor } from "../lib/plugins.mjs";
import { generateKeyPair } from "../lib/registry/minisign.mjs";
import { cleanup, req, startHub, tempHome } from "./helpers.mjs";

const UID = process.getuid();
const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const CURL = "/usr/bin/curl";

// Every connection comes from one process; its path decides the class: AgentHub.app → app, anything else → cli.
function appSys(state) {
  const procs = () => ({ [state.pid]: { ppid: 1, path: state.path || APP } });
  return {
    available: true,
    peerPid: () => state.pid,
    peerUid: () => UID,
    pidPath: (pid) => procs()[pid]?.path ?? null,
    pidInfo: (pid) => (procs()[pid] ? { pid, ppid: 1, uid: UID, startSec: 1000, startUsec: 0, comm: "x" } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => `${p}|id`,
    myUid: () => UID,
    readJson: () => {
      throw new Error("ENOENT");
    },
  };
}

const BASE = {
  fsRead: "# <agenthub.fsRead>~/.config/mine/state.json — show the state</agenthub.fsRead>",
  watch: "# <agenthub.watch>~/.config/mine — the state changed</agenthub.watch>",
  action: '# <agenthub.action id="flip" level="confirm" title="Flip the mode">mine.5m.sh --action flip</agenthub.action>',
};
function pluginText({ line = "Mine v1", fsRead = BASE.fsRead, watch = BASE.watch, action = BASE.action, extra = "", title = "Mine" } = {}) {
  return `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>macos</agenthub.platforms>
${fsRead}
${watch}
${action}
${extra}
echo "${line} | status=ok"
`;
}

async function setup() {
  const state = { pid: 4242 };
  const reg = tempHome("ah-reg-");
  const repo = tempHome("ah-own-");
  const dir = join(repo, "agenthub", "mine");
  mkdirSync(dir, { recursive: true });
  const main = join(dir, "mine.5m.sh");
  writeFileSync(main, pluginText());
  writeFileSync(join(dir, "README.md"), "# mine\n");
  const h = await startHub({
    services: "plugins",
    sys: appSys(state),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub"' },
      // the folder is checked only when the test asks (checkOwn): no timer in the way
      services: { plugins: { indexUrl: join(reg, "index.json"), publicKey: generateKeyPair().publicKey, allowNetwork: false, ownCheck: { checkMs: 3_600_000, debounceMs: 3_600_000 } } },
    },
  });
  const mgr = managerFor(h.config.paths.home);
  const call = (method, path, body) => req(h.sock, method, path, body);
  // a request from the CLI, the consent window in the app
  state.path = CURL;
  const r = await call("POST", "/registry/own/request", { path: repo });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  state.path = APP;
  const w = await call("POST", "/registry/own/approve", { requestId: r.body.requestId });
  assert.equal(w.status, 428, JSON.stringify(w.body));
  const ok = await call("POST", "/registry/own/approve", { requestId: r.body.requestId, consentToken: w.body.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return {
    h,
    mgr,
    main,
    call,
    installed: () => readFileSync(join(h.config.paths.plugins, "mine", "mine.5m.sh"), "utf8"),
    journal: () => h.core.journal.tail(3000),
    async stop() {
      await h.stop();
      cleanup(reg);
      cleanup(repo);
    },
  };
}

// Each entry is one way the same folder asks for more than was consented to.
const GROWTH = {
  "one more file to read": { extra: "# <agenthub.fsRead>~/.config/mine/other.json — more</agenthub.fsRead>" },
  "a wider path instead of the consented one": { fsRead: "# <agenthub.fsRead>~/.config/mine — the whole folder</agenthub.fsRead>" },
  "a file to write": { extra: "# <agenthub.fsWrite>~/.config/mine/out.json — save</agenthub.fsWrite>" },
  "a network host": { extra: "# <agenthub.net>api.example.com — ask the service</agenthub.net>" },
  "a command to run": { extra: "# <agenthub.exec>git — read the branch</agenthub.exec>" },
  "a secret": { extra: "# <agenthub.secrets>example.token — sign in</agenthub.secrets>" },
  "an effect": { extra: "# <agenthub.effects>open.url</agenthub.effects>" },
  "watching subdirectories too": { watch: '# <agenthub.watch recursive="true">~/.config/mine — the state changed</agenthub.watch>' },
  "a second action": { extra: '# <agenthub.action id="wipe" level="confirm" title="Wipe">mine.5m.sh --action wipe</agenthub.action>' },
  "another command behind the same action": { action: '# <agenthub.action id="flip" level="confirm" title="Flip the mode">mine.5m.sh --action wipe</agenthub.action>' },
  "a lower confirmation level of the same action": { action: '# <agenthub.action id="flip" level="immediate" title="Flip the mode">mine.5m.sh --action flip</agenthub.action>' },
  "a terminal permission": { extra: "# <agenthub.terminal>send /model — switch the model</agenthub.terminal>" },
  "a subscription to other plugins' events": { extra: "# <agenthub.subscribe>*:deploy — react to deploys</agenthub.subscribe>" },
  "a push rule delivered regardless of the switches": { extra: '# <agenthub.push key="alarm" kind="security">Alarm</agenthub.push>' },
};

test("own plugin: a changed folder that asks for one more permission is never installed by itself", async () => {
  const t = await setup();
  try {
    const lock0 = t.mgr.lockEntry("mine");
    const copy0 = t.installed();
    for (const [name, change] of Object.entries(GROWTH)) {
      writeFileSync(t.main, pluginText({ line: `Mine grown (${name})`, ...change }));
      const st = t.mgr.checkOwn("mine", "test");
      // "update" — waits for the consent window. Never "ok".
      assert.equal(st.status, "update", `${name}: ${JSON.stringify(st)}`);
      assert.ok(st.growth.length > 0, `${name}: the growth is what the window will show`);
      assert.equal(t.mgr.lockEntry("mine").sha256, lock0.sha256, `${name}: the lock entry is untouched`);
      assert.deepEqual(t.mgr.lockEntry("mine").granted, lock0.granted, `${name}: the granted permissions are untouched`);
      assert.equal(t.installed(), copy0, `${name}: the installed copy is untouched`);
    }
    assert.equal(t.journal().filter((e) => e.type === "plugin-own-updated").length, 0);
    // the "Update" button for a grown set is the consent window, not an install
    writeFileSync(t.main, pluginText({ line: "Mine grown", ...GROWTH["a file to write"] }));
    assert.equal(t.mgr.checkOwn("mine", "test").status, "update");
    const win = await t.call("POST", "/registry/install", { id: "mine" });
    assert.equal(win.status, 428, JSON.stringify(win.body));
    assert.deepEqual(win.body.added.map((p) => p.kind), ["fsWrite"]);
    assert.equal(t.installed(), copy0);
  } finally {
    await t.stop();
  }
});

test("own plugin: the same permission keys — the code, the \"why\" text and the title install by themselves, with a journal line", async () => {
  const t = await setup();
  try {
    const lock0 = t.mgr.lockEntry("mine");
    writeFileSync(t.main, pluginText({ line: "Mine v2", title: "Mine renamed", fsRead: "# <agenthub.fsRead>~/.config/mine/state.json — another explanation</agenthub.fsRead>" }));
    const st = t.mgr.checkOwn("mine", "test");
    assert.equal(st.status, "ok", JSON.stringify(st));
    assert.notEqual(t.mgr.lockEntry("mine").sha256, lock0.sha256);
    assert.match(t.installed(), /Mine v2/);
    const line = t.journal().find((e) => e.type === "plugin-own-updated" && e.plugin === "mine");
    assert.ok(line, "the reinstall is journaled");
    assert.deepEqual(line.files, ["mine.5m.sh"]);
  } finally {
    await t.stop();
  }
});
