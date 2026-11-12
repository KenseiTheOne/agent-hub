import Foundation

/// External daemon extensions (G4, `/state.extensions`, event `extensions.changed`): `<home>/Extensions/{services,routes,
/// primitives,terminals}/*.mjs` — code inside the daemon with its full rights, loaded only after a human approved the
/// file's exact bytes here (`POST /extensions/approve {path, sha256}`, app only).
public struct ExtensionsInfo: Codable, Sendable, Hashable {
    public var dir: String?
    public var enabled: Bool
    public var testAutoApprove: Bool
    /// The consent text in the hub language — shown verbatim in the approval sheet.
    public var consent: String?
    /// Items waiting for a human (`pending` + `changed`): the badge.
    public var pending: Int
    public var items: [ExtensionItem]

    public init(dir: String? = nil, enabled: Bool = true, testAutoApprove: Bool = false, consent: String? = nil, pending: Int = 0, items: [ExtensionItem] = []) {
        self.dir = dir; self.enabled = enabled; self.testAutoApprove = testAutoApprove; self.consent = consent; self.pending = pending; self.items = items
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dir = try? c.decodeIfPresent(String.self, forKey: .dir)
        enabled = (try? c.decodeIfPresent(Bool.self, forKey: .enabled)) ?? true
        testAutoApprove = (try? c.decodeIfPresent(Bool.self, forKey: .testAutoApprove)) ?? false
        consent = try? c.decodeIfPresent(String.self, forKey: .consent)
        items = c.lossyList(ExtensionItem.self, forKey: .items) ?? []
        pending = (try? c.decodeIfPresent(Int.self, forKey: .pending)) ?? items.filter(\.needsApproval).count
    }

    enum CodingKeys: String, CodingKey { case dir, enabled, testAutoApprove, consent, pending, items }
}

public struct ExtensionItem: Codable, Sendable, Hashable, Identifiable {
    /// `revoked` — the approval was dropped while the module is loaded: it runs until the hub restarts (restartRequired) and
    /// waits for nobody (the human already decided), so it is not counted in `pending`.
    public enum Status: String, Codable, Sendable { case pending, changed, approved, revoked, error, unknown }

    /// `<folder>/<file>.mjs` — the id for approve/revoke.
    public var path: String
    public var file: String?
    public var kind: String
    public var name: String?
    public var sha256: String?
    public var size: Int?
    public var mtime: String?
    public var status: Status
    public var loaded: Bool
    public var restartRequired: Bool
    public var approvedSha256: String?
    public var autoApproved: Bool
    public var skipped: String?
    public var error: String?
    public var errorText: String?
    public var errorDetail: String?
    public var id: String { path }

    public init(path: String, kind: String, name: String? = nil, sha256: String? = nil, status: Status, loaded: Bool = false, restartRequired: Bool = false) {
        self.path = path; self.file = nil; self.kind = kind; self.name = name; self.sha256 = sha256; self.size = nil; self.mtime = nil
        self.status = status; self.loaded = loaded; self.restartRequired = restartRequired; self.approvedSha256 = nil; self.autoApproved = false
        self.skipped = nil; self.error = nil; self.errorText = nil; self.errorDetail = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        file = try? c.decodeIfPresent(String.self, forKey: .file)
        kind = ((try? c.decodeIfPresent(String.self, forKey: .kind)) ?? nil) ?? "?"
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        sha256 = try? c.decodeIfPresent(String.self, forKey: .sha256)
        size = try? c.decodeIfPresent(Int.self, forKey: .size)
        mtime = try? c.decodeIfPresent(String.self, forKey: .mtime)
        status = ((try? c.decodeIfPresent(String.self, forKey: .status)) ?? nil).flatMap(Status.init(rawValue:)) ?? .unknown
        loaded = (try? c.decodeIfPresent(Bool.self, forKey: .loaded)) ?? false
        restartRequired = (try? c.decodeIfPresent(Bool.self, forKey: .restartRequired)) ?? false
        approvedSha256 = try? c.decodeIfPresent(String.self, forKey: .approvedSha256)
        autoApproved = (try? c.decodeIfPresent(Bool.self, forKey: .autoApproved)) ?? false
        skipped = try? c.decodeIfPresent(String.self, forKey: .skipped)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        errorText = try? c.decodeIfPresent(String.self, forKey: .errorText)
        errorDetail = try? c.decodeIfPresent(String.self, forKey: .errorDetail)
    }

    enum CodingKeys: String, CodingKey {
        case path, file, kind, name, sha256, size, mtime, status, loaded, restartRequired, approvedSha256, autoApproved, skipped, error, errorText, errorDetail
    }

    /// Waits for a human: never approved, or the bytes changed since.
    public var needsApproval: Bool { status == .pending || status == .changed }
    /// The first 12 hex characters of the fingerprint (the sheet shows the whole one under it).
    public var shortSha: String { sha256.map { String($0.prefix(12)) } ?? "?" }

    public var kindLabel: String {
        switch kind {
        case "service": return tr("служба", "service")
        case "route": return tr("маршрут", "route")
        case "primitive": return tr("примитив", "primitive")
        case "terminal": return tr("терминал", "terminal")
        default: return kind
        }
    }

    public var statusText: String {
        switch status {
        case .pending: return tr("ждёт одобрения", "waiting for approval")
        case .changed: return tr("файл изменился — одобрите снова", "file changed — approve again")
        case .approved:
            if skipped == "disabled" { return tr("одобрено, выключено в настройках", "approved, turned off in the config") }
            if autoApproved { return tr("одобрено автоматически (тест)", "auto-approved (test)") }
            return loaded ? tr("одобрено, работает", "approved, running") : tr("одобрено", "approved")
        case .revoked: return tr("одобрение отозвано — работает до перезапуска", "approval revoked — runs until restart")
        case .error: return errorText ?? error.map { tr("ошибка: \($0)", "error: \($0)") } ?? tr("ошибка", "error")
        case .unknown: return "?"
        }
    }

    /// The note under an item whose running code is not what is approved now.
    public static var restartText: String {
        tr("Работает прежняя версия — новое решение вступит в силу после перезапуска хаба.",
           "The previous version keeps running — the new decision takes effect after the hub restarts.")
    }
}

extension SidebarStatus {
    /// "Plugins" in the sidebar while hub extensions wait for approval (an orange line; the approval itself is on the page).
    public static func extensionsWaiting(_ e: ExtensionsInfo?) -> SidebarStatus? {
        guard let n = e?.pending, n > 0 else { return nil }
        return SidebarStatus(text: tr("расширения ждут одобрения: \(n)", "extensions waiting for approval: \(n)"), tone: .attention)
    }
}
