#!/usr/bin/env node
// Manual check of the hub's Telegram bot: one "connection check" message to the chat_id from the keychain.
// Run only by the user, after setting up the bot and the agent-hub.telegram entries:
//   env -u NODE_OPTIONS node daemon/lib/push/send-test.mjs --yes
// Prints only the result (ok / reason code); the token and chat_id are never printed.

import { execFile } from "node:child_process";
import { createTelegram, DEFAULT_SERVICE } from "./telegram.mjs";
import { defaultHome } from "../config.mjs";
import { msg, setLangSource } from "../i18n.mjs";
import { langForHome } from "../settings.mjs";

// texts in the hub language (the home's settings.json, as the CLI)
setLangSource(() => langForHome(defaultHome()));

if (!process.argv.includes("--yes")) {
  console.error(msg("push.test.confirm"));
  process.exit(2);
}

const exec = (file, args, { timeoutMs = 5000 } = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: String(stdout ?? "") });
    });
  });

const tg = createTelegram({ exec, enabled: true, service: DEFAULT_SERVICE });
if (!(await tg.available())) {
  console.error(msg("push.test.noKeys", { service: DEFAULT_SERVICE }));
  process.exit(1);
}
const r = await tg.send(msg("push.test.text"));
console.log(r.ok ? "ok" : msg("push.test.failed", { reason: r.reason, code: r.code }));
process.exit(r.ok ? 0 : 1);
