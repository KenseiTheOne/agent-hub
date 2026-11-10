// Plugin metadata and output warnings (lib/meta.mjs, lib/output.mjs) — part of the message table in lib/i18n.mjs.
//
// No imports on purpose: the agent-hub-plugins registry vendors meta.mjs and output.mjs (scripts/vendor/), so their
// texts live in a module that loads alone. The language comes from setParseLangSource (lib/i18n.mjs setLangSource
// forwards the hub language here); without a source — AGENTHUB_LANG if it is ru|en, otherwise English.

export const PARSE_MESSAGES = {
  ru: {
    "meta.push.noKey": "нет корректного key",
    "meta.push.hold": "{key}: hold только evening",
    "meta.push.kind": "{key}: kind ждём {list}",
    "meta.push.was": "{key}: was ждём {list}",
    "meta.push.wasKind": "{key}: was — только у kind=\"plugin\"",
    "meta.interval": "{what} — число и ms|s|m|h|d",
    "meta.icon.symbol": "icon: symbol — имя SF Symbol (a-z, 0-9 через точку, до 64)",
    "meta.conn.id": "connection: id — id плагина или «<id плагина>.<имя>» (имя: a-z, 0-9, «-», с буквы, до 32; целиком — с буквы, до 64)",
    "meta.conn.type": "connection {id}: type — только mcp",
    "meta.conn.url": "connection {id}: url — адрес https://",
    "meta.conn.urlHost": "connection {id}: url — https:// на имени хоста (не IP-адрес), без порта, учётных данных и #",
    "meta.conn.hosts": "connection {id}: hosts — имена хостов (не IP-адреса) через запятую",
    "meta.conn.scope": "connection {id}: scope — слова через пробел",
    "meta.conn.tools": "connection {id}: tools — 1–32 имени инструментов через запятую",
    "meta.conn.budget": "connection {id}: budget — целое 1…10000",
    "meta.conn.title": "connection {id}: title — до 64 символов",
    "meta.conn.dup": "connection {id}: повтор id",
    "meta.conn.many": "connection: больше 4 подключений",
    "meta.req.name": "нет name (до 64 символов)",
    "meta.req.url": "{name}: url — только https://",
    "meta.req.check": "{name}: check — путь ~/… или /… без масок и «..»",
    "meta.req.dup": "requires {name}: повтор name",
    "meta.req.many": "requires: больше 8 зависимостей",
    "meta.status.value": "status: value ждём {list}",
    "meta.status.label": "status {value}: нет label",
    "meta.lang.code": "{tag}: lang ждём двухбуквенный код (ru, en), а не «{lang}»",
    "meta.lang.pushFirst": "push {key} lang={lang}: сначала правило без lang",
    "meta.lang.requiresFirst": "requires {name} lang={lang}: сначала тег без lang с тем же name",
    "meta.lang.connFirst": "connection {id} lang={lang}: сначала тег без lang с тем же id",
    "meta.lang.unsupported": "{tag}: lang у этого тега не поддерживается",
    "meta.action.id": "action без корректного id: «{value}»",
    "meta.action.level": "action {id}: неизвестный level «{level}»",
    "meta.action.empty": "action {id}: пустая команда",
    "meta.action.dup": "action {id}: повтор id",
    "meta.action.arg": "action {id}: arg ждём «имя:^шаблон$» (имя [A-Za-z][A-Za-z0-9_]{0,31}, шаблон с ^ и $, до 200 символов)",
    "meta.push.dup": "push {key}: повтор ключа",
    "meta.push.many": "push: больше 32 правил",
    "meta.icon.dup": "icon: повтор тега",
    "meta.contract": "contract: ждём целое число ≥ 1, а не «{value}»",
    "meta.type": "неизвестный type «{value}»",
    "out.lines": "вывод обрезан до {n} строк",
    "out.line": "строка обрезана до {n} символов",
    "out.forbidden": "параметр {key}= запрещён и проигнорирован",
    "out.status": "неизвестный status «{value}»",
    "out.event": "некорректный ключ event «{value}»",
    "out.headerOnly": "параметр {field}= понимается только в шапке",
  },
  en: {
    "meta.push.noKey": "no valid key",
    "meta.push.hold": "{key}: hold must be evening",
    "meta.push.kind": "{key}: kind must be {list}",
    "meta.push.was": "{key}: was must be {list}",
    "meta.push.wasKind": "{key}: was only with kind=\"plugin\"",
    "meta.interval": "{what}: a number and ms|s|m|h|d",
    "meta.icon.symbol": "icon: symbol must be an SF Symbol name (a-z, 0-9 separated by dots, up to 64)",
    "meta.conn.id": "connection: id must be the plugin id or \"<plugin id>.<name>\" (name: a-z, 0-9, \"-\", starting with a letter, up to 32; the whole id starts with a letter, up to 64)",
    "meta.conn.type": "connection {id}: type must be mcp",
    "meta.conn.url": "connection {id}: url must be an https:// address",
    "meta.conn.urlHost": "connection {id}: url must be https:// on a host name (not an IP address), without a port, credentials or #",
    "meta.conn.hosts": "connection {id}: hosts must be comma-separated host names (not IP addresses)",
    "meta.conn.scope": "connection {id}: scope must be space-separated words",
    "meta.conn.tools": "connection {id}: tools must be 1–32 comma-separated tool names",
    "meta.conn.budget": "connection {id}: budget must be an integer 1…10000",
    "meta.conn.title": "connection {id}: title must be up to 64 characters",
    "meta.conn.dup": "connection {id}: duplicate id",
    "meta.conn.many": "connection: more than 4 connections",
    "meta.req.name": "no name (up to 64 characters)",
    "meta.req.url": "{name}: url must be https://",
    "meta.req.check": "{name}: check must be a ~/… or /… path without wildcards or \"..\"",
    "meta.req.dup": "requires {name}: duplicate name",
    "meta.req.many": "requires: more than 8 dependencies",
    "meta.status.value": "status: value must be {list}",
    "meta.status.label": "status {value}: no label",
    "meta.lang.code": "{tag}: lang must be a two-letter code (ru, en), not \"{lang}\"",
    "meta.lang.pushFirst": "push {key} lang={lang}: the rule without lang must come first",
    "meta.lang.requiresFirst": "requires {name} lang={lang}: a tag without lang with the same name must come first",
    "meta.lang.connFirst": "connection {id} lang={lang}: a tag without lang with the same id must come first",
    "meta.lang.unsupported": "{tag}: lang isn't supported on this tag",
    "meta.action.id": "action without a valid id: \"{value}\"",
    "meta.action.level": "action {id}: unknown level \"{level}\"",
    "meta.action.empty": "action {id}: empty command",
    "meta.action.dup": "action {id}: duplicate id",
    "meta.action.arg": "action {id}: arg must be \"name:^pattern$\" (name [A-Za-z][A-Za-z0-9_]{0,31}, a pattern with ^ and $, up to 200 characters)",
    "meta.push.dup": "push {key}: duplicate key",
    "meta.push.many": "push: more than 32 rules",
    "meta.icon.dup": "icon: duplicate tag",
    "meta.contract": "contract: must be an integer ≥ 1, not \"{value}\"",
    "meta.type": "unknown type \"{value}\"",
    "out.lines": "output cut to {n} lines",
    "out.line": "line cut to {n} characters",
    "out.forbidden": "parameter {key}= is forbidden and ignored",
    "out.status": "unknown status \"{value}\"",
    "out.event": "invalid event key \"{value}\"",
    "out.headerOnly": "parameter {field}= is understood only in the header",
  },
};

let langSource = null;

// fn() → "ru" | "en"; null — back to the default.
export function setParseLangSource(fn) {
  langSource = typeof fn === "function" ? fn : null;
}

function parseLang() {
  if (langSource) {
    try {
      const l = langSource();
      if (l === "ru" || l === "en") return l;
    } catch {}
  }
  const env = typeof process !== "undefined" ? process.env?.AGENTHUB_LANG : undefined;
  return env === "ru" || env === "en" ? env : "en";
}

// A metadata/output warning in the current language: a string with {parameters}.
export function parseMsg(key, params = {}) {
  const v = PARSE_MESSAGES[parseLang()][key] ?? PARSE_MESSAGES.en[key];
  if (v === undefined) return key;
  return v.replace(/\{(\w+)\}/g, (_m, k) => (params[k] ?? "").toString());
}
