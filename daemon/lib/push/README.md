# Push (stage 4)

The `lib/services/push.mjs` service listens on the bus for `event.raised` / `event.cleared` (key `<pluginId>:<key>` from
`event=<key>` in plugin output, plus `plugin-error` from the core) and decides when to call the human. Delivery goes through a
channel list (below "Channels"): the macOS banner (the shell's, or `osascript` without it) always, plus the channels from
`services.push.channels` and those other services register; quiet hours hold banners for a morning digest.

| Module | What |
|---|---|
| `engine.mjs` | dedup, quiet hours, digest, evening blocker, a waiting session's delayed banner, presence |
| `rules.mjs` | the event table (design section 6), the kind of every rule (`kind`, `kindOf`) |
| `prefs.mjs` | "Settings → Notifications": kinds, the master switch, quiet hours from `settings.json`, edits via `PUT /settings/notifications` |
| `clock.mjs` | local time in a given time zone (Intl), quiet hours, the "night day" |
| `idle.mjs` | HID idle time: `ioreg -c IOHIDSystem -d 4` → `HIDIdleTime` |
| `macos.mjs` | `push.notify` on the bus → the shell; without an acknowledgement — `osascript display notification` |
| `channels.mjs` | the channel set the engine sends through: `mac` first, then webhook/ntfy from `config.json` and registered channels; routing by kind, security banners only to `security: true` |
| `acks.mjs` | waiting for `POST /push/ack` (route `lib/routes/push.mjs`) |
| `store.mjs` | `<home>/push-state.json` (0600): what was sent, the digest queue |
| `config.mjs` | `services.push` from `config.json` over the defaults; unknown keys are ignored (`push-config-ignored`) |

## Event keys for plugins

A rule is chosen by the key without the plugin id: an exact name/alias, or a name plus an instance suffix after `:`,
`.`, `/`, `-` (`session-waiting:<sessionId>`, `build-blocked:<what>`). The message text is the title of the output
line that carries `event=` (up to 160 characters, no control characters); the subtitle is the plugin name plus the
rule label ("Mail · message not sent"): a leading "<plugin name>:" is cut from the label, and if the detail already says
the same (≥ 60 % of the label's significant words), the subtitle is only the name ("Quota" · "At this pace 85% will be
reached Sun 08.11 12:36 — before the reset"). With no detail, the label becomes the body. **The title of such a line
must contain metadata only**: a task name, a tab, a reason; no conversation text, no `tool_input`, no paths to secrets.

**A plugin's own rules.** A plugin declares rules for its own keys with a tag in its metadata:

```
# <agenthub.push key="build-blocked" hold="evening" cooldown="0s" kind="plugin">Сборка не запустится</agenthub.push>
# <agenthub.push key="crashed" quiet="true" kind="plugin">Упало</agenthub.push>
# <agenthub.push key="service-silent" away="5m" kind="plugin" was="runs">Молчит</agenthub.push>
# <agenthub.push key="service-silent" lang="en">Silent</agenthub.push>
```

`hold="evening"`, `quiet="true"` (urgent: shown right away during quiet hours too, not held for the digest),
`cooldown=<interval>`, `away=<interval>` (at the Mac — right away; away — the banner waits until the human is back or the
event stays raised that long), `macOnly="true"` (the Mac banner only, never the extra channels below — keep sensitive
text such as a mail subject on this Mac; quiet hours and the digest work as usual; hub 0.1.3+, community plugins too),
`kind=<kind>` (the switch in
"Settings": a shared core kind `sessions`, `updates`, `problems`, `other`; `plugin` — **the plugin's own toggle** (a
line with the plugin name in "Settings → Notifications"); `security` — a security exception, cannot be turned off; an
unknown value is a parse warning and the rule is dropped), `was=runs|night` (only with `kind="plugin"`: the former
contract 1 kind — if the user turned it off, it turns this toggle off, see "Migration" below); the tag text is the label
(up to 80 characters). The deprecated `kind="runs"` and `kind="night"` (contract 1) are accepted as
`kind="plugin" was="<kind>"`, and the linter warns. The service takes such rules **only from built-in, official and
own** plugins (`trusted`: the tier comes from the signed registry index or from the human's consent to an own plugin
from a folder — [`docs/plugins-registry.md`](../../../docs/plugins-registry.md), "Own sources"); they go ahead of the
shared table. A **community** plugin's `kind="plugin"` rules are taken with their key, label and `macOnly="true"` only (hub 0.1.3+;
`macOnly` only narrows delivery, so it is allowed; `quiet`, `away`, `hold`, `cooldown` and other kinds are ignored): such a key notifies under the plugin's own toggle with the
reviewed label and the row text, within the third-party limits below. `local` plugins' tags are ignored. This way the core knows no plugin's keys: official plugins' rules live in
their metadata (registry `agent-hub-plugins`), own plugins' rules in their metadata in the tool's repository; built-in
plugins (`agents`, `claude-sessions`) declare theirs the same way. For an own plugin, rules with `kind="security"` and
`quiet="true"` are `push` permissions: they are shown in the consent window, and their appearance is a permission
increase (not a silent update from the folder).

The shared table (`rules.mjs`) contains only the core's shared keys (since contract 2 it no longer has `blocker`,
`session-died`, `workflow-failed`, `workflow-orphaned` or the quota keys: the plugins that need them declare them —
`claude-sessions` (`died`), `agents` (`wf-failed`, `wf-orphaned`), `quota` (`week-80` and `pace-85` — at most once a
week, `token-lost` — immediately; all of them "failures and warnings"), `spend` (`daily-over` — today's cost passed the
threshold picked on its page, once a day, its own switch)):

| Key | When it is sent |
|---|---|
| `session-waiting` (`waiting:<sessionId>` in claude-sessions) | at the Mac — a banner immediately; away — once the human is back or after 5 min, whichever comes first (during quiet hours — the digest); no flap window |
| `auth-failed` | immediately |
| `source-broken`, `plugin-error` | once until recovery |
| `approvals-paused` (source `@hub`) | immediately |
| `app-pin-changed` (source `@hub`) | immediately and during quiet hours, on every change of `requirements.app` (no flap window); at the Mac — always `osascript`, without `push.notify` and `/push/ack` (`bannerAlways`); the text says where the pin came from (`из Claude Code` — capitalized at the start) |
| `app-pin-path-changed` (source `@hub`) | immediately and during quiet hours, on every change of `appPin.path` with the same requirement (the bundle the daemon launches); at the Mac — always `osascript` (`bannerAlways`); "The path of the pinned Agent Hub build changed — the daemon now launches <path>. If it wasn't you, open the journal" |
| `plugin-update:<id>:<version>` (source `@hub`) | a new version of an installed plugin in the signed catalog, once per version ("Update available: Mail 0.4.0") |
| `plugin-own-updated:<id>:<version>` (source `@hub`) | an own plugin was updated from its folder automatically (same permissions, no consent window): "Plugin updated — "Mail" updated to 0.4.0" (or "updated from its folder (version …)" when the version stayed); every such update, no flap window; kind `updates` |
| `app-restart-stopped` (source `@hub`) | immediately, once per episode of the supervisor stopping (app service: the app crashed 3 times in 10 min or 3 checks in a row could not launch it — `why`); again only after the app has opened the event stream and the stop is cleared; at the Mac — always `osascript` (`bannerAlways`: there is no app to acknowledge); "Agent Hub keeps crashing — restarts stopped: 3 restarts in 10 min. Open Agent Hub yourself; details — agenthub logs" (with `why` — "Cannot launch Agent Hub (<why>)…") |
| anything else | immediately, labeled "Event "key"" |

In general: while a key is raised there is one message; cleared and raised again within 10 min after sending — it is
suppressed (flapping). Events of **third-party** plugins (`trusted: false`) arrive without their text and without their
rules, labeled "Event "key"" — except community keys described by a `kind="plugin"` rule (above).

Limits (protecting the daemon from an event flood): at most `maxPerPluginPerMin` (20) new notifications per minute from
one trusted plugin and `maxPerUntrustedPerMin` (5) from a third-party one; the first one over the limit produces a
single notification "notifications from the plugin are muted for a minute" (`push-throttled` in the journal) — it goes where the rule goes: a `macOnly` rule's notice stays on the Mac — the
other events are only remembered. Entries (keys) per plugin — at most `maxEntriesPerPlugin` (500) /
`maxEntriesPerUntrusted` (100): beyond that the longest-cleared ones are evicted, and if all are raised the new key is
not remembered (`push-dropped`: the first refusal in a minute is recorded immediately, the rest as one `push-dropped`
summary with `dropped: N` when the minute ends). Hub events (`@hub`) have no such limits. `push-state.json` is written
once per batch of events (when the queue is empty, at least every 2 s); the queue yields the event loop between
operations.

## Switches — "Settings → Notifications" (2026-11-09)

Stored in `<home>/settings.json → notifications` (`{enabled, kinds: {<kind>: bool}, quiet: {enabled, start, end} | null}`),
written only by the app class (the pinned build) via `PUT /settings/notifications`
([`docs/api.md`](../../../docs/api.md)); the service picks up changes on `settings.changed` without a restart.

| Kind | Core rules | Plugins (`kind=` in the tag) |
|---|---|---|
| `sessions` — waiting for an answer / session questions | `session-waiting`, `approvals-paused` | — |
| `updates` — hub and plugin updates | `plugin-update`, `plugin-own-updated`, `hub-update`, `hub-update-ready`, `hub-update-installed`, `hub-update-failed` | — |
| `problems` — plugin failures and warnings | `source-broken`, `plugin-error`, `auth-failed` (and plugin rules with `kind="problems"`, for example quota) | a rule with `kind="problems"` or a key from the table (`auth-failed`) |
| `other` — everything else from plugins | a key without a rule; events of third-party plugins (except community keys with a `kind="plugin"` rule) | a rule without `kind` and without a match in the table |
| `plugin:<id>` — **the plugin's own toggle** | — | rules with `kind="plugin"` (and the deprecated `kind="runs"`/`"night"`; a community plugin's `kind="plugin"` labels too): a line in "Settings" with the plugin name, only while the plugin is installed |
| `security` — **cannot be turned off** | `app-pin-changed`, `app-pin-path-changed`, `app-restart-stopped`, `hub-update-tag-moved`, `hub-update-suspect` | rules with `kind="security"` (tampering signals) |

**The plugin's own toggle** (contract 2). `settings.json → pluginNotifications.plugins` holds `{<id>: bool}`;
`/state.notifications.plugins` has lines `{id, title, on, labels, legacy?}` for installed trusted and community plugins
that have a `kind="plugin"` rule. The title is in the hub language (from `<agenthub.title lang=…>`), `labels` are the labels of its
rules. No plugin — no line; the value in `settings.json` stays (if the plugin comes back, the same choice applies).
The master switch also silences plugin toggles; they do not affect `security`.

**Migrating contract 1 settings.** Before 2026-11-09 `settings.json` had the kinds `runs` ("Agent runs") and `night`.
The core no longer knows them, but the user's choice is not lost:

1. Turned-off `kinds.runs/night = false` stay in `settings.json → notifications.kinds` as they are — the core sees
   them as "a former kind is off" (`legacy` in memory); `true` means nothing (it is on by default anyway).
2. A plugin toggle without an explicit value is off if at least one of its rules declared a turned-off former kind:
   `kind="night"`/`kind="runs"` (deprecated synonym) or `kind="plugin" was="night"|"runs"`. The built-in `agents` and
   `claude-sessions` declare `was="runs"` — before 2026-11-09 their events used the "Agent runs" kind.
3. As soon as the core sees such a plugin, it fixes the inferred value as an explicit `plugins.<id> = false` with a
   `migrated.<id>` mark (journal `settings-migrated {plugin, from}`, event `settings.changed`): from then on the plugin
   may change `kind="night"` to `kind="plugin"` without `was=` and the choice is kept. Migration never touches an
   explicit human choice; a line inferred from migration has `legacy: true` ("Turned off by an earlier notification
   setting") until the human touches it.
4. **Once only.** After the first full plugin scan (`host.start` → `core.pluginsScanned`) the core records which plugins
   the migration applies to (`pluginNotifications.legacyFor` — ids of the plugins installed at that time; journal
   `settings-migrated {legacyFor}`). A plugin installed later is not turned off by the old setting, even if it declares
   `was=`.
5. `PUT /settings/notifications` with `kinds.runs|night` — `400 args:kinds:enum`; a digest item from a pre-migration
   file with kind `runs`/`night` counts as "other".

**A hub rollback** (`agenthub hub rollback` to a contract 1 core) keeps the choice: in `settings.json` the turned-off
`runs`/`night` live in `notifications.kinds`, where the old core reads them (its "Runs" and "Night" stay silent), and
the plugin toggles and migration marks live in a separate top-level key `pluginNotifications {plugins, migrated,
legacyFor}`: the old core does not normalize it and keeps it as is when it writes `settings.json`. After updating again
the choice is in place. If the human turned a former kind back on in the old hub, the new core drops the "off" values
inferred from it (`migrated`), while explicit choices stay.

The kind of a plugin rule without `kind` is the kind of the shared-table rule with the same key (`auth-failed` →
`problems`), otherwise `other`. Only the core and a trusted plugin set kinds; `services.push.rules` in `config.json`
does not change the kind, and a third-party plugin cannot declare `security` (a community plugin's rules are taken only as `kind="plugin"` labels, a local plugin's not at all). The
`security` kind from the core table applies only to the hub's own events (`@hub`): a plugin that raises a core key
(`app-restart-stopped` and the like) gets a rule without a kind, without `bannerAlways`, `quietException` and the hub
label — a trusted plugin declares a security exception only with its own `<agenthub.push kind="security">` tag (the
registry linter warns about such a tag and about core keys).

**`config.json` does not override security exceptions**: `services.push.rules` is not applied to rules of kind
`security` (core or trusted plugins) — no `hold`, no `awayDelayMs`, no `cooldownMs`, no `label`, no new alias that
hijacks a core key. The only way to silence them is to turn off the whole service (`services.push.enabled = false`),
and "Settings → Notifications" warns about that.

- **A turned-off kind goes nowhere**: no `push.notify` to the shell, no fallback `osascript`, no digest item; the journal gets `push-muted {key, rule, kind, reason: "kind"|"all"}` without text. The event stays in the
  plugin state (popover, plugin page) and in the journal. Raising it does not consume the plugin rate limit and does not
  produce "notifications muted".
- The decision is made when the event is raised and before every deferred send: the evening blocker waited for 21:00, a
  waiting session for idleness, an item for the morning digest (`push-muted {key: "digest", count}`). Off at send time —
  not sent; turned off while waiting but on again by send time — sent as usual (`push-muted` once per "off"). Raised
  while the kind was off — not re-sent after it is turned on (the next state will arrive). A digest item without `kind`
  (a file from before 2026-11-09) gets its kind from the key.
- The master switch (`enabled: false`) silences all kinds except `security`.
- **Why `security` cannot be turned off**: these are signals of possible tampering (the app re-pinned, the build path
  changed, a release tag moved, a tampering signal declared by a plugin) and of app restarts being stopped. Settings are
  changed by the app class — that is, by the very build the pin notification is about; a switch for such events would be
  the first thing a swapped build flips. So they are neither under the master switch nor among the kinds (`PUT` with
  `kinds.security` — `400 args:kinds:enum`), and the banner for hub events still bypasses the shell (`bannerAlways`).
- **Quiet hours** — `quiet` in settings; until it is set, `services.push.quietStart/quietEnd` from `config.json` apply
  (as before 2026-11-09), and without them 23:00–08:00 (`/state.notifications.quiet.from`: `settings` | `config` |
  `default`). The first edit in "Settings" starts from the effective values. `quiet.enabled: false` — at night everything
  takes the normal route (a banner immediately, no digest); the evening blocker and the "night day" are computed from the
  same bounds. `quietStart == quietEnd` in `config.json` (formerly "no quiet hours") is shown as quiet hours turned off
  with bounds 23:00–08:00. The blocker's evening window runs from `eveningAt` to the start of quiet hours, only if that
  is in the evening (no longer than 12 h): quiet hours from 20:00 with `eveningAt` 21:00 give no window, and the blocker
  waits for the night to start.

## Routing

- HID idle < 10 min or unknown — a macOS notification: event `push.notify`
  `{notifyId, title, subtitle, body, plugin, key, digest, actions, href}` on the bus and SSE. The shell shows a banner
  (`UNUserNotificationCenter`; a click opens `href` when given, otherwise the plugin page in the panel; `actions` become
banner buttons, without them — the plain "Open" button) and answers `POST /push/ack {"id": notifyId}`.
  `actions` — up to 2 buttons `{offer, label, level}`: the offers of the direct children of the line with `event=`
  (no typed-input offers), asked from the plugin's current frame at send time (an event held for the evening gets the live
  offers); `href` — the event line's `href=` when `open.url` accepts it (http/https), the banner click target. Both only when
  the banner shows the row text (trusted plugins, a community event its reviewed rule describes); otherwise `[]` / `null`.
  No answer within 3 s — the daemon shows the banner itself via `osascript` (the text goes as arguments, not inside the
  script text). The exception is a rule with `bannerAlways` (only the built-in `app-pin-changed`, `app-pin-path-changed`
  and `app-restart-stopped`; this field can be neither set nor cleared through `config.json` or plugins): `osascript`
  right away, nothing goes to the shell. Acknowledgements are accepted from the app class, and right after a re-pin, app
  is the very build the pin notification is about.
- Idle ≥ 10 min (`idleThresholdMs`) — the human is away. Outside quiet hours a banner still shows right away (it waits in
  Notification Center); a rule with `awayDelayMs` (`session-waiting`, a plugin's `away=`) waits until the human is back
  at the Mac (checked on every tick) or the delay has passed, then shows one banner.
- Quiet hours (23:00–08:00 by default, "Settings") while away: only `quietException` shows right away (pin and path
  changes, a moved tag, `hub-update-suspect`, `hub-update-failed`, and for plugins `quiet="true"`); everything else is
  held (`push-deferred`), including `app-restart-stopped` and update notices, and goes out as **one digest banner**
  ("Overnight: N", the bodies in a row) on the first tick after quiet hours end. At the Mac during quiet hours banners
  show as usual. Before 2026-11-11 the hub had a chat-bot channel; it is removed, and its old `services.push.*` keys in
  `config.json` are ignored (one `push-config-ignored {keys}` journal line at startup); channels are now `channels` (below).
- Time is in the `services.push.timezone` zone (the system one by default: the service checks it on every tick and
  writes `push-timezone` to the journal when it changes); DST transitions follow wall-clock time. The zone is exposed
  in `/state.notifications.quiet.timezone`, the idle threshold in `awayAfterMs`.
- A hub update failure that looks like tampering (`commit-mismatch`, `not-on-main`, `untrusted-build`, `verify-failed`,
  `tag-moved`) uses the key `hub-update-suspect:<label>` (`security`); other failures use `hub-update-failed:<label>`
  (`updates`).

## Channels

The engine calls one `notify(msg)`; `channels.mjs` sends it to the macOS notifier (always, first — its acknowledgement is what
the engine tracks) and in the background to every extra channel that accepts it:

- `services.push.channels` — `[{type: "webhook"|"ntfy", url, id?, label?, events?, security?, enabled?}]`; `url` — `https://`,
  or `http://` only to `localhost`/`127.0.0.0/8`/`[::1]`; no redirects, a 10 s timeout; a bad entry →
  `push-channel-invalid {index, reason}` (an ntfy URL whose topic has a broken `%` escape — `ntfy-topic`); a bad channel
  is left out on its own, never the whole set. The URL is never journaled (it often carries a secret).
- a service: `ctx.facts.get("push.channels")?.register({id, label?, security?, events?, send(payload)}) → unregister`.
- routing: the kind `security` and `bannerAlways` rules go only to channels with `security: true` — also when they were held
  overnight: the morning digest goes to extra channels without them, and they follow as a separate kind `security`
  message (subtitle "Overnight: N", key `push:digest`) for security channels only; the Mac banner lists everything. `events` narrows to kinds
  (`sessions`, `updates`, `problems`, `other`, `plugin`, `security`, `hub`, `digest`) or key prefixes `<plugin>:<key>*`.
  A rule with `macOnly` (the plugin tag or `services.push.rules`) goes to `mac` only, security channels included (its "notifications muted" notice too); held
  overnight, its item is in the Mac digest banner and left out of what extra channels get.
- visible: `/state.notifications.channels` (and Settings → Notifications in the app) lists every channel — `id`, `type`,
  `label`, `security`, `events`, never its URL.
- payload: `{source: "agent-hub", title, subtitle, body, plugin, key, kind, digest, href, ts}` (no `actions`: offer ids are for
  the shell). Everything the engine decides — quiet hours, digest, switches, limits — applies before any channel.
- failures: `push-channel-error {channel, key, code}`; `push-sent`/`push-digest` carry `also: [channel ids]`.

Details and examples — [`docs/extension-points.md`](../../../docs/extension-points.md), "Push channel".

## Settings (`services.push` in `<home>/config.json`)

`timezone`, `quietStart` ("23:00"), `quietEnd` ("08:00") — fallbacks only, until quiet hours are set in "Settings"
(above), `eveningAt` ("21:00"), `idleThresholdMs` (600000),
`ackTimeoutMs` (3000), `acceptCliAck` (false), `tickMs` (30000), `flapCooldownMs` (600000),
`staleGraceMs` (600000), `digestMaxItems` (30), `maxPerPluginPerMin` (20), `maxPerUntrustedPerMin` (5),
`maxEntriesPerPlugin` (500), `maxEntriesPerUntrusted` (100), `rules` — overrides/additions to the table:
`{"my-key": {"label": "…", "hold": "evening"}}` (fields `label`, `hold`, `awayDelayMs`, `quietException`, `cooldownMs`,
`macOnly`, `aliases`). Plugin rules from `<agenthub.push>` go ahead of this table, but user overrides apply to them too:
`{"service-silent": {"awayDelayMs": 0}}` (by rule name) or `{"<plugin>:service-silent": {…}}` (for that plugin only) —
the fields are layered over the plugin rule. `channels` — extra delivery channels (above). `enabled: false` — the service does not start. Any other key is ignored
(journal `push-config-ignored {keys}` once at startup).

## Journal

Message text never reaches the journal: only `push-start {…, channels}`, `push-sent {key, channel: "mac", rule, also?}`, `push-held`,
`push-deferred`, `push-suppressed`, `push-digest {count, channel: "mac", also?}`, `push-error {channel, code}`,
`push-channel-invalid {index, reason}`, `push-channel-registered {channel, security}`, `push-channel-error {channel, key, code}`,
`push-muted {key, rule, kind, reason}`, `push-throttled`, `push-dropped`, `push-timezone`, `push-config-ignored {keys}`.
