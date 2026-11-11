# Writing plugins

A practical guide for plugin authors: how to make a plugin, what it can declare and print, what it gets from the hub,
how to test it and how to ship it. It is the "how to" companion to the reference documents, which stay the source of
truth:

- [`extension-points.md`](extension-points.md) — the plugin contract (metadata, output, environment, contract versions);
- [`plugins-registry.md`](plugins-registry.md) — tiers, consent, the registry and own sources;
- [`api.md`](api.md) — the daemon HTTP API (connections, terminal);
- [`daemon/lib/push/README.md`](../daemon/lib/push/README.md) — notification rules.

Everything below matches the code of contract **3** (`CONTRACT_VERSION` in `daemon/lib/meta.mjs`). The built-in plugins
in [`plugins/`](../plugins) (`quota`, `agents`, `claude-sessions`) are real, complete examples.

## Contents

1. [Quick start](#1-quick-start)
2. [Anatomy of a plugin](#2-anatomy-of-a-plugin)
3. [Metadata tags](#3-metadata-tags)
4. [Output](#4-output)
5. [Effects and actions](#5-effects-and-actions)
6. [Tiers, permissions and consent](#6-tiers-permissions-and-consent)
7. [Environment](#7-environment)
8. [The hub socket: connections and terminal](#8-the-hub-socket-connections-and-terminal)
9. [Notifications](#9-notifications)
10. [Language](#10-language)
11. [Contract versions and compatibility](#11-contract-versions-and-compatibility)
12. [Shipping: own source and the registry](#12-shipping-own-source-and-the-registry)
13. [Checklist before you ship](#13-checklist-before-you-ship)

## 1. Quick start

### 1.1 A first plugin

A plugin is one executable file (or a folder with one) that prints its state to stdout in a SwiftBar-like format. The
hub runs it on a schedule and draws a tile, a page and the menu bar icon from what it printed. Save this as
`hello.1m.sh` (`1m` is the run interval):

```sh
#!/bin/sh
# <agenthub.title>Hello</agenthub.title>
# <agenthub.version>0.1.0</agenthub.version>
# <agenthub.desc>Says hello and shows the time of the last run</agenthub.desc>
# <agenthub.author.github>your-login</agenthub.author.github>
# <agenthub.platforms>macos</agenthub.platforms>
# <agenthub.contract>2</agenthub.contract>
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
| a test hub (`AGENTHUB_HOME=<dir>`, below) | `local` | developing without touching your real hub |
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

- `interval` — a number and `ms|s|m|h|d` (`30s`, `5m`, `2h`); runs are at least 1 s apart.
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
| a change of a watched path → a new run (`FileChanged`) | gets NDJSON on stdin: `{"type":"fileChanged","path":…}`, `{"type":"refresh","reason":…}`, `{"type":"actionResult",…}` |

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

**Data directories.** Every plugin gets two directories of its own, created by the hub: `AGENTHUB_PLUGIN_DATA_PATH`
(`PluginData/<id>`, kept across updates; removed only by "Remove with data") and `AGENTHUB_PLUGIN_CACHE_PATH`
(`Cache/<id>`, removed with the plugin). Keep your state there rather than next to the plugin file: an installed
plugin's folder is exactly the files that were agreed to, and anything extra sends it to quarantine.

## 3. Metadata tags

A tag is `<agenthub.NAME attr="…">value</agenthub.NAME>`, always closed. A multi-line value is joined with spaces (the
comment prefix on continuation lines is dropped). Unknown tags are ignored — including `<agenthub.tier>`: the tier never
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
| `contract` | the minimum plugin contract the plugin needs (section 11) | `<agenthub.contract>2</agenthub.contract>` |
| `icon` | the tile icon: an SF Symbol name and an optional `#RRGGBB`; without it — a grey puzzle piece | `<agenthub.icon symbol="internaldrive" color="#64D2FF"></agenthub.icon>` |
| `status` | your own label for a status value, with an explanation shown as a tooltip | `<agenthub.status value="wait" label="Disk almost full">Less than 10% is free</agenthub.status>` |
| `requires` | an external program the plugin is useless without (up to 8); the catalog shows "Requires …", not a permission | `<agenthub.requires name="Tool" url="https://tool.example.com" check="~/.tool">reads its state</agenthub.requires>` |

**How it runs**

| Tag | What | Example |
|---|---|---|
| `type` | `standard` (default) or `streamable` | `<agenthub.type>streamable</agenthub.type>` |
| `schedule` | a 5-field cron line, for a file without an interval | `<agenthub.schedule>*/10 9-18 * * 1-5</agenthub.schedule>` |
| `watch` | a path or a mask in the last segment; a change starts a run (300 ms debounce). Repeatable | `<agenthub.watch>~/.config/tool/state.json — show a change right away</agenthub.watch>` |

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
| `connection` | an OAuth connection to an MCP server that the hub signs into (section 8) | see 8.2 |
| `terminal` | read a Claude Code tab's input state / type into it (section 8) | `<agenthub.terminal>send /model — apply the chosen model</agenthub.terminal>` |

**Notifications**

| Tag | What | Example |
|---|---|---|
| `push` | a rule for one of your `event=` keys (section 9) | `<agenthub.push key="disk-low" kind="plugin">Disk almost full</agenthub.push>` |

**Translations.** Repeat a tag with `lang="xx"` (section 10): `title`, `desc`, `status`, `push`, `requires`,
`connection` and the "why" of permission entries. Actions use `title-xx=` and `cost-xx=` attributes instead.

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
- **Body** — lines after it. `--` in front adds a nesting level; a `---` line in the body is a separator (`-----` is a
  separator one level down).
- **Parameters** — after the **last** `|` that is followed only by `key=value` pairs; values with spaces go in quotes:
  `key="two words"`. If the text itself contains `|`, the line still parses as long as the tail is not valid
  parameters, but it is safer to replace `|` in titles (the built-in plugins use `¦`).
- **Sanitize what you print**: no newlines inside a title, no leading `-` or `~` (they would read as nesting or a frame
  end), no `---`/`~~~` lines from data. Limits: 2000 lines, 16 KB per line, 1 MB in total.

### 4.2 Parameters

| Parameter | Where | Meaning |
|---|---|---|
| `status=ok\|wait\|block\|error\|unknown` | header (body — a colored dot on the line) | the plugin status (4.4) |
| `tile="…"` | first header line | a short value for the popover tile and the panel badge: "04:30", "2 waiting", "62%". Say what is happening, not "!" — the status icon already shows alarm |
| `tileLabel="…"` | first header line | a short tile caption instead of the plugin name (the tile fits ~110 pt): "Agents" instead of "Background agents" |
| `gauge=0…100`, `gaugeLabel="…"` | first header line — a ring on the plugin page; body — a card with a bar (`note` on the right, children under the bar) | |
| `stat="caption"`, `note="…"` | body | a number card: the line title is the value ("04:30"), `stat` the caption, `note` a line under it; consecutive ones form a row |
| `strip=true` | body | the line's children form a strip of cells (`sfimage`, title, `note`; a cell with an effect is a button): "Recent runs" |
| `details=true` | body | the line's children are collapsed under "Details": process ids, cron lines, internal ids |
| `segment=true`, `select=true` | body | the line's children are the options of a segmented control or a popup button; `selected=true` marks the current one, the others carry `action=`/`effect=`; `note=` on the line is gray text beside the control ([4.3](#43-controls)) |
| `toggle=on\|off` | body | a switch in that state; a click runs the line's own `action=`/`effect=` ([4.3](#43-controls)) |
| `table=true`, `columns="A¦B¦C"` | body | the line's children are table rows: `cells="b¦c"`, `cellColors="¦#FFB454"`, row children as buttons (`icon=true` — icon only) or gray notes, `group=true` subheadings, `header=true` buttons by the title ([4.3](#43-controls)) |
| `activity="…"`, `needsOn="…"` | header | the "can I shut down" verdict (4.5) |
| `event=<key>` | any line | a notification key (section 9) |
| `effect="<primitive> <args>"`, `href=<url>` | any line | a button that runs a core primitive (section 5) |
| `action=<id>`, `arg=<value>` | any line | a button that runs your declared action (section 5) |
| `session=<uuid> pid=<pid>` + `sessionStatus=`, `sessionName=`, … | any line | a line about a Claude Code session; only trusted plugins feed the hub's session registry ([`extension-points.md`](extension-points.md), output table) |
| `sfimage=<SF Symbol>` | any line | the line icon |
| `color=` | any line | the title and icon color, nested lines included: `red`, `green`, `blue`, `orange`, `yellow`, `gray`, `purple`, `pink` or `#RRGGBB` (`#light,#dark` — the first is taken) |
| `iconColor=` | any line | colors only the `sfimage` icon (same palette); the title keeps `color=` or the default |
| `badge="…"` | any line | a small capsule after the title |
| `badgeColor=` | a line with `badge=` | the badge tint (same palette): a light fill with text in that color; without it — the neutral capsule |
| `link=true` | a line with `effect=`/`href=`/`action=` | drawn as a text link instead of a capsule button (panel); same confirmation, gate and tooltip |
| `tooltip="…"` | any line | hover text (the full text of a truncated line is shown anyway) |
| other keys (`font`, `size`, …) | any line | passed to the shell in `params` as is |
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

### 4.4 Status: what it means

| Status | Shared label (without your `<agenthub.status>`) | Use it when |
|---|---|---|
| `ok` | "All good" | nothing to do |
| `unknown` | "No data" | the source is missing or unreadable, not loaded yet |
| `wait` | "Needs attention" | something waits for the human or will soon be a problem |
| `block` | "Blocking" | something is in the way and will not resolve without the human |
| `error` | "Failure" | the plugin itself failed |

- The menu bar icon and `/state.status` show the **worst status of all plugins** (`ok < unknown < wait < block <
  error`): green, grey, orange, red, red. Do not raise `wait` for things that are merely interesting.
- No `status=` in the header — `ok`; empty output — `unknown`; a non-zero exit code — `error` (the printed lines are
  kept and a `plugin-error` notification goes out once until recovery). Print `status=error` with exit code 0 for a
  domain error ("the service rejected the token"); exit non-zero only when the plugin itself broke.
- An unknown shape of your source: print `status=unknown` and `event=source-broken` on that line.
- Give each status you use an unambiguous label with `<agenthub.status>`: "waiting" for a quota and for a session mean
  different things.

### 4.5 "Can I shut down?"

The popover answers whether the Mac can be shut down. A plugin takes part only if its header carries `activity=` or
`needsOn=` (any tier — this is not a permission):

- `activity="Run \"build\" running, 12 min"` — work is in progress right now (the verdict becomes "too early");
- `needsOn="Build at 04:30 — needs the Mac on"` — quiet now, but the Mac is needed later ("OK, but …"; the part before
  " — " goes into the card title for trusted plugins);
- `activity=""` — "I take part, all quiet here": the plugin is listed under "Also checked".

Phrases are cleaned (control characters, newlines) and cut to 120 graphemes; at most 4 per kind. A participant that
fails (exit ≠ 0, timeout, empty output) or goes silent (no frame for 3 intervals, at least 2 min) is shown as
"<plugin>: failure — last: <phrase>". `status=block` does not affect the verdict. Phrases of plugins that are not
built-in or official get a "<plugin name>: " prefix.

## 5. Effects and actions

### 5.1 Effects — core primitives

An effect is a button that asks the core to do something well-defined. The core writes the confirmation text and
checks the arguments itself; the plugin only proposes.

| Effect | Arguments | Who may offer it |
|---|---|---|
| `open.url <url>` | `http(s)` only, no credentials in the URL | everyone (`href=<url>` is the same) |
| `open.file <path> [reveal=true]` | an absolute or `~/` path; documents and plain folders open, anything executable or unknown is refused — only revealed in Finder with `reveal=true` | everyone |
| `session.focus <sessionId>` | a session UUID; the hub finds the terminal tab itself | everyone except `local` (contract 3) |
| `terminal.focus <surfaceId> [workspaceId=…]` | a terminal tab by its id (the `surfaceId` of a session record) — prefer `session.focus` | everyone except `local` |
| `cmux.focus <surfaceId> [workspaceId=…]` | **deprecated** former name of `terminal.focus`: accepted until the next contract — use `session.focus` | everyone except `local` |
| `session.interrupt`, `session.stop`, `session.respond`, `session.launch` | — | built-in plugins only |

Declare what you offer: `<agenthub.effects>open.url,open.file,session.focus</agenthub.effects>` (`open.*` covers both
`open.` primitives). An effect that is not declared, or not under your tier's ceiling, is dropped with a warning. Lines:

```
Open the dashboard | effect="open.url https://status.example.com" sfimage=safari
Show the log | effect="open.file reveal=true ~/Library/Logs/tool.log"
Go to the session | effect="session.focus 3f2c9a1e-7b4d-4c8e-9f10-2a3b4c5d6e7f" sfimage=arrow.up.forward.app
```

`open.url`, `open.file` and `session.focus` run immediately, without a confirmation, and `open.*` keep working while
the hub is paused. `session.focus` refuses with `409 facts:<code>` when the session is not in the hub's registry or no
terminal adapter knows its tab. The hub knows the session's terminal itself (cmux, tmux, iTerm2, Terminal.app — see
[`extension-points.md`](extension-points.md#terminal-adapter-daemonlibterminalsidmjs)), so the same line works in any of them.
Your plugin learns session ids from `AGENTHUB_CLAUDE_SESSIONS_FILE` (trusted plugins, section 7) or from
`~/.claude/sessions/*.json` (with an `fsRead` permission).

### 5.2 Actions — your own commands

An action runs a command of **your** plugin when the human presses a button. Only `builtin`, `official` and `own`
plugins get actions; for others they are a linter error and the core ignores them.

```
// <agenthub.action id="snooze" level="immediate" arg="minutes:^(?:60|240)$" title="Hide the warning for a while" title-ru="Скрыть предупреждение на время">disk.10m.mjs --action snooze {minutes}</agenthub.action>
```

- `id` — `[A-Za-z0-9][\w.-]{0,63}`, unique.
- The text is the command, split into argv **without a shell** (quotes and `\` work, no pipes or variables). The first
  word is your main file name: it runs with the plugin's interpreter, cwd = the plugin folder, the same environment as a
  run (`AGENTHUB_REFRESH_REASON=MenuAction`), a 30 s timeout. `--action <id>` is a convention, not a requirement.
- `level` — `immediate` (no window), `confirm` (default; a window with text the core writes) or `confirm-cost` (a
  window with a price: `cost="…"` says what it spends). The core raises the level: a plugin that declares `net` or an
  action with `cost=` always gets at least `confirm-cost`. An `immediate` action is fine only if it spends nothing at
  the click and the same click undoes it (a toggle); the registry linter flags every one for the reviewer.
- `arg="name:^pattern$"` — a parameterized action. The pattern must be anchored with `^` and `$` (up to 200 characters).
  The value comes from the output line (`action=snooze arg=60`), never from the click request; the core checks it against
  the pattern, rejects empty values, values over 256 characters, control characters and a leading `-`, and passes it as
  a separate argv element in place of `{name}` (or at the end).
- Non-built-in actions are pressed only by a human in the app; the CLI and agents cannot trigger them. Every run is
  journaled. While the hub is paused, actions are refused (423).
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
again (a streamable plugin gets `{"type":"actionResult","actionId":…,"ok":…,"code":…}` instead), so the new state shows
right away.

## 6. Tiers, permissions and consent

### 6.1 Tiers

The tier comes from **where the plugin was installed and who agreed to it**, never from its metadata.

| Tier | How it gets there | Effects | Actions, `push` rules, connections, terminal, hub variables, session registry | Secrets |
|---|---|---|---|---|
| `builtin` | ships with the app (`plugins/`) | any | yes | any key except `telegram.*`, `oauth.*` |
| `official` | from the signed registry, the index marks the id official | `open.*`, `session.focus`, `terminal.focus` (`cmux.focus`) | yes | `<id>.*` |
| `own` | from your own folder, a human confirmed it in the pinned app | `open.*`, `session.focus`, `terminal.focus` (`cmux.focus`) | yes | `<id>.*` |
| `community` | from the signed registry, not official | `open.*`, `session.focus`, `terminal.focus` (`cmux.focus`) | no | `<id>.*` |
| `local` | `Plugins/local` | `open.*` | no | none |

"Trusted" in this guide means `builtin`, `official` or `own`. Events of untrusted plugins still notify, but as "Other",
on the Mac only and without the line text (section 9). Session lines of untrusted plugins are verified only inside their
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
error (`/` covers `~/.claude/projects`), `/bin/df -k` is fine. `..` in a path is an error.

**Loud permissions** (contract 3) are allowed but shown first in the consent window as a red line, and the linter
warns the reviewer:

- `fsWrite` to a **hijack location** — places through which Claude Code or the system can be taken over:
  `claude-code` (all of `~/.claude` except `task-runs` and `backups`, `~/.claude.json`, any project's `.claude` and
  `.mcp.json`), `autostart` (LaunchAgents, cron…), `shell` (`~/.zshrc` and friends), `bin` (directories on `PATH`,
  global npm packages), `terminals` (`~/.cmuxterm`, terminal configs), `ssh`, `git`, `hub` (the Agent Hub directory
  except your own `PluginData/<id>` and `Cache/<id>`). The list is `WRITE_RISKS` in `daemon/lib/registry/perms.mjs`.
  Write there only what the "why" promises: an allowlist of keys, a backup before editing, atomic writes.
- `terminal` `send …` — typing into Claude Code tabs; `send !` (and `#`, `&`) is the loudest (section 8.3).
- for own plugins, `push` rules with `kind="security"` or `quiet="true"` (section 9).

## 7. Environment

The hub starts every run and every action with **only** these variables (nothing from your shell, no `NODE_OPTIONS`):

| Variable | Who gets it | What |
|---|---|---|
| `HOME`, `USER`, `TMPDIR` | all | as usual |
| `PATH` | all | `~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` |
| `LANG` | all | always `en_US.UTF-8` (for predictable parsing of program output) |
| `AGENTHUB_LANG` | all | `ru` \| `en` — the hub UI language; format your output in it |
| `AGENTHUB_PLUGIN_ID` | all | your id |
| `AGENTHUB_PLUGIN_DATA_PATH`, `AGENTHUB_PLUGIN_CACHE_PATH` | all | your data and cache directories (section 2) |
| `AGENTHUB_REFRESH_REASON` | all | `FirstLaunch`, `Schedule`, `FileChanged`, `MenuAction`, `Manual`, `LanguageChanged`, `Paused`, `Resumed` |
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

**Secrets.** Declare `<agenthub.secrets>tool.token — why</agenthub.secrets>`; the human creates the entry in the login
keychain:

```sh
security add-generic-password -s agent-hub.tool -a token -w
```

The key `<service>.<account>` maps to service `agent-hub.<service>`, account `<account>`, and arrives as
`AGENTHUB_SECRET_TOOL_TOKEN` (non-alphanumerics become `_`). Installed plugins (official, own, community) get only keys
starting with their own id; `local` gets none; `oauth.*` is never given out. A missing entry means no variable — show
"not configured" instead of failing. Never print a secret: output lines go to the shell, the journal records metadata.

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

Trusted plugins can call two hub APIs over `AGENTHUB_HUB_SOCKET` (a Unix socket, HTTP, `Host: hub`). The hub
recognizes the caller **by the peer pid on the socket**: the request must come from the plugin's own process — a child
such as `curl` from a shell plugin is refused (`403 …:not-a-plugin`). In practice that means a node or python plugin.

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
- `interval` — the same call runs at most once per interval (5 min … 24 h, default 15 min); in between the hub returns
  the previous result. `budget` — calls per rolling day (1…10000, default 100).
- Only `builtin`, `official`, `own`. A new connection or tool is permission growth.

The human connects in the app (the plugin page or "Settings → Connections"). The call — from a run or a streamable
process (not from an action):

```js
const r = await hubPost("/connections/tasks/mcp", { tool: "filter_tasks", args: { assignee: "me" } });
if (r.status === 409 && r.body?.error === "oauth:not-connected") { /* print "Connect Example" */ }
else if (r.status === 200) {
  const { result, fresh, nextAt, pending, error } = r.body;   // result: the MCP tools/call result (content, structuredContent?)
}
```

Errors: `403 mcp:not-a-plugin|untrusted|not-owner|net-not-declared|tool-not-allowed`, `409 oauth:not-connected|expired|
unavailable`, `413 too-large` (arguments over 8 KB); a slow service gives `pending: true` and the result lands in the
hub's memory for the next call. Details: [`api.md`](api.md), "Connections".

### 8.3 Terminal: Claude Code tabs (contract 3)

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
| `quiet="true"` | also during quiet hours |
| `away="5m"` | Telegram if the human is away and the event stays raised that long |
| `macOnly="true"` | never to Telegram |
| `was="runs\|night"` | with `kind="plugin"`: carry over a choice from the contract 1 kinds `runs`/`night` |

Up to 32 rules; the rule without `lang` must come first. Without a rule a key gets the shared table rule with the same
name (`auth-failed`, `source-broken`, `session-waiting`…) or "immediately, kind Other". Keys the core raises itself
(`app-pin-changed`, `hub-update-*`, `plugin-own-unexpected`…) are reserved. A raised key sends one message; clearing and
raising it again within 10 minutes is suppressed as flapping; at most 20 new notifications a minute per plugin.

**Untrusted plugins** (`community`, `local`): `<agenthub.push>` is ignored; events go to macOS only, kind "Other",
without the line text, at most 5 a minute.

## 10. Language

- Print in `AGENTHUB_LANG` (`ru` or `en`); without a translation the plugin is shown as is. On a language change the
  hub restarts streamable plugins and runs interval ones out of turn (`LanguageChanged`).
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
  (a streamable one must print its first frame), checks the output (no undeclared effects, actions only for official,
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
- [ ] Printed titles are sanitized (no `|`, newlines, leading `-`/`~`), no secrets or conversation text, no paths to
      secrets; notification lines carry metadata only.
- [ ] Actions: exit 0 on success; refusals print `message=` and `reason=`; a parameterized action has an anchored
      pattern.
- [ ] Hub variables and service files are optional: no variable — say "unavailable", do not search for the file.
- [ ] `AGENTHUB_PAUSED=1` stops your background work.
- [ ] `README.md` explains what the plugin shows, what it needs and its permissions; tests and synthetic fixtures pass
      (`scripts/check.sh --only <id>` for the registry, `agenthub plugins install --from` for an own source).
