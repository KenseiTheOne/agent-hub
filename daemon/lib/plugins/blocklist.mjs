// PluginManager part: the registry blocklist — whether an entry blocks a plugin (blockReason) and moving blocked
// installed plugins out of Plugins/ and back (applyBlocklist).
// The methods are installed on PluginManager.prototype by lib/plugins.mjs (lib/parts.mjs): `this` is the manager.

import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hashTree, sameFiles } from "./common.mjs";

export class ManagerBlocklist {
  // ---------- blocklist ----------
  // A blocklist entry applies to a plugin from its own registry; blocklists of registries with trust "official" apply to every
  // plugin (the hub's kill switch). registry — the plugin's registry (null: a local plugin or not from a registry).
  blockReason(id, { version = null, sha256: sum = null, any = false, registry = null } = {}) {
    for (const b of this.catalog?.blocklist || []) {
      if (b.id !== id) continue;
      if (b.registry && b.registry !== registry && this.source(b.registry)?.trust !== "official") continue;
      const all = !b.versions?.length && !b.sha256?.length;
      if (all) return b.reason;
      if (any) continue;
      if (version && b.versions?.includes(version)) return b.reason;
      if (sum && b.sha256?.includes(sum)) return b.reason;
    }
    return null;
  }

  // Disables installed plugins from the blocklist (the directory moves to Registry/disabled/<id>, the core doesn't see it)
  // and restores those removed from the blocklist (if the files match lock).
  applyBlocklist() {
    const lock = this.lock();
    let changed = false;
    for (const [id, e] of Object.entries(lock.plugins)) {
      // The registry blocklist is about registry plugins; it doesn't disable an own plugin from its own folder (the human installed it).
      // An own entry the manager didn't make (ownTrusted) is not an own plugin: the blocklist applies to it.
      if (this.ownTrusted(id, e)) continue;
      const reason = this.blockReason(id, { version: e.version, sha256: e.sha256, registry: this.registryOf(e) });
      const live = join(this.paths.plugins, id);
      const off = join(this.dirs.disabled, id);
      if (reason && !e.disabled) {
        if (existsSync(live)) {
          rmSync(off, { recursive: true, force: true });
          renameSync(live, off);
        }
        e.disabled = { reason: "blocklist", detail: reason, at: new Date().toISOString() };
        changed = true;
        this.log({ type: "plugin-blocked", plugin: id, version: e.version });
        this.emit({ type: "plugins.blocked", plugin: id });
      } else if (!reason && e.disabled?.reason === "blocklist" && existsSync(off)) {
        let ok = false;
        try {
          ok = sameFiles(hashTree(off), e.files);
        } catch {}
        if (ok && !existsSync(live)) {
          renameSync(off, live);
          e.disabled = null;
          changed = true;
          this.log({ type: "plugin-unblocked", plugin: id, version: e.version });
        }
      }
    }
    if (changed) {
      this.saveLock(lock);
      this.changed();
      this.noteUpdates();
    }
  }
}
