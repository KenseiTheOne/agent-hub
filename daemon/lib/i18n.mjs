// Hub language: the message table and the language every human-facing text of the core, the CLI and the hub-update
// helpers is rendered in (the setting itself — lib/settings.mjs).
//
// Effective language — ru | en (lib/settings.mjs: the "system" setting follows the OS language). Plugins get it in
// AGENTHUB_LANG=ru|en (lib/runner.mjs buildEnv) and are restarted when it changes. A plugin without a translation is
// shown as is.
//
// One table, four parts: core texts (notifications, cards, confirmations — below), daemon errors and warnings
// (lib/messages/daemon.mjs), plugin metadata/output warnings (lib/messages/parse.mjs — self-contained, the registry
// vendors it with meta.mjs and output.mjs) and CLI output (lib/messages/cli.mjs). Machine codes (error codes, journal types) are never
// translated — only the human text next to them.
//
// msg(key, params) renders in the current process language: the daemon's core registers its settings as the source
// (setLangSource in lib/core.mjs), the CLI and the helper processes register the home's settings.json
// (lib/settings.mjs langForHome). Without a source — AGENTHUB_LANG if it is ru|en, otherwise English.

import { plural } from "./messages/plural.mjs";
import { DAEMON_MESSAGES } from "./messages/daemon.mjs";
import { CLI_MESSAGES } from "./messages/cli.mjs";
import { PARSE_MESSAGES, setParseLangSource } from "./messages/parse.mjs";

export const LANGS = ["ru", "en"];

// The hub UI language: ru | en. Anything else falls back to en — the same product decision as the "system" setting
// (lib/settings.mjs detectSystemLang: a non-Russian system gets en) and as a process without a language source
// (currentLang). The effective language itself is always ru | en, so ru/en users see no change; this only decides what
// an unexpected value (a third-language code, a missing argument) renders in.
export function normLang(v) {
  return LANGS.includes(v) ? v : "en";
}

// ---------- core messages ----------
// A value is a string with {parameters} or a function (p) => string.
const CORE_MESSAGES = {
  ru: {
    "tier.builtin": "встроенный плагин",
    "tier.official": "официальный плагин",
    "tier.community": "плагин сообщества",
    "tier.local": "локальный плагин",
    "tier.own": "свой плагин",
    "action.text": (p) => `«${p.plugin}» (${p.tier}) просит: «${p.title}»${p.arg ? ` для ${p.arg}` : ""}. Выполнится: ${p.command}.`,
    "action.textNoTitle": (p) => `«${p.plugin}» (${p.tier}) просит выполнить: ${p.command}.`,
    "action.label": (p) => `Выполнить «${p.command}»`,
    "cost.net": (p) => `Команда может выходить в сеть: ${p.hosts}`,
    "cost.generic": "Команда может тратить ресурсы или выходить в сеть",
    "cost.pluginSays": (p) => `По словам плагина: ${p.text}`,
    "prim.open.url": (p) => `Открыть ссылку ${p.host}`,
    "prim.open.file": (p) => `Открыть файл ${p.path}`,
    "prim.open.reveal": (p) => `Показать в Finder: ${p.path}`,
    "prim.terminal.focus": (p) => (p.name ? `Перейти во вкладку «${p.name}»` : `Перейти во вкладку терминала ${p.id}…`),
    "prim.session.focus": (p) => (p.name ? `Перейти во вкладку «${p.name}»` : `Перейти во вкладку сессии ${p.id}…`),
    "prim.session.stop": (p) => `Завершить сессию «${p.who}». Продолжить её можно позже: claude --resume ${p.sessionId}`,
    "prim.session.respond.once": (p) => `Разрешить один раз: ${p.what}`,
    "prim.session.respond.deny": (p) => `Отклонить: ${p.what}`,
    "prim.session.respond.answer": (p) => `Ответить: ${p.what}`,
    "prim.session.respond.request": "запрос",
    "session.label.no-file": "подпись не проверить: Claude Code обновился",
    "session.label.no-process": "процесс завершился",
    "session.label.other": "подпись не подтверждена",
    "hook.deny": "Отклонено в Agent Hub",
    "hook.question": (p) => `Вопрос (${p.n})`,
    "hook.command": "команда",
    "push.rule.session-waiting": "Сессия ждёт вас",
    "push.rule.source-broken": "Плагин не может прочитать данные",
    "push.rule.auth-failed": "Сервис не принял токен",
    "push.rule.plugin-error": "Плагин перестал работать",
    "push.rule.approvals-paused": "Ответы из хаба приостановлены: слишком много одобрений подряд",
    "push.rule.app-pin-changed": "Agent Hub закреплён заново",
    "push.rule.app-pin-first": "Agent Hub закреплён",
    "push.rule.app-pin-removed": "Закрепление Agent Hub снято",
    "push.rule.plugin-update": "Доступно обновление",
    "push.rule.app-restart-stopped": "Agent Hub падает — перезапуск остановлен",
    "push.event": (p) => `Событие «${p.key}»`,
    "push.digest.subtitle": (p) => `За ночь: ${p.n}`,
    "push.throttled": "Слишком много событий подряд — уведомления от плагина приглушены на минуту",
    "pin.under.claude-code": "Из сессии Claude Code",
    "pin.under.terminal": "Из терминала",
    "pin.under.no-tty": "Из скрипта без терминала",
    "pin.under.unknown": "Откуда — неизвестно",
    "pin.manual": "config.json изменён вручную",
    "pin.detail": (p) => `${p.where} · ${p.time}. Если это были не вы — откройте журнал`,
    "pin.removed": "Подтверждения отключены. Если это были не вы — откройте журнал",
    "app.restart-stopped": (p) => `${p.restarts} ${plural.ru(p.restarts, "перезапуск", "перезапуска", "перезапусков")} за ${p.minutes} мин. Откройте Agent Hub сами; подробности — agenthub logs`,
    "app.restart-stopped.why": (p) => `Не удаётся запустить Agent Hub (${p.why}). Откройте его сами; подробности — agenthub logs`,
    "push.rule.app-pin-path-changed": "Сменился путь закреплённой сборки Agent Hub",
    "pin.path.detail": (p) => `Демон теперь запускает ${p.path}. Если это были не вы — откройте журнал`,
    // hub update (the hub-update service, docs/hub-updates.md)
    "push.rule.hub-update": "Доступна новая версия Agent Hub",
    "push.rule.hub-update-ready": "Новая версия Agent Hub собрана — ждёт перезапуска",
    "hub-update.detail.ready": (p) => `${p.label}. ${p.cards > 0 ? `Ждут ответа: ${p.cards} — перезапуск снимет их карточки, вопросы уйдут в терминал. ` : p.sessions > 0 ? `Ждут ответа сессии: ${p.sessions} — лучше сначала ответить. ` : ""}Перезапустить — в меню Agent Hub или в Настройках`,
    "push.rule.hub-update-installed": "Agent Hub обновлён",
    "push.rule.hub-update-rolled-back": "Agent Hub возвращён на прежнюю версию",
    "push.rule.hub-update-failed": "Обновление Agent Hub не удалось",
    "push.rule.hub-update-suspect": "Обновление Agent Hub остановлено — возможна подмена",
    "push.rule.plugin-own-unexpected": "Свой плагин записан мимо Agent Hub",
    "push.rule.plugin-own-updated": "Плагин обновлён",
    "own.updated.detail": (p) => (p.same ? `«${p.title}» обновлён из своей папки (версия ${p.version})` : `«${p.title}» обновлён до ${p.version}`),
    "own.unexpected.detail": (p) => `«${p.title}»: запись в plugins.lock сделана не после вашего согласия — плагин работает как сторонний. Если это были не вы — откройте журнал; иначе подтвердите заявку в «Плагинах»`,
    "hub-update.detail.available": (p) => `${p.version}${p.notes ? ` — ${p.notes}` : ""}${p.notes?.endsWith("…") ? "" : "."} Сейчас ${p.current} · обновить — в меню Agent Hub`,
    "hub-update.detail.installed": (p) => `${p.label}${p.from ? ` (было ${p.from})` : ""}${p.cdhash ? ` · закреплена сборка ${p.cdhash}` : ""}`,
    "hub-update.detail.failed": (p) => `${p.label}: ${p.why}. Хаб остался на ${p.current}${p.log ? ` · лог: ${p.log}` : ""}`,
    "hub-update.why.clone-failed": "не удалось скачать исходники тега",
    "hub-update.why.commit-mismatch": "тег переписан после проверки",
    "hub-update.why.version-mismatch": "версия в теге не совпала с VERSION",
    "hub-update.why.build-failed": "ошибка сборки",
    "hub-update.why.build-timeout": "сборка не уложилась во время",
    "hub-update.why.node-missing": "не найден node для сборки — перезапустите хаб",
    "hub-update.why.verify-failed": "сборка не прошла проверку подписи",
    "hub-update.why.selftest-failed": "новый демон не прошёл самопроверку",
    "hub-update.why.switch-failed": "не удалось переключиться — файлы возвращены",
    "hub-update.why.trial-timeout": "новая версия не запустилась — откат",
    "hub-update.why.interrupted": "установку прервал перезапуск хаба",
    "hub-update.why.estop": "хаб на паузе",
    "hub-update.why.other": "ошибка установки",
    "hub-update.why.not-on-main": "коммит тега не входит в ветку релизов origin",
    "hub-update.why.no-space": "мало места на диске",
    "hub-update.why.untrusted-build": "эту сборку хаб не закреплял",
    "hub-update.why.tag-moved": "тег перенесён на другой коммит",
    "push.rule.hub-update-tag-moved": "Тег релиза Agent Hub перенесён",
    "hub-update.detail.tag-moved": (p) => `${p.version}: ${p.old} → ${p.new}. Установка — только после подтверждения: окно покажет оба коммита`,
    // the "can it be shut down" verdict (lib/idle.mjs)
    "idle.sessions.busy": (p) => `${p.n} ${plural.ru(p.n, "сессия работает", "сессии работают", "сессий работают")}: ${p.names}`,
    // waiting for an answer, but the session shows activity (a subagent, a worker, status=busy) — a blocker (lib/idle.mjs, askingWorks)
    "idle.sessions.busy-asking": (p) => `${p.n} ${plural.ru(p.n, "сессия работает и ждёт", "сессии работают и ждут", "сессий работают и ждут")} ответа на шаг: ${p.names}`,
    // a session waiting for an answer does nothing by itself: sleep does not affect it, after shutdown — claude --resume (lib/idle.mjs)
    "idle.sessions.waiting": (p) => `${p.n} ${plural.ru(p.n, "сессия ждёт", "сессии ждут", "сессий ждут")} ответа: ${p.names} — ответить можно и после включения`,
    "idle.sessions.unknown": "Не знаю про сессии: плагин сессий не ответил",
    "idle.sessions.unsure": (p) => `Не знаю про сессии: ${p.why || "плагин сессий сам не уверен"}`,
    "idle.plugin.failed": (p) => `${p.title}: сбой — ${p.last ? `последнее: ${p.last}${p.at ? ` (${p.at})` : ""}` : "не знаю, тихо ли у него"}`,
    "idle.plugin.stale": (p) => `${p.title} не отвечает — ${p.last ? `последнее: ${p.last}${p.at ? ` (${p.at})` : ""}` : "не знаю, тихо ли у него"}`,
    "idle.names.more": (p) => `ещё ${p.n}`,
    "idle.hub.building": (p) => `Собирается обновление хаба${p.label ? ` ${p.label}` : ""}`,
    "idle.hub.switching": (p) => `Ставится обновление хаба${p.label ? ` ${p.label}` : ""}`,
    "idle.hub.rollback": (p) => `Хаб переключается${p.label ? ` на ${p.label}` : " на прежнюю версию"}`,
    "idle.hub.rolling-back": "Хаб возвращается на прежнюю версию",
    "idle.plugin.install": (p) => `Ставится плагин: ${p.title}${p.version ? ` ${p.version}` : ""}`,
    "idle.plugin.update": (p) => `Обновляется плагин: ${p.title}${p.version ? ` ${p.version}` : ""}`,
    "idle.action": (p) => `${p.plugin}: выполняется «${p.title}»`,
    "idle.src.sessions": "Сессии",
    "idle.src.updates": "Идущие обновления",
  },
  en: {
    "tier.builtin": "built-in plugin",
    "tier.official": "official plugin",
    "tier.community": "community plugin",
    "tier.local": "local plugin",
    "tier.own": "own plugin",
    "action.text": (p) => `"${p.plugin}" (${p.tier}) asks to: "${p.title}"${p.arg ? ` for ${p.arg}` : ""}. Will run: ${p.command}.`,
    "action.textNoTitle": (p) => `"${p.plugin}" (${p.tier}) asks to run: ${p.command}.`,
    "action.label": (p) => `Run "${p.command}"`,
    "cost.net": (p) => `The command may access the network: ${p.hosts}`,
    "cost.generic": "The command may use resources or access the network",
    "cost.pluginSays": (p) => `The plugin says: ${p.text}`,
    "prim.open.url": (p) => `Open link ${p.host}`,
    "prim.open.file": (p) => `Open file ${p.path}`,
    "prim.open.reveal": (p) => `Show in Finder: ${p.path}`,
    "prim.terminal.focus": (p) => (p.name ? `Switch to tab "${p.name}"` : `Switch to terminal tab ${p.id}…`),
    "prim.session.focus": (p) => (p.name ? `Switch to tab "${p.name}"` : `Switch to the tab of session ${p.id}…`),
    "prim.session.stop": (p) => `End session "${p.who}". You can resume it later: claude --resume ${p.sessionId}`,
    "prim.session.respond.once": (p) => `Allow once: ${p.what}`,
    "prim.session.respond.deny": (p) => `Deny: ${p.what}`,
    "prim.session.respond.answer": (p) => `Answer: ${p.what}`,
    "prim.session.respond.request": "request",
    "session.label.no-file": "can't verify: Claude Code was updated",
    "session.label.no-process": "process exited",
    "session.label.other": "signature not verified",
    "hook.deny": "Denied in Agent Hub",
    "hook.question": (p) => `Question (${p.n})`,
    "hook.command": "command",
    "push.rule.session-waiting": "A session needs you",
    "push.rule.source-broken": "Plugin can't read its data",
    "push.rule.auth-failed": "Service rejected the token",
    "push.rule.plugin-error": "Plugin stopped working",
    "push.rule.approvals-paused": "Hub replies paused: too many approvals in a row",
    "push.rule.app-pin-changed": "Agent Hub was re-pinned",
    "push.rule.app-pin-first": "Agent Hub pinned",
    "push.rule.app-pin-removed": "Agent Hub pin removed",
    "push.rule.plugin-update": "Update available",
    "push.rule.app-restart-stopped": "Agent Hub keeps crashing — restart stopped",
    "push.event": (p) => `Event "${p.key}"`,
    "push.digest.subtitle": (p) => `Overnight: ${p.n}`,
    "push.throttled": "Too many events in a row — this plugin's notifications are muted for a minute",
    "pin.under.claude-code": "From a Claude Code session",
    "pin.under.terminal": "From Terminal",
    "pin.under.no-tty": "From a script (no terminal)",
    "pin.under.unknown": "Source unknown",
    "pin.manual": "config.json was edited by hand",
    "pin.detail": (p) => `${p.where} · ${p.time}. If this wasn't you, open the log`,
    "pin.removed": "Confirmations are off. If this wasn't you, open the log",
    "app.restart-stopped": (p) => `${p.restarts} ${plural.en(p.restarts, "restart", "restarts")} in ${p.minutes} min. Open Agent Hub yourself; details: agenthub logs`,
    "app.restart-stopped.why": (p) => `Can't launch Agent Hub (${p.why}). Open it yourself; details: agenthub logs`,
    "push.rule.app-pin-path-changed": "Agent Hub's pinned build path changed",
    "pin.path.detail": (p) => `The hub now launches ${p.path}. If this wasn't you, open the log`,
    "push.rule.hub-update": "New Agent Hub version available",
    "push.rule.hub-update-ready": "New Agent Hub version built — waiting to restart",
    "hub-update.detail.ready": (p) => `${p.label}. ${p.cards > 0 ? `Waiting for an answer: ${p.cards} — a restart drops their cards and the questions fall back to the terminal. ` : p.sessions > 0 ? `Sessions waiting for an answer: ${p.sessions} — better answer them first. ` : ""}Restart from the Agent Hub menu or Settings`,
    "push.rule.hub-update-installed": "Agent Hub updated",
    "push.rule.hub-update-rolled-back": "Agent Hub rolled back to the previous version",
    "push.rule.hub-update-failed": "Agent Hub update failed",
    "push.rule.hub-update-suspect": "Agent Hub update stopped — possible substitution",
    "push.rule.plugin-own-unexpected": "Own plugin written behind Agent Hub's back",
    "push.rule.plugin-own-updated": "Plugin updated",
    "own.updated.detail": (p) => (p.same ? `"${p.title}" updated from its folder (version ${p.version})` : `"${p.title}" updated to ${p.version}`),
    "own.unexpected.detail": (p) => `"${p.title}": the plugins.lock entry wasn't made after your consent — the plugin runs as third-party. If this wasn't you, open the log; otherwise approve the request in Plugins`,
    "hub-update.detail.available": (p) => `${p.version}${p.notes ? ` — ${p.notes}` : ""}${p.notes?.endsWith("…") ? "" : "."} Now ${p.current} · update from the Agent Hub menu`,
    "hub-update.detail.installed": (p) => `${p.label}${p.from ? ` (was ${p.from})` : ""}${p.cdhash ? ` · pinned build ${p.cdhash}` : ""}`,
    "hub-update.detail.failed": (p) => `${p.label}: ${p.why}. The hub stays on ${p.current}${p.log ? ` · log: ${p.log}` : ""}`,
    "hub-update.why.clone-failed": "couldn't download the tag's sources",
    "hub-update.why.commit-mismatch": "the tag was rewritten after the check",
    "hub-update.why.version-mismatch": "the tag's version doesn't match VERSION",
    "hub-update.why.build-failed": "build error",
    "hub-update.why.build-timeout": "the build took too long",
    "hub-update.why.node-missing": "node for the build is missing — restart the hub",
    "hub-update.why.verify-failed": "the build failed the signature check",
    "hub-update.why.selftest-failed": "the new daemon failed its self-test",
    "hub-update.why.switch-failed": "couldn't switch over — files restored",
    "hub-update.why.trial-timeout": "the new version didn't start — rolled back",
    "hub-update.why.interrupted": "a hub restart interrupted the install",
    "hub-update.why.estop": "the hub is paused",
    "hub-update.why.other": "install error",
    "hub-update.why.not-on-main": "the tag's commit isn't on origin's release branch",
    "hub-update.why.no-space": "not enough disk space",
    "hub-update.why.untrusted-build": "the hub never pinned this build",
    "hub-update.why.tag-moved": "the tag was moved to another commit",
    "push.rule.hub-update-tag-moved": "Agent Hub release tag moved",
    "hub-update.detail.tag-moved": (p) => `${p.version}: ${p.old} → ${p.new}. Install only after confirming: the window shows both commits`,
    "idle.sessions.busy": (p) => `${p.n} ${plural.en(p.n, "session is", "sessions are")} working: ${p.names}`,
    "idle.sessions.busy-asking": (p) => `${p.n} ${plural.en(p.n, "session is", "sessions are")} working with a step waiting for a reply: ${p.names}`,
    "idle.sessions.waiting": (p) => `${p.n} ${plural.en(p.n, "session is", "sessions are")} waiting for a reply: ${p.names} — ${p.n === 1 ? "it" : "they"} can wait until the Mac is back on`,
    "idle.sessions.unknown": "Not sure about sessions: the sessions plugin hasn't reported",
    "idle.sessions.unsure": (p) => `Not sure about sessions: ${p.why || "the sessions plugin isn't sure itself"}`,
    "idle.plugin.failed": (p) => `${p.title}: failed — ${p.last ? `last known: ${p.last}${p.at ? ` (${p.at})` : ""}` : "can't tell whether it's quiet"}`,
    "idle.plugin.stale": (p) => `${p.title} isn't responding — ${p.last ? `last known: ${p.last}${p.at ? ` (${p.at})` : ""}` : "can't tell whether it's quiet"}`,
    "idle.names.more": (p) => `${p.n} more`,
    "idle.hub.building": (p) => `Hub update${p.label ? ` ${p.label}` : ""} is building`,
    "idle.hub.switching": (p) => `Hub update${p.label ? ` ${p.label}` : ""} is installing`,
    "idle.hub.rollback": (p) => `The hub is switching${p.label ? ` to ${p.label}` : " to the previous version"}`,
    "idle.hub.rolling-back": "The hub is rolling back to the previous version",
    "idle.plugin.install": (p) => `Installing plugin: ${p.title}${p.version ? ` ${p.version}` : ""}`,
    "idle.plugin.update": (p) => `Updating plugin: ${p.title}${p.version ? ` ${p.version}` : ""}`,
    "idle.action": (p) => `${p.plugin}: running "${p.title}"`,
    "idle.src.sessions": "Sessions",
    "idle.src.updates": "Running updates",
  },
};

export const MESSAGES = {
  ru: { ...CORE_MESSAGES.ru, ...DAEMON_MESSAGES.ru, ...PARSE_MESSAGES.ru, ...CLI_MESSAGES.ru },
  en: { ...CORE_MESSAGES.en, ...DAEMON_MESSAGES.en, ...PARSE_MESSAGES.en, ...CLI_MESSAGES.en },
};

export function t(lang, key, params = {}) {
  const l = normLang(lang);
  const v = MESSAGES[l][key] ?? MESSAGES.ru[key];
  if (v === undefined) return key;
  if (typeof v === "function") return v(params);
  return v.replace(/\{(\w+)\}/g, (_m, k) => (params[k] ?? "").toString());
}

export function has(key) {
  return key in MESSAGES.ru;
}

// ---------- plugin content languages (G14) ----------
// The hub UI speaks ru | en only (LANGS); a third UI language is out of scope. Plugin CONTENT (metadata translations:
// <agenthub.title lang="de">, title-de=…, status labels, connection names, catalog titles) may be in any language, tagged
// with a BCP-47 tag (primary subtag 2–3 letters, optional script/region/variant subtags: de, pt-BR, zh-Hant, sr-Latn-RS).
// The translation is picked by a chain (contentLang):
//   1. the hub UI language (ru | en), if the plugin has it;
//   2. the system preferred languages (Settings.systemLocales: macOS AppleLanguages, in order), up to the first one that is
//      a hub UI language — that one is decided by step 1 (the plugin's base text is assumed to be in it), so existing ru/en
//      users see exactly what they saw before (a ru hub never switches a ru-base plugin to its en variant);
//   3. the base text (the tag without lang).
// Matching a candidate tag: exact (case-insensitive), then the bare primary language, then any variant with the same primary
// language (system de-AT finds a plugin's "de" or "de-DE"). Plugins also get the system list in AGENTHUB_LOCALE
// (lib/runner.mjs buildEnv) to localize their own output the same way.
const TAG_RE = /^([A-Za-z]{2,3})((?:[-_][A-Za-z0-9]{1,8})*)$/;

// A BCP-47 language tag in canonical case (de, pt-BR, zh-Hant, sr-Latn-RS), or null if malformed. "_" is accepted for "-"
// (macOS and POSIX spell en_US).
export function normTag(v) {
  const m = TAG_RE.exec(String(v ?? "").trim());
  if (!m || String(v).length > 35) return null;
  const subs = m[2] ? m[2].slice(1).split(/[-_]/) : [];
  const out = [m[1].toLowerCase()];
  for (const s of subs) {
    if (!/^[A-Za-z0-9]{1,8}$/.test(s)) return null;
    if (/^[A-Za-z]{4}$/.test(s)) out.push(s[0].toUpperCase() + s.slice(1).toLowerCase());
    else if (/^(?:[A-Za-z]{2}|\d{3})$/.test(s)) out.push(s.toUpperCase());
    else out.push(s.toLowerCase());
  }
  return out.join("-");
}
const primaryOf = (tag) => String(tag).split("-")[0].toLowerCase();

// A system language list (array or "de-DE,en-US") → canonical tags, no duplicates, at most 8.
export function normLocales(v) {
  const list = Array.isArray(v) ? v : String(v ?? "").split(",");
  const out = [];
  for (const x of list) {
    const t = normTag(x);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

// Candidate content languages for a hub language and a system list (see the chain above).
export function langCandidates(lang, locales = []) {
  const ui = normLang(lang);
  const out = [ui];
  for (const t of normLocales(locales)) {
    if (LANGS.includes(primaryOf(t))) break;
    out.push(t);
  }
  return out;
}

function matchKey(keys, cand) {
  const c = cand.toLowerCase();
  const p = primaryOf(cand);
  return keys.find((k) => k.toLowerCase() === c) || keys.find((k) => k.toLowerCase() === p) || keys.find((k) => primaryOf(k) === p) || null;
}

// The key of i18n ({ <tag>: {...} }) to show for hub language lang, or null — the base text. field — only variants that
// translate this field count (a "de" variant without a title doesn't hide a title further down the chain).
export function contentLang(i18n, lang, { field = null, locales = currentLocales() } = {}) {
  if (!i18n || typeof i18n !== "object") return null;
  const keys = Object.keys(i18n).filter((k) => {
    const v = i18n[k];
    if (!v || typeof v !== "object") return false;
    if (!field) return true;
    const f = v[field];
    return typeof f === "string" ? f !== "" : Boolean(f && typeof f === "object" && Object.keys(f).length);
  });
  if (!keys.length) return null;
  for (const cand of langCandidates(lang, locales)) {
    const k = matchKey(keys, cand);
    if (k) return k;
  }
  return null;
}

// The variant object of i18n for hub language lang ({} — none; then the base text is shown).
export function contentOf(i18n, lang, opts = {}) {
  const k = contentLang(i18n, lang, opts);
  return k ? i18n[k] : {};
}

// Translation from plugin metadata: { base, i18n: { en: {...}, de: {...} } } → the value of field by the chain above, or
// the base one.
export function pickLang(base, i18n, field, lang) {
  const k = contentLang(i18n, lang, { field });
  const v = k ? i18n[k][field] : null;
  return typeof v === "string" && v ? v : base;
}

// ---------- the current process language ----------
let langSource = null;

// fn() → "ru" | "en"; null — back to the default (AGENTHUB_LANG or English). fn.locales() (optional) → the system
// preferred languages for plugin content (currentLocales; the daemon's core: Settings.systemLocales).
export function setLangSource(fn) {
  langSource = typeof fn === "function" ? fn : null;
  // the parser/linter texts live in a self-contained module (lib/messages/parse.mjs): same language
  setParseLangSource(langSource ? () => currentLang() : null);
}

// The owner stops (a core in tests): back to the default, unless another source took over since.
export function releaseLangSource(fn) {
  if (fn && langSource === fn) setLangSource(null);
}

export function currentLang() {
  if (langSource) {
    try {
      const l = langSource();
      if (LANGS.includes(l)) return l;
    } catch {}
  }
  const env = process.env.AGENTHUB_LANG;
  return LANGS.includes(env) ? env : "en";
}

// The system preferred languages of the current process (plugin content, contentLang): the registered source's
// locales(), otherwise AGENTHUB_LOCALE (a plugin process, the CLI), otherwise none (only the hub language counts).
export function currentLocales() {
  if (typeof langSource?.locales === "function") {
    try {
      return normLocales(langSource.locales());
    } catch {}
  }
  return normLocales(process.env.AGENTHUB_LOCALE || "");
}

// A message in the current process language (see the header).
export function msg(key, params = {}) {
  return t(currentLang(), key, params);
}

// The text of an error from a self-contained module (lib/registry/tarball.mjs, minisign.mjs: no imports, so they carry
// msgKey/params next to an English message) — in the current language; any other error — its message.
export function errText(e) {
  if (e && typeof e.msgKey === "string" && MESSAGES.ru[e.msgKey] !== undefined) return msg(e.msgKey, e.params || {});
  return String(e?.message ?? e);
}
