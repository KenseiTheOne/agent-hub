// Contract 3 is frozen (2026-11-12, docs/extension-points.md "Contract 3 is frozen"): the version stays 3, and every
// registry contract feature — an optional contract 3 item an older hub would run wrongly — is named in that paragraph.
// A failure here means a contract change: either it belongs to contract 4, or the paragraph must name the new feature.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION } from "../lib/meta.mjs";
import { CONTRACT_FEATURES } from "../lib/registry/perms.mjs";

const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs/extension-points.md"), "utf8");
const frozen = doc.slice(doc.indexOf("**Contract 3 is frozen"), doc.indexOf("**Contract 3 and version 2 hubs.**"));

test("contract 3 is frozen: the version stays 3 until contract 4 is opened deliberately", () => {
  assert.equal(CONTRACT_VERSION, 3, "a contract bump: open contract 4 in docs/extension-points.md and update this test");
  assert.ok(frozen.length > 0, "the 'Contract 3 is frozen' paragraph is missing");
});

test("contract 3 is frozen: every registry contract feature is named in the freeze paragraph", () => {
  for (const f of CONTRACT_FEATURES) assert.ok(frozen.includes("`" + f + "`"), `feature ${f} is not named in "Contract 3 is frozen"`);
});
