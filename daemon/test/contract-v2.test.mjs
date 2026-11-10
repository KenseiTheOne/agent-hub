// Plugin contract 2 (2026-11-09, removing plugin names from the core): icon, contract version, connections, own
// notification toggles, action refusal text. Metadata parsing and the linter — without a daemon; plugin state — in
// a real core in a temporary directory (AGENTHUB_HOME), no external programs are run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION, parseMetaText } from "../lib/meta.mjs";
import { lintPlugin, permissionGrowth, permissionList, permissionsFingerprint, permissionsFromMeta } from "../lib/registry/perms.mjs";
import { actionMessage } from "../lib/host.mjs";
import { contractTooNew } from "../lib/plugins.mjs";
import { cleanup, req, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const BASE = `# <agenthub.title>T</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.author.github>someone</agenthub.author.github>
# <agenthub.platforms>macos</agenthub.platforms>
# <agenthub.net>mcp.example.com — тикеты через хаб</agenthub.net>
`;

test("icon: SF Symbol and #RRGGBB; invalid — a parse warning, no icon", () => {
  const ok = parseMetaText('# <agenthub.icon symbol="gauge.with.dots.needle.50percent" color="#0a84ff"></agenthub.icon>');
  assert.deepEqual(ok.meta.icon, { symbol: "gauge.with.dots.needle.50percent", color: "#0A84FF" });
  assert.deepEqual(ok.warnings, []);
  assert.deepEqual(parseMetaText('# <agenthub.icon symbol="moon"></agenthub.icon>').meta.icon, { symbol: "moon" }, "color is optional");
  for (const bad of ['symbol="Moon"', 'symbol="moon fill"', 'symbol="../x"', 'symbol="moon" color="red"', 'symbol="moon" color="#12345"', 'symbol=""']) {
    const r = parseMetaText(`# <agenthub.icon ${bad}></agenthub.icon>`);
    assert.equal(r.meta.icon, null, bad);
    assert.ok(r.warnings.some((w) => /^icon:/.test(w)), bad);
  }
});

test("contract version: <agenthub.contract> — integer ≥ 1; newer than the core — \"needs a newer hub\"", () => {
  assert.equal(CONTRACT_VERSION, 3);
  assert.equal(parseMetaText("# <agenthub.contract>2</agenthub.contract>").meta.contract, 2);
  assert.equal(parseMetaText("").meta.contract, null, "not declared — contract 1");
  const bad = parseMetaText("# <agenthub.contract>два</agenthub.contract>");
  assert.equal(bad.meta.contract, null);
  assert.ok(bad.warnings.some((w) => /^contract:/.test(w)));
  assert.equal(contractTooNew(null), null);
  assert.equal(contractTooNew(CONTRACT_VERSION), null);
  assert.deepEqual(contractTooNew(CONTRACT_VERSION + 1), { need: CONTRACT_VERSION + 1, have: CONTRACT_VERSION });
  // the linter doesn't treat a newer contract as an error: the manager refuses, in plain words
  const meta = parseMetaText(`${BASE}# <agenthub.contract>${CONTRACT_VERSION + 5}</agenthub.contract>`).meta;
  assert.deepEqual(lintPlugin({ id: "t", meta, official: true }).errors, []);
});

test("linter: connection — host from <agenthub.net> and own id; old push kinds — warning, was= — no", () => {
  const conn = (attrs) => parseMetaText(`${BASE}# <agenthub.connection ${attrs} tools="a,b">тикеты</agenthub.connection>`).meta;
  assert.deepEqual(lintPlugin({ id: "t", meta: conn('url="https://mcp.example.com/mcp"'), official: true }).errors, []);
  assert.match(lintPlugin({ id: "t", meta: conn('url="https://other.example.com/mcp"'), official: true }).errors.join("\n"), /хост other\.example\.com не объявлен в <agenthub\.net>/);
  assert.match(lintPlugin({ id: "t", meta: conn('url="https://mcp.example.com/mcp" hosts="auth.example.com"'), official: true }).errors.join("\n"), /auth\.example\.com/);
  assert.match(lintPlugin({ id: "t", meta: conn('id="someone-else" url="https://mcp.example.com/mcp"'), official: true }).errors.join("\n"), /id подключения — id плагина/);
  assert.deepEqual(lintPlugin({ id: "t", meta: conn('id="t.extra" url="https://mcp.example.com/mcp"'), official: true }).errors, []);
  // "<id>-…" is another plugin's id (t-extra), not a connection of plugin t: that way a foreign connection can't be taken over
  assert.match(lintPlugin({ id: "t", meta: conn('id="t-extra" url="https://mcp.example.com/mcp"'), official: true }).errors.join("\n"), /id подключения — id плагина или «t\.<имя>»/);
  // the plugin id isn't usable as a keychain entry name (starts with a digit) — a declaration without its own id is rejected right away
  assert.match(lintPlugin({ id: "1pass", meta: conn('url="https://mcp.example.com/mcp"'), official: true }).errors.join("\n"), /целиком — с буквы, до 64/);
  assert.match(lintPlugin({ id: "x".repeat(65 - 1) + "y", meta: conn('url="https://mcp.example.com/mcp"'), official: true }).errors.join("\n") || "long plugin id — ID_RE", /.+/);
  // third-party (neither official nor own) — the core won't run the connection: it must not appear in the consent sheet
  assert.match(lintPlugin({ id: "t", meta: conn('url="https://mcp.example.com/mcp"'), official: false }).errors.join("\n"), /подключения есть только у официальных и своих/);
  // an IP address instead of a host name — no
  for (const bad of ["https://169.254.169.254/x", "https://127.0.0.1/mcp", "https://10.0.0.1/"]) {
    const r = parseMetaText(`${BASE}# <agenthub.connection url="${bad}" tools="a">x</agenthub.connection>`);
    assert.deepEqual(r.meta.connections, [], bad);
    assert.ok(r.warnings.some((w) => /not an IP address/.test(w)), bad);
  }
  assert.ok(parseMetaText(`${BASE}# <agenthub.connection url="https://mcp.example.com/mcp" hosts="10.0.0.1" tools="a">x</agenthub.connection>`).warnings.some((w) => /hosts/.test(w)));
  const legacy = parseMetaText(`${BASE}# <agenthub.push key="done" kind="night">Готово</agenthub.push>\n# <agenthub.push key="job" kind="plugin" was="runs">Упало</agenthub.push>\n# <agenthub.push key="x" kind="plugin">X</agenthub.push>`).meta;
  const l = lintPlugin({ id: "t", meta: legacy, official: true, lang: "en" });
  assert.deepEqual(l.errors, []);
  assert.equal(l.warnings.length, 1, l.warnings.join("\n"));
  assert.match(l.warnings[0], /key="done" kind="night">: the kind is deprecated \(contract 1\) — write kind="plugin" was="night"/);
});

test("permissions: a connection is a connections-kind permission; a new one — permission growth; without connections the permission set is unchanged", () => {
  const before = permissionsFromMeta(parseMetaText(BASE).meta);
  assert.equal(before.connections, undefined, "index and lock entries from before contract 2 are compared as before");
  const meta = parseMetaText(`${BASE}# <agenthub.connection url="https://mcp.example.com/mcp" scope="read" tools="get_user,filter_tasks" interval="15m" budget="100" title="Tix">тикеты, назначенные вам</agenthub.connection>`).meta;
  const after = permissionsFromMeta(meta);
  assert.deepEqual(after.connections, [{ what: "https://mcp.example.com/mcp scope=read tools=get_user,filter_tasks", why: "тикеты, назначенные вам" }]);
  assert.deepEqual(permissionGrowth(before, after).map((p) => p.kind), ["connections"]);
  assert.ok(permissionList(after).some((p) => p.key === "connections:https://mcp.example.com/mcp scope=read tools=get_user,filter_tasks"));
  // interval and budget aren't access: changing them doesn't count as permission growth
  const slower = permissionsFromMeta(parseMetaText(`${BASE}# <agenthub.connection url="https://mcp.example.com/mcp" scope="read" tools="get_user,filter_tasks" interval="30m" budget="50">тикеты</agenthub.connection>`).meta);
  assert.equal(permissionsFingerprint(slower), permissionsFingerprint(after));
  // a new tool in the allowlist — growth
  const more = permissionsFromMeta(parseMetaText(`${BASE}# <agenthub.connection url="https://mcp.example.com/mcp" scope="read" tools="get_user,filter_tasks,create_task">тикеты</agenthub.connection>`).meta);
  assert.equal(permissionGrowth(after, more).length, 1);
});

test("action refusal text: message= among the last lines, sanitized; without it — nothing", () => {
  assert.equal(actionMessage("работаю\nmessage=Идёт другой прогон — подождите\nreason=busy\n"), "Идёт другой прогон — подождите");
  assert.equal(actionMessage('message="В кавычках"\nreason=x'), "В кавычках");
  assert.equal(actionMessage("reason=x\n"), null);
  assert.equal(actionMessage("message=‮подмена\u0007 строки\nreason=x"), "подмена строки", "bidi and control characters are stripped");
  assert.equal(actionMessage(`message=${"я".repeat(500)}`).length, 120);
  assert.equal(actionMessage("message=рано\n1\n2\n3\n4\n5\n"), null, "only among the last 5 lines");
});

test("plugin state: icon, contract version and connections — from metadata; own notification toggles — per the rules", async () => {
  const plugins = tempHome("ah-c2-");
  writePlugin(
    plugins,
    "tix.1h.sh",
    `#!/bin/sh
${BASE}# <agenthub.contract>2</agenthub.contract>
# <agenthub.icon symbol="checklist" color="#FF375F"></agenthub.icon>
# <agenthub.connection url="https://mcp.example.com/mcp" scope="read" tools="get_user" title="Tix">тикеты</agenthub.connection>
# <agenthub.connection lang="en" title="Tix EN">tickets</agenthub.connection>
# <agenthub.push key="job-failed" kind="plugin">Задача упала</agenthub.push>
# <agenthub.push key="job-failed" lang="en">Job failed</agenthub.push>
echo "Tix | status=ok"
`,
  );
  writePlugin(plugins, "plain.1h.sh", `#!/bin/sh\n# <agenthub.title>Plain</agenthub.title>\necho "Plain | status=ok"\n`);
  const h = await startHub({ pluginsDir: plugins, services: "none", settingsFile: { lang: "ru" } });
  try {
    const st = await waitFor(() => h.core.pluginState("tix"));
    assert.deepEqual(st.icon, { symbol: "checklist", color: "#FF375F" });
    assert.equal(st.contract, 2);
    assert.deepEqual(st.connections.map((c) => [c.id, c.title, c.note, c.host, c.tools]), [["tix", "Tix", "тикеты", "mcp.example.com", ["get_user"]]]);
    const plain = await waitFor(() => h.core.pluginState("plain"));
    assert.deepEqual([plain.icon, plain.contract, plain.connections], [null, 1, []], "no declarations — neutral");
    const n = (await req(h.sock, "GET", "/state")).body.notifications;
    assert.deepEqual(n.plugins, [{ id: "tix", title: "T", on: true, labels: ["Задача упала"] }], "a row only for a plugin with kind=plugin rules");
    // the hub language changed — connection labels and rule labels are in it
    h.core.settings.setLang("en");
    h.core.langChanged({ force: true });
    const en = h.core.pluginState("tix");
    assert.equal(en.connections[0].title, "Tix EN");
    assert.equal(en.connections[0].note, "tickets");
    assert.deepEqual((await req(h.sock, "GET", "/state")).body.notifications.plugins[0].labels, ["Job failed"]);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("agenthub uninstall: keychain entries come from installed plugins' declarations, not from a list in the core", async () => {
  const { keychainServices } = await import("../lib/hub-update/cli.mjs");
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = tempHome("ah-kc-");
  try {
    assert.deepEqual(keychainServices(home), ["agent-hub.telegram", "agent-hub.oauth"], "no plugins — only core services (push and connection sign-ins)");
    mkdirSync(join(home, "Plugins", "tix"), { recursive: true });
    writePlugin(join(home, "Plugins", "tix"), "tix.1h.sh", `#!/bin/sh\n${BASE}# <agenthub.secrets>tix.token — запасной путь</agenthub.secrets>\n# <agenthub.connection url="https://mcp.example.com/mcp" tools="a">x</agenthub.connection>\n`);
    mkdirSync(join(home, "Plugins", "plain"), { recursive: true });
    writePlugin(join(home, "Plugins", "plain"), "plain.sh", "#!/bin/sh\n# <agenthub.title>P</agenthub.title>\n");
    assert.deepEqual(keychainServices(home).sort(), ["agent-hub.oauth", "agent-hub.telegram", "agent-hub.tix"]);
  } finally {
    cleanup(home);
  }
});
