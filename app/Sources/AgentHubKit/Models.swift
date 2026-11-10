import Foundation

// Daemon response models, per docs/api.md (GET /state, SSE GET /events, POST /actions/:id).
// Lenient parsing: a missing field → default value, an unknown status value → unknown.
// This way a newer daemon with extra fields does not crash the app.

/// Plugin status / worst status. Severity order as in the core: ok < unknown < wait < block < error.
public enum HubStatus: String, Codable, Sendable, CaseIterable, Comparable {
    case ok, unknown, wait, block, error

    public var severity: Int {
        switch self {
        case .ok: return 0
        case .unknown: return 1
        case .wait: return 2
        case .block: return 3
        case .error: return 4
        }
    }

    public static func < (a: HubStatus, b: HubStatus) -> Bool { a.severity < b.severity }

    public init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = HubStatus(rawValue: raw) ?? .unknown
    }

    public static func worst(_ list: some Sequence<HubStatus>) -> HubStatus {
        list.reduce(.ok) { max($0, $1) }
    }
    // Labels: L10n.swift (label, hint).
}

/// Action confirmation level. The core decides; the app only displays it.
public enum ActionLevel: String, Codable, Sendable {
    case immediate, confirm
    case confirmCost = "confirm-cost"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
        self = ActionLevel(rawValue: raw) ?? .unknown
    }
}

/// A plugin offer: `offer.id` is passed to `POST /actions/:id`.
public struct Offer: Codable, Sendable, Hashable {
    public var id: String
    public var kind: String            // "effect" | "action"
    public var primitive: String?
    public var action: String?
    public var level: ActionLevel
    public var label: String?
    /// An action of a non-built-in plugin: the core accepts it only from the app (class app), even if immediate.
    public var appOnly: Bool = false

    public init(id: String, kind: String, primitive: String? = nil, action: String? = nil, level: ActionLevel, label: String? = nil, appOnly: Bool = false) {
        self.id = id; self.kind = kind; self.primitive = primitive; self.action = action; self.level = level; self.label = label; self.appOnly = appOnly
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "effect"
        primitive = try? c.decodeIfPresent(String.self, forKey: .primitive)
        action = try? c.decodeIfPresent(String.self, forKey: .action)
        level = (try? c.decode(ActionLevel.self, forKey: .level)) ?? .unknown
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        appOnly = (try? c.decodeIfPresent(Bool.self, forKey: .appOnly)) ?? false
    }
}

/// Session mark in a plugin row: the core verifies the signature.
public struct ItemSession: Codable, Sendable, Hashable {
    public var id: String
    public var pid: Int?
    public var verified: Bool?         // nil — verification still in progress
    public var label: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        pid = try? c.decodeIfPresent(Int.self, forKey: .pid)
        verified = try? c.decodeIfPresent(Bool.self, forKey: .verified)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
    }
}

/// A plugin output row (SwiftBar format after parsing by the core).
public struct Item: Codable, Sendable, Hashable {
    public var title: String
    public var level: Int
    public var separator: Bool
    public var status: HubStatus?
    public var event: String?
    public var params: [String: String]
    public var offer: Offer?
    public var session: ItemSession?

    public init(title: String, level: Int = 0, separator: Bool = false, status: HubStatus? = nil, event: String? = nil,
                params: [String: String] = [:], offer: Offer? = nil) {
        self.title = title; self.level = level; self.separator = separator; self.status = status
        self.event = event; self.params = params; self.offer = offer; self.session = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        level = (try? c.decode(Int.self, forKey: .level)) ?? 0
        separator = (try? c.decode(Bool.self, forKey: .separator)) ?? false
        status = try? c.decodeIfPresent(HubStatus.self, forKey: .status)
        event = try? c.decodeIfPresent(String.self, forKey: .event)
        // parameter values are strings; anything else (number/bool) is converted to a string
        if let raw = try? c.decodeIfPresent([String: JSONValue].self, forKey: .params) {
            params = raw.compactMapValues { v in v == .null ? nil : v.display }
        } else {
            params = [:]
        }
        offer = try? c.decodeIfPresent(Offer.self, forKey: .offer)
        session = try? c.decodeIfPresent(ItemSession.self, forKey: .session)
    }

    /// SF Symbol from the SwiftBar `sfimage` parameter.
    public var sfImage: String? { params["sfimage"] }
    public var tooltip: String? { params["tooltip"] }
    public var color: String? { params["color"] }
    public var badge: String? { params["badge"] }
    /// `badgeColor=`: the badge tint (the `color=` palette); nil — the neutral badge.
    public var badgeColor: String? { params["badgeColor"].flatMap { $0.isEmpty ? nil : $0 } }
    /// `iconColor=`: colors only the `sfimage` icon; the title keeps `color=` (or the default).
    public var iconColor: String? { params["iconColor"].flatMap { $0.isEmpty ? nil : $0 } }
    /// `link=true` on a line with `href=`/`effect=`: drawn as a text link instead of a capsule button.
    public var isLink: Bool { params["link"] == "true" }
    /// Number card (`stat="Next run"`): the row title is the value, `stat` the caption, `note` the line below it.
    public var stat: String? { params["stat"].flatMap { $0.isEmpty ? nil : $0 } }
    /// A short note to the right of or below the row (`note="resets in 2 h"`).
    public var note: String? { params["note"].flatMap { $0.isEmpty ? nil : $0 } }
    /// Fill bar 0…100 (`gauge=62`); in the first header row it is a ring on the plugin page.
    public var gauge: Double? { params["gauge"].flatMap(Double.init).map { min(100, max(0, $0)) } }
    /// Caption under the number in the ring (`gaugeLabel="week"`).
    public var gaugeLabel: String? { params["gaugeLabel"] }
    /// The row's children as a strip of cells (`strip=true`), for example "Recent runs".
    public var isStrip: Bool { params["strip"] == "true" }
    /// The row's children at the second level, collapsed (`details=true`): process ids, schedules, internals.
    public var isDetails: Bool { params["details"] == "true" }
}

public struct PluginAction: Codable, Sendable, Hashable {
    public var id: String
    public var level: ActionLevel
    public var title: String?
}

/// Plugin tier. The daemon decides it: install location (app directory, `Plugins/local`) and the signed registry
/// index (`plugins.lock`), never the plugin's own metadata. The app only displays it.
public enum PluginTier: String, Codable, Sendable, Hashable {
    /// own — an own plugin from a local folder that a human approved in the app (trusted like an official one).
    case builtin, official, own, community, local

    /// `tier` from the daemon response; for an old daemon without it, derived from `source` and `official`.
    public init(tier: String?, source: String, official: Bool) {
        if let t = tier, let v = PluginTier(rawValue: t) { self = v; return }
        switch source {
        case "builtin": self = .builtin
        case "local": self = .local
        default: self = official ? .official : .community
        }
    }

    /// Whether it can be removed from the manager: anything installed by the manager (official and third-party). Built-in ones ship
    /// with the app; `Plugins/local` is the developer directory.
    public var removable: Bool { self == .official || self == .own || self == .community }
}

/// Plugin state in the snapshot.
public struct PluginState: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var source: String          // builtin | installed | local
    public var tier: PluginTier
    public var trusted: Bool
    public var file: String?
    public var type: String            // standard | streamable
    public var title: String
    /// Description from the metadata (<agenthub.desc>, in the hub language).
    public var desc: String?
    /// Custom status labels (<agenthub.status>): ok|wait|… → { label, hint }.
    public var statusLabels: [String: StatusLabel]
    public var version: String?
    /// Author from the metadata: name and GitHub login.
    public var author: PluginAuthor?
    public var interval: String?
    public var schedule: String?
    public var effects: [String]
    public var actions: [PluginAction]
    public var status: HubStatus
    public var error: String?
    public var lastRunAt: String?
    public var durationMs: Double?
    public var pid: Int?
    public var events: [String]
    public var header: [Item]
    public var body: [Item]
    /// Plugin icon (`<agenthub.icon>`, contract 2); nil if not declared: a neutral icon.
    public var icon: PluginIcon?
    /// Minimum contract version the plugin declared (1 if not declared); an older daemon gives nil.
    public var contract: Int?

    public init(id: String, title: String, status: HubStatus, header: [Item] = [], body: [Item] = [], source: String = "builtin", icon: PluginIcon? = nil) {
        self.id = id; self.source = source; self.tier = PluginTier(tier: nil, source: source, official: false)
        self.trusted = source == "builtin"; self.file = nil; self.type = "standard"
        self.title = title; self.desc = nil; self.statusLabels = [:]; self.version = nil; self.author = nil; self.interval = nil; self.schedule = nil; self.effects = []; self.actions = []
        self.status = status; self.error = nil; self.lastRunAt = nil; self.durationMs = nil; self.pid = nil; self.events = []
        self.header = header; self.body = body; self.icon = icon; self.contract = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        icon = try? c.decodeIfPresent(PluginIcon.self, forKey: .icon)
        contract = try? c.decodeIfPresent(Int.self, forKey: .contract)
        source = (try? c.decode(String.self, forKey: .source)) ?? "builtin"
        let extra = try decoder.container(keyedBy: ExtraKeys.self)
        tier = PluginTier(tier: try? c.decodeIfPresent(String.self, forKey: .tier), source: source,
                          official: (try? extra.decode(Bool.self, forKey: .official)) ?? false)
        trusted = (try? c.decode(Bool.self, forKey: .trusted)) ?? false
        file = try? c.decodeIfPresent(String.self, forKey: .file)
        type = (try? c.decode(String.self, forKey: .type)) ?? "standard"
        title = (try? c.decode(String.self, forKey: .title)) ?? id
        desc = try? c.decodeIfPresent(String.self, forKey: .desc)
        statusLabels = (try? c.decode([String: StatusLabel].self, forKey: .statusLabels)) ?? [:]
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        author = (try? c.decodeIfPresent(PluginAuthor.self, forKey: .author)).flatMap { $0.isEmpty ? nil : $0 }
        interval = try? c.decodeIfPresent(String.self, forKey: .interval)
        schedule = try? c.decodeIfPresent(String.self, forKey: .schedule)
        effects = (try? c.decode([String].self, forKey: .effects)) ?? []
        actions = (try? c.decode([PluginAction].self, forKey: .actions)) ?? []
        status = (try? c.decode(HubStatus.self, forKey: .status)) ?? .unknown
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        lastRunAt = try? c.decodeIfPresent(String.self, forKey: .lastRunAt)
        durationMs = try? c.decodeIfPresent(Double.self, forKey: .durationMs)
        pid = try? c.decodeIfPresent(Int.self, forKey: .pid)
        events = (try? c.decode([String].self, forKey: .events)) ?? []
        header = (try? c.decode([Item].self, forKey: .header)) ?? []
        body = (try? c.decode([Item].self, forKey: .body)) ?? []
    }

    /// Menu line: the first non-empty header row, otherwise the plugin name.
    public var headline: String {
        header.first(where: { !$0.separator && !$0.title.isEmpty })?.title ?? title
    }

    /// Daemon response fields that are not among the properties (an old daemon without `tier`).
    private enum ExtraKeys: String, CodingKey { case official }

    /// The tier is marked in the UI.
    public var sourceLabel: String { tier.label }
}

/// A plugin icon declared by the plugin itself (`<agenthub.icon symbol="…" color="#RRGGBB">`, contract 2): SF Symbol name and
/// tile color. The hub knows no specific plugins' icons; an invalid declaration is not parsed and gives a neutral icon.
public struct PluginIcon: Codable, Sendable, Hashable {
    public var symbol: String
    public var color: String?

    public init?(symbol: String, color: String? = nil) {
        guard Self.validSymbol(symbol), color.map(Self.validColor) ?? true else { return nil }
        self.symbol = symbol; self.color = color?.uppercased()
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let s = try c.decode(String.self, forKey: .symbol)
        let col = try? c.decodeIfPresent(String.self, forKey: .color)
        guard Self.validSymbol(s) else { throw DecodingError.dataCorruptedError(forKey: .symbol, in: c, debugDescription: "symbol") }
        symbol = s
        color = col.flatMap { Self.validColor($0) ? $0.uppercased() : nil }
    }

    enum CodingKeys: String, CodingKey { case symbol, color }

    /// The same rules as the daemon (`daemon/lib/meta.mjs` ICON_SYMBOL_RE / ICON_COLOR_RE).
    public static func validSymbol(_ s: String) -> Bool {
        s.count <= 64 && s.range(of: #"^[a-z0-9]+(\.[a-z0-9]+){0,7}$"#, options: .regularExpression) != nil
    }
    public static func validColor(_ s: String) -> Bool { s.range(of: #"^#[0-9A-Fa-f]{6}$"#, options: .regularExpression) != nil }

    /// Color as the number 0xRRGGBB; nil if not declared.
    public var rgb: UInt32? { color.flatMap { UInt32($0.dropFirst(), radix: 16) } }
}

/// A Claude Code session from the core registry (signature-verified only).
public struct SessionInfo: Codable, Sendable, Hashable, Identifiable {
    public var sessionId: String
    public var pid: Int?
    public var startSec: Double?
    public var status: String?         // busy | waiting | idle
    public var waitingFor: String?
    public var name: String?
    public var cwd: String?
    public var kind: String?
    public var surfaceId: String?
    public var workspaceId: String?
    public var sources: [String]
    public var interactive: Bool
    public var updatedAt: Double?
    /// Effort of the last turn (low | medium | high | xhigh | max), from the session transcript (claude-sessions plugin,
    /// metadata fields only). May be stale for an idle session. nil means unknown.
    public var effort: String?
    /// ⚡ultracode from the last marker in the transcript; nil if there are no markers.
    public var ultracode: Bool?
    /// The core terminal layer found the session's tab (`terminal` is its adapter, for example "cmux") and the adapter can
    /// jump to it: the "Go to" button via `session.focus`. nil means an older daemon (no field).
    public var terminal: String?
    public var focusable: Bool?

    public var id: String { sessionId }

    public init(sessionId: String, status: String?, name: String? = nil, cwd: String? = nil, surfaceId: String? = nil, effort: String? = nil, ultracode: Bool? = nil) {
        self.sessionId = sessionId; self.status = status; self.sources = []; self.interactive = false
        self.name = name; self.cwd = cwd; self.surfaceId = surfaceId; self.effort = effort; self.ultracode = ultracode
    }

    /// Known effort levels; anything else is not shown.
    public static let effortLevels = ["low", "medium", "high", "xhigh", "max"]

    /// Effort capsule: the level, if known.
    public var effortLabel: String? { effort.flatMap { Self.effortLevels.contains($0) ? $0 : nil } }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = (try? c.decode(String.self, forKey: .sessionId)) ?? ""
        pid = try? c.decodeIfPresent(Int.self, forKey: .pid)
        startSec = try? c.decodeIfPresent(Double.self, forKey: .startSec)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        waitingFor = try? c.decodeIfPresent(String.self, forKey: .waitingFor)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        cwd = try? c.decodeIfPresent(String.self, forKey: .cwd)
        kind = try? c.decodeIfPresent(String.self, forKey: .kind)
        surfaceId = try? c.decodeIfPresent(String.self, forKey: .surfaceId)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        sources = (try? c.decode([String].self, forKey: .sources)) ?? []
        interactive = (try? c.decode(Bool.self, forKey: .interactive)) ?? false
        updatedAt = try? c.decodeIfPresent(Double.self, forKey: .updatedAt)
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        ultracode = try? c.decodeIfPresent(Bool.self, forKey: .ultracode)
        terminal = try? c.decodeIfPresent(String.self, forKey: .terminal)
        focusable = try? c.decodeIfPresent(Bool.self, forKey: .focusable)
    }

    public var isWaiting: Bool { status == "waiting" }
}

public struct PrimitiveInfo: Codable, Sendable, Hashable {
    public var name: String
    public var level: ActionLevel
    public var remoteAllowed: Bool
    public var appOnly: Bool
    /// Works while the hub is paused (the daemon sends the field since 2026-11-05; nil means an old daemon, and the app uses its own list).
    public var safeUnderEstop: Bool?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        level = (try? c.decode(ActionLevel.self, forKey: .level)) ?? .unknown
        remoteAllowed = (try? c.decode(Bool.self, forKey: .remoteAllowed)) ?? false
        appOnly = (try? c.decode(Bool.self, forKey: .appOnly)) ?? false
        safeUnderEstop = try? c.decodeIfPresent(Bool.self, forKey: .safeUnderEstop)
    }
}

/// Our peer class as the daemon sees us (`app` is needed for confirmations).
public struct PeerInfo: Codable, Sendable, Hashable {
    public var `class`: String
    public var reason: String?

    public init(class cls: String, reason: String?) { self.class = cls; self.reason = reason }

    public var isApp: Bool { self.class == "app" }
}

/// What is pinned in the daemon's `requirements.app` and when (`appPin` in `GET /state`, event `app-pin.changed`).
/// `kind`: `cdhash` (ad hoc build by cdhash, the default), `cert` (certificate), `other`, `none`.
/// `by`/`under` as reported by whoever wrote config.json (`agenthub pin-app`, from a terminal / from under Claude Code).
public struct AppPinInfo: Codable, Sendable, Hashable {
    public var kind: String
    public var fingerprint: String
    public var changedAt: String?
    public var by: String?
    public var under: String?
    public var source: String?
    /// Fingerprint before this change: `none` means the first pin, `unknown` means the daemon does not remember; nil means a daemon older than 2026-11-05.
    public var old: String?
    /// The bundle the daemon launches at start and after a crash (`appPin.path`); nil means no path (`--cert` mode,
    /// an entry from before 2026-11-06) or an older daemon.
    public var path: String?

    public init(kind: String, fingerprint: String, changedAt: String? = nil, by: String? = nil, under: String? = nil, source: String? = nil, old: String? = nil, path: String? = nil) {
        self.kind = kind; self.fingerprint = fingerprint; self.changedAt = changedAt; self.by = by; self.under = under; self.source = source; self.old = old; self.path = path
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "none"
        fingerprint = (try? c.decode(String.self, forKey: .fingerprint)) ?? "none"
        changedAt = try? c.decodeIfPresent(String.self, forKey: .changedAt)
        by = try? c.decodeIfPresent(String.self, forKey: .by)
        under = try? c.decodeIfPresent(String.self, forKey: .under)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        old = try? c.decodeIfPresent(String.self, forKey: .old)
        path = try? c.decodeIfPresent(String.self, forKey: .path)
    }

    /// First pin: there was no requirement before (or the daemon does not remember what it was), so not "rebuilt".
    /// One rule for the panel banner, the journal label (`L10n.typeLabel`) and the daemon push (`services/push.mjs`).
    public var isFirstPin: Bool { old.map(Self.isFirstPin(old:)) ?? false }
    /// `old` is the previous fingerprint from `app-pin.changed` / a journal entry: `none` means none, `unknown` means the daemon does not remember.
    public static func isFirstPin(old: String) -> Bool { old == "none" || old == "unknown" }

    /// Short fingerprint: `cdhash 1347dd31e6cd…`.
    public var shortFingerprint: String {
        guard let i = fingerprint.firstIndex(of: ":") else { return fingerprint }
        let kindName = String(fingerprint[..<i])
        let value = fingerprint[fingerprint.index(after: i)...]
        return "\(kindName) \(value.prefix(12))…"
    }

    /// Time of the last requirement change.
    public var changedDate: Date? {
        guard let changedAt else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: changedAt) ?? ISO8601DateFormatter().date(from: changedAt)
    }

    /// Changed recently (within a day by default): the panel line is shown prominently.
    public func isRecent(now: Date = Date(), within: TimeInterval = 24 * 3600) -> Bool {
        guard let d = changedDate else { return false }
        return now.timeIntervalSince(d) < within
    }
}

/// The `GET /state` snapshot.
public struct HubState: Codable, Sendable, Hashable {
    public var version: String?
    /// Plugin contract version the daemon understands (`/state.contract`; contract 2 since 2026-11-09). nil means an older daemon.
    public var contract: Int?
    public var now: String?
    public var pid: Int?
    public var seq: Int
    public var estop: Bool
    public var status: HubStatus
    public var waitingSessions: Int
    public var plugins: [PluginState]
    public var sessions: [SessionInfo]
    public var primitives: [PrimitiveInfo]
    public var peer: PeerInfo?
    public var appPin: AppPinInfo?
    /// Hub language: the setting and the effective one (`GET /state.lang`).
    public var lang: LangInfo?
    /// Where the hub lives: directory, whether it is a test one, where built-in plugins come from (`GET /state.hub`).
    public var hub: HubInfo?
    /// The cmux bridge (`GET /state.bridge`): whether it is connected and how to start it. nil means the daemon has no actions service.
    public var bridge: BridgeInfo?
    /// Available registry plugin updates (`GET /state.pluginUpdates`, event `plugins.updates`). nil means the daemon
    /// has no plugins service (or is old).
    public var pluginUpdates: PluginUpdates?
    /// Update of the hub itself (`GET /state.hubUpdate`, event `hub-update.status`; docs/hub-updates.md). nil means the
    /// daemon has no hub-update service (or is old).
    public var hubUpdate: HubUpdateInfo?
    /// "Launch at login" (`GET /state.launchAtLogin`, `settings.json → launchAtLogin`; decision 2026-11-07): the daemon +
    /// app pair. nil means an older daemon.
    public var launchAtLogin: LaunchAtLoginInfo?
    /// "Settings → Notifications" (`GET /state.notifications`, `settings.json → notifications`; 2026-11-09): the master
    /// switch, kinds, quiet hours, security exceptions. nil means an older daemon.
    public var notifications: NotificationsInfo?
    /// Whether the computer can be shut down (`GET /state.idle`, event `idle.verdict`; the daemon's idle service). nil means no service
    /// or an older daemon: the icon and popover behave as before.
    public var idle: IdleVerdict?
    /// OAuth connections to external services (`GET /state.connections`, event `connections.changed`; the daemon's oauth
    /// service): those declared by installed plugins (`<agenthub.connection>`). nil means no service or an older daemon.
    public var connections: [ConnectionInfo]?
    /// Own plugins from local folders (`GET /state.ownPlugins`, plugins service, 2026-11-09): install requests waiting
    /// for a human in the app, and own plugins whose folder is gone or broken. nil means an older daemon.
    public var ownPlugins: OwnPluginsInfo?

    public init(plugins: [PluginState] = [], sessions: [SessionInfo] = [], estop: Bool = false, seq: Int = 0) {
        self.version = nil; self.contract = nil; self.now = nil; self.pid = nil; self.seq = seq; self.estop = estop
        self.plugins = plugins; self.sessions = sessions; self.primitives = []; self.peer = nil; self.appPin = nil; self.lang = nil; self.hub = nil; self.bridge = nil; self.pluginUpdates = nil
        self.hubUpdate = nil
        self.launchAtLogin = nil
        self.notifications = nil
        self.idle = nil
        self.connections = nil
        self.ownPlugins = nil
        self.status = HubStatus.worst(plugins.map(\.status))
        self.waitingSessions = sessions.filter(\.isWaiting).count
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        contract = try? c.decodeIfPresent(Int.self, forKey: .contract)
        now = try? c.decodeIfPresent(String.self, forKey: .now)
        pid = try? c.decodeIfPresent(Int.self, forKey: .pid)
        seq = (try? c.decode(Int.self, forKey: .seq)) ?? 0
        estop = (try? c.decode(Bool.self, forKey: .estop)) ?? false
        plugins = (try? c.decode([PluginState].self, forKey: .plugins)) ?? []
        sessions = (try? c.decode([SessionInfo].self, forKey: .sessions)) ?? []
        primitives = (try? c.decode([PrimitiveInfo].self, forKey: .primitives)) ?? []
        peer = try? c.decodeIfPresent(PeerInfo.self, forKey: .peer)
        appPin = try? c.decodeIfPresent(AppPinInfo.self, forKey: .appPin)
        lang = try? c.decodeIfPresent(LangInfo.self, forKey: .lang)
        hub = try? c.decodeIfPresent(HubInfo.self, forKey: .hub)
        bridge = try? c.decodeIfPresent(BridgeInfo.self, forKey: .bridge)
        pluginUpdates = try? c.decodeIfPresent(PluginUpdates.self, forKey: .pluginUpdates)
        hubUpdate = try? c.decodeIfPresent(HubUpdateInfo.self, forKey: .hubUpdate)
        launchAtLogin = try? c.decodeIfPresent(LaunchAtLoginInfo.self, forKey: .launchAtLogin)
        notifications = try? c.decodeIfPresent(NotificationsInfo.self, forKey: .notifications)
        idle = try? c.decodeIfPresent(IdleVerdict.self, forKey: .idle)
        connections = try? c.decodeIfPresent([ConnectionInfo].self, forKey: .connections)
        ownPlugins = try? c.decodeIfPresent(OwnPluginsInfo.self, forKey: .ownPlugins)
        status = (try? c.decode(HubStatus.self, forKey: .status)) ?? HubStatus.worst(plugins.map(\.status))
        waitingSessions = (try? c.decode(Int.self, forKey: .waitingSessions)) ?? sessions.filter(\.isWaiting).count
    }

    /// Plugins for the menu: those needing attention first (by descending severity), otherwise in the daemon's order.
    public var pluginsByAttention: [PluginState] {
        plugins.enumerated()
            .sorted { a, b in
                a.element.status != b.element.status ? a.element.status > b.element.status : a.offset < b.offset
            }
            .map(\.element)
    }
}

/// `bridge` in `/state`: the cmux bridge. `command` is the path to the bridge script; `home`/`defaultHome` say whether the command
/// needs `AGENTHUB_HOME` (the hub is not in the default directory).
public struct BridgeInfo: Codable, Sendable, Hashable {
    public var online: Bool
    public var since: String?
    public var version: String?
    public var command: String?
    public var home: String?
    public var defaultHome: Bool

    public init(online: Bool, since: String? = nil, version: String? = nil, command: String? = nil, home: String? = nil, defaultHome: Bool = true) {
        self.online = online; self.since = since; self.version = version; self.command = command; self.home = home; self.defaultHome = defaultHome
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        online = (try? c.decode(Bool.self, forKey: .online)) ?? false
        since = try? c.decodeIfPresent(String.self, forKey: .since)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        command = try? c.decodeIfPresent(String.self, forKey: .command)
        home = try? c.decodeIfPresent(String.self, forKey: .home)
        defaultHome = (try? c.decode(Bool.self, forKey: .defaultHome)) ?? true
    }

    enum CodingKeys: String, CodingKey { case online, since, version, command, home, defaultHome }

    /// The bridge start command for a cmux tab (zsh): the path quoted if needed; `AGENTHUB_HOME=…` if the hub
    /// is not in the default directory.
    public var launchCommand: String {
        func q(_ v: String) -> String { v.range(of: #"^[A-Za-z0-9_./:@%+=-]+$"#, options: .regularExpression) != nil ? v : "'" + v.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let cmd = command.map(q) ?? "agenthub-bridge"
        if !defaultHome, let home { return "AGENTHUB_HOME=\(q(home)) \(cmd)" }
        return cmd
    }
}

/// `hub` in `/state`: the state directory, whether it is a test one (not the default directory), where built-in plugins come from:
/// `copy` (`<home>/Builtin`), `repo` (the repository working tree), `custom`.
public struct HubInfo: Codable, Sendable, Hashable {
    public var home: String?
    public var testMode: Bool
    public var builtinDir: String?
    public var builtin: String?
    /// Full path to the daemon's `agenthub` CLI, for hints with a command (`agenthub pin-app`); nil means an older daemon.
    public var cli: String?

    public init(home: String? = nil, testMode: Bool = false, builtinDir: String? = nil, builtin: String? = nil, cli: String? = nil) {
        self.home = home; self.testMode = testMode; self.builtinDir = builtinDir; self.builtin = builtin; self.cli = cli
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        home = try? c.decodeIfPresent(String.self, forKey: .home)
        testMode = (try? c.decode(Bool.self, forKey: .testMode)) ?? false
        builtinDir = try? c.decodeIfPresent(String.self, forKey: .builtinDir)
        builtin = try? c.decodeIfPresent(String.self, forKey: .builtin)
        cli = try? c.decodeIfPresent(String.self, forKey: .cli)
    }

    enum CodingKeys: String, CodingKey { case home, testMode, builtinDir, builtin, cli }
}

/// `launchAtLogin` in `/state`, `GET /settings` and the `PUT /settings/launch-at-login` response: "Launch at login" covers the
/// daemon + app pair (decision 2026-11-07). When off, a daemon started at login does not launch the app and
/// exits; an app opened by hand starts the daemon itself.
public struct LaunchAtLoginInfo: Codable, Sendable, Hashable {
    public var setting: Bool
    /// KeepAlive of the daemon job: `ok`, `outdated` (a plist from before 2026-11-06 with KeepAlive true, under which the disabled setting does not
    /// work: `agenthub install --apply` is needed), `missing`, `unknown`; nil means the daemon did not check.
    public var launchAgent: String?

    public init(setting: Bool, launchAgent: String? = nil) { self.setting = setting; self.launchAgent = launchAgent }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        setting = (try? c.decode(Bool.self, forKey: .setting)) ?? true
        launchAgent = try? c.decodeIfPresent(String.self, forKey: .launchAgent)
    }

    /// An old LaunchAgent: the toggle is disabled and the hint says to reinstall.
    public var agentOutdated: Bool { launchAgent == "outdated" }

    enum CodingKeys: String, CodingKey { case setting, launchAgent }
}

/// `notifications` in `/state`, `GET /settings`, the `PUT /settings/notifications` response and the `settings.changed` event:
/// "Settings → Notifications". A disabled kind does not arrive at all: no banner, no osascript fallback, no Telegram;
/// the event stays in the popover and the journal (`push-muted`). `security` lists the security exceptions: they arrive under any
/// toggles (hub events and trusted plugin rules with `kind="security"`).
public struct NotificationsInfo: Codable, Sendable, Hashable {
    /// Shared core kinds with toggles, in Settings order (like the daemon's `KINDS`, `daemon/lib/push/prefs.mjs`). Anything
    /// that belongs to a specific plugin is that plugin's own toggle (`plugins`); the daemon builds the row.
    public static let kinds = ["sessions", "updates", "problems", "other"]

    /// A plugin's own toggle (contract 2): the plugin declared `<agenthub.push kind="plugin">` rules. The title is in the
    /// hub language, the labels are its rules'; `legacy` means it was turned off by migrating an earlier setting and the person has not touched it.
    public struct PluginToggle: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var on: Bool
        public var labels: [String]
        public var legacy: Bool

        public init(id: String, title: String, on: Bool = true, labels: [String] = [], legacy: Bool = false) {
            self.id = id; self.title = title; self.on = on; self.labels = labels; self.legacy = legacy
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = (try? c.decode(String.self, forKey: .title)) ?? id
            on = (try? c.decode(Bool.self, forKey: .on)) ?? true
            labels = (try? c.decode([String].self, forKey: .labels)) ?? []
            legacy = (try? c.decode(Bool.self, forKey: .legacy)) ?? false
        }

        enum CodingKeys: String, CodingKey { case id, title, on, labels, legacy }
    }

    public struct Quiet: Codable, Sendable, Hashable {
        public var enabled: Bool
        public var start: String
        public var end: String
        /// Source: `settings` (set here), `config` (`services.push.quietStart/quietEnd` in config.json, as before
        /// 2026-11-09), `default` (23:00–08:00).
        public var from: String?
        /// The time zone the daemon uses for quiet hours (`services.push.timezone` or the system one); an older daemon gives nil.
        public var timezone: String?

        public init(enabled: Bool = true, start: String = "23:00", end: String = "08:00", from: String? = nil, timezone: String? = nil) {
            self.enabled = enabled; self.start = start; self.end = end; self.from = from; self.timezone = timezone
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? true
            start = (try? c.decode(String.self, forKey: .start)) ?? "23:00"
            end = (try? c.decode(String.self, forKey: .end)) ?? "08:00"
            from = try? c.decodeIfPresent(String.self, forKey: .from)
            timezone = try? c.decodeIfPresent(String.self, forKey: .timezone)
        }

        enum CodingKeys: String, CodingKey { case enabled, start, end, from, timezone }
    }

    /// A security exception: the rule key, the source (`@hub` is the hub itself, otherwise a plugin id), the label in the hub language.
    public struct SecurityItem: Codable, Sendable, Hashable, Identifiable {
        public var key: String
        public var plugin: String
        public var pluginTitle: String?
        public var label: String
        public var id: String { "\(plugin):\(key)" }

        public init(key: String, plugin: String = "@hub", pluginTitle: String? = nil, label: String = "") {
            self.key = key; self.plugin = plugin; self.pluginTitle = pluginTitle; self.label = label
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            key = (try? c.decode(String.self, forKey: .key)) ?? ""
            plugin = (try? c.decode(String.self, forKey: .plugin)) ?? "@hub"
            pluginTitle = try? c.decodeIfPresent(String.self, forKey: .pluginTitle)
            label = (try? c.decode(String.self, forKey: .label)) ?? ""
        }

        enum CodingKeys: String, CodingKey { case key, plugin, pluginTitle, label }
    }

    public var enabled: Bool
    public var kinds: [String: Bool]
    /// Own toggles of installed plugins (empty for an older daemon).
    public var plugins: [PluginToggle]
    public var quiet: Quiet
    public var security: [SecurityItem]
    /// The push service is running (`services.push.enabled` is not false in config.json).
    public var service: Bool
    /// Telegram is enabled in config.json (never in a test directory).
    public var telegram: Bool
    /// Idle threshold after which a notification goes to Telegram (`services.push.idleThresholdMs`); an older daemon gives nil.
    public var awayAfterMs: Int?

    public init(enabled: Bool = true, kinds: [String: Bool] = [:], plugins: [PluginToggle] = [], quiet: Quiet = Quiet(), security: [SecurityItem] = [], service: Bool = true, telegram: Bool = false, awayAfterMs: Int? = nil) {
        self.enabled = enabled; self.kinds = kinds; self.plugins = plugins; self.quiet = quiet; self.security = security; self.service = service; self.telegram = telegram; self.awayAfterMs = awayAfterMs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? true
        kinds = (try? c.decode([String: Bool].self, forKey: .kinds)) ?? [:]
        // a broken row does not break the rest
        plugins = ((try? c.decode([JSONValue].self, forKey: .plugins)) ?? []).compactMap { v in
            (try? JSONEncoder().encode(v)).flatMap { try? JSONDecoder().decode(PluginToggle.self, from: $0) }
        }
        quiet = (try? c.decode(Quiet.self, forKey: .quiet)) ?? Quiet()
        security = ((try? c.decode([SecurityItem].self, forKey: .security)) ?? []).filter { !$0.key.isEmpty }
        service = (try? c.decode(Bool.self, forKey: .service)) ?? true
        telegram = (try? c.decode(Bool.self, forKey: .telegram)) ?? false
        awayAfterMs = try? c.decodeIfPresent(Int.self, forKey: .awayAfterMs)
    }

    /// Whether a kind is on (missing from the response means on, as in the daemon's default).
    public func kindOn(_ kind: String) -> Bool { kinds[kind] ?? true }
    /// Whether a plugin's own toggle is on (no row means on).
    public func pluginOn(_ id: String) -> Bool { plugins.first { $0.id == id }?.on ?? true }

    enum CodingKeys: String, CodingKey { case enabled, kinds, plugins, quiet, security, service, telegram, awayAfterMs }
}

/// `idle` in `/state` and the `idle.verdict` event: whether the computer can be shut down, one daemon answer for the popover and the icon
/// (docs/api.md). `quiet`: nothing is running; `quietNeedsOn`: quiet, but someone will need the computer later (a plugin's needsOn=
/// run at 04:30) or the hub does not know something; `busy`: work is in progress. Sessions waiting for an answer do not change
/// the verdict (decision 2026-11-09): they do nothing themselves, after sleep the question is still there, after shutdown there is `claude --resume`;
/// they get an informational `waiting` row.
public struct IdleVerdict: Codable, Sendable, Hashable {
    public enum Verdict: String, Codable, Sendable, Hashable {
        case quiet
        case quietNeedsOn = "quiet-needs-on"
        case busy
    }

    /// One row: `kind` is busy (work), waiting (waiting for an answer: informational, not a blocker), needs-on (the computer must stay on),
    /// unknown (the hub does not know: the sessions plugin did not answer, a participant failed or went silent); `text` is in the hub language (a
    /// plugin's own phrase as is, an untrusted one prefixed with "<title>: "); `target` is where to go: `sessions`,
    /// `settings`, `manager`, `plugin:<id>`; `plugin` is the plugin title (for plugin rows); `trusted` means the phrase comes from a
    /// built-in or official plugin: only such a phrase may be used as the card title.
    public struct Item: Codable, Sendable, Hashable {
        public enum Kind: String, Codable, Sendable, Hashable {
            case busy, waiting
            case needsOn = "needs-on"
            case unknown
            case other
        }
        public var source: String
        public var kind: Kind
        public var text: String
        public var target: String?
        public var plugin: String?
        public var trusted: Bool?

        public init(source: String, kind: Kind, text: String, target: String? = nil, plugin: String? = nil, trusted: Bool? = nil) {
            self.source = source; self.kind = kind; self.text = text; self.target = target; self.plugin = plugin; self.trusted = trusted
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            source = (try? c.decode(String.self, forKey: .source)) ?? ""
            kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .other
            text = (try? c.decode(String.self, forKey: .text)) ?? ""
            target = try? c.decodeIfPresent(String.self, forKey: .target)
            plugin = try? c.decodeIfPresent(String.self, forKey: .plugin)
            trusted = try? c.decodeIfPresent(Bool.self, forKey: .trusted)
        }

        enum CodingKeys: String, CodingKey { case source, kind, text, target, plugin, trusted }
    }

    public var verdict: Verdict
    public var items: [Item]
    /// Names of sources where everything is fine ("Also checked: …").
    public var checked: [String]
    public var since: String?

    public init(verdict: Verdict, items: [Item] = [], checked: [String] = [], since: String? = nil) {
        self.verdict = verdict; self.items = items; self.checked = checked; self.since = since
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        verdict = try c.decode(Verdict.self, forKey: .verdict)
        items = (try? c.decode([Item].self, forKey: .items)) ?? []
        checked = (try? c.decode([String].self, forKey: .checked)) ?? []
        since = try? c.decodeIfPresent(String.self, forKey: .since)
        // a daemon before 2026-11-09 counted sessions waiting for an answer as "busy": busy without work rows, so recompute from blockers as the new one does
        if verdict == .busy, !items.contains(where: { $0.kind == .busy || $0.kind == .other }) {
            verdict = items.contains(where: { $0.kind == .needsOn || $0.kind == .unknown }) ? .quietNeedsOn : .quiet
        }
    }

    enum CodingKeys: String, CodingKey { case verdict, items, checked, since }
}

/// `pluginUpdates` in `/state` and the `plugins.updates` event: the daemon's background check of the registry index (every 6 h) and
/// what it found. Only the plugin manager installs updates (permission window: 428); this is just the list.
public struct PluginUpdates: Codable, Sendable, Hashable {
    /// The check is enabled (the "Check for plugin updates" setting and `services.plugins.checkUpdates`).
    public var enabled: Bool
    /// The app setting (`settings.json → checkPluginUpdates`).
    public var setting: Bool
    /// `services.plugins.checkUpdates` in the daemon's config.json (false means disabled by the config owner, which overrides the setting).
    public var config: Bool
    public var configured: Bool
    public var checkedAt: String?
    public var nextCheckAt: String?
    public var error: String?
    public var items: [PluginUpdate]

    public init(enabled: Bool = true, setting: Bool = true, config: Bool = true, configured: Bool = true, checkedAt: String? = nil, nextCheckAt: String? = nil, error: String? = nil, items: [PluginUpdate] = []) {
        self.enabled = enabled; self.setting = setting; self.config = config; self.configured = configured
        self.checkedAt = checkedAt; self.nextCheckAt = nextCheckAt; self.error = error; self.items = items
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        setting = (try? c.decode(Bool.self, forKey: .setting)) ?? true
        config = (try? c.decode(Bool.self, forKey: .config)) ?? true
        configured = (try? c.decode(Bool.self, forKey: .configured)) ?? false
        checkedAt = try? c.decodeIfPresent(String.self, forKey: .checkedAt)
        nextCheckAt = try? c.decodeIfPresent(String.self, forKey: .nextCheckAt)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        // a broken entry does not break the rest
        let raw = (try? c.decode([JSONValue].self, forKey: .items)) ?? []
        items = raw.compactMap { v in (try? JSONEncoder().encode(v)).flatMap { try? JSONDecoder().decode(PluginUpdate.self, from: $0) } }
    }

    enum CodingKeys: String, CodingKey { case enabled, setting, config, configured, checkedAt, nextCheckAt, error, items }
}

/// A single update: an installed plugin and a new version in the signed catalog.
public struct PluginUpdate: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String?
    public var installed: String
    public var version: String
    /// The new version asks for more permissions: the manager will show the permission window with the diff.
    public var permissionsGrow: Bool

    public init(id: String, title: String? = nil, installed: String, version: String, permissionsGrow: Bool = false) {
        self.id = id; self.title = title; self.installed = installed; self.version = version; self.permissionsGrow = permissionsGrow
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        installed = (try? c.decode(String.self, forKey: .installed)) ?? "?"
        version = try c.decode(String.self, forKey: .version)
        permissionsGrow = (try? c.decode(Bool.self, forKey: .permissionsGrow)) ?? false
    }

    enum CodingKeys: String, CodingKey { case id, title, installed, version, permissionsGrow }
}

/// `lang` in `/state` and the `settings.changed` event.
public struct LangInfo: Codable, Sendable, Hashable {
    public var setting: String
    public var effective: String
    public var system: String?

    public init(setting: String, effective: String, system: String? = nil) {
        self.setting = setting; self.effective = effective; self.system = system
    }
}

/// A journal entry: type, time and metadata as is.
/// `id` is based on the entry content (time to the ms, type, fields) and its index among identical entries, counting from the oldest: `/journal`
/// returns a tail of the last N entries, so positions in the response shift with each new entry, but the content does not.
/// This keeps an expanded row and list animations on their entry after the journal is reloaded.
public struct JournalEntry: Sendable, Hashable, Identifiable {
    public var id: String
    public var type: String
    public var ts: String?
    public var fields: [String: JSONValue]

    public init(index: Int, raw: [String: JSONValue]) {
        self.init(id: "#\(index)", raw: raw)
    }

    init(id: String, raw: [String: JSONValue]) {
        self.id = id
        type = raw["type"]?.stringValue ?? "?"
        ts = raw["ts"]?.stringValue ?? raw["time"]?.stringValue
        fields = raw.filter { $0.key != "type" && $0.key != "ts" && $0.key != "time" }
    }

    /// Content key: JSON with sorted keys.
    static func contentKey(_ raw: [String: JSONValue]) -> String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? enc.encode(raw)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    /// Entries of the `/journal` response (oldest to newest) with stable ids.
    static func list(_ raws: [[String: JSONValue]]) -> [JournalEntry] {
        var seen: [String: Int] = [:]
        return raws.map { raw in
            let key = contentKey(raw)
            let n = seen[key, default: 0]
            seen[key] = n + 1
            return JournalEntry(id: n == 0 ? key : "\(key)#\(n)", raw: raw)
        }
    }

    /// Metadata as one line: `key=value` sorted alphabetically.
    public var summary: String {
        fields.keys.sorted().map { "\($0)=\(fields[$0]!.display)" }.joined(separator: " ")
    }
}

public struct JournalResponse: Decodable, Sendable {
    public var entries: [JournalEntry]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode([[String: JSONValue]].self, forKey: .entries)) ?? []
        entries = JournalEntry.list(raw)
    }

    enum CodingKeys: String, CodingKey { case entries }
}

/// A 428 response: confirmation is needed; the core writes the text and the cost.
public struct ConfirmRequest: Decodable, Sendable, Hashable {
    public var token: String
    public var level: ActionLevel
    public var text: String
    public var cost: String?
    public var expiresInMs: Int?
    /// Only for the app's own confirmations (hub update): the dialog title, the button label and
    /// "Details" in small print. Not read from core responses: the core's dialog stays generic.
    public var title: String? = nil
    public var button: String? = nil
    public var details: String? = nil

    public init(token: String, level: ActionLevel, text: String, cost: String? = nil, expiresInMs: Int? = nil, title: String? = nil, button: String? = nil, details: String? = nil) {
        self.token = token; self.level = level; self.text = text; self.cost = cost; self.expiresInMs = expiresInMs
        self.title = title; self.button = button; self.details = details
    }

    enum CodingKeys: String, CodingKey { case token, level, text, cost, expiresInMs }
}

/// A daemon error `{"error": "<code>"}`.
public struct HubErrorBody: Decodable, Sendable {
    public var error: String
}

// MARK: - hub update

/// `hubUpdate` in `/state` and the `hub-update.status` event (docs/hub-updates.md §6): the current and previous versions, the release
/// check (vX.Y.Z tag in origin), the available version and install progress. Only the pinned build installs and rolls back.
public struct HubUpdateInfo: Codable, Sendable, Hashable {
    /// Release notes: the annotated tag message (subject and body). A lightweight tag or a build without a tag has none.
    public struct Notes: Codable, Sendable, Hashable {
        public var subject: String
        public var body: String?
        public init(subject: String, body: String? = nil) { self.subject = subject; self.body = body }
    }
    public struct Version: Codable, Sendable, Hashable {
        public var label: String
        public var version: String?
        public var tag: String?
        public var commit: String?
        public var builtAt: String?
        public var dirty: Bool?
        public var cdhash: String?
        public var notes: Notes?
        public init(label: String, version: String? = nil, tag: String? = nil, commit: String? = nil, builtAt: String? = nil, dirty: Bool? = nil, cdhash: String? = nil, notes: Notes? = nil) {
            self.label = label; self.version = version; self.tag = tag; self.commit = commit; self.builtAt = builtAt; self.dirty = dirty; self.cdhash = cdhash; self.notes = notes
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            label = try c.decode(String.self, forKey: .label)
            version = try? c.decodeIfPresent(String.self, forKey: .version)
            tag = try? c.decodeIfPresent(String.self, forKey: .tag)
            commit = try? c.decodeIfPresent(String.self, forKey: .commit)
            builtAt = try? c.decodeIfPresent(String.self, forKey: .builtAt)
            dirty = try? c.decodeIfPresent(Bool.self, forKey: .dirty)
            cdhash = try? c.decodeIfPresent(String.self, forKey: .cdhash)
            notes = try? c.decodeIfPresent(Notes.self, forKey: .notes)
        }
        enum CodingKeys: String, CodingKey { case label, version, tag, commit, builtAt, dirty, cdhash, notes }
    }
    public struct Available: Codable, Sendable, Hashable {
        /// This version's tag was moved to another commit after the hub saw it: it installs only with confirmation.
        public struct Moved: Codable, Sendable, Hashable {
            public var old: String
            public var new: String
            public init(old: String, new: String) { self.old = old; self.new = new }
        }
        public var version: String
        public var tag: String?
        public var commit: String?
        public var moved: Moved?
        public var notes: Notes?
        /// The version is in the Homebrew tree (no tag; built from there).
        public var brew: Bool?
        public init(version: String, tag: String? = nil, commit: String? = nil, moved: Moved? = nil, notes: Notes? = nil, brew: Bool? = nil) { self.version = version; self.tag = tag; self.commit = commit; self.moved = moved; self.notes = notes; self.brew = brew }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            version = try c.decode(String.self, forKey: .version)
            tag = try? c.decodeIfPresent(String.self, forKey: .tag)
            commit = try? c.decodeIfPresent(String.self, forKey: .commit)
            moved = try? c.decodeIfPresent(Moved.self, forKey: .moved)
            notes = try? c.decodeIfPresent(Notes.self, forKey: .notes)
            brew = try? c.decodeIfPresent(Bool.self, forKey: .brew)
        }
        enum CodingKeys: String, CodingKey { case version, tag, commit, moved, notes, brew }
    }
    public struct Install: Codable, Sendable, Hashable {
        /// idle | building | ready | switching | trial | rolling-back | done | failed | rolled-back
        public var phase: String
        /// install | rollback | migrate
        public var op: String?
        public var label: String?
        /// clone | build | verify | selftest | switch | restart | confirm
        public var step: String?
        public var error: String?
        public var detail: String?
        public var log: String?
        public var from: String?
        public var startedAt: String?
        public var finishedAt: String?
        /// phase = ready: how many are waiting for an answer now (the larger of cards and sessions).
        public var waiting: Int?
        /// phase = ready: the hub's PermissionRequest cards (a restart removes them) and sessions waiting for an answer; nil means an older
        /// daemon (then `waiting` counts cards).
        public var waitingCards: Int?
        public var waitingSessions: Int?
        public init(phase: String = "idle", op: String? = nil, label: String? = nil, step: String? = nil, error: String? = nil, detail: String? = nil, log: String? = nil, from: String? = nil, startedAt: String? = nil, finishedAt: String? = nil, waiting: Int? = nil, waitingCards: Int? = nil, waitingSessions: Int? = nil) {
            self.phase = phase; self.op = op; self.label = label; self.step = step; self.error = error; self.detail = detail; self.log = log; self.from = from; self.startedAt = startedAt; self.finishedAt = finishedAt; self.waiting = waiting
            self.waitingCards = waitingCards; self.waitingSessions = waitingSessions
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            phase = (try? c.decode(String.self, forKey: .phase)) ?? "idle"
            op = try? c.decodeIfPresent(String.self, forKey: .op)
            label = try? c.decodeIfPresent(String.self, forKey: .label)
            step = try? c.decodeIfPresent(String.self, forKey: .step)
            error = try? c.decodeIfPresent(String.self, forKey: .error)
            detail = try? c.decodeIfPresent(String.self, forKey: .detail)
            log = try? c.decodeIfPresent(String.self, forKey: .log)
            from = try? c.decodeIfPresent(String.self, forKey: .from)
            startedAt = try? c.decodeIfPresent(String.self, forKey: .startedAt)
            finishedAt = try? c.decodeIfPresent(String.self, forKey: .finishedAt)
            waiting = try? c.decodeIfPresent(Int.self, forKey: .waiting)
            waitingCards = try? c.decodeIfPresent(Int.self, forKey: .waitingCards)
            waitingSessions = try? c.decodeIfPresent(Int.self, forKey: .waitingSessions)
        }
        enum CodingKeys: String, CodingKey { case phase, op, label, step, error, detail, log, from, startedAt, finishedAt, waiting, waitingCards, waitingSessions }
    }

    /// The hub runs from a separate install (Versions/<label>); false means from a working folder (not migrated).
    public var installed: Bool
    /// VERSION of the running code.
    public var running: String?
    /// Label of the version the daemon runs from.
    public var label: String?
    public var current: Version?
    public var previous: Version?
    public var enabled: Bool
    public var setting: Bool
    public var config: Bool
    public var configured: Bool
    public var checkedAt: String?
    public var nextCheckAt: String?
    public var error: String?
    public var checking: Bool
    public var available: Available?
    public var install: Install
    /// Why install and rollback are unavailable: estop | not-installed | busy | nil.
    public var blocked: String?
    /// Where new versions come from: "git" (vX.Y.Z tags in origin) or "brew" (the Homebrew formula's tree; installed with
    /// `brew install` + `agenthub setup`, updated with `brew upgrade agent-hub`). nil — an older daemon (git).
    public var source: String?
    /// brew mode: the brew source directory (<prefix>/opt/agent-hub/libexec).
    public var brew: String?

    /// The hub follows Homebrew, not git tags.
    public var isBrew: Bool { source == "brew" }

    public init(installed: Bool = true, running: String? = nil, label: String? = nil, current: Version? = nil, previous: Version? = nil, enabled: Bool = true, setting: Bool = true, config: Bool = true, configured: Bool = true, checkedAt: String? = nil, nextCheckAt: String? = nil, error: String? = nil, checking: Bool = false, available: Available? = nil, install: Install = Install(), blocked: String? = nil, source: String? = nil, brew: String? = nil) {
        self.installed = installed; self.running = running; self.label = label; self.current = current; self.previous = previous
        self.enabled = enabled; self.setting = setting; self.config = config; self.configured = configured
        self.checkedAt = checkedAt; self.nextCheckAt = nextCheckAt; self.error = error; self.checking = checking
        self.available = available; self.install = install; self.blocked = blocked
        self.source = source; self.brew = brew
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = (try? c.decode(Bool.self, forKey: .installed)) ?? false
        running = try? c.decodeIfPresent(String.self, forKey: .running)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        current = try? c.decodeIfPresent(Version.self, forKey: .current)
        previous = try? c.decodeIfPresent(Version.self, forKey: .previous)
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
        setting = (try? c.decode(Bool.self, forKey: .setting)) ?? true
        config = (try? c.decode(Bool.self, forKey: .config)) ?? true
        configured = (try? c.decode(Bool.self, forKey: .configured)) ?? false
        checkedAt = try? c.decodeIfPresent(String.self, forKey: .checkedAt)
        nextCheckAt = try? c.decodeIfPresent(String.self, forKey: .nextCheckAt)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        checking = (try? c.decode(Bool.self, forKey: .checking)) ?? false
        available = try? c.decodeIfPresent(Available.self, forKey: .available)
        install = (try? c.decode(Install.self, forKey: .install)) ?? Install()
        blocked = try? c.decodeIfPresent(String.self, forKey: .blocked)
        source = try? c.decodeIfPresent(String.self, forKey: .source)
        brew = try? c.decodeIfPresent(String.self, forKey: .brew)
    }

    enum CodingKeys: String, CodingKey {
        case installed, running, label, current, previous, enabled, setting, config, configured, checkedAt, nextCheckAt, error, checking, available, install, blocked, source, brew
    }
}
