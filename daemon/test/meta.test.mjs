import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parseFileName, parseInterval, parseMetaText, readPluginMeta, splitWhy, XATTR_NAME } from "../lib/meta.mjs";
import { cleanup, tempHome, writePlugin } from "./helpers.mjs";

test("intervals ms|s|m|h|d", () => {
  assert.equal(parseInterval("500ms"), 500);
  assert.equal(parseInterval("30s"), 30_000);
  assert.equal(parseInterval("2m"), 120_000);
  assert.equal(parseInterval("1h"), 3_600_000);
  assert.equal(parseInterval("1d"), 86_400_000);
  assert.equal(parseInterval("5x"), null);
});

test("file name parsing", () => {
  assert.deepEqual(parseFileName("quota.30s.mjs"), { id: "quota", interval: "30s", intervalMs: 30_000, ext: "mjs" });
  assert.deepEqual(parseFileName("my-runner.30s.mjs"), { id: "my-runner", interval: "30s", intervalMs: 30_000, ext: "mjs" });
  assert.deepEqual(parseFileName("clickup.2m.mjs").intervalMs, 120_000);
  assert.deepEqual(parseFileName("claude-sessions.mjs"), { id: "claude-sessions", interval: null, intervalMs: null, ext: "mjs" });
  assert.equal(parseFileName("a.b.10s.sh").id, "a.b");
  assert.equal(parseFileName("README.md"), null);
  assert.equal(parseFileName(".hidden.5s.sh"), null);
  assert.equal(parseFileName("_draft.5s.sh"), null);
  assert.equal(parseFileName("binary").id, "binary");
});

test("metadata tags, including action with id and level", () => {
  const text = `#!/usr/bin/env node
// <agenthub.title>Quota</agenthub.title>  <agenthub.version>1.0.0</agenthub.version>
// <agenthub.author.github>someone</agenthub.author.github>  <agenthub.platforms>macos, windows</agenthub.platforms>
// <agenthub.type>streamable</agenthub.type>
// <agenthub.watch>~/.claude/cache/usage-cache</agenthub.watch>
// <agenthub.watch>~/.claude/sessions/*.json</agenthub.watch>
// <agenthub.fsRead>~/.claude/cache/usage-cache — кэш квоты</agenthub.fsRead>
// <agenthub.exec>batch-run.mjs status --json — статус прогонов</agenthub.exec>
// <agenthub.secrets>clickup.token — чтение тикетов</agenthub.secrets>
// <agenthub.effects>open.url,cmux.focus</agenthub.effects>
// <agenthub.schedule>*/5 * * * *</agenthub.schedule>
// <agenthub.action id="check" level="confirm">node batch-run.mjs check</agenthub.action>
// <agenthub.action id="ping" level="immediate" title="Пинг">/bin/echo "a b"</agenthub.action>
// <agenthub.action id="bad" level="always">rm</agenthub.action>
// <agenthub.custom>x</agenthub.custom>
`;
  const { meta, warnings } = parseMetaText(text);
  assert.equal(meta.title, "Quota");
  assert.equal(meta.version, "1.0.0");
  assert.equal(meta.author.github, "someone");
  assert.deepEqual(meta.platforms, ["macos", "windows"]);
  assert.equal(meta.type, "streamable");
  assert.deepEqual(meta.watch, ["~/.claude/cache/usage-cache", "~/.claude/sessions/*.json"]);
  assert.deepEqual(meta.effects, ["open.url", "cmux.focus"]);
  assert.equal(meta.schedule, "*/5 * * * *");
  assert.deepEqual(splitWhy(meta.fsRead[0]), { what: "~/.claude/cache/usage-cache", why: "кэш квоты" });
  assert.deepEqual(splitWhy(meta.secrets[0]), { what: "clickup.token", why: "чтение тикетов" });
  assert.equal(meta.actions.length, 2);
  assert.deepEqual(meta.actions[0], { id: "check", level: "confirm", command: "node batch-run.mjs check", title: null, cost: null });
  assert.equal(meta.actions[1].title, "Пинг");
  assert.equal(meta.actions[1].level, "immediate");
  assert.ok(warnings.some((w) => w.includes("bad")));
  assert.equal(meta.extra.custom, "x");
});

test("action without level — confirm by default; unknown type — warning", () => {
  const { meta, warnings } = parseMetaText(`# <agenthub.action id="x">echo</agenthub.action>\n# <agenthub.type>weird</agenthub.type>`);
  assert.equal(meta.actions[0].level, "confirm");
  assert.equal(meta.type, "standard");
  assert.ok(warnings.some((w) => w.includes("weird")));
});

test("binary: metadata from xattr (base64 and text)", () => {
  const dir = tempHome();
  try {
    const p = writePlugin(dir, "bin.10s", "");
    // a pseudo-binary with zero bytes
    execFileSync("/bin/sh", ["-c", `printf 'MZ\\000\\000\\001' > '${p}'`]);
    const tags = "<agenthub.title>Bin</agenthub.title><agenthub.effects>open.url</agenthub.effects>";
    execFileSync("/usr/bin/xattr", ["-w", XATTR_NAME, Buffer.from(tags).toString("base64"), p]);
    let pm = readPluginMeta(p);
    assert.equal(pm.binary, true);
    assert.equal(pm.meta.title, "Bin");
    assert.deepEqual(pm.meta.effects, ["open.url"]);
    execFileSync("/usr/bin/xattr", ["-w", XATTR_NAME, "<agenthub.title>Plain</agenthub.title>", p]);
    pm = readPluginMeta(p);
    assert.equal(pm.meta.title, "Plain");
  } finally {
    cleanup(dir);
  }
});

test("readPluginMeta on a text file", () => {
  const dir = tempHome();
  try {
    const p = writePlugin(dir, "q.30s.sh", "#!/bin/sh\n# <agenthub.title>Q</agenthub.title>\necho hi\n");
    const pm = readPluginMeta(p);
    assert.equal(pm.id, "q");
    assert.equal(pm.intervalMs, 30_000);
    assert.equal(pm.binary, false);
    assert.equal(pm.executable, true);
    assert.equal(pm.meta.title, "Q");
    assert.equal(readPluginMeta(join(dir, "nope.md")), null);
  } finally {
    cleanup(dir);
  }
});

test("parameterized action: arg \"name:^pattern$\"; without anchors, with a bad name or pattern — the action is dropped", async () => {
  const { parseActionArg } = await import("../lib/meta.mjs");
  assert.deepEqual(parseActionArg("taskId:^[A-Za-z0-9_-]{1,64}$"), { name: "taskId", pattern: "^[A-Za-z0-9_-]{1,64}$" });
  for (const bad of ["taskId:[a-z]+", "taskId:^[a-z]+", "taskId:[a-z]+$", "1x:^a$", "taskId:^(a$", "taskId:^a\\$", ":^a$", `x:^${"a".repeat(200)}$`]) {
    assert.equal(parseActionArg(bad), null, bad);
  }
  const { meta, warnings } = parseMetaText(`// <agenthub.action id="ok" arg="id:^[a-z]{1,8}$">p.mjs --action ok {id}</agenthub.action>
// <agenthub.action id="bad" arg="id:.*">p.mjs --action bad</agenthub.action>`);
  assert.deepEqual(meta.actions.map((a) => a.id), ["ok"]);
  assert.deepEqual(meta.actions[0].arg, { name: "id", pattern: "^[a-z]{1,8}$" });
  assert.equal(meta.actions[0].level, "confirm");
  assert.ok(warnings.some((w) => w.startsWith("action bad: arg")));
});

test("plugin push rules: <agenthub.push key hold quiet macOnly cooldown away>Label", () => {
  const { meta, warnings } = parseMetaText(`# <agenthub.push key="unity-open" hold="evening" cooldown="0s">Прогоны не запустятся</agenthub.push>
# <agenthub.push key="crash" quiet="true" macOnly="false" away="5m">Упало</agenthub.push>
# <agenthub.push key="bad key">x</agenthub.push>
# <agenthub.push key="h" hold="morning">x</agenthub.push>
# <agenthub.push key="crash">повтор</agenthub.push>`);
  assert.deepEqual(meta.push, [
    { key: "unity-open", label: "Прогоны не запустятся", hold: "evening", cooldownMs: 0 },
    { key: "crash", label: "Упало", quietException: true, macOnly: false, awayDelayMs: 300_000 },
  ]);
  assert.equal(warnings.length, 3);
});

test("core: argument value — by the pattern in ^(?:…)$, without control characters and \"-…\"", async () => {
  const { checkActionArg } = await import("../lib/core.mjs");
  const spec = { name: "id", pattern: "^[A-Za-z0-9_-]{1,64}$" };
  assert.deepEqual(checkActionArg(spec, "T-1"), { value: "T-1" });
  assert.equal(checkActionArg(spec, "-rf").error, "option-like");
  assert.equal(checkActionArg(spec, "a b").error, "pattern");
  assert.equal(checkActionArg(spec, "").error, "required");
  assert.equal(checkActionArg(spec, undefined).error, "required");
  assert.equal(checkActionArg({ name: "id", pattern: "^.*$" }, "a\nb").error, "control");
  assert.equal(checkActionArg({ name: "id", pattern: "^.*$" }, "x".repeat(300)).error, "too-long");
  // "^a|b$" without the wrapper would let "zzb" through
  assert.equal(checkActionArg({ name: "id", pattern: "^a|b$" }, "zzb").error, "pattern");
  // the author's broad pattern doesn't let C1, bidi overrides, zero-width and line separators through
  const wide = { name: "x", pattern: "^\\S{1,64}$" };
  for (const v of ["ab\u0085cd", "ab\u009bcd", "abc\u202egpj.exe", "a\u200bb", "x\u2066y", "a\u00adb", "a\ufeffb", "a\u2028b", "a\u2029b"]) {
    assert.equal(checkActionArg(wide, v).error, "control", JSON.stringify(v));
  }
  assert.deepEqual(checkActionArg(wide, "задача-1"), { value: "задача-1" }, "ordinary non-ASCII text passes");
});
