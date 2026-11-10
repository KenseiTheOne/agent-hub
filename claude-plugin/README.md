# Claude Code plugin `agent-hub`

Connects Claude Code sessions to Agent Hub (the macOS menu bar icon):

- **PermissionRequest** → `hook/agenthub-hook` forwards the request to the hub daemon over the Unix socket
  `~/Library/Application Support/AgentHub/hub.sock` and waits for the decision on the hub card (at most ~2 min):
  "Allow once", "Deny" or an AskUserQuestion option. The terminal and Remote Control
  answer as usual — the first answer wins.
- **SessionStart / SessionEnd / Stop** (async) — registers interactive sessions and clears cards.

The hook breaks nothing when the hub is absent: the daemon is not running, the session is not interactive
(`claude -p`, a runner), timeout, ESTOP — it prints `{}` and Claude Code behaves as if there were no hook.
`onFailure: block` is not used. No "always", `updatedPermissions`, bypass or `setMode`: the hook passes through only a
narrow answer, even if the daemon sent more.

Protocol details: [`../docs/hook.md`](../docs/hook.md).

## Installation (done by the user)

Installing changes `~/.claude/plugins`; if you run unattended tools that check the integrity of that folder,
install between their runs.

To use it without installing anything — per session, from the installed hub (`<hub>` is
`~/Library/Application Support/AgentHub`):

```sh
claude --plugin-dir "$HOME/Library/Application Support/AgentHub/Versions/current/src/claude-plugin"
```

This path survives hub updates, and the daemon already trusts the hook there (it is in the default `peer.hookPaths`). A
shell alias makes it permanent for your sessions. From a clone of this repository, `claude --plugin-dir
~/path/to/agent-hub/claude-plugin` works the same way.

Permanently — as a plugin from this repository, which is also a Claude Code marketplace
(`.claude-plugin/marketplace.json`):

```sh
claude plugin marketplace add KenseiTheOne/agent-hub     # or a local clone: ~/path/to/agent-hub
claude plugin install agent-hub@agent-hub
```

## Requirements

- `node` in the `PATH` of the Claude Code session (the hook is dependency-free Node; `NODE_OPTIONS` is cleared in `#!`).
- The `agenthubd` daemon with the `hook` service. The path `~/.claude/plugins/**/agenthub-hook` (an installed plugin) and
  `<hub>/Versions/current/src/claude-plugin/hook/agenthub-hook` are already in the daemon's `peer.hookPaths`; for
  `--plugin-dir` from another folder, add its `…/claude-plugin/hook/agenthub-hook` to `config.json` → `peer.hookPaths`.

`hook/agenthub-hook` is a copy of `../hook/agenthub-hook` (the test `daemon/test/hook-script.test.mjs` compares them).
