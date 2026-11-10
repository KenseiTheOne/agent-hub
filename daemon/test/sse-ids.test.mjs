// SSE event ids: a Last-Event-ID from a previous daemon instance → snapshot, not someone else's tail.

import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startHub } from "./helpers.mjs";

function firstEvents(sock, lastEventId, n = 1) {
  return new Promise((resolve, reject) => {
    const r = request({ socketPath: sock, path: "/events", headers: lastEventId ? { "last-event-id": String(lastEventId) } : {} }, (res) => {
      let buf = "";
      const out = [];
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const id = /^id: (.+)$/m.exec(block)?.[1];
          if (ev) out.push({ ev, id: Number(id) });
          if (out.length >= n) {
            r.destroy();
            resolve(out);
          }
        }
      });
    });
    r.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    r.end();
  });
}

test("SSE: ids start from the startup timestamp; an old Last-Event-ID → snapshot; our own — resend what was missed", async () => {
  const h = await startHub();
  try {
    assert.ok(h.core.seq >= h.core.seqBase && h.core.seqBase > 1e15, "seq starts from the startup timestamp");
    // an id "from a previous instance" (small) — a snapshot
    const [a] = await firstEvents(h.sock, 7);
    assert.equal(a.ev, "snapshot");
    // our own id — the missed events
    const from = h.core.seq;
    h.core.emit({ type: "test.one" });
    h.core.emit({ type: "test.two" });
    const evs = await firstEvents(h.sock, from, 2);
    assert.deepEqual(evs.map((e) => e.ev), ["test.one", "test.two"]);
    assert.equal(evs[0].id, from + 1);
    // an id from the future — also a snapshot
    const [c] = await firstEvents(h.sock, h.core.seq + 1000);
    assert.equal(c.ev, "snapshot");
  } finally {
    await h.stop();
  }
});
