// G14: plugin content in any language. The hub UI stays ru | en; plugins get the system preferred languages in
// AGENTHUB_LOCALE, metadata translations (lang="de", title-pt-BR=…) are picked by the chain hub language → system
// languages (up to the first hub UI language) → base text; malformed lang codes are a warning (journal and linter).

import test from "node:test";
import assert from "node:assert/strict";
import { contentLang, langCandidates, normLocales, normTag, pickLang, setLangSource, releaseLangSource, currentLocales } from "../lib/i18n.mjs";
import { Settings, detectSystemLocales } from "../lib/settings.mjs";
import { normLangTag, parseMetaText } from "../lib/meta.mjs";
import { curl, startHub, tempHome, cleanup, waitFor, writePlugin } from "./helpers.mjs";
import { join } from "node:path";

test("language tags: any BCP-47 tag in canonical case, malformed ones rejected", () => {
  assert.equal(normTag("de"), "de");
  assert.equal(normTag("pt_br"), "pt-BR");
  assert.equal(normTag("ZH-hant-tw"), "zh-Hant-TW");
  assert.equal(normTag("es-419"), "es-419");
  assert.equal(normTag("english"), null);
  assert.equal(normTag("d"), null);
  assert.equal(normTag("de DE"), null);
  assert.equal(normLangTag("pt-br"), "pt-BR", "meta.mjs agrees with i18n.mjs");
  assert.equal(normLangTag("e"), null);
  assert.deepEqual(normLocales("de-DE, en_US,,bad tag,de-DE"), ["de-DE", "en-US"]);
  assert.equal(normLocales(Array.from({ length: 20 }, (_, i) => `x${String.fromCharCode(97 + i)}`)).length, 8, "at most 8");
});

test("content chain: hub language, then system languages up to the first hub UI language, then the base text", () => {
  const i18n = { en: { title: "Weather" }, de: { title: "Wetter" }, "pt-BR": { title: "Tempo" } };
  // existing ru/en users: unchanged
  assert.equal(contentLang(i18n, "ru", { locales: ["ru-RU", "en-US"] }), null, "ru hub, ru-base plugin with an en variant — base text");
  assert.equal(contentLang(i18n, "ru", { locales: ["en-US", "de-DE"] }), null, "a ru hub on an English system stays on the base text");
  assert.equal(contentLang(i18n, "en", { locales: ["en-US"] }), "en");
  assert.equal(contentLang(i18n, "en", { locales: ["de-DE"] }), "en", "the hub language first");
  // a third language comes from the system list
  assert.equal(contentLang({ de: { title: "Wetter" } }, "en", { locales: ["de-AT", "en-US"] }), "de", "de-AT finds de");
  assert.equal(contentLang({ "de-DE": { title: "Wetter" } }, "en", { locales: ["de-CH"] }), "de-DE", "same primary language");
  assert.equal(contentLang(i18n, "en", { locales: [] }), "en");
  assert.equal(contentLang({ de: { title: "Wetter" }, fr: { title: "Météo" } }, "en", { locales: ["fr-FR", "de-DE"] }), "fr", "system order");
  assert.equal(contentLang({ de: { title: "Wetter" } }, "en", { locales: ["en-GB", "de-DE"] }), null, "a hub UI language earlier in the list stops the chain");
  assert.equal(contentLang({ "pt-BR": { title: "Tempo" }, pt: { title: "Tempo PT" } }, "en", { locales: ["pt-BR"] }), "pt-BR", "exact tag first");
  assert.deepEqual(langCandidates("en", ["de-DE", "ru-RU", "fr"]), ["en", "de-DE"]);
  // per field: a variant without the field doesn't hide the base text
  assert.equal(contentLang({ de: { desc: "x" } }, "en", { field: "title", locales: ["de"] }), null);
  assert.equal(pickLang("Base", { de: { title: "Wetter" } }, "title", "en"), "Base", "no registered locales — only the hub language");
  // the registered source (the daemon's core) supplies the system list
  const src = () => "en";
  src.locales = () => ["de-DE", "en-US"];
  setLangSource(src);
  try {
    assert.deepEqual(currentLocales(), ["de-DE", "en-US"]);
    assert.equal(pickLang("Base", { de: { title: "Wetter" } }, "title", "en"), "Wetter");
    assert.equal(pickLang("База", { de: { title: "Wetter" } }, "title", "ru"), "Wetter", "a ru hub on a German-first system");
  } finally {
    releaseLangSource(src);
  }
});

test("system languages: settings cache, AGENTHUB_SYSTEM_LOCALES override, a test hub's fixed language", () => {
  const dir = tempHome("ah-loc-");
  try {
    const s = new Settings(join(dir, "settings.json"), { detect: () => "en", detectLocales: () => ["de_DE", "en-US"] });
    assert.deepEqual(s.systemLocales(), ["de-DE", "en-US"]);
    assert.deepEqual(s.langInfo().locales, ["de-DE", "en-US"]);
    assert.deepEqual(new Settings(join(dir, "s2.json"), { detect: () => "ru" }).systemLocales(), ["ru"], "a fixed test language — the list is that language");
    assert.deepEqual(detectSystemLocales({ env: { AGENTHUB_SYSTEM_LOCALES: "fr-FR,en" } }), ["fr-FR", "en"]);
    assert.ok(Array.isArray(detectSystemLocales({ platform: "linux", env: {} })), "Intl fallback");
  } finally {
    cleanup(dir);
  }
});

test("metadata: lang tags with any BCP-47 code, title-xx attributes, malformed codes warned", () => {
  const { meta, warnings } = parseMetaText(`#!/bin/sh
# <agenthub.title>Wetter</agenthub.title>
# <agenthub.title lang="pt_br">Tempo</agenthub.title>
# <agenthub.desc lang="de">Das Wetter</agenthub.desc>
# <agenthub.title lang="deutsch">x</agenthub.title>
# <agenthub.status value="wait" label="Warte">w</agenthub.status>
# <agenthub.status lang="fr" value="wait" label="Attends">a</agenthub.status>
# <agenthub.action id="go" title="Los" title-de="Los!" title-pt-BR="Vai" title-q="bad">./x</agenthub.action>
`);
  assert.equal(meta.i18n["pt-BR"].title, "Tempo");
  assert.equal(meta.i18n.de.desc, "Das Wetter");
  assert.equal(meta.i18n.fr.statuses.wait.label, "Attends");
  assert.deepEqual(meta.actions[0].i18n, { de: { title: "Los!" }, "pt-BR": { title: "Vai" } });
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.ok(warnings.some((w) => w.includes("deutsch")));
  assert.ok(warnings.some((w) => w.includes("title-") && w.includes("q")));
});

test("hub: AGENTHUB_LOCALE reaches plugins, a German variant is shown on a German-first system, a malformed code is journaled", async () => {
  const dir = tempHome("ah-locp-");
  writePlugin(
    dir,
    "wx.1h.sh",
    `#!/bin/sh
# <agenthub.title>Weather</agenthub.title>
# <agenthub.title lang="de">Wetter</agenthub.title>
# <agenthub.title lang="ru">Погода</agenthub.title>
# <agenthub.desc lang="english">x</agenthub.desc>
# <agenthub.status value="wait" label="Wait">w</agenthub.status>
# <agenthub.status lang="de" value="wait" label="Warte">w</agenthub.status>
echo "loc=$AGENTHUB_LOCALE lang=$AGENTHUB_LANG | status=ok"
`,
  );
  const prev = process.env.AGENTHUB_SYSTEM_LOCALES;
  process.env.AGENTHUB_SYSTEM_LOCALES = "de-DE,en-US";
  const h = await startHub({ pluginsDir: dir });
  try {
    await waitFor(() => h.core.pluginState("wx")?.header?.[0]?.title?.startsWith("loc="));
    // the test hub's UI language is ru (a fixed language): ru has a variant — it wins
    assert.equal(h.core.pluginState("wx").header[0].title, "loc=de-DE,en-US lang=ru");
    assert.equal(h.core.pluginState("wx").title, "Погода");
    assert.deepEqual((await curl(h.sock, "GET", "/state")).body.lang.locales, ["de-DE", "en-US"]);
    // en UI: the plugin has no en variant — the first system language it has (de) instead of the base text
    h.core.setLang("en", { class: "app", pid: 1 });
    assert.equal(h.core.pluginState("wx").title, "Wetter");
    assert.equal(h.core.pluginState("wx").statusLabels.wait.label, "Warte");
    assert.ok(h.core.journal.tail(200).some((e) => JSON.stringify(e).includes("english")), "the malformed lang code is a journal warning");
  } finally {
    if (prev === undefined) delete process.env.AGENTHUB_SYSTEM_LOCALES;
    else process.env.AGENTHUB_SYSTEM_LOCALES = prev;
    await h.stop();
    cleanup(dir);
  }
});

// Review 2026-11-12 (C6): one OS read serves both the hub language and the content locales; a change of the system
// languages alone relocalizes plugin metadata.
test("system languages: the hub language and the locale list come from one OS read per minute", () => {
  const dir = tempHome("ah-loc-");
  let reads = 0;
  let t = 1_000_000;
  try {
    const s = new Settings(join(dir, "settings.json"), { readLanguages: () => (reads++, '(\n    "de-DE",\n    "ru-RU"\n)\n'), now: () => t, env: {} });
    assert.equal(s.systemLang(), "en", "the first system language is German: en UI");
    assert.deepEqual(s.systemLocales(), ["de-DE", "ru-RU"]);
    assert.equal(s.effectiveLang(), "en");
    assert.equal(reads, 1, "one read for both");
    t += 61_000;
    assert.deepEqual(s.systemLocales(), ["de-DE", "ru-RU"]);
    assert.equal(s.systemLang(), "en");
    assert.equal(reads, 2);
    // AGENTHUB_SYSTEM_LOCALES still overrides the list (the language comes from the same read)
    const s2 = new Settings(join(dir, "s2.json"), { readLanguages: () => (reads++, '("ru-RU")'), now: () => t, env: { AGENTHUB_SYSTEM_LOCALES: "fr-FR" } });
    assert.deepEqual([s2.systemLang(), s2.systemLocales()], ["ru", ["fr-FR"]]);
    assert.equal(reads, 3);
  } finally {
    cleanup(dir);
  }
});

test("hub: a change of the system languages alone relocalizes plugin metadata (settings.changed with the new locales)", async () => {
  const dir = tempHome("ah-locc-");
  writePlugin(
    dir,
    "wx.1h.sh",
    `#!/bin/sh
# <agenthub.title>Weather</agenthub.title>
# <agenthub.title lang="de">Wetter</agenthub.title>
# <agenthub.title lang="fr">Météo</agenthub.title>
echo "x | status=ok"
`,
  );
  const h = await startHub({ pluginsDir: dir });
  const events = [];
  h.core.on("event", (e) => events.push(e));
  try {
    await waitFor(() => h.core.pluginState("wx")?.header?.length);
    h.core.settings.detectLocales = () => ["de-DE"];
    h.core.settings.systemLocales({ fresh: true });
    h.core.langChanged();
    assert.equal(h.core.pluginState("wx").title, "Wetter");
    h.core.settings.detectLocales = () => ["fr-FR"];
    h.core.settings.systemLocales({ fresh: true });
    h.core.langChanged();
    assert.equal(h.core.pluginState("wx").title, "Météo", "the new first system language picks the variant");
    assert.ok(events.some((e) => e.type === "settings.changed" && e.lang?.locales?.[0] === "fr-FR"));
  } finally {
    await h.stop();
    cleanup(dir);
  }
});
