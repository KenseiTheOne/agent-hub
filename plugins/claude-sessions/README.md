# claude-sessions

Built-in Agent Hub plugin (`streamable`). Read-only.

**Sources.** `claude agents --json` every 2 s is the source of truth (`pid, sessionId, name, cwd, kind, status
busy|waiting|idle, waitingFor`). `~/.claude/sessions/<pid>.json` is a hint: `procStart` to verify the pid,
`statusUpdatedAt` for "waiting N min", and sessions missing from agents (`status: "shell"` is shown as is and is not
passed to the core as a status). `*.key` files are never opened. `~/.cmuxterm/claude-hook-sessions.json` binds a
session to a tab: `surfaceId`, `workspaceId`, `agentLifecycle`, `pidStartSeconds`; text fields are not used.
On `fileChanged`/`refresh` from stdin the plugin polls immediately.

**Effort of the last turn.** Transcript `~/.claude/projects/<folder>/<sessionId>.jsonl` (the folder is the cwd with
every non-alphanumeric character replaced by "-"; otherwise the folders are searched every 30 s). Only the tail is
read: up to 512 KB from the end (up to 2 MB if it contains no turn — for example, one huge tool_result line — or no
ultracode marker), and when the file has only grown, just the appended part (up to 2 MB). The level comes from the
last turn record — `assistant` (not API errors, not sidechain) or `api-request`:
`perTurnEffort` ?? `effort` or `params.output_config.effort`; if the field is missing or the value is unknown, there
is no level, and earlier turns are not substituted. Claude Code writes ultracode markers (`attachment.type` =
`ultra_effort_enter` / `ultra_effort_exit`) only when the state changes, so the state carries over until the appended
part contains a new marker. The result survives a plugin restart (language change, daemon restart,
`builtin update`): `$AGENTHUB_PLUGIN_DATA_PATH/effort.json` (0600) holds the session id, transcript path, its
size/mtime, the level, ultracode and the turn time; it is rewritten only when the result changes. Message text is
never extracted or printed. Cache key: the file's (size, mtime). The session line carries
`sessionEffort=low|medium|high|xhigh|max` and `sessionUltracode=true|false`; for an idle session the value may be
stale (it is the level of the last turn).

**Model and the `/model`, `/effort` commands (0.5.0, contract 3).** From the same tail: the model of the last
`assistant` record (`message.model`, otherwise `requestedModel`; `<synthetic>` and anything that does not look like
a model is skipped). If the transcript contains local command output after the turn — a `user` record whose content
is a string starting with (or a `system` record with `subtype: "local_command"` and such a string in `content`: this
is how Claude Code 2.1.3xx writes "Kept model as")
`<local-command-stdout>Set model to `<x>`` (or `Kept model as `<x>``) or `<local-command-stdout>Set effort level to <level>`
— the command wins: for an idle session the turn may predate it. Tool output with such text (an array, not a
string), subagents (sidechain) and message text do not count as commands; only that line is taken from a command
record. The session line carries `sessionModel="…"`, `sessionModelSource=turn|command`, `sessionEffortSource=turn|command` and
`sessionAt=<time of the newest of these records>`; the core puts them into the session registry, and the `sessions`
service writes them to `Cache/claude-sessions.json` for trusted plugins (`AGENTHUB_CLAUDE_SESSIONS_FILE`). The result
cache is version 2 (with the model); a version 1 cache is still read, and the model is found by the next tail read.
Session details show "Model: …" and "Effort: … (from the last turn | from the /effort command)".

**Where the name comes from (contract 3).** Next to `sessionName="…"` the plugin prints
`sessionNameSource=<nameSource>` from `~/.claude/sessions/<pid>.json` (`derived` — from the folder and branch,
`auto` — a title Claude Code composed from the conversation). The core shows the name as usual, but does not put an
`auto` name into `claude-sessions.json` for plugins (`name: null`): it is derived from conversation text.

**Liveness** — `kill -0` (signal 0, the process receives nothing) plus the start time: `TZ=UTC ps -o lstart` against
`procStart` (Claude Code writes it in UTC — hence the "one hour shift" against a local `ps`; a whole number of hours
of difference counts as the same second) or against cmux's `pidStartSeconds`. A mismatch means the pid was reused.

**Died mid-turn** (`status=wait`, `event=died:<sessionId>`, 30 min; the plugin declares the push rule itself —
`<agenthub.push key="died" kind="plugin" was="runs">`, since 0.4.0, contract 2: its own "Claude Code Sessions" toggle in
"Settings → Notifications"; "Agent runs" that were turned off before 2026-11-09 carry over to it; "waiting for an
answer" `waiting:` uses the core's shared "Sessions waiting for an answer" kind): the session was `busy` and
disappeared with a dead pid; a `busy` session file with a fresh `statusUpdatedAt` and a dead pid; a cmux `running`
record younger than 2 h with a dead pid. Not counted: **a normal exit** — on exit Claude Code removes its own
`~/.claude/sessions/<pid>.json` (a `claude -p` reply, "End session" from the hub, leaving the session), while a
crashed process leaves the file behind; **background runs** — `entrypoint` `sdk-*` (`claude -p` registers with
`kind: interactive`, only `entrypoint` tells it apart): they are labeled "background (claude -p)" and cannot be
interrupted or ended from here; **an old trace** — "busy" was seen more than 2 h ago (memory restored after the hub
was down). Memory (`memory.json`) stores `seenAt` to the minute.

**Output.** The header answers "do I need to do anything": "1 session is waiting for you" (tile "1 waiting",
"2 waiting"), "N sessions broke off", "N working, none waiting", "All idle"; `status=wait` if someone is waiting or
died. A session line carries parameters for the core: `session=<id> pid=<pid> sessionStatus=… waitingFor=… sessionName=…
sessionCwd=… surfaceId=… workspaceId=…` (a `sessionCwd` inside the home folder is shown as `~/…`); a waiting one adds
`event=waiting:<sessionId>`. **Authenticity is checked by the core** (signature `requirements.claudeCode`); a session
that fails gets the label "not Claude Code" and does not enter the registry.

**Broken source** (`agents` is not an array, a record without pid/sessionId/status, an unknown `status`, a session
file without pid/sessionId, cmux without `sessions`) → `status=unknown` + `event=source-broken`. The reason depends on
the failure: claude not found in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` (the plugin PATH is the
standard one); `claude agents --json` did not answer (timeout, exit code); "update Claude Code" — only for an unknown
output shape. If no sessions are visible at all, the reason is in the header (which also carries the event), with
details below. Texts are in the hub language (`AGENTHUB_LANG`).

Tests: `daemon/test/plugins-claude-sessions.test.mjs`; fixtures in `fixtures/` (synthetic).
