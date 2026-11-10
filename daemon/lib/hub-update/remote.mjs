// Hub releases in origin: `git ls-remote --tags <origin>` with the user's credentials (git keychain;
// no tokens of our own). A release is a vMAJOR.MINOR.PATCH tag (pre-release only via a setting). In tests origin is
// a local bare repository.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitCommand } from "../platform.mjs";
import { msg } from "../i18n.mjs";
import { compareVersions, tagVersion } from "../version.mjs";

export const GIT = gitCommand();

// git environment without terminal prompts: the keychain (credential helper) works, nobody gets asked for a password.
export function gitEnv(base = process.env) {
  const e = { ...base, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" };
  delete e.NODE_OPTIONS;
  delete e.GIT_ASKPASS;
  delete e.SSH_ASKPASS;
  return e;
}

// Credentials in the URL (https://user:token@host/…) are never written anywhere: not to the build log, argv, the journal
// or build.json. → the URL with "***" instead of user and password (or as is, if it's not a URL with userinfo).
// Exception — ssh: in ssh://git@host/… a lone user name without a password isn't a secret (like the scp form git@host:path),
// we don't hide it and don't refuse because of it; a password in an ssh URL is a secret, as everywhere.
const SSH_SCHEME = /^(ssh|git\+ssh|ssh\+git):$/i;
export function hasUserinfo(remote) {
  try {
    const u = new URL(String(remote));
    if (u.password) return true;
    return Boolean(u.username) && !SSH_SCHEME.test(u.protocol);
  } catch {
    return false;
  }
}
export function redactUrl(remote) {
  if (typeof remote !== "string") return remote;
  try {
    const u = new URL(remote);
    if (!u.username && !u.password) return remote;
    const ssh = SSH_SCHEME.test(u.protocol);
    if (ssh && !u.password) return remote;
    if (u.username && !ssh) u.username = "***";
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return remote;
  }
}
// A URL from build.json.origin is fit for checking only if it isn't redacted (builds before 2026-11-07 wrote
// ssh://***@host/…: connecting as user "***" is pointless — an honest "origin unknown" is better).
export function usableOrigin(s) {
  return typeof s === "string" && s && !s.includes("***") ? s : null;
}
// Any string (command, git message): URLs like scheme://user:pass@ → scheme://***@ (ssh://user@ without a password
// stays as is: an ssh user name isn't a secret)
export function redactText(s) {
  return String(s).replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(:[^/@\s]*)?@/gi, (m, scheme, _user, pass) => (!pass && /^(ssh|git\+ssh|ssh\+git):\/\/$/i.test(scheme) ? m : `${scheme}***@`));
}

// ls-remote output → [{tag, version, commit, annotated, object}]. For an annotated tag the commit comes from the line
// "<sha> refs/tags/<t>^{}", and object is the sha of the tag object itself (release notes are cached by it).
export function parseLsRemote(text) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = /^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim());
    if (!m) continue;
    (m[3] ? peeled : direct).set(m[2], m[1]);
  }
  const out = [];
  for (const [tag, sha] of direct) {
    const version = tagVersion(tag);
    if (!version) continue;
    const annotated = peeled.has(tag);
    out.push({ tag, version, commit: peeled.get(tag) || sha, annotated, object: annotated ? sha : null });
  }
  return out;
}

// The highest release strictly newer than current. prerelease = false — tags with "-…" aren't considered. maxMajor — tags with
// a major number above it aren't considered (a junk v999.0.0 doesn't shadow real releases; a jump of more
// than one major version only via a setting).
export function latestRelease(tags, current, { prerelease = false, maxMajor = null } = {}) {
  let best = null;
  for (const t of tags || []) {
    if (!prerelease && t.version.includes("-")) continue;
    if (Number.isInteger(maxMajor) && majorOf(t.version) > maxMajor) continue;
    if (best && compareVersions(t.version, best.version) <= 0) continue;
    best = t;
  }
  if (!best) return null;
  const c = compareVersions(best.version, current);
  return c === null || c > 0 ? best : null;
}

export function majorOf(v) {
  const m = /^(\d+)\./.exec(String(v || ""));
  return m ? Number(m[1]) : null;
}

// → Promise<[{tag, version, commit}]>; error — { code: "hub-update:remote", detail }.
export function listTags({ remote, git = GIT, timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof remote !== "string" || !remote) return reject(Object.assign(new Error(msg("hub.detail.noOrigin")), { code: "hub-update:not-configured" }));
    // git would take a URL like "-…" for an option
    if (remote.startsWith("-")) return reject(Object.assign(new Error(msg("hub.detail.originAddress")), { code: "hub-update:remote", detail: "bad remote" }));
    execFile(git, ["ls-remote", "--tags", remote], { timeout: timeoutMs, env: gitEnv(env), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const first = redactText(String(stderr || err.message || "").trim().split("\n")[0]).slice(0, 200);
        return reject(Object.assign(new Error(first), { code: err.killed ? "hub-update:remote-timeout" : "hub-update:remote", detail: first }));
      }
      resolve(parseLsRemote(stdout));
    });
  });
}

// Release notes are the annotated tag's message, without tokens or an API: `git fetch` of one tag (depth 1, no
// trees if the server supports filtering) into a temporary service bare repository in <dir>, then the subject and body
// of the message (git strips the PGP signature itself: %(contents:body) doesn't include it). object is the tag object sha from
// ls-remote: the mirror must hold exactly that one (the tag wasn't rewritten in between). A lightweight tag — null (no notes).
// → Promise<{subject, body} | null>; error — { code: "hub-update:notes", detail }.
export const NOTES_LIMITS = Object.freeze({ subject: 200, body: 2000 });
export function cleanNotesText(s, max) {
  // control characters (except newline) and trailing spaces go; release notes are data, not markup
  const t = String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
export function parseTagNotes(raw) {
  const [kind, subject = "", body = ""] = String(raw || "").split("\0");
  if (kind.trim() !== "tag") return null;
  const s = cleanNotesText(subject, NOTES_LIMITS.subject);
  if (!s) return null;
  const b = cleanNotesText(body, NOTES_LIMITS.body);
  return { subject: s, body: b || null };
}
export async function fetchTagNotes({ remote, tag, object, dir, git = GIT, timeoutMs = 30_000, env = process.env } = {}) {
  if (typeof remote !== "string" || !remote || remote.startsWith("-")) throw Object.assign(new Error("origin"), { code: "hub-update:notes", detail: "remote" });
  if (typeof tag !== "string" || !tagVersion(tag)) throw Object.assign(new Error(msg("hub.detail.tag")), { code: "hub-update:notes", detail: "tag" });
  if (!/^[0-9a-f]{40}$/.test(String(object || ""))) return null; // lightweight tag — no notes
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(dir, ".notes-"));
  const run = (args) =>
    new Promise((resolve, reject) => {
      execFile(git, args, { timeout: timeoutMs, env: gitEnv(env), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(Object.assign(new Error("git"), { code: "hub-update:notes", detail: redactText(String(stderr || err.message || "").trim().split("\n").pop()).slice(0, 200) }));
        resolve(String(stdout));
      });
    });
  try {
    await run(["init", "--quiet", "--bare", tmp]);
    await run(["-C", tmp, "fetch", "--quiet", "--depth=1", "--filter=tree:0", "--no-tags", "--no-write-fetch-head", remote, `+refs/tags/${tag}:refs/tags/${tag}`]);
    const sha = (await run(["-C", tmp, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])).trim();
    if (sha !== object) throw Object.assign(new Error(msg("hub.detail.tagRewritten")), { code: "hub-update:notes", detail: "object" });
    return parseTagNotes(await run(["-C", tmp, "for-each-ref", "--format=%(objecttype)%00%(contents:subject)%00%(contents:body)", `refs/tags/${tag}`]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
