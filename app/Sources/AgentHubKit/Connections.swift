import Foundation

/// A connection to an external service over OAuth (`/state.connections`, the daemon's oauth service). The hub does not know
/// which connections exist: a plugin declares them with the `<agenthub.connection>` tag (contract 2) — the name, description, address and
/// tool allowlist come from the daemon. No plugin — no connection. There are no tokens here and cannot be: the daemon
/// returns only state and timings.
public struct ConnectionInfo: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    /// Service name — from the plugin's declaration (`title=`), in the hub language.
    public var title: String
    /// Why the connection is needed — the description from the plugin's declaration (the tag text), in the hub language.
    public var note: String?
    /// The plugin that declared the connection: the "Connect" button is on its page too.
    public var plugin: String?
    /// The plugin was removed (or no longer declares the connection) but the sign-in is still in the keychain: only "Disconnect".
    public var orphan: Bool?
    public var host: String?
    /// MCP tool allowlist from the declaration (only these can be called).
    public var tools: [String]?
    /// `unknown` | `unavailable` (no keychain) | `disconnected` | `connecting` | `connected` | `expired`
    public var state: String
    public var since: String?
    /// Code of the last error: sign-in (`denied`, `timeout`, `discovery`, `register`, `exchange`, `iss-mismatch`, `keychain`, …),
    /// "Disconnect" (`keychain-delete`), keychain (`keychain-read`) or calls (`forbidden` — 403, the sign-in lacks permissions).
    public var error: String?
    /// Code detail: for `discovery` — what exactly is wrong in the metadata (`resource-mismatch`, `issuer-url`, `no-s256`, …),
    /// for `forbidden` — the error from WWW-Authenticate (`insufficient_scope`).
    public var errorReason: String?
    /// What the server granted at sign-in (nil — not signed in).
    public var scope: String?
    /// What the connection asks for at sign-in — `scope=` from the plugin's declaration.
    public var requestedScope: String?
    public var expiresAt: String?
    public var refresh: Bool?
    public var login: Login?
    public var intervalMs: Int?
    public var dailyBudget: Int?
    public var calls24h: Int?
    public var lastOkAt: String?
    public var nextAt: String?
    /// Why the next refresh is later than usual: `rate-limit`, `budget`, `http-limit`, `error`; nil — per the interval.
    public var why: String?
    public var keychain: Bool?

    public struct Login: Codable, Sendable, Hashable {
        public var startedAt: String?
        public var expiresAt: String?
    }

    public init(id: String, title: String, plugin: String? = nil, state: String, error: String? = nil) {
        self.id = id; self.title = title; self.plugin = plugin; self.state = state; self.error = error
    }

    public var isOrphan: Bool { orphan == true }
    public var isConnected: Bool { state == "connected" && !isOrphan }
    public var isConnecting: Bool { state == "connecting" }
    public var isExpired: Bool { state == "expired" }
    public var canConnect: Bool { state != "unavailable" && state != "unknown" && !isOrphan }
    /// "Disconnect" failed (the keychain did not delete the entry) — the button stays so it can be pressed again.
    public var canDisconnect: Bool { isOrphan || state == "connected" || state == "expired" || (state == "connecting" && scope != nil) || error == "keychain-delete" }

    /// Parsing `connections` from the `connections.changed` event.
    public static func list(from v: JSONValue?) -> [ConnectionInfo]? {
        guard let v, let raw = try? JSONEncoder().encode(v) else { return nil }
        return try? JSONDecoder().decode([ConnectionInfo].self, from: raw)
    }
}

/// Connection texts for the shell — in the hub language.
public enum ConnectionsText {
    public static func stateLine(_ c: ConnectionInfo) -> String {
        if c.isOrphan {
            return tr("Плагина больше нет — вход остался в связке ключей", "The plugin is gone — the sign-in is still in the keychain")
        }
        switch c.state {
        case "connected":
            // "read-only" is not derived from scope: what the hub calls is defined by the plugin's tool allowlist (explain)
            var s = tr("Подключён", "Connected")
            if let d = c.since.flatMap(parseISODate) { s += tr(" · с \(Fmt.dateTime(d))", " · since \(Fmt.dateTime(d))") }
            return s
        case "connecting":
            return tr("Ждём подтверждения в браузере…", "Waiting for you to approve in the browser…")
        case "expired":
            return tr("Вход истёк или доступ отозван — подключите снова", "The sign-in expired or access was revoked — reconnect")
        case "unavailable":
            return tr("Недоступно: хаб не может хранить вход в связке ключей", "Unavailable: the hub can't keep the sign-in in the keychain")
        case "unknown":
            return tr("Проверяю…", "Checking…")
        default:
            return tr("Не подключён", "Not connected")
        }
    }

    public static func connectTitle(_ c: ConnectionInfo) -> String {
        c.isExpired ? tr("Подключить \(c.title) снова", "Reconnect \(c.title)") : tr("Подключить \(c.title)", "Connect \(c.title)")
    }
    public static var disconnectTitle: String { tr("Отключить", "Disconnect") }
    public static var cancelTitle: String { tr("Отмена", "Cancel") }
    public static var openAgainTitle: String { tr("Открыть страницу входа ещё раз", "Open the sign-in page again") }

    /// What "Connect" does — one line under the button. Service, interval and budget come from the plugin's declaration; the hub
    /// does not know or name the service's plans.
    public static func explain(_ c: ConnectionInfo) -> String {
        let minutes = max(1, (c.intervalMs ?? 900_000) / 60_000)
        let budget = c.dailyBudget ?? 100
        let access = toolsLine(c)
        return tr("Вход и подтверждение — на сайте \(c.title), токен вводить не нужно. Хаб хранит вход в связке ключей и сам делает запросы — плагин токена не видит. \(access), обновление не чаще раза в \(minutes) мин, не больше \(budget) запросов в сутки.",
                  "You sign in and approve on the \(c.title) site — no token to paste. The hub keeps the sign-in in the keychain and makes the requests itself; the plugin never sees the token. \(access), refreshing at most every \(minutes) min, at most \(budget) requests a day.")
    }

    /// What the hub may call: the tool allowlist from the plugin's declaration (the server may not check scope —
    /// so we do not promise "read-only" based on it).
    public static func toolsLine(_ c: ConnectionInfo) -> String {
        let tools = (c.tools ?? []).filter { !$0.isEmpty }
        if tools.isEmpty || tools.count > 4 {
            return tr("Только инструменты, объявленные плагином", "Only the tools the plugin declared")
        }
        let list = tools.joined(separator: ", ")
        return tools.count == 1 ? tr("Только инструмент \(list)", "Only the \(list) tool") : tr("Только инструменты \(list)", "Only the tools \(list)")
    }

    /// An orphaned connection: what "Disconnect" means.
    public static func orphanExplain(_ c: ConnectionInfo) -> String {
        tr("Плагин, которому нужно было это подключение, удалён. «Отключить» удалит оставшийся вход из связки ключей; вернёте плагин — вход подхватится снова.",
           "The plugin that needed this connection was removed. Disconnect deletes the leftover sign-in from the keychain; if you bring the plugin back, it picks the sign-in up again.")
    }

    public static func disconnectExplain(_ c: ConnectionInfo) -> String {
        tr("«Отключить» удаляет вход из связки ключей хаба. Выданный доступ на стороне \(c.title) хаб не отзывает — при необходимости отзовите его в настройках \(c.title).",
           "Disconnect removes the sign-in from the hub's keychain. The hub doesn't revoke the access on the \(c.title) side — revoke it in the \(c.title) settings if needed.")
    }

    /// "Needed by plugin "X": <why>" — a line in "Settings"; nil — nothing to say.
    public static func ownerLine(_ c: ConnectionInfo, pluginTitle: String?) -> String? {
        let trimmed = { (s: String?) -> String? in
            guard let t = s?.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
            return t
        }
        let note = trimmed(c.note)
        guard let who = trimmed(pluginTitle) else { return note }
        let q = L10n.shared.lang == .en ? "\"\(who)\"" : "«\(who)»"
        if let note { return tr("Нужно плагину \(q): \(note)", "Needed by \(q): \(note)") }
        return tr("Нужно плагину \(q)", "Needed by \(q)")
    }

    /// Service name when the response has no connection (rejected before parsing).
    public static var someService: String { tr("сервис", "the service") }

    /// When the next refresh is and why it is less frequent — for a connected one.
    public static func refreshLine(_ c: ConnectionInfo) -> String? {
        guard c.isConnected else { return nil }
        var parts: [String] = []
        if let d = c.lastOkAt.flatMap(parseISODate) { parts.append(tr("обновлено \(Fmt.time(d))", "updated \(Fmt.time(d))")) }
        if let d = c.nextAt.flatMap(parseISODate) {
            switch c.why {
            case "rate-limit": parts.append(tr("лимит \(c.title) исчерпан — следующее в \(Fmt.time(d))", "\(c.title) limit reached — next at \(Fmt.time(d))"))
            case "budget": parts.append(tr("бережём суточный лимит — следующее в \(Fmt.time(d))", "saving the daily limit — next at \(Fmt.time(d))"))
            case "http-limit": parts.append(tr("\(c.title) просит сбавить темп — следующее в \(Fmt.time(d))", "\(c.title) asks to slow down — next at \(Fmt.time(d))"))
            case "error": parts.append(tr("\(c.title) не ответил — повтор в \(Fmt.time(d))", "\(c.title) didn't respond — retry at \(Fmt.time(d))"))
            case "forbidden": parts.append(tr("\(c.title) не дал доступ — повтор в \(Fmt.time(d))", "\(c.title) denied access — retry at \(Fmt.time(d))"))
            case "tool-error": parts.append(tr("\(c.title) вернул ошибку на запрос — повтор в \(Fmt.time(d))", "\(c.title) returned an error — retry at \(Fmt.time(d))"))
            default: parts.append(tr("следующее в \(Fmt.time(d))", "next at \(Fmt.time(d))"))
            }
        }
        if let n = c.calls24h, let b = c.dailyBudget { parts.append(tr("запросов за сутки: \(n) из \(b)", "requests in 24 h: \(n) of \(b)")) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Error detail in small print (the daemon's reason code), if present and it adds something.
    public static func errorDetail(_ c: ConnectionInfo) -> String? {
        guard c.error != nil, let r = c.errorReason, !r.isEmpty else { return nil }
        return tr("причина: \(r)", "reason: \(r)")
    }

    public static func warns(_ c: ConnectionInfo) -> Bool {
        c.isExpired || (c.why != nil && c.isConnected) || c.error != nil
    }

    /// `discovery` reasons that can also come from a network or server failure (the metadata did not arrive); the rest mean the service
    /// changed its sign-in settings (another issuer, no S256, wrong resource), and the network has nothing to do with it.
    static let discoveryNetworkReasons: Set<String> = ["no-resource-metadata", "no-as-metadata"]

    /// A sign-in error (daemon code) in human terms; nil — no error. reason — the detail (`errorReason`).
    public static func error(_ code: String?, title: String = ConnectionsText.someService, reason: String? = nil) -> String? {
        guard let code else { return nil }
        switch code.replacingOccurrences(of: "oauth:", with: "") {
        case "denied": return tr("Вход отменён в браузере — доступ не выдан", "Sign-in was cancelled in the browser — no access granted")
        case "timeout": return tr("Подтверждения не дождались за 5 минут — нажмите «Подключить» ещё раз", "No approval within 5 minutes — click Connect again")
        case "discovery" where reason != nil && !discoveryNetworkReasons.contains(reason!):
            return tr("\(title) изменил настройки входа — обновите хаб", "\(title) changed its sign-in settings — update the hub")
        case "discovery": return tr("Не удалось найти сервер входа \(title) — проверьте сеть", "Couldn't find the \(title) sign-in server — check your network")
        case "register": return tr("\(title) не зарегистрировал хаб как приложение — попробуйте позже", "\(title) didn't register the hub as an app — try again later")
        case "exchange", "invalid-grant": return tr("\(title) не выдал доступ по коду — попробуйте ещё раз", "\(title) didn't grant access for the code — try again")
        case "iss-mismatch": return tr("Ответ пришёл не от того сервера входа — вход отклонён", "The reply came from the wrong sign-in server — sign-in rejected")
        case "keychain", "no-keychain": return tr("Не получилось записать вход в связку ключей", "Couldn't save the sign-in in the keychain")
        case "keychain-delete": return tr("Не получилось удалить вход из связки ключей — нажмите «Отключить» ещё раз", "Couldn't remove the sign-in from the keychain — click Disconnect again")
        case "keychain-read": return tr("Связка ключей не ответила — хаб попробует снова через минуту", "The keychain didn't respond — the hub will try again in a minute")
        case "forbidden": return tr("\(title) не даёт этому входу доступ к данным — проверьте права аккаунта в \(title)", "\(title) doesn't give this sign-in access to the data — check the account's permissions in \(title)")
        case "net": return tr("Нет связи с \(title)", "Can't reach \(title)")
        case "authorize": return tr("\(title) вернул ошибку входа", "\(title) returned a sign-in error")
        case "token-expired", "invalid-token": return nil // this is the expired state, it has its own line
        default:
            if code.hasPrefix("http-") { return nil }
            return tr("Ошибка входа: \(code)", "Sign-in error: \(code)")
        }
    }
}

// MARK: - requests to the daemon

extension HubClient {
    public struct ConnectStart: Decodable, Sendable {
        public var authorizeUrl: String
        public var expiresAt: String?
        public var connection: ConnectionInfo?
    }

    /// A `connect` refusal: the daemon's code and detail (`reason`) and the connection state from the response.
    public struct ConnectFailed: Error, Sendable {
        public var status: Int
        public var code: String?
        public var reason: String?
        public var connection: ConnectionInfo?
    }

    /// `POST /connections/:id/connect` (app only): start signing in. → the sign-in page address (the shell opens it).
    public func connect(_ id: String) async throws -> ConnectStart {
        let r = try await request(.POST, "/connections/\(id)/connect", json: .object([:]), timeout: .seconds(30))
        guard r.status == 200 else {
            struct Body: Decodable { var error: String?; var reason: String?; var connection: ConnectionInfo? }
            let b = try? JSONDecoder().decode(Body.self, from: r.body)
            throw ConnectFailed(status: r.status, code: b?.error ?? Self.errorCode(r.body), reason: b?.reason, connection: b?.connection)
        }
        do { return try JSONDecoder().decode(ConnectStart.self, from: r.body) } catch { throw HubError.decode("connect") }
    }

    /// `POST /connections/:id/cancel` | `/disconnect` (app only). → the new connection state.
    public func connectionCall(_ id: String, _ op: String) async throws -> ConnectionInfo? {
        let r = try await request(.POST, "/connections/\(id)/\(op)", json: .object([:]), timeout: .seconds(15))
        guard r.status == 200 else { throw HubError.http(status: r.status, code: Self.errorCode(r.body)) }
        struct Body: Decodable { var connection: ConnectionInfo? }
        return (try? JSONDecoder().decode(Body.self, from: r.body))?.connection
    }
}

extension HubStore {
    /// A connection by id (from the plugin's declaration) from the snapshot.
    public func connectionInfo(_ id: String) -> ConnectionInfo? { state?.connections?.first { $0.id == id } }
    /// The connection that provides data to this plugin.
    public func connectionInfo(forPlugin id: String) -> ConnectionInfo? { state?.connections?.first { $0.plugin == id && !$0.isOrphan } }

    private func put(_ c: ConnectionInfo?) {
        if let c { applyConnection(c) }
    }

    /// "Connect": the daemon starts signing in and returns the sign-in page address. → a URL for the browser (the view opens it).
    public func startConnect(_ id: String) async -> URL? {
        do {
            let r = try await client.connect(id)
            put(r.connection)
            guard let url = URL(string: r.authorizeUrl), url.scheme == "https" || url.host == "127.0.0.1" || url.host == "localhost" else { return nil }
            return url
        } catch let e as HubClient.ConnectFailed {
            put(e.connection)
            let title = e.connection?.title ?? ConnectionsText.someService
            var detail = e.code?.hasPrefix("peer:") == true
                ? tr("Подключать сервисы может только закреплённая сборка приложения.", "Only the pinned app build can connect services.") + Self.codeNote(e.code ?? "")
                : ConnectionsText.error(e.code, title: title, reason: e.reason) ?? "HTTP \(e.status)"
            if let r = e.reason, e.code?.hasPrefix("peer:") != true { detail += " (\(r))" }
            presenter?.report(title: tr("Подключение не начато", "Couldn't start connecting"), detail: detail)
        } catch let e as HubError {
            presenter?.report(title: tr("Подключение не начато", "Couldn't start connecting"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Подключать сервисы может только закреплённая сборка приложения.", "Only the pinned app build can connect services.") + Self.codeNote(e.code ?? "")
                                  : ConnectionsText.error(e.code) ?? (e.errorDescription ?? ""))
        } catch {
            presenter?.report(title: tr("Подключение не начато", "Couldn't start connecting"), detail: (error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
        return nil
    }

    /// "Cancel" of an ongoing sign-in and "Disconnect".
    public func connectionOp(_ id: String, _ op: String) async {
        do {
            put(try await client.connectionCall(id, op))
        } catch let e as HubError {
            presenter?.report(title: op == "disconnect" ? tr("Не отключено", "Not disconnected") : tr("Не отменено", "Not cancelled"),
                              detail: e.code?.hasPrefix("peer:") == true
                                  ? tr("Это может только закреплённая сборка приложения.", "Only the pinned app build can do this.") + Self.codeNote(e.code ?? "")
                                  : ConnectionsText.error(e.code) ?? (e.errorDescription ?? ""))
        } catch {
            presenter?.report(title: tr("Нет связи с хабом", "Can't reach the hub"), detail: (error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
    }
}
