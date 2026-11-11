// Push: the service in a real core (the daemon inside the test process, AGENTHUB_HOME in a temporary directory).
// No external programs run: ctx.exec writes calls to exec.log (AGENTHUB_TEST_EXEC_LOG).
// macOS banners are the only channel; keys of services.push the service doesn't know are ignored (push-config-ignored).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { req, startHub, tempHome, cleanup, waitFor, writePlugin } from "./helpers.mjs";

// Hub notification: the subtitle is the gist (the label), the body is the detail; the full text is "subtitle: body"
const bannerText = (c) => (c.args[8] ? `${c.args[8]}: ${c.args[6]}` : c.args[6]);

const APP = "/Applications/AgentHub.app/Contents/MacOS/AgentHub";

function execLog(home) {
  const f = join(home, "exec.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const PLUGIN = (withEvent) => `#!/bin/sh
# <agenthub.title>Прогоны</agenthub.title>
# <agenthub.push key="runner-crashed" quiet="true">Раннер упал</agenthub.push>
echo "Прогоны | status=${withEvent ? "error" : "ok"}"
echo "---"
${withEvent ? 'echo "Прогон упал на задаче 3 | event=runner-crashed"' : 'echo "Всё спокойно"'}
`;

// System double: any connection is the state.who process (app | cli).
function sysAs(state) {
  const procs = { 10: { ppid: 1, path: APP }, 20: { ppid: 1, path: "/usr/bin/curl" } };
  const pidOf = { app: 10, cli: 20 };
  return {
    available: true,
    peerPid: () => pidOf[state.who],
    peerUid: () => 501,
    pidPath: (pid) => procs[pid]?.path ?? null,
    pidInfo: (pid) => (procs[pid] ? { pid, ppid: procs[pid].ppid, uid: 501, startSec: 1, startUsec: 0 } : null),
    procArgv: () => null,
    codesignVerify: async (path) => path === APP,
    fileId: (p) => p,
    myUid: () => 501,
    readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
  };
}

test("plugin event → push.notify, no ack — osascript; an old channel key in config.json is ignored with one journal line", async () => {
  const plugins = tempHome("ah-pp-");
  writePlugin(plugins, "batch.1h.sh", PLUGIN(true));
  const h = await startHub({
    pluginsDir: plugins,
    services: "push",
    overrides: { services: { push: { ackTimeoutMs: 100, telegram: { enabled: true, keychainService: "agent-hub.telegram" } } } },
  });
  try {
    const osa = await waitFor(() => execLog(h.home).find((c) => c.file === "/usr/bin/osascript"));
    // body — the detail, label — in the subtitle next to the plugin name (no "<label>: …" in the body)
    assert.equal(osa.args[6], "Прогон упал на задаче 3");
    assert.equal(osa.args[7], "Agent Hub");
    assert.equal(osa.args[8], "Прогоны · Раннер упал");
    const log = execLog(h.home);
    assert.ok(log.some((c) => c.file === "/usr/sbin/ioreg"), "idle time is asked from ioreg");
    assert.ok(!log.some((c) => c.file === "/usr/bin/security"), "the keychain is not read in test mode");
    const notify = h.core.recent.find((e) => e.type === "push.notify");
    assert.ok(notify, "push.notify went to the bus (and to SSE)");
    assert.equal(notify.source, "service:push");
    assert.equal(notify.key, "batch:runner-crashed");
    const j = h.core.journal.tail(200);
    const start = j.find((e) => e.type === "push-start");
    assert.ok(start && !("telegram" in start));
    // the removed channel's key from an older config.json: ignored, one line, no error
    assert.deepEqual(j.filter((e) => e.type === "push-config-ignored").map((e) => e.keys), [["services.push.telegram"]], "one line, no error");
    assert.ok(j.some((e) => e.type === "push-sent" && e.channel === "mac" && e.key === "batch:runner-crashed"));
    // state — 0600
    const st = join(h.home, "push-state.json");
    await waitFor(() => existsSync(st));
    assert.equal(statSync(st).mode & 0o777, 0o600);
    // restarting the plugin with the same event — no repeat
    await h.core.host.refresh("batch", "Manual");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(execLog(h.home).filter((c) => c.file === "/usr/bin/osascript").length, 1);
    // event cleared
    writePlugin(plugins, "batch.1h.sh", PLUGIN(false));
    await h.core.host.refresh("batch", "Manual");
    await waitFor(() => h.core.recent.some((e) => e.type === "event.cleared" && e.key === "batch:runner-crashed"));
    const { _engine } = await import("../lib/services/push.mjs");
    await _engine().idle();
    assert.equal(_engine().entries.get("batch:runner-crashed").active, false);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("POST /push/ack: from app it suppresses osascript; from cli — 403 unless allowed by a setting", async () => {
  const plugins = tempHome("ah-pa-");
  writePlugin(plugins, "batch.1h.sh", PLUGIN(true));
  const state = { who: "app" };
  const acks = [];
  const h = await startHub({
    pluginsDir: plugins,
    services: "none",
    sys: sysAs(state),
    overrides: {
      requirements: { app: 'identifier "com.kensei.agenthub" and certificate leaf = H"aa"' },
      services: { push: { ackTimeoutMs: 400 } },
    },
  });
  try {
    h.core.on("push.notify", (ev) => {
      req(h.sock, "POST", "/push/ack", { id: ev.notifyId }).then((r) => acks.push(r));
    });
    h.core.config.servicesFilter = "push";
    await h.core.startServices(join(import.meta.dirname, "..", "lib", "services"));
    await waitFor(() => acks.length === 1);
    assert.equal(acks[0].status, 200);
    assert.deepEqual(acks[0].body, { ok: true });
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(!execLog(h.home).some((c) => c.file === "/usr/bin/osascript"), "the shell showed it itself — no duplicate");

    state.who = "cli";
    const denied = await req(h.sock, "POST", "/push/ack", { id: "abcdefgh-1234" });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "peer:cli");
    h.core.config.services.push.acceptCliAck = true;
    const allowed = await req(h.sock, "POST", "/push/ack", { id: "abcdefgh-1234" });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, { ok: false }, "unknown id — nothing acknowledged");
    const bad = await req(h.sock, "POST", "/push/ack", { id: "x" });
    assert.equal(bad.status, 400);
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("service disabled by a setting — does not start", async () => {
  const plugins = tempHome("ah-po-");
  writePlugin(plugins, "batch.1h.sh", PLUGIN(true));
  const h = await startHub({ pluginsDir: plugins, services: "push", overrides: { services: { push: { enabled: false } } } });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!h.core.journal.tail(100).some((e) => e.type === "push-start"));
    assert.ok(!existsSync(join(h.home, "push-state.json")));
  } finally {
    await h.stop();
    cleanup(plugins);
  }
});

test("approval pause (hook.paused) → a \"replies paused\" push from the hub; cleared when the pause ends", async () => {
  const h = await startHub({ services: "push", overrides: { services: { push: { ackTimeoutMs: 100 } } } });
  try {
    const until = new Date(Date.now() + 400).toISOString();
    h.core.emit({ type: "hook.paused", until, limit: 10 });
    const osa = await waitFor(() => execLog(h.home).find((c) => c.file === "/usr/bin/osascript"));
    assert.match(bannerText(osa), /^Ответы из хаба приостановлены/);
    const { _engine } = await import("../lib/services/push.mjs");
    await _engine().idle();
    assert.equal(_engine().entries.get("@hub:approvals-paused").active, true);
    await waitFor(() => _engine().entries.get("@hub:approvals-paused")?.active === false, 3000);
  } finally {
    await h.stop();
  }
});

test("service: writing an own plugin bypassing the manager (plugins.own-unexpected) — security exception @hub:plugin-own-unexpected:<id>", async () => {
  const h = await startHub({ services: "push" });
  try {
    const { _engine } = await import("../lib/services/push.mjs");
    h.core.emit({ type: "plugins.own-unexpected", plugin: "evil", version: "1.0.0" });
    h.core.emit({ type: "plugins.own-unexpected", plugin: "../bad" });
    await waitFor(() => _engine()?.entries.has("@hub:plugin-own-unexpected:evil"));
    await _engine().idle();
    assert.equal([..._engine().entries.keys()].filter((k) => k.includes("plugin-own-unexpected")).length, 1, "invalid id is dropped");
  } finally {
    await h.stop();
  }
});

test("service: an own plugin updated from its folder (plugins.own-updated) — \"Plugin updated\" banner, kind updates; a rebuilt same version says so", async () => {
  const h = await startHub({ services: "push", overrides: { services: { push: { ackTimeoutMs: 100 } } } });
  try {
    const { _engine } = await import("../lib/services/push.mjs");
    h.core.emit({ type: "plugins.own-updated", plugin: "mine", from: "1.0.0", version: "1.1.0", files: ["mine.5m.sh"] });
    h.core.emit({ type: "plugins.own-updated", plugin: "../bad", version: "1.0.0" });
    const osa = await waitFor(() => execLog(h.home).find((c) => c.file === "/usr/bin/osascript" && /обновлён до/.test(bannerText(c))));
    assert.equal(bannerText(osa), "Плагин обновлён: «mine» обновлён до 1.1.0");
    assert.ok(h.core.recent.some((e) => e.type === "push.notify" && e.key === "@hub:plugin-own-updated:mine:1.1.0"), "through the shell first, like other update notifications");
    // the same version rebuilt from the folder: announced again (no flapping window), and the text says the version stayed
    h.core.emit({ type: "plugins.own-updated", plugin: "mine", from: "1.1.0", version: "1.1.0" });
    const again = await waitFor(() => execLog(h.home).find((c) => c.file === "/usr/bin/osascript" && /из своей папки/.test(bannerText(c))));
    assert.equal(bannerText(again), "Плагин обновлён: «mine» обновлён из своей папки (версия 1.1.0)");
    await _engine().idle();
    assert.equal([..._engine().entries.keys()].filter((k) => k.includes("plugin-own-updated")).length, 1, "invalid id is dropped");
    assert.equal(h.core.journal.tail(200).filter((e) => e.type === "push-sent" && e.rule === "plugin-own-updated").length, 2);
  } finally {
    await h.stop();
  }
});

test("service: hub-update.failed with a tampering sign (commit-mismatch) raises hub-update-suspect, an ordinary failure — hub-update-failed", async () => {
  const h = await startHub({ services: "push" });
  try {
    const { _engine } = await import("../lib/services/push.mjs");
    h.core.emit({ type: "hub-update.failed", label: "0.3.0", error: "hub-update:commit-mismatch" });
    h.core.emit({ type: "hub-update.failed", label: "0.3.1", error: "hub-update:build-failed" });
    await waitFor(() => _engine()?.entries.has("@hub:hub-update-failed:0.3.1"));
    await _engine().idle();
    assert.ok(_engine().entries.has("@hub:hub-update-suspect:0.3.0"));
    assert.ok(!_engine().entries.has("@hub:hub-update-failed:0.3.0"));
  } finally {
    await h.stop();
  }
});
