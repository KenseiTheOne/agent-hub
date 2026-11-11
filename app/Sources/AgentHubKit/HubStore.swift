import Foundation
import Observation

/// Connection state with the daemon.
public enum ConnectionState: Sendable, Equatable {
    case connecting
    case live
    case offline(String)

    public var isLive: Bool { self == .live }
}

/// How the shell asks the human. Implementation — NSAlert in the AgentHub target; in tests — a double.
@MainActor
public protocol ConfirmPresenter: AnyObject {
    /// Show the text and cost **from the core**; true — the human agreed.
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool
    /// Show a core refusal or a connection error.
    func report(title: String, detail: String)
    /// Plugin permissions window (`428 consent-required`): permissions with "why", new ones marked. true — the human agreed.
    func consent(_ request: ConsentRequest) async -> Bool
}

/// Shell store: daemon snapshot, live stream, log, action calls.
/// Main thread only; the UI observes it via Observation.
@MainActor
@Observable
public final class HubStore {
    public private(set) var state: HubState? { didSet { PluginIconBook.shared.absorb(state: state) } }
    public private(set) var connection: ConnectionState = .connecting
    public private(set) var journal: [JournalEntry] = []
    public private(set) var journalError: String?
    /// Active `event.raised` events (key `<plugin>:<event>`).
    public private(set) var activeEvents: Set<String> = []
    /// The action currently running (offer.id or primitive name) — for the indicator.
    public private(set) var busyAction: String?
    /// When the last event or ping arrived — for the "updated" caption.
    public private(set) var lastEventAt: Date?

    /// The panel is showing the log — we reload it after actions and ESTOP changes. No polling.
    public var journalVisible = false { didSet { if journalVisible, !oldValue { Task { await loadJournal() } } } }

    /// Session reply cards (`GET /hook/cards`, app only). Updated via SSE `hook.card*`.
    public private(set) var cards: [HookCard] = []
    /// Why no cards are visible: 403 (the app isn't `app`), service not running, replies paused. A dropped connection doesn't
    /// land here — the "connection lost" banner covers it.
    public private(set) var cardsError: String?
    /// cardsError — a refusal by peer class (this copy isn't pinned).
    public private(set) var cardsErrorIsPeer = false
    /// Banner above "Sessions": not shown without a connection (the "connection lost" banner covers it); not shown for a peer-class refusal
    /// while the "This copy of the app isn't pinned" banner is visible (the same message twice).
    public var sessionsNotice: String? {
        guard connection.isLive, let e = cardsError else { return nil }
        if cardsErrorIsPeer, let p = peer, !p.isApp { return nil }
        return e
    }
    /// The card we're replying to right now (requestId) — indicator and button lock.
    public private(set) var respondingTo: String?

    /// Plugin manager: registry catalog and installed plugins (`/registry/*`).
    public private(set) var catalog: RegistryCatalog? {
        didSet { PluginIconBook.shared.absorb(catalog: catalog, installedIds: Set(state?.plugins.map(\.id) ?? [])) }
    }
    public private(set) var installed: RegistryInstalled? { didSet { PluginIconBook.shared.absorb(requests: installed?.requests ?? []) } }
    public private(set) var registryError: String?
    /// The last catalog load error (network, signature): shown as a banner in the manager with "Retry".
    public private(set) var fetchError: String?
    /// The catalog is being loaded and verified right now.
    public var fetching: Bool { registryBusy == "fetch" }
    /// id of the plugin being installed/removed right now, or "fetch".
    public private(set) var registryBusy: String?
    /// The panel shows the manager — we reload the catalog on `plugins.*` events.
    public var managerVisible = false { didSet { if managerVisible, !oldValue { Task { await loadRegistry() } } } }

    /// The last session launch from the form: sessionId, name and what's known about it (bridge events). The form closes
    /// after launch, so the outcome ("waiting for the session", "appeared", "didn't appear within a minute") is also shown in "Sessions".
    public private(set) var lastLaunch: LaunchStatus?
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
    public private(set) var daemonLaunch: DaemonLaunchState = .idle
    private var lastDaemonStart: Date?
    /// No more often than once per this many seconds (the "Retry" button resets it). Shorter in tests.
    var daemonStartCooldown: TimeInterval = 30
    /// How long to wait for the socket after kickstart. Shorter in tests.
    var daemonSocketWait: TimeInterval = 10
    /// The app is quitting: the stream is stopped, we don't start the daemon (otherwise closing the stream on /shutdown would start it again).
    public private(set) var quitting = false
    /// The hub is switching to another version (`hub-update.restarting`): the app quits by itself, without `/shutdown` — the daemon
    /// restarts from the new version and launches the new app (docs/hub-updates.md).
    public private(set) var hubRestarting = false
    /// What to do on `hub-update.restarting` — quit (set by AppModel: NSApp.terminate). nil — nothing (tests, preview).
    public var onHubRestart: (@MainActor () -> Void)?
    /// A hub update request is in progress: "check" | "install" | "rollback" | "plugins-check" — indicator and button lock.
    public private(set) var hubUpdateBusy: String?

    private var streamTask: Task<Void, Never>?
    private(set) var lastEventId: String?
    /// The build pin changed (`app-pin.changed`): the daemon drops AgentHub.app connections, the peer class
    /// may have changed, and a Last-Event-ID replay doesn't carry the snapshot (with `peer`) — we reconnect without Last-Event-ID.
    private(set) var snapshotNext = false
    /// Session replies are paused (`hook.paused`) until this time; then the cards are re-read (the daemon has no event for the end
    /// of the pause).
    private(set) var pausedUntil: Date?
    private var pauseRecheck: Task<Void, Never>?
    private var backoff: Double = 0.5
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

    /// Whether the daemon can switch to a tab (`session.focus`, on older daemons `terminal.focus`/`cmux.focus` by the tab id).
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
                          actionAppOnly: offer.kind == "action" && offer.appOnly)
    }

    public func plugin(_ id: String) -> PluginState? { state?.plugins.first { $0.id == id } }

    /// Available plugin updates (daemon background check): the "Plugins" badge in the sidebar and a row in the popover.
    public var pluginUpdates: [PluginUpdate] { state?.pluginUpdates?.items ?? [] }

    // MARK: - live stream

    /// Connect to `GET /events` and keep the stream; on a drop — reconnect with backoff 0.5 → 30 s.
    public func start() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.runStream()
                if Task.isCancelled { return }
                let delay = self.backoff
                self.backoff = min(self.backoff * 2, Self.maxBackoff)
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    public func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Reconnect right away (the "Retry" button). The daemon is started again without a pause between attempts.
    public func reconnect() {
        stop()
        backoff = Self.minBackoff
        lastDaemonStart = nil
        connection = .connecting
        start()
    }

    /// No connection and no daemon (no socket or the connection was refused — `DaemonProbe`): start the launchd job and
    /// wait for the socket. The daemon is alive but closed the stream (re-pin, drop) — leave it alone. No more often than once per
    /// `daemonStartCooldown`; not while quitting and not for a test copy.
    func startDaemonIfNeeded() async {
        guard let starter = daemonStarter, starter.enabled, !quitting else { return }
        if DaemonProbe.listening(client.socketPath) { return }
        if let t = lastDaemonStart, Date().timeIntervalSince(t) < daemonStartCooldown { return }
        lastDaemonStart = Date()
        daemonLaunch = .starting
        switch await starter.start() {
        case .started:
            daemonLaunch = .idle
            let until = Date().addingTimeInterval(daemonSocketWait)
            while Date() < until, HubPaths.checkSocket(client.socketPath) != nil, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
            }
            // kickstart succeeded but there's no socket: the job was still stopping (kickstart into an exiting process returns 0 but
            // starts nothing) — don't count the attempt, the next reconnection will start it again
            if HubPaths.checkSocket(client.socketPath) != nil { lastDaemonStart = nil }
            backoff = Self.minBackoff
        case .notInstalled: daemonLaunch = .notInstalled
        case .failed(let c): daemonLaunch = .failed(c)
        case .skipped: daemonLaunch = .idle
        }
    }

    /// Quitting the app: stop the stream and ask the daemon to exit (`POST /shutdown`) if this copy is
    /// the pinned build. We wait no longer than 2 s for the reply.
    public func shutdownDaemonOnQuit(arguments: [String] = CommandLine.arguments) async -> QuitShutdown {
        quitting = true
        stop()
        // quitting for a hub update: the daemon restarts itself (code 75), /shutdown would stop it for good
        if hubRestarting { return .skipped }
        guard QuitPolicy.shouldStopDaemon(peer: peer, arguments: arguments), HubPaths.checkSocket(client.socketPath) == nil else { return .skipped }
        do {
            let r = try await client.shutdown()
            return r.status == 202 ? .requested : .failed(r.code ?? "http-\(r.status)")
        } catch {
            return .failed((error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
    }

    private func runStream() async {
        if !connection.isLive { connection = .connecting }
        if lastEventId != nil {
            if snapshotNext {
                lastEventId = nil
            } else if let pid = try? await client.daemonPid(), pid != state?.pid {
                // Event numbers restart in a new daemon instance: an old Last-Event-ID could
                // collide with other events and the daemon would send "missed" events instead of a snapshot.
                lastEventId = nil
            } else if let p = try? await client.peer(), p.class != state?.peer?.class {
                // The peer class changed (another build was pinned — this one became cli): the replay doesn't carry `peer`
                // and doesn't replay hook.* — we need a snapshot, otherwise the cards and buttons would stay from the old class.
                lastEventId = nil
            }
        }
        snapshotNext = false
        do {
            for try await ev in client.events(lastEventId: lastEventId) {
                handle(ev)
            }
            if Task.isCancelled || quitting { return }
            connection = .offline(tr("служба хаба закрыла поток", "the hub service closed the stream"))
        } catch {
            if Task.isCancelled || quitting { return }
            connection = .offline((error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
        // no daemon (exited normally — launchd doesn't keep it, or hasn't started yet) — start the job
        await startDaemonIfNeeded()
    }

    /// Apply one SSE event (extracted for tests).
    public func handle(_ ev: SSEEvent) {
        // `: ping` — the stream is alive; don't touch the snapshot and connection
        if ev.isKeepalive {
            if state != nil, connection.isLive { lastEventAt = Date() }
            return
        }
        if let id = ev.id { lastEventId = id }
        lastEventAt = Date()
        guard let hub = HubEvent.decode(ev) else { return }
        if case .snapshot = hub {
            activeEvents = []
        }
        // the stream is alive: a snapshot or events of the same daemon replayed by Last-Event-ID
        if state != nil || { if case .snapshot = hub { return true } else { return false } }() {
            connection = .live
            backoff = Self.minBackoff
            daemonLaunch = .idle
        }
        if state == nil, case .snapshot(let s) = hub { state = s } else { state?.apply(hub) }
        if case .snapshot(let s) = hub, let l = s.lang {
            let before = L10n.shared.lang
            L10n.shared.apply(setting: l.setting, effective: l.effective)
            if L10n.shared.lang != before { onLanguageChange?() }
        }
        if let id = ev.id.flatMap(Int.init) { state?.seq = id }
        // advice for an unpinned copy ("open the pinned build: <path>") — from the fresh snapshot
        PinAdvice.shared.update(pinPath: state?.appPin?.path, installed: state?.hubUpdate?.installed)
        switch hub {
        case .snapshot(let s):
            // events already active in plugins arrive in the snapshot as plugin.events
            for p in s.plugins { for e in p.events { activeEvents.insert("\(p.id):\(e)") } }
            onSnapshot?(s)
            Task { await loadCards() }
            if managerVisible { Task { await loadRegistry() } }
        case .raised(let key, _, _): activeEvents.insert(key)
        case .cleared(let key, _): activeEvents.remove(key)
        case .action, .estop:
            if journalVisible { Task { await loadJournal() } }
            if case .estop(true) = hub { cards = [] }
        case .pushNotify(let n):
            onNotify?(n)
        case .pluginUpdates:
            if managerVisible { Task { await loadRegistry() } }
        case .hookCard:
            Task { await loadCards() }
        case .hookCardRemoved(let id, _):
            cards.removeAll { $0.requestId == id }
        case .hookPaused(let until):
            // the daemon has already removed all cards; re-read to show the pause (cardsError) and an empty list,
            // and once more at the end of the pause (loadCards schedules a recheck), so the banner clears itself
            cards = []
            cardsError = Self.pausedText
            pausedUntil = until.flatMap(PluginUpdatesStatus.parseDate)
            Task { await loadCards() }
        case .hubRestarting:
            // the hub is switching to another version: quit without /shutdown (the new daemon will launch the new app)
            hubRestarting = true
            onHubRestart?()
        case .appPinChanged:
            // the daemon will close AgentHub.app connections; the next one comes with a snapshot, but we re-read the class right away
            snapshotNext = true
            Task { await refreshPeer() }
        case .other(let type, let data):
            if type == "settings.changed", let l = data["lang"] {
                L10n.shared.apply(setting: l["setting"]?.stringValue, effective: l["effective"]?.stringValue)
                state?.lang = LangInfo(setting: l["setting"]?.stringValue ?? "system", effective: l["effective"]?.stringValue ?? "ru")
                onLanguageChange?()
            }
            // "Launch at login" was changed by another copy of the app (or this one — the reply has already been applied)
            if type == "settings.changed", case .bool(let on)? = data["launchAtLogin"] {
                let agent = state?.launchAtLogin?.launchAgent
                state?.launchAtLogin = LaunchAtLoginInfo(setting: on, launchAgent: agent)
            }
            // "Notifications" was changed by another copy of the app (or this one — the reply has already been applied)
            if type == "settings.changed", let n = data["notifications"],
               let raw = try? JSONEncoder().encode(n), let info = try? JSONDecoder().decode(NotificationsInfo.self, from: raw) {
                state?.notifications = info
            }
            // OAuth connections (oauth service): login started, finished, expired, "Disconnect"
            if type == "connections.changed", let list = ConnectionInfo.list(from: data["connections"]) { state?.connections = list }
            if type.hasPrefix("plugins."), managerVisible { Task { await loadRegistry() } }
            // an own plugin request or an own plugin folder changed: the popover shows requests even without the manager
            else if type == "plugins.own-request" || type == "plugins.own" { Task { await loadRegistry() } }
            // the cmux bridge connected / disconnected (bye or stopped polling) — "Go to tab" buttons of cmux sessions follow it right away
            if type == "bridge.connected" || type == "bridge.disconnected" {
                let on = type == "bridge.connected"
                if state?.bridge == nil { state?.bridge = BridgeInfo(online: on) }
                state?.bridge?.online = on
                if on { state?.bridge?.since = ISO8601DateFormatter().string(from: Date()) } else { state?.bridge?.since = nil; state?.bridge?.version = nil }
            }
            if type == "bridge.launch.registered" || type == "bridge.launch.timeout",
               let sid = data["sessionId"]?.stringValue, lastLaunch?.sessionId == sid {
                lastLaunch?.state = type == "bridge.launch.registered" ? .registered : .timeout
            }
        default: break
        }
    }

    // MARK: - log

    public func loadJournal() async {
        do {
            journal = try await client.journal(limit: 300).reversed()
            journalError = nil
        } catch {
            journalError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        }
    }

    // MARK: - reply cards

    /// Demo cards for screenshots (`--demo-cards`): no hook is tied to them, they can't be answered.
    public private(set) var demoCards: [HookCard] = []
    public func showDemoCards(_ list: [HookCard]) { demoCards = list }
    /// What to show in "Replies": real cards, then demo ones.
    public var visibleCards: [HookCard] { cards + demoCards }

    public func loadCards() async {
        do {
            let r = try await client.hookCards()
            cards = r.cards
            cardsErrorIsPeer = false
            if r.paused {
                cardsError = Self.pausedText
                if let u = r.pausedUntil.flatMap(PluginUpdatesStatus.parseDate) { pausedUntil = u }
                schedulePauseRecheck()
            } else {
                cardsError = nil
                pausedUntil = nil
                pauseRecheck?.cancel()
            }
        } catch let e as HubError {
            cards = []
            pauseRecheck?.cancel()
            cardsErrorIsPeer = false
            switch e {
            case .socket, .transport:
                // no connection — the "connection lost" banner covers it; the raw error text doesn't need a second copy
                cardsError = nil
                return
            default: break
            }
            switch e.code {
            case "peer:cli", "peer:app-signature", "peer:app-requirement-missing":
                cardsErrorIsPeer = true
                cardsError = tr("Ответы сессиям видит только закреплённая сборка приложения.", "Only the pinned app build can see session replies.") + " " + PinAdvice.shared.openPinned
            case "no-hook-service":
                cardsError = tr("Служба ответов сессиям не запущена.", "The session reply service isn't running.")
            default:
                cardsError = e.errorDescription
            }
        } catch {
            cardsErrorIsPeer = false
            cardsError = String(describing: error)
        }
    }

    /// Re-read cards at the end of the reply pause: the daemon sends no "pause ended" event.
    private func schedulePauseRecheck() {
        pauseRecheck?.cancel()
        if let u = pausedUntil, u <= Date() { pausedUntil = nil }
        let delay = Self.pauseRecheckDelay(until: pausedUntil, now: Date())
        pauseRecheck = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.loadCards()
        }
    }

    /// In how many seconds to recheck the pause: at `until` (+0.5 s), without it — every 15 s; at least every 10 min.
    nonisolated static func pauseRecheckDelay(until: Date?, now: Date) -> TimeInterval {
        guard let until else { return 15 }
        return min(600, max(2, until.timeIntervalSince(now) + 0.5))
    }

    /// Peer class from `GET /peer` (after a pin change); if it changed — re-read the cards.
    func refreshPeer() async {
        guard let p = try? await client.peer() else { return }
        guard state?.peer?.class != p.class || state?.peer?.reason != p.reason else { return }
        state?.peer = p
        await loadCards()
    }

    /// Reply to a card. `session.respond` is "immediate" level: the card itself is the consent (docs/hook.md).
    public func respond(_ card: HookCard, _ choice: RespondChoice) async {
        if demoCards.contains(card) {
            presenter?.report(title: tr("Это демо-карточка", "This is a demo card"), detail: tr("Её показал аргумент --demo-cards для скриншота; сессия её не ждёт.", "It was added by --demo-cards for a screenshot; no session is waiting on it."))
            return
        }
        guard respondingTo == nil else { return }
        respondingTo = card.requestId
        defer { respondingTo = nil }
        let label = card.kind == .question ? tr("Ответ сессии «\(card.sessionName ?? String(card.sessionId.prefix(8)))»", "Reply to \"\(card.sessionName ?? String(card.sessionId.prefix(8)))\"")
                                           : "\(card.summary ?? card.tool ?? tr("Разрешение", "Permission"))"
        do {
            let outcome = try await client.invoke("session.respond", args: choice.args(requestId: card.requestId))
            switch outcome {
            case .done(let ok, let result):
                if ok { cards.removeAll { $0.requestId == card.requestId } }
                else {
                    let why = result?["error"]?.stringValue
                    presenter?.report(title: tr("Ответ не принят", "Reply not accepted"), detail: why == "rate-limit"
                        ? Explain.text(code: "rate-limit", status: 200, label: label)
                        : Explain.failure(result: result, label: label))
                }
            case .needsConfirm:
                presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите.", "\(label): try again."))
            case .denied(let status, let code):
                if code == "facts:not-pending" { cards.removeAll { $0.requestId == card.requestId } }
                deny(label, status: status, code: code)
            }
        } catch {
            reportOffline(error)
        }
        await loadCards()
    }

    // MARK: - session launch

    /// `session.launch` from the form: the core will require a confirmation with a cost (428), the launch terminal opens the tab.
    @discardableResult
    public func launch(_ draft: LaunchDraft) async -> Bool {
        guard busyAction == nil else { return false }
        busyAction = "session.launch"
        defer { busyAction = nil }
        let label = tr("Запуск сессии «\(draft.name)»", "Launch session \"\(draft.name)\"")
        do {
            var outcome = try await client.invoke("session.launch", args: draft.args)
            if case .needsConfirm(let req) = outcome {
                guard let presenter, await presenter.confirm(req, actionLabel: label) else { return false }
                outcome = try await client.invoke("session.launch", args: draft.args, confirmToken: req.token)
            }
            switch outcome {
            case .done(let ok, let result):
                if ok {
                    lastLaunch = LaunchStatus(sessionId: result?["sessionId"]?.stringValue, name: draft.name, state: .started)
                    return true
                }
                presenter?.report(title: tr("Сессия не запущена", "Session not launched"), detail: Explain.failure(result: result, label: label))
            case .needsConfirm:
                presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите.", "\(label): try again."))
            case .denied(let status, let code):
                deny(label, status: status, code: code)
            }
        } catch {
            reportOffline(error)
        }
        return false
    }

    // MARK: - plugin manager

    public func loadRegistry() async {
        do {
            async let c = client.registryCatalog()
            async let i = client.registryInstalled()
            catalog = try await c
            installed = try await i
            registryError = nil
        } catch let e as HubError {
            registryError = e.code.map { Explain.text(code: $0, status: 0, label: "") } ?? e.errorDescription
        } catch {
            registryError = String(describing: error)
        }
    }

    /// Download and verify the signed catalog (`POST /registry/fetch`, app only).
    public func fetchCatalog() async {
        guard registryBusy == nil else { return }
        registryBusy = "fetch"
        defer { registryBusy = nil }
        // The manager shows the error itself (a banner with "Retry"), without NSAlert.
        do {
            try await client.registryFetch()
            fetchError = nil
        } catch let e as HubError {
            fetchError = e.code ?? "registry:fetch"
        } catch {
            fetchError = "registry:fetch"
        }
        await loadRegistry()
    }

    /// Own plugin requests from folders: from the manager (`/registry/installed`), otherwise from the snapshot (`/state.ownPlugins`).
    public var ownRequests: [OwnRequest] { installed?.requests ?? state?.ownPlugins?.requests ?? [] }

    /// "Add from folder…": a request (as from the CLI) and immediately the consent window — path, version, fingerprint, permissions.
    public func addFromFolder(_ path: String) async {
        guard registryBusy == nil else { return }
        do {
            switch try await client.registryOwnRequest(path: path) {
            case .pending(let q):
                await approveOwn(q.requestId, title: q.displayTitle)
                return
            case .already(let id):
                presenter?.report(title: tr("Уже установлен", "Already installed"),
                                  detail: tr("«\(id)» из этой папки уже стоит, и содержимое то же — ставить нечего.", "\"\(id)\" from this folder is already installed with the same contents — nothing to install."))
            case .denied(let status, let code, let errors):
                presenter?.report(title: tr("Плагин из папки не добавлен", "Plugin from the folder not added"),
                                  detail: Explain.text(code: code, status: status, label: path) + (errors.isEmpty ? "" : "\n\n" + errors.prefix(8).joined(separator: "\n")) + Self.codeNote(code))
            }
        } catch {
            reportOffline(error)
        }
        await loadRegistry()
    }

    /// "Check and install" on a request: consent window from the daemon (428), consent via a token.
    public func approveOwn(_ requestId: String, title: String) async {
        guard registryBusy == nil else { return }
        registryBusy = requestId
        defer { registryBusy = nil }
        do {
            var outcome = try await client.registryOwnApprove(requestId)
            if case .needsConsent(let req) = outcome {
                guard let presenter, await presenter.consent(req) else { return }
                outcome = try await client.registryOwnApprove(requestId, consentToken: req.token)
            }
            switch outcome {
            case .installed, .needsConsent: break
            case .denied(let status, let code):
                presenter?.report(title: tr("«\(title)» не установлен", "\"\(title)\" not installed"), detail: Explain.text(code: code, status: status, label: title) + Self.codeNote(code))
            }
        } catch {
            reportOffline(error)
        }
        await loadRegistry()
    }

    public func declineOwn(_ requestId: String) async {
        guard registryBusy == nil else { return }
        registryBusy = requestId
        defer { registryBusy = nil }
        do { try await client.registryOwnDecline(requestId) } catch {
            reportOffline(error)
        }
        await loadRegistry()
    }

    /// Install or update: the daemon sends the permissions window (428), consent is passed via a token. fromRegistry — from the catalog
    /// over an own plugin with the same id (reverse switch: window marked "Will replace your own … from the folder").
    public func install(_ id: String, fromRegistry: Bool = false) async {
        guard registryBusy == nil else { return }
        registryBusy = id
        defer { registryBusy = nil }
        do {
            var outcome = try await client.registryInstall(id, fromRegistry: fromRegistry)
            if case .needsConsent(let req) = outcome {
                guard let presenter, await presenter.consent(req) else { return }
                outcome = try await client.registryInstall(id, consentToken: req.token)
            }
            switch outcome {
            case .installed: break
            case .needsConsent:
                presenter?.report(title: tr("Права изменились", "Permissions changed"), detail: tr("Права изменились, пока было открыто окно, — повторите установку.", "Permissions changed while the window was open — install again."))
            case .denied(let status, let code):
                presenter?.report(title: tr("Плагин «\(id)» не установлен", "Plugin \"\(id)\" not installed"), detail: Explain.text(code: code, status: status, label: id) + Self.codeNote(code))
            }
        } catch {
            reportOffline(error)
        }
        await loadRegistry()
    }

    public func remove(_ id: String, purge: Bool) async {
        guard registryBusy == nil else { return }
        registryBusy = id
        defer { registryBusy = nil }
        do { try await client.registryRemove(id, purge: purge) } catch let e as HubError {
            presenter?.report(title: tr("Плагин «\(id)» не удалён", "Plugin \"\(id)\" not removed"), detail: Explain.text(code: e.code ?? "", status: 0, label: id) + Self.codeNote(e.code ?? ""))
        } catch {
            reportOffline(error)
        }
        await loadRegistry()
    }

    // MARK: - notifications

    public func ackNotify(_ notifyId: String) async {
        try? await client.pushAck(notifyId)
    }

    // MARK: - actions

    /// Run a plugin offer. Whether confirmation is needed is decided by the core (428 reply),
    /// the shell only shows its text and passes consent via a token.
    public func perform(offer: Offer, label: String) async {
        await perform(id: offer.id, args: nil, label: offer.label ?? label)
    }

    /// Call a primitive directly (panel forms: session launch, etc.).
    public func perform(id: String, args: [String: JSONValue]?, label: String) async {
        guard busyAction == nil else { return }
        busyAction = id
        defer { busyAction = nil }
        do {
            var outcome = try await client.invoke(id, args: args)
            if case .needsConfirm(let req) = outcome {
                guard let presenter, await presenter.confirm(req, actionLabel: label) else { return }
                outcome = try await client.invoke(id, args: args, confirmToken: req.token)
            }
            switch outcome {
            case .done(let ok, let result):
                // a plugin action checks its own facts and names the refusal reason with a `reason=<code>` line
                if !ok { presenter?.report(title: tr("Не получилось: \(label)", "Couldn't: \(label)"), detail: Explain.failure(result: result, label: label)) }
            case .needsConfirm:
                presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите действие.", "\(label): try again."))
            case .denied(let status, let code):
                deny(label, status: status, code: code)
            }
        } catch {
            reportOffline(error)
        }
    }

    /// Core refusal: the title says what failed, the text is human-readable, the code is the last line.
    private func deny(_ label: String, status: Int, code: String) {
        presenter?.report(title: tr("Не получилось: \(label)", "Couldn't: \(label)"), detail: Explain.text(code: code, status: status, label: label) + Self.codeNote(code))
    }

    nonisolated static func codeNote(_ code: String) -> String {
        code.isEmpty ? "" : "\n\n" + tr("Код для журнала: \(code)", "Log code: \(code)")
    }

    private func reportOffline(_ error: Error) {
        let why = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        presenter?.report(title: tr("Нет связи со службой хаба", "Lost connection to the hub service"), detail: why)
    }

    /// Hub pause (internal name — estop, ESTOP file). Anyone can turn it on, only the pinned build can lift it.
    public func setEstop(_ on: Bool) async {
        do {
            let v = try await client.setEstop(on)
            state?.estop = v
            if journalVisible { await loadJournal() }
        } catch let e as HubError {
            let notApp = e.code?.hasPrefix("peer:") == true
            presenter?.report(title: on ? tr("Не удалось поставить хаб на паузу", "Couldn't pause the hub") : tr("Пауза не снята", "Couldn't resume the hub"),
                              detail: !on && notApp ? tr("Снять паузу можно только из закреплённой сборки приложения.", "Only the pinned app build can resume.") + Self.codeNote(e.code ?? "")
                                  : (e.code.map { Explain.text(code: $0, status: 403, label: tr("Пауза хаба", "Pause hub")) + Self.codeNote($0) } ?? (e.errorDescription ?? "")))
        } catch {
            reportOffline(error)
        }
    }

    /// Hub language: written by the daemon (app class only), the reply is applied right away.
    public func setLang(_ setting: LangSetting) async {
        do {
            let info = try await client.setLang(setting.rawValue)
            L10n.shared.apply(setting: info.setting, effective: info.effective)
            state?.lang = info
            onLanguageChange?()
        } catch let e as HubError {
            presenter?.report(title: tr("Язык не сменён", "Language not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Язык хаба меняет только закреплённая сборка приложения.", "Only the pinned app build can change the hub's language.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    /// "Check for plugin updates": written by the daemon (app class only), the reply is applied right away.
    public func setCheckPluginUpdates(_ on: Bool) async {
        do {
            if let u = try await client.setCheckPluginUpdates(on) { state?.pluginUpdates = u }
            else { state?.pluginUpdates?.setting = on }
        } catch let e as HubError {
            presenter?.report(title: tr("Настройка не сменена", "Setting not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Эту настройку меняет только закреплённая сборка приложения.", "Only the pinned app build can change this setting.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    /// "Notifications": written by the daemon (app class only) — master switch, style or quiet hours; the reply is applied right away.
    public func setNotifications(_ patch: JSONValue) async {
        do {
            if let n = try await client.setNotifications(patch) { state?.notifications = n }
        } catch let e as HubError {
            presenter?.report(title: tr("Настройка не сменена", "Setting not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Эту настройку меняет только закреплённая сборка приложения.", "Only the pinned app build can change this setting.") + Self.codeNote(e.code ?? "")
                                  : NotificationsText.error(e.code) ?? (e.errorDescription ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    /// A connection from the daemon reply (`/connections/:id/*`, Connections.swift) — right away, without waiting for `connections.changed`.
    func applyConnection(_ c: ConnectionInfo) {
        guard var list = state?.connections, let i = list.firstIndex(where: { $0.id == c.id }) else { return }
        list[i] = c
        state?.connections = list
    }

    /// "Launch at login": written by the daemon (app class only) — a setting for the daemon + app pair (decision 2026-11-07).
    public func setLaunchAtLogin(_ on: Bool) async {
        do {
            let r = try await client.setLaunchAtLogin(on)
            state?.launchAtLogin = r ?? LaunchAtLoginInfo(setting: on)
        } catch let e as HubError {
            presenter?.report(title: tr("Настройка не сменена", "Setting not changed"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Эту настройку меняет только закреплённая сборка приложения.", "Only the pinned app build can change this setting.") + Self.codeNote(e.code ?? "")
                                  : (e.errorDescription ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    // MARK: - hub update (docs/hub-updates.md)

    public var hubUpdate: HubUpdateInfo? { state?.hubUpdate }

    /// "Check for hub updates": written by the daemon (app class only).
    public func setCheckHubUpdates(_ on: Bool) async {
        do {
            if let u = try await client.setCheckHubUpdates(on) { state?.hubUpdate = u } else { state?.hubUpdate?.setting = on }
        } catch let e as HubError {
            presenter?.report(title: tr("Настройка не сменена", "Setting not changed"), detail: HubUpdateText.denied(e.code) + Self.codeNote(e.code ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    /// "Check now": git ls-remote against origin; the result is in the card (the check line).
    public func checkHubUpdate() async {
        await hubUpdateRequest("check", title: tr("Проверка не выполнена", "Check failed")) { try await self.client.checkHubUpdate() }
    }

    /// "Update": first a confirmation (tag, commit, tag move, major version jump), then a background build,
    /// progress via `hub-update.status` events; when ready the hub restarts.
    public func installHubUpdate() async {
        guard let info = hubUpdate, let a = info.available, let ask = HubUpdateText.installConfirm(info) else { return }
        let req = ConfirmRequest(token: "", level: .confirm, text: ask.text, title: ask.title, button: ask.button, details: ask.details)
        guard let presenter, await presenter.confirm(req, actionLabel: ask.button) else { return }
        let accept = a.moved?.new
        await hubUpdateRequest("install", title: tr("Обновление не началось", "Update didn't start")) { try await self.client.installHubUpdate(version: a.version, acceptCommit: accept) }
    }

    /// "Restart now": the built version was waiting for the cards to be answered.
    public func switchHubUpdate() async {
        await hubUpdateRequest("switch", title: tr("Перезапуск не начался", "Restart didn't start")) { try await self.client.switchHubUpdate() }
    }

    /// "Roll back to <previous>": first a confirmation (the hub will restart), like "Update".
    public func rollbackHub() async {
        guard let info = hubUpdate, let ask = HubUpdateText.rollbackConfirm(info) else { return }
        let req = ConfirmRequest(token: "", level: .confirm, text: ask.text, title: ask.title, button: ask.button, details: ask.details)
        guard let presenter, await presenter.confirm(req, actionLabel: ask.button) else { return }
        await hubUpdateRequest("rollback", title: tr("Откат не начался", "Rollback didn't start")) { try await self.client.rollbackHub() }
    }

    private func hubUpdateRequest(_ kind: String, title: String, _ call: @escaping () async throws -> HubUpdateInfo?) async {
        guard hubUpdateBusy == nil else { return }
        hubUpdateBusy = kind
        defer { hubUpdateBusy = nil }
        do {
            if let u = try await call() { state?.hubUpdate = u }
        } catch let e as HubError {
            presenter?.report(title: title, detail: HubUpdateText.denied(e.code) + Self.codeNote(e.code ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    /// "Check now" for plugin updates (`POST /registry/check-updates`).
    public func checkPluginUpdatesNow() async {
        guard hubUpdateBusy == nil else { return }
        hubUpdateBusy = "plugins-check"
        defer { hubUpdateBusy = nil }
        do {
            if let u = try await client.checkPluginUpdates() { state?.pluginUpdates = u }
        } catch let e as HubError {
            presenter?.report(title: tr("Проверка не выполнена", "Check failed"),
                              detail: e.code?.hasPrefix("peer:") == true ? tr("Проверять обновления может только закреплённая сборка приложения.", "Only the pinned app build can check for updates.") + Self.codeNote(e.code ?? "") : (e.errorDescription ?? ""))
        } catch {
            reportOffline(error)
        }
    }

    /// "Update all plugins": one by one; no connection — a single alert and stop, refusals — one alert with a list.
    public func refreshAll() async {
        var failed: [String] = []
        for p in state?.plugins ?? [] {
            do { try await client.refresh(plugin: p.id) } catch let e as HubError {
                guard case .http = e else { reportOffline(e); return }
                failed.append("\(p.title): " + (e.code.map { Explain.text(code: $0, status: 0, label: p.title) } ?? (e.errorDescription ?? "")))
            } catch {
                reportOffline(error)
                return
            }
        }
        if !failed.isEmpty {
            presenter?.report(title: tr("Не все плагины перезапущены", "Not all plugins were restarted"), detail: failed.joined(separator: "\n"))
        }
    }

    public func refresh(plugin id: String) async {
        do { try await client.refresh(plugin: id) } catch {
            presenter?.report(title: tr("Плагин не перезапущен", "Plugin not restarted"), detail: (error as? LocalizedError)?.errorDescription ?? "")
        }
    }

    /// Explanation for a failed completed action (200, `ok: false`) — L10n.swift, Explain.failure.
    nonisolated public static func explainFailure(result: JSONValue?, label: String) -> String {
        Explain.failure(result: result, label: label)
    }

    /// Human-readable explanation of a core refusal code — L10n.swift, Explain.text.
    nonisolated public static func explain(code: String, status: Int, label: String) -> String {
        Explain.text(code: code, status: status, label: label)
    }
}
