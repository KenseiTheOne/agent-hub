import AsyncHTTPClient
import Foundation
import NIOCore
import NIOHTTP1

/// Where the daemon socket lives.
public enum HubPaths {
    /// `<home>/hub.sock`; `<home>` = `--home <dir>` from the arguments, otherwise `AGENTHUB_HOME`,
    /// otherwise `~/Library/Application Support/AgentHub` (same as the daemon, docs/extension-points.md).
    public static func socketPath(arguments: [String] = CommandLine.arguments,
                                  environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        (home(arguments: arguments, environment: environment) as NSString).appendingPathComponent("hub.sock")
    }

    public static func home(arguments: [String] = CommandLine.arguments,
                            environment: [String: String] = ProcessInfo.processInfo.environment) -> String {
        if let i = arguments.firstIndex(of: "--home"), i + 1 < arguments.count { return expand(arguments[i + 1]) }
        if let h = environment["AGENTHUB_HOME"], !h.isEmpty { return expand(h) }
        return defaultHome
    }

    /// The default hub directory is where the real daemon lives (launchd). Anything else is a test copy.
    public static var defaultHome: String {
        (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/AgentHub")
    }

    static func expand(_ p: String) -> String { (p as NSString).expandingTildeInPath }

    /// The socket must be a socket and belong to us: we don't listen to a foreign file in place of `hub.sock`.
    public static func checkSocket(_ path: String) -> String? {
        var st = stat()
        guard lstat(path, &st) == 0 else { return tr("служба хаба не запущена (нет \(path))", "the hub service isn't running (no \(path))") }
        guard (st.st_mode & S_IFMT) == S_IFSOCK else { return tr("\(path) — не сокет", "\(path) isn't a socket") }
        guard st.st_uid == getuid() else { return tr("\(path) принадлежит другому пользователю", "\(path) belongs to another user") }
        return nil
    }
}

/// Client errors. `code` is the `error` field from the daemon's response (`peer:cli`, `estop`, …).
public enum HubError: Error, Sendable, LocalizedError {
    case socket(String)
    case http(status: Int, code: String?)
    case decode(String)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .socket(let s): return s
        case .http(let status, let code): return "HTTP \(status)" + (code.map { ": \($0)" } ?? "")
        case .decode(let s): return tr("не разобрал ответ службы хаба: \(s)", "couldn't parse the hub service's reply: \(s)")
        case .transport(let s): return tr("нет связи со службой хаба: \(s)", "can't reach the hub service: \(s)")
        }
    }

    public var code: String? {
        if case .http(_, let c) = self { return c }
        return nil
    }
}

/// The result of `POST /actions/:id`.
public enum ActionOutcome: Sendable {
    /// 200: `ok` — what the primitive returned, `result` — the result's scalars.
    case done(ok: Bool, result: JSONValue?)
    /// 428: the core requires confirmation — show `text`/`cost` and retry with `token`.
    case needsConfirm(ConfirmRequest)
    /// 4xx/5xx with a core code (`peer:cli`, `peer:app-signature`, `estop`, `facts:…`, `confirm:invalid`).
    case denied(status: Int, code: String)
}

/// Daemon client: HTTP/1.1 over a Unix socket via AsyncHTTPClient (`http+unix://`).
/// No TCP at all: the URL has the socket path in place of the host.
public final class HubClient: Sendable {
    public let socketPath: String
    private let http: HTTPClient
    /// A separate client for SSE: 45 s read timeout (the daemon sends `: ping` every 15 s) — that way a hung daemon
    /// without a FIN is detected and the stream reconnects.
    private let stream: HTTPClient

    public init(socketPath: String) {
        self.socketPath = socketPath
        var cfg = HTTPClient.Configuration()
        cfg.timeout = .init(connect: .seconds(2), read: nil)
        cfg.redirectConfiguration = .disallow
        cfg.decompression = .disabled
        // keep the connection: the daemon determines the peer class once per connection
        cfg.connectionPool = .init(idleTimeout: .seconds(4))
        self.http = HTTPClient(eventLoopGroupProvider: .singleton, configuration: cfg)
        var scfg = cfg
        scfg.timeout = .init(connect: .seconds(2), read: .seconds(45))
        self.stream = HTTPClient(eventLoopGroupProvider: .singleton, configuration: scfg)
    }

    deinit {
        try? http.syncShutdown()
        try? stream.syncShutdown()
    }

    private func url(_ uri: String) throws -> String {
        guard let u = URL(httpURLWithSocketPath: socketPath, uri: uri) else { throw HubError.socket(tr("плохой путь сокета", "bad socket path")) }
        return u.absoluteString
    }

    /// A request with a JSON body; returns the status and the whole body (up to 32 MB).
    public func request(_ method: HTTPMethod, _ uri: String, json: JSONValue? = nil,
                        timeout: TimeAmount = .seconds(15)) async throws -> (status: Int, body: Data) {
        if let problem = HubPaths.checkSocket(socketPath) { throw HubError.socket(problem) }
        var req = HTTPClientRequest(url: try url(uri))
        req.method = method
        // in http+unix:// the socket path acts as the host; Node rejects such a Host (400) — send a nominal "hub"
        req.headers.replaceOrAdd(name: "host", value: "hub")
        req.headers.add(name: "accept", value: "application/json")
        if let json {
            let data = try JSONEncoder().encode(json)
            req.headers.add(name: "content-type", value: "application/json")
            req.body = .bytes(ByteBuffer(bytes: data))
        }
        do {
            let resp = try await http.execute(req, timeout: timeout)
            var buf = try await resp.body.collect(upTo: 32 * 1024 * 1024)
            let bytes = buf.readBytes(length: buf.readableBytes) ?? []
            return (Int(resp.status.code), Data(bytes))
        } catch let e as HubError {
            throw e
        } catch {
            throw HubError.transport(String(describing: error))
        }
    }

    public func get<T: Decodable>(_ type: T.Type, _ uri: String) async throws -> T {
        let r = try await request(.GET, uri)
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        do { return try JSONDecoder().decode(T.self, from: r.body) } catch { throw HubError.decode(String(describing: error)) }
    }

    public func state() async throws -> HubState { try await get(HubState.self, "/state") }

    public func peer() async throws -> PeerInfo { try await get(PeerInfo.self, "/peer") }

    private struct Health: Decodable { var pid: Int? }

    /// The daemon pid from `GET /health` — to tell that the daemon restarted and the old Last-Event-ID is no good.
    public func daemonPid() async throws -> Int? { try await get(Health.self, "/health").pid }

    public func journal(limit: Int = 200) async throws -> [JournalEntry] {
        try await get(JournalResponse.self, "/journal?limit=\(limit)").entries
    }

    /// `POST /actions/:id`. `id` is `offer.id` from the snapshot or a primitive name.
    public func invoke(_ id: String, args: [String: JSONValue]? = nil, confirmToken: String? = nil) async throws -> ActionOutcome {
        var body: [String: JSONValue] = [:]
        if let args { body["args"] = .object(args) }
        if let confirmToken { body["confirmToken"] = .string(confirmToken) }
        let path = "/actions/" + (id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id)
        let r = try await request(.POST, path, json: .object(body), timeout: .seconds(60))
        switch r.status {
        case 200:
            let v = try? JSONDecoder().decode(JSONValue.self, from: r.body)
            return .done(ok: v?["ok"]?.boolValue ?? false, result: v?["result"])
        case 428:
            do { return .needsConfirm(try JSONDecoder().decode(ConfirmRequest.self, from: r.body)) } catch {
                throw HubError.decode("428 without token")
            }
        default:
            return .denied(status: r.status, code: Self.errorCode(r.body) ?? "http-\(r.status)")
        }
    }

    /// `POST /estop`. Anyone can turn it on; only the signed application can turn it off (otherwise 403).
    public func setEstop(_ on: Bool) async throws -> Bool {
        let r = try await request(.POST, "/estop", json: .object(["on": .bool(on)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        return ((try? JSONDecoder().decode(JSONValue.self, from: r.body))?["estop"]?.boolValue) ?? on
    }

    /// `PUT /settings/lang` — app class only (cli gets 403).
    public func setLang(_ value: String) async throws -> LangInfo {
        let r = try await request(.PUT, "/settings/lang", json: .object(["lang": .string(value)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var lang: LangInfo }
        do { return try JSONDecoder().decode(Body.self, from: r.body).lang } catch { throw HubError.decode("settings") }
    }

    /// `PUT /settings/plugin-updates` (app only): "Check for plugin updates". → the new check state.
    public func setCheckPluginUpdates(_ enabled: Bool) async throws -> PluginUpdates? {
        let r = try await request(.PUT, "/settings/plugin-updates", json: .object(["enabled": .bool(enabled)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var pluginUpdates: PluginUpdates? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.pluginUpdates
    }

    /// `PUT /settings/launch-at-login` (app only): "Launch at login" — the daemon + application pair. → the new setting.
    public func setLaunchAtLogin(_ enabled: Bool) async throws -> LaunchAtLoginInfo? {
        let r = try await request(.PUT, "/settings/launch-at-login", json: .object(["enabled": .bool(enabled)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var launchAtLogin: LaunchAtLoginInfo? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.launchAtLogin
    }

    /// `PUT /settings/notifications` (app only): "Notifications" — a partial edit `{enabled?, kinds?, quiet?}`.
    /// → the new settings.
    public func setNotifications(_ patch: JSONValue) async throws -> NotificationsInfo? {
        let r = try await request(.PUT, "/settings/notifications", json: patch)
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var notifications: NotificationsInfo? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.notifications
    }

    /// `PUT /settings/hub-updates` (app only): "Check for hub updates". → the new hub update state.
    public func setCheckHubUpdates(_ enabled: Bool) async throws -> HubUpdateInfo? {
        let r = try await request(.PUT, "/settings/hub-updates", json: .object(["enabled": .bool(enabled)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var hubUpdate: HubUpdateInfo? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.hubUpdate
    }

    /// `POST /hub-update/check` (app only): "Check now" — git ls-remote against origin (up to 30 s).
    public func checkHubUpdate() async throws -> HubUpdateInfo? {
        try await hubUpdateCall("/hub-update/check", body: [:], ok: [200], timeout: .seconds(45))
    }

    /// `POST /hub-update/install {version, acceptCommit?}` (app only): build and switch. 202 — the build
    /// has started. acceptCommit — a human saw that the tag was moved to this commit (otherwise 409 hub-update:tag-moved).
    public func installHubUpdate(version: String, acceptCommit: String? = nil) async throws -> HubUpdateInfo? {
        var body: [String: JSONValue] = ["version": .string(version)]
        if let c = acceptCommit { body["acceptCommit"] = .string(c) }
        return try await hubUpdateCall("/hub-update/install", body: body, ok: [202])
    }

    /// `POST /hub-update/switch` (app only): a built version was waiting for a second press (cards were waiting) —
    /// restart into it now.
    public func switchHubUpdate() async throws -> HubUpdateInfo? {
        try await hubUpdateCall("/hub-update/switch", body: [:], ok: [202])
    }

    /// `POST /hub-update/rollback {version?}` (app only): switch to the previous built version.
    public func rollbackHub(version: String? = nil) async throws -> HubUpdateInfo? {
        try await hubUpdateCall("/hub-update/rollback", body: version.map { ["version": .string($0)] } ?? [:], ok: [202])
    }

    private func hubUpdateCall(_ path: String, body: [String: JSONValue], ok: Set<Int>, timeout: TimeAmount = .seconds(10)) async throws -> HubUpdateInfo? {
        let r = try await request(.POST, path, json: .object(body), timeout: timeout)
        guard ok.contains(r.status) else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var hubUpdate: HubUpdateInfo? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.hubUpdate
    }

    /// `POST /registry/check-updates` (app only): "Check now" for plugin updates.
    public func checkPluginUpdates() async throws -> PluginUpdates? {
        let r = try await request(.POST, "/registry/check-updates", json: .object([:]), timeout: .seconds(45))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var pluginUpdates: PluginUpdates? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.pluginUpdates
    }

    /// `POST /shutdown` (app only): the application quits — the daemon stops cleanly with code 0 (launchd doesn't
    /// restart it). → HTTP status (202 — stopping). Short timeout: quitting the app doesn't wait.
    public func shutdown(timeout: TimeAmount = .seconds(2)) async throws -> (status: Int, code: String?) {
        let r = try await request(.POST, "/shutdown", json: .object([:]), timeout: timeout)
        return (r.status, Self.errorCode(r.body))
    }

    public func refresh(plugin id: String) async throws {
        let r = try await request(.POST, "/plugins/\(id)/refresh")
        guard r.status == 202 || r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
    }

    // MARK: - session reply cards (docs/hook.md)

    /// `GET /hook/cards` — app only (the questions contain conversation content); cli gets 403.
    public func hookCards() async throws -> HookCardsResponse { try await get(HookCardsResponse.self, "/hook/cards") }

    // MARK: - plugin manager (docs/plugins-registry.md)

    public func registryCatalog() async throws -> RegistryCatalog { try await get(RegistryCatalog.self, "/registry/catalog") }

    public func registryInstalled() async throws -> RegistryInstalled { try await get(RegistryInstalled.self, "/registry/installed") }

    /// `POST /registry/fetch` — download and verify the signed `index.json`.
    public func registryFetch() async throws {
        let r = try await request(.POST, "/registry/fetch", json: .object([:]), timeout: .seconds(60))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
    }

    /// `POST /registry/install`: without a token the daemon answers with the permissions sheet (428), with a token it installs. fromRegistry — install
    /// from the catalog over an own plugin with the same id (reverse migration, `source: "registry"`; always with the sheet).
    public func registryInstall(_ id: String, consentToken: String? = nil, fromRegistry: Bool = false) async throws -> InstallOutcome {
        var body: [String: JSONValue] = ["id": .string(id)]
        if let consentToken { body["consentToken"] = .string(consentToken) }
        if fromRegistry { body["source"] = .string("registry") }
        let r = try await request(.POST, "/registry/install", json: .object(body), timeout: .seconds(120))
        switch r.status {
        case 200:
            let v = try? JSONDecoder().decode(JSONValue.self, from: r.body)
            return .installed(version: v?["version"]?.stringValue, update: v?["update"]?.boolValue ?? false)
        case 428:
            do { return .needsConsent(try JSONDecoder().decode(ConsentRequest.self, from: r.body)) } catch {
                throw HubError.decode("428 without consent")
            }
        default:
            return .denied(status: r.status, code: Self.errorCode(r.body) ?? "http-\(r.status)")
        }
    }

    // MARK: own plugins from folders (docs/plugins-registry.md "Own sources")

    /// `POST /registry/own/request` — a request for an own plugin from a folder (cli or app); only approve installs it.
    public func registryOwnRequest(path: String) async throws -> OwnRequestOutcome {
        let r = try await request(.POST, "/registry/own/request", json: .object(["path": .string(path)]), timeout: .seconds(30))
        let v = try? JSONDecoder().decode(JSONValue.self, from: r.body)
        if r.status == 200 {
            if v?["already"]?.boolValue == true { return .already(id: v?["id"]?.stringValue ?? "?") }
            if let q = try? JSONDecoder().decode(OwnRequest.self, from: r.body) { return .pending(q) }
            throw HubError.decode("own request")
        }
        let errors: [String] = {
            if case .array(let a)? = v?["errors"] { return a.compactMap(\.stringValue) }
            return []
        }()
        return .denied(status: r.status, code: Self.errorCode(r.body) ?? "http-\(r.status)", errors: errors)
    }

    /// `POST /registry/own/approve` (app only): without a token — the consent sheet (428), with a token — install.
    public func registryOwnApprove(_ requestId: String, consentToken: String? = nil) async throws -> InstallOutcome {
        var body: [String: JSONValue] = ["requestId": .string(requestId)]
        if let consentToken { body["consentToken"] = .string(consentToken) }
        let r = try await request(.POST, "/registry/own/approve", json: .object(body), timeout: .seconds(60))
        switch r.status {
        case 200:
            let v = try? JSONDecoder().decode(JSONValue.self, from: r.body)
            return .installed(version: v?["version"]?.stringValue, update: v?["update"]?.boolValue ?? false)
        case 428:
            do { return .needsConsent(try JSONDecoder().decode(ConsentRequest.self, from: r.body)) } catch {
                throw HubError.decode("428 without consent")
            }
        default:
            return .denied(status: r.status, code: Self.errorCode(r.body) ?? "http-\(r.status)")
        }
    }

    /// `POST /registry/own/decline` (app only).
    public func registryOwnDecline(_ requestId: String) async throws {
        let r = try await request(.POST, "/registry/own/decline", json: .object(["requestId": .string(requestId)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
    }

    public func registryRemove(_ id: String, purge: Bool) async throws {
        let r = try await request(.POST, "/registry/remove", json: .object(["id": .string(id), "purge": .bool(purge)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
    }

    // MARK: - notifications

    /// `POST /push/ack` — the shell showed the banner itself; the daemon doesn't duplicate it via osascript.
    public func pushAck(_ notifyId: String) async throws {
        let r = try await request(.POST, "/push/ack", json: .object(["id": .string(notifyId)]))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
    }

    /// The live `GET /events` stream. The stream ends when the daemon closes the connection; reconnecting is up to the caller.
    /// `lastEventId` goes into `Last-Event-ID`: the daemon resends what was missed or sends a new `snapshot`.
    /// Comments (`: ping`) arrive as the `SSEEvent.keepalive` event.
    public func events(lastEventId: String?) -> AsyncThrowingStream<SSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    if let problem = HubPaths.checkSocket(socketPath) { throw HubError.socket(problem) }
                    var req = HTTPClientRequest(url: try url("/events"))
                    req.method = .GET
                    req.headers.replaceOrAdd(name: "host", value: "hub")
                    req.headers.add(name: "accept", value: "text/event-stream")
                    if let lastEventId { req.headers.add(name: "last-event-id", value: lastEventId) }
                    let resp = try await stream.execute(req, deadline: .distantFuture)
                    guard resp.status == .ok else {
                        var b = try await resp.body.collect(upTo: 64 * 1024)
                        let data = Data(b.readBytes(length: b.readableBytes) ?? [])
                        throw HubError.http(status: Int(resp.status.code), code: Self.errorCode(data))
                    }
                    var parser = SSEParser()
                    for try await chunk in resp.body {
                        let pings = parser.comments
                        for ev in parser.push(chunk.readableBytesView) { continuation.yield(ev) }
                        // `: ping` — the stream is alive though there are no events: the "updated" label doesn't go stale
                        if parser.comments != pings { continuation.yield(.keepalive) }
                    }
                    continuation.finish()
                } catch let e as HubError {
                    continuation.finish(throwing: e)
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: HubError.transport(String(describing: error)))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func errorCode(_ data: Data) -> String? {
        (try? JSONDecoder().decode(HubErrorBody.self, from: data))?.error
    }
}
