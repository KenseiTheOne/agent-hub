# Writing plugins

A practical guide for plugin authors: how to make a plugin, what it can declare and print, what it gets from the hub,
how to test it and how to ship it. It is the "how to" companion to the reference documents, which stay the source of
truth:

- [`extension-points.md`](extension-points.md) — the plugin contract (metadata, output, environment, contract versions);
- [`plugins-registry.md`](plugins-registry.md) — tiers, consent, the registry and own sources;
- [`api.md`](api.md) — the daemon HTTP API (connections, terminal);
- [`daemon/lib/push/README.md`](../daemon/lib/push/README.md) — notification rules.

Everything below matches the code of contract **3** (`CONTRACT_VERSION` in `daemon/lib/meta.mjs`). The built-in plugins
in [`plugins/`](../plugins) (`quota`, `agents`, `claude-sessions`, `spend`) are real, complete examples.

## Contents

1. [Quick start](#1-quick-start)
2. [Anatomy of a plugin](#2-anatomy-of-a-plugin)
3. [Metadata tags](#3-metadata-tags)
4. [Output](#4-output)
5. [Effects and actions](#5-effects-and-actions)
6. [Tiers, permissions and consent](#6-tiers-permissions-and-consent)
7. [Environment](#7-environment)
8. [The hub socket: connections and terminal](#8-the-hub-socket-connections-and-terminal) (MCP 8.2, any HTTPS API 8.3, terminal 8.4)
9. [Notifications](#9-notifications)
10. [Language](#10-language)
11. [Contract versions and compatibility](#11-contract-versions-and-compatibility)
12. [Shipping: own source and the registry](#12-shipping-own-source-and-the-registry)
13. [Checklist before you ship](#13-checklist-before-you-ship)

## 1. Quick start

### 1.1 A first plugin

A plugin is one executable file (or a folder with one) that prints its state to stdout in a SwiftBar-like format. The
hub runs it on a schedule and draws a popover tile and a panel page from what it printed. Save this as
`hello.1m.sh` (`1m` is the run interval):

```sh
#!/bin/sh
# <agenthub.title>Hello</agenthub.title>
# <agenthub.version>0.1.0</agenthub.version>
# <agenthub.desc>Says hello and shows the time of the last run</agenthub.desc>
# <agenthub.author.github>your-login</agenthub.author.github>
# <agenthub.platforms>macos</agenthub.platforms>
# <agenthub.contract>3</agenthub.contract>
# <agenthub.icon symbol="hand.wave" color="#30D158"></agenthub.icon>

now=$(date +%H:%M)
echo "Hello from my first plugin | tile=\"$now\" sfimage=hand.wave"
echo "---"
echo "Last run at $now | sfimage=clock"
echo "Agent Hub docs | href=https://example.com/docs sfimage=book"
```

- The `<agenthub.*>` tags in comments are the plugin's metadata (section 3). The hub reads them from the first 64 KB of
  the file; the comment prefix (`#`, `//`, `--`, `;`) does not matter.
- Everything before the first `---` line is the **header** (the tile and the first line of the plugin page), everything
  after it is the **body**. `Title | key=value …` — the text, then parameters after the last `|` (section 4).

### 1.2 Where to put it

| Where | Tier | When |
|---|---|---|
| `~/Library/Application Support/AgentHub/Plugins/local/` | `local` ("unverified") | trying something out on the live hub: no install step, picked up on the fly |
| a test hub (`AGENTHUB_HOME=<dir>`, below) | `local`; `own` with `AGENTHUB_TEST_TIER=own` | developing without touching your real hub |
| your tool's repository, `agenthub/<id>/`, installed with `agenthub plugins install --from …` | `own` | your own plugin that needs trust: actions, notification rules, hub services ([12.1](#121-own-source)) |
| the registry repository `agent-hub-plugins` | `official` / `community` | a plugin for other people ([12.2](#122-the-registry)) |

A local plugin is the quickest loop, but it is also the most limited tier: effects only `open.*`, no actions, no
secrets, no notification rules, no hub service variables (section 6). Develop the output locally, then move the plugin
to an own source when it needs more.

Copy the file into `Plugins/local/` — a single file or a folder `<id>/` with `<id>.<interval>.<ext>` inside. The
directory is watched; a missed event is caught by the rescan within 60 s. Shell scripts do not need the x bit: the hub
picks the interpreter from the extension.

**A test hub** keeps experiments away from your real state directory. From a clone of the `agent-hub` repository:

```sh
H=$(mktemp -d /tmp/ah-XXXX)                      # short: the socket path must be ≤ 103 bytes
mkdir -p "$H/Plugins/local" && cp hello.1m.sh "$H/Plugins/local/"
printf '{"services":{"push":{"enabled":false}}}\n' > "$H/config.json"   # no notification banners while testing
AGENTHUB_HOME=$H env -u NODE_OPTIONS node daemon/bin/agenthubd &
AGENTHUB_HOME=$H env -u NODE_OPTIONS node daemon/bin/agenthub status
```

`AGENTHUB_SERVICES=none` starts the daemon without services (no push, no registry, no keychain) — enough for a local
plugin. `AGENTHUB_BUILTIN_PLUGINS=<empty dir>` hides the built-in plugins from the test hub. The shell can be pointed at
the same daemon: `AgentHub.app/Contents/MacOS/AgentHub --home $H --open-panel`. Clear `NODE_OPTIONS` if your terminal
sets a preload (cmux does): it crashes child node processes.

**Testing trusted features on a test hub.** Start the daemon with `AGENTHUB_TEST_TIER=own` next to `AGENTHUB_HOME`: every
plugin in `$H/Plugins/local` then runs with the `own` tier — actions, your own `<agenthub.push>` rules, hub service
variables, the session registry (`/state.plugins[].testTier: true` marks it) — and the CLI class (a script, `curl`) may
press its actions without the pinned app, a `confirm` level included (the 428 token is not bound to the requester's
process there), and stop its background jobs (`POST /actions/job.cancel` with `{"args":{"job":"<id>"}}` — the "Stop"
button of the app; jobs of other plugins stay app-only). The variable is honoured only when `AGENTHUB_HOME` points to a directory other than the live state
directory: the live hub never has it.

`AGENTHUB_TEST_EXTENSIONS=1` (also honoured only on a test hub) is the same shortcut for daemon extensions: every file
in `$H/Extensions/{services,routes,primitives,terminals}` counts as approved without the app
([`extension-points.md`](extension-points.md#external-extensions-homeextensions)). It has nothing to do with plugins.

```sh
AGENTHUB_HOME=$H AGENTHUB_TEST_TIER=own env -u NODE_OPTIONS node daemon/bin/agenthubd &
OFFER=$(curl -s --unix-socket $H/hub.sock http://hub/state | jq -r '.plugins[]|select(.id=="hello").body[]|.offer.id // empty' | head -1)
curl -s --unix-socket $H/hub.sock -X POST http://hub/actions/$OFFER -H 'content-type: application/json' -d '{"input":"text"}'
```

### 1.3 See it and debug it

The CLI is not on `PATH`. After the installer it is

```sh
AH="$HOME/Library/Application Support/AgentHub/Versions/current/src/daemon/bin/agenthub"
```

and in a clone `daemon/bin/agenthub` (with `AGENTHUB_HOME=$H` in front for a test hub).

| Command | What it shows |
|---|---|
| `"$AH" status` | every plugin: id, status, age of the last frame, the first header line (or the error) |
| `"$AH" status --json` | the whole `/state`: `tier`, `trusted`, granted `effects` and `actions`, `pushRules`, `icon`, the parsed `header` and `body` with offers |
| `"$AH" refresh <id>` | run the plugin now (`AGENTHUB_REFRESH_REASON=Manual`) |
| `"$AH" logs -n 50` / `-f` | the journal: `plugin-add`, `warning` (output and metadata problems), `plugin-exit`, `plugin-contract-newer`, `connection-rejected`, actions… |
| `"$AH" version` | the hub version and the plugin contract it understands |

In the app the same is on the plugin's page in the panel and in the Journal section.

The journal is where the hub explains what it ignored. For example a plugin that prints `status=maybe`, `bash=…` and
an action it is not allowed gets:

```
warning plugin=broken detail=unknown status "maybe"
warning plugin=broken detail=parameter bash= is forbidden and ignored
warning plugin=broken detail=action=snooze: actions aren't available (local)
```

(warning texts are written in the hub language at the moment of writing — with Russian: «неизвестный status «maybe»»,
«параметр bash= запрещён и проигнорирован»…; switching the language doesn't rewrite older entries). The same warning is
written at most once per 10 minutes.

**Run it by hand with the hub's environment.** The hub starts a plugin with a clean environment (section 7), so test the
same way — a plugin that works only with your shell's variables will fail in the hub:

```sh
mkdir -p /tmp/hello-data
env -i HOME="$HOME" PATH=/usr/bin:/bin AGENTHUB_LANG=en AGENTHUB_PAUSED=0 \
  AGENTHUB_PLUGIN_ID=hello AGENTHUB_PLUGIN_DATA_PATH=/tmp/hello-data AGENTHUB_REFRESH_REASON=Manual \
  sh hello.1m.sh
```

**Typical failures.** Status `error` with the output kept — the plugin exited with a non-zero code. `error: "timeout"` —
a standard run took longer than 5 s (the whole process group is killed). `unknown` with nothing shown — empty output.
`output-too-large` — more than 1 MB. `not-executable` — no interpreter for the extension and no x bit. A plugin that
does not appear at all — the file name does not parse (an ignored extension, a leading `_` or `.`, a bad id: see
section 2) or `<agenthub.platforms>` does not include this system.

## 2. Anatomy of a plugin

**File name.** `{id}.{interval}.{ext}`, `{id}.{ext}` or a folder `{id}/` containing such a file.

- `interval` — a number and `ms|s|m|h|d` (`30s`, `5m`, `2h`); runs are at least 1 s apart. The interval counts from
  the **end** of the previous run, and every other run (`refresh`, a `watch` change, the run after an action or a job's
  end) starts it over: a `1m` plugin whose run takes 3 s runs about every 63 s and drifts against the clock. For runs at
  fixed clock times (on the hour, 09:00 on weekdays) drop the interval and use `<agenthub.schedule>`.
- No interval — the plugin runs at start, on `refresh`, on a `watch` change and per `<agenthub.schedule>` (a 5-field
  cron line: `<agenthub.schedule>0 9 * * 1-5</agenthub.schedule>`).
- `id` — for the registry and own sources `a-z`, `0-9`, `-`, up to 64 characters, not `local`, `staging`, `disabled`,
  and not the id of a built-in plugin. Local plugins may also use uppercase, `_` and `.`. The id is the folder name and
  the file name up to the interval.
- Ignored: names starting with `_` or `.`, and the extensions `.md .txt .json .lock .log .orig .bak .swp` — so a
  folder plugin may keep `README.md`, data and fixtures next to the main file.

**Interpreter.** `.mjs/.js/.cjs` — the hub's own node; `.py` — `/usr/bin/python3`; `.sh/.bash/.zsh` — that shell;
anything else runs by its x bit. The registry and own sources accept text files only (`.mjs .js .cjs .py .sh .bash
.zsh`), not binaries. A binary local plugin keeps its metadata in the `com.kensei.agenthub.meta` xattr (text or base64).

**Two kinds of plugins** (`<agenthub.type>`):

| `standard` (default) | `streamable` |
|---|---|
| started per interval, schedule, watch or refresh; prints one frame and exits | one long-lived process; prints a frame, then a `~~~` line, and so on |
| 5 s budget per run | no budget; restarted with a 1 s → 60 s backoff if it crashes, status `error` until the next frame |
| a change of a watched path → a new run (`FileChanged`) | gets NDJSON on stdin: `{"type":"fileChanged","path":…}`, `{"type":"refresh","reason":…}`, `{"type":"actionResult",…}`, `{"type":"jobs",…}` and `{"type":"jobExit",…}` (section 5.2), `{"type":"event",…}` and `{"type":"eventSnapshot",…}` (section 9.1), `{"type":"stopping","reason":…}` (below) |

A streamable skeleton:

```js
#!/usr/bin/env node
// <agenthub.title>Watcher</agenthub.title>
// <agenthub.type>streamable</agenthub.type>
// …
import { createInterface } from "node:readline";

function frame() {
  process.stdout.write(`All quiet | status=ok\n---\nChecked at ${new Date().toLocaleTimeString()}\n~~~\n`);
}
frame();
setInterval(frame, 60_000).unref?.();
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "refresh" || msg.type === "fileChanged") frame();
});
```

A streamable plugin that reports `activity=`/`needsOn=` must repeat its frame at least every 2 minutes: silent for more
than 5 minutes counts as hung.

**Process lifecycle.** Every run, streamable process and action runs in its own process group; when it ends (or times
out) the hub kills the whole group, so do not leave children behind on purpose — a long task is a background action
(`background="true"`, section 5.2). A streamable process must keep reading its stdin: while more than 1 MB of messages
waits unread in the pipe, new ones are dropped (journaled once a minute as `stdin-backlog`). Before stopping a streamable process the hub writes
`{"type":"stopping","reason":…}` to its stdin and closes it, then sends SIGTERM 200 ms later and SIGKILL a second after
that. `reason`: `restart` (the hub starts it again with a new environment — `cause` is the new
`AGENTHUB_REFRESH_REASON`: `LanguageChanged`, `Paused`, `Resumed`, `SecretChanged`), `updated` (your file changed),
`policy` (tier or permissions changed), `removed` (deleted or disabled), `shutdown` (the daemon stops). After a crash
the process restarts with a **freshly built** environment (a secret set meanwhile is there), with the same
`AGENTHUB_REFRESH_REASON` as the start it replaces.

**Frame rate.** Every frame costs a full redraw of your page in the app. The hub forwards at most 4 state changes per
second per plugin and always delivers the latest one; the first change after a quiet period and the first frame after
an action go out at once. Printing faster than that only burns CPU — print when something changed.

**Data directories.** Every plugin gets two directories of its own, created by the hub: `AGENTHUB_PLUGIN_DATA_PATH`
(`PluginData/<id>`, kept across updates; removed only by "Remove with data") and `AGENTHUB_PLUGIN_CACHE_PATH`
(`Cache/<id>`, removed with the plugin). Keep your state there rather than next to the plugin file: an installed
plugin's folder is exactly the files that were agreed to, and anything extra sends it to quarantine.

## 3. Metadata tags

A tag is `<agenthub.NAME attr="…">value</agenthub.NAME>`, always closed. A multi-line value is joined with spaces (the
comment prefix on continuation lines is dropped). Quote attribute values that hold `>` (`arg="text:^[^<>]{1,500}$"`):
since hub 0.1.3 a `>` inside quotes is part of the value; outside quotes it ends the tag (older hubs end the tag at any
`>`, so there such an action is dropped). Unknown tags are ignored — including `<agenthub.tier>`: the tier never
comes from metadata. Parse problems (a bad `lang`, an invalid icon, a broken action) are warnings in the journal; for the
registry and own sources they are errors.

**Description**

| Tag | What | Example |
|---|---|---|
| `title` | the plugin name (required for the registry and own sources) | `<agenthub.title>Disk space</agenthub.title>` |
| `version` | semver `1.2.3` (required; every change of the shipped files needs a new one) | `<agenthub.version>1.0.0</agenthub.version>` |
| `desc` | one line for the catalog and the plugin page | `<agenthub.desc>Free space on the startup disk</agenthub.desc>` |
| `author.github`, `author.name` | the GitHub login (required) and how to sign the catalog card | `<agenthub.author.github>your-login</agenthub.author.github>` |
| `platforms` | comma-separated `macos`, `windows`, `linux` (required); a plugin is not started on other systems | `<agenthub.platforms>macos,windows</agenthub.platforms>` |
| `contract` | the minimum plugin contract the plugin needs (section 11) | `<agenthub.contract>3</agenthub.contract>` |
| `icon` | the tile icon: an SF Symbol name and an optional `#RRGGBB`; without it — a grey puzzle piece | `<agenthub.icon symbol="internaldrive" color="#64D2FF"></agenthub.icon>` |
| `status` | your own label for a status value, with an explanation shown as a tooltip | `<agenthub.status value="wait" label="Disk almost full">Less than 10% is free</agenthub.status>` |
| `requires` | an external program the plugin is useless without (up to 8); the catalog shows "Requires …", not a permission | `<agenthub.requires name="Tool" url="https://tool.example.com" check="~/.tool">reads its state</agenthub.requires>` |

**How it runs**

| Tag | What | Example |
|---|---|---|
| `type` | `standard` (default) or `streamable` | `<agenthub.type>streamable</agenthub.type>` |
| `schedule` | a 5-field cron line, for a file without an interval | `<agenthub.schedule>*/10 9-18 * * 1-5</agenthub.schedule>` |
| `watch` | a path or a mask in the last segment; a change starts a run (300 ms debounce; under writes that never pause — a log written every 100 ms — a run still comes at least every 2 s). `~` is the plugins' HOME; `$AGENTHUB_PLUGIN_DATA_PATH`/`$AGENTHUB_PLUGIN_CACHE_PATH` are your own directories (any tier); `recursive="true"` — subdirectories too (the mask then matches the file name). Repeatable | `<agenthub.watch recursive="true">$AGENTHUB_PLUGIN_DATA_PATH/inbox — a job dropped into the inbox</agenthub.watch>` |

**Permissions** — every entry is `what — why`; the "why" is shown to the human in the consent window. All of these are
repeatable (section 6):

| Tag | What | Example |
|---|---|---|
| `fsRead` | files and directories the plugin reads (masks allowed) | `<agenthub.fsRead>~/.config/tool/state.json — show the tool's state</agenthub.fsRead>` |
| `fsWrite` | files and directories it writes outside its own data directories | `<agenthub.fsWrite>~/.config/tool/mode — the mode switch button</agenthub.fsWrite>` |
| `exec` | programs it runs, as a command line | `<agenthub.exec>/bin/df -k — free space on the startup disk</agenthub.exec>` |
| `net` | hosts it talks to | `<agenthub.net>api.example.com — the service status</agenthub.net>` |
| `secrets` | keychain entries put into its environment (section 7) | `<agenthub.secrets>tool.token — read your tasks</agenthub.secrets>` |
| `effects` | comma-separated primitives its output may offer (section 5) | `<agenthub.effects>open.url,session.focus</agenthub.effects>` |
| `action` | its own command behind a button (section 5) | `<agenthub.action id="snooze" level="confirm" title="Snooze">tool.5m.mjs --action snooze</agenthub.action>` |
| `connection` | an OAuth connection the hub signs into: an MCP server or an HTTPS API (section 8) | see 8.2, 8.3 |
| `terminal` | read a Claude Code tab's input state / type into it (section 8.4) | `<agenthub.terminal>send /model — apply the chosen model</agenthub.terminal>` |
| `subscribe` | another plugin's events on stdin: `<plugin id>:<event key prefix>`, `*` for every other plugin (section 9.1; trusted streamable plugins only) | `<agenthub.subscribe>builds:failed — restart a failed build</agenthub.subscribe>` |

**Notifications**

| Tag | What | Example |
|---|---|---|
| `push` | a rule for one of your `event=` keys (section 9) | `<agenthub.push key="disk-low" kind="plugin">Disk almost full</agenthub.push>` |

**Translations.** Repeat a tag with `lang="xx"` (section 10): `title`, `desc`, `status`, `push`, `requires`,
`connection` and the "why" of permission entries. Actions use `title-xx=`, `cost-xx=` and `input-xx=` attributes instead.

## 4. Output

### 4.1 Lines

```
Header line | status=wait tile="3 waiting"
Another header line
---
Body line | sfimage=checkmark.circle color=green
--Child line
----Grandchild line
---
Line after a separator
```

- **Header** — lines before the first `---`. The first header line is the main one: the tile and the page title. The
  plugin status is the worst `status=` among header lines.
- **Header buttons reach the popover.** A header line with an offer (`action=`, `effect=`, `href=`) is a button in the
  page header; the first three of them are also buttons in the popover. The tile itself is not a button: a click on it
  expands a card under the tiles (the headline, up to four body lines, then those buttons), and a click on the card's
  text opens the plugin page. The buttons behave as on the page — the same gate, confirmation and spinner; an `input=`
  action asks for its text in a sheet. Put what people press without opening the panel (Start, Skip) on header lines,
  most important first; body buttons are on the page only. A hub app older than 0.1.3 shows no buttons in the popover.
- **Body** — lines after it. `--` in front adds a nesting level; a `---` line in the body is a separator (`-----` is a
  separator one level down).
- **Parameters** — after the **last** unescaped `|` that is followed only by `key=value` pairs; values with spaces go
  in quotes: `key="two words"` (inside quotes `\` escapes the next character). A `|` written as `\|` is part of the
  title and never a separator (hub 0.1.3+, below).
- **Sanitize what you print**: no newlines inside a title, no leading `-` or `~` (they would read as nesting or a frame
  end), no `---`/`~~~` lines from data. Limits: 2000 lines, 64 KB per line (16 KB before hub 0.1.3), 1 MB in total.
  A longer line is cut and keeps **only its title** (the text before its first unescaped `|`), with no parameters at
  all and a journal warning: the cut may fall inside a quoted value, and what follows its open quote must not become
  parameters. A streamable line over 1 MB is dropped up to its end.

#### Foreign text in a line

Text you don't control — log lines, PR and task titles, tab, file and folder names, model names, error messages — must
never be printed raw. If it is the last thing on a line and contains `|`, everything after its `|` is read as **your**
parameters: `GET /x 200 | href=https://evil.example event=pwned` from a log becomes a clickable line that raises a
notification, and `action=`/`arg=` can press your own buttons. Escape titles and quote values:

- **Title escapes** (hub 0.1.3+, within contract 3): a `|` preceded by an odd number of backslashes is a literal `|`
  of the title; that backslash run shows as half its length rounded down (`\|` → `|`, `\\\|` → `\|`). Backslashes
  anywhere else show as they are, so older titles don't change. A title that starts with backslashes followed by `-`
  or `~` loses one backslash (`\--x` shows `--x`): the line is not read as a nesting level, a `---` separator or a
  `~~~` frame end.
- **Values**: always in double quotes with `"`, `\` and `|` escaped; never paste foreign text unquoted (`note=${x}`
  with `x = "a href=…"` adds a parameter). The hub also refuses a split whose right side starts inside a quoted value
  (an unquoted value there holds a quote character) when a split further left parses cleanly.
- Put your own parameters after the escaped title with ` | ` — a space before the `|`.
- `escapeTitle` is for a **whole** title: build the title first and escape it once
  (``escapeTitle(`PR ${prTitle}`)``), not a piece glued after your own prefix — its leading `-`/`~` guard adds a
  backslash that only the start of a title hides, so `"PR " + escapeTitle("-x")` shows `PR \-x`.

Copy these helpers (the hub's own copy is `escapeTitle` in `daemon/lib/output.mjs`):

```js
// Title: control characters → spaces, "|" escaped (a backslash run in front of it doubled), a leading "-"/"~" guarded.
export function escapeTitle(text) {
  const s = String(text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ");
  let out = "", run = 0;
  for (const ch of s) {
    out += ch === "|" ? "\\".repeat(run + 1) + "|" : ch;
    run = ch === "\\" ? run + 1 : 0;
  }
  return out.replace(/^(\s*)(\\*[-~])/, "$1\\$2");
}
// Value: one line, in quotes, with ", \ and | escaped.
export const quoteValue = (v) => `"${String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/["\\|]/g, "\\$&")}"`;

console.log(`${escapeTitle(prTitle)} | href=${quoteValue(prUrl)} color=gray`);
```

```python
import re
def escape_title(text):
    s = re.sub(r"[\x00-\x1f\x7f]", " ", str(text))
    s = re.sub(r"(\\*)\|", lambda m: m.group(1) * 2 + "\\|", s)
    return re.sub(r"^(\s*)(\\*[-~])", r"\1\\\2", s)
def quote_value(v):
    return '"' + re.sub(r'["\\|]', r"\\\g<0>", re.sub(r"[\x00-\x1f\x7f]", " ", str(v))) + '"'
```

On a hub older than 0.1.3 `\|` is still a separator and the backslash shows. A plugin that must run there should
replace `|` with `¦` and strip leading `-`/`~` instead — what the built-in plugins do (their `clean()`), which is safe on
every hub.

### 4.2 Parameters

| Parameter | Where | Meaning |
|---|---|---|
| `status=ok\|wait\|block\|error\|unknown` | header (body — a colored dot on the line) | the plugin status (4.5) |
| `tile="…"` | first header line | a short value for the popover tile and the panel badge: "04:30", "2 waiting", "62%". Say what is happening, not "!" — the status icon already shows alarm |
| `tileLabel="…"` | first header line | a short tile caption instead of the plugin name (the tile fits ~110 pt): "Agents" instead of "Background agents" |
| `gauge=0…100`, `gaugeLabel="…"` | first header line — a ring on the plugin page; body — a card with a bar (`note` on the right, children under the bar) | |
| `stat="caption"`, `note="…"` | body | a number card: the line title is the value ("04:30"), `stat` the caption, `note` a line under it; consecutive ones form a row |
| `strip=true` | body | the line's children form a strip of cells (`sfimage`, title, `note`; a cell with an effect is a button): "Recent runs" |
| `details=true` | body | the line's children are collapsed under "Details": process ids, cron lines, internal ids |
| `segment=true`, `select=true` | body | the line's children are the options of a segmented control or a popup button; `selected=true` marks the current one, the others carry `action=`/`effect=`; `note=` on the line is gray text beside the control ([4.3](#43-controls)) |
| `toggle=on\|off` | body | a switch in that state; a click runs the line's own `action=`/`effect=` ([4.3](#43-controls)) |
| `table=true`, `columns="A¦B¦C"` | body | the line's children are table rows: `cells="b¦c"`, `cellColors="¦#FFB454"`, row children as buttons (`icon=true` — icon only) or gray notes, `group=true` subheadings, `header=true` buttons by the title ([4.3](#43-controls)) |
| `chart=bars`, `values="1,2"`, `labels=`, `valueLabels=`, `avg=`, `highlight=`, `tips=`, `stack=`/`series=`/`colors=` | body | a bar chart card; a segment child sits in its title row ([4.4](#44-charts)) |
| `chart=share` + children with `value=` | body | one bar of shares and a legend with percents and `note=` ([4.4](#44-charts)) |
| `bar=0…100`, `barColumn=<n>` | body line, table row | a thin progress bar; in a table — in column `n` ([4.4](#44-charts)) |
| `spark="1,2,3"`, `sparkAvg=`, `sparkMax=`, `sparkLabel=`, `sparkNote=` | first header line | a sparkline in the page header (a large value, [4.4](#44-charts)) and the popover tile |
| `until=<ISO-8601>` | first header line | a live countdown the app runs itself (hub 0.1.3+): the tile value and the page header value show `mm:ss` (from an hour on `h:mm:ss`) to that moment and stop at `00:00`; no frames needed while it runs. Give a time zone (`2026-11-12T18:30:00Z` or `…+03:00`); unparsable — ignored. Keep a `tile=` too: an older hub shows it instead |
| `font=mono` | any line | the line title in a monospaced font (ids, hashes, aligned figures; hub 0.1.3+): plain lines, header lines, `stat=`/`gauge=`/`strip=` cards (and strip cells), chart titles and `chart=share` legend rows, `bar=` lines, table rows (the title and its `cells=`) and `group=true` headings, buttons and links, the popover's expanded tile card; captions, notes and badges stay in the regular font; other `font=` values are ignored |
| `activity="…"`, `needsOn="…"` | header | the "can I shut down" verdict (4.6) |
| `event=<key>` | any line | a notification key (section 9) |
| `effect="<primitive> <args>"`, `href=<url>` | any line | a button that runs a core primitive (section 5) |
| `action=<id>`, `arg=<value>` | any line | a button that runs your declared action (section 5) |
| `session=<uuid> pid=<pid>` + `sessionStatus=`, `sessionName=`, … | any line | a line about a Claude Code session; only trusted plugins feed the hub's session registry ([`extension-points.md`](extension-points.md), output table) |
| `agentSession=<id> pid=<pid>` + `agent=<kind>`, `agentName="…"` | any line | another agent's session (not Claude Code: a CLI agent in a terminal tab) — trusted plugins only; the hub can then switch to its tab with `session.focus <id>` and nothing else (section 5.1) |
| `sfimage=<SF Symbol>` | any line | the line icon |
| `color=` | any line | the title and icon color, nested lines included: `red`, `green`, `blue`, `orange`, `yellow`, `gray`, `purple`, `pink` or `#RRGGBB` (`#light,#dark` — the first is taken) |
| `iconColor=` | any line | colors only the `sfimage` icon (same palette); the title keeps `color=` or the default |
| `badge="…"` | any line | a small capsule after the title |
| `badgeColor=` | a line with `badge=` | the badge tint (same palette): a light fill with text in that color; without it — the neutral capsule |
| `link=true` | a line with `effect=`/`href=`/`action=` | drawn as a text link instead of a capsule button (panel); same confirmation, gate and tooltip |
| `tooltip="…"` | any line | hover text (the full text of a truncated line is shown anyway) |
| other keys (`size`, …) | any line | passed to the shell in `params` as is; the app draws nothing for them |
| `bash=`, `shell=`, `terminal=`, `paramN=` | — | **forbidden**: dropped with a warning; output can never run a command |

A layout example (the built-in `quota` and `claude-sessions` use all of these):

```
Week 62% · resets Mon 09:00 | status=ok tile="62%" gauge=62 gaugeLabel="of week"
---
04:30 | stat="Next build" note="in 6 h"
12 | stat="Runs today"
Week — 62% used | gauge=62 note="reset Mon 09:00" sfimage=calendar
--If you keep this pace, ≈90% by the reset
Recent runs | strip=true
--build | sfimage=checkmark.circle note="12 min"
--release | sfimage=xmark.octagon color=red note="failed"
Details | details=true
--pid 4242 · cron 30 4 * * *
```

### 4.3 Controls

Hub 0.1.1 draws four more kinds of body lines on the plugin page. They stay within contract 3: the keys are optional,
and an older hub draws the children as plain lines and capsule buttons, so the same output still works there. Every
clickable part is an ordinary offer (`action=`/`arg=`, `effect=`, `href=`): the same gate (disabled with the reason in
the tooltip while paused or without the bridge), confirmation level ("…" after the title of an offer that asks first)
and spinner while it runs. After an action the hub runs the plugin again, so the new state comes from your next frame —
the hub never flips a control by itself.

```
Model | segment=true note="for new sessions"
--Default (Opus 5.5) | action=set-model arg=default
--Opus 5.5 | selected=true
--Sonnet 5.5 | action=set-model arg=claude-sonnet-5-5
Output style | select=true note="open tabs pick it up from their next message"
--Explanatory | selected=true
--Terse | action=set-style arg=Terse note="yours"
Ultracode | toggle=off action=ultracode-on note="multi-agent workflows on every task"
---
Open sessions · 13 | table=true columns="Tab¦State¦Model¦Effort"
--Apply base · 2 | action=apply-all header=true
--api-server | cells="idle¦Opus 5.5¦xhigh" cellColors="¦¦#FFB454" sfimage=circle.fill iconColor=#8E8E93
----Fix | action=apply arg=3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f
----Switch | effect="session.focus 3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f" sfimage=arrow.up.forward.app icon=true
--web-client | cells="busy¦Sonnet 5.5¦medium"
----after the turn | color=#8E8E93
--As base · 9 | group=true
----Agent Hub | cells="waiting¦Opus 5.5¦medium" sfimage=circle.fill iconColor=#FFB454
------Switch | effect="session.focus 4a3d0b2f-8c5e-4d9f-a021-3b4c5d6e7f80" sfimage=arrow.up.forward.app icon=true
```

- **`segment=true`** — the children form a segmented control: one shared track, the `selected=true` child highlighted
  (it is not pressable). The others need an offer; one without is shown dimmed. When the options do not fit the page
  width, the same choice is drawn as a popup button.
- **`select=true`** — a popup button with the current (`selected=true`) child and a chevron; the menu lists all
  children, the current one with a checkmark, each child's `note=` as a dimmed second line. For lists that can be long.
- **`toggle=on|off`** — a switch drawn in that state; a click runs the line's own offer (print `toggle=off
  action=…-on` and `toggle=on action=…-off`). Without an offer the switch only shows the state.
- Consecutive segment, select and toggle lines form one block: titles in a label column, controls beside them, `note=`
  as gray text right of the control. Under a heading line (`For new sessions` with the controls as its children) they
  line up with the heading instead of being indented.
- **`table=true`** — the line title is the table title, `columns=` the column titles. Each child is a ~34 pt row: the
  title is the first column, `cells=` the other columns, `cellColors=` a color per cell (empty — default; a colored cell
  is also bold), `sfimage=circle.fill` with `iconColor=` (or `status=`) a small state dot before the title (another
  `sfimage` — a small icon). A row's own children: with an offer — small buttons at the right of the row, with
  `icon=true` an icon-only button (`sfimage`; the title is its tooltip and accessibility label); without an offer — a
  gray note in the same place (`color=` tints it). Rows outside groups have a subtle fill.
- **`group=true`** on a table child — a collapsible subheading whose children are rows. Groups start expanded; the
  hub remembers a collapsed group while the app runs (by the table and group titles without a trailing count, so
  `As base · 9` → `As base · 10` stays collapsed).
- **`header=true`** on a direct table child with an offer — a button right of the table title, not a row.
- `¦` (U+00A6) separates entries in `columns=`, `cells=` and `cellColors=`; entries are trimmed, empty ones keep their
  place. Quote the value when an entry has a space. A truncated cell shows its full text on hover.

### 4.4 Charts

Hub 0.1.3 draws four chart elements on the plugin page. Like the controls they stay within contract 3: the keys are
optional plain params, and an older hub draws the same lines as plain text (a chart line as its title, its children as
lines), so write titles that still read well there. All of them are generic: the highlight color is your plugin's
`<agenthub.icon color=…>` (or `color=` on the line), nothing in the hub knows your plugin.

```
Today $101 · 236M tokens | tile="$101" stat="Today, by 16:00" note="236M tokens · 836 requests" spark="503,332,17,94,406,195,208,845,454,392,99,441,698,101" sparkAvg=342 sparkLabel="14 days" sparkNote="avg $342 a day"
yesterday for the whole day — $698
---
By day | chart=bars values="503,332,16.77,94.13,698,101" labels="6¦7¦8¦9¦10¦11" valueLabels="$503¦$332¦$17¦$94¦$698¦$101" avg=342 avgLabel="avg $342" highlight=last unit=$ tips="Fri Nov 6\\n$503 · 1.04B tokens¦Sat Nov 7\\n$332¦Sun Nov 8\\n$17¦Mon Nov 9\\n$94¦Tue Nov 10\\n$698¦Wed Nov 11, by 16:00\\n$101"
--Range | segment=true
----14 days | selected=true
----30 days | action=set-range arg=30
---
Tokens by day | chart=bars stack="Cache read,Cache write,Output" series="990,797,23;29.7,19.7,1.2;7.1,3.1,0.27" colors="#4A8FAD,#BF5AF2,#FF9F0A" labels="9¦10¦11" note="avg 900M a day" legend=true
--By token type | table=true columns="Type¦Today¦Share of cost" barColumn=3
----Cache read | cells="230M¦47%" bar=47 sfimage=square.fill iconColor=#4A8FAD
----Output | cells="828K¦21%" bar=21 sfimage=square.fill iconColor=#FF9F0A
---
Where it goes · 7 days | chart=share
--Background runs | value=2050 note="$2,050" color=#BF5AF2
--Sessions | value=665 note="$665" color=#0A84FF
--Subagents | value=316 note="$316"
---
Models · 7 days
--Opus 5.5 | bar=100 note="$2,981" color=#FF9F0A
--Fable 5.2 | bar=1.1 note="$32" color=#FF9F0A badge="priced as Fable 5.1"
```

- **`chart=bars`** — a card with the line title on the left and `note=` (gray) on the right, then the bars. A
  `segment=true` or `select=true` child is drawn in the title row instead of under it (a 14 / 30 days switch); other
  children (a table, notes) go under the chart. Keys:
  - `values="v1,v2,…"` — one bar per number (comma-separated; a broken or negative entry is 0 and keeps its place);
  - `labels="…"` — short captions under the bars, `¦`-separated (comma-separated works when no label has a comma);
  - `valueLabels="…"` — text above each bar, `¦`-separated (empty entries keep their place: no caption);
  - `avg=<number>` — a dashed average line across the plot; its caption sits under the chart next to a short dashed
    sample of the line (beside the `legend=true` entries), its text from `avgLabel=` (default «среднее» / "average");
    bars above it are tinted orange unless `tint=none`;
  - `highlight=last|<index>` — that bar (0-based) in the plugin color or `color=`; its label is bold;
  - `tips="…"` — a hover tooltip per bar, entries `¦`-separated; a line break inside an entry is the two characters
    `\n`. Inside a quoted value a backslash escapes the next character, so print it as `\\n` (or let your quoting
    helper escape the backslash). The tooltip covers the bar's whole column and shows at once;
  - `height=<pt>` — the plot height, 60…400 (default 160); `unit=` — only for the accessibility label;
  - `max=<number>` — a fixed scale top (hub 0.1.3+; a percentage chart: `max=100`): bars above it are clipped at the
    top, an `avg=` above it is not drawn. Without it the scale autoscales to the tallest bar or `avg=`, whichever is
    higher, so the same value draws at a different height from frame to frame. A non-positive or broken value is ignored;
  - **stacked:** `stack="a,b,c"` names the series (bottom layer first), `series="a1,a2,…;b1,b2,…;c1,…"` holds their
    values (`;` between series), `colors="#hex,#hex,#hex"` their colors (`color=` palette, default — a built-in
    palette); layers are in true proportion, but a visible (non-zero) layer gets at least 2 pt. `legend=true` adds a
    legend under the chart. Without `series=` the chart falls back to `values=`.
- **`chart=share`** — a card with one rounded bar of the children's shares and a legend: a dot, the child title, its
  percent and its `note=` on the right. A child is a part when it has `value=` (a positive number); `color=` per
  child, otherwise a built-in palette. All values zero — the line is drawn as a plain line.
- **`bar=<0…100>`** — a thin progress bar. On a body line: the title (and `badge=`) on the left, `note=` on the right,
  the bar under them; `color=` tints the bar, not the title. A heading line whose children carry `bar=` reads as a card
  title, the rows line up with it (a ranked list). In a table row: `barColumn=<n>` on the table or the row (1-based,
  the title column is 1) draws the bar in that column, with the cell text (if any) to its right; without it the bar
  is a hairline under the title. The bar color is `color=`, else `iconColor=`, else the plugin color.
- **`spark="v1,v2,…"`** — on the first header line: a mini bar sparkline, the last bar in the plugin color. On the
  plugin page the header becomes a "hero": `stat=` as the caption, the `tile=` value large in the plugin color,
  `note=` (or the headline) and the other header lines under it, the sparkline on the right with `sparkLabel=` /
  `sparkNote=` above it and a dashed `sparkAvg=` line (bars above it tinted). `sparkMax=<number>` — a fixed scale top,
  like `max=` on a chart (hub 0.1.3+). The status line shows only when the
  status is not `ok`. The popover tile draws the sparkline in its icon row.
- **Size:** the data keys `values`, `labels`, `valueLabels`, `tips`, `series` and `spark` may be up to 8000
  characters each (other values — 2000); the line itself is at most 64 KB (hub 0.1.3+; 16 KB before) — enough for
  every data key of a chart at its maximum. Send numbers without exponents and
  without thousands separators. A longer data key keeps its **newest** entries: the hub drops entries from the start of
  the list until it fits, and drops the same count from every list of that chart line (`values`, `labels`,
  `valueLabels`, `tips` and each `;`-row of `series`) so bar *i* keeps its caption and tooltip; a numeric `highlight=`
  moves with them (gone if its bar was dropped). `spark=` is trimmed on its own. A single entry longer than the limit
  keeps its tail. Each trimmed key leaves a warning in the journal (`agenthub journal`) — send fewer days instead.

### 4.5 Status: what it means

| Status | Shared label (without your `<agenthub.status>`) | Use it when |
|---|---|---|
| `ok` | "All good" | nothing to do |
| `unknown` | "No data" | the source is missing or unreadable, not loaded yet |
| `wait` | "Needs attention" | something waits for the human or will soon be a problem |
| `block` | "Blocking" | something is in the way and will not resolve without the human |
| `error` | "Failure" | the plugin itself failed |

- `/state.status` is the **worst status of all plugins** (`ok < unknown < wait < block < error`). The popover tile
  and the sidebar show each plugin's own status. The menu bar icon reacts only to `block` and `error`: its emblem turns
  red and the tooltip names the plugin ("<plugin> — <headline>"). `wait` does not tint the icon — the orange emblem
  and the number next to it count only Claude Code sessions awaiting a reply and question cards. `activity=`/`needsOn=`
  (4.6) color the quiet states blue and indigo. Do not raise `wait` for things that are merely interesting.
- No `status=` in the header — `ok`; empty output — `unknown`; a non-zero exit code — `error` (the printed lines are
  kept and a `plugin-error` notification goes out once until recovery). Print `status=error` with exit code 0 for a
  domain error ("the service rejected the token"); exit non-zero only when the plugin itself broke.
- An unknown shape of your source: print `status=unknown` and `event=source-broken` on that line.
- Give each status you use an unambiguous label with `<agenthub.status>`: "waiting" for a quota and for a session mean
  different things.

### 4.6 "Can I shut down?"

The popover answers whether the Mac can be shut down. A plugin takes part only if its header carries `activity=` or
`needsOn=` (any tier — this is not a permission):

- `activity="Run \"build\" running, 12 min"` — work is in progress right now (the verdict becomes "too early");
- `needsOn="Build at 04:30 — needs the Mac on"` — quiet now, but the Mac is needed later ("OK, but …"; the part before
  " — " goes into the card title for trusted plugins);
- `activity=""` — "I take part, all quiet here": the plugin is listed under "Also checked".

Phrases are cleaned (control characters, newlines) and cut to 120 graphemes; at most 4 per kind. A participant that
fails (exit ≠ 0, timeout, empty output) or goes silent (no frame for 3 intervals, at least 2 min) is shown as
"<plugin>: failure — last: <phrase>". `status=block` does not affect the verdict. Phrases of plugins that are not
trusted (`builtin`, `official`, `own`) get a "<plugin name>: " prefix.

## 5. Effects and actions

### 5.1 Effects — core primitives

An effect is a button that asks the core to do something well-defined. The core writes the confirmation text and
checks the arguments itself; the plugin only proposes.

| Effect | Arguments | Who may offer it |
|---|---|---|
| `open.url <url>` | `http(s)` only, no credentials in the URL — another link (`message://`, `mailto:`, `file:`) gets no button at all: the core drops it when it reads the frame and journals a warning (`open.url would refuse this button (scheme)`); open such a link from your own `net="none"` action | everyone (`href=<url>` is the same) |
| `open.file <path> [reveal=true]` | an absolute or `~/` path; documents and plain folders open, anything executable or unknown is refused — only revealed in Finder with `reveal=true`; a folder with a dot in its name (`site.com`, `notes.d`) counts as a package and is only revealed too (deliberately) | everyone |
| `session.focus <sessionId>` | a Claude Code session UUID, or the id of another agent's session (below); the hub finds the terminal tab itself | everyone except `local` (contract 3) |
| `terminal.focus <surfaceId> [workspaceId=…]` | a terminal tab by its UUID (the `surfaceId` of a session record — in practice a cmux surface) — prefer `session.focus` | everyone except `local` |
| `cmux.focus <surfaceId> [workspaceId=…]` | **deprecated** former name of `terminal.focus`: accepted until the next contract — use `session.focus` | everyone except `local` |
| `session.interrupt`, `session.stop`, `session.respond`, `session.launch` | — | built-in plugins only |

Declare what you offer: `<agenthub.effects>open.url,open.file,session.focus</agenthub.effects>` (`open.*` covers both
`open.` primitives). An effect that is not declared, or not under your tier's ceiling, is dropped with a warning. Lines:

```
Open the dashboard | effect="open.url https://status.example.com" sfimage=safari
Show the log | effect="open.file reveal=true ~/Library/Logs/tool.log"
Go to the session | effect="session.focus 3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f" sfimage=arrow.up.forward.app
```

An argument with spaces (a path) goes in quotes **inside** the quoted `effect=` value — single quotes, or escaped double
quotes:

```
Open the report | effect="open.file '~/My Reports/week 45.pdf'"
Show the folder | effect="open.file reveal=true \"~/Library/Application Support/Tool\""
```

Build it with `quoteValue` (4.1) around the whole spec and single quotes around a path without `'`; a path with `'` or
`"` needs the escaped double-quote form with its own `"` and `\` escaped once more (`\\\"`).

`open.url`, `open.file`, `session.focus` and `terminal.focus` run immediately, without a confirmation, and `open.*` keep
working while the hub is paused. `session.focus` refuses with `409 facts:<code>` when the session is not in the hub's registry or no
terminal adapter knows its tab. The hub knows the session's terminal itself (cmux, tmux, iTerm2, Terminal.app — see
[`extension-points.md`](extension-points.md#terminal-adapter-daemonlibterminalsidmjs)), so the same line works in any of them.
Your plugin learns session ids from `AGENTHUB_CLAUDE_SESSIONS_FILE` (trusted plugins, section 7) or from
`~/.claude/sessions/*.json` (with an `fsRead` permission).

**Other agents' sessions** (hub 0.1.3+, trusted plugins). A plugin that watches a non-Claude agent (another CLI agent
running in a terminal tab) puts `agentSession=<id> pid=<pid>` on that agent's line, optionally `agent=<kind>` (`a-z`,
`0-9`, `-`, up to 32) and `agentName="<name>"` (sanitized, up to 120 characters):

```
Refactor auth | agentSession=cx-1 pid=48213 agent=codex agentName="Refactor auth" effect="session.focus cx-1"
```

- `<id>` is `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (a UUID works too). The process `pid` must exist; the hub records its start
  time and drops the entry when the process ends or the pid is reused, and when the line disappears from your output.
- There is no signature check, so **only switching to the tab works**: `session.focus <id>` finds the tab by the pid
  in tmux, iTerm2 and Terminal.app. **In cmux it cannot**: the cmux adapter knows only the Claude Code tabs (the session
  registry and cmux's own hook file), so `session.focus` refuses such a session with `409 facts:no-terminal` and
  `terminal.focus <surfaceId>` with a non-Claude tab's surface with `409 facts:unknown-surface` — offer no switch button
  for an agent running in cmux.
  `session.interrupt` and `session.stop` refuse such a session with `409 facts:external-session`, the `/terminal/*`
  routes with `409 terminal:external-session`.
- An id is held by the plugin that registered it while its process lives; another plugin's line with the same id is
  ignored (a journal warning). Up to 64 such sessions per plugin. Lines from `community` and `local` plugins are ignored.
- These sessions are not in `/state.sessions` or `AGENTHUB_CLAUDE_SESSIONS_FILE` (Claude Code only): the app reads
  them from `/state.externalSessions` ([`api.md`](api.md)).

### 5.2 Actions — your own commands

An action runs a command of **your** plugin when the human presses a button. `builtin`, `official` and `own` plugins
get actions as declared; `community` plugins get them too (hub 0.1.3+), but never below `confirm` — every click shows the
core's confirmation window; `local` plugins get none (except on a test hub with `AGENTHUB_TEST_TIER=own`, section 1.2).

```
// <agenthub.action id="snooze" level="immediate" arg="minutes:^(?:60|240)$" title="Hide the warning for a while" title-ru="Скрыть предупреждение на время">disk.10m.mjs --action snooze {minutes}</agenthub.action>
```

- `id` — `[A-Za-z0-9][\w.-]{0,63}`, unique.
- The text is the command, split into argv **without a shell** (quotes and `\` work, no pipes or variables). The first
  word is your main file name: it runs with the plugin's interpreter, cwd = the plugin folder, the same environment as a
  run (`AGENTHUB_REFRESH_REASON=MenuAction`), a 30 s timeout. `--action <id>` is a convention, not a requirement.
- `level` — `immediate` (no window), `confirm` (default; a window with text the core writes) or `confirm-cost` (a
  window with a price: `cost="…"` says what it spends). The core raises the level: a plugin that declares `net` (unless the
  action says `net="none"`, below) or an action with `cost=` always gets at least `confirm-cost`; a `community` plugin's
  action — at least `confirm`. The linter treats `immediate` with network (without `net="none"`) or with `cost=` as an
  error, and warns about a community `immediate` (it would never run without a window). An `immediate` action is fine only if it spends nothing at the click and the same click undoes
  it (a toggle); the registry linter flags every one for the reviewer.
- `net="none"` — this action does not use the network your plugin declares (a local toggle in a plugin that also talks
  to an API): the `confirm-cost` floor that `<agenthub.net>` puts on every action is lifted for this one (a `cost=` still
  counts). It is a promise, not a sandbox: the registry reviewer checks the command reaches no host, and the permission
  key carries it (`actions: <id> [<level>] <command> net=none`), so adding it in an update asks for consent again.
  The hub holds it to the promise on its own proxy (hub 0.1.3+): the action's process gets `403 net:none` on
  `/connections/<id>/mcp` and `/connections/<id>/http`.
- `input="Placeholder"` (+ `input-ru="…"`, `maxLength="N"` 1…4000, default 256) — **the human types the value**: the app
  shows a text field (the offer carries `input: {placeholder, maxLength, pattern}`), and the core checks the text like an
  argument — against the pattern of the required `arg="name:^pattern$"`, no control characters (so a single line), no
  leading `-`, at most `maxLength` characters. The text never goes into argv (a `{name}` word in the command is dropped):
  it arrives on the action's **stdin** as the text followed by one `\n`, then end of input — read it with
  `IFS= read -r text` in sh or by reading stdin to the end and dropping the final newline in node. The output line carries
  only `action=<id>` (an `arg=` on it is refused). Input actions are pressed only in the app, whatever the tier (the one
  exception is the CLI on a test hub with `AGENTHUB_TEST_TIER=own`, section 1.2, as for any action); the journal records
  the text's length, never the text. At `confirm` the app may ask for the text inside the confirmation
  sheet (`POST /actions/:id` without `input` → the 428 carries the field).
- `inputPattern="^pattern$"` (with `input=`, contract 3, hub 0.1.3+) — **a reply bound to a row**: the typed text is checked
  against this pattern instead, and `arg=` (optional then) becomes an ordinary row argument — the output line names the
  row (`Thread t2: deploy? | action=reply arg=t2`), the core checks the value and passes it in argv as for any `arg=`
  action, and the typed text still goes only to stdin. Each row then has its own button, the confirmation names the
  bound value, and `actionResult` carries it in `arg`. Without `inputPattern=` an input action keeps the rule above:
  `arg=` is the text's pattern and the line can't carry `arg=`. A hub older than 0.1.3 ignores `inputPattern=` and
  drops such a button (the line has `arg=`), so declare `<agenthub.contract>3</agenthub.contract>` and say so in your README.

  ```
  # <agenthub.action id="reply" level="confirm" title="Reply" arg="thread:^t[0-9]{1,9}$" input="Your reply" inputPattern="^[^<>]{1,500}$" maxLength="500">chat.mjs --action reply {thread}</agenthub.action>
  Thread t2: deploy now? | action=reply arg=t2
  ```
- `background="true"` — a **job**: the command keeps running after the click, with no 30 s timeout, in its own process
  group. The click returns at once with the job id; `/state.plugins[].jobs` lists running jobs (the app shows them with a
  "Stop" button — the `job.cancel` primitive), and "Can I shut down?" counts them. At most 4 jobs per plugin at once
  (`409 facts:jobs-limit`; jobs of the previous version that are still being stopped after an update don't count). A job survives restarts of your streamable process (language, a new secret) but
  is stopped (SIGTERM, SIGKILL 2 s later) when the plugin is removed, disabled or updated, when the hub is paused and
  when the daemon stops. When it ends, a streamable plugin gets `{"type":"jobExit","job","actionId","ok","code","signal",
  "durationMs","cancelled"?,"reason"?,"message"?}` on stdin (`cancelled`: `cancelled` | `paused` | `shutdown`); a standard
  one gets an extra run with `AGENTHUB_REFRESH_REASON=JobExit`. When the plugin is removed, disabled or updated its jobs
  belong to the old instance: they are stopped (journaled as `job-exit` with `cancelled: plugin-removed` |
  `plugin-restarted`, and the `job.exited` event), and the new process neither lists them in `jobs` nor gets their
  `jobExit` — after an update it starts with no jobs. A job that
  ends while your streamable process is being restarted is not lost: its `jobExit` is kept and delivered right after the
  new process starts. Every start of a streamable plugin with background actions begins with
  `{"type":"jobs","running":[{"id","actionId","title","startedAt","pid"}]}` — the jobs running at that moment (an empty
  list on the first start), so a restarted process can resynchronize. Keep the job's own progress in your data directory
  and show it in your frame. A job's `title` is the action's title plus its `arg=` value ("Start dev server web"); a
  second running job with the same title gets its start time ("Long (14:05:31)").
  The job **is its first process**: when that process exits, whatever is left in its group is killed (SIGKILL) and the
  job ends — do not background children and exit. A descendant that left the group (`setsid`) and keeps stdout open
  does not keep the job alive: a second after the first process exited its stdout is closed and the job ends anyway.
  A cancelled job whose end the hub cannot observe 2 s after the SIGKILL is ended with `reason: "orphaned"`.
  Running jobs are recorded in `<hub home>/jobs.json`; if the daemon crashes, it signals every job group (SIGTERM) on the
  way out, and the next daemon kills the groups whose first process is still the same one (same pid and start time —
  journaled as `job-orphan-killed`), so a job never outlives the hub unnoticed.
- `arg="name:^pattern$"` — a parameterized action. The pattern must be anchored with `^` and `$` (up to 200 characters).
  The value comes from the output line (`action=snooze arg=60`), never from the click request (for typed text see
  `input=` above); the core checks it against the pattern, rejects empty values, values over 256 characters, control characters and a leading `-`, and passes it as
  a separate argv element in place of `{name}` (or at the end).
- Non-built-in actions are pressed only by a human in the app; the CLI and agents cannot trigger them (a test hub with
  `AGENTHUB_TEST_TIER=own` is the one exception, section 1.2). Every run is journaled. While the hub is paused, actions
  are refused (423).
- The confirmation window is written by the core: plugin, tier, action title, argument, the command as it will run, the
  typed text (for `input=`), and — at the end — the title of **the row that carries the button** (sanitized, up to 120
  characters: "Button on the row "…""). Keep row titles meaningful: they tell the human what the click is about. The same
  button (same action and argument) on several rows with different titles is a separate button per row, so each window
  names the row actually pressed. A button's id stays the same across frames even when its row text changes every
  frame; with several copies, the first one keeps its id, so print copies in a stable order. A child button whose own text only repeats the action's title (`--Approve | action=approve
  arg=r8` under `Request r8: wipe the cache`, the layout of banner buttons) is confirmed with its **parent row's** title. Still put a unique request id in `arg=`, not a list position: the token is bound to the action and its argument,
  not to the row text.
- Before the confirmation and the run the core re-reads your file: a changed command, level, pattern or version cancels
  the click (`409 facts:action-changed`).

In the output:

```
Hide the warning for 1 hour | action=snooze arg=60 sfimage=bell.slash
```

**Success and refusal.** Exit code 0 is success. To refuse, exit non-zero and print a human explanation and a
machine code as the last lines of stdout:

```js
const i = process.argv.indexOf("--action");
if (i >= 0) {
  const [id, arg] = process.argv.slice(i + 1);
  if (id === "snooze") {
    writeFileSync(join(process.env.AGENTHUB_PLUGIN_DATA_PATH, "snooze-until"), String(Date.now() + Number(arg) * 60_000));
    process.exit(0);
  }
  console.log(`message=${process.env.AGENTHUB_LANG === "en" ? "Nothing to do" : "Нечего делать"}`);
  console.log("reason=unknown-action");
  process.exit(3);
}
```

`reason=<code>` (last line, `[a-z0-9-]`, up to 48) goes to `result.reason`; `message=<text>` (one of the last 5 lines,
contract 2) is shown to the human as `"<button>": <text>` — in the hub language, up to 120 characters, without the button
name. Without `message=` the human only sees "the plugin refused (<code>)". After an action the hub runs the plugin
again (a streamable plugin gets `{"type":"actionResult","id":…,"actionId":…,"primitive":null,"arg":…,"ok":…,"code":…}`
instead — `arg` is the checked value from the offer, `null` without one and for an input action, which adds
`inputLength`; a background action adds `job`), so the new state shows right away: the first frame after an action
reaches the app without the frame-rate wait (section 2).

## 6. Tiers, permissions and consent

### 6.1 Tiers

The tier comes from **where the plugin was installed and who agreed to it**, never from its metadata.

| Tier | How it gets there | Effects | Actions, `push` rules, connections, terminal, hub variables, session registry | Secrets |
|---|---|---|---|---|
| `builtin` | ships with the app (`plugins/`) | any | yes | any key except the reserved `oauth.*` and `telegram.*` |
| `official` | from the signed registry, the index marks the id official | `open.*`, `session.focus`, `terminal.focus` (`cmux.focus`) | yes | `<id>.*` |
| `own` | from your own folder, a human confirmed it in the pinned app | `open.*`, `session.focus`, `terminal.focus` (`cmux.focus`) | yes | `<id>.*` |
| `community` | from the signed registry, not official | `open.*`, `session.focus`, `terminal.focus` (`cmux.focus`) | actions (at least `confirm`, app only) and `push` rules of `kind="plugin"` (label and `macOnly="true"` only); no connections, terminal, hub variables or session registry | `<id>.*` |
| `local` | `Plugins/local` | `open.*` | no | none |

"Trusted" in this guide means `builtin`, `official` or `own`. Events of untrusted plugins still notify, but as "Other"
and without the line text — unless a `community` plugin describes the key with a `kind="plugin"` rule (section 9). Session lines of untrusted plugins are verified only inside their
own frame.

### 6.2 Permissions

The consent window lists every permission with its "why"; a new install always shows it, an update shows it again only
when permissions **grow** (a new `kind:what` key — a new path, host, command, effect, action, connection, tool, terminal
command or loud push rule; changing an action's command, level or `arg` pattern also counts). A changed "why" alone
is not growth. So write the "what" language-neutral and stable — a path, a command, a host — and translate only the
"why".

**Permissions are a promise, not a sandbox.** A plugin is a separate process with a clean environment, but it runs as
your user. The hub enforces effects, actions, secrets, hub variables, connections and the terminal at runtime; `fsRead`,
`fsWrite`, `exec` and `net` are checked by the linter, by the registry reviewer and by the human in the consent window.
Declare everything your code really touches and nothing it does not.

**Forbidden for everyone** (a linter error in metadata and in any file of the plugin, no exceptions by tier):
`~/.claude/projects` (conversation text), `~/.cmuxterm/workstream.jsonl`, `*.key`, `.env*`, `auth.json`, and any path
or mask that covers them — `~/.claude`, `~/.claude/*`, `~/.claude/sessions` as a whole, `/`, `~`. Allowed masks are
narrower: `~/.claude/sessions/*.json`. `exec` tokens that look like paths are checked the same way: `/bin/df -k /` is an
error (`/` covers `~/.claude/projects`), `/bin/df -k` is fine. `..` in a path is an error. In the source text `*.key`
is any string literal ending in `.key` (`"server.key"`, `"tls.server.key"`, `` `${host}.local.key` ``,
`"--key-file=my.site.key"`). SF Symbol names are removed first — the value of `sfimage=` and of a `symbol="…"`
attribute (letters, digits and dots) — so `sfimage=person.badge.key` passes; a bare string such as
`"lock.rectangle.key"` outside those contexts is flagged.

**Loud permissions** (contract 3) are allowed but shown first in the consent window as a red line, and the linter
warns the reviewer:

- `fsWrite` to a **hijack location** — places through which Claude Code or the system can be taken over:
  `claude-code` (all of `~/.claude` except `task-runs` and `backups`, `~/.claude.json`, any project's `.claude` and
  `.mcp.json`), `autostart` (LaunchAgents, cron…), `shell` (`~/.zshrc` and friends), `bin` (directories on `PATH`,
  global npm packages), `terminals` (`~/.cmuxterm`, terminal configs), `ssh`, `git`, `hub` (the Agent Hub directory
  except your own `PluginData/<id>` and `Cache/<id>`). The list is `WRITE_RISKS` in `daemon/lib/registry/perms.mjs`.
  Write there only what the "why" promises: an allowlist of keys, a backup before editing, atomic writes.
- `terminal` `send …` — typing into Claude Code tabs; `send !` (and `#`, `&`) is the loudest (section 8.4).
- for own plugins, `push` rules with `kind="security"` or `quiet="true"` (section 9).

## 7. Environment

The hub starts every run and every action with **only** these variables (nothing from your shell, no `NODE_OPTIONS`):

| Variable | Who gets it | What |
|---|---|---|
| `HOME`, `USER`, `TMPDIR` | all | as usual |
| `PATH` | all | `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` |
| `LANG` | all | always `en_US.UTF-8` (for predictable parsing of program output) |
| `AGENTHUB_LANG` | all | `ru` \| `en` — the hub UI language; format your output in it |
| `AGENTHUB_LOCALE` | all | the system preferred languages, BCP-47, in order (`de-DE,en-US,ru-RU`; may be empty) — for content in a third language (section 10) |
| `AGENTHUB_PLUGIN_ID` | all | your id |
| `AGENTHUB_PLUGIN_DATA_PATH`, `AGENTHUB_PLUGIN_CACHE_PATH` | all | your data and cache directories (section 2) |
| `AGENTHUB_REFRESH_REASON` | all | `FirstLaunch`, `Schedule`, `FileChanged`, `MenuAction`, `Manual`, `LanguageChanged`, `Paused`, `Resumed`, `SecretChanged` (a secret was set or removed in the app), `JobExit` (a background job of a standard plugin ended, section 5.2) |
| `AGENTHUB_PAUSED` | all (contract 3) | `1` — the hub is paused ("Pause hub"), `0` — it is not. No variable — an older hub |
| `OS_PLATFORM`, `OS_VERSION_MAJOR\|MINOR\|PATCH`, `OS_APPEARANCE`, `OS_LAST_SLEEP_TIME`, `OS_LAST_WAKE_TIME` | all | system facts (times in ISO) |
| `AGENTHUB_SECRET_<KEY>` | per tier (6.1) | a declared secret from the keychain |
| `AGENTHUB_HUB_SOCKET` | trusted | the hub socket path, for section 8 |
| `AGENTHUB_USAGE_FILE` | trusted, while the `usage` service runs | the Claude subscription quota cache, `<home>/Cache/usage.json` |
| `AGENTHUB_CLAUDE_SESSIONS_FILE` | trusted, contract 3, while the `sessions` service runs | metadata of live Claude Code sessions, `<home>/Cache/claude-sessions.json` |

On Windows also `USERPROFILE` and the system `SystemRoot`, `windir`, `COMSPEC`, `PATHEXT`, `TEMP`, `TMP`.

**The pause.** Setting and lifting the pause restarts plugins with `AGENTHUB_REFRESH_REASON=Paused|Resumed` (a
streamable one from scratch). The core already refuses actions while paused; the variable is for your own background
work: with `AGENTHUB_PAUSED=1` do not start anything, and without the variable (an older hub) better not either.

**Secrets.** Declare `<agenthub.secrets>tool.token — why</agenthub.secrets>`; the human enters the value on the
plugin page in the app ("Set key…", `PUT /secrets/:plugin/:key`, [`api.md`](api.md), "Secrets") or creates the entry in
the login keychain:

```sh
security add-generic-password -s agent-hub.tool -a token -w
```

The key `<service>.<account>` maps to service `agent-hub.<service>`, account `<account>`, and arrives as
`AGENTHUB_SECRET_TOOL_TOKEN` (non-alphanumerics become `_`). `<service>` is `a-z`, `0-9`, `_`, `-` up to 64 characters
(so any plugin id fits), `<account>` starts with a letter, `a-z`, `0-9`, `_`, `.`, `-`, up to 64. Installed plugins
(official, own, community) get only keys starting with their own id; `local` gets none; `oauth.*` is never given out. A
missing entry means no variable — show "not configured" instead of failing. Never print a secret: output lines go to the
shell, the journal records metadata.

When the value changes: the hub keeps a found value for 5 minutes and a missing one for 1 minute, so an entry made in the
terminal reaches the next run within a minute (or 5 minutes when it replaces a value). A value set or removed in the app
takes effect at once: the hub forgets the cached value and restarts the plugin with `AGENTHUB_REFRESH_REASON=SecretChanged`
(a streamable plugin from scratch, with the new environment). The app accepts printable ASCII without spaces, quotes and
`\`, up to 3072 characters; anything else goes through `security add-generic-password`.

**Service files** (trusted plugins). Do not look for these files yourself: no variable means the service is off or the
hub is older — say "unavailable". Declare the read, and watch it to run right after a write (the hub substitutes the
path):

```
// <agenthub.fsRead>$AGENTHUB_USAGE_FILE — the hub's quota cache: percentages and reset times</agenthub.fsRead>
// <agenthub.watch>$AGENTHUB_USAGE_FILE — fresh quota: show it right away</agenthub.watch>
// <agenthub.fsRead>$AGENTHUB_CLAUDE_SESSIONS_FILE — model and effort of open sessions</agenthub.fsRead>
// <agenthub.watch>$AGENTHUB_CLAUDE_SESSIONS_FILE — a session changed: update the list</agenthub.watch>
```

`usage.json` is `{version: 1, fetched_at, checked_at, error, rows: [{kind, group, percent, severity, resets_at, …}]}`
(times in epoch seconds, `error` a code or `null`, no tokens) — see the built-in `quota` plugin.
`claude-sessions.json` is `{version: 1, updatedAt, sessions: [{sessionId, pid, verified, status, model, modelId,
modelSource, effort, effortSource, ultracode, surfaceId, workspaceId, name, at}]}` — metadata only, no conversation
text; never act on a session with `verified: false`. The fields are described in
[`extension-points.md`](extension-points.md), "Contract 3".

## 8. The hub socket: connections and terminal

Trusted plugins call the plugin APIs of the hub — connections (8.2, 8.3) and the terminal (8.4) — over
`AGENTHUB_HUB_SOCKET` (a Unix socket, HTTP, `Host: hub`). For these routes the hub recognizes the caller **by the peer
pid on the socket**: the request must come from the plugin's own process — a run, the streamable process or an action
process — and a child such as `curl` from a shell plugin is refused (`403 …:not-a-plugin`). In practice that means a node
or python plugin. A background job (5.2) is an action process too.

`AGENTHUB_HUB_SOCKET` is not the boundary — the socket path is no secret. The boundary is the tier: a process of a
**community or local** plugin, its action, or any descendant of them (a `curl`, an `agenthub` call — found by its
parents or its process group, at any depth; the group counts until the run is over, even after its first process
exited, as long as the group has a member) gets only `GET /health` and `GET /peer`; everything else answers `403 peer:untrusted-plugin` and is journaled ([`api.md`](api.md#peer-classes)).
While your plugin is being stopped (it got `{"type":"stopping"}`), its processes are still yours: with the reason
`restart` they keep your trust; with `updated`, `removed` or `policy` they count as an untrusted plugin's until they
exit, so don't call the hub after such a `stopping`.
Processes of trusted plugins keep the plain `cli` view (reading `/state`, `/events`, `/journal`).

### 8.1 A request helper (node)

```js
import { request } from "node:http";

// → { status, body } or { status: 0, error } (the hub did not answer)
export function hubPost(path, payload, timeoutMs = 4000) {
  const socketPath = process.env.AGENTHUB_HUB_SOCKET;
  if (!socketPath) return Promise.resolve({ status: 0, error: "no-socket" });
  const data = JSON.stringify(payload);
  return new Promise((resolve) => {
    const rq = request(
      { socketPath, path, method: "POST", timeout: timeoutMs,
        headers: { Host: "hub", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let s = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (s += c));
        res.on("end", () => {
          let body = null;
          try { body = JSON.parse(s); } catch {}
          resolve({ status: res.statusCode, body });
        });
      },
    );
    rq.on("timeout", () => { rq.destroy(); resolve({ status: 0, error: "timeout" }); });
    rq.on("error", (e) => resolve({ status: 0, error: e.code || "error" }));
    rq.end(data);
  });
}
```

Keep the 5 s budget of a standard run in mind.

### 8.2 Connections: MCP servers behind a hub sign-in

The hub signs into the service with OAuth 2.1 and calls its MCP server for you; the plugin never sees a token.
Declare the connection and the hosts (in a plugin with id `tasks`):

```
// <agenthub.net>mcp.example.com — your tasks via the hub sign-in: the hub makes the requests, read-only</agenthub.net>
// <agenthub.connection id="tasks" type="mcp" url="https://mcp.example.com/mcp" scope="read" title="Example"
//   tools="get_user,filter_tasks" interval="15m" budget="100">your open tasks: read-only</agenthub.connection>
```

- `id` — your plugin id, or `<plugin id>.<name>` (`name`: `a-z`, `0-9`, `-`, starting with a letter, up to 32; the whole
  id up to 64). Up to 4 connections.
- `url` — `https://` on a host name (not an IP), no port or credentials. The `url` host and any extra authorization
  hosts (`hosts="auth.example.com"`) **must be in `<agenthub.net>`**.
- `tools` — the allowlist (1–32); nothing else can be called. `scope` — what to request at sign-in.
- `writes` (optional, hub 0.1.3+) — the tools of that list that change something (`writes="create_task,update_task"`):
  every call of them skips the interval cache as if it carried `fresh: true`. A name not in `tools` rejects the
  declaration.
- `interval` — the same call runs at most once per interval (5 min … 24 h, default 15 min); in between the hub returns
  the previous result. `budget` — calls per rolling day (1…10000, default 100).
- Only `builtin`, `official`, `own`. A new connection or tool is permission growth.

The human connects in the app (the plugin page or "Settings → Connections"). The call — from a run, a streamable
process or an action process (a button the human pressed):

```js
const r = await hubPost("/connections/tasks/mcp", { tool: "filter_tasks", args: { assignee: "me" } });
if (r.status === 409 && r.body?.error === "oauth:not-connected") { /* print "Connect Example" */ }
else if (r.status === 200) {
  const { result, fresh, nextAt, pending, error } = r.body;   // result: the MCP tools/call result (content, structuredContent?)
}
```

Errors: `403 mcp:not-a-plugin|untrusted|not-owner|net-not-declared|tool-not-allowed`, `403 net:none` (the calling action
declares `net="none"`: the hub's proxy is network too), `409 oauth:not-connected|expired|
unavailable`, `413 too-large` (arguments over 8 KB); a slow service gives `pending: true` and the result lands in the
hub's memory for the next call. Details: [`api.md`](api.md), "Connections".

**Writes and read after write.** A call that changes something (create, update, comment) — or a "refresh now" a human
asked for — passes `fresh: true`. Since hub 0.1.3 a write is never served from the cache even without it: a tool
listed in `writes=` and **any call from a foreground action process** (a button the human pressed) count as fresh,
even with `"fresh": false`. A background job reads through the cache like a run — pass `fresh: true` from a job when it
needs a current answer. Older hubs need the flag, so keep passing it:

```js
const w = await hubPost("/connections/tasks/mcp", { tool: "update_task", args: { id, status: "done" }, fresh: true }, 25_000);
if (w.status === 429 && w.body?.error === "mcp:wait") { /* budget or backoff: not sent; w.body.why, w.body.nextAt */ }
else if (w.status === 200 && w.body.ok) { /* done; w.body.result */ }
```

A fresh call skips the interval cache and waits for the service (up to 20 s — give the helper a longer timeout); it still
counts against `budget` and respects the backoff (`429 mcp:wait` — it was **not** sent). Its result is not cached, and a
tool error (`error: mcp:tool-error`, `errorText`) does not slow down your other calls. After a successful fresh call your
cached reads of that connection are stale: the next ordinary call goes to the service and sees the change. Do not use
`fresh` for routine reads — it burns the daily budget.

### 8.3 Connections: any HTTPS API behind a hub sign-in (`type="http"`)

For a service without an MCP server: the hub signs in with OAuth 2.1 using **your pre-registered public client** (no client
secret, no dynamic registration; PKCE S256 and a loopback redirect `http://127.0.0.1:<port>/oauth/callback`) and then
proxies your HTTP requests to the declared API hosts with the bearer token. The plugin never sees the token.

```
// <agenthub.net>auth.example.com — sign-in to Example through the hub</agenthub.net>
// <agenthub.net>api.example.com — your Example items, read and create through the hub</agenthub.net>
// <agenthub.connection id="items" type="http" client_id="Iv1.abc123" authorize="https://auth.example.com/oauth/authorize"
//   token="https://auth.example.com/oauth/token" hosts="api.example.com" scope="items:read items:write"
//   methods="GET,POST" paths="/v1/items" interval="15m" budget="300" title="Example">your items</agenthub.connection>
```

- `client_id` — the public client id the service gave you when you registered the app (1–256 of `A-Z a-z 0-9 . _ ~ : @ +
  = / -`). Register the redirect URI `http://127.0.0.1/oauth/callback` (loopback, any port — RFC 8252 §7.3); a service
  that insists on an exact port: declare `port="53682"` (1024–65535) and register `http://127.0.0.1:53682/oauth/callback`.
  The service must support PKCE (S256) for public clients; the hub never sends a secret.
- `authorize`, `token` — `https://` on host names; `authorize` may carry fixed query parameters (`?access_type=offline`).
- `hosts` — the API hosts (1–8) the hub sends the token to; nothing else gets it. **Every host — `authorize`, `token`,
  `hosts` — must be in `<agenthub.net>`.**
- `methods` — allowed methods (default `GET`; `GET HEAD POST PUT PATCH DELETE`), `paths` — optional path prefixes (1–16).
  Declare only what you use: the consent window and the registry reviewer see both.
- `scope`, `interval`, `budget`, `title`, `id` — as for `mcp`. Only `builtin`, `official`, `own`.

The human connects in the app exactly like an MCP connection. The call:

```js
const r = await hubPost("/connections/items/http", { method: "GET", path: "/v1/items", query: { state: "open" },
  headers: { "Accept": "application/json" } });
if (r.status === 200 && r.body.ok) {
  const { status, headers, body, json, encoding, truncated } = r.body.response;   // the service's answer
}
const w = await hubPost("/connections/items/http", { method: "POST", path: "/v1/items", body: { title: "New" } }, 25_000);
```

- `GET`/`HEAD` are reads: the same request (path, query, headers) goes to the service at most once per `interval`, in
  between you get the previous `response` (`fresh: false`, `nextAt`); `fresh: true` forces a read. Other methods are writes:
  always sent (if the budget and backoff allow — else `429 http:wait`), never cached, and they make your cached reads stale.
- `host` — which declared API host (default: the first). `path` — an absolute path, no `?`/`#`, no dot segments, no
  encoded `/`, `\`, `.` or `%` (`%2F`, `%5C`, `%2E`, `%25`) and no `;`; `query` — an object (values: strings, numbers,
  booleans or arrays of them; not the key `_method`); `body` — a string or JSON (then `Content-Type:
  application/json`), up to 64 KB, not for `GET`/`HEAD`.
- Request headers (an allow-list): `Accept`, `Accept-Language`, `Content-Type`, `If-*`, `Prefer`, `Idempotency-Key`,
  `Range` and API version headers (`Notion-Version`, `X-GitHub-Api-Version`, …); any other header, `X-…` included, is
  refused; never `Authorization`, `Cookie`, `Host`. Response headers: content type/language/range, `ETag`, `Last-Modified`, `Link`, `Location`, `Retry-After`,
  `Cache-Control`, `Date`, `Expires`, rate-limit headers, `X-Total-Count`, `X-Request-Id`. Redirects are not followed
  (you get the 3xx and its `Location`). The body is capped at 256 KB (`truncated: true`); non-text bodies come as base64
  (`encoding: "base64"`); JSON is parsed into `json`.
- Any status from the service is `ok: true` with `response.status` (a 404 is an answer). `401` — the hub refreshes the
  token once and retries, then `409 oauth:expired`; `429` or `503` with `Retry-After` — `error: http:rate-limited` and a
  backoff; `5xx` — `error: http:server-error` (with the `response`); a network failure — `error: http:net`.
- Errors before sending: `403 http:not-a-plugin|untrusted|not-owner|net-not-declared|method-not-allowed|host-not-allowed|
  path-not-allowed|header-not-allowed|query-not-allowed`, `400 args:path:invalid|args:query:…|args:headers:…|args:body:…`, `400 http:not-http`
  (the connection is `mcp`), `409 oauth:not-connected|expired|unavailable`, `413 too-large`.

A hub older than this feature does not know `type="http"`: it skips the tag with a warning (and a registry install refuses
the archive, its permission list differs from the index).

### 8.4 Terminal: Claude Code tabs (contract 3)

Read whether a Claude Code session's input field is empty and the session is free, and type one line into it.

```
// <agenthub.contract>3</agenthub.contract>
// <agenthub.terminal>read-screen — check that the input field is empty before typing</agenthub.terminal>
// <agenthub.terminal>send /model /effort — apply the model and effort you picked</agenthub.terminal>
```

- `read-screen` — flags only; the plugin never gets the screen text.
- `send /cmd …` — slash commands only (up to 16), each followed by at most 3 short arguments from `[A-Za-z0-9._:[]-]`.
- `send *` — any prompt and any slash command, **except** lines starting with `!`, `#`, `&` (Claude Code modes).
- `send !` (or `#`, `&`) — lines starting with that mode character: a separate, loudest permission (`!` runs a shell
  command without Claude Code's permissions). Only if the plugin cannot do without it.

```js
const s = await hubPost("/terminal/read-screen", { sessionId });
if (s.body?.ready) await hubPost("/terminal/send-text", { sessionId, text: "/effort high" }, 25_000);
```

`ready` = the session is idle, in the foreground, its input field is found and empty, no turn running. A line is
printable ASCII without `\`, 1…200 characters, no leading or trailing spaces; the hub presses Enter itself after
checking that the field holds exactly that line. Calls come from a run, a streamable process or a running action (a
human click — 30 s budget; typing may take up to ~20 s, so prefer an action or streamable over a 5 s standard run).
Rate limits: 60 requests and 12 sends per minute per plugin, 4 sends per minute per tab. Do not call anything with
`AGENTHUB_PAUSED=1`.

What to do with refusals: `prompt-not-empty` — the human has a draft (or Claude Code shows a placeholder): show "clear
the input field"; `prompt-mismatch` — **the line was typed but Enter was not pressed**: tell the human, never retry
automatically; `session-busy`, `not-foreground`, `prompt-not-found` — try on the next frame; `unverified`,
`pid-mismatch` — never type into that session; `unsupported` — the session's terminal cannot do it (iTerm2 and
Terminal.app neither read the screen nor type; cmux and tmux do) — the answer names `terminal` and `capability`, do not
retry; timeouts — check `claude-sessions.json` before retrying. The full list is in [`api.md`](api.md), "Terminal". Lines are never journaled, only their length and declared command.

## 9. Notifications

Put `event=<key>` on a line to raise an event while the line is present; when it disappears the event is cleared. The
**line title is the notification text** — metadata only (a task name, a reason), never conversation text or secrets.
An instance suffix after `:` makes separate events per thing: `event=build-failed:release`.

**Trusted plugins** describe their keys with `<agenthub.push>`:

```
// <agenthub.push key="disk-low" kind="plugin" cooldown="1d">Disk almost full</agenthub.push>
// <agenthub.push key="disk-low" lang="ru">Диск почти полон</agenthub.push>
```

| Attribute | Meaning |
|---|---|
| `key` | `[\w.-]{1,64}`; the rule also matches `<key>:<instance>` |
| `kind` | which switch in "Settings → Notifications" controls it: `plugin` — **your own line with the plugin name** (recommended), `problems`, `sessions`, `updates`, `other`; `security` — cannot be turned off, only for tampering signals (the reviewer checks it) |
| `cooldown="7d"` | not more often than this |
| `hold="evening"` | hold until the evening |
| `quiet="true"` | urgent: a banner right away during quiet hours too (otherwise, while the human is away, it waits for the morning digest) |
| `away="5m"` | at the Mac — right away; away — the banner waits until the human is back or the event stays raised that long |
| `macOnly="true"` | the event goes to the Mac banner only, never to the extra channels the human configured (webhook, ntfy, channels of hub services): keep sensitive text (a mail subject) on this Mac. Timing (quiet hours, the digest) is unchanged. Hub 0.1.3+; older 0.1.x hubs accept and ignore it. Community plugins may declare it too |
| `was="runs\|night"` | with `kind="plugin"`: carry over a choice from the contract 1 kinds `runs`/`night` |

Up to 32 rules; the rule without `lang` must come first. Without a rule a key gets the shared table rule with the same
name (`auth-failed`, `source-broken`, `session-waiting`…) or "immediately, kind Other". Keys the core raises itself
(`app-pin-changed`, `hub-update-*`, `plugin-own-unexpected`…) are reserved. A raised key sends one message; clearing and
raising it again within 10 minutes is suppressed as flapping; at most 20 new notifications a minute per plugin.

**What the banner does** (hub 0.1.3+). A click on the banner opens the event line's `href=` (http(s) only, checked like
`open.url`), otherwise your plugin page. Up to 2 direct children of the line with `event=` that carry an offer
(`action=`, `effect=`, `href=`; not `input=` actions — a banner has no text field) become buttons on the banner, labelled
with their titles; pressing one is the same as pressing it on the page — the same gate, and an offer that asks first
brings the app forward with the confirmation sheet. The offers are taken when the banner is sent, so a banner held for the evening carries
the current ones. Both work only when the banner shows your row text (trusted plugins, and community keys described by
a `kind="plugin"` rule); an older hub or app shows the plain banner.

```
Release build 42 failed | event=build-failed:42 href=https://ci.example.com/builds/42 status=block
--Restart | action=restart arg=42
--Hide for an hour | action=snooze arg=60
```

The SSE event `event.raised` carries the same sanitized row text as `title` (up to 120 graphemes), so other consumers —
an app, a subscribed plugin (9.1) — see what was raised without the plugin's frame.

**Community plugins** (hub 0.1.3+): only `kind="plugin"` rules are taken, and only their key and label (with `lang`
variants) — `quiet`, `away`, `hold`, `cooldown` and other kinds are ignored (the linter says so). A key such a rule
describes notifies under the plugin's own switch in Settings, with the reviewed label and the row text; at most 5 a
minute, and during quiet hours it waits for the morning digest. Keys without a rule — as for `local`.

**Local plugins** and community keys without a rule: events arrive as a banner of kind "Other", without the line text,
at most 5 a minute.

### 9.1 Events of other plugins (subscriptions)

A trusted (`builtin`, `official`, `own`, or a test-tier local plugin) **streamable** plugin can react to other plugins'
events — an automation that restarts a failed build, a log that collects what was raised — without polling the hub
socket. Declare what you want, each entry with its "why" (a permission: adding one in an update asks for consent again):

```
// <agenthub.type>streamable</agenthub.type>
// <agenthub.subscribe>builds:failed — restart a failed build once</agenthub.subscribe>
// <agenthub.subscribe>*:deploy — log every deploy event</agenthub.subscribe>
```

- `<plugin id>:<prefix>` — the events of that plugin whose key (`event=<key>` in its output) starts with `<prefix>`;
  an empty prefix (`builds:`) — all its events. `*` instead of the id — every plugin except yours. Up to 16 entries.
- Each change arrives on stdin as one NDJSON line:
  `{"type":"event","plugin":"builds","key":"failed:42","state":"raised","title":"Release build 42 failed"}` and later
  `{"type":"event","plugin":"builds","key":"failed:42","state":"cleared"}`. `key` is the source plugin's own key
  (without the `builds:` prefix the hub's event stream adds); `title` is the sanitized text of the row carrying
  `event=` (up to 120 characters) — another plugin's words: treat it as data, never as a command.
- Right after your process starts or restarts you get `{"type":"eventSnapshot","events":[{"plugin","key","state":"raised","title"?}, …]}`
  with the matching events raised at that moment (always sent, possibly empty) — events raised while you were down are
  in it, so rebuild your state from it.
- At most 600 messages a minute per subscriber; the rest are dropped (journaled), the next snapshot carries the state.
- Untrusted or `standard` plugins: the tag is ignored with a journal warning (the linter warns too).

When your plugin presses buttons over the hub socket (`POST /actions/:id`), the journal names it (`byPlugin`) next to
`peer: cli`. On the live hub that class reaches only what any script may press: effect buttons of the primitives that
are `immediate` and not app-only (`open.*`, `session.focus`, `terminal.focus` — on any plugin's line, or called
directly) and `immediate` actions of the built-in plugins. The actions of every other plugin — your own and the one
whose events you follow included — are app-only at any level and answer `403 peer:cli`, and so do the other
primitives (`job.cancel`, `session.stop`, …). A test hub with
`AGENTHUB_TEST_TIER=own` lets the CLI press its test-tier plugins' actions and stop their jobs (section 1.2), so an
automation that works there may get `403` on the live hub: test it with the targets it will really press.

## 10. Language

- Print in `AGENTHUB_LANG` (`ru` or `en`); without a translation the plugin is shown as is. On a language change the
  hub restarts streamable plugins and runs interval ones out of turn (`LanguageChanged`).
- The hub UI has two languages, `ru` and `en`; a third UI language is out of scope. Your **content** may be in any
  language: `AGENTHUB_LOCALE` has the system preferred languages (`de-DE,en-US,ru-RU`, BCP-47, in order). A reasonable
  rule for your own output: `AGENTHUB_LANG` if you have it, else the first `AGENTHUB_LOCALE` language you have, else your
  default.
- Format numbers and dates yourself: RU «1,2 млн», «05.11 11:00», «пн»; EN "1.2M", "Nov 5, 11:00", "Mon".
- Translate metadata with `lang="xx"`; a tag without `lang` is in the plugin's default language:

```
// <agenthub.title>Disk space</agenthub.title>
// <agenthub.title lang="ru">Место на диске</agenthub.title>
// <agenthub.desc lang="ru">Свободное место на системном диске</agenthub.desc>
// <agenthub.status value="wait" lang="ru" label="Диск почти полон">Свободно меньше 10%</agenthub.status>
// <agenthub.exec lang="ru">/bin/df -k — сколько места свободно</agenthub.exec>      ← only the "why"; adds no permission
// <agenthub.push key="disk-low" lang="ru">Диск почти полон</agenthub.push>
// <agenthub.action id="snooze" … title="Snooze" title-ru="Отложить" cost-ru="…">…</agenthub.action>
```

`lang` takes any BCP-47 tag — `de`, `pt-BR`, `zh-Hant` (also on action attributes: `title-de`, `cost-pt-BR`); a malformed
code is a warning (journal, linter) and the tag is skipped. Which variant the hub shows: the hub language (`ru`/`en`) if
you have it; otherwise the first system language you have, looking through the system list only up to its first `ru`/`en`
entry (so a `ru` hub with a Russian-first system keeps showing your default text, exactly as before); otherwise the tag
without `lang`. A system `de-AT` finds your `de` or `de-DE` variant.

For the registry, official plugins need an English variant of every permission and action.

## 11. Contract versions and compatibility

The hub declares the plugin contract it understands (`agenthub version`, `/state.contract`); a plugin declares the
minimum it needs with `<agenthub.contract>N</agenthub.contract>` (no tag — 1). If the plugin needs more than the hub
has, install and update refuse with "requires a newer hub" instead of installing a plugin that would half-work; an
already installed one keeps running (journal `plugin-contract-newer`).

| Declare | If you use |
|---|---|
| nothing (1) | the basics: output, effects `open.*`, actions, `event=` with core keys |
| `2` | `<agenthub.icon>`, `<agenthub.connection>`, `kind="plugin"`/`was=` on `<agenthub.push>`, `message=` in action output |
| `3` | `AGENTHUB_CLAUDE_SESSIONS_FILE`, `AGENTHUB_PAUSED`, `<agenthub.terminal>`, `session.focus`, `sessionModel=` and friends |

A plugin that can live without a feature may declare the lower version and check for the variable itself (no
`AGENTHUB_CLAUDE_SESSIONS_FILE` — work without session data; no `AGENTHUB_PAUSED` — an older hub, avoid background
work). Contract 1 hubs know neither the tag nor the index field and install anything silently, so the registry
publishes plugins that need a newer contract only after hubs are updated. The details per version are in
[`extension-points.md`](extension-points.md), "Contract versions".

## 12. Shipping: own source and the registry

Both paths run the same checks (`lintPlugin` in `daemon/lib/registry/perms.mjs`): a folder `<id>/` with exactly one
main file `<id>.<interval>.<ext>` (text, a known interpreter), `README.md`, metadata without warnings (`title`,
semver `version`, `author.github`, `platforms`, a "why" on every permission), no forbidden places in any file, no
symbolic links, at most 200 files. `test/`, `fixtures/` and dot files are not shipped.

### 12.1 Own source

For a plugin that belongs to your own tool rather than the public catalog. Keep it in the tool's repository:

```
my-tool/
  agenthub/my-tool/
    my-tool.5m.mjs
    README.md
    test/  fixtures/
```

```sh
"$AH" plugins install --from ~/Projects/my-tool          # the repository root or the plugin folder
```

The command **does not install**: it files a request (valid for a day). A human opens the pinned app → "Plugins" →
"Waiting for confirmation" → "Review and install", sees the consent window (folder, version, content fingerprint,
permissions, the linter's warnings as "Check it yourself") and confirms. Without a pinned app the request is refused
(`own:no-app`); a failed check prints the errors (`own:lint`).

- Only you may write to the folder (no group/world write, no ACLs granting it to others).
- The hub runs its own copy in `Plugins/<id>` and **watches the folder**: an edit with exactly the same permissions is
  installed by itself (journal `plugin-own-updated`); new permissions show "Update · new permissions" and the consent
  window; narrowed permissions or an older version — one "Update" click; a vanished folder — the last copy keeps
  running with a warning. Any process running as you (including an agent in that repository) can edit the folder and
  get its edit installed — the consent window says so.
- Tier `own`: trusted like official — actions (the declared level, `immediate` without a window, app only), push
  rules, hub variables, connections, terminal, secrets `<id>.*`. It never becomes official.

### 12.2 The registry

The public catalog is the monorepo [`agent-hub-plugins`](https://github.com/KenseiTheOne/agent-hub-plugins): a PR with
`plugins/<id>/` (its `CONTRIBUTING.md` has the details, `docs/contract/` a copy of this contract).

```sh
scripts/check.sh --only my-plugin            # the same checks as CI
scripts/check.sh --base origin/main          # plus the permission diff against main
node scripts/build-index.mjs --out /tmp/idx  # what would go into index.json (unsigned)
```

- CI (macOS and Windows, no network, no secrets) parses the metadata with the hub's own parser (vendored), runs the
  linter, runs the plugin once on a synthetic `HOME` from `fixtures/home` with the hub's environment and a 5 s timeout
  (a streamable one must print its first frame), checks the output (no undeclared effects or actions,
  `arg=` matching the pattern) and runs `test/*.test.mjs` (`node:test`, with `HOME`, `AGENTHUB_PLUGIN_FILE`,
  `AGENTHUB_FIXTURES`; no network, no secrets).
- Any change to shipped files needs a new `version`: a published archive is never overwritten.
- Permission growth gets the `permissions` label and a second reviewer.
- After the merge a separate job builds `index.json` (sha256 of every archive, `tier` from `official.json`, which only
  the owner edits), signs it (minisign, Ed25519) and publishes it. The hub installs only from an index signed with the
  registry key, only an archive with the matching sha256 and permissions, and asks for consent. `blocklist.json`
  (inside the signed index) disables a plugin on every hub.
- `community` is the default; `official` is the owner's decision. Fixtures are synthetic: no real session ids, names,
  tokens or conversation text.

## 13. Checklist before you ship

- [ ] The file name parses: `<id>.<interval>.<ext>`, the id is `a-z0-9-`, the folder name equals the id.
- [ ] `title`, semver `version` (bumped for this change), `desc`, `author.github`, `platforms`, `icon`, `contract`.
- [ ] Every permission has a language-neutral "what" and a human "why"; nothing forbidden; nothing undeclared in code.
- [ ] Loud permissions (hijack locations, terminal `send`, `immediate` actions, `security`/`quiet` push rules) are
      really needed and the "why" says exactly what is done.
- [ ] Works with the hub's clean environment (`env -i …`, section 1.3) and with `AGENTHUB_LANG=ru` and `en`.
- [ ] A standard run finishes well under 5 s; a streamable plugin prints its first frame quickly and repeats it.
- [ ] The first header line answers "do I need to do anything?" in plain words; `tile=` is a short value; technical
      details are under `details=true`.
- [ ] Statuses: `wait` only when the human is needed, custom `<agenthub.status>` labels, `status=unknown` +
      `event=source-broken` for an unreadable source, exit ≠ 0 only when the plugin itself broke.
- [ ] Foreign text in titles goes through `escapeTitle` (or `|` → `¦` and no leading `-`/`~` for hubs before 0.1.3),
      foreign values are quoted with `quoteValue` ([4.1](#41-lines)); no secrets or conversation text, no paths to
      secrets; notification lines carry metadata only.
- [ ] Actions: exit 0 on success; refusals print `message=` and `reason=`; a parameterized action has an anchored
      pattern.
- [ ] Hub variables and service files are optional: no variable — say "unavailable", do not search for the file.
- [ ] `AGENTHUB_PAUSED=1` stops your background work.
- [ ] `README.md` explains what the plugin shows, what it needs and its permissions; tests and synthetic fixtures pass
      (`scripts/check.sh --only <id>` for the registry, `agenthub plugins install --from` for an own source).
