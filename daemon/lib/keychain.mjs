// macOS keychain via /usr/bin/security, for the secrets service (lib/services/secrets.mjs).
//
// Read: `find-generic-password -s <service> -a <account> -w` (value on stdout). Write: **only via stdin**
// of the interactive `security -i` mode, so the value never lands in the process argv (argv is visible via ps to any
// process of the same user). The value is base64url-encoded: no quotes or spaces for `security -i` to parse.
// Delete: `delete-generic-password -s … -a …` (no secret in argv).
//
// Limits: value ≤ 16 KB after encoding; names are Latin letters, digits, `._-`. Errors are a code without response text.
// `security -i` reads lines of at most 4095 characters: for a longer one the first part runs as a command (with a
// truncated value, overwriting the previous entry) and the rest is "unknown command". So writeItem refuses (`too-large`)
// when the command line exceeds MAX_LINE, without calling security; the store splits long values (services/secrets.mjs).
//
// The keychain parameter (path to a keychain file) is only for manual checks with a temporary keychain. `security -i`
// with a nonexistent path silently writes to the default keychain (login), so writeItem requires an existing file and
// reads the value back from the same keychain after writing.

import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

const NAME_RE = /^[a-z][a-z0-9_.-]{0,95}$/i;
const MAX_ENCODED = 16 * 1024;
export const MAX_LINE = 4095;
const ENV = { PATH: "/usr/bin:/bin" };

function okName(s) {
  return typeof s === "string" && NAME_RE.test(s);
}

// → { value } | { missing: true } (no entry: code 44) | { error } (timeout, keychain locked, another code).
// A transient keychain failure is not "no entry": the oauth service must not mistake it for being logged out.
export function readItemResult(securityPath, service, account, { timeoutMs = 5000, keychain = null } = {}) {
  if (!okName(service) || !okName(account)) return Promise.resolve({ error: "bad-name" });
  return new Promise((resolve) => {
    execFile(
      securityPath,
      ["find-generic-password", "-s", service, "-a", account, "-w", ...(keychain ? [keychain] : [])],
      { timeout: timeoutMs, maxBuffer: 64 * 1024, env: ENV },
      (err, stdout) => {
        if (err) {
          if (err.code === 44) return resolve({ missing: true });
          return resolve({ error: err.killed || err.signal ? "timeout" : typeof err.code === "number" ? `exit-${err.code}` : "spawn" });
        }
        const v = String(stdout ?? "").replace(/\r?\n$/, "");
        if (!v) return resolve({ missing: true });
        resolve(v.length <= MAX_ENCODED ? { value: v } : { error: "too-large" });
      },
    );
  });
}

// → string or null (no entry, denied, timeout), for plugin secrets where failure and absence are equivalent.
export function readItem(securityPath, service, account, opts = {}) {
  return readItemResult(securityPath, service, account, opts).then((r) => r.value ?? null);
}

// The write command line for `security -i` (without a newline).
export function writeLine(service, account, value, keychain = null) {
  return `add-generic-password -U -s ${service} -a ${account} -w ${value}${keychain ? ` ${keychain}` : ""}`;
}

// Write (or replace: -U) a value. → { ok, error? }. The value goes to the stdin of `security -i`.
export async function writeItem(securityPath, service, account, value, { timeoutMs = 5000, keychain = null } = {}) {
  if (!okName(service) || !okName(account)) return { ok: false, error: "bad-name" };
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,16384}$/.test(value)) return { ok: false, error: "bad-value" };
  if (keychain && !/^\/[\w./-]{1,500}$/.test(keychain)) return { ok: false, error: "bad-keychain" };
  // security -i will not notice a nonexistent keychain file and will write to login
  if (keychain && !isFile(keychain)) return { ok: false, error: "no-keychain-file" };
  // longer than a security -i line: refuse before the call, or a truncated value would overwrite the previous entry
  if (writeLine(service, account, value, keychain).length > MAX_LINE) return { ok: false, error: "too-large" };
  const r = await spawnWrite(securityPath, writeLine(service, account, value, keychain), timeoutMs);
  if (!r.ok || !keychain) return r;
  // manual check with a temporary keychain: the value must end up in that very keychain
  const back = await readItemResult(securityPath, service, account, { timeoutMs, keychain });
  return back.value === value ? r : { ok: false, error: "readback" };
}

function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function spawnWrite(securityPath, line, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(securityPath, ["-i"], { env: ENV, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      return finish({ ok: false, error: "spawn" });
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ ok: false, error: "timeout" });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", () => finish({ ok: false, error: "spawn" }));
    child.on("close", (code) => finish(code === 0 ? { ok: true } : { ok: false, error: `exit-${code}` }));
    child.stdin.on("error", () => {});
    child.stdin.end(`${line}\n`);
  });
}

// → { ok, missing? }. No entry: ok with missing: true (nothing to delete).
export function deleteItem(securityPath, service, account, { timeoutMs = 5000, keychain = null } = {}) {
  if (!okName(service) || !okName(account)) return Promise.resolve({ ok: false, error: "bad-name" });
  return new Promise((resolve) => {
    execFile(securityPath, ["delete-generic-password", "-s", service, "-a", account, ...(keychain ? [keychain] : [])], { timeout: timeoutMs, env: ENV }, (err) => {
      if (!err) return resolve({ ok: true });
      // 44 is security's errSecItemNotFound
      if (err.code === 44) return resolve({ ok: true, missing: true });
      resolve({ ok: false, error: err.killed ? "timeout" : `exit-${err.code}` });
    });
  });
}

export function encodeJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}
export function decodeJson(s) {
  if (typeof s !== "string" || !s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    return o && typeof o === "object" ? o : null;
  } catch {
    return null;
  }
}
