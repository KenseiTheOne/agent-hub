// Push state across daemon restarts: what has already been sent, the morning digest queue.
// File <home>/push-state.json, mode 0600, written atomically (tmp + rename). Metadata only.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

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
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
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
