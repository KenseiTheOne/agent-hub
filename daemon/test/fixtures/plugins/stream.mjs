// <agenthub.type>streamable</agenthub.type>
// <agenthub.title>Stream</agenthub.title>
import { createInterface } from "node:readline";
let n = 0;
function frame(extra = "") {
  n++;
  process.stdout.write(`Stream ${n} | status=wait\n---\nfrom env: ${process.env.AGENTHUB_PLUGIN_ID}${extra}\n~~~\n`);
}
frame();
createInterface({ input: process.stdin }).on("line", (l) => {
  try {
    const m = JSON.parse(l);
    frame(` got=${m.type}`);
  } catch {}
});
setInterval(() => {}, 1 << 30);
