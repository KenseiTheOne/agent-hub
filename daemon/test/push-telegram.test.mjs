// Push: the Telegram module (keychain and fetch are doubles, no network) and the macOS notification (ack / osascript).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegram } from "../lib/push/telegram.mjs";
import { createMacNotifier, osascriptArgs } from "../lib/push/macos.mjs";
import { ack, clearAcks, pendingCount, waitAck } from "../lib/push/acks.mjs";

// Synthetic values of the right shape — not a real bot.
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHAT = "-1001234567890";

function keychain(items) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push({ file, args });
    assert.equal(file, "/usr/bin/security");
    assert.equal(args[0], "find-generic-password", "keychain read only");
    const acc = args[args.indexOf("-a") + 1];
    const svc = args[args.indexOf("-s") + 1];
    const v = items[`${svc}/${acc}`];
    return v === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: `${v}\n` };
  };
  return { exec, calls };
}

function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  f.calls = calls;
  return f;
}

const okRes = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });

test("disabled — doesn't read the keychain or touch the network", async () => {
  const kc = keychain({ "agent-hub.telegram/token": TOKEN, "agent-hub.telegram/chat_id": CHAT });
  const f = fakeFetch(okRes);
  const tg = createTelegram({ exec: kc.exec, fetchImpl: f, enabled: false });
  assert.equal(await tg.available(), false);
  assert.deepEqual(await tg.send("x"), { ok: false, reason: "disabled" });
  assert.equal(kc.calls.length, 0);
  assert.equal(f.calls.length, 0);
});

test("no keychain entries or a wrong format — no-credentials, no network access", async () => {
  for (const items of [{}, { "agent-hub.telegram/token": TOKEN }, { "agent-hub.telegram/token": "не токен", "agent-hub.telegram/chat_id": CHAT }, { "agent-hub.telegram/token": TOKEN, "agent-hub.telegram/chat_id": "12; rm" }]) {
    const kc = keychain(items);
    const f = fakeFetch(okRes);
    const tg = createTelegram({ exec: kc.exec, fetchImpl: f, enabled: true });
    assert.equal(await tg.available(), false);
    assert.equal((await tg.send("x")).reason, "no-credentials");
    assert.equal(f.calls.length, 0);
  }
});

test("sendMessage: URL, body, text only; the result has no secrets", async () => {
  const kc = keychain({ "agent-hub.telegram/token": TOKEN, "agent-hub.telegram/chat_id": CHAT });
  const f = fakeFetch(okRes);
  const tg = createTelegram({ exec: kc.exec, fetchImpl: f, enabled: true });
  const r = await tg.send("Agent Hub · Прогоны\nПрогоны не запустятся");
  assert.deepEqual(r, { ok: true, code: 200 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal(f.calls[0].init.redirect, "error");
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), ["chat_id", "disable_notification", "disable_web_page_preview", "text"]);
  assert.equal(f.calls[0].body.chat_id, CHAT);
  assert.equal(f.calls[0].body.parse_mode, undefined, "no markup: the event text isn't interpreted");
  // the keychain is read by service/account
  assert.deepEqual(kc.calls.map((c) => c.args), [
    ["find-generic-password", "-s", "agent-hub.telegram", "-a", "token", "-w"],
    ["find-generic-password", "-s", "agent-hub.telegram", "-a", "chat_id", "-w"],
  ]);
  await tg.send("ещё");
  assert.equal(kc.calls.length, 2, "secrets are cached, the keychain isn't hit for every message");
  const long = await (async () => {
    await tg.send("x".repeat(5000));
    return f.calls.at(-1).body.text.length;
  })();
  assert.equal(long, 3500);
});

test("errors: 401 resets the cache, 429 with retry_after, network/timeout — no token in the result", async () => {
  const kc = keychain({ "agent-hub.telegram/token": TOKEN, "agent-hub.telegram/chat_id": CHAT });
  let mode = "401";
  const f = fakeFetch(() => {
    if (mode === "401") return { ok: false, status: 401, json: async () => ({}) };
    if (mode === "429") return { ok: false, status: 429, json: async () => ({ parameters: { retry_after: 17 } }) };
    if (mode === "500") return { ok: false, status: 500, json: async () => ({}) };
    if (mode === "timeout") {
      const e = new Error(`timeout https://api.telegram.org/bot${TOKEN}/sendMessage`);
      e.name = "TimeoutError";
      throw e;
    }
    throw new Error(`fetch failed https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });
  const tg = createTelegram({ exec: kc.exec, fetchImpl: f, enabled: true });
  assert.deepEqual(await tg.send("a"), { ok: false, reason: "bad-credentials", code: 401 });
  mode = "429";
  assert.deepEqual(await tg.send("a"), { ok: false, reason: "rate-limited", code: 429, retryAfter: 17 });
  assert.equal(kc.calls.length, 4, "the keychain is re-read after 401");
  mode = "500";
  assert.equal((await tg.send("a")).reason, "http-500");
  mode = "timeout";
  const t = await tg.send("a");
  assert.equal(t.reason, "timeout");
  mode = "net";
  const n = await tg.send("a");
  assert.equal(n.reason, "network");
  for (const r of [t, n]) assert.ok(!JSON.stringify(r).includes(TOKEN));
});

test("osascript: text as arguments, not spliced into the script", () => {
  const args = osascriptArgs({ title: "Agent Hub", subtitle: "Прогоны", body: 'a" & (do shell script "x") & "' });
  assert.deepEqual(args.slice(0, 6), [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)",
    "-e",
    "end run",
  ]);
  assert.equal(args[6], 'a" & (do shell script "x") & "');
  assert.ok(!args.slice(0, 6).join(" ").includes("shell script"));
});

test("macOS: the shell acknowledged — no osascript; no acknowledgement — osascript", async () => {
  const events = [];
  const execs = [];
  const exec = async (file, args) => (execs.push({ file, args }), { code: 0, stdout: "" });
  const emit = (ev) => {
    events.push(ev);
    if (ev.body === "с ответом") setTimeout(() => ack(ev.notifyId), 5);
  };
  const mac = createMacNotifier({ emit, waitAck, exec, ackTimeoutMs: 80 });
  const a = mac.notify({ title: "Agent Hub", subtitle: "S", body: "с ответом", plugin: "p", key: "p:k" });
  assert.deepEqual(await a.done, { channel: "app", ok: true });
  assert.equal(execs.length, 0);
  assert.equal(events[0].type, "push.notify");
  assert.equal(events[0].notifyId, a.notifyId);
  assert.equal(events[0].key, "p:k");
  const b = mac.notify({ title: "Agent Hub", subtitle: "S", body: "без ответа", plugin: "p", key: "p:k2" });
  assert.deepEqual(await b.done, { channel: "osascript", ok: true });
  assert.equal(execs.length, 1);
  assert.equal(execs[0].file, "/usr/bin/osascript");
  assert.equal(execs[0].args[6], "без ответа");
  assert.equal(ack(b.notifyId), false, "an expired acknowledgement does nothing");
  assert.equal(ack("unknown-id-123"), false);
});

test("acks: all pending waits are cleared on stop", async () => {
  const p = waitAck("stop-test-1", 10_000);
  assert.equal(pendingCount(), 1);
  clearAcks();
  assert.equal(await p, false);
  assert.equal(pendingCount(), 0);
});
