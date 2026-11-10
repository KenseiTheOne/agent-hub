// Interception places on this machine by real path (contract 3): if ~/.zshrc, ~/.claude or ~/Library/LaunchAgents is a
// symlink (dotfiles), a write to the real path is the same write to a dangerous place. perms.mjs doesn't touch the disk
// itself (the registry copies it), so the daemon builds the list and passes it to setLocalWritePlaces.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizePath, setLocalWritePlaces, WRITE_RISKS } from "./perms.mjs";

// → [{ place, kind }] — only those whose real path differs from the written one.
export function localWritePlaces({ home = homedir(), realpath = (p) => realpathSync.native(p) } = {}) {
  const out = [];
  for (const [kind, places] of Object.entries(WRITE_RISKS)) {
    for (const place of places) {
      const abs = place === "~" ? home : place.startsWith("~/") ? join(home, place.slice(2)) : place;
      let real;
      try {
        real = realpath(abs);
      } catch {
        continue; // not on disk — nothing to substitute
      }
      const n = normalizePath(real);
      if (n && n !== place && n !== normalizePath(abs) && !out.some((e) => e.place === n)) out.push({ place: n, kind });
    }
  }
  return out;
}

// Build and hand to the linter (writeRisk) of this machine. Errors are no reason to fail: without them places are checked by the written path.
export function refreshLocalWritePlaces(opts) {
  try {
    const list = localWritePlaces(opts);
    setLocalWritePlaces(list);
    return list;
  } catch {
    setLocalWritePlaces([]);
    return [];
  }
}
