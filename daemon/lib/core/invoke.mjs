// Core part: running an action (POST /actions/:id → invoke) — the offer or the primitive behind the id, the caller's
// class and the pause, arguments against facts, the confirmation window and its token, the run and its journal record.
// The methods are installed on Core.prototype by lib/core.mjs (lib/parts.mjs): `this` is the Core.

import { randomBytes } from "node:crypto";
import { readPluginMeta, splitWhy } from "../meta.mjs";
import { cleanPhrase } from "../output.mjs";
import { validateArgs } from "../schema.mjs";
import { makeCtx } from "../ctx.mjs";
import { pickLang, t } from "../i18n.mjs";
import { actionFingerprint, actionLevel, checkActionArg, inputDecls, sha, shownCommand } from "./action-rules.mjs";
import { SNAPPY_MS } from "./frames.mjs";
import { testTierPlugin } from "./tiers.mjs";

const CONFIRM_TTL_MS = 120_000;

export class CoreInvoke {
  // ---------- running an action ----------
  // req: { id, args?, input?, confirmToken?, peer } → { status, body }
  // input (G1) — the text a human typed for an input action (offer.input); ignored for any other target.
  async invoke({ id, args = undefined, input = undefined, confirmToken = null, peer: peerInfo }) {
    const started = Date.now();
    const cls = peerInfo?.class || "cli";
    // G11: pressed by a plugin process (the server found the peer, or an ancestor, among plugin runs, streams and actions —
    // peer.plugin): the journal names the initiating plugin, not only "peer: cli"
    const by = typeof peerInfo?.plugin?.id === "string" ? { byPlugin: peerInfo.plugin.id } : {};
    const deny = (status, error, extra = {}) => {
      this.journal.write({ type: "action-denied", action: id, peer: cls, pid: peerInfo?.pid, ...by, error });
      return { status, body: { error, ...extra } };
    };
    // 1. target
    let target = null;
    const offer = this.offers.get(id);
    if (offer) {
      // an action of a non-builtin plugin — only from the app, even immediate (official without a confirmation window):
      // it can be pressed by a human in the shell, not by cli and not by an agent
      if (offer.kind === "action") target = { kind: "action", offer, args: offer.args, level: offer.level, appOnly: offer.appOnly === true, safeUnderEstop: false, label: offer.label };
      else {
        const prim = this.primitives.get(offer.primitive);
        if (!prim) return deny(404, "not-found");
        target = { kind: "effect", offer, prim, args: offer.args, level: prim.level, appOnly: prim.appOnly, safeUnderEstop: prim.safeUnderEstop };
      }
    } else if (this.primitives.has(id)) {
      // arguments are checked after the peer class and the hub pause (order per docs/api.md): cli with an empty body
      // on an app-only primitive gets 403 peer:cli, not 400 args:…
      const prim = this.primitives.get(id);
      target = { kind: "primitive", prim, args: null, rawArgs: args ?? {}, level: prim.level, appOnly: prim.appOnly, safeUnderEstop: prim.safeUnderEstop };
    } else return deny(404, "not-found");

    // 2. peer
    if (cls === "foreign") return deny(403, "peer:uid");
    if (cls !== "app" && cls !== "cli") return deny(403, `peer:${cls}`);
    const needApp = target.appOnly || target.level !== "immediate";
    // G15: on a test hub with AGENTHUB_TEST_TIER=own, cli (a script, curl) may press actions of its test-tier plugins at any level
    // (a confirm level still goes through 428 and the token) — never on the live hub (config.testTierOf)
    // Task 75: the same for an app-only primitive that acts on one plugin's thing and names it (pluginOf: job.cancel → the job's
    // plugin) when that plugin is a test-tier one — stopping a test plugin's job is testable without the app
    const testCli = cls === "cli" && this.config.testTier === "own" && ((target.kind === "action" && offer?.testTier === true) || (target.kind === "primitive" && this.testTierTargetOf(target.prim, target.rawArgs)));
    if (needApp && cls !== "app" && !testCli) return deny(403, peerInfo?.reason && peerInfo.reason !== "peer:no-agent-ancestor" ? peerInfo.reason : `peer:${cls}`, { peer: cls });
    if (target.kind === "effect" && offer && !this.plugins.has(offer.pluginId)) return deny(404, "not-found");

    // 3. ESTOP
    if (this.estop() && !target.safeUnderEstop) return deny(423, "estop");

    // 3a. arguments of a direct primitive call
    if (target.kind === "primitive") {
      const v = validateArgs(target.prim.argsSchema, target.rawArgs);
      if (v.error) return deny(400, v.error);
      target.args = v.args;
      delete target.rawArgs;
    }

    // 4. checking against facts
    // A plugin action is checked against the current metadata of its file on disk (not a snapshot from the offer): the file may have been
    // replaced or updated while the offer and the confirmation window were alive. Argument pattern fails —
    // facts:bad-arg; command, level, pattern, version or plugin tier changed — facts:action-changed.
    if (target.kind === "action") {
      const cur = this.currentAction(offer);
      if (!cur) return deny(409, "facts:action-changed");
      if (cur.action.input) {
        // task 65: the row argument of an input action with inputPattern= — checked like any action argument
        const d = inputDecls(cur.action);
        if (d.row) {
          const v = checkActionArg(d.row, target.args?.[d.row.name]);
          if (v.error) return deny(409, "facts:bad-arg");
          target.argValue = v.value;
        } else if (target.args && Object.keys(target.args).length) return deny(409, "facts:bad-arg");
        // G1: the typed text — checked like an argument (control characters, a leading "-", the declared pattern) with the
        // action's maxLength. A confirm-level action may be asked without it: the 428 then carries the field (the app shows
        // it in the confirmation sheet) and the token accepts any valid text typed there.
        if (input === undefined || input === null) {
          if (target.level === "immediate" || confirmToken) return deny(400, "input:required");
          target.inputOpen = true;
        } else {
          const v = checkActionArg(d.text, input, { max: cur.action.input.maxLength });
          if (v.error) return deny(400, `input:${v.error}`);
          target.input = v.value;
        }
      } else if (cur.action.arg) {
        const v = checkActionArg(cur.action.arg, target.args?.[cur.action.arg.name]);
        if (v.error) return deny(409, "facts:bad-arg");
        target.argValue = v.value;
      } else if (target.args && Object.keys(target.args).length) return deny(409, "facts:bad-arg");
      if (cur.fp !== offer.fp) return deny(409, "facts:action-changed");
      target.action = cur.action;
      target.level = cur.level;
      target.fp = cur.fp;
      // G6: a background action — not more than plugins.maxJobsPerPlugin jobs of this plugin at once
      if (cur.action.background && this.jobsCount(offer.pluginId) >= this.maxJobs()) return deny(409, "facts:jobs-limit");
    }
    if (target.prim) {
      let f;
      try {
        f = await target.prim.verifyFacts(target.args, this.facts, { peer: peerInfo, plugin: offer?.pluginId ?? null, config: this.config });
      } catch (e) {
        f = { ok: false, reason: "verify-error" };
      }
      if (!f?.ok) return deny(409, `facts:${f?.reason || "rejected"}`);
    }

    // 5. confirmation (the core decides; the core writes the text). The token key includes the action fingerprint: a token issued
    // for the text of one version of a command will not execute another.
    // An input action: the key also binds the typed text (its hash) — or "open" when the text is typed in the confirmation sheet.
    const baseKey = sha(`${id}|${target.fp || ""}|${JSON.stringify(target.args || {})}`);
    const inputKey = (v) => sha(`${baseKey}|input|${v}`);
    const key = target.inputOpen ? inputKey("open") : target.input !== undefined ? inputKey(sha(target.input)) : baseKey;
    if (target.level !== "immediate") {
      if (!confirmToken) {
        const token = randomBytes(16).toString("hex");
        const d = this.describeTarget(target);
        // test tier cli (G15): every curl is a new process — the token is not bound to the pid there
        this.confirmTokens.set(token, { key, expires: Date.now() + CONFIRM_TTL_MS, pid: testCli ? null : (peerInfo?.pid ?? null) });
        for (const [t, v] of this.confirmTokens) if (v.expires < Date.now()) this.confirmTokens.delete(t);
        // what exactly was asked: plugin and action (the offer id is a hash, a human learns nothing from it)
        const askedTitle = target.kind === "action" ? pickLang((target.action || target.offer?.action)?.title, (target.action || target.offer?.action)?.i18n, "title", this.lang()) : null;
        this.journal.write({ type: "action-confirm-requested", action: id, plugin: offer?.pluginId ?? null, actionId: target.offer?.action?.id ?? null, primitive: target.prim?.name ?? null, title: askedTitle ? String(askedTitle).slice(0, 80) : null, peer: cls, pid: peerInfo?.pid, ...by });
        return {
          status: 428,
          body: {
            error: "confirm-required",
            needsConfirm: true,
            token,
            level: target.level,
            text: d.text,
            cost: d.cost ?? null,
            expiresInMs: CONFIRM_TTL_MS,
            // G10: the row carrying the button (sanitized, also quoted in text); G1: the field to show in the sheet when the text
            // was not sent yet; G6: pressing starts a background job
            ...(d.row ? { row: d.row } : {}),
            // the same confirmation by parts (plugin actions): the shell lays its window out from these
            ...(d.parts ? { parts: d.parts } : {}),
            ...(target.inputOpen ? { input: { ...offer.input } } : {}),
            ...(target.action?.background ? { background: true } : {}),
          },
        };
      }
      const t = this.confirmTokens.get(confirmToken);
      this.confirmTokens.delete(confirmToken);
      const keyOk = t && (t.key === key || (target.input !== undefined && t.key === inputKey("open")));
      if (!keyOk || t.expires < Date.now() || (t.pid !== null && t.pid !== (peerInfo?.pid ?? null))) return deny(403, "confirm:invalid");
    }

    // 6. execution. Hub pause — once more: there were waits between step 3 and here (verifyFacts, the
    // confirmation window is already behind, but the fact check is asynchronous).
    if (this.estop() && !target.safeUnderEstop) return deny(423, "estop");
    let result;
    try {
      if (target.kind === "action") {
        const inst = this.host.get(target.offer.pluginId);
        if (!inst) return deny(404, "not-found");
        const runKey = `${id}:${started}`;
        const title = this.plugins.get(target.offer.pluginId)?.actions?.find((a) => a.id === target.action.id)?.title || target.action.id;
        this.runningActions.set(runKey, { action: target.action.id, plugin: target.offer.pluginId, title: String(title).slice(0, 200), since: new Date(started).toISOString() });
        this.emit({ type: "action.started", action: id, plugin: target.offer.pluginId, actionId: target.action.id });
        // action and argument — already checked against the current metadata (step 4)
        try {
          if (target.action.background) result = await this.startJob(inst, target, title);
          else result = await inst.runAction(target.action, inputDecls(target.action).row ? target.argValue : null, { input: target.input ?? null });
        } finally {
          this.runningActions.delete(runKey);
        }
      } else {
        const ctx = { ...makeCtx(this, `primitive:${target.prim.name}`), requester: { ...peerInfo }, plugin: offer?.pluginId || null };
        result = (await target.prim.run(target.args, ctx)) || { ok: true };
      }
    } catch (e) {
      result = { ok: false, error: "run-error" };
    }
    const safe = {};
    for (const [k, v] of Object.entries(result || {})) if (v === null || ["string", "number", "boolean"].includes(typeof v)) safe[k] = typeof v === "string" ? v.slice(0, 200) : v;
    // the rows of a refusal (fact= lines of a plugin action, host.mjs actionDetails): the only list a result carries
    if (target.kind === "action" && Array.isArray(result?.facts)) {
      const facts = result.facts.filter((f) => typeof f === "string" && f).slice(0, 3).map((f) => f.slice(0, 200));
      if (facts.length) safe.facts = facts;
    }
    this.journal.write({
      type: "action",
      action: id,
      kind: target.kind,
      primitive: target.prim?.name,
      actionId: target.offer?.action?.id,
      plugin: offer?.pluginId,
      peer: cls,
      pid: peerInfo?.pid,
      ...by,
      ok: Boolean(safe.ok),
      code: safe.code,
      ms: Date.now() - started,
      // G1: only the length of the typed text, never the text; G6: the job a background action started
      ...(target.input !== undefined ? { inputLength: [...target.input].length } : {}),
      ...(typeof safe.job === "string" ? { background: true, job: safe.job } : {}),
    });
    this.emit({ type: "action", action: id, ok: Boolean(safe.ok), plugin: offer?.pluginId || null, primitive: target.prim?.name || null, ...(typeof safe.job === "string" ? { job: safe.job } : {}) });
    if (offer) {
      const pst = this.plugins.get(offer.pluginId);
      // the frame that follows the action goes to the app at once, not after the coalescing interval (G9)
      this.snappy.set(offer.pluginId, Date.now() + SNAPPY_MS);
      if (pst?.type === "streamable") {
        // arg (G18) — the checked argument value from the offer; an input action has none here: the typed text went to the
        // action's stdin, the plugin gets only its length
        const arg = target.kind === "action" && inputDecls(target.action).row ? (target.argValue ?? null) : null;
        this.host.send(offer.pluginId, {
          type: "actionResult",
          id,
          actionId: offer.action?.id || null,
          primitive: offer.primitive || null,
          arg,
          ok: Boolean(safe.ok),
          code: safe.code ?? null,
          ...(target.input !== undefined ? { inputLength: [...target.input].length } : {}),
          ...(typeof safe.job === "string" ? { job: safe.job } : {}),
        });
      } else this.host.refresh(offer.pluginId, "MenuAction");
    }
    return { status: 200, body: { ok: Boolean(safe.ok), result: safe } };
  }

  // Task 75: whether a direct primitive call concerns a test-tier plugin (the primitive names it: pluginOf(rawArgs, facts)).
  testTierTargetOf(prim, rawArgs) {
    if (typeof prim?.pluginOf !== "function") return false;
    let pluginId = null;
    try {
      pluginId = prim.pluginOf(rawArgs ?? {}, this.facts);
    } catch {
      return false;
    }
    return typeof pluginId === "string" && testTierPlugin(this.pluginMeta.get(pluginId));
  }

  // The offer's action per the current plugin file. → { action, level, fp } | null (the plugin, the action or the right
  // to actions is gone, the file cannot be read).
  currentAction(offer) {
    const pl = this.pluginMeta.get(offer.pluginId);
    const st = this.plugins.get(offer.pluginId);
    if (!pl || !st || !st.actions.length) return null;
    let fresh;
    try {
      fresh = readPluginMeta(pl.file);
    } catch {
      return null;
    }
    if (!fresh) return null;
    const now = { ...pl, meta: fresh.meta };
    const action = fresh.meta.actions.find((a) => a.id === offer.action.id);
    if (!action) return null;
    return { action, level: actionLevel(now, action), fp: actionFingerprint(now, st.tier, action) };
  }

  // The core builds the confirmation text in the effective language; the plugin author's words are quoted and marked.
  describeTarget(target) {
    const lang = this.lang();
    if (target.kind === "action") {
      const a = target.action || target.offer.action;
      const pl = this.pluginMeta.get(target.offer.pluginId);
      const parts = [];
      let netHosts = false;
      if (target.level === "confirm-cost") {
        // net="none" (G2): the action promised no network — only its own cost= is left to show
        const net = a.net === "none" ? [] : (pl?.meta?.net || []).map((n) => splitWhy(n).what).filter(Boolean);
        netHosts = net.length > 0;
        parts.push(net.length ? t(lang, "cost.net", { hosts: net.slice(0, 3).join(", ") }) : t(lang, "cost.generic"));
      }
      // builtin plugin — our code, its words about cost are shown as is
      const cost = pickLang(a.cost, a.i18n, "cost", lang);
      if (cost) parts.push(pl?.source === "builtin" ? String(cost).slice(0, 200) : t(lang, "cost.pluginSays", { text: String(cost).slice(0, 200) }));
      const st = this.plugins.get(target.offer.pluginId);
      const tier = st?.tier ? t(lang, `tier.${st.tier}`) : "?";
      const rowArg = inputDecls(a).row;
      const arg = rowArg ? String(target.args?.[rowArg.name] ?? "") : "";
      const title = pickLang(a.title, a.i18n, "title", lang);
      const plugin = st?.title || target.offer.pluginId;
      const p = { plugin, tier, command: shownCommand(a.command, a.arg, arg, { input: Boolean(a.input) && !a.input.pattern }), arg, title: title ? String(title).slice(0, 80) : "" };
      const text = [t(lang, title ? "action.text" : "action.textNoTitle", p)];
      // G1: what goes to the command's stdin — the typed text (sanitized for display, ≤ 120) or "typed in this window"
      if (a.input) text.push(target.input !== undefined ? t(lang, "action.input", { text: cleanPhrase(target.input) }) : t(lang, "action.inputOpen"));
      // G10: which row the button was on — the plugin's words, sanitized (control characters, ≤ 120 graphemes)
      const row = target.offer.row && target.offer.row !== p.title && target.offer.row !== target.offer.label ? target.offer.row : null;
      if (row) text.push(t(lang, "action.row", { row }));
      if (a.background) text.push(t(lang, "action.background"));
      // the same by parts, for a shell that lays the window out itself; `text` and `cost` stay whole for older shells.
      // costNet — the hub's own words (confirm-cost only); note — the action's cost= words, notePlugin — they are a
      // plugin author's (not the hub's) and are shown as such
      const layout = {
        plugin: cleanPhrase(plugin) || target.offer.pluginId,
        tier,
        // the plugin's words become the window's title: control and format characters out (task 123)
        title: cleanPhrase(p.title) || null,
        command: p.command,
        arg: arg || null,
        row: target.offer.row || null,
        parentRow: target.offer.parentRow || null,
        // the generic "may use resources or the network" is the hub's own warning: only a built-in plugin (our code) that
        // named no host but explained its cost itself goes without it. A third-party plugin's cost= words cannot vouch it
        // stays off the network, so the hub keeps its line next to them (task 124)
        costNet: target.level === "confirm-cost" && (netHosts || !cost || pl?.source !== "builtin") ? parts[0] : null,
        note: cost ? String(cost).slice(0, 200) : null,
        notePlugin: Boolean(cost) && pl?.source !== "builtin",
        input: a.input ? (target.input !== undefined ? cleanPhrase(target.input) : null) : null,
        background: Boolean(a.background),
      };
      return { text: text.join(" "), cost: parts.length ? parts.join("; ") : null, row: target.offer.row || null, parts: layout };
    }
    try {
      const d = target.prim.describe?.(target.args, this.facts, lang);
      if (d?.text) return d;
    } catch {}
    return { text: `${target.prim.name} ${JSON.stringify(target.args)}`, cost: null };
  }
}
