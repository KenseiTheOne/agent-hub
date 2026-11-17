import Foundation
import Observation

/// Connection state with the daemon.
public enum ConnectionState: Sendable, Equatable {
    case connecting
    case live
    case offline(String)

    public var isLive: Bool { self == .live }
}

/// Shell store: daemon snapshot, live stream, log, action calls.
/// Main thread only; the UI observes it via Observation.
///
/// This file holds the stored state and the values derived from it; the behaviour is in extensions, one file per
/// responsibility: `HubStore+Stream` (the event stream, the journal), `HubStore+Cards` (reply cards, session launch),
/// `HubStore+Registry` (the plugin manager, registry keys), `HubStore+Actions` (plugin actions, extensions, plugin
/// keys), `HubStore+Settings` (hub switches, the hub update). State the extensions write is `internal(set)`: the
/// app target is another module and can only read it.
@MainActor
@Observable
public final class HubStore {
    public internal(set) var state: HubState? { didSet { PluginIconBook.shared.absorb(state: state) } }
    public internal(set) var connection: ConnectionState = .connecting
    public internal(set) var journal: [JournalEntry] = []
    public internal(set) var journalError: String?
    /// Active `event.raised` events (key `<plugin>:<event>`).
    public internal(set) var activeEvents: Set<String> = []
    /// The action currently running (offer.id or primitive name) — for the indicator.
    public internal(set) var busyAction: String?
    /// Plugin keys (G8, `GET /secrets/:plugin`) by plugin id, loaded when its page opens; nil entry — not loaded or refused
    /// (an unpinned copy, no secrets service): the "Keys" section is not shown.
    public internal(set) var secrets: [String: SecretsList] = [:]
    /// The key being written or removed right now (`<plugin>/<key>`).
    public internal(set) var secretBusy: String?
    /// Text typed into inline input fields (G1) by offer id. The field reads and writes it here, not in its own view
    /// state: rows above it may come and go on a refresh (the page lists blocks by position), which recreates the field —
    /// the text must survive that. Offer ids are content hashes, stable across refreshes. Cleared once sent.
    public private(set) var inputDrafts: [String: String] = [:]

    /// The draft of an inline input field ("" — nothing typed).
    public func inputDraft(_ offerId: String) -> String { inputDrafts[offerId] ?? "" }

    /// Keep the field's text; "" drops the draft. At most `maxInputDrafts` offers keep text (the oldest typed into is
    /// dropped first) — drafts of offers that left the page don't pile up.
    public func setInputDraft(_ offerId: String, _ text: String) {
        if text.isEmpty {
            inputDrafts[offerId] = nil
            draftOrder.removeAll { $0 == offerId }
            return
        }
        if inputDrafts[offerId] == text { return }
        inputDrafts[offerId] = text
        draftOrder.removeAll { $0 == offerId }
        draftOrder.append(offerId)
        while draftOrder.count > Self.maxInputDrafts { inputDrafts[draftOrder.removeFirst()] = nil }
    }

    public static let maxInputDrafts = 32
    @ObservationIgnored private var draftOrder: [String] = []
    /// When the last event or ping arrived — for the "updated" caption.
    public internal(set) var lastEventAt: Date?

    /// The panel is showing the log — we reload it after actions and ESTOP changes. No polling.
    public var journalVisible = false { didSet { if journalVisible, !oldValue { Task { [weak self] in await self?.loadJournal() } } } }

    /// Session reply cards (`GET /hook/cards`, app only). Updated via SSE `hook.card*`.
    public internal(set) var cards: [HookCard] = []
    /// Why no cards are visible: 403 (the app isn't `app`), service not running, replies paused. A dropped connection doesn't
    /// land here — the "connection lost" banner covers it.
    public internal(set) var cardsError: String?
    /// cardsError — a refusal by peer class (this copy isn't pinned).
    public internal(set) var cardsErrorIsPeer = false
    /// Banner above "Sessions": not shown without a connection (the "connection lost" banner covers it); not shown for a peer-class refusal
    /// while the "This copy of the app isn't pinned" banner is visible (the same message twice).
    public var sessionsNotice: String? {
        guard connection.isLive, let e = cardsError else { return nil }
        if cardsErrorIsPeer, let p = peer, !p.isApp { return nil }
        return e
    }
    /// The card we're replying to right now (requestId) — indicator and button lock.
    public internal(set) var respondingTo: String?

    /// Plugin manager: registry catalog and installed plugins (`/registry/*`).
    public internal(set) var catalog: RegistryCatalog? {
        didSet { PluginIconBook.shared.absorb(catalog: catalog, installedIds: Set(state?.plugins.map(\.id) ?? [])) }
    }
    public internal(set) var installed: RegistryInstalled? { didSet { PluginIconBook.shared.absorb(requests: installed?.requests ?? []) } }
    public internal(set) var registryError: String?
    /// The last catalog load error (network, signature): shown as a banner in the manager with "Try again".
    public internal(set) var fetchError: String?
    /// The catalog is being loaded and verified right now.
    public var fetching: Bool { registryBusy == "fetch" }
    /// id of the plugin being installed/removed right now, or "fetch".
    public internal(set) var registryBusy: String?
    /// The panel shows the manager — we reload the catalog on `plugins.*` events.
    public var managerVisible = false { didSet { if managerVisible, !oldValue { Task { [weak self] in await self?.loadRegistry() } } } }

    /// The last session launch from the form: sessionId, name and what's known about it (bridge events). The form closes
    /// after launch, so the outcome ("waiting for the session", "appeared", "didn't appear within a minute") is also shown in "Sessions".
    public internal(set) var lastLaunch: LaunchStatus?
    /// The launch form was reopened or the human closed the banner — the previous outcome is no longer shown.
    public func clearLastLaunch() { lastLaunch = nil }

    /// `push.notify` from SSE → the shell shows a banner (UNUserNotificationCenter) and answers `/push/ack` itself.
    public var onNotify: (@MainActor (PushNotify) -> Void)?
    /// The hub language changed — the shell re-registers what SwiftUI doesn't redraw (notification categories).
    public var onLanguageChange: (@MainActor () -> Void)?
    /// A state snapshot arrived (first connection and every reconnection) — the shell removes the old registration
    /// in "Login Items" when the snapshot shows the app will start the daemon at login.
    public var onSnapshot: (@MainActor (HubState) -> Void)?

    static var pausedText: String {
        tr("Ответы из хаба приостановлены на минуту: слишком много одобрений подряд.", "Replies from the hub are paused for a minute: too many approvals in a row.")
    }

    public let client: HubClient
    public weak var presenter: ConfirmPresenter?

    /// Start the daemon if it's not running (`launchctl kickstart`, DaemonLifecycle.swift). nil — don't start (test
    /// copy, preview). Set by AppModel.
    public var daemonStarter: DaemonStarter?
    /// The last attempt to start the daemon — for the "hub service is not installed" banner.
    public internal(set) var daemonLaunch: DaemonLaunchState = .idle
    var lastDaemonStart: Date?
    /// No more often than once per this many seconds (the "Try again" button resets it). Shorter in tests.
    var daemonStartCooldown: TimeInterval = 30
    /// How long to wait for the socket after kickstart. Shorter in tests.
    var daemonSocketWait: TimeInterval = 10
    /// The app is quitting: the stream is stopped, we don't start the daemon (otherwise closing the stream on /shutdown would start it again).
    public internal(set) var quitting = false
    /// The hub is switching to another version (`hub-update.restarting`): the app quits by itself, without `/shutdown` — the daemon
    /// restarts from the new version and launches the new app (docs/hub-updates.md).
    public internal(set) var hubRestarting = false
    /// What to do on `hub-update.restarting` — quit (set by AppModel: NSApp.terminate). nil — nothing (tests, preview).
    public var onHubRestart: (@MainActor () -> Void)?
    /// A hub update request is in progress: "check" | "install" | "rollback" | "plugins-check" — indicator and button lock.
    public internal(set) var hubUpdateBusy: String?

    var streamTask: Task<Void, Never>?
    var lastEventId: String?
    /// The build pin changed (`app-pin.changed`): the daemon drops AgentHub.app connections, the peer class
    /// may have changed, and a Last-Event-ID replay doesn't carry the snapshot (with `peer`) — we reconnect without Last-Event-ID.
    var snapshotNext = false
    /// Session replies are paused (`hook.paused`) until this time; then the cards are re-read (the daemon has no event for the end
    /// of the pause).
    var pausedUntil: Date?
    var pauseRecheck: Task<Void, Never>?
    var backoff: Double = 0.5
    static let minBackoff = 0.5
    static let maxBackoff = 30.0

    public init(client: HubClient) {
        self.client = client
    }

    /// For previews and tests: a ready snapshot without a daemon.
    public init(client: HubClient, preview: HubState) {
        self.client = client
        self.state = preview
        self.connection = .live
    }

    // MARK: - derived values for the UI

    public var worstStatus: HubStatus {
        guard let state else { return .unknown }
        if !connection.isLive { return .unknown }
        return state.status
    }

    public var waitingCount: Int { state?.waitingSessions ?? 0 }

    /// Sessions to show: from the daemon registry plus demo sessions (`--demo-sessions`, screenshots only).
    public var sessions: [SessionInfo] { (state?.sessions ?? []) + demoSessions }
    public private(set) var demoSessions: [SessionInfo] = []
    public func showDemoSessions(_ list: [SessionInfo]) { demoSessions = list }
    public func isDemo(_ s: SessionInfo) -> Bool { demoSessions.contains { $0.sessionId == s.sessionId } }

    /// Whether the daemon can go to a tab (`session.focus`, on older daemons `terminal.focus`/`cmux.focus` by the tab id).
    public var focusPrimitive: Bool { sessionFocusPrimitive || tabFocusPrimitive != nil }
    /// Switching to a tab by its id: `terminal.focus`, on daemons before the terminal layer `cmux.focus` (its deprecated alias now).
    public var tabFocusPrimitive: String? {
        let names = Set(state?.primitives.map(\.name) ?? [])
        return names.contains("terminal.focus") ? "terminal.focus" : names.contains("cmux.focus") ? "cmux.focus" : nil
    }
    /// Switching to a session's tab by its id — the core finds the tab (terminal layer), the shell needn't know the terminal.
    public var sessionFocusPrimitive: Bool { state?.primitives.contains { $0.name == "session.focus" } ?? false }

    /// How to switch to a session's tab: `session.focus` by id if the core found the tab (`focusable`); a daemon without
    /// `session.focus` — the old way, `cmux.focus` by the tab from the registry. nil — don't draw the button.
    public func focusRequest(sessionId: String) -> (primitive: String, args: [String: JSONValue])? {
        let s = sessions.first { $0.sessionId == sessionId }
        if sessionFocusPrimitive {
            guard s?.focusable == true else { return nil }
            return ("session.focus", ["sessionId": .string(sessionId)])
        }
        guard let s, let sf = s.surfaceId, let prim = tabFocusPrimitive else { return nil }
        var args: [String: JSONValue] = ["surfaceId": .string(sf)]
        if let ws = s.workspaceId { args["workspaceId"] = .string(ws) }
        return (prim, args)
    }
    public var bridgeOnline: Bool { state?.bridge?.online ?? false }

    /// The session's terminal: what the daemon found (`terminalInfo`). A daemon before the terminal layer (no `/state.terminals`)
    /// knew only cmux tabs, through the bridge.
    public func terminal(of s: SessionInfo) -> SessionTerminal? {
        if let t = s.terminalInfo { return t }
        guard state?.terminals == nil, s.terminal != nil || s.surfaceId != nil else { return nil }
        return SessionTerminal(adapter: s.terminal ?? "cmux", label: s.terminal ?? "cmux",
                               capabilities: ["focus", "read-screen", "send-text", "send-esc", "launch"], via: "bridge")
    }

    /// Why a session button won't work: the common checks (connection, pinned build, pause), then the session's terminal — it
    /// doesn't support the capability (`unsupported`, the tooltip names the terminal), it goes through the cmux bridge and the
    /// bridge is offline (`noBridge`). nil — can be pressed.
    public func gate(primitive: String, session s: SessionInfo, capability: String) -> ActionBlock? {
        if let b = gate(primitive: primitive, needsBridge: false) { return b }
        let t = terminal(of: s)
        if let t, !t.supports(capability) { return .unsupported(terminal: t.label, capability: capability) }
        if t?.needsBridge ?? true, ActionBlock.bridgePrimitives.contains(primitive), !bridgeOnline { return .noBridge }
        return nil
    }

    /// "Go to tab" for a non-Claude agent session (`externalSessions`): only when the core found its tab; nil — no button.
    public func focusRequest(external s: ExternalSession) -> (primitive: String, args: [String: JSONValue])? {
        guard sessionFocusPrimitive, s.focusable else { return nil }
        return ("session.focus", ["sessionId": .string(s.sessionId)])
    }

    /// Why "Go to tab" won't work for an external session right now (connection, pin, pause, its terminal, the cmux bridge).
    public func gate(external s: ExternalSession) -> ActionBlock? {
        if let b = gate(primitive: "session.focus", needsBridge: false) { return b }
        if let t = s.terminalInfo, !t.supports("focus") { return .unsupported(terminal: t.label, capability: "focus") }
        if s.terminalInfo?.needsBridge == true, !bridgeOnline { return .noBridge }
        return nil
    }

    /// "Go to tab" will work for this session right now.
    public func canFocus(_ s: SessionInfo) -> Bool {
        guard let req = focusRequest(sessionId: s.sessionId) else { return false }
        return gate(primitive: req.primitive, session: s, capability: "focus") == nil
    }

    /// Sessions whose terminal goes through the cmux bridge while it is offline — the bridge banner shows only then.
    public var sessionsWaitingForBridge: Bool {
        !bridgeOnline && focusPrimitive && sessions.contains { terminal(of: $0)?.needsBridge == true }
    }

    /// Where a new session opens (`/state.terminals.launch`); nil — no terminal can, or an older daemon (cmux only).
    public var launchTerminal: TerminalsInfo.Adapter? { state?.terminals?.launchAdapter }

    /// Why "Launch" won't work: the common checks, no terminal can open a tab, the launch terminal waits for the cmux bridge.
    public func launchGate() -> ActionBlock? {
        if let b = gate(primitive: "session.launch", needsBridge: false) { return b }
        guard let ts = state?.terminals else { return bridgeOnline ? nil : .noBridge }
        guard let a = ts.launchAdapter else { return .noLaunchTerminal }
        return a.via == "bridge" && !bridgeOnline ? .noBridge : nil
    }

    public var estop: Bool { state?.estop ?? false }

    /// The hub directory the shell is connected to (the socket directory).
    public var home: String { (client.socketPath as NSString).deletingLastPathComponent }

    /// "ТЕСТ · /tmp/ahl": the shell isn't looking at the default directory (`--home`, `AGENTHUB_HOME`) or the daemon
    /// itself is a test one. nil — the real copy. Visible in the popover and panel header and in the icon tooltip.
    public var testMark: String? {
        TestMark.label(home: home, defaultHome: HubPaths.defaultHome, daemonTestMode: state?.hub?.testMode)
    }

    /// Whether the app is signed in the daemon's eyes. false — confirmable actions will get 403.
    public var peer: PeerInfo? { state?.peer }

    /// Whether this copy may do what the core allows only to the pinned build (app-only, confirmable,
    /// lifting the pause, language, settings). Class still unknown (nil) — don't forbid: the core decides.
    public var canAct: Bool { peer?.isApp != false }

    /// Why a primitive call won't work right now (`ActionBlock`); nil — it will. `needsBridge: false` — the button
    /// only opens a form, where the bridge is mentioned separately.
    public func gate(primitive: String, needsBridge: Bool = true) -> ActionBlock? {
        let level = state?.primitives.first { $0.name == primitive }?.level ?? .unknown
        return ActionBlock.check(primitive: primitive, level: level, pluginAction: false, primitives: state?.primitives ?? [],
                                 live: connection.isLive, peer: peer, estop: estop, bridgeOnline: bridgeOnline, needsBridge: needsBridge)
    }

    /// Same for a plugin offer: an effect — by its primitive, a declared action — by its level.
    /// A `session.*` offer names a session the shell can't see from the offer: with the terminal layer the core decides whether
    /// its terminal needs the bridge; a tab id (`terminal.focus`, `cmux.focus`) is a cmux tab — through the bridge.
    public func gate(offer: Offer) -> ActionBlock? {
        let sessionPrim = offer.primitive?.hasPrefix("session.") == true
        return ActionBlock.check(primitive: offer.kind == "action" ? nil : offer.primitive, level: offer.level, pluginAction: offer.kind == "action",
                          primitives: state?.primitives ?? [], live: connection.isLive, peer: peer, estop: estop, bridgeOnline: bridgeOnline,
                          needsBridge: !(sessionPrim && state?.terminals != nil),
                          // an input action is pressed only in the app, whatever the tier (G1)
                          actionAppOnly: offer.kind == "action" && (offer.appOnly || offer.input != nil))
    }

    public func plugin(_ id: String) -> PluginState? { state?.plugins.first { $0.id == id } }

    /// Available plugin updates (daemon background check): the "Plugins" badge in the sidebar and a row in the popover.
    public var pluginUpdates: [PluginUpdate] { state?.pluginUpdates?.items ?? [] }

    /// How long one plugin action may run (`/state.limits.actionTimeoutMs`); nil — an older daemon: texts name no number.
    var actionLimitMs: Double? { state?.limits?.actionTimeoutMs }

    // MARK: - state of the reply cards (the code is in HubStore+Cards.swift)
    // Stored here, not there: an extension cannot hold stored properties.

    /// Demo cards for screenshots (`--demo-cards`): no hook is tied to them, they can't be answered.
    public internal(set) var demoCards: [HookCard] = []

    /// Card loads are numbered. Several can be in flight at once (a snapshot, `hook.card` events, a reply), and their
    /// answers may come back in any order: an answer is applied only when it belongs to a load started after the one
    /// already on screen, so a slow older answer never overwrites a newer one.
    var cardsLoadSeq = 0
    var cardsAppliedSeq = 0
    var cardsLoadsInFlight = 0
}
