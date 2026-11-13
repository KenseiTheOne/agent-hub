// Review 3 (2026-11-12), task 85: built-in plugin leftovers of the rename. The quota push labels no longer repeat the
// plugin name in the banner, and the "broken" frames keep the short tile caption of a normal frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPluginMeta } from "../lib/meta.mjs";
import { parseOutput } from "../lib/output.mjs";
import { PushEngine } from "../lib/push/engine.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PLUGINS = join(REPO, "plugins");

test("quota: push labels don't repeat the plugin name in the banner", () => {
  const { meta } = readPluginMeta(join(PLUGINS, "quota/quota.5m.mjs"));
  const titles = { ru: meta.title, en: meta.i18n?.en?.title };
  assert.ok(titles.ru && titles.en);
  for (const lang of ["ru", "en"]) {
    // the last word of the title is the plugin's own name ("Квота" / "Quota")
    const name = titles[lang].split(/\s+/).pop().toLowerCase();
    for (const rule of meta.push) {
      const label = lang === "en" ? rule.labels.en : rule.label;
      assert.ok(label, `${rule.key}: ${lang} label`);
      assert.ok(!label.toLowerCase().startsWith(name), `${rule.key} (${lang}) starts with the plugin name: ${label}`);
      const self = { lang: () => lang };
      for (const itemTitle of [null, "Week 82% used, resets Mon 10:00"]) {
        const r = PushEngine.prototype.compose.call(self, { name: rule.key, label, kind: rule.kind }, { trusted: true, pluginTitle: titles[lang], itemTitle }, "quota", rule.key);
        const seen = `${r.subtitle} ${r.body}`.toLowerCase().split(name).length - 1;
        assert.equal(seen, 1, `${rule.key} (${lang}): the name once, got ${JSON.stringify(r)}`);
      }
    }
  }
});

test("built-in plugins: the broken frame keeps the tile caption", async () => {
  const cases = [
    ["agents/agents.mjs", { ru: "Агенты", en: "Agents" }],
    ["spend/spend.mjs", { ru: "Расход сегодня", en: "Spend today" }],
    ["claude-sessions/claude-sessions.mjs", { ru: "Сессии", en: "Sessions" }],
  ];
  for (const [file, want] of cases) {
    const mod = await import(join(PLUGINS, file));
    for (const lang of ["ru", "en"]) {
      const out = parseOutput(mod.brokenFrame(new Error("disk | gone"), lang));
      const head = out.header.find((h) => !h.separator);
      assert.equal(head.params.tileLabel, want[lang], `${file} (${lang})`);
      assert.equal(head.status, "unknown");
      assert.ok(out.events.includes("source-broken") || out.header.some((h) => h.event === "source-broken") || out.body.some((b) => b.event === "source-broken"), `${file}: source-broken`);
      assert.match(JSON.stringify(out.body), /disk ¦ gone/);
    }
  }
});
