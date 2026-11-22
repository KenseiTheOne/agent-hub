# Stage 6: answering sessions (hook, cards, `session.respond`)

How a permission request or a question from a Claude Code or Codex CLI session reaches a hub card and back. The
mechanics were checked with Claude Code hook experiments at stage 0 and with Codex CLI 0.159.3 (section
[Codex CLI](#codex-cli)).

## Parts

| Part | File |
|---|---|
| Hook (type `command`) | `hook/agenthub-hook` (Node, CommonJS, no dependencies); copy — `claude-plugin/hook/agenthub-hook` |
| Plugin `agent-hub` (Claude Code and Codex) | `claude-plugin/` (`.claude-plugin/plugin.json`, `hooks/hooks.json`) — **installed by the user**, see [`claude-plugin/README.md`](../claude-plugin/README.md) |
| Daemon service | `daemon/lib/services/hook.mjs` — the `POST /hook` handler via `ctx.onHook` |
| Logic | `daemon/lib/hook/cards.mjs` — registry of interactive sessions, cards, limits |
| Agent table | `daemon/lib/hook/agents.mjs` — what differs between Claude Code and Codex (signature, session proof, interactivity, answers) |
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

1. **agenthub-hook** reads stdin, forwards only the needed fields (no `cwd`, `last_assistant_message`, `prompt`,
   `permission_suggestions`…; `tool_input` only for `PermissionRequest`; `transcript_path` only when it names a Codex
   rollout of the very thread that runs the hook — `rollout-…-<session_id>.jsonl`, or `<agent_id>` for a subagent,
   lowercase UUIDs only — the Codex session proof below),
   waits for the answer (`AGENTHUB_HOOK_TIMEOUT_MS`, by default 123 s for `PermissionRequest`, 2.5 s for `SessionEnd`
   — Codex cuts that event at 3 s —, 5 s for the rest),
   passes through only a narrow answer and **always** exits with code 0. No daemon, a foreign socket, 403, timeout,
   garbage — `{}`. `NODE_OPTIONS` is cleared by the line `#!/usr/bin/env -S -u NODE_OPTIONS node`.
2. **The core** (`server.mjs`) admits `POST /hook` only from the `hook` class: the executing script is
   `agenthub-hook` from `peer.hookPaths`, and among its ancestors (up to 4 levels) there is a process signed as Claude
   Code (`requirements.claudeCode`) or as Codex (`requirements.codex`) — otherwise `403 peer:no-agent-ancestor`. The
   session must belong to that ancestor, otherwise `403 peer:session-mismatch` / `peer:no-session-file`: for Claude
   Code `session_id` must match `~/.claude/sessions/<claudePid>.json`; for Codex see
   [Codex session proof](#codex-session-proof).
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
     **No lazy registration after `SessionEnd`.** A session this daemon saw `SessionEnd` for is over, not forgotten:
     a later `PermissionRequest` of the same Claude process with the same `session_id` gets `{}` right away
     (`hook-skip` with reason `session-ended`) instead of bringing the session back — otherwise a card nobody expects
     would hang until `waitMs`. Only an explicit `SessionStart` makes the session interactive again. The daemon
     remembers the last 256 ended sessions (session id → Claude pid) in memory; after a daemon restart the list is
     empty and the lazy rule above applies.
     This is for agents with one session per process (Claude Code). A Codex `SessionEnd` never marks a thread ended —
     a tool command of another thread in the same process could send it; a really closed thread drops its
     `thread-writer-locks` lock, and its later hooks fail the session proof instead.
   - `SessionEnd`/`Stop`/`PermissionRequest` with a `session_id` bound to another pid — `{}` and a
     `hook-foreign-session` record: one session's hook neither removes nor replaces another session's cards.
   - `SessionEnd` → drop interactivity and cards. `Stop` → drop the session's cards. Not so for a process that hosts
     many sessions (Codex, `oneSessionPerProcess: false`): see [One process, many threads](#one-process-many-threads).
   - `UserPromptSubmit` → the same lazy registration as below, for agents that send `SessionStart` late (Codex sends
     it with the first turn): never for an ended session.
   - `PermissionRequest` → `{}` immediately if: paused by a limit; the session has ended (`SessionEnd` from this
     process, see above); the session is not interactive (no SessionStart,
     another pid, the process died, the pid was reused — the start time changed, the signature failed);
     the tool is in `skipTools` (`ExitPlanMode`); `tool_input` is not an object; more than `maxRequestsPerMinute`
     requests from the session within a minute; `maxPending` cards are already waiting (or `maxPendingPerProcess`
     from one process that hosts many sessions — Codex); an unknown AskUserQuestion
     shape; a question for an agent that cannot take answers (Codex, `no-questions`). Otherwise a card is created and
     the hook waits for a decision for at most `waitMs` (Codex — `codexWaitMs`).
4. **Card removal** (the hook gets `{}`): timeout; a repeated identical request (dedup by
   session + agent_id + tool + `tool_input`); `Stop`/`SessionEnd`; the session status in the registry was `waiting`
   and changed (answered in the terminal or via Remote Control); hub pause (estop); answer pause; the hook connection
   dropped (`signal` from the core); the service stopped. For Codex neither `Stop`/`SessionEnd` nor a repeated request
   remove a card whose hook is still connected (see [One process, many threads](#one-process-many-threads)).

### Daemon stopped or unavailable (checked 2026-11-06)

The hub is not a required participant: without the daemon Claude Code works as if there were no hook.

- **The daemon stops normally** (the app quit and sent `POST /shutdown`, or SIGTERM): the server closes connections
  and removes the socket. A pending `PermissionRequest` loses its connection — `agenthub-hook` prints `{}` right away
  and exits with code 0, Claude Code shows its usual permission dialog in the terminal (test
  `daemon/test/app-lifecycle.test.mjs`: the hook answers in under 3 s after `/shutdown`, not after 118 s).
- **No daemon** (no socket): `{}` immediately, without trying to connect (`AGENTHUB_HOOK_DEBUG=1` → "daemon is not running");
  the same test — under 2 s including node startup.
- **The socket remains but the daemon crashed** (`ECONNREFUSED`): `{}` immediately ("socket: ECONNREFUSED").
- **The daemon hangs** (accepts but stays silent): `{}` on the hook timeout — 123 s for `PermissionRequest`, 5 s for
  the rest (`AGENTHUB_HOOK_TIMEOUT_MS`).

## Cards — for the app

`GET /hook/cards` — **app only** (questions contain conversation content):

```jsonc
{ "cards": [{
    "requestId": "9f…32 hex", "sessionId": "…", "sessionName": "…|null", "surfaceId": "…|null",
    "agent": "claude" | "codex", "agentLabel": "Claude Code" | "Codex",   // the verified signature, for the badge
    "claudePid": 2220,              // Claude Code; other agents — "agentPid"
    "external": false,              // the session is one of /state.externalSessions (Codex), not the Claude registry
    "subagent": false,
    "kind": "permission" | "question",
    "tool": "Bash", "summary": "Bash: git",         // command name or path, no body
    "questions": null | [{ "question": "…", "header": "…", "multiSelect": false,
                           "options": [{ "label": "…", "description": "…|null" }] }],
    "decisions": ["once", "deny", "terminal"] | ["answer", "deny", "terminal"],   // the buttons to draw
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
    "decision": "once" | "deny" | "answer" | "terminal",
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
`terminal` → `{}` (no decision: the card goes away with reason `terminal`, Codex shows its own approval prompt, Claude
Code keeps the dialog it already shows; not counted as an approval);
`answer` → `allow` + `updatedInput` = the original `tool_input` (the same `questions`) + `answers: {<question text>: <label>}`,
for multiSelect the labels are joined with `", "`. `updatedPermissions`, "always", bypass and `setMode` cannot be
expressed at all.

The second line of defense is `agenthub-hook` itself: it passes `updatedInput` only for `AskUserQuestion` and only if
everything except `answers` matches the original `tool_input` (deep comparison), and `answers` are strings. Any other
`updatedInput` (for example, a replaced Bash command from a foreign process on `hub.sock`) becomes `{}`.

## Settings (`config.json` → `services.hook`)

| Key | Default | |
|---|---|---|
| `waitMs` | 110000 | how long a Claude Code card waits; less than the hook timeout (123 s) and the `timeout` in hooks.json (125 s) |
| `codexWaitMs` | 120000 | how long a Codex card waits (Codex's own prompt appears only after the hook) |
| `codexModes` | `["tui", "daemon"]` | which Codex launches get cards: `tui`, `daemon` (the shared app-server), `exec`, `app-server` (stdio — IDE, desktop app), `other` |
| `maxApprovalsPerMinute` | 10 | approvals (once/answer) across all sessions within a sliding minute |
| `pauseMs` | 600000 | pause after the limit is exceeded |
| `maxRequestsPerMinute` | 30 | requests from one session per minute |
| `maxPending` | 32 | cards waiting at the same time |
| `maxPendingPerProcess` | 8 | cards waiting at the same time from one process that hosts many sessions (Codex) |
| `interactiveKinds` / `interactiveEntrypoints` | `["interactive"]` / `["cli"]` | the interactivity rule (check in stage 0, item (e)) |
| `skipTools` | `["ExitPlanMode"]` | no card is created for these tools |
| `sweepMs` | 30000 | check whether interactive sessions are alive |

## Journal (metadata only)

`hook-session` (sessionId, claudePid — or agent + agentPid for Codex, interactive, reason, kind, entrypoint or mode,
source; a lazy check that finds the session non-interactive again with the same pid and reason — every prompt of
`claude -p` — is not journaled again), `hook-session-end`,
`hook-card` (request — a **hash** of requestId, sessionId, **claudePid** / agentKind + agentPid of the verified ancestor,
kind, tool; `agent` here is true for a subagent's request, as before),
`hook-answer` (decision, appPid), `hook-cancel` (reason), `hook-skip` (reason), `hook-paused`, `hook-foreign-session`.
`hook-skip` reasons — why a `PermissionRequest` got `{}` without a card: `paused`, `session-ended` (the session's
`SessionEnd` was already seen from this process — no lazy registration), `not-interactive`, `skip-tool`, `bad-input`,
`rate` (`maxRequestsPerMinute`), `bad-questions` (an unknown AskUserQuestion shape), `no-questions` (a question for
an agent without answers), `too-many` (`maxPending`), `too-many-process` (`maxPendingPerProcess`),
`hook-gone` (the hook closed the connection before the card was created).
`GET /journal` is open to cli too, so requestId itself is never written to the journal. `tool_input`, paths, commands,
questions — never.

## What the core provides

- `core.handleHook` calls handlers as `h(body, {peer, signal})`; `signal` is an `AbortSignal` that fires when
  `agenthub-hook` closed the connection before the answer (Claude killed the hook — for example, it was answered in
  the terminal). The service removes the card with reason `hook-gone` right away instead of waiting for the timeout.
- `peer.hookPaths` includes `<repo>/claude-plugin/hook/agenthub-hook`, `~/.claude/plugins/**/agenthub-hook` and
  `~/.codex/plugins/**/agenthub-hook` by default, so `claude --plugin-dir <repo>/claude-plugin` and an installed
  plugin (Claude Code or Codex) work without editing `config.json`.
- `GET /state` contains no cards; `GET /hook/cards` + SSE is enough for the app.
- `GET /state` → `hook: {installed, lastEventAt, reason?, installCommand}` — whether a verified hook event has ever reached this hub
  and when the last one did (`daemon/lib/hook/seen.mjs`, kept in `<home>/hook-seen.json`). The core records it for
  every event that reaches `core.handleHook`, with or without the hook service and during a hub pause. It is the only
  sign of an installed hook the hub has: it does not read Claude Code's settings. `installed: false` comes with
  `reason: "no-events"` — see [`api.md`](api.md), `GET /state`. `installCommand` is the permanent install of
  [`claude-plugin/README.md`](../claude-plugin/README.md) as one line (`HOOK_INSTALL_COMMAND`; a test keeps the two in
  step), for a client to show.

## Codex CLI

The same plugin and the same `agenthub-hook` serve Codex CLI (checked with 0.159.3, source tag `rust-v0.159.3`). Codex
reads Claude-style plugin manifests, `.claude-plugin/marketplace.json` and `hooks/hooks.json`, and runs a hook as
`$SHELL -lc "<command>"` in a new session (setsid: no controlling terminal) with the codex process that hosts the
thread as its parent.

### Install

```sh
codex plugin marketplace add KenseiTheOne/agent-hub     # or a local clone: ~/path/to/agent-hub
codex plugin add agent-hub@agent-hub
```

The plugin lands in `~/.codex/plugins/cache/agent-hub/agent-hub/<version>/` (already in `peer.hookPaths`). **Trust
step:** Codex runs a plugin's hooks only after the user trusts them — the next `codex` start shows "Hooks need review"
(review / trust all / continue without). Codex keeps the hash of the trusted hook configuration in
`~/.codex/config.toml` (`[hooks.state]`); a plugin update that changes `hooks.json` changes the hash and Codex asks
again. Until then the hooks do not run and Codex works as without the hub. The hub never writes Codex settings.

`hooks.json` is shared by both agents: `PermissionRequest` (timeout 125 s), `SessionStart`, `UserPromptSubmit`,
`SessionEnd` and `Stop` (async). Codex runs `SessionEnd` synchronously whatever the file says and clamps it to 3 s
(`hooks/src/engine/discovery.rs`), so its timeout is 3 s and the hook gives it 2.5 s; for Claude Code it stays async and
never delays the exit.

### How a Codex request differs

- **Order.** Codex asks the hooks first and shows its own approval prompt only if no hook decided
  (`core/src/tools/approvals.rs`): there is no race with the terminal. While a card is open the Codex terminal waits;
  "Decide in terminal" (`decision: "terminal"`), the card timing out (`codexWaitMs`, 120 s) or the hub being down hand
  the request back to Codex's own prompt (or to `auto_review` when it is configured).
- **Answers.** Allow / deny only. Codex rejects `updatedInput` and `updatedPermissions` in a `PermissionRequest`
  answer (the decision is dropped), so there are no question cards (`hook-skip no-questions`) and no "always".
- **What is asked.** `tool_name` / `tool_input` as Codex sends them: `Bash` `{command, description?}` (summary — the
  command name; a network request comes as `Bash` with `description: "network-access <target>"`, summary
  `Network: <host>`), `apply_patch` `{command: <patch>}` (summary — the file names from the patch headers, never the
  patch), `mcp__<server>__<tool>` (the tool name), `request_permissions` `{reason, permissions}` (summary — the
  permission keys), `write_stdin` (summary — "Input to a process terminal").
- **Sessions.** `session_id` is the Codex thread id (a lowercase UUID; any other spelling is refused). `SessionStart`
  comes with the first turn, not at launch; `UserPromptSubmit` registers the session as well. One codex process may
  host many threads (the shared app-server daemon), so a new `session_id` from the same pid does not replace the old
  one. Codex sessions are not in the Claude
  Code registry: the hook service keeps them by `session_id`. When a trusted plugin reports the same session in
  `/state.externalSessions` (`agentSession=<thread id> … agent=codex`), the card is marked `external: true` and the
  app takes "Go to tab" and the waiting glyph from that row.

### Codex session proof

1. **The ancestor** passes `requirements.codex` (`identifier "codex" and anchor apple generic and certificate
   leaf[subject.OU] = "2DC432GLL2"` — the Homebrew/npm `codex` binary signed by OpenAI).
2. **The thread lock.** The process that writes a thread's rollout keeps
   `$CODEX_HOME/thread-writer-locks/<thread id>.lock` open and flock-ed for the thread's lifetime
   (`rollout/src/writer_lock.rs`). The core asks `lsof -Fp` who has that file open and requires the verified ancestor
   among them. It never takes or probes the lock itself (that could break the writer). lsof on macOS does not show
   flock state, so "open by the ancestor" stands for "held". A positive answer is cached for 30 s
   (`peer.hookSessionCacheMs`) — but not for a launch that hosts several conversations at once (`daemon`,
   `app-server`; `sharedProcess` in `agents.mjs`): Codex briefly opens other threads' locks while it takes its own
   (`writer_lock.rs`: the stale-lock sweep, the publication probe), and a thread closed there would stay accepted until
   the entry expired.
3. **The rollout.** `transcript_path` (forwarded by `agenthub-hook` only in this shape) after resolving symlinks lies
   inside `$CODEX_HOME/sessions/` and is named `rollout-<timestamp>-<thread id>.jsonl[.zst]`. The hub never reads it.
   It is checked **by name only**: a hard link to the file elsewhere is not detected (a symlink is). That is the same
   trust level as `~/.claude/sessions/<pid>.json` for Claude Code: the agent's own home, writable by any process of
   the user; the lock held by the signed ancestor is what carries the proof.
4. **Subagents.** Codex gives a thread-spawn subagent's hooks the **root** thread's id as `session_id` (one session
   identity for the root and its descendants, `core/src/session/session.rs`), the subagent's own thread id as
   `agent_id` and the subagent's rollout as `transcript_path` (`core/src/hook_runtime.rs`). Such a hook passes when
   the subagent's lock and rollout pass 2–3 and the root thread's lock is open in the same ancestor as well; the card
   then belongs to the root session and is marked `subagent`. When the root's lock is not there (an ephemeral root,
   another process) — 403, and Codex asks in its terminal as without the hub. Other subagents (review, compaction,
   guardian) send no `agent_id` and their rollout does not match the root's id — the same 403.

`$CODEX_HOME` is `config.codexHome` (`~/.codex`; the `AGENTHUB_CODEX_HOME` variable overrides it, for tests).
A custom `CODEX_HOME` or `sqlite_home` of the user's Codex is not followed: the proof then finds no lock
(403 → Codex's own prompt), and the plugin linter's forbidden paths (`registry/perms.mjs`: conversations, rollouts,
the state databases) cover only the default `~/.codex` — a plugin that reads a relocated Codex home is not flagged.

`$CODEX_HOME` is `config.codexHome` (`~/.codex`; the `AGENTHUB_CODEX_HOME` variable overrides it, for tests).

### Which Codex launches get cards

From the ancestor's argv (`codexMode` in `agents.mjs`), filtered by `services.hook.codexModes`:

| Mode | argv | Default |
|---|---|---|
| `tui` | `codex [PROMPT]`, `codex resume`, `codex fork` — must have a controlling terminal | yes |
| `daemon` | `codex app-server [--remote-control] --listen unix:// [-c …]` — exactly `unix://`, the default control socket (`app-server-daemon/src/backend/pid.rs`); a listener on any other path is `app-server` — the shared app-server daemon a default TUI starts (`tui/src/startup_orchestration.rs`, feature `daemon_auto_start`, on by default) and hosts its threads in; it runs under setsid without a terminal | yes |
| `exec` | `codex exec`, `codex e` — no human at the terminal | no |
| `app-server` | `codex app-server` on stdio or another transport (IDE extensions, the desktop app) | no |
| `other` | any other subcommand | no |

A default `codex` TUI hosts its threads in the shared daemon, so the hook's verified ancestor is that daemon. A TUI with
`-c` overrides, `--profile`, `--no-daemon`, `--dangerously-bypass-hook-trust` and the like (`tui/src/daemon_startup.rs`)
hosts them in-process, and the ancestor is the TUI itself. `codex exec` never uses the daemon and is off by default;
tests turn it on with `"codexModes": ["tui", "daemon", "exec"]`.

### One process, many threads

The shared daemon hosts the threads of every TUI attached to it, and even a TUI hosts its subagents' threads. Any tool
command under such a process can run `agenthub-hook` itself with the id and rollout of another thread of the same
process and pass the proof — the same pid holds both locks. The agent table marks such agents
`oneSessionPerProcess: false`, and the hook service then:

- lets `Stop` cancel nothing and `SessionEnd` only forget a session that has no pending cards, never marking it as
  ended: a pending Codex card goes away when its own hook connection closes (`hook-gone` — Codex kills the hook's
  process group when the turn is interrupted, the thread shuts down or the hook times out:
  `hooks/src/engine/command_runner.rs`, test `cancelled_and_timed_out_hooks_kill_their_process_group`) or at
  `codexWaitMs`. After a real `SessionEnd` the thread's lock is gone, so the thread's later hooks fail the proof anyway;
- never replaces a pending card by an identical request from another connection (`superseded` only when the old
  card's hook is already gone);
- allows at most `maxPendingPerProcess` (8) pending cards per process, on top of `maxPending`.

**Residual risk.** Within one shared Codex daemon a tool command of thread A can still raise a card labelled as thread
B (B's name, B's tab). The answer goes to the hook that asked — A's command — never to B; it can only make a human
answer a request that looks like B's, the same as the Claude Code limit for its own session.
