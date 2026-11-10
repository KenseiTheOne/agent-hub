// Loads the peercred N-API addon (daemon/native/peercred/build/peercred.node).
// No addon → null: peer verification fails closed (every client is cli, signatures are not checked).

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR } from "./config.mjs";

export const NATIVE_PATH = join(DAEMON_DIR, "native", "peercred", "build", "peercred.node");
let cached;

export function loadNative() {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform === "darwin" && existsSync(NATIVE_PATH)) {
    try {
      cached = createRequire(import.meta.url)(NATIVE_PATH);
    } catch {
      cached = null;
    }
  }
  return cached;
}
