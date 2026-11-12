// External daemon extensions (G4): <home>/Extensions/{services,routes,primitives,terminals}/*.mjs — the same modules as the
// built-in ones in lib/services, lib/routes, lib/primitives and lib/terminals, kept outside the hub's source tree, so they
// survive hub updates (an install rebuilds the source tree from a tag; the state directory stays).
//
// An extension is code inside the daemon with the daemon's full rights — not a plugin: no permissions, no registry review.
// So it is loaded only after a human approved exactly these bytes in the pinned app:
//   - approval = the file's sha256, recorded in Registry/ext-approvals.json ONLY by the app-only route
//     POST /extensions/approve {path, sha256} (lib/routes/extensions.mjs); the app shows the consent text from /state.extensions;
//   - like own-plugin consents (lib/plugins.mjs), the daemon keeps every approval in memory too: an entry someone wrote into the
//     file while the daemon runs grants nothing (the file can only revoke); the file is trusted as is only at daemon start —
//     forging it while the daemon is down is the same limit as for own plugins and the app pin;
//   - a changed file (a sha256 other than the approved one) is "changed": not loaded at the next start until approved again; a
//     running module keeps running the approved bytes until the daemon restarts (restartRequired);
//   - a revoked approval of a module that is still loaded is "revoked" (restartRequired): it runs until the daemon restarts and
//     is not counted in `pending` — the human already decided; after a restart the file, if still there, is "pending" again;
//   - what is hashed is what runs: the bytes are read once, hashed and imported from a data: URL — a file swapped between the
//     check and the import is never executed. Consequence: an extension is one self-contained file; it may import node:*
//     built-ins (and absolute file: URLs), not relative paths. Hub helpers come through ctx;
//   - a name taken by a built-in (service name, primitive name, route method+path, terminal id) or an earlier extension is
//     refused: the extension never replaces hub code;
//   - every load, refusal and approval is journaled (extension-load, extension-denied, extension-error, extension-approved,
//     extension-revoked).
// Order: extension primitives and terminal adapters right after the built-in primitives, extension services after the built-in
// services (before plugins), extension routes after the built-in routes (the server attaches itself). Approved at runtime — loaded
// right away.
//
// Test mode: AGENTHUB_TEST_EXTENSIONS=1 together with AGENTHUB_HOME (a directory other than the live one) approves every file
// automatically — for tests only; the live hub never has it (lib/config.mjs testExtensionsOf).

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeCtx } from "./ctx.mjs";
import { t } from "./i18n.mjs";
import { myUid, usesFileModes } from "./platform.mjs";
import { ADAPTERS, adapterProblem, EXTENSION_ADAPTERS } from "./terminals/index.mjs";

// directory → kind
export const EXT_KINDS = Object.freeze({ primitives: "primitive", terminals: "terminal", services: "service", routes: "route" });
export const EXT_MAX_BYTES = 1024 * 1024;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.mjs$/;
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const RESCAN_MS = 30_000;

export const extensionsDir = (home) => join(home, "Extensions");
export const approvalsFile = (home) => join(home, "Registry", "ext-approvals.json");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function sigOf(st) {
  return `${st.ino}|${st.size}|${st.mtimeMs}|${st.ctimeMs}`;
}

// The approvals file: { version: 1, files: { "<dir>/<file>.mjs": { sha256, approvedAt } } } → Map(path → sha256).
export function readApprovals(home) {
  const map = new Map();
  try {
    const j = JSON.parse(readFileSync(approvalsFile(home), "utf8"));
    if (j?.version === 1 && j.files && typeof j.files === "object") {
      for (const [p, r] of Object.entries(j.files)) if (relOk(p) && SHA_RE.test(r?.sha256 || "")) map.set(p, { sha256: r.sha256, approvedAt: typeof r.approvedAt === "string" ? r.approvedAt : null });
    }
  } catch {}
  return map;
}

function relOk(p) {
  const m = /^([a-z]+)\/([^/]+)$/.exec(String(p || ""));
  return Boolean(m && EXT_KINDS[m[1]] && FILE_RE.test(m[2]));
}

function writeApprovals(home, map) {
  const dir = join(home, "Registry");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = {};
  for (const [p, r] of [...map].sort(([a], [b]) => (a < b ? -1 : 1))) files[p] = { sha256: r.sha256, approvedAt: r.approvedAt };
  const path = approvalsFile(home);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ version: 1, files }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class ExtensionError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export class Extensions {
  // core — the Core (journal, facts, primitives, services, emit); the config decides enabled and the test auto-approval.
  constructor(core) {
    this.core = core;
    this.home = core.config.paths.home;
    this.dir = extensionsDir(this.home);
    this.enabled = core.config.extensions?.enabled !== false;
    this.autoApprove = core.config.testExtensions === true;
    this.approved = readApprovals(this.home); // memory: path → {sha256, approvedAt}; the file is trusted as is only now
    this.items = new Map(); // path → item (the last scan)
    this.hashes = new Map(); // path → {sig, sha256, size}
    this.loaded = new Map(); // path → {sha256, kind, name}
    this.errors = new Map(); // path → {sha256, error, detail} — a load of these bytes failed
    this.loading = new Map(); // path → Promise of the load in progress (two approvals at once load once)
    this.denied = new Set(); // `${path}|${sha256}` — journaled once per daemon
    this.adapters = []; // loaded terminal adapters (the core's "terminal.adapters" fact)
    this.routeSink = null; // (name, mod) → error | null — set by the server (lib/server.mjs)
    this.lastKey = "";
    this.watcher = null;
    this.timer = null;
    this.debounce = null;
  }

  // ---------- approvals ----------
  // Approved = the memory and the file agree on this path's sha256 (a revocation in the file stands, a foreign entry does not).
  approvalOf(path) {
    if (this.autoApprove) return { sha256: this.items.get(path)?.sha256 ?? null, approvedAt: null, auto: true };
    const mem = this.approved.get(path);
    if (!mem) return null;
    const disk = readApprovals(this.home).get(path);
    return disk && disk.sha256 === mem.sha256 ? mem : null;
  }

  // ---------- scanning ----------
  // The files that are there now, with their sha256 and status. Cheap on repeat: a file is hashed again only when its
  // (ino, size, mtime, ctime) changed.
  scan() {
    const next = new Map();
    if (this.enabled && existsSync(this.dir)) {
      for (const [sub, kind] of Object.entries(EXT_KINDS)) {
        const d = join(this.dir, sub);
        let names = [];
        try {
          if (statSync(d).isDirectory()) names = readdirSync(d);
        } catch {}
        for (const f of names.filter((n) => n.endsWith(".mjs") && !n.startsWith("_") && !n.startsWith(".")).sort()) {
          const path = `${sub}/${f}`;
          next.set(path, this.inspect(path, kind, join(d, f), f));
        }
      }
    }
    for (const p of [...this.hashes.keys()]) if (!next.has(p)) this.hashes.delete(p);
    this.items = next;
    return next;
  }

  inspect(path, kind, file, name) {
    const it = { path, file, kind, name: name.replace(/\.mjs$/, ""), sha256: null, size: null, mtime: null, error: null };
    if (!FILE_RE.test(name)) return { ...it, error: "bad-name" };
    let st;
    try {
      st = statSync(file);
    } catch {
      return { ...it, error: "unreadable" };
    }
    it.size = st.size;
    it.mtime = new Date(st.mtimeMs).toISOString();
    if (!st.isFile()) return { ...it, error: "not-a-file" };
    // someone else's file, or one other users may write: whoever can change it could change what a human approved
    if (usesFileModes()) {
      const uid = myUid();
      if ((uid !== null && st.uid !== uid) || (st.mode & 0o022) !== 0) return { ...it, error: "unsafe-file" };
    }
    if (st.size > EXT_MAX_BYTES) return { ...it, error: "too-large" };
    const sig = sigOf(st);
    const h = this.hashes.get(path);
    if (h && h.sig === sig) return { ...it, sha256: h.sha256 };
    try {
      const digest = sha256(readFileSync(file));
      this.hashes.set(path, { sig, sha256: digest });
      return { ...it, sha256: digest };
    } catch {
      return { ...it, error: "unreadable" };
    }
  }

  // The item as the API shows it: status approved | pending | changed (the file's sha256 differs from the approved one) |
  // revoked (no approval, the module still runs until a restart) | error; loaded; restartRequired (the running code is not what
  // is approved now). Computed fresh on every call: approvals, loads and errors change without a rescan.
  view(it, lang) {
    const ap = this.approvalOf(it.path);
    const ld = this.loaded.get(it.path);
    const er = this.errors.get(it.path);
    let status;
    let error = it.error;
    let errorDetail = null;
    if (error) status = "error";
    else if (er && er.sha256 === it.sha256) {
      status = "error";
      error = er.error;
      errorDetail = er.detail || null;
    } else if (ap && ap.sha256 === it.sha256) status = "approved";
    else if (ap) status = "changed";
    else if (ld) status = "revoked";
    else status = "pending";
    return {
      path: it.path,
      file: it.file,
      kind: it.kind,
      name: ld?.name || it.name,
      sha256: it.sha256,
      size: it.size,
      mtime: it.mtime,
      status,
      loaded: Boolean(ld),
      restartRequired: Boolean(ld && (!ap || ld.sha256 !== it.sha256 || ap.sha256 !== it.sha256)),
      approvedSha256: ap && !ap.auto ? ap.sha256 : null,
      autoApproved: Boolean(ap?.auto),
      ...(ld?.skipped ? { skipped: ld.skipped } : {}),
      error: error || null,
      errorText: error ? t(lang, `ext.error.${error}`) : null,
      ...(errorDetail ? { errorDetail } : {}),
    };
  }

  // /state.extensions and GET /extensions. lang — the hub language for the consent text and the error details.
  info(lang = this.core.lang?.() || "ru") {
    const items = [...this.items.values()].map((it) => this.view(it, lang));
    return {
      dir: this.dir,
      enabled: this.enabled,
      testAutoApprove: this.autoApprove,
      consent: t(lang, "ext.consent"),
      pending: items.filter((i) => i.status === "pending" || i.status === "changed").length,
      items,
    };
  }

  // ---------- loading ----------
  // Load the approved files of one kind (the core calls it at its point in init; routes — when the server attaches).
  async loadKind(kind) {
    if (!this.enabled) return;
    this.scan();
    for (const it of this.items.values()) if (it.kind === kind) await this.loadItem(it);
    this.changed();
  }

  // One load per path at a time: a second caller (two approvals at once, an approval during loadKind) waits for the first.
  loadItem(it, opts = {}) {
    if (!it) return Promise.resolve();
    const running = this.loading.get(it.path);
    if (running) return running;
    const p = this.loadOnce(it, opts).finally(() => this.loading.delete(it.path));
    this.loading.set(it.path, p);
    return p;
  }

  async loadOnce(it, { approvedNow = false } = {}) {
    if (this.loaded.has(it.path)) return;
    if (it.error && !this.errors.has(it.path)) return this.journalError(it, it.error, null, { remember: false });
    const ap = this.approvalOf(it.path);
    if (!ap || !ap.sha256 || ap.sha256 !== it.sha256) {
      const key = `${it.path}|${it.sha256}`;
      if (!this.denied.has(key)) {
        this.denied.add(key);
        this.core.journal.write({ type: "extension-denied", path: it.path, kind: it.kind, sha256: it.sha256, status: ap ? "changed" : "pending" });
      }
      return;
    }
    if (it.kind === "route" && !this.routeSink) return; // the server loads routes when it attaches
    // the bytes that run are the bytes that were hashed
    let bytes;
    try {
      bytes = readFileSync(it.file);
    } catch {
      return this.journalError(it, "unreadable");
    }
    const digest = sha256(bytes);
    if (digest !== ap.sha256) {
      this.core.journal.write({ type: "extension-denied", path: it.path, kind: it.kind, sha256: digest, status: "changed" });
      return;
    }
    let mod;
    try {
      mod = await import(`data:text/javascript;base64,${bytes.toString("base64")}#${encodeURIComponent(it.path)}`);
    } catch (e) {
      return this.journalError(it, "import-failed", e?.message, { sha256: digest });
    }
    let r;
    try {
      r = await this.register(it, mod);
    } catch (e) {
      r = { error: "start-failed", detail: e?.message };
    }
    if (r?.error) return this.journalError(it, r.error, r.detail, { sha256: digest });
    this.errors.delete(it.path);
    this.loaded.set(it.path, { sha256: digest, kind: it.kind, name: r?.name || it.name, ...(r?.skipped ? { skipped: r.skipped } : {}) });
    this.core.journal.write({ type: "extension-load", path: it.path, kind: it.kind, name: r?.name || it.name, sha256: digest, ...(ap.auto ? { auto: true } : {}), ...(approvedNow ? { now: true } : {}), ...(r?.skipped ? { skipped: r.skipped } : {}) });
  }

  journalError(it, error, detail = null, { sha256: digest = it.sha256, remember = true } = {}) {
    const d = detail ? String(detail).replace(/\s+/g, " ").slice(0, 160) : null;
    if (remember) this.errors.set(it.path, { sha256: digest, error, detail: d });
    this.core.journal.write({ type: "extension-error", path: it.path, kind: it.kind, sha256: digest, error, ...(d ? { detail: d } : {}) });
  }

  // One module by kind. → { name?, skipped? } | { error, detail? }
  async register(it, mod) {
    const core = this.core;
    if (it.kind === "primitive") {
      if (typeof mod.name === "string" && core.primitives.has(mod.name)) return { error: "name-taken", detail: mod.name };
      const err = core.registerPrimitive(mod);
      return err ? { error: "bad-module", detail: err } : { name: mod.name };
    }
    if (it.kind === "terminal") {
      const problem = adapterProblem(mod);
      if (problem) return { error: "bad-module", detail: problem };
      if ([...ADAPTERS, ...this.adapters].some((a) => a.id === mod.id)) return { error: "name-taken", detail: mod.id };
      EXTENSION_ADAPTERS.add(mod);
      this.adapters = [...this.adapters, mod];
      return { name: mod.id };
    }
    if (it.kind === "service") {
      const name = mod.name || it.name;
      if (typeof name !== "string" || !SERVICE_NAME_RE.test(name)) return { error: "bad-module", detail: "name" };
      if (typeof mod.start !== "function") return { error: "bad-module", detail: "start" };
      if (core.builtinServiceNames?.has(name) || core.services.some((s) => s.name === name)) return { error: "name-taken", detail: name };
      // the same switches as for built-in services: AGENTHUB_SERVICES and services.<name>.enabled = false
      const filter = core.config.servicesFilter;
      const only = filter && filter !== "none" ? new Set(filter.split(",").map((s) => s.trim())) : null;
      if (filter === "none" || (only && !only.has(name)) || core.config.services?.[name]?.enabled === false) return { name, skipped: "disabled" };
      const ctx = makeCtx(core, `service:${name}`);
      await mod.start(ctx);
      core.services.push({ name, mod, ctx, extension: true });
      core.journal.write({ type: "service-start", service: name, extension: true });
      return { name };
    }
    if (it.kind === "route") {
      const err = this.routeSink(it.name, mod);
      return err ? { error: err.startsWith("duplicate") ? "name-taken" : "bad-module", detail: err } : { name: it.name };
    }
    return { error: "bad-module" };
  }

  // The server is up: its route table takes extension routes from now on. sink(name, mod) → null | "duplicate <M path>" | "bad route …"
  async attachRoutes(sink) {
    this.routeSink = sink;
    if (sink) await this.loadKind("route");
  }

  // ---------- approval (the app-only routes) ----------
  // POST /extensions/approve {path, sha256}: the human saw these bytes (the sha256 the app showed) — record and load now.
  async approve(path, digest, peer = null) {
    if (!this.enabled) throw new ExtensionError(409, "extensions:disabled");
    if (this.core.estop?.()) throw new ExtensionError(423, "estop");
    if (typeof path !== "string" || !relOk(path)) throw new ExtensionError(400, "args:path");
    if (typeof digest !== "string" || !SHA_RE.test(digest)) throw new ExtensionError(400, "args:sha256");
    this.scan();
    const it = this.items.get(path);
    if (!it) throw new ExtensionError(404, "extensions:not-found");
    if (it.error) throw new ExtensionError(409, `extensions:${it.error}`);
    if (it.sha256 !== digest) {
      this.core.journal.write({ type: "extension-approve-refused", path, sha256: digest, now: it.sha256, pid: peer?.pid ?? null });
      throw new ExtensionError(409, "extensions:changed", { sha256: it.sha256 });
    }
    const record = { sha256: digest, approvedAt: new Date().toISOString() };
    // what the memory and the file both hold, plus this one (a foreign file entry is dropped, a revocation stands)
    const disk = readApprovals(this.home);
    const next = new Map();
    for (const [p, r] of this.approved) if (disk.get(p)?.sha256 === r.sha256) next.set(p, r);
    next.set(path, record);
    try {
      writeApprovals(this.home, next);
    } catch (e) {
      throw new ExtensionError(500, "extensions:write-failed", { why: e?.code || "error" });
    }
    this.approved = next;
    this.errors.delete(path);
    this.core.journal.write({ type: "extension-approved", path, kind: it.kind, sha256: digest, pid: peer?.pid ?? null });
    this.scan();
    await this.loadItem(this.items.get(path), { approvedNow: true });
    this.scan();
    this.changed(true);
    return { ok: true, item: this.info().items.find((i) => i.path === path) || null };
  }

  // POST /extensions/revoke {path}: drop the approval. A loaded module runs until the daemon restarts (restartRequired).
  revoke(path, peer = null) {
    if (typeof path !== "string" || !relOk(path)) throw new ExtensionError(400, "args:path");
    const had = this.approved.has(path);
    if (!had && !this.items.has(path)) throw new ExtensionError(404, "extensions:not-found");
    const disk = readApprovals(this.home);
    const next = new Map();
    for (const [p, r] of this.approved) if (p !== path && disk.get(p)?.sha256 === r.sha256) next.set(p, r);
    try {
      writeApprovals(this.home, next);
    } catch (e) {
      throw new ExtensionError(500, "extensions:write-failed", { why: e?.code || "error" });
    }
    this.approved = next;
    this.core.journal.write({ type: "extension-revoked", path, pid: peer?.pid ?? null });
    this.scan();
    this.changed(true);
    return { ok: true, item: this.info().items.find((i) => i.path === path) || null };
  }

  // ---------- watching ----------
  // A new or changed file shows up in /state.extensions (and the extensions.changed event) without a restart: fs.watch on the folder
  // plus a rescan every 30 s (fs.watch loses events; the folder may appear later).
  start() {
    if (!this.enabled) return;
    this.timer = setInterval(() => this.rescan(), this.core.config.extensions?.rescanMs || RESCAN_MS);
    this.timer.unref?.();
    this.watch();
  }
  watch() {
    if (this.watcher || !existsSync(this.dir)) return;
    try {
      this.watcher = watch(this.dir, { recursive: true, persistent: false }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.rescan(), 200);
        this.debounce.unref?.();
      });
      this.watcher.on("error", () => {
        try {
          this.watcher?.close();
        } catch {}
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }
  rescan() {
    try {
      this.scan();
      this.watch();
      this.changed();
    } catch {}
  }
  // Emits extensions.changed when the list or a status changed (metadata only — paths, statuses, sha256).
  changed(force = false) {
    const info = this.info();
    const key = JSON.stringify(info.items.map((i) => [i.path, i.sha256, i.status, i.loaded, i.restartRequired, i.error]));
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.core.emit?.({ type: "extensions.changed", extensions: info });
  }
  stop() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.timer = null;
    try {
      this.watcher?.close();
    } catch {}
    this.watcher = null;
    this.routeSink = null;
  }
}
