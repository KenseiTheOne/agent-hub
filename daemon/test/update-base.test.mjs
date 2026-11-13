// 13.11: after `hub migrate` the hub ran 0.1.2-dev.52e4996 (built after the 0.1.2 release) and offered v0.1.2 — older
// code — as an update, because semver puts X.Y.Z-dev before X.Y.Z. A dev build now compares as its VERSION.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, updateBaseOf } from "../lib/version.mjs";

test("updateBaseOf: a dev build compares as its VERSION — the same tag is not newer, the next one is", () => {
  assert.equal(updateBaseOf("0.1.2-dev.52e4996"), "0.1.2");
  assert.equal(updateBaseOf("0.1.2-dev.52e4996.dirty"), "0.1.2");
  assert.equal(compareVersions("0.1.2", updateBaseOf("0.1.2-dev.52e4996")), 0, "v0.1.2 is not an update");
  assert.equal(compareVersions("0.1.3", updateBaseOf("0.1.2-dev.52e4996")), 1, "v0.1.3 is");
  // release and pre-release labels stay as they are
  assert.equal(updateBaseOf("0.1.3"), "0.1.3");
  assert.equal(updateBaseOf("0.2.0-rc.1"), "0.2.0-rc.1");
  assert.equal(updateBaseOf("0.1.2-dev.XYZ"), "0.1.2-dev.XYZ");
  assert.equal(updateBaseOf(null), null);
});
