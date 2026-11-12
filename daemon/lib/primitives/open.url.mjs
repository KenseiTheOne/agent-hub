// The open.url primitive — open a web link in the default browser.
// A sample primitive (the contract is in docs/extension-points.md).
// Only http/https: no file:, javascript:, agenthub:, x-apple-… or other schemes.

import { t } from "../i18n.mjs";
import { openCommand } from "../platform.mjs";

export const name = "open.url";
export const level = "immediate";
export const remoteAllowed = false;
export const safeUnderEstop = true;

export const argsSchema = {
  url: { type: "string", required: true, positional: true, maxLength: 4096 },
};

export function verifyFacts(args) {
  let u;
  try {
    u = new URL(args.url);
  } catch {
    return { ok: false, reason: "bad-url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "credentials-in-url" };
  return { ok: true };
}

// The same check when a plugin's frame offers the link (href=, effect="open.url …", task 71): a link that can never open gets
// no button — the core warns the author instead.
export function checkOffer(args) {
  return verifyFacts(args);
}

export function describe(args, facts, lang = "ru") {
  let host = "";
  try {
    host = new URL(args.url).host;
  } catch {}
  return { text: t(lang, "prim.open.url", { host }), cost: null };
}

export async function run(args, ctx) {
  const [file, ...argv] = openCommand(new URL(args.url).href);
  const r = await ctx.exec(file, argv);
  return { ok: r.code === 0, code: r.code };
}
