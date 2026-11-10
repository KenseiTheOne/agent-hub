// Self-test of this daemon version (`agenthubd --self-test`), called by the hub update builder before switching
// (lib/hub-update/build.mjs). Test directory only (AGENTHUB_HOME, not the live one): core without plugins
// or services, server on a socket, a /health request, shutdown. → {ok, version, native, error?}
//
// Service, route, primitive and hub-update modules are imported explicitly: the core and server swallow import errors
// (load-error in the journal, the daemon runs without the module), so a broken routes/hub-update.mjs would pass the
// self-test, and without it the app could neither update nor roll back. Any load-error in the self-test journal also fails.

import { readdirSync } from "node:fs";
import { request } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveStateDir, samePath } from "./platform.mjs";
import { msg } from "./i18n.mjs";

const LIB = dirname(fileURLToPath(import.meta.url));
export const SELFTEST_DIRS = ["routes", "services", "primitives", "hub-update"];

// Imports every module in the directories (like loadModules: *.mjs except _* and .*). → first error or null
export async function importAll(lib = LIB, dirs = SELFTEST_DIRS) {
  for (const d of dirs) {
    let files;
    try {
      files = readdirSync(join(lib, d)).filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && !f.startsWith(".")).sort();
    } catch (e) {
      return `${d}/: ${e.code || e.message}`;
    }
    for (const f of files) {
      try {
        await import(pathToFileURL(join(lib, d, f)).href);
      } catch (e) {
        return `${d}/${f}: ${String(e?.message || e).split("\n")[0].slice(0, 160)}`;
      }
    }
  }
  return null;
}

export async function selfTest(env = process.env) {
  let version = null;
  try {
    ({ VERSION: version } = await import("./version.mjs"));
    if (!env.AGENTHUB_HOME || samePath(env.AGENTHUB_HOME, liveStateDir({ env }))) return { ok: false, version, error: msg("err.selftest.home") };
    const { loadConfig } = await import("./config.mjs");
    const { Core } = await import("./core.mjs");
    const { createPeer } = await import("./peer.mjs");
    const { loadNative } = await import("./native.mjs");
    const { startServer } = await import("./server.mjs");
    const { stopHub } = await import("./lifecycle.mjs");
    const broken = await importAll();
    if (broken) return { ok: false, version, error: msg("err.selftest.module", { what: broken }) };
    const native = Boolean(loadNative());
    const config = loadConfig({ env: { ...env, AGENTHUB_SERVICES: "none" } });
    const core = new Core({ config, peer: createPeer({ config }) });
    await core.init({ startPlugins: false, startServices: false });
    const srv = await startServer(core);
    const health = await new Promise((done) => {
      const r = request({ socketPath: config.paths.socket, path: "/health", agent: false, timeout: 5000 }, (res) => {
        res.resume();
        done(res.statusCode === 200);
      });
      r.on("error", () => done(false));
      r.on("timeout", () => {
        r.destroy();
        done(false);
      });
      r.end();
    });
    let loadError = null;
    try {
      loadError = core.journal.tail(500).find((e) => e?.type === "load-error") ?? null;
    } catch {}
    await stopHub({ srv, core, reason: "self-test" });
    if (loadError) return { ok: false, version, native, error: `self-test: load-error ${loadError.kind ?? ""} ${basename(String(loadError.file ?? ""))} — ${String(loadError.detail ?? "").slice(0, 160)}` };
    return health ? { ok: true, version, native } : { ok: false, version, native, error: "self-test: /health" };
  } catch (e) {
    return { ok: false, version, error: `self-test: ${String(e?.message || e).slice(0, 200)}` };
  }
}
