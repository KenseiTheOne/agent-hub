# Agent Hub — project rules

## Hub and plugins are separate

The hub (daemon `daemon/`, shell `app/`, CLI) is a generic engine. It knows nothing about any specific plugin.

- **The core and the shell contain no names or logic of specific plugins.** No "Night", "Hermes", "ClickUp",
  "Background agents" in texts, settings, notification kinds, hints or code branches. If the hub needs to show something
  about a plugin (a notification kind, a verdict line, a dependency, an icon), the plugin declares it itself in its
  metadata or output, and the hub builds the UI from what was declared: no plugin — no line.
- **The exception is built-in plugins** (`plugins/`: Claude Code sessions, background agents, quota): they are part of
  the hub, but wherever possible the hub sees them through the same contract too, not through special branches.
- **Official plugins** live in a separate repository, [`agent-hub-plugins`](https://github.com/KenseiTheOne/agent-hub-plugins); **own** plugins (for example,
  a runner plugin) live in their tools' repositories (`agenthub/<id>/`) and are installed from a local folder.
- **A new plugin capability = an extension of the contract** ([`docs/extension-points.md`](docs/extension-points.md)),
  not a core change made for one plugin. First the contract and its tests in the hub, then its use in the plugin.
- **Separate sessions where possible**: work on the hub and work on a plugin go separately. If they did get mixed in one
  session, before committing check the core diff for plugin names (`grep -rn` over `daemon/lib`, `app/Sources`) and
  move whatever you find into the plugin's metadata.

## Other

- After code changes, restart the live daemon and shell (`scripts/bundle.sh --pin-live`, `agenthub builtin update`,
  `launchctl kickstart -k gui/$(id -u)/com.kensei.agenthub`) so the changes are visible right away.
- Commits, pushes, tags and publishing to the registry happen only on an explicit command.
