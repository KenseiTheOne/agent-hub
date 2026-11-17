// The frame-rate limit of streamable plugins (core.streamFrame, plugins.maxFramesPerSec): a plugin that floods stdout cannot
// make the daemon parse every frame — frames above the limit are coalesced (the latest one is applied), and the journal gets
// one plugin-throttled line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanup, startHub, tempHome, waitFor, writePlugin } from "./helpers.mjs";

// A quiet streamable plugin: one frame, then it waits on stdin.
const QUIET = `#!/bin/sh
# <agenthub.title>Stream</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
echo "first | status=ok"; echo "~~~"
while IFS= read -r line; do :; done
`;
// A flood: N frames as fast as the shell prints them, then the last one.
const flood = (n) => `#!/bin/sh
# <agenthub.title>Flood</agenthub.title>
# <agenthub.type>streamable</agenthub.type>
i=0
while [ $i -lt ${n} ]; do echo "F$i | status=ok"; echo "~~~"; i=$((i+1)); done
echo "LAST | status=ok"; echo "~~~"
while IFS= read -r line; do :; done
`;

async function hub(script, plugins = {}) {
  const dir = tempHome("ah-ft-");
  writePlugin(dir, "s.sh", script);
  const h = await startHub({ pluginsDir: dir, overrides: { plugins } });
  h.dir = dir;
  // every frame that is really parsed
  h.applied = [];
  const apply = h.core.applyFrame.bind(h.core);
  h.core.applyFrame = (id, text, opts) => {
    h.applied.push(text.split("\n")[0]);
    return apply(id, text, opts);
  };
  h.title = () => h.core.pluginState("s")?.header?.[0]?.title ?? null;
  h.throttled = () => h.core.journal.tail(500).filter((e) => e.type === "plugin-throttled");
  h.end = async () => {
    await h.stop();
    cleanup(dir);
  };
  return h;
}
const frame = (title) => `${title} | status=ok\n`;

test("streamFrame: a burst within the limit is applied frame by frame; above it only the latest frame is, with one journal line", async () => {
  const h = await hub(QUIET, { maxFramesPerSec: 10 });
  try {
    await waitFor(() => h.title() === "first");
    // a quiet second: the bucket is full again
    await new Promise((r) => setTimeout(r, 1100));
    h.applied.length = 0;
    for (let i = 0; i < 5; i++) h.core.streamFrame("s", frame(`b${i}`));
    assert.deepEqual(h.applied, ["b0 | status=ok", "b1 | status=ok", "b2 | status=ok", "b3 | status=ok", "b4 | status=ok"], "a short burst is not slowed down");
    assert.equal(h.throttled().length, 0);

    for (let i = 0; i < 300; i++) h.core.streamFrame("s", frame(`f${i}`));
    assert.ok(h.applied.length <= 5 + 6, `only what was left of the burst is applied at once: ${h.applied.length}`);
    assert.notEqual(h.title(), "f299");
    // the latest frame is not lost: it is applied when the next slot frees
    await waitFor(() => h.title() === "f299", { timeoutMs: 3000, stepMs: 10 });
    assert.ok(h.applied.length <= 5 + 7, `300 frames, ${h.applied.length} parsed`);
    assert.ok(!h.applied.includes("f150 | status=ok"), "the frames in between are dropped");
    const t = h.throttled();
    assert.equal(t.length, 1, "one journal line, not one per dropped frame");
    assert.deepEqual([t[0].plugin, t[0].maxFramesPerSec, t[0].dropped], ["s", 10, 1]);
    // more of the same within the minute adds no line
    for (let i = 0; i < 300; i++) h.core.streamFrame("s", frame(`g${i}`));
    await waitFor(() => h.title() === "g299", { timeoutMs: 3000, stepMs: 10 });
    assert.equal(h.throttled().length, 1);
    // a minute later: one more line, with the number dropped since the first
    h.core.frameRate.get("s").notedAt -= 61_000;
    for (let i = 0; i < 50; i++) h.core.streamFrame("s", frame(`h${i}`));
    const again = h.throttled();
    assert.equal(again.length, 2);
    assert.ok(again[1].dropped > 500, String(again[1].dropped));
  } finally {
    await h.end();
  }
});

test("a streamable plugin that floods stdout: the daemon parses a bounded number of frames and ends on the last one", async () => {
  const N = 4000;
  const h = await hub(flood(N), { maxFramesPerSec: 10 });
  try {
    const t0 = Date.now();
    await waitFor(() => h.title() === "LAST", { timeoutMs: 30_000, stepMs: 20, label: "the last frame is applied" });
    const sec = (Date.now() - t0) / 1000;
    // a second's burst + 10 a second while it lasted (+ the last one)
    assert.ok(h.applied.length <= 10 + Math.ceil(sec * 10) + 3, `${N} frames in ${sec.toFixed(1)} s, ${h.applied.length} parsed`);
    assert.ok(h.applied.length < N / 10);
    assert.equal(h.throttled().length, 1);
    assert.equal(h.throttled()[0].plugin, "s");
    assert.equal(h.core.pluginState("s").status, "ok");
  } finally {
    await h.end();
  }
});

test("a frame held back by the limit is applied before the process's exit is handled, and dropped with the plugin", async () => {
  const h = await hub(QUIET, { maxFramesPerSec: 2 });
  try {
    await waitFor(() => h.title() === "first");
    for (let i = 0; i < 6; i++) h.core.streamFrame("s", frame(`x${i}`));
    assert.notEqual(h.title(), "x5");
    h.core.pluginExited("s", { code: 1, signal: null, error: null });
    const st = h.core.pluginState("s");
    assert.deepEqual([st.header[0].title, st.status], ["x5", "error"], "the last words first, then the failure");
    assert.equal(h.applied.at(-1), "x5 | status=ok");
    // nothing is applied later on top of the failure
    const n = h.applied.length;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(h.applied.length, n);
    // a plugin that is removed takes its waiting frame with it
    for (let i = 0; i < 6; i++) h.core.streamFrame("s", frame(`y${i}`));
    assert.ok(h.core.frameRate.get("s").pending);
    h.core.pluginRemoved("s");
    assert.equal(h.core.frameRate.has("s"), false);
  } finally {
    await h.end();
  }
});

test("plugins.maxFramesPerSec = 0 switches the limit off", async () => {
  const h = await hub(QUIET, { maxFramesPerSec: 0 });
  try {
    await waitFor(() => h.title() === "first");
    h.applied.length = 0;
    for (let i = 0; i < 200; i++) h.core.streamFrame("s", frame(`f${i}`));
    assert.equal(h.applied.length, 200);
    assert.equal(h.throttled().length, 0);
  } finally {
    await h.end();
  }
});
