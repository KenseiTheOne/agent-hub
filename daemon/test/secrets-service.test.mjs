// Secrets service: the core provider on top of the keychain (a `security` double), the "who gets what" rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";
import { denyReason } from "../lib/services/secrets.mjs";

const SECRET = "s3cr3t-value-for-test";

// security double: answers only agent-hub.clickup / token, writes calls (without the value) to a file.
function fakeSecurity(dir) {
  const log = join(dir, "security.log");
  const p = writePlugin(
    dir,
    "security",
    `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = find-generic-password ] && [ "$3" = agent-hub.clickup ] && [ "$5" = token ]; then echo "${SECRET}"; exit 0; fi\nexit 44\n`,
  );
  return { p, log };
}

test("denyReason: builtin — anything except reserved; installed — only its own namespace; local — nothing", () => {
  assert.equal(denyReason({ source: "builtin", id: "clickup" }, "clickup.token"), null);
  assert.equal(denyReason({ source: "builtin", id: "x" }, "telegram.token"), "reserved");
  assert.equal(denyReason({ source: "installed", id: "clickup" }, "clickup.token"), null);
  assert.equal(denyReason({ source: "installed", id: "evil" }, "clickup.token"), "foreign-namespace");
  assert.equal(denyReason({ source: "local", id: "clickup" }, "clickup.token"), "untrusted");
  assert.equal(denyReason({ source: "builtin", id: "x" }, "no-dot"), "bad-key");
  assert.equal(denyReason({ source: "builtin", id: "x" }, "Upper.token"), "bad-key");
});

test("plugin gets AGENTHUB_SECRET_* from the keychain; the value doesn't reach the log; without a double in test mode — nothing", async () => {
  const bin = tempHome("ah-sec-");
  const plugins = tempHome("ah-secp-");
  const { p: security, log } = fakeSecurity(bin);
  // the plugin prints only the secret's length
  writePlugin(
    plugins,
    "clickup.1h.sh",
    `#!/bin/sh\n# <agenthub.secrets>clickup.token — чтение тикетов</agenthub.secrets>\necho "len \${#AGENTHUB_SECRET_CLICKUP_TOKEN}"\n`,
  );
  writePlugin(plugins, "other.1h.sh", `#!/bin/sh\n# <agenthub.secrets>telegram.token — чужое</agenthub.secrets>\necho "len \${#AGENTHUB_SECRET_TELEGRAM_TOKEN}"\n`);
  const h = await startHub({ pluginsDir: plugins, services: "secrets", overrides: { services: { secrets: { securityPath: security } } } });
  try {
    const st = await waitFor(() => h.core.pluginState("clickup")?.header[0]?.title);
    assert.equal(st, `len ${SECRET.length}`);
    assert.equal(await waitFor(() => h.core.pluginState("other")?.header[0]?.title), "len 0", "telegram is a hub service, not given to the plugin");
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /find-generic-password -s agent-hub\.clickup -a token -w/);
    assert.doesNotMatch(calls, /telegram/);
    const journal = readFileSync(h.config.paths.journal, "utf8");
    assert.doesNotMatch(journal, new RegExp(SECRET));
    assert.match(journal, /"secret-denied"/);
  } finally {
    await h.stop();
    cleanup(bin);
  }

  const h2 = await startHub({ pluginsDir: plugins, services: "secrets" });
  try {
    assert.equal(await waitFor(() => h2.core.pluginState("clickup")?.header[0]?.title), "len 0", "test mode without a double: the keychain isn't read");
  } finally {
    await h2.stop();
    cleanup(plugins);
  }
});
