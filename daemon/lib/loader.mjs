// Extension autoloading: lib/primitives/*.mjs, lib/routes/*.mjs, lib/services/*.mjs.
// Files starting with `_` or `.` are skipped (samples, drafts). Load order is by file name.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadModules(dir, { onError } = {}) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_") && !f.startsWith("."))
    .sort();
  const out = [];
  for (const f of files) {
    const file = join(dir, f);
    try {
      const mod = await import(pathToFileURL(file).href);
      out.push({ file, name: f.replace(/\.mjs$/, ""), mod });
    } catch (e) {
      onError?.(file, e);
    }
  }
  return out;
}
