import Foundation

// Interface decisions that are tested without AppKit: the menu bar icon look, the test copy label,
// the plugin author, version ordering.

// MARK: - menu bar icon

/// What the menu bar icon shows (a cop bot in a peaked cap, `app/Resources/MenuBar/`). The emblem on the cap:
/// - `.calm` — a cut-out (the whole image is a template, macOS tints it);
/// - `.waiting` — the emblem is filled with system orange, and next to it as text — the number waiting: sessions awaiting a reply and
///   question cards (PermissionRequest, replies); plugins' `status=wait` doesn't tint the icon (popover, sidebar);
/// - `.blocked` — the emblem is red (the worst status block/error), the number waiting is shown next to it the same way;
/// - `.paused` — hub paused: the bot as usual, the emblem grey, and to the right of the bot (not over it) a pause sign "‖":
///   a grey emblem alone is a few pixels and on greyish wallpaper barely differed from "calm". A blocker isn't hidden
///   while paused: the emblem is red then, and the pause sign stays. The number waiting stays — sessions wait in the terminal;
/// - `.offline` — no connection to the service: the bot is faded (0.3), the emblem is a cut-out, a "?" sign to the right of the bot (`unknownMark`):
///   fading alone barely differed from "quiet" (0.5), and "no connection" means "I know nothing", not "safe to shut down".
/// The "safe to shut down?" verdict (`/state.idle`, the daemon's idle service) ranks below blocking and waiting:
/// - `.working` — work in progress (a session, a background run, plugin work, an update): the bot as usual, the emblem blue;
/// - `.quietNeedsOn` — quiet, but the computer will be needed later (plugin: a run at 04:30): the whole bot dimmed, the emblem indigo;
/// - `.quiet` — quiet, safe to shut down: the whole bot dimmed, the emblem a cut-out.
/// Priority: block (red) > waiting (orange + number) > working (blue) > quiet with needsOn (indigo) > quiet. No verdict
/// (older daemon, service off) — `.calm`, as before.
/// The icon isn't cut by a badge: the number and the pause sign sit next to it.
public enum MenuBarLook: Equatable, Sendable {
    case calm
    case waiting(Int)
    case blocked(Int)
    case paused(Int, blocker: Bool)
    case offline
    case working
    case quiet
    case quietNeedsOn

    public static func make(status: HubStatus, waiting: Int, live: Bool, estop: Bool, idle: IdleVerdict? = nil) -> MenuBarLook {
        if !live { return .offline }
        let n = max(0, waiting)
        if estop { return .paused(n, blocker: status >= .block) }
        if status >= .block { return .blocked(n) }
        // "waiting" — only sessions awaiting a reply and question cards (decision 2026-11-07): a plugin's status=wait (for example,
        // a plugin with nothing to do) doesn't tint the icon — it's visible in the popover and the sidebar
        if n > 0 { return .waiting(n) }
        switch idle?.verdict {
        case .busy: return .working
        case .quietNeedsOn: return .quietNeedsOn
        case .quiet: return .quiet
        case nil: return .calm
        }
    }

    /// The number next to the icon; nil — don't show.
    public var count: Int? {
        switch self {
        case .waiting(let n), .blocked(let n), .paused(let n, _): return n > 0 ? n : nil
        case .calm, .offline, .working, .quiet, .quietNeedsOn: return nil
        }
    }

    /// What to fill the emblem with: nil — leave it a cut-out.
    public enum Emblem: Equatable, Sendable { case orange, red, gray, blue, indigo }

    public var emblem: Emblem? {
        switch self {
        case .waiting: return .orange
        case .blocked: return .red
        case .paused(_, let blocker): return blocker ? .red : .gray
        case .working: return .blue
        case .quietNeedsOn: return .indigo
        case .calm, .offline, .quiet: return nil
        }
    }

    /// The pause sign "‖" to the right of the bot (the image is wider by `pauseMarkWidth`).
    public var pauseMark: Bool {
        if case .paused = self { return true }
        return false
    }

    /// The "?" sign to the right of the bot — no connection: the hub knows nothing (the image is wider by `pauseMarkWidth`).
    public var unknownMark: Bool { self == .offline }

    /// Opacity of the template part (the bot) over the menu bar text color.
    public var glyphAlpha: Double {
        switch self {
        case .offline: return 0.3
        // quiet: the whole bot is dimmed, but more visible than "no connection"
        case .quiet, .quietNeedsOn: return 0.5
        default: return 1
        }
    }

    /// macOS draws the whole image (template): no color, no dimming.
    public var isTemplate: Bool { self == .calm }

    /// Text next to the icon: "TEST" for a test copy (otherwise two identical bots sit side by side in the menu bar) and
    /// the number waiting. nil — no text.
    public func labelText(test: Bool) -> String? {
        let parts = [test ? tr("ТЕСТ", "TEST") : nil, count.map { "\($0)" }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// Who turns the icon red: the plugin with the worst status (block, failure) — "Mail — Message "…" not sent". Without this
    /// the tooltip "Agent Hub: Failure" read like a failure of the hub itself.
    public static func culprit(_ plugins: [PluginState]) -> String? {
        guard let p = plugins.filter({ $0.status >= .block }).max(by: { $0.status < $1.status }) else { return nil }
        let head = p.headline.trimmingCharacters(in: .whitespaces)
        if head.isEmpty || head == p.title { return "\(p.title) — \(p.statusLabel())" }
        // the header names the plugin itself ("Mail isn't responding: …") — no repeat
        return head.hasPrefix(p.title) ? head : "\(p.title) — \(head)"
    }

    /// The icon tooltip: the state, the blocker (also while paused — the pause doesn't hide it) with the name of the culprit plugin
    /// (`culprit`), the waiting ones, the test copy label.
    public func tooltip(status: HubStatus, waiting: Int, testMark: String?, idle: IdleVerdict? = nil, culprit: String? = nil) -> String {
        var state: String
        switch self {
        case .offline: state = tr("нет связи со службой хаба", "no connection to the hub service")
        case .paused(_, let blocker):
            state = tr("хаб на паузе", "hub paused")
            if blocker { state += tr(", блокер: \(culprit ?? status.label)", ", blocker: \(culprit ?? status.label)") }
        case .working: state = tr("идёт работа — выключать рано", "work in progress — too early to shut down")
        case .quiet: state = tr("тихо — можно выключать", "all quiet — OK to shut down")
        case .quietNeedsOn:
            let why = idle?.items.first(where: { $0.kind == .needsOn || $0.kind == .unknown })?.text
            state = why.map { tr("тихо, но: \($0)", "quiet, but: \($0)") } ?? tr("тихо, но компьютер понадобится позже", "quiet, but the computer is needed later")
        case .blocked: state = culprit ?? status.label
        default: state = status.label
        }
        let w = waiting > 0 && self != .offline ? tr(", ждут вас: \(waiting)", ", waiting for you: \(waiting)") : ""
        let test = testMark.map { "\n\($0)" } ?? ""
        return "Agent Hub: \(state)\(w)\(test)"
    }
}

// MARK: - safe to shut down? (popover card)

/// The verdict card above the popover tiles (mockup F): a title, a subtitle, blockers — one row each at the top (● work,
/// ! computer needed, ? hub doesn't know), then the info row ○ "awaiting a reply — can be answered after power-on" (not a blocker:
/// it doesn't change the verdict), everything fine — a single grey "Also checked: …" row. Collapsed — at most
/// `maxRows` blocker rows, and at most one from a single plugin (a wordy plugin doesn't crowd out the rest),
/// the rest — "N more" (tapping expands it in place).
public struct IdleCard: Equatable, Sendable {
    public enum Tone: Equatable, Sendable { case green, orange, blue }
    public enum Mark: Equatable, Sendable { case busy, attention, unknown, info }

    public struct Row: Equatable, Sendable, Identifiable {
        public var id: Int
        public var mark: Mark
        public var text: String
        public var target: String?
        /// Name of the source plugin (tooltip "Open "…" in panel"); nil — a hub row.
        public var plugin: String?
        /// The row's own tooltip (for those awaiting a reply — what exactly will happen on sleep and shutdown); nil — the common one.
        public var hint: String? = nil
    }

    /// Tooltip for the "awaiting a reply" row: only what definitely happens to a waiting session (code.claude.com/docs/en/sessions,
    /// "What a resumed session restores"): sleep doesn't touch the process; shutdown closes it, the conversation is saved, but the
    /// question dialog won't come back by itself and the step asked about isn't done. A waiting session's background work (Bash, Monitor) isn't
    /// visible in its status (waiting overrides busy in Claude Code): on shutdown it will be cut off and won't resume by itself — that's what
    /// the last sentence is about. Visible work (a subagent, a worker) is shown by the daemon as "working and awaiting a reply to a step".
    public static var waitingHint: String {
        tr("Сон сессию не трогает — вопрос будет на месте. После выключения разговор сохранён: claude --resume откроет его; окно вопроса само не вернётся и спрошенный шаг не выполнен — ответьте в разговоре или попросите продолжить. Фоновые агенты и команды сессии при выключении остановятся и сами не продолжатся",
           "Sleep doesn't touch the session — the question stays put. After a shutdown the conversation is saved and claude --resume opens it; the prompt itself won't come back and the step it asked about hasn't run — answer in the conversation or ask Claude to go on. The session's background agents and commands stop at shutdown and won't resume on their own")
    }

    public static let maxRows = 4
    /// "Checked": how many names to list (after that — "and N more") and how many characters to truncate a name to.
    public static let maxChecked = 4
    public static let checkedNameLimit = 18

    public var tone: Tone
    public var title: String
    public var subtitle: String
    /// The blocker rows visible now.
    public var rows: [Row]
    /// How many rows are hidden ("N more"); 0 — all are shown.
    public var hidden: Int
    /// Can be collapsed back (it's expanded and some rows were hidden when collapsed).
    public var collapsible: Bool
    /// "Also checked: …" / "Checked: …"; nil — there was nothing to check.
    public var checkedLine: String?

    public static func make(_ v: IdleVerdict, expanded: Bool = false) -> IdleCard {
        let all = v.items.enumerated().map { i, it in
            Row(id: i, mark: it.kind == .busy || it.kind == .other ? .busy : it.kind == .unknown ? .unknown : it.kind == .waiting ? .info : .attention,
                text: unbreakablePaths(it.text), target: it.target, plugin: it.plugin, hint: it.kind == .waiting ? waitingHint : nil)
        }
        // collapsed: hub rows (sessions, updates) — all of them, from a plugin — the first; at most maxRows
        var folded: [Row] = []
        var shownSources = Set<String>()
        for (row, item) in zip(all, v.items) where folded.count < maxRows {
            let perPlugin = item.source.hasPrefix("plugin:")
            if perPlugin, shownSources.contains(item.source) { continue }
            shownSources.insert(item.source)
            folded.append(row)
        }
        let show = expanded ? all : folded
        let checked = checkedText(v.checked, alone: all.isEmpty)
        let tone: Tone
        let title: String
        let subtitle: String
        switch v.verdict {
        case .quiet:
            tone = .green
            title = tr("Можно выключать", "OK to shut down")
            subtitle = v.items.contains(where: { $0.kind == .waiting })
                // "no visible work" rather than "nothing running": the status doesn't show a waiting session's background work
                ? tr("работы не видно — ждущие ответа подождут", "no work in sight — the waiting sessions can wait")
                : tr("ничего не потеряется", "nothing will be lost")
        case .quietNeedsOn:
            tone = .orange
            // a title from the phrase — only from a trusted plugin: otherwise a third-party needsOn="don't shut down — …" would produce
            // "Yes, but don't shut down"
            let needs = v.items.filter { $0.kind == .needsOn }
            if v.items.contains(where: { $0.kind == .unknown }) {
                title = tr("Можно, но не всё известно", "OK, but not everything is known")
            } else if needs.count == 1, needs[0].trusted == true, let head = needsOnHead(needs[0].text) {
                title = tr("Можно, но \(head)", "OK — \(head) needs the Mac")
            } else {
                title = tr("Можно, но не всё пройдёт", "OK, but not everything will run")
            }
            subtitle = tr("выключать — на ваше усмотрение", "it's your call")
        case .busy:
            tone = .blue
            title = tr("Пока рано", "Not yet")
            // "too early" — only because of running work: those awaiting a reply don't change the verdict (for an old daemon — recomputed
            // during parsing, IdleVerdict.init(from:))
            subtitle = tr("идёт работа — выключение её прервёт", "work is running — shutting down would interrupt it")
        }
        return IdleCard(tone: tone, title: title, subtitle: subtitle, rows: show, hidden: all.count - show.count,
                        collapsible: expanded && folded.count < all.count, checkedLine: checked)
    }

    /// Paths in plugin text ("/usr/local/bin", "~/.local/bin") and hyphenated session names ("demo-d9") don't break
    /// mid-way when wrapping: after "/" inside a word and after "-" between letters or digits — an invisible non-breaking U+2060
    /// (otherwise "/usr/" at the end of a line and "local/bin" at the start of the next, "demo-" and "d9").
    public static func unbreakablePaths(_ s: String) -> String {
        guard s.contains("/") || s.contains("-") else { return s }
        var out = ""
        let chars = Array(s)
        for (i, c) in chars.enumerated() {
            out.append(c)
            guard i + 1 < chars.count else { continue }
            if c == "/", !chars[i + 1].isWhitespace { out.append("\u{2060}") }
            if c == "-", i > 0, chars[i - 1].isLetter || chars[i - 1].isNumber, chars[i + 1].isLetter || chars[i + 1].isNumber { out.append("\u{2060}") }
        }
        return out
    }

    /// "Checked: Sessions, Agents, Mail, Build and 3 more": at most `maxChecked` names, each up to
    /// `checkedNameLimit` characters (the way tiles truncate a long name).
    static func checkedText(_ names: [String], alone: Bool) -> String? {
        guard !names.isEmpty else { return nil }
        let cut = names.prefix(maxChecked).map { $0.count > checkedNameLimit ? String($0.prefix(checkedNameLimit - 1)).trimmingCharacters(in: .whitespaces) + "…" : $0 }
        var list = cut.joined(separator: ", ")
        if names.count > maxChecked { list += tr(" и ещё \(names.count - maxChecked)", " and \(names.count - maxChecked) more") }
        return alone ? tr("Проверено: \(list)", "Checked: \(list)") : tr("Ещё проверено: \(list)", "Also checked: \(list)")
    }

    /// "Сборка в 04:30 — нужен включённый Mac" → "сборка в 04:30": the part before " — ", the first letter lowercased if the word
    /// is an ordinary Russian one (the second letter is lowercase too: "Сборка" → "сборка", "Почта" → "почта", "NAS" and "Xcode" stay as
    /// is). In English the title has a different form ("OK — Build at 04:30 needs the Mac"): the phrase comes from the start.
    static func needsOnHead(_ text: String) -> String? {
        let head = text.components(separatedBy: " — ").first?.trimmingCharacters(in: .whitespaces) ?? ""
        guard !head.isEmpty, head.count <= 40 else { return nil }
        let chars = Array(head)
        if chars.count > 1, chars[0].isUppercase, chars[1].isLowercase,
           let s = chars[0].unicodeScalars.first, (0x0400...0x04FF).contains(Int(s.value)) {
            return chars[0].lowercased() + String(chars.dropFirst())
        }
        return head
    }

    /// The label of the "N more" and "collapse" row.
    public static func moreLabel(_ n: Int) -> String { tr("ещё \(n)", "\(n) more") }
    public static var collapseLabel: String { tr("свернуть", "collapse") }
}

// MARK: - test copy

public enum TestMark {
    /// The "TEST · /tmp/ahl" label, if the shell looks at a directory other than the default hub one (`--home`, `AGENTHUB_HOME`)
    /// or the daemon itself says it's a test one (`/state.hub.testMode`). nil — the real copy.
    public static func label(home: String, defaultHome: String, daemonTestMode: Bool?) -> String? {
        let custom = standardized(home) != standardized(defaultHome)
        guard custom || daemonTestMode == true else { return nil }
        return tr("ТЕСТ", "TEST") + " · " + abbreviate(home)
    }

    /// The hub directory, short: ~ in place of the home directory.
    public static func abbreviate(_ path: String) -> String {
        (standardized(path) as NSString).abbreviatingWithTildeInPath
    }

    static func standardized(_ p: String) -> String {
        var s = ((p as NSString).expandingTildeInPath as NSString).standardizingPath
        while s.count > 1 && s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

// MARK: - plugin author

/// The author from metadata (`<agenthub.author.name>`, `<agenthub.author.github>`) or the registry index.
/// Shows the name, then the GitHub login (as a link to the profile).
public struct PluginAuthor: Codable, Sendable, Hashable {
    public var name: String?
    public var github: String?

    public init(name: String? = nil, github: String? = nil) {
        self.name = name?.trimmingCharacters(in: .whitespaces).nilIfEmpty
        self.github = github.flatMap { Self.validLogin($0) ? $0 : nil }
    }

    /// A string (an old daemon — login only) or an object `{name, github}`.
    public init(from decoder: Decoder) throws {
        if let s = try? decoder.singleValueContainer().decode(String.self) {
            self.init(github: s)
            return
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(name: try? c.decodeIfPresent(String.self, forKey: .name), github: try? c.decodeIfPresent(String.self, forKey: .github))
    }

    enum CodingKeys: String, CodingKey { case name, github }

    public var isEmpty: Bool { name == nil && github == nil }

    /// "Kensei · @KenseiTheOne"; without a name — "@login"; without a login — the name.
    public var display: String {
        [name, github.map { "@\($0)" }].compactMap { $0 }.joined(separator: " · ")
    }

    /// The GitHub profile — only for a login that follows GitHub's rules.
    public var profileURL: URL? { github.flatMap { URL(string: "https://github.com/\($0)") } }

    static func validLogin(_ s: String) -> Bool {
        s.range(of: #"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$"#, options: .regularExpression) != nil
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - versions

public enum PluginVersion {
    /// Semver version comparison (the registry allows `1.2.3-beta.1`, `SEMVER_RE` in daemon/lib/registry/perms.mjs):
    /// the X.Y.Z core — numerically (missing parts are zeros; non-numeric — as strings), a pre-release is lower than the release of the same
    /// version (`1.3.0-beta.1` < `1.3.0`), pre-release identifiers — one by one: numeric ones numerically, a numeric one
    /// is lower than an alphanumeric one, alphanumeric ones as strings; if the common ones are equal, the shorter is lower. Build metadata (`+…`) doesn't count.
    public static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let (ca, pa) = split(a), (cb, pb) = split(b)
        let core = compareCore(ca, cb)
        if core != .orderedSame { return core }
        switch (pa, pb) {
        case (nil, nil): return .orderedSame
        case (nil, _): return .orderedDescending
        case (_, nil): return .orderedAscending
        case let (x?, y?): return comparePrerelease(x, y)
        }
    }

    /// «1.3.0-beta.1+build» → («1.3.0», «beta.1»).
    static func split(_ v: String) -> (core: String, pre: String?) {
        var s = Substring(v.trimmingCharacters(in: .whitespaces))
        if let plus = s.firstIndex(of: "+") { s = s[..<plus] }
        guard let dash = s.firstIndex(of: "-") else { return (String(s), nil) }
        let pre = s[s.index(after: dash)...]
        return (String(s[..<dash]), pre.isEmpty ? nil : String(pre))
    }

    static func compareCore(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.split(separator: ".").map(String.init), pb = b.split(separator: ".").map(String.init)
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : "0", y = i < pb.count ? pb[i] : "0"
            if let nx = Int(x), let ny = Int(y) {
                if nx != ny { return nx < ny ? .orderedAscending : .orderedDescending }
            } else if x != y {
                return x.compare(y, options: .numeric)
            }
        }
        return .orderedSame
    }

    static func comparePrerelease(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let pb = b.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        for (x, y) in zip(pa, pb) where x != y {
            switch (Int(x), Int(y)) {
            case let (nx?, ny?): if nx != ny { return nx < ny ? .orderedAscending : .orderedDescending }
            case (.some, nil): return .orderedAscending
            case (nil, .some): return .orderedDescending
            case (nil, nil): return x < y ? .orderedAscending : .orderedDescending
            }
        }
        if pa.count == pb.count { return .orderedSame }
        return pa.count < pb.count ? .orderedAscending : .orderedDescending
    }
}

/// What the update button will do: the daemon marks an update (`updateAvailable`) on any sha256 mismatch
/// of the archive, so the catalog version may even be older than the installed one (the registry rolled back a release) — then it's a
/// rollback, not an update.
public enum PluginUpdateKind: Equatable, Sendable {
    /// "Update to X" — the catalog version is newer.
    case newer(String)
    /// "Update" — a rebuilt archive of the same version.
    case rebuild
    /// "Roll back to X" — the catalog version is older than the installed one (with confirmation).
    case older(String)

    public var isRollback: Bool {
        if case .older = self { return true }
        return false
    }
}

extension CatalogPlugin {
    /// The catalog version is newer than the installed one: the "Update to X" button. The daemon marks an update by the archive's sha256
    /// (`updateAvailable`); a rebuilt archive of the same version is just "Update".
    public var newerVersion: String? {
        if case .newer(let v) = updateKind { return v }
        return nil
    }

    /// nil — nothing to update (no mismatch, not installed, or the catalog version is blocked by the registry).
    public var updateKind: PluginUpdateKind? {
        guard updateAvailable, blocked == nil, let inst = installed else { return nil }
        switch PluginVersion.compare(version, inst) {
        case .orderedDescending: return .newer(version)
        case .orderedAscending: return .older(version)
        case .orderedSame: return .rebuild
        }
    }

    /// The update will add permissions — the permissions sheet will open.
    public var updateGrows: Bool { !(growth ?? []).isEmpty }
}

// MARK: - plugin updates (the daemon's background check)

/// The popover row about available updates. One — "Update available: Mail 0.4.0", below it "Installed 0.3.0" or
/// in orange "The new version asks for more permissions", the "Update" button starts the manager's update flow right away (`single`
/// — the plugin id). Several — "Plugin updates: N" and a row per plugin (`rows`, at most `maxRows`, the rest —
/// "and K more"): the name is truncated at the tail, the version is always visible, "more permissions" only for those that need them; the
/// "Open" button leads to Plugins, where each has its own "Update".
public struct PluginUpdateLine: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var version: String
        public var grows: Bool
    }

    public var title: String
    /// The explanation under the title (only for a single update).
    public var detail: String?
    public var single: String?
    /// The single update adds permissions: the explanation and the button are orange.
    public var grows: Bool
    public var rows: [Row]
    /// How many updates didn't fit into `rows`.
    public var more: Int
    public var button: String

    public static let maxRows = 3

    public static func make(_ items: [PluginUpdate]) -> PluginUpdateLine? {
        guard let first = items.first else { return nil }
        if items.count == 1 {
            let name = first.title ?? first.id
            let detail = first.permissionsGrow
                ? tr("Новая версия просит больше прав", "The new version asks for more permissions")
                : tr("Установлена \(first.installed)", "Installed: \(first.installed)")
            return PluginUpdateLine(title: tr("Доступно обновление: \(name) \(first.version)", "Update available: \(name) \(first.version)"),
                                    detail: detail, single: first.id, grows: first.permissionsGrow, rows: [], more: 0,
                                    button: tr("Обновить", "Update"))
        }
        let rows = items.prefix(maxRows).map { Row(id: $0.id, name: $0.title ?? $0.id, version: $0.version, grows: $0.permissionsGrow) }
        return PluginUpdateLine(title: tr("Обновления плагинов: \(items.count)", "Plugin updates: \(items.count)"),
                                detail: nil, single: nil, grows: false, rows: Array(rows), more: items.count - rows.count,
                                button: tr("Открыть", "Open"))
    }

    /// "more permissions" on a list row.
    public static var growsLabel: String { tr("больше прав", "more permissions") }
    /// "and 2 more" under the list.
    public static func moreLabel(_ n: Int) -> String { tr("и ещё \(n)", "and \(n) more") }

    /// Tooltip for the Plugins badge in the sidebar.
    public static func badgeHelp(_ items: [PluginUpdate]) -> String {
        tr("Доступны обновления: ", "Updates available: ") + items.map { "\($0.title ?? $0.id) \($0.version)" }.joined(separator: ", ")
    }
}

/// The status line under the "Check for plugin updates" toggle in Settings: what's off, when it last
/// checked, what failed (briefly, without advice about buttons — there are none here), when the next one is and how many were found.
public enum PluginUpdatesStatus {
    /// → (text, whether it's a warning). `date` — renders the daemon's ISO time (in the shell — `Fmt.dateTime`).
    public static func line(_ info: PluginUpdates, date: (Date) -> String = Fmt.dateTime) -> (text: String, warn: Bool) {
        if !info.config { return (tr("Выключено в config.json демона (services.plugins.checkUpdates = false)", "Turned off in the daemon's config.json (services.plugins.checkUpdates = false)"), false) }
        if !info.setting { return (tr("Выключено", "Off"), false) }
        if !info.configured { return (tr("Каталог реестра не подключён — проверять нечего", "The registry catalog isn't connected — nothing to check"), false) }
        var parts: [String] = []
        let checked = parseDate(info.checkedAt)
        if let e = info.error {
            let why = errorText(e)
            if let d = checked {
                parts.append(tr("Последняя проверка: \(date(d))", "Last check: \(date(d))"))
                parts.append(tr("последняя попытка не удалась: \(why)", "the latest attempt failed: \(why)"))
            } else {
                parts.append(tr("Проверить не удалось: \(why)", "Couldn't check: \(why)"))
            }
        } else if let d = checked {
            parts.append(tr("Последняя проверка: \(date(d))", "Last check: \(date(d))"))
        } else {
            parts.append(tr("Ещё не проверялось", "Not checked yet"))
        }
        if info.enabled, let d = parseDate(info.nextCheckAt) {
            parts.append(info.error == nil ? tr("следующая: \(date(d))", "next: \(date(d))") : tr("повтор: \(date(d))", "retry: \(date(d))"))
        }
        let n = info.items.count
        if n > 0 { parts.append(tr("доступно обновлений: \(n)", "updates available: \(n)")) }
        return (parts.joined(separator: " · "), info.error != nil)
    }

    /// A background check error — briefly, lowercase, without a period (part of a line joined with " · ").
    public static func errorText(_ code: String) -> String {
        switch code {
        case "registry:fetch", "registry:http", "registry:redirect":
            return tr("нет связи с каталогом", "can't reach the catalog")
        case "registry:not-found":
            return tr("файл каталога не найден", "the catalog file wasn't found")
        case "registry:too-large":
            return tr("каталог слишком большой", "the catalog is too large")
        case "registry:rollback":
            return tr("каталог старее уже загруженного", "the catalog is older than the one already loaded")
        case "registry:network-disabled":
            return tr("сеть для каталога выключена в config.json", "network access for the catalog is off in config.json")
        case "registry:url-scheme":
            return tr("адрес каталога — не https", "the catalog address isn't https")
        case "registry:no-index-url", "registry:no-public-key":
            return tr("каталог не подключён", "the catalog isn't connected")
        case "registry:foreign-key", "registry:signature", "registry:global-signature", "registry:sig-format", "registry:key-format":
            return tr("подпись каталога не сошлась", "the catalog signature didn't verify")
        default:
            if code.hasPrefix("registry:index-") { return tr("каталог повреждён", "the catalog is malformed") }
            return tr("ошибка \(code)", "error \(code)")
        }
    }

    public static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}

// MARK: - panel sidebar

/// The second line of a panel sidebar item (variant C, 2026-11-06): a colored severity dot and a short status in words
/// on one line, the tail truncated with an ellipsis; the full text is in the item's tooltip (`help`) and in the accessibility
/// label. There are no more word pills on the right: the first line has only a number on the right (plugin updates,
/// `SidebarStatus.updatesCount`).
public struct SidebarStatus: Equatable, Sendable {
    /// Severity is the dot color: calm (grey), attention — waiting for you (orange), block or failure (red).
    public enum Tone: Equatable, Sendable { case calm, attention, alarm }

    /// The line under the name (one line, no line breaks).
    public var text: String
    public var tone: Tone
    /// The full text for the hover tooltip and for VoiceOver.
    public var help: String

    /// A macOS tooltip wraps text to its width but isn't height-limited, and a plugin header can be
    /// long (output parsing lets a line through up to 64 KB; a longer one is cut and carries no params) — truncate to a reasonable length; the full text is on the page.
    public static let helpLimit = 300

    public init(text: String, tone: Tone, help: String? = nil) {
        self.text = text; self.tone = tone; self.help = Self.clip(help ?? text)
    }

    public static func clip(_ s: String, limit: Int = helpLimit) -> String {
        s.count <= limit ? s : String(s.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    public static func tone(_ s: HubStatus) -> Tone {
        switch s {
        case .block, .error: return .alarm
        case .wait: return .attention
        case .ok, .unknown: return .calm
        }
    }

    /// Plugin: the header title — the same as shown large on its page ("Build won't start: disk busy…").
    /// On the second line the leading plugin name is cut off ("won't start: disk busy…", as in mockup C) —
    /// the tooltip and the accessibility label have the full title; a header equal to the name ("Weather" for the "Weather" plugin)
    /// isn't a status: then the status label is used. No header — the status label ("All good", the plugin's own label).
    /// A failure (`error` with a reason) — "Plugin failed: timeout", as on the page: a crashed plugin's header is left over
    /// from the last good frame, so it's only in the tooltip next to the failure.
    /// `live == false` — no connection to the daemon: the line is grey, the tooltip says the data is as of the disconnect.
    /// Sessions awaiting a reply: in the waiting status and with a hook card (by sessionId — two cards from subagents of one
    /// session count as one waiting).
    static func waitingSessionIds(_ list: [SessionInfo], cardSessions: [String]) -> Set<String> {
        var ids = Set(list.filter(\.isWaiting).map(\.sessionId))
        for (i, id) in cardSessions.enumerated() { ids.insert(id.isEmpty ? "\u{0}card\(i)" : id) }
        return ids
    }

    /// How many are awaiting a reply — counted the same way as the Sessions row in the sidebar (the section subtitle matches it).
    public static func waitingCount(_ list: [SessionInfo], waiting: Int = 0, cardSessions: [String] = []) -> Int {
        max(waiting, waitingSessionIds(list, cardSessions: cardSessions).count)
    }

    /// The Sessions subtitle: "5 open · 1 waiting for you".
    public static func sessionsSubtitle(open n: Int, waiting w: Int) -> String {
        let open = tr("\(n) открыто", "\(n) open")
        guard w > 0 else { return open }
        return open + " · \(w) " + plural(w, ru: ("ждёт вас", "ждут вас", "ждут вас"), en: ("waiting for you", "waiting for you"))
    }

    public static func plugin(_ p: PluginState, live: Bool = true) -> SidebarStatus {
        let raw = p.header.first(where: { !$0.separator && !oneLine($0.title).isEmpty }).map { oneLine($0.title) }
        // a header identical to the name says nothing
        let head = raw.flatMap { $0.compare(p.title, options: .caseInsensitive) == .orderedSame ? nil : $0 }
        var s: SidebarStatus
        if p.status == .error, let e = p.error.map(oneLine), !e.isEmpty {
            let fail = tr("Сбой плагина: \(e)", "Plugin failure: \(e)")
            s = SidebarStatus(text: fail, tone: .alarm, help: head.map { "\($0) — \(fail)" } ?? fail)
        } else if let head {
            s = SidebarStatus(text: dropTitle(p.title, from: head), tone: tone(p.status), help: head)
        } else {
            s = SidebarStatus(text: p.statusLabel(), tone: tone(p.status))
        }
        return live ? s : s.offline()
    }

    /// "Build won't start: …" for the "Build" plugin → "won't start: …". Only the whole name is cut off
    /// (case-insensitive) followed by a space, colon or dash; if nothing is left — the line as it was.
    static func dropTitle(_ title: String, from head: String) -> String {
        let t = oneLine(title)
        guard !t.isEmpty, let r = head.range(of: t, options: [.caseInsensitive, .anchored]) else { return head }
        let rest = head[r.upperBound...]
        guard let c = rest.first, c == " " || c == ":" || c == "—" || c == "–" else { return head }
        let cut = rest.drop { $0 == " " || $0 == ":" || $0 == "—" || $0 == "–" || $0 == "-" || $0 == "·" }
        return cut.isEmpty ? head : String(cut)
    }

    /// Sessions: "2 awaiting a reply · 5 working". Waiting for you — sessions: the waiting ones in the list and those with a reply
    /// card (`cardSessions` — `HookCard.sessionId`; two cards from subagents of one session count as one waiting),
    /// at least `waiting` (`/state.waitingSessions`). A session with a card doesn't count as working.
    /// The session registry plugin (`claude-sessions`): crashed — red "Sessions plugin didn't answer"; can't see its source —
    /// its reason in orange ("No sessions visible…"), not "no open sessions"; died mid-turn —
    /// "1 died", in orange. Nobody waiting or working — "3 idle"; no sessions — "no open
    /// sessions". `live == false` — no connection: grey, without sessions — "no connection to the hub".
    public static func sessions(_ list: [SessionInfo], waiting: Int = 0, cardSessions: [String] = [],
                                plugin: PluginState? = nil, live: Bool = true) -> SidebarStatus {
        let waitingIds = waitingSessionIds(list, cardSessions: cardSessions)
        let busy = list.filter { $0.status == "busy" && !waitingIds.contains($0.sessionId) }.count
        let waiting = max(waiting, waitingIds.count)
        let extras = SessionsPluginExtras(plugin)
        let died = extras.nodes.filter { $0.item.event?.hasPrefix("died:") == true }.count
        let broken = extras.brokenTitle.map(oneLine)
            ?? extras.nodes.first(where: { $0.item.event == "source-broken" }).map { oneLine($0.item.title) }
        var parts: [String] = []
        if waiting > 0 {
            parts.append("\(waiting) " + plural(waiting, ru: ("ждёт ответа", "ждут ответа", "ждут ответа"), en: ("waiting for you", "waiting for you")))
        }
        if died > 0 {
            parts.append("\(died) " + plural(died, ru: ("оборвалась", "оборвались", "оборвались"), en: ("stopped mid-turn", "stopped mid-turn")))
        }
        if busy > 0 {
            parts.append("\(busy) " + plural(busy, ru: ("работает", "работают", "работают"), en: ("working", "working")))
        }
        if parts.isEmpty, !list.isEmpty {
            let n = list.count
            parts.append("\(n) " + plural(n, ru: ("простаивает", "простаивают", "простаивают"), en: ("idle", "idle")))
        }
        var s: SidebarStatus
        if let f = extras.failure.map(oneLine) {
            let short = tr("Плагин сессий не ответил", "The sessions plugin failed")
            let full = tr("Плагин сессий не ответил: \(f)", "The sessions plugin failed: \(f)")
            s = SidebarStatus(text: ([short] + parts).joined(separator: " · "), tone: .alarm,
                              help: ([full] + parts).joined(separator: " · "))
        } else if let broken, !broken.isEmpty {
            let all = (parts + [broken]).joined(separator: " · ")
            s = SidebarStatus(text: all, tone: .attention)
        } else if !parts.isEmpty {
            s = SidebarStatus(text: parts.joined(separator: " · "), tone: waiting > 0 || died > 0 ? .attention : .calm)
        } else if !live {
            return SidebarStatus(text: tr("нет связи с хабом", "no connection to the hub"), tone: .calm)
        } else if let p = plugin, p.status == .unknown,
                  let h = p.header.first(where: { !$0.separator && !oneLine($0.title).isEmpty }).map({ oneLine($0.title) }) {
            // the plugin hasn't figured it out yet (or the source is in an unknown form) — its words, not "no sessions"
            s = SidebarStatus(text: h, tone: .calm)
        } else {
            s = SidebarStatus(text: tr("нет открытых сессий", "no open sessions"), tone: .calm)
        }
        return live ? s : s.offline()
    }

    /// Plugins: "2 updates"; no updates — no second line. A new version asks for more permissions — the dot
    /// is orange (like the "more permissions" row in the popover). The tooltip is the list: "Updates available: Mail 0.4.1, …".
    public static func updates(_ items: [PluginUpdate], live: Bool = true) -> SidebarStatus? {
        let n = items.count
        guard n > 0 else { return nil }
        let text = "\(n) " + plural(n, ru: ("обновление", "обновления", "обновлений"), en: ("update", "updates"))
        let s = SidebarStatus(text: text, tone: items.contains { $0.permissionsGrow } ? .attention : .calm,
                              help: PluginUpdateLine.badgeHelp(items))
        return live ? s : s.offline()
    }

    /// The number in the capsule on the right of Plugins — available updates; none — no capsule.
    public static func updatesCount(_ items: [PluginUpdate]) -> String? {
        items.isEmpty ? nil : "\(items.count)"
    }

    /// The item's accessibility label: the name and the full status ("Build, Build won't start: …").
    public static func accessibilityLabel(title: String, status: SidebarStatus?) -> String {
        guard let s = status, !s.help.isEmpty else { return title }
        return "\(title), \(s.help)"
    }

    /// No connection to the daemon: the words are from the last snapshot, hence grey, and the tooltip says they're as of the disconnect.
    func offline() -> SidebarStatus {
        SidebarStatus(text: text, tone: .calm,
                      help: help + " — " + tr("нет связи с хабом, данные на момент обрыва", "no connection to the hub, data as of the disconnect"))
    }

    /// The status on one line: line breaks and repeated spaces are collapsed.
    static func oneLine(_ s: String) -> String {
        s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
    }
}

/// Hover tooltips on plugin texts (panel, popover): the full text of whatever may have been ellipsized.
/// The plugin's own `tooltip=` takes precedence; otherwise — the line's parts joined with " — ", on one line; up to `SidebarStatus.helpLimit`
/// (300) characters. Empty — nil (no tooltip).
public enum PluginText {
    public static func help(tooltip: String? = nil, _ parts: String?...) -> String? {
        help(tooltip: tooltip, parts: parts)
    }

    public static func help(tooltip: String?, parts: [String?]) -> String? {
        if let t = tooltip.map(SidebarStatus.oneLine), !t.isEmpty { return SidebarStatus.clip(t) }
        let s = parts.compactMap { $0.map(SidebarStatus.oneLine) }.filter { !$0.isEmpty }.joined(separator: " — ")
        return s.isEmpty ? nil : SidebarStatus.clip(s)
    }

    /// The plugin page header: the title and the status explanation (the plugin's own label or the common one).
    public static func heroHelp(_ p: PluginState) -> String? {
        help(p.headline, p.statusHint())
    }

    /// A body row: its text (or `tooltip=`); a button row takes the tooltip from the button.
    public static func rowHelp(_ it: Item) -> String? {
        help(tooltip: it.tooltip, it.title)
    }

    /// A number card and a strip cell: caption, value, the line below it.
    public static func cardHelp(_ it: Item) -> String? {
        help(tooltip: it.tooltip, it.stat, it.title, it.note)
    }

    /// A popover tile: name, status label and header.
    public static func tileHelp(_ p: PluginState) -> String {
        help("\(p.title): \(p.statusLabel())", p.headline) ?? p.title
    }
}

/// Where "Open" on a notification leads: a plugin — to its page, the hub's "Update available" — to the plugin manager,
/// other hub events (`@hub`, a source with "@" — e.g. `@hub:approvals-paused`: the replies pause is visible in Sessions)
/// and sessions plugin events ("session waiting", "session crashed") — to Sessions, where the reply cards and session buttons are.
public enum NotifyTarget: Equatable, Sendable {
    case plugin(String)
    case manager
    case sessions

    /// The session registry plugin: it has no page of its own in the sidebar, its section is Sessions.
    public static let sessionsPlugin = "claude-sessions"

    public static func of(plugin: String?, key: String?) -> NotifyTarget {
        guard let plugin, !plugin.isEmpty else { return .sessions }
        if plugin.hasPrefix("@") { return key?.hasPrefix("@hub:plugin-update:") == true ? .manager : .sessions }
        if plugin == sessionsPlugin { return .sessions }
        return .plugin(plugin)
    }
}

/// What to show in Sessions from the sessions plugin's frame. Its page leads there (`PanelSection.resolved`,
/// `NotifyTarget`), and Sessions already shows live sessions from the hub registry. Only rows that aren't in the registry
/// remain from the frame: died sessions (event `died:<id>`, with "Continue: claude --resume <id>") and
/// the "no sessions visible" reason (`source-broken` — as a header followed by a grey detail, or as a body row), plus a failure
/// of the plugin itself. Otherwise after the redirect they wouldn't be visible anywhere.
public struct SessionsPluginExtras: Sendable, Equatable {
    /// The "no sessions visible" reason from the header (the title) and its detail (a grey body row before the rest).
    public var brokenTitle: String?
    public var brokenDetail: String?
    /// The plugin failure (`exit N`, `empty-output`…), if it crashed.
    public var failure: String?
    /// Body rows: died ones and `source-broken` — with nested rows ("Continue: …", "Details").
    public var nodes: [ItemNode]

    public var isEmpty: Bool { brokenTitle == nil && failure == nil && nodes.isEmpty }

    public init(_ p: PluginState?) {
        brokenTitle = nil; brokenDetail = nil; failure = nil; nodes = []
        guard let p else { return }
        if p.status == .error { failure = p.error ?? "error" }
        let first = ItemTree.blocks(p.body).first ?? []
        if let h = p.header.first(where: { !$0.separator }), h.event == "source-broken" {
            brokenTitle = h.title
            // the detail — rows of the first block up to the first row with an event; for a section heading ("Where the data comes from") —
            // its child rows (the substance is there); a bare heading without content isn't shown
            var detail: [String] = []
            for n in first.prefix(while: { $0.item.event == nil && !$0.item.separator }) {
                if n.hasChildren {
                    detail += n.children.map(\.item.title).filter { !$0.isEmpty }
                } else if !n.item.title.isEmpty {
                    detail.append(n.item.title)
                }
            }
            if !detail.isEmpty { brokenDetail = detail.joined(separator: "\n") }
        }
        nodes = ItemTree.build(p.body).filter { n in
            guard let e = n.item.event, n.item.level == 0 else { return false }
            return e.hasPrefix("died:") || e == "source-broken"
        }
    }
}

// MARK: - action availability

/// Why an action button won't work right now — the same checks in the same order as the core (`POST /actions/:id`,
/// docs/api.md): connection, peer class (confirmable and app-only — pinned build only), hub pause
/// (only `open.url`/`open.file` work during it), the cmux bridge (for primitives that go through it when the session's terminal is
/// cmux), the session's terminal (`unsupported`: the adapter doesn't declare the capability).
/// nil — can be pressed; the core decides anyway, the shell just doesn't offer a certain refusal.
public enum ActionBlock: Equatable, Sendable {
    case offline, notPinned, paused, noBridge
    /// The session's terminal can't do it: `terminal` is its label (iTerm2), `capability` — focus, send-esc, launch, …
    case unsupported(terminal: String, capability: String)
    /// No terminal can open a new tab (`/state.terminals.launch` is null).
    case noLaunchTerminal

    /// Work even while the hub is paused, if the daemon didn't provide `safeUnderEstop` in `/state.primitives` (daemons before 2026-11-05).
    public static let safeUnderEstop: Set<String> = ["open.url", "open.file"]
    /// May run through the cmux bridge: without it the core answers `bridge-offline` — but only when the terminal is cmux. For a
    /// session the caller passes `needsBridge` from its terminal (`SessionTerminal.needsBridge`), for a launch — from the launch
    /// terminal; `terminal.focus`/`cmux.focus` by a cmux tab id always need it.
    public static let bridgePrimitives: Set<String> = ["terminal.focus", "cmux.focus", "session.focus", "session.interrupt", "session.launch"]

    /// - primitive: the primitive (nil for a plugin action); level: the offer's or the primitive's level;
    ///   pluginAction: a declared plugin action (`offer.kind == "action"`) — never works while paused.
    public static func check(primitive: String?, level: ActionLevel, pluginAction: Bool, primitives: [PrimitiveInfo],
                             live: Bool, peer: PeerInfo?, estop: Bool, bridgeOnline: Bool, needsBridge: Bool = true,
                             actionAppOnly: Bool = false) -> ActionBlock? {
        if !live { return .offline }
        let info = primitive.flatMap { p in primitives.first { $0.name == p } }
        // an action of a non-built-in plugin (offer.appOnly) — only from the pinned build, even immediate
        let appOnly = pluginAction ? actionAppOnly : (info?.appOnly ?? false)
        let lvl = pluginAction ? level : (info?.level ?? level)
        if let peer, !peer.isApp, appOnly || lvl != .immediate { return .notPinned }
        if estop, pluginAction || !(info?.safeUnderEstop ?? safeUnderEstop.contains(primitive ?? "")) { return .paused }
        if needsBridge, !pluginAction, let p = primitive, bridgePrimitives.contains(p), !bridgeOnline { return .noBridge }
        return nil
    }

    /// The tooltip on a disabled button (without the bridge the shell has its own, with the bridge launch command).
    public var help: String {
        switch self {
        case .offline: return tr("Нет связи со службой хаба", "No connection to the hub service")
        case .notPinned: return tr("Только закреплённая сборка приложения", "Pinned app build only")
        case .paused: return tr("Хаб на паузе", "Hub is paused")
        case .noBridge: return tr("Мост cmux не подключён", "The cmux bridge isn't connected")
        case .unsupported(let terminal, let capability): return TerminalText.unsupported(terminal: terminal, capability: capability)
        case .noLaunchTerminal: return tr("Нет терминала, в котором можно открыть вкладку", "No terminal can open a new tab")
        }
    }
}

// MARK: - plugin interval

/// "Updates every …" in "About the plugin": the interval from the file name (`foo.5m.mjs`; the daemon allows ms|s|m|h|d,
/// daemon/lib/meta.mjs) with the unit in the hub language. An unknown form — as is.
public enum RefreshInterval {
    public static func text(_ interval: String) -> String {
        let s = interval.trimmingCharacters(in: .whitespaces)
        guard let m = s.wholeMatch(of: /(\d+)(ms|s|m|h|d)/) else { return tr("каждые \(s)", "every \(s)") }
        let n = String(m.1)
        let unit: String
        switch m.2 {
        case "ms": unit = tr("мс", "ms")
        case "s": unit = tr("с", "s")
        case "m": unit = tr("мин", "min")
        case "h": unit = tr("ч", "h")
        default: unit = tr("дн", "d")
        }
        return tr("каждые \(n) \(unit)", "every \(n) \(unit)")
    }
}

// MARK: - advice for an unpinned copy

/// What to advise an app copy that isn't pinned (the peer class isn't app), or when there's no pin
/// at all. Since 2026-11-06 `scripts/bundle.sh` doesn't pin the build by default, and a hub from an install runs from
/// `Versions/current` — "rebuild (scripts/bundle.sh)" doesn't help. The main advice is to open the pinned build
/// (the path from `/state.appPin.path`); the fix is the installer (same version, no rebuild) or, for a hub from a working
/// folder, `scripts/bundle.sh --pin-live` (deliberately). HubStore updates the context on every snapshot; the texts for
/// refusal codes (L10n.known) take it from here.
public final class PinAdvice: @unchecked Sendable {
    public static let shared = PinAdvice()

    private let lock = NSLock()
    private var _pinPath: String?
    private var _installed: Bool?

    public init() {}

    public func update(pinPath: String?, installed: Bool?) {
        lock.withLock {
            _pinPath = pinPath.flatMap { $0.isEmpty ? nil : $0 }
            _installed = installed
        }
    }

    private var context: (pinPath: String?, installed: Bool?) { lock.withLock { (_pinPath, _installed) } }

    /// This copy isn't pinned: open the pinned build, otherwise fix it.
    public var openPinned: String {
        let c = context
        let open = c.pinPath.map { p in
            let short = (p as NSString).abbreviatingWithTildeInPath
            return tr("Откройте закреплённую сборку: \(short).", "Open the pinned build: \(short).")
        } ?? tr("Откройте закреплённую сборку приложения.", "Open the pinned app build.")
        return open + " " + repair(c.installed)
    }

    /// No pin at all: only a fix.
    public var repairOnly: String { repair(context.installed) }

    private func repair(_ installed: Bool?) -> String {
        installed == true
            ? tr("Если её нет — почините установку установщиком: bash install.sh (та же версия, без пересборки).",
                 "If it's gone, repair the install with the installer: bash install.sh (same version, no rebuild).")
            : tr("Разработчику: scripts/bundle.sh --pin-live — собрать и закрепить эту копию (обычный bundle.sh не закрепляет).",
                 "For developers: scripts/bundle.sh --pin-live builds and pins this copy (plain bundle.sh doesn't pin).")
    }
}

// MARK: - terminals

/// Texts of the terminal layer (Settings → Terminal, disabled buttons). Terminal names come from the daemon (`label`); the shell
/// knows only the capability names, not the terminals.
public enum TerminalText {
    /// The capability as a short phrase: "switch to tab".
    public static func capability(_ c: String) -> String {
        switch c {
        case "focus": return tr("переход во вкладку", "switch to tab")
        case "read-screen": return tr("чтение экрана", "read the screen")
        case "send-text": return tr("набор строки", "type a line")
        case "send-esc": return tr("Esc (прервать ход)", "Esc (interrupt)")
        case "launch": return tr("новая вкладка", "new tab")
        default: return c
        }
    }

    /// The tooltip of a button the session's terminal can't serve.
    public static func unsupported(terminal: String, capability c: String) -> String {
        switch c {
        case "focus": return tr("\(terminal) не умеет переходить во вкладку из хаба", "\(terminal) can't switch to the tab from the hub")
        case "send-esc": return tr("\(terminal) не умеет нажимать Esc из хаба — прервите ход во вкладке", "\(terminal) can't press Esc from the hub — interrupt the turn in the tab")
        default: return tr("\(terminal) не умеет: \(capability(c))", "\(terminal) doesn't support: \(capability(c))")
        }
    }

    /// The note under the launch form: where the tab opens. nil — no terminal can open one.
    public static func launchNote(_ label: String?) -> String {
        guard let label else { return tr("Промпт уйдёт файлом 0600 и удалится после чтения.", "The prompt goes as a 0600 file and is deleted after reading.") }
        return tr("Новая вкладка \(label) откроется в фоне. Промпт уйдёт файлом 0600 и удалится после чтения.",
                  "A new \(label) tab opens in the background. The prompt goes as a 0600 file and is deleted after reading.")
    }

    /// Why a new session opens in this terminal (`/state.terminals.launch.why`).
    public static func launchWhy(_ why: String?) -> String? {
        switch why {
        case "setting": return tr("выбран в настройках хаба", "set in the hub's config")
        case "sessions": return tr("в нём больше всего сессий", "most sessions run there")
        case "installed": return tr("первый установленный", "the first one installed")
        default: return nil
        }
    }

    /// The adapter's state line: sessions now, installed, available (a bridge adapter follows `bridgeOnline`).
    public static func status(_ a: TerminalsInfo.Adapter, bridgeOnline: Bool) -> String {
        var parts: [String] = []
        if a.sessions > 0 { parts.append("\(a.sessions) " + plural(a.sessions, ru: ("сессия", "сессии", "сессий"), en: ("session", "sessions"))) }
        if a.via == "bridge" {
            parts.append(bridgeOnline ? tr("мост подключён", "bridge connected") : tr("мост не подключён", "bridge not connected"))
        } else if a.needsSetup {
            parts.append(tr("нужна настройка", "needs setup"))
        } else if a.installed == false, a.sessions == 0 {
            parts.append(tr("не найден", "not found"))
        } else if !a.available, a.reasonText != nil {
            parts.append(tr("недоступен", "unavailable"))
        } else if a.installed == true {
            parts.append(tr("установлен", "installed"))
        }
        return parts.isEmpty ? "—" : parts.joined(separator: " · ")
    }

    /// Whether the adapter can run operations now: through the bridge — while it is connected.
    public static func ready(_ a: TerminalsInfo.Adapter, bridgeOnline: Bool) -> Bool {
        a.via == "bridge" ? bridgeOnline : a.available
    }

}

/// "cmux bridge" in Settings when there's no information about the bridge: without a connection to the hub — say so, rather than "the actions
/// service isn't running" (the whole hub isn't answering).
public enum BridgeSettingsText {
    public static func missing(stateKnown: Bool) -> String {
        stateKnown ? tr("Служба действий хаба не запущена — моста нет", "The hub's actions service isn't running — no bridge")
                   : tr("Нет связи с хабом — состояние моста неизвестно", "No connection to the hub — the bridge state is unknown")
    }
}
