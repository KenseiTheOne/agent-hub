// Services that fetch a file for plugins from the network (usage, models) poll only while a running trusted plugin declares
// reading or watching it (core.pluginEnvWanted, services/_on-demand.mjs). Doubles only: a fake `security` and our own HTTP
// server on 127.0.0.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

const TOKEN = "sk-ant-oat01-SYNTHETIC-demand-0123456789";

function fakeSecurity(dir) {
  const out = join(dir, "cred.json");
  writeFileSync(out, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 } }));
  return writePlugin(dir, "security", `#!/bin/sh\nif [ "$1" = find-generic-password ] && [ "$4" = -w ]; then cat "${out}"; exit 0; fi\nexit 44\n`);
}

async function fakeApi(body) {
  const seen = [];
  const srv = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}/x`, seen, close: () => new Promise((r) => srv.close(r)) };
}

const reader = (title, name) => `#!/bin/sh
# <agenthub.title>${title}</agenthub.title>
# <agenthub.fsRead>$${name} — the cache this plugin shows</agenthub.fsRead>
echo '${title} | status=ok'
`;
const journalTypes = (h, type) =>
  readFileSync(h.config.paths.journal, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === type);

for (const [svc, envName, body] of [
  ["usage", "AGENTHUB_USAGE_FILE", { limits: [{ kind: "session", group: "session", percent: 5 }] }],
  ["models", "AGENTHUB_CLAUDE_MODELS_FILE", { data: [{ id: "claude-x", display_name: "X" }] }],
]) {
  test(`${svc} service polls only while a running trusted plugin reads ${envName}: off → no requests, on → polls, off again → stops`, { timeout: 20_000 }, async () => {
    const bin = tempHome("ah-dm-");
    const plugins = tempHome("ah-dmp-");
    const sec = fakeSecurity(bin);
    const api = await fakeApi(body);
    writePlugin(plugins, "reader.1h.sh", reader("Reader", envName));
    writePlugin(plugins, "other.1h.sh", `#!/bin/sh\n# <agenthub.title>Other</agenthub.title>\necho 'Other | status=ok'\n`);
    const h = await startHub({
      pluginsDir: plugins,
      services: svc,
      settingsFile: { builtinOff: ["reader"] },
      overrides: { services: { [svc]: { securityPath: sec, url: api.url, firstDelayMs: 10, intervalMs: 100, backoffCapMs: 100 } } },
    });
    try {
      await waitFor(() => h.core.pluginState("other")?.status === "ok");
      // nobody reads the file: the variable is still given, but no requests
      assert.equal(h.core.pluginEnvFor({ source: "builtin" })[envName], join(h.home, "Cache", svc === "usage" ? "usage.json" : "models.json"));
      assert.equal(h.core.pluginEnvWanted(envName), false);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(api.seen.length, 0);
      assert.deepEqual(journalTypes(h, `${svc}-demand`).map((e) => e.polling), [false]);
      // the reader is turned on — polling starts
      await h.core.setBuiltinEnabled("reader", true, null);
      assert.equal(h.core.pluginEnvWanted(envName), true);
      await waitFor(() => api.seen.length >= 2, { timeoutMs: 5000 });
      // turned off again — polling stops
      await h.core.setBuiltinEnabled("reader", false, null);
      await new Promise((r) => setTimeout(r, 150));
      const n = api.seen.length;
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(api.seen.length, n);
      assert.deepEqual(journalTypes(h, `${svc}-demand`).map((e) => e.polling), [false, true, false]);
    } finally {
      await h.stop();
      await api.close();
      cleanup(bin);
      cleanup(plugins);
    }
  });
}

test("pluginEnvWanted: only trusted running plugins count; $NAME and ${NAME}; a longer name doesn't match", async () => {
  const plugins = tempHome("ah-dmw-");
  writePlugin(plugins, "braced.1h.sh", `#!/bin/sh\n# <agenthub.watch>\${AGENTHUB_USAGE_FILE} — fresh quota</agenthub.watch>\necho 'B | status=ok'\n`);
  writePlugin(plugins, "longer.1h.sh", `#!/bin/sh\n# <agenthub.fsRead>$AGENTHUB_CLAUDE_MODELS_FILE_X — not the same</agenthub.fsRead>\necho 'L | status=ok'\n`);
  const h = await startHub({ pluginsDir: plugins });
  try {
    await waitFor(() => h.core.pluginState("braced") && h.core.pluginState("longer"));
    assert.equal(h.core.pluginEnvWanted("AGENTHUB_USAGE_FILE"), true);
    assert.equal(h.core.pluginEnvWanted("AGENTHUB_CLAUDE_MODELS_FILE"), false);
    assert.equal(h.core.pluginEnvWanted("not a name"), false);
    // a local (untrusted) plugin reading the file does not count
    h.core.pluginMeta.set("loc", { id: "loc", source: "local", meta: { fsRead: ["$AGENTHUB_CLAUDE_MODELS_FILE — x"] } });
    assert.equal(h.core.pluginEnvWanted("AGENTHUB_CLAUDE_MODELS_FILE"), false);
    h.core.pluginMeta.delete("loc");
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});
