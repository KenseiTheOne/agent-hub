// Synthetic Codex rollout lines for the codex-* plugin tests. The shapes follow Codex CLI 0.159 (new format, with
// token_usage_record and an "ordinal" key) and 0.146 (old format: token_count only, no ordinal). Every text field holds
// SECRET, so a test can check that no conversation text reaches a frame or a cache.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SECRET = "SYNTHETIC-PRIVATE-TEXT";

// One rollout writer: keeps the ordinal and the clock. `old: true` — the 0.146 shape (no ordinal key).
export function writer({ start = "2026-11-22T10:00:00.000Z", old = false } = {}) {
  let ordinal = 0;
  let t = Date.parse(start);
  let self = null; // the thread id of the file's own session_meta
  const lines = [];
  const at = (stepMs = 1000) => new Date((t += stepMs)).toISOString();
  const push = (type, payload, stepMs) => {
    const o = old ? { timestamp: at(stepMs), type, payload } : { timestamp: at(stepMs), ordinal: ordinal++, type, payload };
    lines.push(JSON.stringify(o));
    return lines.at(-1);
  };
  return {
    lines,
    now: () => t,
    // `forkedFrom` — a user fork (forked_from_id); `parent` — a spawned agent (parent_thread_id)
    meta({ id, cwd = "/Users/test/Projects/demo", source = "cli", parent = null, forkedFrom = null }) {
      self ??= id;
      return push("session_meta", { id, ...(forkedFrom ? { forked_from_id: forkedFrom } : {}), ...(parent ? { parent_thread_id: parent } : {}), timestamp: new Date(t).toISOString(), cwd, originator: "codex_cli_rs", cli_version: old ? "0.146.0" : "0.159.3", source, base_instructions: { text: SECRET } }, 0);
    },
    // Codex 0.159 appends the thread's own settings snapshot after a fork's copied prefix (and on resume)
    settingsApplied({ thread = self, model = "gpt-6.1-terra" } = {}) {
      return push("event_msg", { type: "thread_settings_applied", ...(thread ? { thread_id: thread } : {}), thread_settings: { model, reasoning_effort: "high", developer_instructions: `${SECRET} "thread_id":"trap"` } });
    },
    // Lines copied from another file the way Codex writes a fork: same content, fresh timestamps `stepMs` apart.
    copy(otherLines, stepMs = 2) {
      for (const l of otherLines) {
        const { timestamp, ordinal: _, ...rest } = JSON.parse(l);
        lines.push(JSON.stringify(old ? { timestamp: at(stepMs), ...rest } : { timestamp: at(stepMs), ordinal: ordinal++, ...rest }));
      }
    },
    wait(ms) {
      t += ms;
    },
    userMessage() {
      push("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: SECRET }] });
      return push("event_msg", { type: "user_message", message: SECRET, images: [] });
    },
    turnContext({ turn, model = "gpt-6.1-terra", effort = null, settingsEffort = "high" }) {
      return push("turn_context", {
        turn_id: turn,
        root_turn_id: turn,
        cwd: "/Users/test/Projects/demo",
        current_date: "2026-11-22",
        approval_policy: "on-request",
        sandbox_policy: { type: "workspace-write" },
        model,
        ...(effort ? { effort } : {}),
        collaboration_mode: { mode: "default", settings: { model, reasoning_effort: settingsEffort, developer_instructions: `${SECRET} "effort":"minimal" "model":"trap"` } },
        summary: "auto",
      });
    },
    taskStarted({ turn, startedAt = Math.floor(t / 1000) }) {
      return push("event_msg", { type: "task_started", turn_id: turn, root_turn_id: turn, started_at: startedAt, model_context_window: 272000, collaboration_mode_kind: "default" });
    },
    taskComplete({ turn }) {
      return push("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: SECRET, started_at: 0, completed_at: 0, duration_ms: 1000, time_to_first_token_ms: 100 });
    },
    turnAborted({ turn }) {
      return push("event_msg", { type: "turn_aborted", turn_id: turn, reason: "interrupted" });
    },
    agentMessage() {
      push("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: SECRET }] });
      return push("event_msg", { type: "agent_message", message: SECRET });
    },
    // new format: one API response
    usage({ turn, response, input = 1000, cached = 400, output = 200, reasoning = 50, thread = self ?? "t" }) {
      const usage = { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
      return push("token_usage_record", { thread_id: thread, turn_id: turn, session_id: thread, root_turn_id: turn, response_id: response, usage, turn_token_usage: usage, thread_token_usage: usage });
    },
    // token_count event: in the new format it repeats the record (with rate limits); in the old one it is the only count
    tokenCount({ input = 1000, cached = 400, output = 200, reasoning = 50, total = null, rateLimits = null }) {
      const last = { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
      const info = { total_token_usage: { ...last, total_tokens: total ?? input + output }, last_token_usage: last, model_context_window: 272000 };
      return push("event_msg", { type: "token_count", info, rate_limits: rateLimits });
    },
    rateLimitsOnly(rateLimits) {
      return push("event_msg", { type: "token_count", info: null, rate_limits: rateLimits });
    },
    text() {
      return lines.join("\n") + "\n";
    },
  };
}

// sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl under a Codex home → the full path.
export function rolloutPath(codex, id, iso = "2026-11-22T10:00:00.000Z", { archived = false } = {}) {
  const d = new Date(iso);
  const ts = iso.slice(0, 19).replace(/:/g, "-");
  const name = `rollout-${ts}-${id}.jsonl`;
  if (archived) return join(codex, "archived_sessions", name);
  return join(codex, "sessions", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"), name);
}

export function writeRollout(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

// A rate_limits snapshot as Codex writes it into token_count.
export function fileRateLimits({ primary = null, secondary = null, plan = "plus" } = {}) {
  return { limit_id: "codex", limit_name: null, primary, secondary, credits: null, plan_type: plan, rate_limit_reached_type: null };
}
