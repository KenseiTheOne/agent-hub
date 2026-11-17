// Translations of permission texts: what an archive or an own folder supplies (cleanI18n, permI18nFromMeta, mergeI18n)
// and the permission list in the hub language for the consent window and the lists (localizePerms). Pure functions — no
// manager here. lib/plugins.mjs re-exports the public names.

import { contentOf, normTag } from "../i18n.mjs";
import { splitWhy } from "../registry/perms.mjs";
import { isStr } from "./common.mjs";

export function cleanI18n(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out = {};
  for (const [raw, x] of Object.entries(v).slice(0, 64)) {
    // any BCP-47 tag (G14), canonical case; malformed — dropped
    const lang = normTag(raw);
    if (!lang || !x || typeof x !== "object") continue;
    const e = {};
    if (isStr(x.title, 200) && x.title) e.title = x.title;
    if (isStr(x.desc, 1000) && x.desc) e.desc = x.desc;
    for (const k of ["why", "actions"]) {
      if (!x[k] || typeof x[k] !== "object" || Array.isArray(x[k])) continue;
      const m = {};
      for (const [what, why] of Object.entries(x[k]).slice(0, 200)) if (isStr(what, 1024) && isStr(why, 1024) && why) m[what] = why;
      if (Object.keys(m).length) e[k] = m;
    }
    // dependency translations: { <name>: { name?, note? } }
    if (x.requires && typeof x.requires === "object" && !Array.isArray(x.requires)) {
      const m = {};
      for (const [name, v] of Object.entries(x.requires).slice(0, 8)) {
        if (!isStr(name, 64) || !v || typeof v !== "object") continue;
        const r = {};
        if (isStr(v.name, 64) && v.name) r.name = v.name;
        if (isStr(v.note, 300) && v.note) r.note = v.note;
        if (Object.keys(r).length) m[name] = r;
      }
      if (Object.keys(m).length) e.requires = m;
    }
    if (Object.keys(e).length) out[lang] = e;
  }
  return out;
}

// Permission translations from archive metadata: { en: { why: { <what>: <why> }, actions: { <id>: <title> } } }.
export function permI18nFromMeta(meta) {
  const out = {};
  for (const [lang, v] of Object.entries(meta?.i18n || {})) if (v?.why) (out[lang] ||= {}).why = { ...v.why };
  for (const a of meta?.actions || []) {
    for (const [lang, v] of Object.entries(a.i18n || {})) if (v?.title) ((out[lang] ||= {}).actions ||= {})[a.id] = v.title;
  }
  return cleanI18n(out);
}

export function mergeI18n(a = {}, b = {}) {
  const out = {};
  for (const lang of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a?.[lang] || {};
    const y = b?.[lang] || {};
    out[lang] = { ...x, ...y, why: { ...(x.why || {}), ...(y.why || {}) }, actions: { ...(x.actions || {}), ...(y.actions || {}) } };
  }
  return out;
}

// Permissions in the hub language: "why" from translations (for actions — the title-xx title), otherwise as the author wrote it.
// For watching, "why" is part of the entry itself (the permission key depends on it), so we separate it for display.
// Keys and the "new" mark don't change: translation affects labels only.
export function localizePerms(list, i18n, lang) {
  const trWhy = contentOf(i18n, lang, { field: "why" });
  const trAct = contentOf(i18n, lang, { field: "actions" });
  return (list || []).map((p) => {
    let what = p.what;
    let why = p.why;
    if (p.kind === "watch" && !why) ({ what, why } = splitWhy(what));
    const norm = (v) => String(v).trim().replace(/\s+/g, " ");
    // a recursive watch (B10) is translated by its path
    const key = p.kind === "watch" ? norm(what).replace(/ recursive$/, "") : norm(what);
    const byWhat = trWhy.why ? Object.entries(trWhy.why).find(([k]) => norm(k) === key || norm(k) === norm(what))?.[1] : undefined;
    const byAction = p.kind === "actions" ? trAct.actions?.[String(what).split(" ")[0]] : undefined;
    return { ...p, what, why: byWhat ?? byAction ?? why ?? null };
  });
}
