// cdhash of the AgentHub.app build on disk (for `agenthub pin-app`). macOS only: codesign.

import { execFile, spawnSync } from "node:child_process";
import { APP_BUNDLE_ID } from "./app-pin.mjs";
import { msg } from "./i18n.mjs";

// Parses `codesign -dvvv` (prints to stderr): Identifier, CDHash, CodeDirectory flags, Authority, TeamIdentifier.
export function parseCodesignDisplay(text) {
  const s = String(text || "");
  const get = (re) => re.exec(s)?.[1] ?? null;
  const flags = get(/^CodeDirectory .*flags=0x[0-9a-f]+\(([^)]*)\)/m);
  return {
    identifier: get(/^Identifier=(.+)$/m),
    cdhash: get(/^CDHash=([0-9a-f]{40})$/m),
    adhoc: flags ? flags.split(",").includes("adhoc") : null,
    authority: get(/^Authority=(.+)$/m),
    teamId: get(/^TeamIdentifier=(.+)$/m),
  };
}

// cdhash of the build on disk. It's the same hash the core (csops CS_OPS_CDHASH, peercred addon: codeInfo) reports
// for a running process: verified 2026-11-05 on an ad hoc arm64 build (codesign -dvvv CDHash= ↔ codeInfo(pid).cdhash).
// codesign shows the native architecture slice; bundle.sh builds only that one.
// → { identifier, cdhash, adhoc, authority, teamId } | throw
export function readBundleCode(appPath, { codesign = "/usr/bin/codesign" } = {}) {
  const v = spawnSync(codesign, ["--verify", "--strict", appPath], { encoding: "utf8", timeout: 60_000 });
  if (v.status !== 0) throw new Error(msg("err.sign.verify", { why: String(v.stderr || v.error?.message || "").trim().split("\n")[0] }));
  const d = spawnSync(codesign, ["-dvvv", appPath], { encoding: "utf8", timeout: 60_000 });
  if (d.status !== 0) throw new Error(`codesign -dvvv: ${String(d.stderr || d.error?.message || "").trim().split("\n")[0]}`);
  const info = parseCodesignDisplay(`${d.stdout || ""}\n${d.stderr || ""}`);
  if (info.identifier !== APP_BUNDLE_ID) throw new Error(msg("err.sign.identifier", { got: info.identifier, want: APP_BUNDLE_ID }));
  if (!info.cdhash) throw new Error(msg("err.sign.noCdhash"));
  return info;
}

// Same thing asynchronously (execFile with a timeout): for the daemon, the event loop (hooks, SSE, /health) doesn't stall while codesign
// verifies the bundle. → Promise<{ identifier, cdhash, adhoc, authority, teamId }>
export function readBundleCodeAsync(appPath, { codesign = "/usr/bin/codesign", timeoutMs = 60_000 } = {}) {
  const run = (args) =>
    new Promise((resolve) => {
      execFile(codesign, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || ""), message: err ? (err.killed ? msg("err.timeout") : err.message) : null });
      });
    });
  return (async () => {
    const v = await run(["--verify", "--strict", appPath]);
    if (!v.ok) throw new Error(msg("err.sign.verify", { why: String(v.stderr || v.message || "").trim().split("\n")[0] }));
    const d = await run(["-dvvv", appPath]);
    if (!d.ok) throw new Error(`codesign -dvvv: ${String(d.stderr || d.message || "").trim().split("\n")[0]}`);
    const info = parseCodesignDisplay(`${d.stdout}\n${d.stderr}`);
    if (info.identifier !== APP_BUNDLE_ID) throw new Error(msg("err.sign.identifier", { got: info.identifier, want: APP_BUNDLE_ID }));
    if (!info.cdhash) throw new Error(msg("err.sign.noCdhash"));
    return info;
  })();
}
