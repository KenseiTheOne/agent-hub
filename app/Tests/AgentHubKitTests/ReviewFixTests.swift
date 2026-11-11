import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import Testing
@testable import AgentHubKit

// Tests for the app review findings (2026-11-05). Stream reconnection, the answers pause and "Update all plugins" run
// against a fake daemon: HTTP/1.1 over its own Unix socket in /tmp/ahf-app-kit-*, with no network and no real daemon.

// MARK: - fake daemon

final class FakeDaemon: @unchecked Sendable {
    struct Request: Sendable { var method: String; var uri: String; var lastEventId: String? }

    let path: String
    private let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private var channel: Channel?
    private let lock = NSLock()
    private var _peerClass = "app"
    private var _requests: [Request] = []
    private var _held: [Channel] = []
    /// The `/events` response body by Last-Event-ID and `/events` request number (from 0).
    var events: @Sendable (_ lastEventId: String?, _ n: Int) -> String = { _, _ in "" }
    /// The `/hook/cards` response for the app class.
    var cards: @Sendable () -> String = { #"{"cards":[],"paused":false}"# }
    /// A custom reply to a request (method, path) → (status, body); nil means the default reply.
    var reply: @Sendable (_ method: String, _ uri: String) -> (status: Int, body: String)? = { _, _ in nil }

    var peerClass: String {
        get { lock.withLock { _peerClass } }
        set { lock.withLock { _peerClass = newValue } }
    }
    var requests: [Request] { lock.withLock { _requests } }
    var eventRequests: [Request] { requests.filter { $0.uri.hasPrefix("/events") } }

    init(path: String? = nil) throws {
        self.path = path ?? "/tmp/ahf-app-kit-\(UUID().uuidString.prefix(8)).sock"
        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { [unowned self] ch in
                ch.pipeline.configureHTTPServerPipeline().flatMap { ch.pipeline.addHandler(Handler(daemon: self)) }
            }
        channel = try bootstrap.bind(unixDomainSocketPath: self.path, cleanupExistingSocketFile: true).wait()
    }

    /// Close the held `/events` streams; the app will reconnect.
    func dropStreams() {
        let list = lock.withLock { let l = _held; _held = []; return l }
        for c in list { c.close(promise: nil) }
    }

    func shutdown() {
        dropStreams()
        try? channel?.close().wait()
        try? group.syncShutdownGracefully()
        unlink(path)
    }

    fileprivate func respond(_ head: HTTPRequestHead, channel: Channel) -> (status: HTTPResponseStatus, body: String, sse: Bool) {
        let leid = head.headers.first(name: "last-event-id")
        let n: Int = lock.withLock {
            _requests.append(Request(method: head.method.rawValue, uri: head.uri, lastEventId: leid))
            return _requests.filter { $0.uri.hasPrefix("/events") }.count - 1
        }
        let isApp = peerClass == "app"
        if let r = reply(head.method.rawValue, head.uri) { return (HTTPResponseStatus(statusCode: r.status), r.body, false) }
        switch (head.method, head.uri) {
        case (.GET, "/health"): return (.ok, #"{"ok":true,"pid":123}"#, false)
        case (.GET, "/peer"): return (.ok, #"{"class":"\#(peerClass)","reason":null,"pid":1}"#, false)
        case (.GET, "/hook/cards"): return isApp ? (.ok, cards(), false) : (.forbidden, #"{"error":"peer:\#(peerClass)"}"#, false)
        case (.POST, "/shutdown"): return isApp ? (.accepted, #"{"ok":true,"stopping":true}"#, false) : (.forbidden, #"{"error":"peer:\#(peerClass)"}"#, false)
        case (.PUT, "/settings/launch-at-login"): return isApp ? (.ok, #"{"launchAtLogin":{"setting":false}}"#, false) : (.forbidden, #"{"error":"peer:\#(peerClass)"}"#, false)
        case (.PUT, "/settings/notifications"): return isApp ? (.ok, #"{"notifications":{"enabled":true,"kinds":{"updates":true},"plugins":[{"id":"nightly","title":"Ночной","on":false,"labels":["Готово"]}],"quiet":{"enabled":true,"start":"22:00","end":"07:00","from":"settings"},"security":[{"key":"app-pin-changed","plugin":"@hub","label":"x"}],"service":true}}"#, false) : (.forbidden, #"{"error":"peer:\#(peerClass)"}"#, false)
        // OAuth connections (ConnectionsTests): start login, disconnect
        case (.POST, "/connections/tix/connect"): return isApp ? (.ok, #"{"authorizeUrl":"https://mcp.example.com/oauth/authorize?client_id=c1&state=s","expiresAt":"2026-11-09T12:05:00.000Z","connection":{"id":"tix","title":"Tix","plugin":"tix","state":"connecting","login":{"startedAt":"2026-11-09T12:00:00.000Z","expiresAt":"2026-11-09T12:05:00.000Z"}}}"#, false) : (.forbidden, #"{"error":"peer:\#(peerClass)"}"#, false)
        case (.POST, "/connections/tix/disconnect"): return isApp ? (.ok, #"{"ok":true,"connection":{"id":"tix","title":"Tix","plugin":"tix","state":"disconnected"}}"#, false) : (.forbidden, #"{"error":"peer:\#(peerClass)"}"#, false)
        case (.GET, "/events"):
            lock.withLock { _held.append(channel) }
            return (.ok, events(leid, n), true)
        default: return (.notFound, #"{"error":"not-found"}"#, false)
        }
    }

    private final class Handler: ChannelInboundHandler, @unchecked Sendable {
        typealias InboundIn = HTTPServerRequestPart
        typealias OutboundOut = HTTPServerResponsePart
        let daemon: FakeDaemon
        var head: HTTPRequestHead?
        init(daemon: FakeDaemon) { self.daemon = daemon }

        func channelRead(context: ChannelHandlerContext, data: NIOAny) {
            switch unwrapInboundIn(data) {
            case .head(let h): head = h
            case .body: break
            case .end:
                guard let h = head else { return }
                let r = daemon.respond(h, channel: context.channel)
                var headers = HTTPHeaders()
                headers.add(name: "content-type", value: r.sse ? "text/event-stream" : "application/json")
                if !r.sse { headers.add(name: "content-length", value: "\(r.body.utf8.count)") }
                context.write(wrapOutboundOut(.head(HTTPResponseHead(version: h.version, status: r.status, headers: headers))), promise: nil)
                context.write(wrapOutboundOut(.body(.byteBuffer(ByteBuffer(string: r.body)))), promise: nil)
                // keep the event stream open until the test closes it (dropStreams)
                if r.sse { context.flush() } else { context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil) }
            }
        }
    }
}

/// An SSE frame as the daemon sends it.
func sseFrame(_ id: Int, _ type: String, _ data: String) -> String { "id: \(id)\nevent: \(type)\ndata: \(data)\n\n" }

func snapshotFrame(_ id: Int, peer: String, plugins: String = "[]") -> String {
    sseFrame(id, "snapshot", #"{"id":\#(id),"type":"snapshot","state":{"pid":123,"seq":\#(id),"estop":false,"status":"ok","plugins":\#(plugins),"sessions":[],"peer":{"class":"\#(peer)","reason":null}}}"#)
}

let oneCard = #"{"cards":[{"requestId":"0123456789abcdef0123456789abcdef","sessionId":"s-1","kind":"permission","tool":"Bash","decisions":["once","deny"]}],"paused":false}"#

@MainActor
func waitFor(_ seconds: Double = 6, _ cond: () -> Bool) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
        if cond() { return true }
        try? await Task.sleep(for: .milliseconds(50))
    }
    return cond()
}

@MainActor
final class RecordingPresenter: ConfirmPresenter {
    var reports: [(title: String, detail: String)] = []
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool { false }
    func report(title: String, detail: String) { reports.append((title, detail)) }
    func consent(_ request: ConsentRequest) async -> Bool { false }
}

// MARK: - finding 5: after re-pinning, a snapshot rather than a replay; new class and cards

@Suite(.serialized) struct ReconnectTests {
    @MainActor @Test func peerChangeOnReconnectForcesSnapshot() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.cards = { oneCard }
        d.events = { leid, n in
            if n == 0 { return snapshotFrame(10, peer: "app") }
            // replay by Last-Event-ID comes without a snapshot or peer (that is how the daemon answers, server.mjs)
            if leid != nil { return sseFrame(11, "app-pin.changed", #"{"type":"app-pin.changed","appPin":{"kind":"cdhash","fingerprint":"cdhash:bb"}}"#) }
            return snapshotFrame(11, peer: "cli")
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.peer?.isApp == true && store.cards.count == 1 })
        // another build was pinned: this one became cli, and the daemon drops its connections
        d.peerClass = "cli"
        d.dropStreams()
        #expect(await waitFor { store.peer?.isApp == false && store.cards.isEmpty && store.cardsError != nil })
        // "Sessions" does not need a second banner saying the same thing: "this app copy is not pinned" is already shown
        #expect(store.cardsErrorIsPeer && store.sessionsNotice == nil)
        #expect(d.eventRequests.count >= 2)
        #expect(d.eventRequests.dropFirst().first?.lastEventId == nil, "the second stream starts with a snapshot, not a replay")
    }

    @MainActor @Test func appPinChangedEventDropsLastEventId() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, n in
            n == 0 ? snapshotFrame(20, peer: "app") + sseFrame(21, "app-pin.changed", #"{"type":"app-pin.changed","appPin":{"kind":"cdhash","fingerprint":"cdhash:cc"}}"#)
                   : snapshotFrame(22, peer: "app")
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.state?.appPin?.fingerprint == "cdhash:cc" })
        #expect(store.snapshotNext)
        d.dropStreams()
        #expect(await waitFor { d.eventRequests.count >= 2 && store.state?.seq == 22 })
        #expect(d.eventRequests[1].lastEventId == nil)
        #expect(!store.snapshotNext)
    }

    // MARK: finding 33: the answers pause banner clears by itself when the pause ends

    @MainActor @Test func hookPauseClearsAtUntil() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        let until = Date().addingTimeInterval(1.0)
        let iso = ISO8601DateFormatter().string(from: until)
        d.cards = { Date() < until ? #"{"cards":[],"paused":true}"# : #"{"cards":[],"paused":false}"# }
        d.events = { _, n in
            n == 0 ? snapshotFrame(30, peer: "app") + sseFrame(31, "hook.paused", #"{"until":"\#(iso)","limit":10}"#) : ""
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.cardsError == HubStore.pausedText })
        #expect(store.pausedUntil != nil)
        #expect(await waitFor(5) { store.cardsError == nil }, "after until the cards are reloaded and the banner is gone")
    }

    // MARK: finding 35: `: ping` arrives from the client as a keepalive event and refreshes "updated"

    @MainActor @Test func pingIsDeliveredAsKeepalive() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in snapshotFrame(40, peer: "app") + ": ping\n\n" }
        let client = HubClient(socketPath: d.path)
        var got: [SSEEvent] = []
        for try await ev in client.events(lastEventId: nil) {
            got.append(ev)
            if ev.isKeepalive { break }
        }
        #expect(got.first?.event == "snapshot")
        #expect(got.last?.isKeepalive == true)

        let store = HubStore(client: client)
        store.handle(SSEEvent.keepalive)
        #expect(store.lastEventAt == nil, "before a snapshot a ping means nothing")
        store.handle(SSEEvent(id: "40", event: "snapshot", data: #"{"state":{"seq":40,"plugins":[]}}"#))
        let first = try #require(store.lastEventAt)
        try await Task.sleep(for: .milliseconds(20))
        let seq = store.state?.seq
        store.handle(SSEEvent.keepalive)
        #expect(try #require(store.lastEventAt) > first)
        #expect(store.state?.seq == seq, "a ping does not change the snapshot")
    }

    // MARK: finding 38: "Update all plugins" shows one dialog, not one per plugin

    @MainActor @Test func refreshAllReportsOnce() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        let state = HubState(plugins: [PluginState(id: "a", title: "Альфа", status: .ok), PluginState(id: "b", title: "Бета", status: .ok)])
        let p = RecordingPresenter()
        let store = HubStore(client: HubClient(socketPath: d.path), preview: state)
        store.presenter = p
        await store.refreshAll()
        #expect(p.reports.count == 1)
        #expect(p.reports.first?.detail.contains("Альфа") == true && p.reports.first?.detail.contains("Бета") == true)

        // no connection: one dialog and stop
        let off = HubStore(client: HubClient(socketPath: "/tmp/ahf-app-kit-none.sock"), preview: state)
        let p2 = RecordingPresenter()
        off.presenter = p2
        await off.refreshAll()
        #expect(p2.reports.count == 1)
    }
}

// MARK: - finding 33: when to recheck the pause

@Test func pauseRecheckDelay() {
    let now = Date()
    #expect(HubStore.pauseRecheckDelay(until: nil, now: now) == 15)
    #expect(abs(HubStore.pauseRecheckDelay(until: now.addingTimeInterval(60), now: now) - 60.5) < 0.001)
    #expect(HubStore.pauseRecheckDelay(until: now.addingTimeInterval(-5), now: now) == 2)
    #expect(HubStore.pauseRecheckDelay(until: now.addingTimeInterval(86_400), now: now) == 600)
}

// MARK: - finding 32: semver with prereleases

@Test func semverPrereleaseOrder() {
    func lt(_ a: String, _ b: String) -> Bool { PluginVersion.compare(a, b) == .orderedAscending && PluginVersion.compare(b, a) == .orderedDescending }
    #expect(lt("1.3.0-beta.1", "1.3.0"))
    #expect(lt("1.2.0-rc.1", "1.2.0"))
    #expect(lt("1.2.0", "1.3.0-beta.1"))
    // order from semver.org: 1.0.0-alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < 1.0.0
    let order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"]
    for (a, b) in zip(order, order.dropFirst()) { #expect(lt(a, b), "\(a) < \(b)") }
    #expect(PluginVersion.compare("1.2.10", "1.2.9") == .orderedDescending)
    #expect(PluginVersion.compare("1.2", "1.2.0") == .orderedSame)
    #expect(PluginVersion.compare("1.0.0+build.5", "1.0.0") == .orderedSame)

    // button: beta to release is an update, release to beta is a rollback
    func kind(installed: String, catalog: String) -> PluginUpdateKind? {
        let json = #"{"id":"x","version":"\#(catalog)","installed":"\#(installed)","updateAvailable":true}"#
        return (try? JSONDecoder().decode(CatalogPlugin.self, from: Data(json.utf8)))?.updateKind
    }
    #expect(kind(installed: "1.3.0-beta.1", catalog: "1.3.0") == .newer("1.3.0"))
    #expect(kind(installed: "1.3.0", catalog: "1.3.0-beta.1") == .older("1.3.0-beta.1"))
}

// MARK: - findings 6, 7, 39: notification "Open" and the sessions plugin page

@Test func notifyTargetForHubAndSessions() {
    #expect(NotifyTarget.of(plugin: "@hub", key: "@hub:approvals-paused") == .sessions)
    #expect(NotifyTarget.of(plugin: "claude-sessions", key: "claude-sessions:waiting:abc") == .sessions)
    #expect(NotifyTarget.of(plugin: "claude-sessions", key: "claude-sessions:died:abc") == .sessions)
    #expect(NotifyTarget.of(plugin: "@other", key: "@other:x") == .sessions)
    #expect(NotifyTarget.of(plugin: "hermes", key: "hermes:x") == .plugin("hermes"))
}

// MARK: - findings 40, 41, 42: buttons the core is sure to reject

// regression review: the claude-sessions page leads to "Sessions", so dead sessions and "no sessions visible" must be there
@Test func sessionsPluginExtrasKeepDiedAndBroken() {
    // a frame like claude-sessions render(): a dead session, a live one (already in the registry), the source
    var p = PluginState(id: "claude-sessions", title: "Сессии", status: .wait, header: [Item(title: "1 сессия оборвалась", status: .wait)], body: [
        Item(title: "ES — оборвалась посреди работы (процесс пропал)", status: .wait, event: "died:abc", params: ["color": "red"]),
        Item(title: "Продолжить: claude --resume abc", level: 1),
        Item(title: "Подробности", level: 1, params: ["details": "true"]),
        Item(title: "замечена 05.11 10:00 · процесс 41", level: 2),
        Item(title: "Agent Hub — ждёт ответа", status: .wait),
        Item(title: "", separator: true),
        Item(title: "Источник", params: ["color": "gray"]),
        Item(title: "claude agents --json", level: 1),
    ])
    var x = SessionsPluginExtras(p)
    #expect(x.nodes.count == 1)
    #expect(x.nodes[0].item.event == "died:abc")
    #expect(x.nodes[0].children.map(\.item.title).contains("Продолжить: claude --resume abc"))
    #expect(x.brokenTitle == nil && x.failure == nil)
    // the header itself names the breakage reason; the gray detail is the first body line
    p.header = [Item(title: "Не найден claude — хаб ищет его в ~/.local/bin", status: .unknown, event: "source-broken")]
    p.body = [Item(title: "Подробности: claude agents --json не ответил", params: ["color": "gray"]), Item(title: "", separator: true), Item(title: "Источник")]
    x = SessionsPluginExtras(p)
    #expect(x.brokenTitle == "Не найден claude — хаб ищет его в ~/.local/bin")
    #expect(x.brokenDetail == "Подробности: claude agents --json не ответил")
    #expect(x.nodes.isEmpty)
    // the reason as a body line (sessions exist, the source is partly broken)
    p.header = [Item(title: "1 сессия работает", status: .ok)]
    p.body = [Item(title: "Часть сессий не видна", status: .unknown, event: "source-broken"), Item(title: "файлы сессий не читаются", level: 1)]
    x = SessionsPluginExtras(p)
    #expect(x.brokenTitle == nil)
    #expect(x.nodes.map(\.item.event) == ["source-broken"])
    // failure of the plugin itself
    p.status = .error; p.error = "exit 1"
    #expect(SessionsPluginExtras(p).failure == "exit 1")
    #expect(SessionsPluginExtras(nil).isEmpty)
}

@Test func actionBlockMirrorsCore() throws {
    let prims = try JSONDecoder().decode([PrimitiveInfo].self, from: Data(#"""
    [{"name":"open.url","level":"immediate","appOnly":false},{"name":"open.file","level":"immediate","appOnly":false},
     {"name":"cmux.focus","level":"immediate","appOnly":false},{"name":"session.interrupt","level":"confirm","appOnly":true},
     {"name":"session.stop","level":"confirm","appOnly":true},{"name":"session.launch","level":"confirm-cost","appOnly":true}]
    """#.utf8))
    let app = PeerInfo(class: "app", reason: nil), cli = PeerInfo(class: "cli", reason: "peer:app-signature")
    func check(_ p: String?, _ level: ActionLevel = .immediate, action: Bool = false, peer: PeerInfo? = app, estop: Bool = false, bridge: Bool = true, live: Bool = true) -> ActionBlock? {
        ActionBlock.check(primitive: p, level: level, pluginAction: action, primitives: prims, live: live, peer: peer, estop: estop, bridgeOnline: bridge)
    }
    // connection first
    #expect(check("open.url", live: false) == .offline)
    // unpinned build: no confirm-level or app-only actions, immediate ones are fine
    #expect(check("session.stop", .confirm, peer: cli) == .notPinned)
    #expect(check("session.interrupt", peer: cli) == .notPinned, "the level comes from /state.primitives")
    #expect(check(nil, .confirm, action: true, peer: cli) == .notPinned, "a declared action with confirmation")
    #expect(check(nil, .immediate, action: true, peer: cli) == nil)
    // 2026-11-09: an immediate action of an official plugin (offer.appOnly) is pinned-build only, as in the core
    #expect(ActionBlock.check(primitive: nil, level: .immediate, pluginAction: true, primitives: prims, live: true, peer: cli, estop: false,
                              bridgeOnline: true, actionAppOnly: true) == .notPinned)
    #expect(ActionBlock.check(primitive: nil, level: .immediate, pluginAction: true, primitives: prims, live: true, peer: app, estop: false,
                              bridgeOnline: true, actionAppOnly: true) == nil)
    let offer = try JSONDecoder().decode(Offer.self, from: Data(#"{"id":"o1","kind":"action","action":"mode-tasks","level":"immediate","appOnly":true}"#.utf8))
    #expect(offer.appOnly && offer.level == .immediate)
    #expect(try JSONDecoder().decode(Offer.self, from: Data(#"{"id":"o2","kind":"action","level":"confirm"}"#.utf8)).appOnly == false, "an old daemon sends no such field")
    #expect(check("open.url", peer: cli) == nil)
    #expect(check("session.stop", .confirm, peer: nil) == nil, "class unknown: the core decides")
    // pause: only open.url/open.file work; plugin actions do not
    #expect(check("open.url", estop: true) == nil)
    #expect(check("open.file", estop: true) == nil)
    #expect(check(nil, .confirm, action: true, estop: true) == .paused)
    #expect(check("cmux.focus", estop: true) == .paused)
    // the daemon provides safeUnderEstop; the app trusts it rather than its own list
    let fromDaemon = try JSONDecoder().decode([PrimitiveInfo].self, from: Data(#"""
    [{"name":"open.url","level":"immediate","appOnly":false,"safeUnderEstop":false},
     {"name":"cmux.focus","level":"immediate","appOnly":false,"safeUnderEstop":true}]
    """#.utf8))
    func checkD(_ p: String) -> ActionBlock? {
        ActionBlock.check(primitive: p, level: .immediate, pluginAction: false, primitives: fromDaemon, live: true, peer: app, estop: true, bridgeOnline: true)
    }
    #expect(checkD("open.url") == .paused)
    #expect(checkD("cmux.focus") == nil)
    // bridge
    #expect(check("session.interrupt", bridge: false) == .noBridge)
    #expect(check("cmux.focus", bridge: false) == .noBridge)
    #expect(check("session.stop", .confirm, bridge: false) == nil, "stopping works without the bridge")
    #expect(ActionBlock.check(primitive: "session.launch", level: .confirmCost, pluginAction: false, primitives: prims, live: true, peer: app,
                              estop: false, bridgeOnline: false, needsBridge: false) == nil, "the launch form opens even without the bridge")
}

@MainActor @Test func storeGateUsesSnapshot() throws {
    var st = HubState()
    st.peer = PeerInfo(class: "cli", reason: nil)
    st.primitives = try JSONDecoder().decode([PrimitiveInfo].self, from: Data(#"[{"name":"session.stop","level":"confirm","appOnly":true}]"#.utf8))
    let store = HubStore(client: HubClient(socketPath: "/tmp/ahf-app-kit-none.sock"), preview: st)
    #expect(!store.canAct)
    #expect(store.gate(primitive: "session.stop") == .notPinned)
    #expect(store.gate(offer: Offer(id: "o", kind: "effect", primitive: "open.url", level: .immediate)) == nil)
    #expect(store.gate(offer: Offer(id: "a", kind: "action", level: .confirm)) == .notPinned)
}

// MARK: - finding 34: a journal entry id does not shift on reload

@Test func journalIdsStableAcrossReload() throws {
    func entries(_ json: String) throws -> [JournalEntry] { try JSONDecoder().decode(JournalResponse.self, from: Data(json.utf8)).entries }
    let a = #"{"ts":"2026-11-05T10:00:00.000Z","type":"action","action":"x","ok":true}"#
    let b = #"{"ts":"2026-11-05T10:00:01.000Z","type":"action-denied","action":"y","error":"estop"}"#
    let c = #"{"ts":"2026-11-05T10:00:02.000Z","type":"action","action":"z","ok":true}"#
    let first = try entries("{\"entries\":[\(a),\(b)]}")
    // the tail moved: an old entry left, a new one came; "b" keeps the same id
    let second = try entries("{\"entries\":[\(b),\(c)]}")
    #expect(first[1].id == second[0].id)
    #expect(first[1].type == second[0].type)
    #expect(Set(second.map(\.id)).count == 2)
    // identical entries (same time to the ms) get different ids
    let dup = try entries("{\"entries\":[\(a),\(a)]}")
    #expect(dup[0].id != dup[1].id)
}

// MARK: - texts (process language is in the serialized TextTests group)

extension TextTests {
    // finding 45
    @Test func firstPinIsNotRepin() {
        L10n.shared.lang = .ru
        func label(_ f: [String: JSONValue]) -> String { JournalEntry(index: 0, raw: f.merging(["type": .string("app-requirement-changed")]) { a, _ in a }).typeLabel }
        #expect(label(["old": .string("none"), "new": .string("cdhash:aa")]) == "Приложение закреплено")
        #expect(label(["new": .string("cdhash:aa")]) == "Приложение закреплено")
        // the daemon does not remember the previous one (app-pin.mjs: old = "unknown"): like the banner and push, a first pin
        #expect(label(["old": .string("unknown"), "new": .string("cdhash:aa")]) == "Приложение закреплено")
        #expect(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:aa", old: "unknown").isFirstPin)
        #expect(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:aa", old: "none").isFirstPin)
        #expect(!AppPinInfo(kind: "cdhash", fingerprint: "cdhash:bb", old: "cdhash:aa").isFirstPin)
        #expect(label(["old": .string("cdhash:aa"), "new": .string("cdhash:bb")]) == "Приложение закреплено заново")
        #expect(label(["old": .string("cdhash:aa"), "new": .string("none")]) == "Закрепление приложения снято")
        L10n.shared.lang = .en
        #expect(label(["old": .string("none"), "new": .string("cdhash:aa")]) == "App pinned")
        #expect(label(["old": .string("cdhash:aa"), "new": .string("cdhash:bb")]) == "App re-pinned")
        L10n.shared.lang = .ru
    }

    // finding 43
    @Test func refreshIntervalUnits() {
        L10n.shared.lang = .ru
        #expect(RefreshInterval.text("30s") == "каждые 30 с")
        #expect(RefreshInterval.text("5m") == "каждые 5 мин")
        #expect(RefreshInterval.text("1h") == "каждые 1 ч")
        #expect(RefreshInterval.text("1d") == "каждые 1 дн")
        #expect(RefreshInterval.text("500ms") == "каждые 500 мс")
        #expect(RefreshInterval.text("weird") == "каждые weird")
        L10n.shared.lang = .en
        #expect(RefreshInterval.text("500ms") == "every 500 ms")
        #expect(RefreshInterval.text("1h") == "every 1 h")
        #expect(RefreshInterval.text("5m") == "every 5 min")
        L10n.shared.lang = .ru
    }

    // finding 36
    @Test func launchStatusTexts() {
        L10n.shared.lang = .ru
        #expect(LaunchStatus(sessionId: "s", name: "ES", state: .timeout).text.contains("не появилась за минуту"))
        #expect(LaunchStatus(sessionId: "s", name: "ES", state: .registered).text.hasPrefix("«ES»"))
        L10n.shared.lang = .en
        #expect(LaunchStatus(sessionId: "s", name: "ES", state: .started).text.contains("waiting for the session"))
        L10n.shared.lang = .ru
    }
}
