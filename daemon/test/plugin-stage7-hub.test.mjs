// The builtin agents plugin (workflow) inside a real core: the host finds it in the folder, the core parses the output.
// hermes and clickup are official registry plugins (agent-hub-plugins), their tests live there, in plugins/<id>/test/.
// HOME is replaced with a synthetic one (os.homedir() reads HOME).
// Run: env -u NODE_OPTIONS node --test test/plugin-stage7-hub.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_DIR } from "../lib/config.mjs";
import { req, startHub, tempHome, waitFor } from "./helpers.mjs";

function syntheticHome() {
  const home = tempHome("ah-s7-");
  // Workflow
  const afix = join(REPO_DIR, "plugins", "agents", "fixtures");
  const sid = "00000000-0000-4000-8000-000000000001";
  const dir = join(home, ".claude", "projects", "-Users-synthetic", sid, "subagents", "workflows", "wf_hub-0001");
  mkdirSync(dir, { recursive: true });
  for (const f of ["journal.jsonl", "agent-a1.jsonl", "agent-a2.jsonl"]) copyFileSync(join(afix, f), join(dir, f));
  mkdirSync(join(home, ".claude", "sessions"), { recursive: true });
  writeFileSync(join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, cwd: "/synthetic" }));
  return home;
}

test("agents under the core: status, spend by requestId, no warnings", async () => {
  const home = syntheticHome();
  const pluginsDir = join(home, "plugins");
  for (const id of ["agents"]) cpSync(join(REPO_DIR, "plugins", id), join(pluginsDir, id), { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = home;
  let hub;
  try {
    hub = await startHub({ pluginsDir });
    const state = await waitFor(async () => {
      const s = (await req(hub.sock, "GET", "/state")).body;
      const ids = Object.fromEntries((s?.plugins || []).map((p) => [p.id, p]));
      return ids.agents?.lastRunAt ? ids : null;
    }, { timeoutMs: 10_000 });

    const a = state.agents;
    assert.equal(a.type, "streamable");
    assert.ok(a.pid, "streamable is running");
    assert.equal(a.status, "ok");
    assert.match(a.header[0].title, /^1 прогон идёт/);
    assert.ok(a.body.some((i) => /5 запросов/.test(i.title)));

    // no warnings about our plugins' output in the journal
    const j = (await req(hub.sock, "GET", "/journal?limit=500")).body.entries;
    const warns = j.filter((e) => e.type === "warning" && e.plugin === "agents");
    assert.deepEqual(warns, []);
    const text = JSON.stringify(state);
    assert.ok(!text.includes("СИНТЕТИЧЕСК"), "conversation text, prompts and errors did not get into the state");
  } finally {
    process.env.HOME = realHome;
    await hub?.stop();
    rmSync(home, { recursive: true, force: true });
  }
});
