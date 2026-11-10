// agenthub-hook double for the "hook from a shell without Claude among ancestors" test.
// Waits until it becomes an orphan (ppid=1, ancestors — only launchd), then sends POST /hook and writes the reply to a file.
//   node hook-client.mjs <socket> <out-file>
import { request } from "node:http";
import { writeFileSync } from "node:fs";

const [sock, out] = process.argv.slice(2);
const until = Date.now() + 5000;
while (process.ppid !== 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
const body = JSON.stringify({ session_id: "55555555-5555-4555-8555-555555555555", hook_event_name: "PermissionRequest" });
const r = request({ socketPath: sock, method: "POST", path: "/hook", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
  let s = "";
  res.on("data", (c) => (s += c));
  res.on("end", () => writeFileSync(out, JSON.stringify({ ppid: process.ppid, status: res.statusCode, body: s })));
});
r.on("error", (e) => writeFileSync(out, JSON.stringify({ error: e.message })));
r.end(body);
