// Plugin permissions: collecting from metadata, linter (forbidden paths, effects ceiling for third parties), diff and growth.
//
// The module is self-contained (plain JS only): the agent-hub-plugins registry copies it too (scripts/vendor/),
// so that CI and the plugin manager in the daemon compute permissions the same way.
//
// A permission is { kind, what, why }; the key is `${kind}:${what}` (what without extra spaces). Permission growth means
// keys appeared that were not in the agreed set; a change of `why` alone does not count as growth.
// For watch, what is the path and why is the explanation after " — ", like other kinds and as the core reads it
// (host.mjs watchPaths). Entries of the old form (what is the whole line including " — why", why: null; that is how
// lock and the index stored them before 2026-11-05) are parsed by permissionList the same way: keys of old and new entries match.

// Effects ceiling for third-party plugins — the same as in the core (core.mjs: THIRD_PARTY_EFFECTS, LOCAL_EFFECTS).
export const THIRD_PARTY_EFFECTS = ["open.*", "terminal.focus", "cmux.focus", "session.focus"];
export const LOCAL_EFFECTS = ["open.*"];

export const KINDS = ["fsRead", "fsWrite", "watch", "exec", "secrets", "net", "effects", "actions", "connections", "terminal", "subscribe"];
// Kinds for which the author must explain "why".
const NEED_WHY = new Set(["fsRead", "fsWrite", "exec", "secrets", "net", "terminal", "subscribe"]);

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RESERVED_IDS = new Set(["local", "staging", "disabled"]);
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLATFORMS = new Set(["macos", "windows", "linux"]);

// Forbidden locations (design §4, §7): conversation text, keys, environment, tokens.
const FORBIDDEN_TREES = ["~/.claude/projects", "~/.cmuxterm/workstream.jsonl"];
const FORBIDDEN_FILE_RE = [/\.key$/, /^\.env(?:\..*)?$/, /^auth\.json$/];
// [sample, distinctive part]: the mask matches the sample and itself contains that part (`*.key`, `.env*`, `auth.*`);
// generic masks like `*.json` are not considered aimed at auth.json.
const FORBIDDEN_FILE_SAMPLES = [
  ["x.key", "key"],
  [".env", "env"],
  [".env.local", "env"],
  ["auth.json", "auth"],
];
// Directories where keys sit next to the files you need: whole or with an "everything" mask is not allowed.
const KEY_DIRS = ["~/.claude/sessions"];

export function splitWhy(entry) {
  const m = /^(.*?)\s+[—–-]{1,2}\s+(.*)$/.exec(String(entry));
  return m ? { what: m[1].trim(), why: m[2].trim() } : { what: String(entry).trim(), why: null };
}

const norm = (s) => String(s).trim().replace(/\s+/g, " ");

// meta — the result of parseMetaText (daemon/lib/meta.mjs). → { fsRead:[{what,why}], …, effects:[…], actions:[…] }
export function permissionsFromMeta(meta) {
  const out = {};
  // <agenthub.watch recursive="true"> (G17): subdirectories too — part of the permission (B10): the entry gets recursive: true and
  // the key " recursive" (permissionList), so an update that adds it is permission growth; what stays the path for the linter
  const deep = new Set(meta.watchRecursive || []);
  for (const k of ["fsRead", "fsWrite", "exec", "secrets", "net", "watch"]) {
    out[k] = (meta[k] || []).map((e) => {
      const { what, why } = splitWhy(e);
      return { what: norm(what), why, ...(k === "watch" && deep.has(e) ? { recursive: true } : {}) };
    });
  }
  out.effects = [...new Set((meta.effects || []).map(norm))].sort();
  // net="none" and background="true" (G2, G6) are part of the permission (lifting the network floor, a job without a timeout);
  // written only when declared — entries of actions without them stay as they were
  out.actions = (meta.actions || []).map((a) => ({ id: a.id, level: a.level, command: norm(a.command), title: a.title || null, ...(a.arg ? { arg: `${a.arg.name}:${a.arg.pattern}` } : {}), ...(a.net === "none" ? { net: "none" } : {}), ...(a.background ? { background: true } : {}), ...(a.input ? { input: true } : {}) }));
  // Connections (<agenthub.connection>, contract 2): the hub handles signing in to the service, the plugin calls MCP tools through
  // it. An empty list is not written into permissions — index and lock entries from before contract 2 are compared as before.
  const conns = (meta.connections || []).map((c) => ({ what: connectionWhat(c), why: c.note || null }));
  if (conns.length) out.connections = conns;
  // Terminal (<agenthub.terminal>, contract 3): read a tab's screen and type a line into a Claude Code session tab.
  // Like connections, an empty list is not written into permissions.
  const term = (meta.terminal || []).map((e) => {
    const { what, why } = splitWhy(e);
    return { what: norm(what), why };
  });
  if (term.length) out.terminal = term;
  // Event subscriptions (<agenthub.subscribe>, G11): another plugin's events on stdin. Like terminal, an empty list is not written.
  const subs = (meta.subscribe || []).map((e) => {
    const { what, why } = splitWhy(e);
    return { what: norm(what), why };
  });
  if (subs.length) out.subscribe = subs;
  return out;
}

// ---------- event subscriptions (G11) ----------
//
//   <agenthub.subscribe>builds:failed — why</agenthub.subscribe>   events of plugin "builds" whose key starts with "failed"
//   <agenthub.subscribe>builds: — why</agenthub.subscribe>         every event of "builds"
//   <agenthub.subscribe>*:deploy — why</agenthub.subscribe>        events of every other plugin with keys starting with "deploy"
// The same grammar as lib/meta.mjs SUBSCRIBE_RE (the module is self-contained — the registry takes a copy).
export const SUBSCRIBE_RE = /^(\*|[A-Za-z0-9][A-Za-z0-9._-]{0,63}):([\w.:/-]{0,128})$/;
export const SUBSCRIBE_MAX = 16;
export function parseSubscribePerm(what) {
  const m = SUBSCRIBE_RE.exec(norm(what || ""));
  return m ? { plugin: m[1], prefix: m[2] } : null;
}

// ---------- terminal (contract 3) ----------
//
//   <agenthub.terminal>read-screen — why</agenthub.terminal>          find out whether the input field is empty and the session is free
//                                                                    (the plugin does not get the screen text)
//   <agenthub.terminal>send /model /effort — why</agenthub.terminal>   type a slash command and Enter: the first word of the line is
//                                                                    one of the listed commands (up to 16), followed by at most
//                                                                    3 arguments from [A-Za-z0-9._:[]-] (up to 64 chars)
//   <agenthub.terminal>send * — why</agenthub.terminal>               any line except those starting with "!" (a shell command
//                                                                    in bash mode), "#" (a memory entry) and "&"
//                                                                    (a background task); louder in the consent window
//   <agenthub.terminal>send ! — why</agenthub.terminal>               a line starting with this mode character ("!", "#",
//                                                                    "&"; several allowed: "send ! #"): a separate permission
//                                                                    (2026-11-10), "*" does not grant it; the loudest in the consent window
// A word is "/", then a-z, 0-9, "-" starting with a letter, up to 32 chars: a per-word permission is only for a slash command (a word without "/" would be
// a permission for an arbitrary prompt starting with that word). Extending the word list is permission growth (the key is the whole entry).
export const TERMINAL_WORD_RE = /^\/[a-z][a-z0-9-]{0,31}$/;
const TERMINAL_WORDS_MAX = 16;
// Slash command arguments under a word permission: at most 3, each from this set (model, level, id with [1m]).
export const TERMINAL_ARG_RE = /^[A-Za-z0-9._:[\]-]{1,64}$/;
const TERMINAL_ARGS_MAX = 3;
// Leading characters Claude Code treats as a mode rather than a prompt: "!" is a shell command run immediately, without Claude Code's
// permissions; "#" is a memory entry (CLAUDE.md); "&" is a background task. Such lines are not typed under the "*" permission.
export const TERMINAL_MODE_CHARS = ["!", "#", "&"];

// what → { op: "read-screen" } | { op: "send", any, words, modes } | null (not a terminal permission entry).
// Permission words are slash commands or mode characters; "*" only alone, without other words.
export function parseTerminalPerm(what) {
  const parts = norm(what || "").split(" ").filter(Boolean);
  if (parts.length === 1 && parts[0] === "read-screen") return { op: "read-screen" };
  if (parts[0] !== "send" || parts.length < 2) return null;
  const words = parts.slice(1);
  if (words.length === 1 && words[0] === "*") return { op: "send", any: true, words: [], modes: [] };
  if (words.length > TERMINAL_WORDS_MAX || !words.every((w) => TERMINAL_WORD_RE.test(w) || TERMINAL_MODE_CHARS.includes(w))) return null;
  const modes = [...new Set(words.filter((w) => TERMINAL_MODE_CHARS.includes(w)))];
  return { op: "send", any: false, words: [...new Set(words.filter((w) => !TERMINAL_MODE_CHARS.includes(w)))], modes };
}

// The plugin's <agenthub.terminal> entries (metadata lines "what — why" or what) → { read, send, any, words: Set, modes: Set }.
export function terminalGrants(entries) {
  const out = { read: false, send: false, any: false, words: new Set(), modes: new Set() };
  for (const e of Array.isArray(entries) ? entries : []) {
    const p = parseTerminalPerm(splitWhy(String(e)).what);
    if (!p) continue;
    if (p.op === "read-screen") out.read = true;
    else {
      out.send = true;
      if (p.any) out.any = true;
      for (const w of p.words) out.words.add(w);
      for (const m of p.modes) out.modes.add(m);
    }
  }
  return out;
}

// Whether this line may be typed under the permissions. → the declared slash command at the start of the line (its arguments per
// TERMINAL_ARG_RE, at most 3), "*" (any line allowed by the "*" permission that does not start with TERMINAL_MODE_CHARS),
// a mode character (the line starts with "!", "#" or "&" and that character is declared as a separate permission) or null — not allowed.
export function terminalTextAllowed(grants, text) {
  if (!grants?.send || typeof text !== "string" || !text) return null;
  if (TERMINAL_MODE_CHARS.includes(text[0])) return grants.modes?.has(text[0]) ? text[0] : null;
  const [head, ...args] = text.split(" ");
  if (grants.words.has(head) && args.length <= TERMINAL_ARGS_MAX && args.every((a) => TERMINAL_ARG_RE.test(a))) return head;
  return grants.any && !TERMINAL_MODE_CHARS.includes(text[0]) ? "*" : null;
}

// A connection id belongs to plugin pluginId: equal to it or "<pluginId>.<name>" (the same grammar as
// lib/meta.mjs connectionIdOf; the module is self-contained — the registry takes a copy).
const CONNECTION_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CONNECTION_ID_RE = /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]{0,31})?$/;
export function connectionIdOk(pluginId, id) {
  const cid = id || pluginId;
  if (!ID_RE.test(pluginId || "") || !CONNECTION_ID_RE.test(String(cid))) return false;
  return cid === pluginId || (String(cid).startsWith(`${pluginId}.`) && CONNECTION_NAME_RE.test(String(cid).slice(pluginId.length + 1)));
}

// The connection permission line: address, scope and allowlist — what a human agrees to. Interval and budget are not
// access and are not part of the key.
export function connectionWhat(c) {
  // type="http" (G7): the client, the endpoints, the API hosts the token goes to, methods and path prefixes — what a human agrees to
  if (c?.type === "http" && c.http) {
    const h = c.http;
    return norm(`${c.id ? `${c.id}: ` : ""}http client=${h.clientId} authorize=${h.authorize} token=${h.token} api=${(h.hosts || []).join(",")} scope=${c.scope || "-"} methods=${(h.methods || []).join(",")}${h.paths?.length ? ` paths=${h.paths.join(",")}` : ""}`);
  }
  const hosts = Array.isArray(c?.hosts) && c.hosts.length ? ` +${c.hosts.join(",")}` : "";
  return norm(`${c?.id ? `${c.id}: ` : ""}${c?.url || "?"}${hosts} scope=${c?.scope || "-"} tools=${(c?.tools || []).join(",")}`);
}

// Permissions for a catalog entry (index.json): like permissionsFromMeta, but watch in the old form (what is the whole
// metadata line including " — why", why: null). Daemons before 2026-11-05 take the watch key from the whole line and use it to compare
// the archive's permissions with the catalog entry (plugins.mjs prepare → registry:archive-permissions); a new daemon parses such
// an entry via splitWhy (permissionList), the keys match. That way one index installs on both old and new cores.
export function indexPermissions(meta) {
  const deep = new Set(meta.watchRecursive || []);
  return { ...permissionsFromMeta(meta), watch: (meta.watch || []).map((w) => ({ what: norm(w), why: null, ...(deep.has(w) ? { recursive: true } : {}) })) };
}

// ---------- compatibility of index entries with older hubs (B11) ----------
//
// Attributes added to contract 3 after hub 0.1.2 (the contract number stays 3: every addition is optional). A hub that
// doesn't know one of them would either refuse the archive with an opaque error (type="http" changes the connection permission:
// registry:archive-permissions; community actions: registry:lint) or install the plugin and run it wrongly (a background job
// killed after 30 s, an input action that can't get its text, no events, no subdirectories watched, confirm-cost instead of
// net="none"). Hub 0.1.2 understands only an integer `contract` in an index entry; any other value means "needs a newer hub"
// for that entry (contractUnknown: not offered as an update, install refused with registry:hub-too-old). So an index entry
// that uses any of these features carries the object form {"version": 3, "features": [...]} — an older hub says "Needs a newer
// hub", this hub checks every feature against CONTRACT_FEATURES. Entries without them keep the plain integer (or no field).
export const CONTRACT_FEATURES = Object.freeze(["background", "community-actions", "http-connection", "input", "input-pattern", "net-none", "subscribe", "watch-recursive"]);

// The features of CONTRACT_FEATURES a plugin uses (sorted). official — the tier the registry assigns (community actions need a
// newer hub, official ones don't).
export function contractFeatures(meta, { official = false } = {}) {
  const f = new Set();
  for (const a of meta?.actions || []) {
    if (a.background) f.add("background");
    if (a.input) f.add("input");
    // inputPattern= (re-review 65): the typed text is checked by its own pattern and arg= stays a row argument
    if (a.input?.pattern) f.add("input-pattern");
    if (a.net === "none") f.add("net-none");
  }
  if (!official && (meta?.actions || []).length) f.add("community-actions");
  if ((meta?.connections || []).some((c) => c?.type === "http")) f.add("http-connection");
  if ((meta?.subscribe || []).length) f.add("subscribe");
  if ((meta?.watchRecursive || []).length) f.add("watch-recursive");
  return [...f].sort();
}

// The `contract` field of an index entry (registry build-index): undefined — no <agenthub.contract> and no new features (the hub
// assumes 1); an integer — as before; {version, features} — the plugin uses features newer than hub 0.1.2 (version at least 3).
export function indexContract(meta, { official = false } = {}) {
  const features = contractFeatures(meta, { official });
  const version = Number.isInteger(meta?.contract) ? meta.contract : undefined;
  if (!features.length) return version;
  return { version: Math.max(version ?? 1, 3), features };
}

// Flat permission list. → [{ kind, what, why, key }]
// opts.pluginId — whose set this is: its PluginData/<id> and Cache/<id> in the hub directory are not loud (writeRisk).
export function permissionList(perms, { pluginId = null } = {}) {
  const list = [];
  if (!perms || typeof perms !== "object") return list;
  for (const k of ["fsRead", "fsWrite", "watch", "exec", "secrets", "net", "connections", "terminal", "subscribe"]) {
    for (const e of perms[k] || []) {
      if (!e || typeof e.what !== "string") continue;
      let what = e.what;
      let why = e.why ?? null;
      if (k === "watch" && why == null) ({ what, why } = splitWhy(what));
      // recursive watch (B10): a separate permission from the same path watched flat
      if (k === "watch" && e.recursive === true) what = `${norm(what)} recursive`;
      // writing where Claude Code or the system can be taken over (contract 3): the permission is allowed, but the consent window
      // shows it as a loud line with an explanation (risk — the kind of location, writeRisk); it is not part of the permission key.
      // Typing into a Claude Code tab (terminal send) is also a takeover: risk "terminal"; a permission for mode characters
      // ("!" — a shell command bypassing Claude Code's permissions) is the loudest: risk "terminal-mode".
      const tp = k === "terminal" ? parseTerminalPerm(what) : null;
      const risk = k === "fsWrite" ? writeRisk(what, { pluginId }) : tp?.op === "send" ? (tp.modes.length ? "terminal-mode" : "terminal") : null;
      list.push({ kind: k, what: norm(what), why, key: `${k}:${norm(what)}`, ...(risk ? { risk } : {}) });
    }
  }
  for (const e of perms.effects || []) if (typeof e === "string") list.push({ kind: "effects", what: norm(e), why: null, key: `effects:${norm(e)}` });
  for (const a of perms.actions || []) {
    if (!a || typeof a.id !== "string") continue;
    // the argument pattern is part of the permission: widening it in an update is permission growth
    const what = `${a.id} [${a.level}] ${norm(a.command || "")}${typeof a.arg === "string" ? ` {${a.arg}}` : ""}${a.input === true ? " input" : ""}${a.net === "none" ? " net=none" : ""}${a.background === true ? " background" : ""}`;
    list.push({ kind: "actions", what, why: a.title ?? null, key: `actions:${what}` });
  }
  // Loud push rules (only for own plugins: the manager puts them into permissions from loudPushRules; the registry does not have this
  // kind — the reviewer sees them as a pushWarnings warning): security exception and quiet hours.
  for (const e of perms.push || []) {
    if (!e || typeof e.what !== "string") continue;
    list.push({ kind: "push", what: norm(e.what), why: e.why ?? null, key: `push:${norm(e.what)}` });
  }
  return list;
}

// Event keys the hub core raises itself (daemon/lib/push/rules.mjs: rules with kind "security" and
// @hub events): a plugin may not take them — its event with such a key will not become a security exception anyway, and
// the reviewer should see the attempt. A shared list for registry CI (scripts/lib/registry.mjs) and checking an own folder.
export const CORE_PUSH_KEYS = Object.freeze(["app-pin-changed", "app-pin-path-changed", "app-restart-stopped", "hub-update-tag-moved", "hub-update-suspect", "hub-update-failed", "hub-update", "plugin-update", "plugin-own-unexpected", "approvals-paused"]);

// Warnings about push rules: kind="security" (delivered with notifications off — the reviewer checks that it is
// a tampering signal, not an ordinary event) and keys reserved by the core. lang — text language (ru by default).
export function pushWarnings(meta, { lang = "ru" } = {}) {
  const out = [];
  for (const r of Array.isArray(meta?.push) ? meta.push : []) {
    const key = String(r?.key || "");
    if (r?.kind === "security") out.push(L(lang, `<agenthub.push key="${key}" kind="security">: исключение безопасности — приходит при любых выключателях уведомлений; ревьюер проверяет, что это сигнал подмены`, `<agenthub.push key="${key}" kind="security">: security exception — delivered whatever the notification switches say; the reviewer checks it signals tampering`));
    if (CORE_PUSH_KEYS.some((k) => key === k || key.startsWith(`${k}:`) || key.startsWith(`${k}-`))) out.push(L(lang, `<agenthub.push key="${key}">: ключ зарезервирован ядром хаба — возьмите другой`, `<agenthub.push key="${key}">: the key is reserved by the hub core — pick another`));
  }
  return out;
}

// A plugin's loud push rules as permissions (push kind): kind="security" (delivered whatever the switches say) and
// quiet="true" (delivered during quiet hours). For an own plugin the reviewer is the human: such rules are visible in the consent
// window, and their appearance is permission growth (a new window, not a silent update from the folder). → [{what, why}]
export function loudPushRules(meta) {
  const out = [];
  for (const r of Array.isArray(meta?.push) ? meta.push : []) {
    const key = norm(r?.key || "");
    if (!key) continue;
    const marks = [r?.kind === "security" ? "security" : null, r?.quietException === true ? "quiet" : null].filter(Boolean);
    if (marks.length) out.push({ what: `${key} [${marks.join(", ")}]`, why: typeof r.label === "string" && r.label ? r.label : null });
  }
  return out;
}

export function permissionKeys(perms) {
  return new Set(permissionList(perms).map((p) => p.key));
}

// What was added and what went away. → { added: [...], removed: [...] }
export function diffPermissions(before, after, opts = {}) {
  const a = permissionList(before, opts);
  const b = permissionList(after, opts);
  const ka = new Set(a.map((p) => p.key));
  const kb = new Set(b.map((p) => p.key));
  return { added: b.filter((p) => !ka.has(p.key)), removed: a.filter((p) => !kb.has(p.key)) };
}

// Permission growth: keys of after that are not in granted.
export function permissionGrowth(granted, after, opts = {}) {
  return diffPermissions(granted, after, opts).added;
}

// Hash of a permission set (to bind consent to a specific set).
export function permissionsFingerprint(perms) {
  return [...permissionKeys(perms)].sort().join("\n");
}

// ---------- forbidden paths ----------

export function normalizePath(p) {
  let s = String(p).trim().replace(/\\/g, "/");
  s = s.replace(/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%)(?=\/|$)/i, "~");
  // macOS firmlink: /System/Volumes/Data/Users/<u>/… is the same file as /Users/<u>/…
  s = s.replace(/^\/System\/Volumes\/Data(?=\/)/i, "");
  s = s.replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/i, "~");
  s = s.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
  s = s.replace(/\/{2,}/g, "/").replace(/\/\.(?=\/|$)/g, "");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

function globToRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") {
        re += "(?:/|$)?";
        i++;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{" || c === "[") re += ".*"; // crude, but errs toward forbidding
    else if (c === "}" || c === "]") continue;
    else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

const isGlob = (s) => /[*?[{]/.test(s);
// "/" covers everything (otherwise the prefix would be "//")
const under = (p, tree) => p === tree || tree === "/" || p.startsWith(tree + "/");

// Segments of a normalized path: "/" → [""], "/a/b" → ["", "a", "b"], "~/x" → ["~", "x"].
const segsOf = (p) => (p === "/" ? [""] : p.split("/"));
// Any user directory (/Users/<anyone>): normalizePath has already reduced a literal name to "~".
const HOME_ANY = "\u0000";
// A place in the home directory — also in absolute form (/Users/*/…, /home/*/…, c:/users/*/…): so the mask
// "/Users/*/.zshrc" and the ancestors "/", "/Users" also cover "~/.zshrc".
function placeSegs(place) {
  const s = segsOf(place);
  if (s[0] !== "~") return [s];
  const rest = s.slice(1);
  return [s, ["", "users", HOME_ANY, ...rest], ["", "home", HOME_ANY, ...rest], ["c:", "users", HOME_ANY, ...rest]];
}
// A path or mask segment against a place segment: true | false | "rest" ("**" — anything after).
function segHit(m, p) {
  if (m.includes("**")) return "rest";
  if (p === HOME_ANY) return m !== "" && isGlob(m);
  if (!isGlob(m)) return m === p;
  if (/[[{]/.test(m)) return true; // crude, but errs toward covering
  return globToRe(m).test(p);
}
// A path or mask reaches a place: lies inside it or is it — "inside"; covers it as an ancestor (including
// "/", "/Users", the mask "~/Library/*") — "ancestor"; otherwise null. Compared by segments: a mask inside a dangerous
// directory ("~/Library/LaunchAgents/*.plist") and a mask with a wildcard in the middle ("~/Library/*/*.plist") are caught the same
// way as a literal path.
function reach(p, place) {
  const ms = segsOf(p);
  for (const ps of placeSegs(place)) {
    const n = Math.min(ms.length, ps.length);
    let ok = true;
    let rest = false;
    for (let i = 0; i < n; i++) {
      const h = segHit(ms[i], ps[i]);
      if (h === "rest") {
        rest = true;
        break;
      }
      if (!h) {
        ok = false;
        break;
      }
    }
    if (ok) return rest || ms.length >= ps.length ? "inside" : "ancestor";
  }
  return null;
}
// The literal part of a path: for a mask — the directories up to the first segment with a wildcard ("~/.claude/backups/x.*" →
// "~/.claude/backups"), for a path — the path itself.
function literalDir(p) {
  if (!isGlob(p)) return p;
  const s = segsOf(p);
  const i = s.findIndex((x) => isGlob(x));
  return s.slice(0, i).join("/") || (p.startsWith("/") ? "/" : "");
}

// → null | reason (in language lang, as L below)
export function pathViolation(raw, lang = "ru") {
  const p = normalizePath(raw);
  if (!p) return null;
  if (p.split("/").includes("..")) return L(lang, "путь с «..»", 'a path with ".."');
  const glob = isGlob(p);
  const re = glob ? globToRe(p) : null;
  for (const tree of FORBIDDEN_TREES) {
    const r = reach(p, tree);
    if (!glob && r === "inside") return L(lang, `запрещено: ${tree}`, `forbidden: ${tree}`);
    // an ancestor of the place, including "/", "/Users" and "/System/Volumes/Data/Users/<u>"
    if (!glob && r === "ancestor") return L(lang, `охватывает ${tree}`, `covers ${tree}`);
    // a mask inside a forbidden place (by segments) or matching its samples; a mask shorter than the place ("~/*") — by samples
    if (glob && (r === "inside" || [tree, tree + "/zz", tree + "/zz/zz.jsonl"].some((s) => re.test(s)))) return L(lang, `маска охватывает ${tree}`, `the mask covers ${tree}`);
  }
  const last = p.split("/").pop();
  if (!isGlob(last) && FORBIDDEN_FILE_RE.some((r) => r.test(last))) return L(lang, `запрещённый файл: ${last}`, `forbidden file: ${last}`);
  if (isGlob(last) && last !== "*" && last !== "**") {
    const lre = globToRe(last);
    const literal = last.replace(/[*?[\]{}]/g, "");
    const hit = FORBIDDEN_FILE_SAMPLES.find(([s, mark]) => lre.test(s) && literal.includes(mark));
    if (hit) return L(lang, `маска ${last} ловит запрещённые файлы (${hit[0]})`, `the mask ${last} catches forbidden files (${hit[0]})`);
  }
  for (const dir of KEY_DIRS) {
    if (!glob && (p === dir || reach(p, dir) === "ancestor")) return L(lang, `охватывает ${dir} (там *.key)`, `covers ${dir} (*.key lives there)`);
    if (glob && [dir + "/x.key", dir + "/zz/x.key"].some((s) => re.test(s))) return L(lang, `маска в ${dir} ловит *.key`, `the mask in ${dir} catches *.key`);
  }
  return null;
}

// ---------- takeover locations (contract 3) ----------
//
// Writing here is not forbidden (a Claude Code settings plugin needs exactly that), but through these places a plugin can take over
// Claude Code or the system: hooks, env, apiKeyHelper, permissions and MCP servers in Claude's settings; autostart; shell
// startup files; program directories on PATH (planting its own "claude"); ssh and git; the hub's own directory. The consent window
// shows such a permission as a loud line with an explanation (per kind of place), the registry linter as a warning to the reviewer.
// Kind → places (normalized like normalizePath: ~/…, lowercase). A place is a file or a directory (then everything inside too).
export const WRITE_RISKS = Object.freeze({
  // all of ~/.claude (except WRITE_SAFE): besides settings and hooks there are statusline scripts, ide/*.lock (a fake IDE and its
  // MCP), local/claude (an old install, run by an alias), shell-snapshots (read by the Bash tool), etc.
  "claude-code": ["~/.claude", "~/.claude.json", "/library/application support/claudecode", "/etc/claude-code"],
  autostart: ["~/library/launchagents", "~/library/launchdaemons", "/library/launchagents", "/library/launchdaemons", "/library/startupitems", "~/library/application support/com.apple.backgroundtaskmanagementagent", "/etc/crontab", "/etc/periodic", "/usr/lib/cron", "/var/at", "~/.config/autostart", "~/library/scripts", "~/library/workflows", "~/.hammerspoon", "~/.config/systemd/user", "~/appdata/roaming/microsoft/windows/start menu/programs/startup"],
  shell: ["~/.zshrc", "~/.zshenv", "~/.zprofile", "~/.zlogin", "~/.zlogout", "~/.bashrc", "~/.bash_profile", "~/.bash_login", "~/.bash_logout", "~/.profile", "~/.config/fish", "~/.oh-my-zsh", "~/.zsh", "~/.config/zsh", "/etc/zshrc", "/etc/zshenv", "/etc/zprofile", "/etc/profile", "/etc/bashrc", "/etc/paths", "/etc/paths.d", "/etc/launchd.conf", "/etc/sudoers", "/etc/sudoers.d", "~/documents/powershell", "~/documents/windowspowershell"],
  bin: ["~/.local/bin", "~/bin", "/usr/local/bin", "/opt/homebrew/bin", "~/.local/share/claude", "~/.npm-global", "~/.bun/bin", "~/.cargo/bin", "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules"],
  // terminals: the tab launch command (ghostty command=, kitty, WezTerm, tmux) and the session-to-tab binding that
  // the hub's typing into tabs trusts (~/.cmuxterm/claude-hook-sessions.json)
  terminals: ["~/.cmuxterm", "~/.config/cmux", "~/.config/ghostty", "~/library/application support/com.mitchellh.ghostty", "~/.config/kitty", "~/.config/wezterm", "~/.wezterm.lua", "~/.tmux.conf", "~/.config/tmux"],
  ssh: ["~/.ssh"],
  git: ["~/.gitconfig", "~/.config/git", "~/.git-templates"],
  hub: ["~/library/application support/agenthub"],
});
// Inside a dangerous place, but not a takeover: Claude Code does not read it (agent run marks, settings backups).
const WRITE_SAFE = ["~/.claude/task-runs", "~/.claude/backups"];
const HUB_DIR = "~/library/application support/agenthub";
// The project's Claude Code settings directory (.claude as a whole — hooks, commands, agents, settings) and .mcp.json: a path or
// mask aimed at them, wherever the project is.
const PROJECT_CLAUDE_RE = /(?:^|\/)\.claude(?:\/|$)|(?:^|\/)\.mcp\.json$/;
// Places on this machine found by their real paths (setLocalWritePlaces): ~/.zshrc as a link into dotfiles, etc.
let localPlaces = [];

// The daemon on a human's machine: real paths of dangerous places if they are links ([{ place, kind }], place — as normalizePath).
// The module does not touch the disk itself (the registry copies it) — the daemon collects the list.
export function setLocalWritePlaces(list) {
  localPlaces = Array.isArray(list) ? list.filter((e) => e && typeof e.place === "string" && WRITE_RISKS[e.kind]).map((e) => ({ place: normalizePath(e.place), kind: e.kind })) : [];
}

// → the kind of place (a WRITE_RISKS key) or null. A path inside a place, a path that is an ancestor of a place ("/", "/Users", "~", "~/.claude") and
// a mask that can reach a place (by segments or by samples) — all count as takeover.
// pluginId — own plugin: its PluginData/<id> and Cache/<id> in the hub directory are not a takeover. Without pluginId (or another
// plugin's id, all of PluginData, service files directly in Cache — claude-sessions.json, usage.json) — a "hub" takeover.
export function writeRisk(raw, { pluginId = null } = {}) {
  const p = normalizePath(raw);
  if (!p) return null;
  const glob = isGlob(p);
  const re = glob ? globToRe(p) : null;
  const lit = literalDir(p);
  // ".." leads out of a safe subdirectory — exceptions do not apply
  const dotdot = p.split("/").includes("..");
  const hits = (place) => Boolean(reach(p, place)) || (glob && [place, place + "/zz", place + "/zz/zz.json"].some((x) => re.test(x)));
  const own = pluginId && ID_RE.test(pluginId) ? [`${HUB_DIR}/plugindata/${pluginId}`, `${HUB_DIR}/cache/${pluginId}`] : [];
  const places = [...Object.entries(WRITE_RISKS).flatMap(([kind, list]) => list.map((place) => ({ place, kind }))), ...localPlaces];
  for (const { place, kind } of places) {
    if (!hits(place)) continue;
    // safe places inside ~/.claude and own ones in the hub directory are not a takeover if the entry (the literal part of the mask) lies within
    if (!dotdot && kind === "claude-code" && WRITE_SAFE.some((safe) => under(lit, safe))) continue;
    if (!dotdot && kind === "hub" && own.some((o) => under(lit, o))) continue;
    return kind;
  }
  // a project's .claude (the home ~/.claude is handled above, with WRITE_SAFE)
  if ((dotdot || !under(p, "~/.claude")) && PROJECT_CLAUDE_RE.test(glob ? p.replace(/[*?[\]{}]/g, "") : p)) return "claude-code";
  return null;
}

// Texts for the registry linter (reviewer) and the terminal window — what writing to such a place grants.
export const WRITE_RISK_TEXT = Object.freeze({
  "claude-code": ["настройки Claude Code: через хуки, env, apiKeyHelper, права, MCP-серверы, statusLine и команды плагин сможет запускать свои команды в каждой сессии, читать переписку и выдать себе разрешения", "Claude Code settings: through hooks, env, apiKeyHelper, permissions, MCP servers, statusLine and commands the plugin can run its own commands in every session, read conversations and grant itself permissions"],
  autostart: ["автозапуск: плагин сможет поставить программу, которая будет запускаться при каждом входе — мимо хаба и окна согласия", "autostart: the plugin can install a program that runs at every login — bypassing the hub and the consent window"],
  shell: ["файлы запуска оболочки: их команды выполняются в каждом новом терминале и в сессиях Claude Code (окружение, PATH, псевдонимы)", "shell startup files: their commands run in every new terminal and in Claude Code sessions (environment, PATH, aliases)"],
  bin: ["каталог программ из PATH или глобальных пакетов npm: можно подложить свою программу под именем claude, git или node (или подменить сам Claude Code) — она запустится вместо настоящей", "a program folder on PATH or the global npm packages: a program named claude, git or node placed here (or a replaced Claude Code) runs instead of the real one"],
  terminals: ["настройки терминала и привязка вкладок: команда, которую терминал запускает в каждой новой вкладке, и сведения, в какой вкладке какая сессия Claude Code (по ним хаб набирает во вкладки)", "terminal settings and tab bindings: the command a terminal runs in every new tab, and which tab holds which Claude Code session (the hub types into tabs by it)"],
  ssh: ["SSH: можно добавить свой ключ доступа или перенаправить подключения", "SSH: the plugin can add its own access key or redirect connections"],
  git: ["настройки git: хуки и псевдонимы git выполняют команды в каждом репозитории", "git settings: git hooks and aliases run commands in every repository"],
  hub: ["каталог самого Agent Hub: настройки хаба, установленные плагины и закрепление приложения — так обходят проверки хаба", "Agent Hub's own folder: hub settings, installed plugins and the app pin — a way around the hub's checks"],
  // not a place on disk but the <agenthub.terminal>send permission (contract 3): the same loud display
  terminal: ["набор во вкладки Claude Code: плагин сможет вводить строки в ваши сессии от вашего имени — команды и запросы, которые Claude Code исполнит с вашими правами", "typing into Claude Code tabs: the plugin can enter lines into your sessions on your behalf — commands and prompts Claude Code will run with your permissions"],
  // not a permission but the own plugin's source folder (decision 2026-11-11): writable by the group, not only by you
  "group-writable": ["папку плагина могут менять не только вы, но и ваша группа (umask 002; на Mac это обычно группа staff — все учётные записи этого компьютера). Правки с тем же набором прав хаб ставит сам, без окна согласия, — чужая правка получит доверие вашего плагина. Уберите запись для группы: chmod -R g-w <папка>", "the plugin folder can be changed not only by you but by your group too (umask 002; on a Mac that is usually the staff group — every account on this computer). The hub installs edits with the same permissions by itself, without a consent window — someone else's edit would get your plugin's trust. Remove group write: chmod -R g-w <folder>"],
  "terminal-mode": ["режимы Claude Code во вкладках: строка с «!» — команда оболочки, которую Claude Code выполнит сразу, без своих разрешений; с «#» — запись в память, которую Claude Code будет читать в каждой сессии; с «&» — фоновая задача", "Claude Code modes in tabs: a line starting with \"!\" is a shell command Claude Code runs at once, without its own permissions; \"#\" writes to memory Claude Code reads in every session; \"&\" starts a background task"],
});
export function writeRiskText(kind, lang = "ru") {
  const t = WRITE_RISK_TEXT[kind];
  return t ? (lang === "en" ? t[1] : t[0]) : null;
}

// Tokens of an exec command that look like paths.
function pathTokens(cmd) {
  return String(cmd)
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    .filter((t) => /[/\\~]|^\.env|\.key$|auth\.json$/i.test(t));
}

export function effectUnderCeiling(effect, ceiling) {
  return ceiling.some((c) => (c.endsWith(".*") ? effect === c || (effect.startsWith(c.slice(0, -1)) && /^[a-z]\w*\.[a-zA-Z*][\w]*$/.test(effect)) : effect === c));
}

// Mentions of forbidden places in the source (undeclared access).
const SOURCE_PATTERNS = [
  // ".claude/./projects", ".claude//projects" — the same directory (normalizePath removes "/./" and repeated "/")
  [/\.claude(?:[\\/]+\.)*[\\/]+projects/i, "~/.claude/projects"],
  [/workstream\.jsonl/i, "workstream.jsonl"],
  [/auth\.json/i, "auth.json"],
  // any string literal that ends in ".key" (example.com.key, `${host}.local.key`, "--key-file=my.site.key"); SF Symbol
  // names (sfimage=person.badge.key, symbol="lock.rectangle.key") are removed from the text first (sfSymbolsStripped)
  [/["'`][^"'`\n]*\.key["'`]/, "*.key"],
  [/["'`](?:[^"'`\n]*[\\/])?\.env(?:\.[\w-]+)?["'`]/, ".env"],
];

// The source without SF Symbol names (task 81): the value of sfimage= (SwiftBar's icon parameter) and of a symbol="…" attribute
// is an icon name, not a file — "person.badge.key" must not read as a key file. Only symbol-name characters are removed
// (letters, digits, dots), so "sfimage=x/../server.key" keeps its path and is still caught.
export function sfSymbolsStripped(text) {
  return String(text)
    .replace(/\bsfimage=[A-Za-z0-9.]+/g, "sfimage=")
    .replace(/\bsymbol\s*=\s*(["'])[A-Za-z0-9.]+\1/g, "symbol=$1$1");
}

export function sourceViolations(text) {
  const out = [];
  const t = sfSymbolsStripped(text);
  for (const [re, what] of SOURCE_PATTERNS) if (re.test(t)) out.push(what);
  return out;
}

// Text in language lang: ru (default — registry CI) or en (checking an own folder in the hub's English UI).
const L = (lang, ru, en) => (lang === "en" ? en : ru);

// Linter for a single plugin.
// { id, meta, source: file text, official: bool, local: bool, lang } → { errors: [...], warnings: [...], permissions }
export function lintPlugin({ id, meta, source = "", official = false, local = false, lang = "ru" }) {
  const errors = [];
  const warnings = [];
  const perms = permissionsFromMeta(meta);
  if (!ID_RE.test(id || "") || RESERVED_IDS.has(id)) errors.push(L(lang, `id «${id}»: только a-z, 0-9, «-», до 64 символов; не local/staging/disabled`, `id "${id}": only a-z, 0-9, "-", up to 64 characters; not local/staging/disabled`));
  if (!meta.title) errors.push(L(lang, "нет <agenthub.title>", "no <agenthub.title>"));
  if (!meta.version || !SEMVER_RE.test(meta.version)) errors.push(L(lang, "нет <agenthub.version> в виде 1.2.3", "no <agenthub.version> like 1.2.3"));
  if (!meta.author?.github) errors.push(L(lang, "нет <agenthub.author.github>", "no <agenthub.author.github>"));
  if (!meta.platforms?.length) errors.push(L(lang, "нет <agenthub.platforms>", "no <agenthub.platforms>"));
  for (const pl of meta.platforms || []) if (!PLATFORMS.has(pl)) errors.push(L(lang, `неизвестная платформа «${pl}»`, `unknown platform "${pl}"`));
  for (const k of NEED_WHY) {
    for (const e of perms[k] || []) if (!e.why) errors.push(L(lang, `<agenthub.${k}>${e.what}: нет пояснения «— зачем»`, `<agenthub.${k}>${e.what}: no "— why" explanation`));
  }
  for (const k of ["fsRead", "fsWrite", "watch"]) {
    for (const e of perms[k]) {
      const v = pathViolation(e.what, lang);
      if (v) errors.push(`<agenthub.${k}>${e.what}: ${v}`);
    }
  }
  // dependency (<agenthub.requires>): the core checks whether the check path exists — and it must not lead into forbidden places
  for (const r of meta.requires || []) {
    const v = pathViolation(r.check, lang);
    if (v) errors.push(`<agenthub.requires name="${r.name}">: check ${r.check}: ${v}`);
  }
  for (const e of perms.exec) {
    for (const t of pathTokens(e.what)) {
      const v = pathViolation(t, lang);
      if (v) errors.push(`<agenthub.exec>${e.what}: ${v}`);
    }
  }
  // the same shape the secrets service accepts: "<service>.<account>" (service — the plugin id, up to 64; account up to 64)
  for (const e of perms.secrets) if (!/^[a-z0-9][a-z0-9_-]{0,63}\.[a-z][a-z0-9_.-]{0,63}$/.test(e.what)) errors.push(L(lang, `<agenthub.secrets>${e.what}: ключ «<сервис>.<имя>»: a-z, 0-9, «_-» в сервисе (до 64), a-z, 0-9, «._-» в имени (с буквы, до 64)`, `<agenthub.secrets>${e.what}: the key is "<service>.<name>": a-z, 0-9, "_-" in the service (up to 64), a-z, 0-9, "._-" in the name (starting with a letter, up to 64)`));
  for (const e of perms.effects) if (!/^[a-z]\w*\.(?:[a-zA-Z]\w*|\*)$/.test(e)) errors.push(L(lang, `effects «${e}»: не имя примитива`, `effects "${e}": not a primitive name`));
  // effects are under the ceiling for all registry plugins (official ones too: control only via their own actions)
  const ceiling = local ? LOCAL_EFFECTS : THIRD_PARTY_EFFECTS;
  for (const e of perms.effects) if (!effectUnderCeiling(e, ceiling)) errors.push(L(lang, `effects «${e}»: плагину реестра доступны только ${ceiling.join(", ")}`, `effects "${e}": a registry plugin may use only ${ceiling.join(", ")}`));
  // cmux.focus is an alias of terminal.focus until the next contract
  if (perms.effects.includes("cmux.focus")) warnings.push(L(lang, `effects «cmux.focus»: устарело — пишите terminal.focus (то же, для любого терминала) или session.focus <sessionId>`, `effects "cmux.focus": deprecated — write terminal.focus (the same, for any terminal) or session.focus <sessionId>`));
  if (!official) {
    // community actions (G3): the core runs them only from the app and never below confirm — immediate is raised; with the
    // plugin's network (no net="none" on the action) or a cost= — to confirm-cost, as core.actionLevel does
    for (const a of meta.actions || []) {
      if (a.level !== "immediate") continue;
      const priced = ((perms.net || []).length && a.net !== "none") || a.cost || Object.values(a.i18n || {}).some((x) => x?.cost);
      if (priced) warnings.push(L(lang, `<agenthub.action id="${a.id}">: у плагина сообщества ядро поднимет immediate до confirm-cost (сеть плагина без net="none" или cost=) — окно подтверждения с ценой будет всегда`, `<agenthub.action id="${a.id}">: for a community plugin the core raises immediate to confirm-cost (the plugin's network without net="none", or cost=) — there is always a confirmation window with the cost`));
      else warnings.push(L(lang, `<agenthub.action id="${a.id}">: у плагина сообщества ядро поднимет immediate до confirm — окно подтверждения будет всегда`, `<agenthub.action id="${a.id}">: for a community plugin the core raises immediate to confirm — there is always a confirmation window`));
    }
    if ((meta.actions || []).length) warnings.push(L(lang, `<agenthub.action>: действия плагина сообщества — только из приложения, с окном подтверждения; ревьюер проверяет, что команда делает ровно то, что сказано в title`, `<agenthub.action>: community plugin actions run only from the app, with a confirmation window; the reviewer checks the command does exactly what its title says`));
  } else {
    // an official action may be immediate (no confirmation window, app only; decision 2026-11-09) —
    // if the plugin declares no network and the action no cost: otherwise the core would raise it to confirm-cost (core.actionLevel),
    // so let the author see that here. "No network and no cost=" does not mean "free" — every immediate action
    // is flagged with a warning: the registry reviewer checks that it spends nothing beyond what its title says.
    for (const a of meta.actions || []) {
      if (a.level !== "immediate") continue;
      if ((perms.net || []).length && a.net !== "none") errors.push(L(lang, `<agenthub.action id="${a.id}">: immediate — только у плагина без сети (с сетью ядро спросит подтверждения)`, `<agenthub.action id="${a.id}">: immediate only for a plugin without network (with network the core asks for confirmation)`));
      else if (a.cost || Object.values(a.i18n || {}).some((x) => x?.cost)) errors.push(L(lang, `<agenthub.action id="${a.id}">: immediate с ценой (cost=) — ядро спросит подтверждения с ценой; цену без окна — только словами в title`, `<agenthub.action id="${a.id}">: immediate with a cost (cost=) — the core asks for confirmation with the cost; a cost without a window — only in words in title`));
      else warnings.push(L(lang, `<agenthub.action id="${a.id}">: immediate — запуск одним щелчком, без окна: ревьюер проверяет, что действие ничего не тратит (квота, деньги, запуск агентов) сверх сказанного в title`, `<agenthub.action id="${a.id}">: immediate — runs in one click, no window: the reviewer checks it spends nothing (quota, money, starting agents) beyond what the title says`));
    }
  }
  // Action attributes the reviewer checks by reading the code (G1, G2, G6) — for every tier.
  for (const a of meta.actions || []) {
    if (a.net === "none") {
      if (!(perms.net || []).length) warnings.push(L(lang, `<agenthub.action id="${a.id}">: net="none" без <agenthub.net> ничего не меняет`, `<agenthub.action id="${a.id}">: net="none" without <agenthub.net> changes nothing`));
      else warnings.push(L(lang, `<agenthub.action id="${a.id}">: net="none" — ядро снимает для этого действия порог confirm-cost от <agenthub.net>; ревьюер проверяет, что команда не выходит в сеть (ни сама, ни через запускаемые программы)`, `<agenthub.action id="${a.id}">: net="none" — the core lifts the confirm-cost floor <agenthub.net> puts on this action; the reviewer checks the command never reaches the network (neither itself nor through programs it starts)`));
    }
    if (a.background) warnings.push(L(lang, `<agenthub.action id="${a.id}">: background="true" — фоновая задача без ограничения по времени; ревьюер проверяет, что она завершается сама и по SIGTERM и не тратит больше, чем сказано в title`, `<agenthub.action id="${a.id}">: background="true" — a background job with no time limit; the reviewer checks it ends by itself and on SIGTERM and spends no more than its title says`));
    if (a.input) warnings.push(L(lang, `<agenthub.action id="${a.id}">: input= — текст человека приходит на stdin; ревьюер проверяет, что команда обращается с ним как с данными (без eval, оболочки и подстановки в команды)`, `<agenthub.action id="${a.id}">: input= — the person's text arrives on stdin; the reviewer checks the command treats it as data (no eval, shell or splicing into commands)`));
  }
  // Connections: only for official and own plugins (the core takes them only from builtin/official/own — for a third-party plugin
  // the permission in the consent window would promise something that will not happen); the address host (and the authorization server's hosts) only from
  // the plugin's declared network; the id is its own: the plugin id or "<plugin id>.<name>" (a plugin id never contains a dot).
  const netHosts = new Set(perms.net.map((e) => e.what.toLowerCase()));
  if (!official && (meta.connections || []).length) errors.push(L(lang, "<agenthub.connection>: подключения есть только у официальных и своих плагинов", "<agenthub.connection>: only official and your own plugins have connections"));
  for (const c of meta.connections || []) {
    const name = c.id || id;
    for (const h of [c.host, ...(c.hosts || [])]) {
      if (h && !netHosts.has(String(h).toLowerCase())) errors.push(L(lang, `<agenthub.connection id="${name}">: хост ${h} не объявлен в <agenthub.net>`, `<agenthub.connection id="${name}">: host ${h} isn't declared in <agenthub.net>`));
    }
    // type="http" (G7): the hub sends the token to the API hosts and proxies the plugin's requests — the reviewer checks the hosts
    // belong to the service, writes (methods beyond GET/HEAD) match what the plugin says, and paths narrow access where possible
    if (c.type === "http" && c.http) {
      warnings.push(L(lang, `<agenthub.connection id="${name}" type="http">: хаб отправляет токен на ${(c.http.hosts || []).join(", ")} и проксирует запросы плагина; ревьюер проверяет, что это хосты самого сервиса, а client_id — публичный клиент автора (без секрета)`, `<agenthub.connection id="${name}" type="http">: the hub sends the token to ${(c.http.hosts || []).join(", ")} and proxies the plugin's requests; the reviewer checks these are the service's own hosts and client_id is the author's public client (no secret)`));
      const writes = (c.http.methods || []).filter((m) => m !== "GET" && m !== "HEAD");
      if (writes.length) warnings.push(L(lang, `<agenthub.connection id="${name}">: methods=${writes.join(",")} — запись в сервис от имени человека; ревьюер проверяет, что плагин пишет только по действию человека${c.http.paths?.length ? "" : " (paths= не задан — доступ ко всему API)"}`, `<agenthub.connection id="${name}">: methods=${writes.join(",")} — writes to the service on the person's behalf; the reviewer checks the plugin writes only on the person's action${c.http.paths?.length ? "" : " (no paths= — the whole API is reachable)"}`));
    }
    if (id && !connectionIdOk(id, c.id)) errors.push(L(lang, `<agenthub.connection id="${name}">: id подключения — id плагина или «${id}.<имя>» (имя: a-z, 0-9, «-», с буквы, до 32; целиком — с буквы, до 64)`, `<agenthub.connection id="${name}">: the connection id must be the plugin id or "${id}.<name>" (name: a-z, 0-9, "-", starting with a letter, up to 32; the whole id starts with a letter, up to 64)`));
  }
  // Terminal (contract 3): only for official and own plugins (the core gives the /terminal/* route only to builtin/official/own);
  // the entry is read-screen or send <words>|*; typing into a tab is a warning to the reviewer.
  if (!official && (perms.terminal || []).length) errors.push(L(lang, "<agenthub.terminal>: терминал есть только у официальных и своих плагинов", "<agenthub.terminal>: only official and your own plugins may use the terminal"));
  for (const e of perms.terminal || []) {
    const t = parseTerminalPerm(e.what);
    if (!t) errors.push(L(lang, `<agenthub.terminal>${e.what}: ждём «read-screen», «send /команда …» (slash-команда: «/», затем a-z, 0-9, «-»; до ${TERMINAL_WORDS_MAX}), «send ! # &» (знаки режимов) или «send *»`, `<agenthub.terminal>${e.what}: expected "read-screen", "send /command …" (a slash command: "/" then a-z, 0-9, "-"; up to ${TERMINAL_WORDS_MAX}), "send ! # &" (mode characters) or "send *"`));
    else if (t.op === "send" && t.modes.length) warnings.push(L(lang, `<agenthub.terminal>${e.what}: ${writeRiskText("terminal-mode", "ru")}. Право нужно только плагину, который без этого не может; проверьте, что плагин набирает такие строки только по явному действию человека и показывает их текст в окне подтверждения`, `<agenthub.terminal>${e.what}: ${writeRiskText("terminal-mode", "en")}. Only a plugin that cannot do without it needs this; check the plugin types such lines only on an explicit action of the person and shows their text in the confirmation`));
    else if (t.op === "send") warnings.push(L(lang, `<agenthub.terminal>${e.what}: ${writeRiskText("terminal", "ru")}. Проверьте, что плагин набирает только обещанное и только по действию человека или его настройке${t.any ? "; «send *» — любой запрос и любая slash-команда (кроме строк с «!», «#», «&» в начале — на них отдельное право «send !»)" : ""}`, `<agenthub.terminal>${e.what}: ${writeRiskText("terminal", "en")}. Check the plugin types only what it promises and only on the person's action or setting${t.any ? '; "send *" — any prompt and any slash command (except lines starting with "!", "#", "&" — those need the separate "send !" right)' : ""}`));
  }
  // Event subscriptions (G11): the core delivers them only to trusted streamable plugins — for the rest the tag is ignored (a warning,
  // not an error: the plugin still works); a malformed entry or too many is an error; "*" (every plugin) is a warning for the reviewer.
  const subs = perms.subscribe || [];
  if (subs.length && !official) warnings.push(L(lang, "<agenthub.subscribe>: подписки на события получают только официальные и свои плагины — у этого плагина ядро их пропустит", "<agenthub.subscribe>: only official and your own plugins get event subscriptions — the core ignores them for this plugin"));
  if (subs.length && meta.type !== "streamable") warnings.push(L(lang, "<agenthub.subscribe>: события приходят на stdin только плагину <agenthub.type>streamable</agenthub.type> — у этого плагина ядро их пропустит", "<agenthub.subscribe>: events arrive on stdin only for a <agenthub.type>streamable</agenthub.type> plugin — the core ignores them for this one"));
  if (subs.length > SUBSCRIBE_MAX) errors.push(L(lang, `<agenthub.subscribe>: не больше ${SUBSCRIBE_MAX} подписок`, `<agenthub.subscribe>: at most ${SUBSCRIBE_MAX} subscriptions`));
  for (const e of subs) {
    const sp = parseSubscribePerm(e.what);
    if (!sp) errors.push(L(lang, `<agenthub.subscribe>${e.what}: ждём «<id плагина>:<начало ключа события>» или «*:<начало ключа>»`, `<agenthub.subscribe>${e.what}: expected "<plugin id>:<event key prefix>" or "*:<key prefix>"`));
    else if (sp.plugin === "*") warnings.push(L(lang, `<agenthub.subscribe>${e.what}: события всех плагинов (с текстом их строк) — ревьюер проверяет, что плагину это нужно и он не уносит их наружу`, `<agenthub.subscribe>${e.what}: events of every plugin (with their row text) — the reviewer checks the plugin needs this and doesn't send them anywhere`));
  }
  // Writing to takeover locations of Claude Code and the system (contract 3): allowed, but the reviewer checks that the plugin writes
  // exactly what it promises there (an allowlist of keys, a backup before editing) — the consent window shows it loudly.
  for (const e of perms.fsWrite) {
    const risk = writeRisk(e.what, { pluginId: id });
    if (risk) warnings.push(L(lang, `<agenthub.fsWrite>${e.what}: место перехвата (${risk}) — ${writeRiskText(risk, "ru")}. Проверьте, что плагин пишет туда только обещанное; окно согласия показывает это право громкой строкой`, `<agenthub.fsWrite>${e.what}: a takeover location (${risk}) — ${writeRiskText(risk, "en")}. Check the plugin writes only what it promises there; the consent window shows this permission as a loud line`));
  }
  // Deprecated contract 1 push kinds: they work as the plugin's own switch, but it is time to move to kind="plugin".
  for (const r of meta.push || []) {
    if (r?.legacyKind && r.kind === "plugin" && !r.wasDeclared) {
      // was= declared explicitly — this is not a deprecated entry but a switch migration (parsePushRule marks wasDeclared)
      warnings.push(L(lang, `<agenthub.push key="${r.key}" kind="${r.legacyKind}">: вид устарел (контракт 1) — пишите kind="plugin" was="${r.legacyKind}"`, `<agenthub.push key="${r.key}" kind="${r.legacyKind}">: the kind is deprecated (contract 1) — write kind="plugin" was="${r.legacyKind}"`));
    }
  }
  // Community push rules (G3): the core takes only kind="plugin" ones and only their label — the rest is ignored, say so.
  if (!official) {
    for (const r of meta.push || []) {
      if (!r || typeof r.key !== "string") continue;
      if (r.kind !== "plugin") warnings.push(L(lang, `<agenthub.push key="${r.key}">: у плагина сообщества действуют только правила kind="plugin" — это правило ядро пропустит`, `<agenthub.push key="${r.key}">: a community plugin only gets kind="plugin" rules — the core skips this one`));
      else if (r.quietException || r.awayDelayMs || r.hold || r.cooldownMs) warnings.push(L(lang, `<agenthub.push key="${r.key}">: у плагина сообщества quiet, away, hold и cooldown не действуют — только подпись и macOnly`, `<agenthub.push key="${r.key}">: for a community plugin quiet, away, hold and cooldown have no effect — only the label and macOnly are used`));
    }
  }
  // Icon: the symbol name and color are checked by metadata parsing; an invalid tag is a parsing warning (not here).
  // Forbidden places are an error for everyone: there are no exceptions based on the official mark.
  for (const what of sourceViolations(source)) errors.push(L(lang, `исходник упоминает запретное место: ${what}`, `the source mentions a forbidden location: ${what}`));
  return { errors, warnings, permissions: perms };
}
