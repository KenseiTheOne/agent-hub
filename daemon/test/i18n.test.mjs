// Hub language (UI pass 2026-11-05): the setting in settings.json, PUT /settings/lang for app only, AGENTHUB_LANG
// for plugins and their restart on change, translations in metadata, core confirmation texts in the right language.
// Plus the order of checks in POST /actions: the peer class before the arguments (docs/api.md).

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES, currentLang, errText, msg, setLangSource, t } from "../lib/i18n.mjs";
import { Settings, detectSystemLang, langForHome } from "../lib/settings.mjs";
import { parseMetaText } from "../lib/meta.mjs";
import { parseOutput } from "../lib/output.mjs";
import { PARSE_MESSAGES } from "../lib/messages/parse.mjs";
import { parseCron, splitCommand } from "../lib/runner.mjs";
import { readTarGz } from "../lib/registry/tarball.mjs";
import { parsePublicKey } from "../lib/registry/minisign.mjs";
import { pathViolation } from "../lib/registry/perms.mjs";
import { rollbackTrial } from "../lib/hub-update/trial.mjs";
import { writeFileSync } from "node:fs";
import { actionFingerprint } from "../lib/core.mjs";
import { curl, req, startHub, tempHome, cleanup, waitFor, writePlugin } from "./helpers.mjs";

const APP = { class: "app", pid: 1 };
const CLI = { class: "cli", pid: 2 };

test("message table: every key has ru and en", () => {
  const ru = Object.keys(MESSAGES.ru).sort();
  const en = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(en, ru);
  assert.equal(t("en", "hook.deny"), "Denied in Agent Hub");
  // G14: an unknown language falls back to en, like the "system" rule (a non-Russian system → en) and currentLang
  assert.equal(t("de", "hook.deny"), "Denied in Agent Hub", "unknown language → en");
  assert.equal(t("ru", "hook.deny"), "Отклонено в Agent Hub");
  assert.equal(t("en", "нет-такого"), "нет-такого");
});

test("Settings: system → OS language, explicit setting, file 0600, garbage → system", () => {
  const dir = tempHome();
  try {
    const p = join(dir, "settings.json");
    const s = new Settings(p, { detect: () => "en" });
    assert.deepEqual(s.langInfo(), { setting: "system", effective: "en", system: "en", locales: ["en"] });
    s.setLang("ru");
    assert.equal(s.effectiveLang(), "ru");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(new Settings(p, { detect: () => "en" }).langSetting, "ru", "survives a restart");
    assert.throws(() => s.setLang("de"));
    assert.equal(typeof detectSystemLang(), "string");
  } finally {
    cleanup(dir);
  }
});

test("metadata: lang variants of title/desc/push/permissions and title-xx/cost-xx on an action; the fingerprint covers all variants", () => {
  const { meta, warnings } = parseMetaText(`
# <agenthub.title>Квота</agenthub.title>
# <agenthub.title lang="en">Quota</agenthub.title>
# <agenthub.desc>неделя и темп</agenthub.desc>
# <agenthub.desc lang="en">week and pace</agenthub.desc>
# <agenthub.fsRead>~/.cache/x — кэш квоты</agenthub.fsRead>
# <agenthub.fsRead lang="en">~/.cache/x — quota cache</agenthub.fsRead>
# <agenthub.push key="week-80">Квота: неделя</agenthub.push>
# <agenthub.push key="week-80" lang="en">Quota: week</agenthub.push>
# <agenthub.action id="stop" title="Остановить" title-en="Stop" cost-en="uses quota">q.sh --stop</agenthub.action>
# <agenthub.title lang="english">x</agenthub.title>
`);
  assert.equal(meta.title, "Квота");
  assert.equal(meta.i18n.en.title, "Quota");
  assert.equal(meta.i18n.en.desc, "week and pace");
  assert.deepEqual(meta.fsRead, ["~/.cache/x — кэш квоты"], "a permission variant doesn't add a permission");
  assert.equal(meta.i18n.en.why["~/.cache/x"], "quota cache");
  assert.equal(meta.push[0].labels.en, "Quota: week");
  assert.deepEqual(meta.actions[0].i18n, { en: { title: "Stop", cost: "uses quota" } });
  assert.equal(warnings.length, 1, "lang not two letters — warning");
  const pl = { id: "q", meta: { version: "1" }, source: "builtin" };
  const a = meta.actions[0];
  assert.notEqual(actionFingerprint(pl, "builtin", a), actionFingerprint(pl, "builtin", { ...a, i18n: { en: { title: "Halt" } } }));
});

test("hub language: /state.lang, PUT /settings/lang app only (cli — 403), plugin label translation, AGENTHUB_LANG and frame restart", async () => {
  const dir = tempHome("ah-l-");
  writePlugin(
    dir,
    "lang.5m.sh",
    `#!/bin/sh
# <agenthub.title>Язык</agenthub.title>
# <agenthub.title lang="en">Language</agenthub.title>
# <agenthub.desc>показывает язык</agenthub.desc>
# <agenthub.desc lang="en">shows the language</agenthub.desc>
echo "lang=$AGENTHUB_LANG | status=ok"
`,
  );
  writePlugin(
    dir,
    "slang.sh",
    `#!/bin/sh
# <agenthub.type>streamable</agenthub.type>
echo "s=$AGENTHUB_LANG | status=ok"
echo "~~~"
exec sleep 30
`,
  );
  const h = await startHub({ pluginsDir: dir });
  try {
    await waitFor(() => h.core.pluginState("lang")?.header[0]?.title === "lang=ru" && h.core.pluginState("slang")?.header[0]?.title === "s=ru");
    const st = await curl(h.sock, "GET", "/state");
    assert.deepEqual(st.body.lang, { setting: "system", effective: "ru", system: "ru", locales: ["ru"] });
    assert.equal(st.body.plugins.find((p) => p.id === "lang").title, "Язык");
    assert.equal(st.body.plugins.find((p) => p.id === "lang").desc, "показывает язык");
    const denied = await curl(h.sock, "PUT", "/settings/lang", { lang: "en" });
    assert.equal(denied.status, 403, "cli doesn't change the language");
    assert.equal((await curl(h.sock, "GET", "/settings")).body.lang.setting, "system", "cli reads");
    const firstPid = h.core.pluginState("slang").pid;
    const seen = [];
    h.core.on("settings.changed", (e) => seen.push(e.lang.effective));
    assert.deepEqual(h.core.setLang("en", APP), { setting: "en", effective: "en", system: "ru", locales: ["ru"] });
    assert.deepEqual(seen, ["en"]);
    assert.equal(h.core.pluginState("lang").title, "Language");
    assert.equal(h.core.pluginState("lang").desc, "shows the language");
    await waitFor(() => h.core.pluginState("lang")?.header[0]?.title === "lang=en", { timeoutMs: 8000 });
    await waitFor(() => h.core.pluginState("slang")?.header[0]?.title === "s=en", { timeoutMs: 8000 });
    assert.notEqual(h.core.pluginState("slang").pid, firstPid, "streamable restarted with the new environment");
    assert.notEqual(h.core.pluginState("slang").status, "error", "a language restart isn't a plugin failure");
    assert.equal(JSON.parse(readFileSync(join(h.home, "settings.json"), "utf8")).lang, "en");
    assert.ok(existsSync(join(h.home, "config.json")) === false, "config.json is left alone");
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "settings-changed" && e.value === "en" && e.peer === "app"));
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("action confirmation text: in the hub language and with the command as it will run (value in place of {name} or at the end)", async () => {
  const dir = tempHome("ah-la-");
  writePlugin(
    dir,
    "act.5m.sh",
    `#!/bin/sh
# <agenthub.title>Прогоны</agenthub.title>
# <agenthub.title lang="en">Runs</agenthub.title>
# <agenthub.version>1.0.0</agenthub.version>
# <agenthub.action id="skip" level="confirm" arg="taskId:^[A-Za-z0-9-]{1,20}$" title="Пропустить задачу" title-en="Skip task">act.5m.sh --action skip {taskId}</agenthub.action>
# <agenthub.action id="tail" level="confirm" arg="taskId:^[A-Za-z0-9-]{1,20}$">act.5m.sh --action tail</agenthub.action>
[ "$1" = "--action" ] && { printf '%s\n' "$@" > "$AGENTHUB_PLUGIN_DATA_PATH/argv.txt"; exit 0; }
echo "x | status=ok"
echo "---"
echo "Skip | action=skip arg=ABC-1"
echo "Tail | action=tail arg=ABC-2"
`,
  );
  const h = await startHub({ pluginsDir: dir });
  try {
    const offers = () => h.core.pluginState("act")?.body.filter((i) => i.offer).map((i) => i.offer) || [];
    await waitFor(() => offers().length === 2);
    const [skip, tail] = offers();
    const ru = await h.core.invoke({ id: skip.id, peer: APP });
    assert.equal(ru.status, 428);
    // G10: the row carrying the button ends the text
    assert.equal(ru.body.text, "«Прогоны» (встроенный плагин) просит: «Пропустить задачу» для ABC-1. Выполнится: act.5m.sh --action skip ABC-1 Кнопка в строке «Skip».");
    const ruTail = await h.core.invoke({ id: tail.id, peer: APP });
    assert.match(ruTail.body.text, /просит выполнить: act\.5m\.sh --action tail ABC-2 Кнопка в строке «Tail»\.$/);
    h.core.setLang("en", APP);
    await waitFor(() => h.core.pluginState("act")?.title === "Runs" && offers().length === 2);
    const skipEn = offers()[0];
    const en = await h.core.invoke({ id: skipEn.id, peer: APP });
    assert.equal(en.status, 428);
    assert.equal(en.body.text, '"Runs" (built-in plugin) asks to: "Skip task" for ABC-1. Will run: act.5m.sh --action skip ABC-1 Button on the row "Skip".');
    assert.equal(en.body.row, "Skip");
    const done = await h.core.invoke({ id: skipEn.id, confirmToken: en.body.token, peer: APP });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const argv = readFileSync(join(h.config.paths.pluginData, "act", "argv.txt"), "utf8").trim().split("\n");
    assert.deepEqual(argv, ["--action", "skip", "ABC-1"], "the shown command matches the one run");
  } finally {
    await h.stop();
    cleanup(dir);
  }
});

test("POST /actions: cli with an empty body on an app-only primitive → 403 peer:cli before 400 args (docs/api.md order)", async () => {
  const h = await startHub();
  try {
    const r = await curl(h.sock, "POST", "/actions/session.stop", {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "peer:cli");
    const direct = await h.core.invoke({ id: "session.stop", args: {}, peer: CLI });
    assert.equal(direct.status, 403);
    // for app the arguments are still checked
    const app = await h.core.invoke({ id: "session.stop", args: {}, peer: APP });
    assert.equal(app.status, 400);
    assert.match(app.body.error, /^args:/);
    // while the hub is paused, app gets 423 before argument parsing
    h.core.setEstop(true, APP);
    assert.equal((await h.core.invoke({ id: "session.stop", args: {}, peer: APP })).status, 423);
  } finally {
    await h.stop();
  }
});

test("hub pause turns off hook responses and actions, but not open.*", async () => {
  const h = await startHub();
  try {
    h.core.setEstop(true, CLI);
    const r = await h.core.invoke({ id: "open.url", args: { url: "https://example.com" }, peer: CLI });
    assert.equal(r.status, 200, "opening a link works while paused too");
    const off = await req(h.sock, "POST", "/estop", { on: false });
    assert.equal(off.status, 403, "only app can resume");
  } finally {
    await h.stop();
  }
});

test("overlapping language changes: one streamable process lives, none after the hub stops; not-executable isn't launched", async () => {
  const dir = tempHome("ah-lr-");
  const pidlog = join(dir, "pids.log");
  writePlugin(
    dir,
    "slang.sh",
    `#!/bin/sh
# <agenthub.type>streamable</agenthub.type>
echo "$$" >> ${pidlog}
echo "s=$AGENTHUB_LANG | status=ok"
echo "~~~"
exec sleep 300
`,
  );
  writePlugin(dir, "noexec.rb", `# <agenthub.type>streamable</agenthub.type>\nputs "x"\n`, 0o644);
  const alive = () =>
    (existsSync(pidlog) ? readFileSync(pidlog, "utf8").trim().split("\n") : []).map(Number).filter((p) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    });
  const h = await startHub({ pluginsDir: dir });
  let stopped = false;
  try {
    await waitFor(() => h.core.pluginState("slang")?.header[0]?.title === "s=ru" && h.core.pluginState("noexec")?.error === "not-executable");
    const exits = [];
    const orig = h.core.pluginExited.bind(h.core);
    h.core.pluginExited = (id, info) => {
      exits.push(id);
      return orig(id, info);
    };
    h.core.setLang("en", APP);
    h.core.setLang("ru", APP);
    h.core.setLang("en", APP);
    await h.core.host.langChain;
    await waitFor(() => h.core.pluginState("slang")?.header[0]?.title === "s=en", { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 300));
    const live = alive();
    assert.deepEqual(live, [h.core.pluginState("slang").pid], "one process, and the core knows it");
    assert.deepEqual(exits, [], "a language restart isn't a plugin exit; not-executable wasn't launched");
    assert.equal(h.core.pluginState("noexec").error, "not-executable");
    await h.stop();
    stopped = true;
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(alive(), [], "no orphans after the hub stops");
  } finally {
    for (const p of alive()) {
      try {
        process.kill(p, "SIGKILL");
      } catch {}
    }
    if (!stopped) await h.stop();
    cleanup(dir);
  }
});

// ---------- daemon texts in the hub language (errors, warnings, logs) ----------

// Runs fn with the current process language set to lang (as a running core does), then back to the default.
function inLang(lang, fn) {
  setLangSource(() => lang);
  try {
    return fn();
  } finally {
    setLangSource(null);
  }
}

test("daemon message tables: every part has ru and en; without a source — AGENTHUB_LANG or English", () => {
  assert.deepEqual(Object.keys(PARSE_MESSAGES.en).sort(), Object.keys(PARSE_MESSAGES.ru).sort());
  for (const k of ["err.cron.fields", "warn.suppressed", "hub.watch.confirmed", "tar.truncated", "journal.hidden", "meta.type", "out.status"]) {
    assert.ok(MESSAGES.ru[k] && MESSAGES.en[k], k);
  }
  const was = process.env.AGENTHUB_LANG;
  try {
    delete process.env.AGENTHUB_LANG;
    assert.equal(currentLang(), "en");
    process.env.AGENTHUB_LANG = "ru";
    assert.equal(currentLang(), "ru");
    assert.equal(msg("err.quote"), "незакрытая кавычка");
  } finally {
    if (was === undefined) delete process.env.AGENTHUB_LANG;
    else process.env.AGENTHUB_LANG = was;
  }
});

test("library errors follow the hub language: cron, quotes, archive and key errors (errText)", () => {
  assert.throws(() => inLang("ru", () => parseCron("* *")), /cron: нужно 5 полей/);
  assert.throws(() => inLang("en", () => parseCron("* *")), /cron: 5 fields required/);
  assert.throws(() => inLang("ru", () => splitCommand('a "b')), /незакрытая кавычка/);
  assert.throws(() => inLang("en", () => splitCommand('a "b')), /unclosed quote/);
  // self-contained modules: an English message plus a key the hub renders in its language
  let tarErr = null;
  try {
    readTarGz(Buffer.from("not gzip"), { root: "p" });
  } catch (e) {
    tarErr = e;
  }
  assert.equal(tarErr.message, "gzip: corrupt");
  assert.equal(inLang("ru", () => errText(tarErr)), "gzip: битый");
  assert.equal(inLang("en", () => errText(tarErr)), "gzip: corrupt");
  let keyErr = null;
  try {
    parsePublicKey("");
  } catch (e) {
    keyErr = e;
  }
  assert.equal(inLang("ru", () => errText(keyErr)), "пустой открытый ключ");
  assert.equal(inLang("en", () => errText(keyErr)), "empty public key");
  assert.equal(errText(new Error("plain")), "plain");
});

test("parser and linter warnings follow the hub language: metadata, output, forbidden paths", () => {
  const meta = "# <agenthub.type>odd</agenthub.type>\n# <agenthub.title lang=\"english\">x</agenthub.title>";
  assert.deepEqual(inLang("ru", () => parseMetaText(meta).warnings), ["неизвестный type «odd»", "title: lang ждём код языка BCP-47 (ru, en, de, pt-BR), а не «english»"]);
  assert.deepEqual(inLang("en", () => parseMetaText(meta).warnings), ['unknown type "odd"', 'title: lang must be a BCP-47 language code (ru, en, de, pt-BR), not "english"']);
  assert.deepEqual(inLang("ru", () => parseOutput("x | status=odd bash=rm").warnings), ["неизвестный status «odd»", "параметр bash= запрещён и проигнорирован"]);
  assert.deepEqual(inLang("en", () => parseOutput("x | status=odd bash=rm").warnings), ['unknown status "odd"', "parameter bash= is forbidden and ignored"]);
  // the linter takes the language explicitly (registry CI: ru by default)
  assert.equal(pathViolation("~/.claude/projects/x", "ru"), "запрещено: ~/.claude/projects");
  assert.equal(pathViolation("~/.claude/projects/x", "en"), "forbidden: ~/.claude/projects");
  assert.equal(pathViolation("~/a/b.key", "ru"), "запрещённый файл: b.key");
  assert.equal(pathViolation("~/a/b.key", "en"), "forbidden file: b.key");
});

test("hub-update watchdog log follows the hub language", async () => {
  const home = tempHome("ah-l-w-");
  try {
    for (const [lang, want] of [["ru", "откат не нужен"], ["en", "no rollback needed"]]) {
      const lines = [];
      setLangSource(() => lang);
      try {
        const r = await rollbackTrial({ home, st: { phase: "trial", startedAt: "2026-01-01T00:00:00Z", label: "0.2.0" }, log: (s) => lines.push(s) });
        assert.equal(r, null);
      } finally {
        setLangSource(null);
      }
      assert.match(lines.join("\n"), new RegExp(want));
    }
  } finally {
    cleanup(home);
  }
});

test("langForHome: the home's settings.json, the system override (AGENTHUB_SYSTEM_LANG / test mode)", () => {
  const home = tempHome("ah-l-h-");
  try {
    assert.equal(langForHome(home, { AGENTHUB_SYSTEM_LANG: "en" }), "en");
    assert.equal(langForHome(home, { AGENTHUB_HOME: home }), "ru", "test mode: the system language is ru");
    writeFileSync(join(home, "settings.json"), JSON.stringify({ lang: "en" }));
    assert.equal(langForHome(home, { AGENTHUB_HOME: home }), "en", "the setting beats the system language");
  } finally {
    cleanup(home);
  }
});

test("plugin warnings in the journal are written in the hub language (ru, then en after switching)", async () => {
  const dir = tempHome("ah-l-j-");
  writePlugin(dir, "warny.5m.sh", `#!/bin/sh\necho "x | status=odd"\n`);
  const h = await startHub({ pluginsDir: dir });
  try {
    await waitFor(() => h.core.journal.tail(50).some((e) => e.type === "warning" && e.plugin === "warny"));
    assert.ok(h.core.journal.tail(50).some((e) => e.type === "warning" && e.detail === "неизвестный status «odd»"));
    h.core.setLang("en", APP);
    await waitFor(() => h.core.journal.tail(80).some((e) => e.type === "warning" && e.detail === 'unknown status "odd"'), { timeoutMs: 8000 });
  } finally {
    await h.stop();
    cleanup(dir);
  }
  assert.equal(currentLang(), "en", "a stopped core no longer sets the language");
});

