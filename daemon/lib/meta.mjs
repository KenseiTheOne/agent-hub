// Plugin metadata: the file name and <agenthub.*> tags from comments (for binaries — xattr).
//
// File name: {name}.{interval}.{ext} or {name}.{ext}; interval — a number + ms|s|m|h|d.
// Folder plugin: <dir>/ with a <dir>.{interval}.{ext} or <dir>.{ext} file inside.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { execFileSync } from "node:child_process";
import { loadNative } from "./native.mjs";
import { parseMsg as msg } from "./messages/parse.mjs";

export const XATTR_NAME = "com.kensei.agenthub.meta";
export const LEVELS = ["immediate", "confirm", "confirm-cost"];
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const LANG_RE = /^[a-z]{2}$/;
const IGNORED_EXT = new Set(["md", "txt", "json", "lock", "log", "orig", "bak", "swp"]);

// Multi-value tags (repeated → array).
const MULTI = new Set(["watch", "fsRead", "fsWrite", "exec", "secrets", "net", "terminal"]);
// Comma-separated list tags.
const CSV = new Set(["effects", "platforms"]);

export function parseInterval(text) {
  const m = /^(\d+)(ms|s|m|h|d)$/.exec(String(text));
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2]];
}

// → { id, interval, intervalMs, ext } | null
export function parseFileName(fileName) {
  const name = basename(fileName);
  if (!name || name.startsWith(".") || name.startsWith("_")) return null;
  let m = /^(.+)\.(\d+(?:ms|s|m|h|d))\.([A-Za-z0-9]+)$/.exec(name);
  if (m) return { id: m[1], interval: m[2], intervalMs: parseInterval(m[2]), ext: m[3].toLowerCase() };
  m = /^(.+)\.([A-Za-z0-9]+)$/.exec(name);
  if (m) {
    const ext = m[2].toLowerCase();
    if (IGNORED_EXT.has(ext)) return null;
    return { id: m[1], interval: null, intervalMs: null, ext };
  }
  // no extension (binary)
  if (/^[A-Za-z0-9][\w-]*$/.test(name)) return { id: name, interval: null, intervalMs: null, ext: "" };
  return null;
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function parseAttrs(text) {
  const out = {};
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = unescapeXml(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

// Argument of a parameterized action: arg="taskId:^[A-Za-z0-9_-]{1,64}$" → { name, pattern } | null.
// The pattern must be anchored at both ends (^…$): otherwise a substring "match" would let anything through.
// The core checks the argument value against the pattern and passes it as a separate argv element, without a shell (lib/core.mjs).
export const ACTION_ARG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export function parseActionArg(text) {
  const m = /^([^:]+):(.+)$/.exec(String(text ?? ""));
  if (!m || !ACTION_ARG_NAME_RE.test(m[1])) return null;
  const pattern = m[2];
  if (pattern.length > 200 || !pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) return null;
  try {
    new RegExp(pattern, "u");
  } catch {
    return null;
  }
  return { name: m[1], pattern };
}

// The plugin contract version this core understands (docs/extension-points.md, "Contract versions"): 1 — before 2026-11-09
// (implicit), 2 — the core cleaned of plugin names: own notification toggles (kind="plugin"), the icon
// (<agenthub.icon>), connections (<agenthub.connection>), action refusal text (message=), the
// <agenthub.contract> tag itself; 3 (2026-11-10) — metadata of live Claude Code sessions for trusted plugins
// (AGENTHUB_CLAUDE_SESSIONS_FILE), the hub pause flag in every run's environment (AGENTHUB_PAUSED) and restarting
// plugins when it is set and cleared, a loud warning in the consent window for writes to Claude Code and system hijack locations,
// terminal: read a tab's screen and type a line into a Claude Code session tab (<agenthub.terminal>, /terminal/*).
// A plugin declares the minimum version it needs; anything newer than this one — install and update refuse with "a newer hub is required"
// (rather than a linter error).
export const CONTRACT_VERSION = 3;

// Push rule for a plugin event key:
//   <agenthub.push key="build-blocked" hold="evening" quiet="true" macOnly="true" cooldown="7d" away="5m" kind="plugin">Label</agenthub.push>
// The core and the push service take such rules only from built-in, official and own plugins (tier from the manager's
// policy: a signed index or consent for an own one); for the rest they are ignored. kind — the notification kind for
// the toggles in Settings (PUSH_KINDS): a general core kind, "plugin" — the plugin's own toggle (a line with the
// plugin name in Settings → Notifications), "security" — a security exception that cannot be turned off.
// Legacy contract 1 kinds ("runs", "night") are accepted as "plugin" (the linter warns) and remembered in
// legacyKind: a legacy kind the user turned off also silences the plugin's own toggle (lib/push/prefs.mjs). The same
// migration for a rule with a new kind — the was="runs|night" attribute. → { key, label, hold?, quietException?, macOnly?,
// cooldownMs?, awayDelayMs?, kind?, legacyKind? } | error text
export const PUSH_KINDS = ["sessions", "updates", "problems", "other", "security", "plugin"];
export const LEGACY_PUSH_KINDS = ["runs", "night"];
export function parsePushRule(attrs, label) {
  const key = attrs.key;
  if (!key || !/^[\w.-]{1,64}$/.test(key)) return msg("meta.push.noKey");
  const out = { key, label: label ? label.slice(0, 80) : null };
  if (attrs.hold !== undefined) {
    if (attrs.hold !== "evening") return msg("meta.push.hold", { key });
    out.hold = "evening";
  }
  const bool = (v) => (v === "true" ? true : v === "false" ? false : undefined);
  if (attrs.quiet !== undefined) out.quietException = bool(attrs.quiet) ?? false;
  if (attrs.macOnly !== undefined) out.macOnly = bool(attrs.macOnly) ?? false;
  if (attrs.kind !== undefined) {
    if (LEGACY_PUSH_KINDS.includes(attrs.kind)) {
      out.kind = "plugin";
      out.legacyKind = attrs.kind;
    } else if (!PUSH_KINDS.includes(attrs.kind)) return msg("meta.push.kind", { key, list: PUSH_KINDS.join("|") });
    else out.kind = attrs.kind;
  }
  if (attrs.was !== undefined) {
    if (!LEGACY_PUSH_KINDS.includes(attrs.was)) return msg("meta.push.was", { key, list: LEGACY_PUSH_KINDS.join("|") });
    if (out.kind !== "plugin") return msg("meta.push.wasKind", { key });
    out.legacyKind = attrs.was;
    out.wasDeclared = true;
  }
  for (const [a, k] of [["cooldown", "cooldownMs"], ["away", "awayDelayMs"]]) {
    if (attrs[a] === undefined) continue;
    const ms = parseInterval(attrs[a]);
    if (ms === null) return msg("meta.interval", { what: `${key}: ${a}` });
    out[k] = ms;
  }
  return out;
}

// Plugin icon: <agenthub.icon symbol="star" color="#FF9F0A"></agenthub.icon>. symbol — an SF Symbol name (lowercase
// Latin letters and digits separated by dots), color — #RRGGBB; the shell draws the tile with a gradient from this color. No tag
// or an invalid one — the neutral default icon. → { symbol, color } | error text
export const ICON_SYMBOL_RE = /^[a-z0-9]+(?:\.[a-z0-9]+){0,7}$/;
export const ICON_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
export function parseIcon(attrs) {
  const symbol = String(attrs.symbol || "").trim();
  if (!symbol || symbol.length > 64 || !ICON_SYMBOL_RE.test(symbol)) return msg("meta.icon.symbol");
  const out = { symbol };
  if (attrs.color !== undefined) {
    const color = String(attrs.color).trim();
    if (!ICON_COLOR_RE.test(color)) return "icon: color — #RRGGBB";
    out.color = color.toUpperCase();
  }
  return out;
}

// An OAuth connection to an external service that the hub manages on the plugin's behalf (the oauth service, docs/api.md "Connections"):
//   <agenthub.connection id="example.tasks" type="mcp" url="https://mcp.example.com/mcp" scope="read" title="Example"
//     tools="get_user,filter_tasks" interval="15m" budget="100">why</agenthub.connection>
// id — the connection name: by default the plugin id, otherwise "<plugin id>.<name>" (name — a-z, 0-9, "-", starting with a letter, up to 32);
// as a whole — starting with a letter and up to 64 characters (a plugin whose id starts with a digit or is longer than 64 cannot declare a connection
// with a short <name> — the declaration is rejected rather than breaking later in the keychain). A plugin id never contains a dot, so the connection
// id always shows whose it is: plugin foo cannot declare a connection of plugin foo-bar. The same name is used for the entry in
// the keychain (agent-hub.oauth / <id>.client|token, lib/services/secrets.mjs — the same rule). type — mcp only, url — https on a host name (not an IP address), its host must be in the plugin's <agenthub.net>
// (checked by the linter and the core), hosts — additional authorization server hosts (also from net), scope — what to request at
// sign-in, tools — an allowlist of MCP tools (1–32), interval — no more than one identical call per that period (the core
// enforces limits of 5 min … 24 h), budget — calls per rolling 24 hours (1…10000). Taken only from trusted
// plugins (builtin, official, own; the registry linter does not admit it for third-party ones); in the consent window — as a permission of kind
// connections. → { … } | error text
export const CONNECTION_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const CONNECTION_ID_RE = /^(?=.{1,64}$)[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]{0,31})?$/;
// A connection id belongs to plugin pluginId: equals it or "<pluginId>.<name>".
export function connectionIdOf(pluginId, id) {
  const cid = id || pluginId;
  if (!CONNECTION_ID_RE.test(String(cid || ""))) return false;
  return cid === pluginId || (cid.startsWith(`${pluginId}.`) && CONNECTION_NAME_RE.test(cid.slice(pluginId.length + 1)));
}
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
// A host name, not an IP address: the last label (top-level domain) contains a letter (127.0.0.1, 169.254.169.254 — no).
export function hostNameOk(h) {
  const s = String(h || "");
  return HOST_RE.test(s) && /[a-z]/.test(s.slice(s.lastIndexOf(".") + 1));
}
export function parseConnection(attrs, note) {
  const id = attrs.id === undefined ? null : String(attrs.id).trim();
  if (id !== null && !CONNECTION_ID_RE.test(id)) return msg("meta.conn.id");
  const type = attrs.type === undefined ? "mcp" : String(attrs.type).trim();
  if (type !== "mcp") return msg("meta.conn.type", { id: id || "?" });
  let url;
  try {
    url = new URL(String(attrs.url || ""));
  } catch {
    return msg("meta.conn.url", { id: id || "?" });
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || !hostNameOk(url.hostname) || url.hash) return msg("meta.conn.urlHost", { id: id || "?" });
  const hosts = [];
  for (const h of String(attrs.hosts || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (!hostNameOk(h)) return msg("meta.conn.hosts", { id: id || "?" });
    if (!hosts.includes(h)) hosts.push(h);
  }
  const scope = attrs.scope === undefined ? null : String(attrs.scope).trim();
  if (scope !== null && !/^[\w:./-]+(?: [\w:./-]+){0,15}$/.test(scope)) return msg("meta.conn.scope", { id: id || "?" });
  const tools = String(attrs.tools || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!tools.length || tools.length > 32 || tools.some((x) => !/^[A-Za-z0-9_.-]{1,64}$/.test(x))) return msg("meta.conn.tools", { id: id || "?" });
  let intervalMs = 15 * 60_000;
  if (attrs.interval !== undefined) {
    intervalMs = parseInterval(attrs.interval);
    if (intervalMs === null) return msg("meta.interval", { what: `connection ${id || "?"}: interval` });
  }
  let budget = 100;
  if (attrs.budget !== undefined) {
    budget = Number(attrs.budget);
    if (!Number.isInteger(budget) || budget < 1 || budget > 10_000) return msg("meta.conn.budget", { id: id || "?" });
  }
  const title = attrs.title === undefined ? null : String(attrs.title).trim();
  if (title !== null && (!title || title.length > 64 || /[\p{Cc}\p{Cf}]/u.test(title))) return msg("meta.conn.title", { id: id || "?" });
  return { id, type, url: url.href, host: url.hostname, hosts, scope, tools: [...new Set(tools)], intervalMs, budget, title, note: note ? note.slice(0, 300) : null };
}

// Plugin dependency: <agenthub.requires name="Tool" url="https://…" check="~/.tool">why</agenthub.requires>.
// name — what to call the program ("Requires Tool"), url — where to get it (https:// only), check — a path whose presence
// shows it is installed (~/… or absolute; no wildcards). → { name, url, check, note } | error text
export function parseRequires(attrs, note) {
  const name = String(attrs.name || "").trim();
  if (!name || name.length > 64 || /[\p{Cc}\p{Cf}]/u.test(name)) return msg("meta.req.name");
  const url = String(attrs.url || "").trim();
  if (!/^https:\/\/[^\s"'<>]{1,500}$/.test(url)) return msg("meta.req.url", { name });
  const check = String(attrs.check || "").trim();
  if (!/^(?:~\/|\/)[^\0*?[\]{}]{0,500}$/.test(check) || check.split("/").includes("..")) return msg("meta.req.check", { name });
  return { name, url, check, note: note ? note.slice(0, 300) : null };
}

const STATUS_VALUES = ["ok", "unknown", "wait", "block", "error"];
function parseStatusTag(attrs, value) {
  if (!STATUS_VALUES.includes(attrs.value)) return msg("meta.status.value", { list: STATUS_VALUES.join("|") });
  if (!attrs.label) return msg("meta.status.label", { value: attrs.value });
  return { value: attrs.value, label: attrs.label.slice(0, 40), hint: value ? value.slice(0, 200) : null };
}

// Parsing tags from text. Returns { meta, warnings }.
export function parseMetaText(text) {
  const warnings = [];
  const meta = {
    title: null,
    version: null,
    author: {},
    desc: null,
    type: "standard",
    schedule: null,
    platforms: [],
    watch: [],
    fsRead: [],
    fsWrite: [],
    exec: [],
    secrets: [],
    net: [],
    // Terminal (contract 3): <agenthub.terminal>read-screen | send <words>|* — why</agenthub.terminal> (lib/registry/perms.mjs)
    terminal: [],
    effects: [],
    actions: [],
    push: [],
    // Own status labels: <agenthub.status value="wait" label="Quota running low">explanation</agenthub.status>
    // → { wait: { label, hint } }. The shell shows label on the tile and in the card, the explanation as a tooltip;
    // a status without a label — the shell's common table.
    statuses: {},
    // Dependencies — external programs without which the plugin is useless (the catalog shows "Requires Tool"):
    // <agenthub.requires name="Tool" url="https://…" check="~/.tool">why</agenthub.requires>
    // → [{ name, url, check, note }]. This is not a permission: the core only checks whether the check path exists.
    requires: [],
    // Minimum contract version (<agenthub.contract>2</agenthub.contract>); null — not declared (contract 1).
    contract: null,
    // Icon (<agenthub.icon symbol="…" color="#RRGGBB">) → { symbol, color? } | null.
    icon: null,
    // Connections to external services (<agenthub.connection …>) → [{ id, type, url, host, hosts, scope, tools,
    // intervalMs, budget, title, note }]; id null — by the plugin id.
    connections: [],
    extra: {},
    // Translations (AGENTHUB_LANG): { en: { title, desc, why: { <what>: <why> } } }. Tags with lang="xx" — the variant
    // in language xx; without lang — the plugin's default language. Actions — title-xx / cost-xx attributes (action.i18n).
    i18n: {},
  };
  const loc = (lang) => (meta.i18n[lang] ||= {});
  const re = /<agenthub\.([A-Za-z][\w.]*)((?:\s+[^>]*)?)>([\s\S]*?)<\/agenthub\.\1>/g;
  let m;
  while ((m = re.exec(text))) {
    const tag = m[1];
    const attrs = parseAttrs(m[2] || "");
    const value = unescapeXml(m[3].replace(/\s*\n\s*(?:#|\/\/|--|;)?\s*/g, " ").trim());
    const lang = attrs.lang !== undefined && tag !== "action" ? attrs.lang : null;
    if (lang !== null) {
      if (!LANG_RE.test(lang)) {
        warnings.push(msg("meta.lang.code", { tag, lang: lang.slice(0, 10) }));
        continue;
      }
      if (tag === "title" || tag === "desc") loc(lang)[tag] = value;
      else if (tag === "status") {
        const st = parseStatusTag(attrs, value);
        if (typeof st === "string") warnings.push(st);
        else (loc(lang).statuses ||= {})[st.value] = { label: st.label, hint: st.hint };
      }
      else if (tag === "push") {
        const r = meta.push.find((x) => x.key === attrs.key);
        if (r) (r.labels ||= {})[lang] = value.slice(0, 80);
        else warnings.push(msg("meta.lang.pushFirst", { key: attrs.key || "?", lang }));
      } else if (MULTI.has(tag)) {
        const { what, why } = splitWhy(value);
        if (why) (loc(lang).why ||= {})[what] = why;
      } else if (tag === "requires") {
        // translation of the dependency's explanation (and its name, if given) — matched by the name of the rule without lang
        const r = meta.requires.find((x) => x.name === attrs.name);
        if (!r) warnings.push(msg("meta.lang.requiresFirst", { name: attrs.name || "?", lang }));
        else ((loc(lang).requires ||= {})[r.name] = { ...(value ? { note: value.slice(0, 300) } : {}), ...(attrs.title ? { name: attrs.title.slice(0, 64) } : {}) });
      } else if (tag === "connection") {
        // translation of the connection's title (title=) and explanation — by id (no id — the first connection without an id)
        const id = attrs.id === undefined ? null : String(attrs.id);
        const c = meta.connections.find((x) => x.id === id);
        if (!c) warnings.push(msg("meta.lang.connFirst", { id: id || "?", lang }));
        else ((loc(lang).connections ||= {})[id || ""] = { ...(value ? { note: value.slice(0, 300) } : {}), ...(attrs.title ? { title: String(attrs.title).slice(0, 64) } : {}) });
      } else warnings.push(msg("meta.lang.unsupported", { tag }));
      continue;
    }
    if (tag === "action") {
      const id = attrs.id;
      const level = attrs.level || "confirm";
      if (!id || !/^[A-Za-z0-9][\w.-]{0,63}$/.test(id)) {
        warnings.push(msg("meta.action.id", { value: value.slice(0, 40) }));
        continue;
      }
      if (!LEVELS.includes(level)) {
        warnings.push(msg("meta.action.level", { id, level }));
        continue;
      }
      if (!value) {
        warnings.push(msg("meta.action.empty", { id }));
        continue;
      }
      if (meta.actions.some((a) => a.id === id)) {
        warnings.push(msg("meta.action.dup", { id }));
        continue;
      }
      let arg = null;
      if (attrs.arg !== undefined) {
        arg = parseActionArg(attrs.arg);
        if (!arg) {
          warnings.push(msg("meta.action.arg", { id }));
          continue;
        }
      }
      const i18n = {};
      for (const [k, v] of Object.entries(attrs)) {
        const lm = /^(title|cost)-([a-z]{2})$/.exec(k);
        if (lm && v) (i18n[lm[2]] ||= {})[lm[1]] = v;
      }
      meta.actions.push({ id, level, command: value, title: attrs.title || null, cost: attrs.cost || null, ...(arg ? { arg } : {}), ...(Object.keys(i18n).length ? { i18n } : {}) });
    } else if (tag === "push") {
      const r = parsePushRule(attrs, value);
      if (typeof r === "string") warnings.push(`push: ${r}`);
      else if (meta.push.some((x) => x.key === r.key)) warnings.push(msg("meta.push.dup", { key: r.key }));
      else if (meta.push.length >= 32) warnings.push(msg("meta.push.many"));
      else meta.push.push(r);
    } else if (tag === "status") {
      const st = parseStatusTag(attrs, value);
      if (typeof st === "string") warnings.push(st);
      else meta.statuses[st.value] = { label: st.label, hint: st.hint };
    } else if (tag === "requires") {
      const r = parseRequires(attrs, value);
      if (typeof r === "string") warnings.push(`requires: ${r}`);
      else if (meta.requires.some((x) => x.name === r.name)) warnings.push(msg("meta.req.dup", { name: r.name }));
      else if (meta.requires.length >= 8) warnings.push(msg("meta.req.many"));
      else meta.requires.push(r);
    } else if (tag === "icon") {
      const ic = parseIcon(attrs);
      if (typeof ic === "string") warnings.push(ic);
      else if (meta.icon) warnings.push(msg("meta.icon.dup"));
      else meta.icon = ic;
    } else if (tag === "contract") {
      const n = /^\d{1,4}$/.test(value) ? Number(value) : NaN;
      if (!Number.isInteger(n) || n < 1) warnings.push(msg("meta.contract", { value: value.slice(0, 10) }));
      else meta.contract = n;
    } else if (tag === "connection") {
      const c = parseConnection(attrs, value);
      if (typeof c === "string") warnings.push(c);
      else if (meta.connections.some((x) => x.id === c.id)) warnings.push(msg("meta.conn.dup", { id: c.id || "?" }));
      else if (meta.connections.length >= 4) warnings.push(msg("meta.conn.many"));
      else meta.connections.push(c);
    } else if (tag.startsWith("author.")) {
      meta.author[tag.slice(7)] = value;
    } else if (tag === "type") {
      if (value === "standard" || value === "streamable") meta.type = value;
      else warnings.push(msg("meta.type", { value }));
    } else if (MULTI.has(tag)) {
      meta[tag].push(value);
    } else if (CSV.has(tag)) {
      meta[tag].push(...value.split(",").map((s) => s.trim()).filter(Boolean));
    } else if (tag === "title" || tag === "version" || tag === "desc" || tag === "schedule") {
      meta[tag] = value;
    } else {
      meta.extra[tag] = value;
    }
  }
  return { meta, warnings };
}

// Entries of the form "what — why": separate the object from the explanation.
export function splitWhy(entry) {
  const m = /^(.*?)\s+[—–-]{1,2}\s+(.*)$/.exec(entry);
  return m ? { what: m[1].trim(), why: m[2].trim() } : { what: entry.trim(), why: null };
}

const HEAD_BYTES = 64 * 1024;

function readHead(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function readXattr(path) {
  const native = loadNative();
  if (native) return native.getXattr(path, XATTR_NAME);
  try {
    return execFileSync("/usr/bin/xattr", ["-p", XATTR_NAME, path], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function decodeXattr(raw) {
  if (!raw) return "";
  if (raw.includes("<agenthub.")) return raw;
  try {
    const t = Buffer.from(raw.trim(), "base64").toString("utf8");
    if (t.includes("<agenthub.")) return t;
  } catch {}
  return "";
}

// Full metadata of a plugin file. → { file, id, interval, intervalMs, ext, binary, meta, warnings }
export function readPluginMeta(path) {
  const fn = parseFileName(path);
  if (!fn) return null;
  const st = statSync(path);
  if (!st.isFile()) return null;
  const head = readHead(path);
  const binary = head.subarray(0, 8192).includes(0);
  const text = binary ? decodeXattr(readXattr(path)) : head.toString("utf8");
  const { meta, warnings } = parseMetaText(text);
  return { file: path, ...fn, binary, executable: (st.mode & 0o111) !== 0, meta, warnings };
}
