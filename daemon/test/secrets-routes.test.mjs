// Entering plugin secrets in the app: GET /secrets/:plugin, PUT|DELETE /secrets/:plugin/:key (app only, secrets service).
// The keychain is a `security` double with a JSON file in a temporary directory; the real keychain is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultSys } from "../lib/peer.mjs";
import { denyReason, envName, KEY_RE, makeApi } from "../lib/services/secrets.mjs";
import { cleanup, curl, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";
const VALUE = "sk-Test_VALUE.123:abc/+=~";

// The test process is the "app" (class app via the signature double); curl stays cli.
function appSelfSys() {
  const real = defaultSys();
  return {
    ...real,
    pidPath: (pid) => (pid === process.pid ? APP : real.pidPath(pid)),
    codeInfo: null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => (p === APP ? "app|id" : real.fileId(p)),
    readJson: () => {
      throw new Error("ENOENT");
    },
    writeJson: () => {},
  };
}

// security double: find / delete by argv, add via the stdin of `security -i` (split on whitespace, like the real one).
// The argv log must never carry a value.
function fakeSecurity(dir) {
  const db = join(dir, "keychain.json");
  writeFileSync(db, "{}");
  const p = writePlugin(
    dir,
    "security",
    `#!${process.execPath}
const fs = require("fs");
const db = ${JSON.stringify(db)};
const load = () => JSON.parse(fs.readFileSync(db, "utf8"));
const save = (o) => fs.writeFileSync(db, JSON.stringify(o));
const opt = (a, k) => a[a.indexOf(k) + 1];
const a = process.argv.slice(2);
fs.appendFileSync(db + ".log", a.join(" ") + "\\n");
if (fs.existsSync(db + ".fail") && a[0] === "-i") process.exit(36);
if (a[0] === "find-generic-password") {
  const v = load()[opt(a, "-s") + "|" + opt(a, "-a")];
  if (v === undefined) process.exit(44);
  process.stdout.write(v + "\\n");
} else if (a[0] === "delete-generic-password") {
  const o = load(); const k = opt(a, "-s") + "|" + opt(a, "-a");
  if (!(k in o)) process.exit(44);
  delete o[k]; save(o);
} else if (a[0] === "-i") {
  let s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => {
    for (const raw of s.split("\\n").filter(Boolean)) {
      const w = raw.trim().split(/\\s+/);
      if (w[0] !== "add-generic-password") process.exit(1);
      const o = load(); o[opt(w, "-s") + "|" + opt(w, "-a")] = opt(w, "-w"); save(o);
    }
    process.exit(0);
  });
} else process.exit(2);
`,
  );
  return { p, db, read: () => JSON.parse(readFileSync(db, "utf8")), log: () => readFileSync(db + ".log", "utf8"), fail: () => writeFileSync(db + ".fail", "1") };
}

test("key rule: a 64-character plugin id is a valid namespace; envName; denyReason unchanged for tiers", () => {
  const id64 = "a".repeat(64);
  assert.ok(KEY_RE.test(`${id64}.token`), "plugin id up to 64 (registry ID_RE)");
  assert.ok(KEY_RE.test("1tool.token"), "a registry id may start with a digit");
  assert.ok(!KEY_RE.test(`${"a".repeat(65)}.token`));
  assert.ok(!KEY_RE.test(`tool.${"b".repeat(65)}`));
  assert.equal(denyReason({ source: "installed", id: id64 }, `${id64}.token`), null);
  assert.equal(envName("tool.api-key"), "AGENTHUB_SECRET_TOOL_API_KEY");
});

test("makeApi: after a write it uses ctx.restartPlugin when the core offers it, else a refresh; the cache key is dropped", async () => {
  const bin = tempHome("ah-ssec-");
  const sec = fakeSecurity(bin);
  const file = writePlugin(bin, "tool.1h.sh", `#!/bin/sh\n# <agenthub.secrets>tool.token — why</agenthub.secrets>\n`);
  const calls = [];
  const base = {
    state: { plugin: (id) => (id === "tool" ? { id, source: "builtin", file } : null) },
    lang: () => "en",
    journal: { write: (e) => calls.push(["journal", e.type, JSON.stringify(e).includes(VALUE)]) },
    emit: (e) => calls.push(["emit", e.type]),
    refreshPlugin: (id, reason) => calls.push(["refresh", id, reason]),
  };
  try {
    const cache = new Map([["tool.token", { value: "old", until: Date.now() + 60_000 }]]);
    const api = makeApi({ ...base, restartPlugin: (id, reason) => calls.push(["restart", id, reason]) }, { securityPath: sec.p, timeoutMs: 5000, cache });
    assert.equal((await api.set("tool", "tool.token", VALUE)).body.restarted, "restart");
    assert.equal(cache.has("tool.token"), false);
    assert.deepEqual(calls.filter((c) => c[0] === "restart"), [["restart", "tool", "SecretChanged"]]);
    assert.ok(!calls.some((c) => c[0] === "journal" && c[2]), "the value is not journaled");
    const api2 = makeApi(base, { securityPath: sec.p, timeoutMs: 5000, cache });
    assert.equal((await api2.remove("tool", "tool.token")).body.restarted, "refresh");
    assert.deepEqual(calls.filter((c) => c[0] === "refresh"), [["refresh", "tool", "SecretChanged"]]);
  } finally {
    cleanup(bin);
  }
});

test("app sets and deletes a declared secret: stdin only, no value in logs, cache dropped, the plugin reruns with it", async () => {
  const bin = tempHome("ah-ssec-");
  const plugins = tempHome("ah-sseep-");
  const sec = fakeSecurity(bin);
  writePlugin(
    plugins,
    "tool.1h.sh",
    `#!/bin/sh
# <agenthub.secrets>tool.token — read your tasks</agenthub.secrets>
# <agenthub.secrets lang="en">tool.token — read your tasks (en)</agenthub.secrets>
# <agenthub.secrets>oauth.token — reserved, never given</agenthub.secrets>
echo "len \${#AGENTHUB_SECRET_TOOL_TOKEN} $AGENTHUB_REFRESH_REASON | status=ok"
`,
  );
  writePlugin(plugins, "plain.1h.sh", `#!/bin/sh\necho "plain | status=ok"\n`);
  const h = await startHub({
    pluginsDir: plugins,
    services: "secrets",
    sys: appSelfSys(),
    overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { secrets: { securityPath: sec.p } } },
  });
  const events = [];
  h.core.on("event", (e) => events.push(JSON.stringify(e)));
  const title = () => h.core.pluginState("tool")?.header?.[0]?.title || "";
  try {
    await waitFor(() => title().startsWith("len 0"), { timeoutMs: 8000 });

    // list: declared keys with state, no values
    const l0 = await req(h.sock, "GET", "/secrets/tool");
    assert.equal(l0.status, 200, JSON.stringify(l0.body));
    assert.equal(l0.body.keychain, true);
    assert.deepEqual(
      l0.body.secrets.map((s) => [s.key, s.state, s.editable, s.env]),
      [
        ["tool.token", "unset", true, "AGENTHUB_SECRET_TOOL_TOKEN"],
        ["oauth.token", "denied", false, "AGENTHUB_SECRET_OAUTH_TOKEN"],
      ],
    );
    assert.equal(l0.body.secrets[1].reason, "reserved");
    assert.equal(l0.body.secrets[0].why, "read your tasks", "ru hub language in test mode: the base explanation");

    // only the app: cli gets 403
    assert.equal((await curl(h.sock, "PUT", "/secrets/tool/tool.token", { value: VALUE })).status, 403);
    assert.equal((await curl(h.sock, "GET", "/secrets/tool")).status, 403);
    // refusals
    assert.equal((await req(h.sock, "PUT", "/secrets/nope/tool.token", { value: VALUE })).status, 404);
    assert.deepEqual((await req(h.sock, "PUT", "/secrets/plain/tool.token", { value: VALUE })).body, { error: "secrets:not-declared" });
    assert.deepEqual((await req(h.sock, "PUT", "/secrets/tool/oauth.token", { value: VALUE })).body, { error: "secrets:reserved" });
    assert.deepEqual((await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: "has space" })).body, { error: "args:value:chars" });
    assert.deepEqual((await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: 'q"uote' })).body, { error: "args:value:chars" });
    assert.deepEqual((await req(h.sock, "PUT", "/secrets/tool/tool.token", {})).body, { error: "args:value:required" });
    assert.equal((await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: "x".repeat(3073) })).body.error, "args:value:length");
    assert.deepEqual(sec.read(), {}, "nothing written by the refusals");

    // set → stdin write, cache dropped, plugin reruns with the value
    const s1 = await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: VALUE });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.body.secret.state, "set");
    assert.ok(["restart", "refresh"].includes(s1.body.restarted));
    assert.deepEqual(sec.read(), { "agent-hub.tool|token": VALUE });
    await waitFor(() => title() === `len ${VALUE.length} SecretChanged`, { timeoutMs: 8000 });
    assert.equal((await req(h.sock, "GET", "/secrets/tool")).body.secrets[0].state, "set");

    // overwrite: the new value is used right away, not the 5-minute cached one
    const V2 = "second-value";
    assert.equal((await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: V2 })).status, 200);
    await waitFor(() => title() === `len ${V2.length} SecretChanged`, { timeoutMs: 8000 });

    // delete → unset, the plugin reruns without it
    const d = await req(h.sock, "DELETE", "/secrets/tool/tool.token");
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.secret.state, "unset");
    assert.deepEqual(sec.read(), {});
    await waitFor(() => title() === "len 0 SecretChanged", { timeoutMs: 8000 });
    const d2 = await req(h.sock, "DELETE", "/secrets/tool/tool.token");
    assert.equal(d2.body.missing, true, "deleting a missing entry is fine");

    // a keychain write failure: 500 secrets:keychain, nothing changes
    sec.fail();
    const f = await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: VALUE });
    assert.deepEqual([f.status, f.body.error, f.body.reason], [500, "secrets:keychain", "exit-36"]);

    // the value is in no log, no event, no argv
    const journal = readFileSync(h.config.paths.journal, "utf8");
    for (const v of [VALUE, V2]) {
      assert.doesNotMatch(journal, new RegExp(v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
      assert.doesNotMatch(events.join("\n"), new RegExp(v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
      assert.ok(!sec.log().includes(v), "values never reach security argv");
    }
    assert.match(journal, /"secret-set"/);
    assert.ok(events.some((e) => e.includes('"secrets.changed"')));
  } finally {
    await h.stop();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("a streamable plugin restarts with the new secret in its environment (when the core offers ctx.restartPlugin)", async (t) => {
  const bin = tempHome("ah-ssec-");
  const plugins = tempHome("ah-sseep-");
  const sec = fakeSecurity(bin);
  writePlugin(
    plugins,
    "live.sh",
    `#!/bin/sh
# <agenthub.type>streamable</agenthub.type>
# <agenthub.secrets>live.token — why</agenthub.secrets>
echo "len \${#AGENTHUB_SECRET_LIVE_TOKEN} $AGENTHUB_REFRESH_REASON | status=ok"
echo "~~~"
while read line; do :; done
`,
  );
  const h = await startHub({
    pluginsDir: plugins,
    services: "secrets",
    sys: appSelfSys(),
    overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' }, services: { secrets: { securityPath: sec.p } } },
  });
  const title = () => h.core.pluginState("live")?.header?.[0]?.title || "";
  try {
    await waitFor(() => title() === "len 0 FirstLaunch", { timeoutMs: 8000 });
    const r = await req(h.sock, "PUT", "/secrets/live/live.token", { value: VALUE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.restarted !== "restart") {
      t.skip("the core does not offer ctx.restartPlugin yet: a streamable plugin gets only a refresh");
      return;
    }
    await waitFor(() => title() === `len ${VALUE.length} SecretChanged`, { timeoutMs: 8000 });
  } finally {
    await h.stop();
    cleanup(bin);
    cleanup(plugins);
  }
});

test("without a keychain (test mode, no double): states unavailable, writes 409 secrets:no-keychain", async () => {
  const plugins = tempHome("ah-sseep-");
  writePlugin(plugins, "tool.1h.sh", `#!/bin/sh\n# <agenthub.secrets>tool.token — why</agenthub.secrets>\necho "x | status=ok"\n`);
  const h = await startHub({ pluginsDir: plugins, services: "secrets", sys: appSelfSys(), overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' } } });
  try {
    await waitFor(() => h.core.pluginState("tool")?.header?.length);
    const l = await req(h.sock, "GET", "/secrets/tool");
    assert.equal(l.body.keychain, false);
    assert.deepEqual([l.body.secrets[0].state, l.body.secrets[0].editable], ["unavailable", false]);
    assert.deepEqual((await req(h.sock, "PUT", "/secrets/tool/tool.token", { value: VALUE })).body, { error: "secrets:no-keychain" });
  } finally {
    await h.stop();
    cleanup(plugins);
  }
  // service off — 503
  const h2 = await startHub({ pluginsDir: plugins, sys: appSelfSys(), overrides: { requirements: { app: 'identifier "com.kensei.agenthub"' } } });
  try {
    assert.deepEqual((await req(h2.sock, "GET", "/secrets/tool")).body, { error: "secrets:disabled" });
  } finally {
    await h2.stop();
    cleanup(plugins);
  }
});

// Review 2026-11-12 (C3): the list never reads values (an existence check by exit code), uses the provider's cache, lists a
// bounded number of keys, knows a test-tier own plugin, and translates "why" through the content language chain.
test("makeApi.list: no -w reads, cached keys not looked up, keys capped, test-tier own keys allowed, why via the language chain", async () => {
  const bin = tempHome("ah-ssec-");
  const sec = fakeSecurity(bin);
  const keys = Array.from({ length: 40 }, (_, i) => `tool.k${i}`);
  const file = writePlugin(
    bin,
    "tool.1h.sh",
    `#!/bin/sh\n${keys.map((k) => `# <agenthub.secrets>${k} — base ${k}</agenthub.secrets>`).join("\n")}\n# <agenthub.secrets lang="en-GB">tool.k0 — gb why</agenthub.secrets>\n`,
  );
  writeFileSync(sec.db, JSON.stringify({ "agent-hub.tool|k0": VALUE }));
  const ctx = {
    state: { plugin: (id) => (id === "tool" ? { id, source: "local", tier: "own", testTier: true, file } : null) },
    lang: () => "en",
    journal: { write: () => {} },
    emit: () => {},
    refreshPlugin: () => {},
  };
  try {
    const cache = new Map([["tool.k2", { value: "cached", until: Date.now() + 60_000 }], ["tool.k3", { value: null, until: Date.now() + 60_000 }]]);
    const api = makeApi(ctx, { securityPath: sec.p, timeoutMs: 5000, cache });
    const r = await api.list("tool");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.secrets;
    assert.equal(s.length, 32, "at most 32 keys are listed");
    assert.equal(r.body.more, 8, "the rest is counted, not looked up");
    assert.deepEqual(s.slice(0, 4).map((x) => x.state), ["set", "unset", "set", "unset"]);
    assert.ok(s.every((x) => x.state !== "denied"), "a test-tier own plugin gets its own keys");
    assert.equal(s[0].why, "gb why", "en hub language picks the en-GB variant");
    assert.equal(s[1].why, "base tool.k1");
    const finds = sec.log().split("\n").filter((l) => l.startsWith("find-generic-password"));
    assert.ok(finds.length > 0);
    assert.ok(finds.every((l) => !/(^| )-w( |$)/.test(l)), "the list never asks security for a value");
    assert.ok(!finds.some((l) => / -a k2( |$)/.test(l) || / -a k3( |$)/.test(l)), "cached keys are not looked up");
    assert.ok(!finds.some((l) => / -a k3[2-9]( |$)/.test(l)), "keys past the cap are not looked up");
  } finally {
    cleanup(bin);
  }
});
