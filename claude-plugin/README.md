# Claude Code and Codex plugin `agent-hub`

Connects Claude Code and Codex CLI sessions to Agent Hub (the macOS menu bar icon):

- **PermissionRequest** → `hook/agenthub-hook` forwards the request to the hub daemon over the Unix socket
  `~/Library/Application Support/AgentHub/hub.sock` and waits for the decision on the hub card (at most ~2 min):
  "Allow once", "Deny", "Decide in terminal" or an AskUserQuestion option (Claude Code only). In Claude Code the
  terminal and Remote Control answer as usual — the first answer wins. Codex shows its own approval prompt only after
  the hook: "Decide in terminal" (or the card timing out) hands the request back to it.
- **SessionStart / UserPromptSubmit / SessionEnd / Stop** (async; Codex always runs SessionEnd synchronously, for at
  most 3 s) — register interactive sessions and clear cards.

The hook breaks nothing when the hub is absent: the daemon is not running, the session is not interactive
(`claude -p`, `codex exec`, a runner), timeout, ESTOP — it prints `{}` and the agent behaves as if there were no hook.
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

### Codex CLI

The same repository is a Codex plugin marketplace too (Codex reads `.claude-plugin/marketplace.json` and the plugin's
`hooks/hooks.json`):

```sh
codex plugin marketplace add KenseiTheOne/agent-hub     # or a local clone: ~/path/to/agent-hub
codex plugin add agent-hub@agent-hub
```

Codex runs a plugin's hooks only after you trust them: the next `codex` start shows **"Hooks need review"** — review
the five `agenthub-hook` entries and trust them (Codex stores a hash of the hook configuration in `~/.codex/config.toml`
under `[hooks.state]`). A plugin update that changes `hooks.json` changes that hash, and Codex asks again. Until then
the hooks do not run and Codex works as without the hub.

## Requirements

- `node` in the `PATH` of the agent session (the hook is dependency-free Node; `NODE_OPTIONS` is cleared in `#!`; Codex
  runs hooks through your login shell, `$SHELL -lc`).
- The `agenthubd` daemon with the `hook` service. The paths `~/.claude/plugins/**/agenthub-hook`,
  `~/.codex/plugins/**/agenthub-hook` (an installed plugin) and
  `<hub>/Versions/current/src/claude-plugin/hook/agenthub-hook` are already in the daemon's `peer.hookPaths`; for
  `--plugin-dir` from another folder, add its `…/claude-plugin/hook/agenthub-hook` to `config.json` → `peer.hookPaths`.

`hook/agenthub-hook` is a copy of `../hook/agenthub-hook` (the test `daemon/test/hook-script.test.mjs` compares them).
