// Push state across daemon restarts: what has already been sent, the morning digest queue.
// File <home>/push-state.json, mode 0600, written atomically (tmp + rename). Metadata only.

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../statefile.mjs";

export function createStore(file) {
  return {
    file,
    load() {
      if (!file || !existsSync(file)) return null;
      try {
        const j = JSON.parse(readFileSync(file, "utf8"));
        return j && typeof j === "object" && j.version === 1 ? j : null;
      } catch {
        return null; // corrupt file — treat it as missing
      }
    },
    save(obj) {
      if (!file) return;
      writeFileAtomic(file, JSON.stringify(obj), { mode: 0o600 });
    },
  };
}

// Test double.
export function memoryStore(initial = null) {
  let data = initial;
  return {
    file: null,
    load: () => (data ? structuredClone(data) : null),
    save: (obj) => {
      data = structuredClone(obj);
    },
    get data() {
      return data;
    },
  };
}
