#!/usr/bin/env node
// A fake `codex` for tests: `codex app-server` speaks newline-delimited JSON-RPC on stdio like the real one.
// FAKE_CODEX_MODE: ok (default) | nologin | apikey | hang | bad | crash. FAKE_CODEX_LOG — append every method name there.
// FAKE_CODEX_ENV_LOG — append CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED (or "unset") there on every start.
// Answers: FAKE_CODEX_RATE_LIMITS_JSON / FAKE_CODEX_USAGE_JSON (paths), default — the plugin fixtures in plugins/codex-*/fixtures.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const mode = process.env.FAKE_CODEX_MODE || "ok";
if (process.argv[2] !== "app-server") process.exit(2);
if (process.env.FAKE_CODEX_ENV_LOG) appendFileSync(process.env.FAKE_CODEX_ENV_LOG, `${process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED ?? "unset"}\n`);
if (mode === "crash") process.exit(1);
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const DEFAULTS = { "rate-limits.json": join(repo, "plugins", "codex-quota", "fixtures", "rate-limits.json"), "usage.json": join(repo, "plugins", "codex-spend", "fixtures", "usage.json") };
const load = (f) => JSON.parse(readFileSync(process.env[`FAKE_CODEX_${f.replace(/\W/g, "_").toUpperCase()}`] || DEFAULTS[f], "utf8"));
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${m.method}\n`);
  if (mode === "hang") return;
  if (m.method === "initialize") return out({ id: m.id, result: { userAgent: "fake/0.0.0", codexHome: "/nonexistent", platformFamily: "unix", platformOs: "macos" } });
  if (m.id === undefined) return; // notifications
  out({ method: "account/rateLimits/updated", params: {} }); // a notification in between must be ignored
  if (mode === "nologin") return out({ id: m.id, error: { code: -32600, message: "codex account authentication required to read rate limits" } });
  if (mode === "apikey") return out({ id: m.id, error: { code: -32600, message: "chatgpt authentication required to read rate limits" } });
  if (mode === "bad") return out({ id: m.id, result: { rateLimits: { primary: "x" } } });
  if (m.method === "account/rateLimits/read") return out({ id: m.id, result: load("rate-limits.json") });
  if (m.method === "account/usage/read") return out({ id: m.id, result: load("usage.json") });
  out({ id: m.id, error: { code: -32601, message: "unknown method" } });
});
rl.on("close", () => process.exit(0));
