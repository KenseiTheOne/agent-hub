// Plugin page controls (hub 0.1.1, optional within contract 3): segment=, select=, toggle=, table= lines are plain
// params for the core. They must reach the shell untouched, and offers must be made for children at any depth and for
// the toggle line itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOutput } from "../lib/output.mjs";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const SID1 = "3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f";
const SID2 = "4a3d0b2f-8c5e-4d9f-a021-3b4c5d6e7f80";

const BODY = `Model | segment=true note="for new sessions"
--Default (Opus 5.5) | action=set-model arg=default
--Opus 5.5 | selected=true
--Sonnet 5.5 | action=set-model arg=claude-sonnet-5-5
Output style | select=true note="open tabs pick it up from their next message"
--Explanatory | selected=true
--Terse | action=set-style arg=Terse note="yours"
Ultracode | toggle=off action=ultracode-on note="multi-agent workflows on every task"
Open sessions · 13 | table=true columns="Tab¦State¦Model¦Effort"
--Apply base · 2 | action=apply-all header=true
--api-server | cells="idle¦Opus 5.5¦xhigh" cellColors="¦¦#FFB454" sfimage=circle.fill iconColor=#8E8E93
----Fix | action=apply arg=${SID1}
----Switch | effect="session.focus ${SID1}" sfimage=arrow.up.forward.app icon=true
--web-client | cells=busy¦Sonnet¦medium
----after the turn | color=#8E8E93
--As base · 9 | group=true
----Agent Hub | cells="waiting¦Opus 5.5¦medium" sfimage=circle.fill iconColor=#FFB454
------Switch | effect="session.focus ${SID2}" sfimage=arrow.up.forward.app icon=true`;

test("controls: segment/select/toggle/table params pass through the parser as is, ¦ with and without quotes", () => {
  const out = parseOutput(`Head\n---\n${BODY}`);
  assert.deepEqual(out.warnings, []);
  const by = (t) => out.body.find((b) => b.title === t);
  assert.deepEqual(by("Model").params, { segment: "true", note: "for new sessions" });
  assert.equal(by("Opus 5.5").params.selected, "true");
  assert.equal(by("Default (Opus 5.5)").action, "set-model");
  assert.equal(by("Default (Opus 5.5)").params.arg, "default");
  assert.deepEqual(by("Output style").params, { select: "true", note: "open tabs pick it up from their next message" });
  assert.equal(by("Terse").params.note, "yours");
  const u = by("Ultracode");
  assert.equal(u.action, "ultracode-on");
  assert.deepEqual(u.params, { toggle: "off", note: "multi-agent workflows on every task" });
  const table = by("Open sessions · 13");
  assert.deepEqual(table.params, { table: "true", columns: "Tab¦State¦Model¦Effort" });
  assert.deepEqual(by("Apply base · 2").params, { header: "true" });
  const row = by("api-server");
  assert.equal(row.level, 1);
  assert.equal(row.params.cells, "idle¦Opus 5.5¦xhigh");
  assert.equal(row.params.cellColors, "¦¦#FFB454", "the key keeps its case");
  assert.equal(row.params.iconColor, "#8E8E93");
  assert.equal(by("web-client").params.cells, "busy¦Sonnet¦medium", "an unquoted value with ¦ is one value");
  const sw = out.body.filter((b) => b.title === "Switch");
  assert.deepEqual(sw.map((b) => b.level), [2, 3]);
  assert.equal(sw[0].params.icon, "true");
  assert.equal(sw[1].effect, `session.focus ${SID2}`);
  assert.deepEqual(by("As base · 9").params, { group: "true" });
});

const PLUGIN = `#!/bin/sh
# <agenthub.title>Controls</agenthub.title>
# <agenthub.effects>session.focus</agenthub.effects>
# <agenthub.action id="set-model" level="immediate" arg="model:^[a-z0-9-]+$">/bin/echo model</agenthub.action>
# <agenthub.action id="set-style" level="immediate" arg="style:^[A-Za-z]+$">/bin/echo style</agenthub.action>
# <agenthub.action id="ultracode-on" level="confirm">/bin/echo on</agenthub.action>
# <agenthub.action id="apply" level="immediate" arg="session:^[0-9a-f-]{36}$">/bin/echo apply</agenthub.action>
# <agenthub.action id="apply-all" level="confirm">/bin/echo all</agenthub.action>
cat <<'EOF'
Controls | status=ok
---
${BODY}
EOF
`;

test("controls: offers are made for the toggle line, header buttons and row children at depth 2 and 3", async () => {
  const plugins = tempHome("ah-ctl-");
  writePlugin(plugins, "ctl.1h.sh", PLUGIN);
  const h = await startHub({ pluginsDir: plugins });
  try {
    const body = await waitFor(() => h.core.pluginState("ctl")?.body.length && h.core.pluginState("ctl").body);
    const by = (t) => body.find((b) => b.title === t);
    assert.equal(by("Default (Opus 5.5)").offer.action, "set-model");
    assert.equal(by("Opus 5.5").offer, undefined, "the selected option has no offer");
    assert.equal(by("Terse").offer.action, "set-style");
    assert.equal(by("Ultracode").offer.action, "ultracode-on");
    assert.equal(by("Ultracode").offer.level, "confirm");
    assert.equal(by("Ultracode").params.toggle, "off");
    assert.equal(by("Apply base · 2").offer.action, "apply-all");
    assert.equal(by("Fix").offer.action, "apply");
    assert.equal(by("Fix").level, 2);
    const sw = body.filter((b) => b.title === "Switch");
    assert.equal(sw.length, 2);
    assert.ok(sw.every((b) => b.offer?.primitive === "session.focus"), "icon buttons at depth 2 and 3 get offers");
    assert.notEqual(sw[0].offer.id, sw[1].offer.id);
    assert.equal(by("after the turn").offer, undefined);
    assert.equal(by("api-server").params.cellColors, "¦¦#FFB454");
    assert.deepEqual(h.core.pluginState("ctl").warnings ?? [], []);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});
