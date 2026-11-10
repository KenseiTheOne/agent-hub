# cmux bridge and actions (stage 5)

The bridge is a small process that lives in a **pinned cmux tab** and runs allowlisted cmux operations for the daemon
(three since stage 5; `read-screen` and `send-text` since contract 3, for the terminal layer and the `/terminal/*`
routes of trusted plugins). Inside a cmux tab it legitimately inherits access to the cmux socket; the daemon itself
neither has nor gets that access. The daemon recognizes the bridge by its script path (`peer.bridgePaths`, by default
`<repo>/bridge/agenthub-bridge.mjs`) — peer class `bridge`, which may use only the `/bridge/*` routes.

## Running

```sh
# in a separate cmux tab that you then pin (tab-action pin)
~/path/to/agent-hub/bridge/agenthub-bridge
```

`agenthub-bridge` clears `NODE_OPTIONS` (the cmux preload crashes child node processes) and starts
`agenthub-bridge.mjs`. Environment: `AGENTHUB_HOME` — the daemon directory (same as for `agenthubd`, by default
`~/Library/Application Support/AgentHub`), `AGENTHUB_CMUX` — absolute path to the cmux CLI (by default
`/Applications/cmux.app/Contents/Resources/bin/cmux`). The bridge never prints or sends environment values.
Stop it with Ctrl-C (the bridge tells the daemon `bye`). A second bridge started while the first is alive gets
`409 bridge:busy` and waits.

## Allowlist

| Operation | cmux commands |
|---|---|
| `surface.focus` | `select-workspace --workspace W`, then `focus-panel --panel S --workspace W` |
| `send-key` | `send-key --workspace W --surface S escape` — `escape` only |
| `new-workspace` | `new-workspace --name N --cwd D --command '<bridge/launch.sh>' '<uuid>' '<N>' '<prompt file>'` |
| `read-screen` (contract 3) | `read-screen --workspace W --surface S` — visible screen only, without `--scrollback` or `--lines`; the daemon receives only input-field flags `{promptFound, promptEmpty, busy}` computed from the last N ≤ 30 lines, **never the text** |
| `send-text` (contract 3) | `read-screen` → field found, empty, no turn running → `send --workspace W --surface S -- <line>` → `read-screen` → the field contains exactly that line → `send-key --workspace W --surface S enter` |

- The tab and workspace are **always passed explicitly**; `CMUX_SURFACE_ID`, `CMUX_PANEL_ID`, `CMUX_TAB_ID` are removed
  from the child cmux environment, so a missing flag cannot land in the bridge's own tab.
- An extra field in an operation, another key, another operation → `not-allowed` / `bad-*`, cmux is not called.
- An operation with an expired `expiresAt` is not run (`expired`): the daemon drops an operation that was not picked up
  within `pickupMs` (5 s), so Esc cannot be pressed later during someone else's turn.
- `read-screen` / `send-text`: the Claude Code input field is a line with `>` or `❯` right under a `─` rule, plus the
  lines up to the next rule (the older `│ … │` frame too); a turn is running when "esc to interrupt" is outside the
  field. `send-text` refusals: `prompt-not-found`, `prompt-not-empty` (a human draft is never touched), `session-busy`,
  `prompt-mismatch` (after typing, the field does not hold exactly that line — someone was typing at the same time;
  Enter is not pressed, the typed text stays in the field). The faint placeholder of an empty field ("Try "…"") cannot
  be told apart from typed text on a text screen: in that case the field counts as non-empty — a refusal rather than
  typing. The line is printable ASCII without `\` (cmux `send` treats `\n`, `\r`, `\t` as Enter and Tab), without
  leading or trailing spaces, 1…200 characters; Enter is pressed only as a key after the check (`send-key` still allows
  only `escape`). Neither the screen text nor the line ends up in the result, in the bridge's stderr or in the daemon
  journal (`bridge-op` is metadata only).
- `new-workspace`: the name is letters/digits, space, `. _ ( ) -`; the prompt file is exactly
  `<AGENTHUB_HOME>/launch/<uuid>.prompt`, a regular file, owned by the user, mode 0600. The bridge builds the tab
  command only from these values; it does not accept arbitrary command text.

## launch.sh

`launch.sh <uuid> <name> <prompt file>` is the first command of a new tab. It checks the uuid, the file name
(`<uuid>.prompt`), the owner and mode 0600; reads the prompt and **deletes the file right away**; then
`exec claude --session-id <uuid> --remote-control -n <name> -- <prompt>` (without a prompt — without the last
argument). `claude` comes from the tab's PATH — that is the cmux shim with its hooks, so the session appears in
`~/.cmuxterm/claude-hook-sessions.json`. No `--allow-dangerously-skip-permissions`.

## Protocol (HTTP on `hub.sock`, `bridge` class only)

| Route | What |
|---|---|
| `POST /bridge/hello` `{version}` | registration; `409 bridge:busy` if another bridge is alive |
| `GET /bridge/next?wait=<ms≤25000>` | long poll: `200 {op}` or `204`; `409 bridge:not-registered` — say hello again |
| `POST /bridge/result/:id` `{ok, code, error?, workspaceId?, promptFound?, promptEmpty?, busy?}` | result (metadata only; field flags only for `read-screen`/`send-text`, booleans only) |
| `POST /bridge/bye` | disconnect |

The bridge counts as connected while it keeps polling (`staleMs` 40 s). The daemon writes every operation to the
journal (`bridge-op`: op, opId, surfaceId, workspaceId, sessionId, ok, code, error, ms) and to the bus (`bridge.op`);
connecting is `bridge-hello` / `bridge.connected`, disconnecting is `bridge-bye` / `bridge.disconnected`.
The channel and facts (`actions.config`, `bridge.channel`, `bridge.online`) are held by the
`daemon/lib/services/actions.mjs` service, the routes by `daemon/lib/routes/bridge.mjs`.

## Action primitives

All except `session.focus` and `cmux.focus` are accepted **only from `app`** and only with a confirmation (by the core).
Before running, the core calls `verifyFacts`; facts that do not match give `409 facts:<reason>`. Checks that could have
gone stale while the confirmation was open (the turn ended, a scheduled run started) are repeated right before running.

| Primitive | Level | remoteAllowed | What it does | 409 reasons |
|---|---|---|---|---|
| `session.focus sessionId` | immediate (for cli and third-party plugins too) | no | the core terminal layer finds the session tab; the cmux adapter uses bridge `surface.focus` | `unknown-session`, `no-terminal`, `pid-mismatch`, `focus-unsupported`, `bridge-offline` |
| `cmux.focus surfaceId [workspaceId]` | immediate (for cli and third-party plugins too); kept for compatibility — new plugins use `session.focus` | no | bridge: switch to the tab | `bridge-offline`, `unknown-surface`, `workspace-mismatch` |
| `session.interrupt sessionId` | confirmation | yes | bridge: Esc in the session tab | `unknown-session`, `bridge-offline`, `no-cmux-session`, `pid-mismatch`, `not-running`, `no-surface` |
| `session.stop sessionId` | confirmation | yes | `kill -TERM <pid>` | `unknown-session`, `no-start`, `session-file-mismatch`, `non-interactive`, `proc-start-mismatch`; at run time — `pid-reused`, `signature:*` (ok:false) |
| `session.launch cwd name [prompt]` | priced | no | bridge: new tab + `launch.sh` | `bad-name`, `bad-cwd`, `forbidden-cwd`, `bridge-offline`; for a plugin offer — `offer-not-allowed` (the core passes the plugin id to `verifyFacts`, refusal comes before the confirmation window) |

The shared reason `actions-off` means the `actions` service is not running (fail closed, not open).

## Terminal for plugins (contract 3)

`read-screen` and `send-text` are not primitives: they are called by the terminal layer (`daemon/lib/terminals/`,
adapter `cmux.mjs`) from the `terminal` service through the `POST /terminal/read-screen` and `POST /terminal/send-text`
routes, which are available only to a trusted plugin process (a run, streamable or action) with the
`<agenthub.terminal>` permission ([`docs/extension-points.md`](../docs/extension-points.md), "Contract 3"). The session
tab comes from `claude-hook-sessions.json` (the same record for the same pid and start time as in the core registry);
whether the session is free comes from the Claude Code status in the core registry, and without it from
`agentLifecycle: idle`; the Claude Code process must not be stopped and must be in the foreground of its terminal. For
`send-text` the daemon sets an `enterBy` deadline: after it the bridge does not press Enter (`deadline`) — the daemon
has already answered the plugin. An old bridge (without these operations) answers `not-allowed` → the plugin gets
`501 terminal:bridge-outdated`: restart the bridge.

Text for the shell: `facts:bridge-offline` — "the cmux bridge is not running".

Controlling third-party tools (Hermes, a runner) is not among the primitives (decision 2026-11-04): those are declared
`<agenthub.action>` actions of official plugins (registry `agent-hub-plugins`, see their READMEs).

**remoteAllowed.** There are no remote action channels in v1 (Telegram only calls you). The flag separates in advance
"stopping" actions (interrupt a turn, stop a session, stop a run, skip a task — yes) from actions that start spending or
reach outside (launching a session — only from the Mac, design §5).

## Settings (`<AgentHub>/config.json`)

```jsonc
{
  "actions": {
    "cmuxHookSessions": "~/.cmuxterm/claude-hook-sessions.json",
    "launch": { "registerTimeoutMs": 60000, "pollMs": 500 }
  },
  "services": { "actions": { "pickupMs": 5000, "resultMs": 15000, "staleMs": 40000, "maxWaitMs": 25000 } }
}
```

Only the needed fields are taken from other programs' files: from `claude-hook-sessions.json` — sessionId, pid,
surfaceId, workspaceId, agentLifecycle (not `lastBody`); from `~/.claude/sessions/<pid>.json` — sessionId, pid, kind,
procStart.

## Tests

`env -u NODE_OPTIONS node --test test/actions-*.test.mjs` in `daemon/`: doubles for processes and signatures, a bridge
double, doubles for the cmux CLI and `claude`; no external programs are run (`AGENTHUB_TEST_EXEC_LOG`). The end-to-end
test starts a real bridge process on the test daemon's socket.
