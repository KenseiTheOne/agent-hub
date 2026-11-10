import Foundation

// Models of panel parts on top of the daemon's extension routes: session reply cards (docs/hook.md),
// session launch (bridge/README.md, session.launch), the plugin manager (docs/plugins-registry.md),
// push notifications (daemon/lib/push/README.md). Parsing is lenient: extra and missing fields don't crash the shell.

// MARK: - session reply cards

/// A `GET /hook/cards` card: a permission (tool and a safe summary — no body) or an AskUserQuestion question.
public struct HookCard: Decodable, Sendable, Hashable, Identifiable {
    public enum Kind: String, Decodable, Sendable { case permission, question }

    public struct Option: Decodable, Sendable, Hashable {
        public var label: String
        public var description: String?
        public init(label: String, description: String? = nil) { self.label = label; self.description = description }
    }

    public struct Question: Decodable, Sendable, Hashable {
        public var question: String
        public var header: String?
        public var multiSelect: Bool
        public var options: [Option]

        public init(question: String, header: String? = nil, multiSelect: Bool = false, options: [Option]) {
            self.question = question; self.header = header; self.multiSelect = multiSelect; self.options = options
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            question = (try? c.decode(String.self, forKey: .question)) ?? ""
            header = try? c.decodeIfPresent(String.self, forKey: .header)
            multiSelect = (try? c.decode(Bool.self, forKey: .multiSelect)) ?? false
            options = (try? c.decode([Option].self, forKey: .options)) ?? []
        }

        enum CodingKeys: String, CodingKey { case question, header, multiSelect, options }
    }

    public var requestId: String
    public var sessionId: String
    public var sessionName: String?
    public var surfaceId: String?
    public var subagent: Bool
    public var kind: Kind
    public var tool: String?
    public var summary: String?
    public var questions: [Question]
    public var decisions: [String]
    public var createdAt: String?
    public var expiresAt: String?

    public var id: String { requestId }

    public init(requestId: String, sessionId: String, sessionName: String? = nil, kind: Kind, tool: String? = nil,
                summary: String? = nil, questions: [Question] = [], expiresAt: String? = nil) {
        self.requestId = requestId; self.sessionId = sessionId; self.sessionName = sessionName; self.surfaceId = nil
        self.subagent = false; self.kind = kind; self.tool = tool; self.summary = summary; self.questions = questions
        self.decisions = kind == .question ? ["answer", "deny"] : ["once", "deny"]; self.createdAt = nil; self.expiresAt = expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        sessionId = (try? c.decode(String.self, forKey: .sessionId)) ?? ""
        sessionName = try? c.decodeIfPresent(String.self, forKey: .sessionName)
        surfaceId = try? c.decodeIfPresent(String.self, forKey: .surfaceId)
        subagent = (try? c.decode(Bool.self, forKey: .subagent)) ?? false
        kind = (try? c.decode(Kind.self, forKey: .kind)) ?? .permission
        tool = try? c.decodeIfPresent(String.self, forKey: .tool)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        questions = (try? c.decodeIfPresent([Question].self, forKey: .questions)) ?? []
        decisions = (try? c.decode([String].self, forKey: .decisions)) ?? (kind == .question ? ["answer", "deny"] : ["once", "deny"])
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        expiresAt = try? c.decodeIfPresent(String.self, forKey: .expiresAt)
    }

    enum CodingKeys: String, CodingKey {
        case requestId, sessionId, sessionName, surfaceId, subagent, kind, tool, summary, questions, decisions, createdAt, expiresAt
    }

    public var expiresDate: Date? { expiresAt.flatMap(parseISODate) }
}

public struct HookCardsResponse: Decodable, Sendable {
    public var cards: [HookCard]
    public var paused: Bool
    /// Until when replies are paused (if the daemon provides it; in `/hook/status` — `pausedUntil`).
    public var pausedUntil: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cards = (try? c.decode([HookCard].self, forKey: .cards)) ?? []
        paused = (try? c.decode(Bool.self, forKey: .paused)) ?? false
        pausedUntil = try? c.decodeIfPresent(String.self, forKey: .pausedUntil)
    }

    enum CodingKeys: String, CodingKey { case cards, paused, pausedUntil }
}

/// The result of the last session launch from the form: the core opened a tab (`started`), the bridge saw the session in the registry
/// (`registered`, event `bridge.launch.registered`) or it didn't appear within a minute (`timeout`).
public struct LaunchStatus: Equatable, Sendable {
    public enum Phase: String, Sendable { case started, registered, timeout }
    public var sessionId: String?
    public var name: String
    public var state: Phase

    public init(sessionId: String?, name: String, state: Phase) {
        self.sessionId = sessionId; self.name = name; self.state = state
    }

    /// The launch line — in the form and as a banner in Sessions.
    public var text: String {
        switch state {
        case .started: return tr("«\(name)»: вкладка открыта, жду сессию…", "\"\(name)\": tab opened, waiting for the session…")
        case .registered: return tr("«\(name)»: сессия появилась в хабе", "\"\(name)\": the session appeared in the hub")
        case .timeout: return tr("«\(name)»: сессия не появилась за минуту — проверьте вкладку cmux", "\"\(name)\": the session didn't appear within a minute — check the cmux tab")
        }
    }
}

/// The choice for one question: option indices or custom text ("Other").
public enum QuestionAnswer: Sendable, Hashable {
    case options([Int])
    case other(String)
}

/// A reply to a card. Only "once" / "deny" / choosing options — no "always", bypass, setMode:
/// the `session.respond` protocol can't even express them.
public enum RespondChoice: Sendable, Hashable {
    case allowOnce
    case deny
    case answer([QuestionAnswer])

    /// Arguments for `POST /actions/session.respond` (docs/hook.md).
    public func args(requestId: String) -> [String: JSONValue] {
        switch self {
        case .allowOnce:
            return ["requestId": .string(requestId), "decision": .string("once")]
        case .deny:
            return ["requestId": .string(requestId), "decision": .string("deny")]
        case .answer(let list):
            let arr: [JSONValue] = list.map {
                switch $0 {
                case .options(let idx): return .array(idx.map { .number(Double($0)) })
                case .other(let text): return .string(text)
                }
            }
            let data = (try? JSONEncoder().encode(JSONValue.array(arr))) ?? Data("[]".utf8)
            return ["requestId": .string(requestId), "decision": .string("answer"),
                    "answers": .string(String(decoding: data, as: UTF8.self))]
        }
    }
}

extension HookCard {
    /// Whether these answers can be sent: an answer to every question; without multiSelect — exactly one option;
    /// "Other" — 1–2000 characters.
    public func isComplete(_ answers: [QuestionAnswer]) -> Bool {
        guard kind == .question, answers.count == questions.count, !questions.isEmpty else { return false }
        for (q, a) in zip(questions, answers) {
            switch a {
            case .options(let idx):
                if idx.isEmpty || idx.contains(where: { $0 < 0 || $0 >= q.options.count }) { return false }
                if !q.multiSelect && idx.count != 1 { return false }
            case .other(let t):
                let s = t.trimmingCharacters(in: .whitespacesAndNewlines)
                if s.isEmpty || s.count > 2000 { return false }
            }
        }
        return true
    }
}

// MARK: - session launch

/// A session launch draft (`session.launch`): only a human fills it in. Arguments follow the primitive's argsSchema.
public struct LaunchDraft: Sendable, Hashable {
    public var folder: String = ""
    public var name: String = ""
    public var prompt: String = ""

    public init() {}

    /// The name, as the daemon checks it (`SESSION_NAME_RE`): starts with a letter or digit, followed by letters, digits,
    /// spaces and `. _ ( ) -`, up to 64 characters in total.
    public static func nameProblem(_ name: String) -> String? {
        let n = name.trimmingCharacters(in: .whitespaces)
        if n.isEmpty { return tr("нужно имя", "name required") }
        if n.count > 64 { return tr("не длиннее 64 символов", "64 characters max") }
        let alnum = { (u: Unicode.Scalar) in CharacterSet.letters.contains(u) || CharacterSet.decimalDigits.contains(u) }
        guard let first = n.unicodeScalars.first, alnum(first) else { return tr("начинается с буквы или цифры", "must start with a letter or digit") }
        let ok = n.unicodeScalars.allSatisfy { alnum($0) || " ._()-".unicodeScalars.contains($0) }
        return ok ? nil : tr("только буквы, цифры, пробел и . _ ( ) -", "letters, digits, spaces and . _ ( ) - only")
    }

    public var expandedFolder: String { (folder as NSString).expandingTildeInPath }

    public var folderProblem: String? {
        if folder.isEmpty { return tr("нужна папка", "folder required") }
        if !expandedFolder.hasPrefix("/") { return tr("абсолютный путь или ~/…", "absolute path or ~/…") }
        return nil
    }

    public var isValid: Bool { folderProblem == nil && Self.nameProblem(name) == nil && prompt.count <= 16_000 }

    /// Arguments for `POST /actions/session.launch`.
    public var args: [String: JSONValue] {
        ["cwd": .string(expandedFolder), "name": .string(name.trimmingCharacters(in: .whitespaces)), "prompt": .string(prompt)]
    }
}

// MARK: - plugin manager

/// A plugin permission: `kind` — fsRead | fsWrite | watch | exec | secrets | net | effects | actions.
/// `risk` (contract 3) — a write to a place used to hijack Claude Code or the system: the place kind from the daemon
/// (`claude-code`, `autostart`, `shell`, `bin`, `ssh`, `git`, `hub`; `lib/registry/perms.mjs` writeRisk). The permission
/// is allowed, but the consent sheet shows it as a prominent line with an explanation.
public struct PluginPermission: Decodable, Sendable, Hashable {
    public var kind: String
    public var what: String
    public var why: String?
    public var added: Bool
    public var risk: String?

    public init(kind: String, what: String, why: String? = nil, added: Bool = false, risk: String? = nil) {
        self.kind = kind; self.what = what; self.why = why; self.added = added; self.risk = risk
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "?"
        what = (try? c.decode(String.self, forKey: .what)) ?? ""
        why = try? c.decodeIfPresent(String.self, forKey: .why)
        added = (try? c.decode(Bool.self, forKey: .added)) ?? false
        risk = (try? c.decodeIfPresent(String.self, forKey: .risk)).flatMap { $0.isEmpty ? nil : $0 }
    }

    enum CodingKeys: String, CodingKey { case kind, what, why, added, risk }

    // kindLabel — L10n.swift
}

/// A `GET /registry/catalog` row.
public struct CatalogPlugin: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var version: String
    public var title: String?
    public var desc: String?
    public var author: PluginAuthor?
    public var official: Bool
    public var tier: PluginTier
    public var permissions: [PluginPermission]
    public var installed: String?
    public var updateAvailable: Bool
    public var growth: [PluginPermission]?
    public var blocked: String?
    public var builtin: Bool
    public var platformOk: Bool
    /// Dependencies the plugin declares (`<agenthub.requires>`): "Requires …" with a link; `present` — checked by the daemon.
    public var requires: [PluginRequirement]
    /// An own plugin from a local folder with this id is installed: the catalog doesn't update it.
    public var installedOwn: OwnPath?
    /// Icon from the index (the plugin's `<agenthub.icon>`); nil — neutral.
    public var icon: PluginIcon?
    /// The plugin needs a newer contract than the hub has: "Requires a newer hub", installation unavailable.
    public var needsHub: NeedsHub?

    public struct NeedsHub: Codable, Sendable, Hashable {
        /// nil — the index entry names the contract in a form this hub doesn't understand (also "requires a newer hub").
        public var need: Int?
        public var have: Int
        public init(need: Int?, have: Int) { self.need = need; self.have = have }
    }

    public init(id: String, version: String, title: String? = nil, desc: String? = nil, official: Bool = false,
                permissions: [PluginPermission] = [], installed: String? = nil, updateAvailable: Bool = false,
                requires: [PluginRequirement] = [], installedOwn: OwnPath? = nil) {
        self.id = id; self.version = version; self.title = title; self.desc = desc; self.author = nil; self.official = official
        self.tier = official ? .official : .community
        self.permissions = permissions; self.installed = installed; self.updateAvailable = updateAvailable
        self.growth = nil; self.blocked = nil; self.builtin = false; self.platformOk = true
        self.requires = requires; self.installedOwn = installedOwn; self.icon = nil; self.needsHub = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        version = (try? c.decode(String.self, forKey: .version)) ?? "?"
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        desc = try? c.decodeIfPresent(String.self, forKey: .desc)
        // author — an object {name, github} (an old daemon — github only) or a login string
        author = (try? c.decodeIfPresent(PluginAuthor.self, forKey: .author)).flatMap { $0.isEmpty ? nil : $0 }
        official = (try? c.decode(Bool.self, forKey: .official)) ?? false
        tier = PluginTier(tier: try? c.decodeIfPresent(String.self, forKey: .tier), source: "installed", official: official)
        permissions = (try? c.decode([PluginPermission].self, forKey: .permissions)) ?? []
        installed = try? c.decodeIfPresent(String.self, forKey: .installed)
        updateAvailable = (try? c.decode(Bool.self, forKey: .updateAvailable)) ?? false
        growth = try? c.decodeIfPresent([PluginPermission].self, forKey: .growth)
        // blocked — a reason string, true or null
        if let s = try? c.decodeIfPresent(String.self, forKey: .blocked) { blocked = s }
        else if let b = try? c.decodeIfPresent(Bool.self, forKey: .blocked), b { blocked = "blocklist" }
        else { blocked = nil }
        builtin = (try? c.decode(Bool.self, forKey: .builtin)) ?? false
        platformOk = (try? c.decode(Bool.self, forKey: .platformOk)) ?? true
        // a broken dependency entry doesn't break the card
        let raw = (try? c.decode([JSONValue].self, forKey: .requires)) ?? []
        requires = raw.compactMap { v in (try? JSONEncoder().encode(v)).flatMap { try? JSONDecoder().decode(PluginRequirement.self, from: $0) } }
        installedOwn = try? c.decodeIfPresent(OwnPath.self, forKey: .installedOwn)
        icon = try? c.decodeIfPresent(PluginIcon.self, forKey: .icon)
        needsHub = try? c.decodeIfPresent(NeedsHub.self, forKey: .needsHub)
    }

    enum CodingKeys: String, CodingKey {
        case id, version, title, desc, author, official, tier, permissions, installed, updateAvailable, growth, blocked, builtin, platformOk, requires, installedOwn, icon, needsHub
    }

    public var displayTitle: String { title ?? id }
    /// "Requires a newer hub" (the plugin needs a newer contract than the hub has); nil — compatible.
    public var needsHubText: String? {
        needsHub.map { n in
            guard let need = n.need else {
                return tr("Нужен хаб новее: плагин требует более новый контракт плагинов, а этот хаб понимает \(n.have). Обновите Agent Hub.",
                          "Needs a newer hub: the plugin requires a newer plugin contract, this hub understands \(n.have). Update Agent Hub.")
            }
            return tr("Нужен хаб новее: плагин требует контракт плагинов \(need), а этот хаб понимает \(n.have). Обновите Agent Hub.",
                      "Needs a newer hub: the plugin requires plugin contract \(need), this hub understands \(n.have). Update Agent Hub.")
        }
    }
    /// Dependencies missing on this Mac (per the daemon's check).
    public var missingRequirements: [PluginRequirement] { requires.filter { !$0.present } }
}

/// A catalog plugin's dependency: an external program the plugin is useless without (`<agenthub.requires>`). The hub
/// doesn't know it by name — the plugin itself declares the name, link and check path.
public struct PluginRequirement: Codable, Sendable, Hashable {
    public var name: String
    public var url: String
    public var note: String?
    public var check: String?
    public var present: Bool

    public init(name: String, url: String, note: String? = nil, check: String? = nil, present: Bool) {
        self.name = name; self.url = url; self.note = note; self.check = check; self.present = present
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        url = try c.decode(String.self, forKey: .url)
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        check = try? c.decodeIfPresent(String.self, forKey: .check)
        present = (try? c.decode(Bool.self, forKey: .present)) ?? true
    }

    enum CodingKeys: String, CodingKey { case name, url, note, check, present }

    /// The link is https only (the daemon passes only those; the shell doesn't open anything else).
    public var link: URL? {
        guard let u = URL(string: url), u.scheme == "https" else { return nil }
        return u
    }
}

/// The own plugin's folder path: the real one and the display one (with "~").
public struct OwnPath: Codable, Sendable, Hashable {
    public var path: String?
    public var pathShort: String?
    public init(path: String?, pathShort: String? = nil) { self.path = path; self.pathShort = pathShort }
    public var shown: String { pathShort ?? path ?? "?" }
}

public struct RegistryCatalog: Decodable, Sendable, Hashable {
    public var configured: Bool
    /// What's missing to connect: "index-url", "public-key".
    public var missing: [String]
    public var generatedAt: String?
    public var fetchedAt: String?
    public var error: String?
    public var plugins: [CatalogPlugin]
    /// How to connect the registry: the CLI by full path and the hub directory (the daemon knows where it is; agenthub isn't in PATH).
    public var connect: RegistryConnect?

    public init(configured: Bool = false, plugins: [CatalogPlugin] = [], generatedAt: String? = nil, error: String? = nil) {
        self.configured = configured; self.missing = configured ? [] : ["index-url", "public-key"]
        self.generatedAt = generatedAt; self.fetchedAt = nil; self.error = error; self.plugins = plugins
    }

    /// The catalog signature is verified (the index is loaded and accepted).
    public var verified: Bool { configured && generatedAt != nil && error == nil }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        configured = (try? c.decode(Bool.self, forKey: .configured)) ?? false
        missing = (try? c.decode([String].self, forKey: .missing)) ?? (configured ? [] : ["index-url", "public-key"])
        generatedAt = try? c.decodeIfPresent(String.self, forKey: .generatedAt)
        fetchedAt = try? c.decodeIfPresent(String.self, forKey: .fetchedAt)
        if let s = try? c.decodeIfPresent(String.self, forKey: .error) { error = s }
        else if let o = try? c.decodeIfPresent([String: JSONValue].self, forKey: .error) { error = o["code"]?.stringValue ?? "error" }
        else { error = nil }
        plugins = (try? c.decode([CatalogPlugin].self, forKey: .plugins)) ?? []
        connect = try? c.decodeIfPresent(RegistryConnect.self, forKey: .connect)
    }

    enum CodingKeys: String, CodingKey { case configured, missing, generatedAt, fetchedAt, error, plugins, connect }

    /// The registry connect command, ready for zsh: the CLI by full path, AGENTHUB_HOME if the hub isn't in the default
    /// directory. Placeholders for the URL and key are in the interface language.
    public func connectCommand(url: String, key: String) -> String {
        func q(_ v: String) -> String { v.range(of: #"^[A-Za-z0-9_./:@%+=-]+$"#, options: .regularExpression) != nil ? v : "'" + v.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let cli = connect.map { q($0.cli) } ?? "agenthub"
        let home = connect.flatMap { $0.defaultHome ? nil : "AGENTHUB_HOME=\(q($0.home)) " } ?? ""
        return "\(home)\(cli) install --registry-url \(url) --registry-pubkey \(key) --apply --no-launchd"
    }
}

public struct RegistryConnect: Decodable, Sendable, Hashable {
    public var cli: String
    public var home: String
    public var defaultHome: Bool
}

/// An installed plugin from `GET /registry/installed` (from `plugins.lock` or `Plugins/local`).
public struct InstalledPlugin: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String?
    public var version: String?
    /// Official in the catalog, but a different build is installed: until updated it works as a community plugin.
    public var officialPending: Bool
    public var updateAvailable: Bool
    public var source: String        // installed | local
    public var official: Bool
    public var tier: PluginTier      // official | community | local — from plugins.lock (signed index)
    public var label: String?        // "unverified" for Plugins/local
    public var disabled: String?
    public var permissions: [PluginPermission]
    /// An own plugin: the source folder and its state (nil for registry plugins).
    public var own: OwnSourceInfo?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        own = try? c.decodeIfPresent(OwnSourceInfo.self, forKey: .own)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        officialPending = (try? c.decode(Bool.self, forKey: .officialPending)) ?? false
        updateAvailable = (try? c.decode(Bool.self, forKey: .updateAvailable)) ?? false
        source = (try? c.decode(String.self, forKey: .source)) ?? "installed"
        official = (try? c.decode(Bool.self, forKey: .official)) ?? false
        tier = PluginTier(tier: try? c.decodeIfPresent(String.self, forKey: .tier), source: source, official: official)
        label = try? c.decodeIfPresent(String.self, forKey: .label)
        if let s = try? c.decodeIfPresent(String.self, forKey: .disabled) { disabled = s }
        else if let s = try? c.decodeIfPresent(String.self, forKey: .blocked) { disabled = s }
        else { disabled = nil }
        permissions = (try? c.decode([PluginPermission].self, forKey: .permissions)) ?? []
    }

    enum CodingKeys: String, CodingKey { case id, title, version, officialPending, updateAvailable, source, official, tier, label, disabled, blocked, permissions, own }
}

/// An own plugin's folder (`GET /registry/installed → installed[].own`): where it is and what's going on with it now.
public struct OwnSourceInfo: Decodable, Sendable, Hashable {
    /// ok | update (permissions grew — consent sheet; narrowed or version rollback — via a button) | paused (waiting for the hub
    /// pause to lift) | unverified (the lock entry was made bypassing the hub — works as third-party) | missing | broken | unknown
    public var status: String
    public var path: String?
    public var pathShort: String?
    public var error: String?
    public var errors: [String]
    public var checkedAt: String?
    public var fingerprint: String?
    /// Permissions the folder's new contents ask for (status == update).
    public var growth: [PluginPermission]
    public var nextVersion: String?
    /// The folder has a version older than the installed one (status == update): installed only via the button.
    public var downgrade: Bool
    /// `own:hub-too-old`: which contract the plugin in the folder needs and which one the hub understands.
    public var need: Int?
    public var have: Int?

    public init(status: String, path: String? = nil, pathShort: String? = nil, error: String? = nil, errors: [String] = [], growth: [PluginPermission] = [], nextVersion: String? = nil, downgrade: Bool = false) {
        self.status = status; self.path = path; self.pathShort = pathShort; self.error = error; self.errors = errors
        self.checkedAt = nil; self.fingerprint = nil; self.growth = growth; self.nextVersion = nextVersion; self.downgrade = downgrade
        self.need = nil; self.have = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = (try? c.decode(String.self, forKey: .status)) ?? "unknown"
        path = try? c.decodeIfPresent(String.self, forKey: .path)
        pathShort = try? c.decodeIfPresent(String.self, forKey: .pathShort)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        errors = (try? c.decode([String].self, forKey: .errors)) ?? []
        checkedAt = try? c.decodeIfPresent(String.self, forKey: .checkedAt)
        fingerprint = try? c.decodeIfPresent(String.self, forKey: .fingerprint)
        growth = (try? c.decode([PluginPermission].self, forKey: .growth)) ?? []
        struct Next: Decodable { var version: String? }
        nextVersion = (try? c.decodeIfPresent(Next.self, forKey: .next))??.version
        downgrade = (try? c.decode(Bool.self, forKey: .downgrade)) ?? false
        need = try? c.decodeIfPresent(Int.self, forKey: .need)
        have = try? c.decodeIfPresent(Int.self, forKey: .have)
    }

    enum CodingKeys: String, CodingKey { case status, path, pathShort, error, errors, checkedAt, fingerprint, growth, next, downgrade, need, have }

    public var shownPath: String { pathShort ?? path ?? "?" }
}

/// A request to install an own plugin from a folder (`GET /registry/installed → requests`, `POST /registry/own/request`):
/// any local process can create one, but only a human here can install it, through the consent sheet.
public struct OwnRequest: Codable, Sendable, Hashable, Identifiable {
    public var requestId: String
    public var id: String
    public var title: String?
    public var version: String?
    public var path: String?
    public var pathShort: String?
    public var fingerprint: String?
    public var permissions: Int?
    public var update: Bool
    public var migrate: PluginMigration?
    public var createdAt: String?
    /// Icon from the folder's metadata (`<agenthub.icon>`); nil — neutral.
    public var icon: PluginIcon?

    public init(requestId: String, id: String, title: String? = nil, version: String? = nil, pathShort: String? = nil, migrate: PluginMigration? = nil) {
        self.requestId = requestId; self.id = id; self.title = title; self.version = version; self.path = nil; self.pathShort = pathShort
        self.fingerprint = nil; self.permissions = nil; self.update = false; self.migrate = migrate; self.createdAt = nil; self.icon = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        id = try c.decode(String.self, forKey: .id)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        path = try? c.decodeIfPresent(String.self, forKey: .path)
        pathShort = try? c.decodeIfPresent(String.self, forKey: .pathShort)
        fingerprint = try? c.decodeIfPresent(String.self, forKey: .fingerprint)
        permissions = try? c.decodeIfPresent(Int.self, forKey: .permissions)
        update = (try? c.decode(Bool.self, forKey: .update)) ?? false
        migrate = try? c.decodeIfPresent(PluginMigration.self, forKey: .migrate)
        createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
        icon = try? c.decodeIfPresent(PluginIcon.self, forKey: .icon)
    }

    enum CodingKeys: String, CodingKey { case requestId, id, title, version, path, pathShort, fingerprint, permissions, update, migrate, createdAt, icon }

    public var displayTitle: String { title ?? id }
    public var shownPath: String { pathShort ?? path ?? "?" }
}

/// A plugin migration on install: the same id is already installed from the registry (official/community) or from another own folder
/// (own), or an own plugin takes a catalog plugin's id (catalog) — the consent sheet says so plainly.
public struct PluginMigration: Codable, Sendable, Hashable {
    /// official | community | own — what's installed now; catalog — not installed, but the id matches a catalog plugin.
    public var from: String
    public var version: String?
    public var path: String?
    public var pathShort: String?
    /// from == catalog: the catalog plugin's tier and name.
    public var tier: String?
    public var title: String?
    public init(from: String, version: String? = nil, pathShort: String? = nil, tier: String? = nil, title: String? = nil) {
        self.from = from; self.version = version; self.path = nil; self.pathShort = pathShort; self.tier = tier; self.title = title
    }
}

/// `ownPlugins` in `/state`: requests awaiting confirmation and own plugins with a folder problem.
public struct OwnPluginsInfo: Codable, Sendable, Hashable {
    public struct Problem: Codable, Sendable, Hashable {
        public var id: String
        public var title: String?
        public var status: String
        public var error: String?
    }
    public var requests: [OwnRequest]
    public var problems: [Problem]

    public init(requests: [OwnRequest] = [], problems: [Problem] = []) { self.requests = requests; self.problems = problems }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let raw = (try? c.decode([JSONValue].self, forKey: .requests)) ?? []
        requests = raw.compactMap { v in (try? JSONEncoder().encode(v)).flatMap { try? JSONDecoder().decode(OwnRequest.self, from: $0) } }
        problems = (try? c.decode([Problem].self, forKey: .problems)) ?? []
    }

    enum CodingKeys: String, CodingKey { case requests, problems }
}

/// The source in the consent sheet: the registry (signature and sha256 verified) or an own folder (path, fingerprint, who writes to it).
public struct ConsentSource: Decodable, Sendable, Hashable {
    public var kind: String
    public var path: String?
    public var pathShort: String?
    public var fingerprint: String?
    /// Only the owner — you — writes to the folder (otherwise the request can't be accepted).
    public var writableMine: Bool
    public var warnings: [String]

    public init(kind: String, path: String? = nil, pathShort: String? = nil, fingerprint: String? = nil, writableMine: Bool = true, warnings: [String] = []) {
        self.kind = kind; self.path = path; self.pathShort = pathShort; self.fingerprint = fingerprint; self.writableMine = writableMine; self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = (try? c.decode(String.self, forKey: .kind)) ?? "registry"
        path = try? c.decodeIfPresent(String.self, forKey: .path)
        pathShort = try? c.decodeIfPresent(String.self, forKey: .pathShort)
        fingerprint = try? c.decodeIfPresent(String.self, forKey: .fingerprint)
        struct W: Decodable { var mine: Bool? }
        writableMine = ((try? c.decodeIfPresent(W.self, forKey: .writable))??.mine) ?? true
        warnings = (try? c.decode([String].self, forKey: .warnings)) ?? []
    }

    enum CodingKeys: String, CodingKey { case kind, path, pathShort, fingerprint, writable, warnings }

    public var isOwn: Bool { kind == "own" }
    public var shownPath: String { pathShort ?? path ?? "?" }
}

public struct RegistryInstalled: Decodable, Sendable {
    public var installed: [InstalledPlugin]
    public var local: [InstalledPlugin]
    /// Requests for own plugins from folders awaiting confirmation (older daemon — empty).
    public var requests: [OwnRequest]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        installed = (try? c.decode([InstalledPlugin].self, forKey: .installed)) ?? []
        local = (try? c.decode([InstalledPlugin].self, forKey: .local)) ?? []
        requests = (try? c.decode([OwnRequest].self, forKey: .requests)) ?? []
    }

    enum CodingKeys: String, CodingKey { case installed, local, requests }
}

/// The permissions sheet (`428 consent-required` from `POST /registry/install`): the daemon decides on consent,
/// the token is single-use, lives 120 s and is bound to the application's pid.
public struct ConsentRequest: Decodable, Sendable, Hashable {
    public var token: String
    public var id: String
    public var title: String?
    public var version: String?
    public var fromVersion: String?
    public var update: Bool
    public var tier: PluginTier
    public var permissions: [PluginPermission]
    public var expiresInMs: Int?
    /// Where it's installed from: the registry or an own folder (path, fingerprint). Older daemon — nil (meaning the registry).
    public var source: ConsentSource?
    /// Migration: the same id is already installed from another source.
    public var migrate: PluginMigration?
    /// The folder contents changed after the request: the sheet shows what's being installed now.
    public var changedSinceRequest: Bool
    public var requestId: String?
    /// Icon from the metadata of the plugin being installed (`<agenthub.icon>`); nil — neutral.
    public var icon: PluginIcon?

    public init(token: String, id: String, title: String? = nil, version: String? = nil, update: Bool = false, tier: PluginTier = .community,
                permissions: [PluginPermission] = [], source: ConsentSource? = nil, migrate: PluginMigration? = nil, changedSinceRequest: Bool = false) {
        self.token = token; self.id = id; self.title = title; self.version = version; self.fromVersion = nil; self.update = update
        self.tier = tier; self.permissions = permissions; self.expiresInMs = nil; self.source = source; self.migrate = migrate
        self.changedSinceRequest = changedSinceRequest; self.requestId = nil; self.icon = nil
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        icon = try? c.decodeIfPresent(PluginIcon.self, forKey: .icon)
        source = try? c.decodeIfPresent(ConsentSource.self, forKey: .source)
        migrate = try? c.decodeIfPresent(PluginMigration.self, forKey: .migrate)
        changedSinceRequest = (try? c.decode(Bool.self, forKey: .changedSinceRequest)) ?? false
        requestId = try? c.decodeIfPresent(String.self, forKey: .requestId)
        id = try c.decode(String.self, forKey: .id)
        title = try? c.decodeIfPresent(String.self, forKey: .title)
        version = try? c.decodeIfPresent(String.self, forKey: .version)
        fromVersion = try? c.decodeIfPresent(String.self, forKey: .fromVersion)
        update = (try? c.decode(Bool.self, forKey: .update)) ?? false
        tier = PluginTier(tier: try? c.decodeIfPresent(String.self, forKey: .tier), source: "installed", official: false)
        permissions = (try? c.decode([PluginPermission].self, forKey: .permissions)) ?? []
        expiresInMs = try? c.decodeIfPresent(Int.self, forKey: .expiresInMs)
    }

    enum CodingKeys: String, CodingKey { case token, id, title, version, fromVersion, update, tier, permissions, expiresInMs, source, migrate, changedSinceRequest, requestId, icon }

    public var isOwn: Bool { source?.isOwn == true || tier == .own }

    /// New permissions are computed only on update: on first install everything is "new", nothing to mark.
    public var addedCount: Int { update ? permissions.filter(\.added).count : 0 }
}

/// The result of `POST /registry/own/request` (a request for an own plugin from a folder).
public enum OwnRequestOutcome: Sendable {
    case pending(OwnRequest)
    /// The same folder with the same contents is already installed.
    case already(id: String)
    /// errors — check reasons (own:lint), as with the registry linter.
    case denied(status: Int, code: String, errors: [String])
}

/// The result of `POST /registry/install`.
public enum InstallOutcome: Sendable {
    case installed(version: String?, update: Bool)
    case needsConsent(ConsentRequest)
    case denied(status: Int, code: String)
}

// MARK: - notifications

/// `push.notify` from SSE: show a macOS banner and reply `POST /push/ack`.
public struct PushNotify: Decodable, Sendable, Hashable {
    public var notifyId: String
    public var title: String
    public var subtitle: String?
    public var body: String?
    public var plugin: String?
    public var key: String?
    public var digest: Bool

    public init(notifyId: String, title: String, subtitle: String? = nil, body: String? = nil, plugin: String? = nil) {
        self.notifyId = notifyId; self.title = title; self.subtitle = subtitle; self.body = body; self.plugin = plugin
        self.key = nil; self.digest = false
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        notifyId = try c.decode(String.self, forKey: .notifyId)
        title = (try? c.decode(String.self, forKey: .title)) ?? "Agent Hub"
        subtitle = try? c.decodeIfPresent(String.self, forKey: .subtitle)
        body = try? c.decodeIfPresent(String.self, forKey: .body)
        plugin = try? c.decodeIfPresent(String.self, forKey: .plugin)
        key = try? c.decodeIfPresent(String.self, forKey: .key)
        digest = (try? c.decode(Bool.self, forKey: .digest)) ?? false
    }

    enum CodingKeys: String, CodingKey { case notifyId, title, subtitle, body, plugin, key, digest }
}

func parseISODate(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}
