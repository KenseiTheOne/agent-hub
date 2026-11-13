// 13.11: `hub migrate --apply` booted the old daemon out, the single bootstrap right after it failed (launchd still
// removing the job: "Bootstrap failed: 5: Input/output error") and the live hub was left with no daemon. bootstrapJob
// retries for a few seconds and reports the last stderr when it gives up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bootstrapJob, installPlan } from "../lib/launchd.mjs";

const plan = installPlan({ uid: 501, home: "/tmp/h", launchctl: "/bin/false" });
const noSleep = async () => {};

test("bootstrapJob: a bootstrap that fails while launchd still removes the job is retried until it succeeds", async () => {
  const calls = [];
  const run = (argv) => {
    calls.push(argv);
    return calls.length < 3 ? { status: 5, stderr: "Bootstrap failed: 5: Input/output error\n" } : { status: 0, stderr: "" };
  };
  const r = await bootstrapJob(plan, { run, sleep: noSleep });
  assert.deepEqual(r, { ok: true, attempts: 3, why: null });
  assert.deepEqual(calls[0], plan.bootstrap);
});

test("bootstrapJob: gives up after the given tries with the last stderr; the first success needs no retry", async () => {
  let n = 0;
  const failing = await bootstrapJob(plan, { tries: 4, run: () => (n++, { status: 5, stderr: "Bootstrap failed: 5: Input/output error\n" }), sleep: noSleep });
  assert.deepEqual(failing, { ok: false, attempts: 4, why: "Bootstrap failed: 5: Input/output error" });
  assert.equal(n, 4);
  const once = await bootstrapJob(plan, { run: () => ({ status: 0, stderr: "" }), sleep: noSleep });
  assert.equal(once.attempts, 1);
  const silent = await bootstrapJob(plan, { tries: 1, run: () => ({ status: 37, stderr: "" }), sleep: noSleep });
  assert.equal(silent.why, "exit 37");
});
