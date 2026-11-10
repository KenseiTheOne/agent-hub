# Stage 6: answering sessions (hook, cards, `session.respond`)

How a permission request or a question from a Claude Code session reaches a hub card and back. The mechanics were checked
with Claude Code hook experiments at stage 0.

## Parts

| Part | File |
|---|---|
| Hook (type `command`) | `hook/agenthub-hook` (Node, CommonJS, no dependencies); copy — `claude-plugin/hook/agenthub-hook` |
| Claude Code plugin `agent-hub` | `claude-plugin/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`) — **installed by the user**, see [`claude-plugin/README.md`](../claude-plugin/README.md) |
| Daemon service | `daemon/lib/services/hook.mjs` — the `POST /hook` handler via `ctx.onHook` |
| Logic | `daemon/lib/hook/cards.mjs` — registry of interactive sessions, cards, limits |
| Routes for the app | `daemon/lib/routes/hook.mjs` — `GET /hook/cards`, `GET /hook/cards/:id`, `GET /hook/status` |
| Primitive | `daemon/lib/primitives/session.respond.mjs` |

## Request path

```
Claude Code ──sh -c──▶ agenthub-hook ──POST /hook (hub.sock)──▶ core: class hook? session_id = sessions/<claudePid>.json?
                                                                    │ no → 403 → the hook prints {}
                                                                    ▼
                                                     hook service: interactive? limits? → no → {}
                                                                    ▼
                                                     card (SSE hook.card) … waits ≤ waitMs
                                                                    ▼
AgentHub.app ── GET /hook/cards ── POST /actions/session.respond ──▶ allow / deny / allow+updatedInput
```

1. **agenthub-hook** reads stdin, forwards only the needed fields (no `transcript_path`, `cwd`,
   `last_assistant_message`, `permission_suggestions`…; `tool_input` only for `PermissionRequest`),
   waits for the answer (`AGENTHUB_HOOK_TIMEOUT_MS`, by default 118 s for `PermissionRequest`, 5 s for the rest),
   passes through only a narrow answer and **always** exits with code 0. No daemon, a foreign socket, 403, timeout,
   garbage — `{}`. `NODE_OPTIONS` is cleared by the line `#!/usr/bin/env -S -u NODE_OPTIONS node`.
2. **The core** (`server.mjs`) admits `POST /hook` only from the `hook` class: the executing script is
   `agenthub-hook` from `peer.hookPaths`, and among its ancestors (up to 4 levels) there is a process signed as Claude
   Code; `session_id` must match `~/.claude/sessions/<claudePid>.json`, otherwise `403 peer:session-mismatch`.
   While the hub is paused (estop) the core answers `{}` without calling the service.
3. **The hook service**:
   - `SessionStart` → the session is interactive if:
     - the Claude process itself has a controlling terminal and its argv has no `-p`/`--print`/`--output-format`/
       `--input-format` (`peer.interactiveProcess`: the core, not a file — an agent inside the session cannot fake it);
     - the session file has `kind ∈ interactiveKinds` (`["interactive"]`) and `entrypoint ∈ interactiveEntrypoints`
       (`["cli"]`) — only a hint: any process with the same UID can rewrite the file;
     - `session_id` is not bound to another live signed Claude process (`sid-bound`) — a foreign agent cannot take
       over a session by writing its id into its own file;
     - a `session_id` change for the same pid is allowed only with `source ∈ {clear, resume, compact}`
       (`rebind-source`); the previous session of that pid is then removed (`replaced`);
     - `ctx.sessions.register(… interactive: true)` passed the signature check.
     After a daemon restart the registry is empty: the first `PermissionRequest` of a verified hook registers the
     session lazily with the same checks (`source: "lazy"`).
   - `SessionEnd`/`Stop`/`PermissionRequest` with a `session_id` bound to another pid — `{}` and a
     `hook-foreign-session` record: one session's hook neither removes nor replaces another session's cards.
   - `SessionEnd` → drop interactivity and cards. `Stop` → drop the session's cards.
   - `PermissionRequest` → `{}` immediately if: paused by a limit; the session is not interactive (no SessionStart,
     another pid, the process died, the pid was reused — the start time changed, the signature failed);
     the tool is in `skipTools` (`ExitPlanMode`); `tool_input` is not an object; more than `maxRequestsPerMinute`
     requests from the session within a minute; `maxPending` cards are already waiting; an unknown AskUserQuestion
     shape. Otherwise a card is created and the hook waits for a decision for at most `waitMs`.
4. **Card removal** (the hook gets `{}`): timeout; a repeated identical request (dedup by
   session + agent_id + tool + `tool_input`); `Stop`/`SessionEnd`; the session status in the registry was `waiting`
   and changed (answered in the terminal or via Remote Control); hub pause (estop); answer pause; the hook connection
   dropped (`signal` from the core); the service stopped.

### Daemon stopped or unavailable (checked 2026-11-06)

The hub is not a required participant: without the daemon Claude Code works as if there were no hook.

- **The daemon stops normally** (the app quit and sent `POST /shutdown`, or SIGTERM): the server closes connections
  and removes the socket. A pending `PermissionRequest` loses its connection — `agenthub-hook` prints `{}` right away
  and exits with code 0, Claude Code shows its usual permission dialog in the terminal (test
  `daemon/test/app-lifecycle.test.mjs`: the hook answers in under 3 s after `/shutdown`, not after 118 s).
- **No daemon** (no socket): `{}` immediately, without trying to connect (`AGENTHUB_HOOK_DEBUG=1` → "daemon is not running");
  the same test — under 2 s including node startup.
- **The socket remains but the daemon crashed** (`ECONNREFUSED`): `{}` immediately ("socket: ECONNREFUSED").
- **The daemon hangs** (accepts but stays silent): `{}` on the hook timeout — 118 s for `PermissionRequest`, 5 s for
  the rest (`AGENTHUB_HOOK_TIMEOUT_MS`).

## Cards — for the app

`GET /hook/cards` — **app only** (questions contain conversation content):

```jsonc
{ "cards": [{
    "requestId": "9f…32 hex", "sessionId": "…", "sessionName": "…|null", "surfaceId": "…|null",
    "claudePid": 2220, "subagent": false,
    "kind": "permission" | "question",
    "tool": "Bash", "summary": "Bash: git",         // command name or path, no body
    "questions": null | [{ "question": "…", "header": "…", "multiSelect": false,
                           "options": [{ "label": "…", "description": "…|null" }] }],
    "decisions": ["once", "deny"] | ["answer", "deny"],
    "createdAt": "…", "expiresAt": "…" }],
  "paused": false, "pausedUntil": null, "estop": false }
```

`GET /hook/cards/:id` — one card or 404. `GET /hook/status` — app and cli, metadata only:
`{pendingCount: {total, permission, question}, interactiveSessions: [...], paused, pausedUntil, limits, estop}`;
the app additionally gets `pending: [{requestId, sessionId, kind, tool}]`. **requestId is the answer key**: only app
sees it (cli gets counters), otherwise any process would know what to answer.

The server sends `hook.*` SSE events (`GET /events`) **to app only** (they contain requestId):

| `event` | `data` |
|---|---|
| `hook.card` | `{requestId, sessionId, kind, tool}` — a new card; the app fetches it from `GET /hook/cards/:id` |
| `hook.card.removed` | `{requestId, sessionId, reason}` — `answered`, `timeout`, `superseded`, `stop`, `session-end`, `answered-elsewhere`, `hook-gone`, `estop`, `paused`, `dead`, `replaced`, `service-stop` |
| `hook.paused` | `{until, limit}` — the approval limit was exceeded; the push service raises the hub event `@hub:approvals-paused` until the pause ends, the app shows the pause |

## Answer — `POST /actions/session.respond`

`app` only (the core forces `session.*` to be app-only; while the hub is paused — 423). Level `immediate`:
the card itself is the consent, no second `NSAlert` is needed.

```jsonc
{ "args": {
    "requestId": "<32 hex>",
    "decision": "once" | "deny" | "answer",
    "answers": "[[1],[0,2]]",   // answer only: a JSON string, per question an array of option indexes
                                 // (exactly one without multiSelect) or an "Other" string (1–2000 characters)
    "presence": "…"              // reserved for Touch ID, not checked yet
} }
```

| Response | Meaning |
|---|---|
| `200 {"ok":true}` | the decision went to the hook |
| `200 {"ok":false,"result":{"error":"rate-limit"}}` | an approval beyond `maxApprovalsPerMinute` → a `pauseMs` pause, all cards removed, `hook.paused` event |
| `409 facts:not-pending` | no card: already answered (in the hub, terminal, RC), timeout, repeat |
| `409 facts:decision` / `facts:answers` | the decision does not fit the card kind / the answers do not match the questions |
| `409 facts:paused`, `facts:not-interactive`, `facts:no-hook-service` | paused / the session is no longer interactive / the service is not running |
| `403 peer:cli` | not the app |
| `400 args:…` | extra arguments (`updatedPermissions`, `mode`, …) and unknown `decision` values |

What goes to the hook: `once` → `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`;
`deny` → `decision: {behavior: "deny", message: "Denied in Agent Hub"}` (in the hub language; Russian «Отклонено в Agent Hub»; without `interrupt`);
`answer` → `allow` + `updatedInput` = the original `tool_input` (the same `questions`) + `answers: {<question text>: <label>}`,
for multiSelect the labels are joined with `", "`. `updatedPermissions`, "always", bypass and `setMode` cannot be
expressed at all.

The second line of defense is `agenthub-hook` itself: it passes `updatedInput` only for `AskUserQuestion` and only if
everything except `answers` matches the original `tool_input` (deep comparison), and `answers` are strings. Any other
`updatedInput` (for example, a replaced Bash command from a foreign process on `hub.sock`) becomes `{}`.

## Settings (`config.json` → `services.hook`)

| Key | Default | |
|---|---|---|
| `waitMs` | 110000 | how long a card waits; less than the hook timeout (118 s) and the `timeout` in hooks.json (125 s) |
| `maxApprovalsPerMinute` | 10 | approvals (once/answer) across all sessions within a sliding minute |
| `pauseMs` | 600000 | pause after the limit is exceeded |
| `maxRequestsPerMinute` | 30 | requests from one session per minute |
| `maxPending` | 32 | cards waiting at the same time |
| `interactiveKinds` / `interactiveEntrypoints` | `["interactive"]` / `["cli"]` | the interactivity rule (check in stage 0, item (e)) |
| `skipTools` | `["ExitPlanMode"]` | no card is created for these tools |
| `sweepMs` | 30000 | check whether interactive sessions are alive |

## Journal (metadata only)

`hook-session` (sessionId, claudePid, interactive, reason, kind, entrypoint, source), `hook-session-end`,
`hook-card` (request — a **hash** of requestId, sessionId, **claudePid** of the verified ancestor, kind, tool),
`hook-answer` (decision, appPid), `hook-cancel` (reason), `hook-skip` (reason), `hook-paused`, `hook-foreign-session`.
`GET /journal` is open to cli too, so requestId itself is never written to the journal. `tool_input`, paths, commands,
questions — never.

## What the core provides

- `core.handleHook` calls handlers as `h(body, {peer, signal})`; `signal` is an `AbortSignal` that fires when
  `agenthub-hook` closed the connection before the answer (Claude killed the hook — for example, it was answered in
  the terminal). The service removes the card with reason `hook-gone` right away instead of waiting for the timeout.
- `peer.hookPaths` includes `<repo>/claude-plugin/hook/agenthub-hook` by default, so `claude --plugin-dir
  <repo>/claude-plugin` works without editing `config.json`.
- `GET /state` contains no cards; `GET /hook/cards` + SSE is enough for the app.
