// Push channels (G12) and banner actions (G5, the daemon half): delivery goes through a channel set — macOS always, plus the
// channels from services.push.channels (webhook, ntfy) and the ones services register; security banners only to channels marked
// for them; the push.notify of a plugin event carries up to 2 child offers and the event line's href.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accepts, checkChannelUrl, configuredChannel, createChannelSet, parseChannelConfig, payloadOf } from "../lib/push/channels.mjs";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

// A webhook receiver on 127.0.0.1: every POST body (JSON) lands in .got; status — what it answers.
async function receiver(status = 200) {
  const got = [];
  const srv = createServer((req, res) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        got.push({ path: req.url, headers: req.headers, body: JSON.parse(s) });
      } catch {
        got.push({ path: req.url, raw: s });
      }
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { got, url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}

const journal = (home) => readFileSync(join(home, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const PLUGIN = `#!/bin/sh
echo "Runs | status=error"
echo "---"
echo "Run failed on task 3 | event=run-failed href=https://example.com/runs/3"
echo "--Open the log | href=https://example.com/log"
echo "--Not a button (an undeclared effect gets no offer) | effect=open.url https://example.com/dash"
echo "--Dashboard | href=https://example.com/dash"
echo "--Third | href=https://example.com/third"
echo "Bad link | event=bad-link href=javascript:alert(1)"
`;

test("channel config: https anywhere, http only to this Mac, ntfy needs a topic, bad entries are reported by index", () => {
  assert.ok(checkChannelUrl("https://hooks.example.com/x").url);
  assert.ok(checkChannelUrl("http://127.0.0.1:9/x").url);
  assert.ok(checkChannelUrl("http://localhost/x").url);
  assert.ok(checkChannelUrl("http://[::1]:8/x").url);
  assert.equal(checkChannelUrl("http://example.com/x").error, "http-not-local");
  assert.equal(checkChannelUrl("ftp://example.com/x").error, "scheme");
  assert.equal(checkChannelUrl("https://user:pw@example.com/x").error, "credentials-in-url");
  const { channels, invalid } = parseChannelConfig([
    { type: "webhook", url: "https://a.example/hook", events: ["sessions", "mail:*"] },
    { type: "ntfy", url: "https://ntfy.example/topic-1", security: true, id: "phone" },
    { type: "ntfy", url: "https://ntfy.example/" },
    { type: "telegram", url: "https://x.example" },
    { type: "webhook", url: "http://10.0.0.5/x" },
    { type: "webhook", url: "https://b.example", events: "all" },
    { type: "webhook", url: "https://c.example", enabled: false },
  ]);
  assert.deepEqual(channels.map((c) => [c.id, c.type, c.security, c.events]), [
    ["webhook-1", "webhook", false, ["sessions", "mail:*"]],
    ["phone", "ntfy", true, null],
  ]);
  assert.deepEqual(invalid, [
    { index: 2, reason: "ntfy-topic" },
    { index: 3, reason: "type" },
    { index: 4, reason: "http-not-local" },
    { index: 5, reason: "events" },
  ]);
  assert.deepEqual(parseChannelConfig({ type: "webhook" }).invalid, [{ index: -1, reason: "not-a-list" }]);
});

test("routing: security and bannerAlways only to channels marked security; events narrow by kind or key prefix", () => {
  const plain = { events: null, security: false };
  const sec = { events: null, security: true };
  assert.equal(accepts(plain, { kind: "sessions", key: "a:b" }), true);
  assert.equal(accepts(plain, { kind: "security", key: "@hub:x" }), false);
  assert.equal(accepts(plain, { kind: "updates", key: "@hub:app-pin-changed", bannerAlways: true }), false);
  assert.equal(accepts(sec, { kind: "security", key: "@hub:x" }), true);
  const narrow = { events: ["sessions", "mail:*", "digest"], security: false };
  assert.equal(accepts(narrow, { kind: "sessions", key: "x:y" }), true);
  assert.equal(accepts(narrow, { kind: "other", key: "mail:sent" }), true);
  assert.equal(accepts(narrow, { kind: "other", key: "runs:x" }), false);
  assert.equal(accepts(narrow, { digest: true, key: "push:digest" }), true);
  assert.equal(accepts({ events: ["hub"] }, { kind: "updates", key: "@hub:hub-update:1.0" }), true);
  const p = payloadOf({ title: "Agent Hub", subtitle: "S", body: "B", plugin: "p", key: "p:k", kind: "other", href: "https://e.example", actions: [{ offer: "x" }] }, () => 0);
  assert.deepEqual(p, { source: "agent-hub", title: "Agent Hub", subtitle: "S", body: "B", plugin: "p", key: "p:k", kind: "other", digest: false, href: "https://e.example", ts: "1970-01-01T00:00:00.000Z" });
});

test("ntfy: JSON publish to the server root with the topic, title, message and click", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, body: null };
  };
  const ch = configuredChannel({ id: "phone", type: "ntfy", url: "https://ntfy.example/my-topic", events: null, security: false }, { fetchImpl });
  const r = await ch.send(payloadOf({ title: "Agent Hub", subtitle: "Runs", body: "Run failed", key: "runs:x", kind: "other", href: "https://e.example/r" }));
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://ntfy.example/");
  assert.equal(calls[0].opts.redirect, "error");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { topic: "my-topic", title: "Agent Hub · Runs", message: "Run failed", click: "https://e.example/r", tags: ["agent-hub"], priority: 3 });
});

test("channel set: a registered channel gets the payload, a failing one is journaled without its address, mac is always first", async () => {
  const sent = [];
  const logs = [];
  const mac = { notify: (m) => (sent.push(m), { notifyId: "n1", done: Promise.resolve({ channel: "app", ok: true }) }) };
  const set = createChannelSet({ mac, journal: (e) => logs.push(e) });
  const got = [];
  const off = set.register({ id: "pager", security: true, send: async (p) => (got.push(p), { ok: true }) });
  set.register({ id: "broken", send: async () => ({ ok: false, code: "http-500" }) });
  assert.throws(() => set.register({ id: "pager", send: async () => ({ ok: true }) }), /exists/);
  assert.throws(() => set.register({ id: "mac", send: async () => ({ ok: true }) }), /bad-id/);
  const r = set.notify({ title: "Agent Hub", subtitle: "s", body: "b", key: "p:k", kind: "other" });
  assert.equal(r.notifyId, "n1");
  assert.deepEqual(r.channels, ["pager", "broken"]);
  await r.all;
  assert.equal(got[0].body, "b");
  assert.deepEqual(logs.find((e) => e.type === "push-channel-error"), { type: "push-channel-error", channel: "broken", key: "p:k", code: "http-500" });
  // a security banner: only the channel marked security
  const s = set.notify({ title: "Agent Hub", body: "re-pinned", key: "@hub:app-pin-changed", kind: "security", bannerAlways: true });
  assert.deepEqual(s.channels, ["pager"]);
  off();
  assert.deepEqual(set.list().map((c) => c.id), ["mac", "broken"]);
});

test("hub: a plugin event → push.notify with up to 2 child offers and the checked href; the webhook gets the banner text; security banners skip it", async () => {
  const rx = await receiver();
  const secRx = [];
  const plugins = tempHome("ah-pc-");
  writePlugin(plugins, "runs.1h.sh", PLUGIN);
  const h = await startHub({
    pluginsDir: plugins,
    services: "push",
    overrides: { services: { push: { ackTimeoutMs: 100, channels: [{ type: "webhook", url: `${rx.url}/hook?token=SECRET123` }] } } },
  });
  const notes = [];
  h.core.on("push.notify", (ev) => notes.push(ev));
  try {
    h.core.facts.get("push.channels").register({ id: "pager", security: true, send: async (p) => (secRx.push(p), { ok: true }) });
    const ev = await waitFor(() => notes.find((n) => n.key === "runs:run-failed"));
    assert.equal(ev.href, "https://example.com/runs/3");
    assert.equal(ev.actions.length, 2, "at most two buttons");
    assert.deepEqual(ev.actions.map((a) => [a.label, a.level]), [["Open the log", "immediate"], ["Dashboard", "immediate"]]);
    const st = h.core.pluginState("runs");
    const child = st.body.find((i) => i.title === "Open the log");
    assert.equal(ev.actions[0].offer, child.offer.id, "the button is the panel offer");
    assert.equal(st.body[0]._href, undefined, "the event href is not part of /state");
    const bad = await waitFor(() => notes.find((n) => n.key === "runs:bad-link"));
    assert.equal(bad.href, null, "javascript: is not a click target");
    assert.deepEqual(bad.actions, []);
    const hook = await waitFor(() => rx.got.find((g) => g.body?.key === "runs:run-failed"));
    assert.equal(hook.path, "/hook?token=SECRET123");
    assert.equal(hook.body.body, "Run failed on task 3");
    assert.equal(hook.body.href, "https://example.com/runs/3");
    assert.equal(hook.body.actions, undefined, "offer ids stay with the shell");
    await waitFor(() => secRx.find((p) => p.key === "runs:run-failed"));
    // a security banner (the app build re-pinned): the security channel only
    h.core.emit({ type: "app-pin.changed", appPin: { fingerprint: "x" } });
    await waitFor(() => secRx.find((p) => p.key === "@hub:app-pin-changed"));
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!rx.got.some((g) => g.body?.key === "@hub:app-pin-changed"), "a plain webhook never gets a security banner");
    const j = readFileSync(join(h.home, "journal.jsonl"), "utf8");
    assert.ok(!j.includes("SECRET123") && !j.includes(rx.url), "the channel address never reaches the journal");
    assert.ok(journal(h.home).some((e) => e.type === "push-sent" && e.key === "runs:run-failed" && e.also?.includes("webhook-1")));
  } finally {
    await h.stop();
    await rx.close();
    cleanup(plugins);
  }
});

test("hub: a local (untrusted) plugin's banner gets no buttons and no click target; a failing webhook is journaled by code", async () => {
  const rx = await receiver(500);
  const h = await startHub({
    services: "push",
    configFile: () => ({}),
    overrides: { services: { push: { ackTimeoutMs: 100, channels: [{ type: "webhook", url: `${rx.url}/x`, id: "ops" }] } } },
  });
  const notes = [];
  h.core.on("push.notify", (ev) => notes.push(ev));
  try {
    writePlugin(join(h.home, "Plugins", "local"), "loc.1h.sh", PLUGIN);
    h.core.host.rescan?.();
    const ev = await waitFor(() => notes.find((n) => n.key === "loc:run-failed"), { timeoutMs: 8000 });
    assert.deepEqual([ev.actions, ev.href], [[], null]);
    await waitFor(() => journal(h.home).find((e) => e.type === "push-channel-error" && e.channel === "ops" && e.code === "http-500"));
  } finally {
    await h.stop();
    await rx.close();
  }
});
