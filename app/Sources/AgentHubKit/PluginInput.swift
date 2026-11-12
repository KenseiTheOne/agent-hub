import CryptoKit
import Foundation

// Contract 3 additions the app renders (core gaps, 2026-11-12): typed input for actions (G1), background jobs (G6),
// plugin keys entered in the app (G8) and the client-side countdown `until=` (G18).

// MARK: - typed input (G1)

/// What the app asks the human to type: an action with `input` — immediate (the field alone) or inside the core's
/// confirmation (`confirm` is the 428 the field belongs to). `error` — why the previous text was refused.
public struct InputPrompt: Sendable {
    public var actionLabel: String
    public var input: OfferInput
    public var confirm: ConfirmRequest?
    public var text: String
    public var error: String?

    public init(actionLabel: String, input: OfferInput, confirm: ConfirmRequest? = nil, text: String = "", error: String? = nil) {
        self.actionLabel = actionLabel; self.input = input; self.confirm = confirm; self.text = text; self.error = error
    }
}

/// The checks the core makes on typed text (`400 input:*`), done in the app first so the human sees the reason under the
/// field. The plugin's pattern is not checked here (it is a JavaScript pattern; the core checks it and its refusal comes
/// back readable). Length is counted in Unicode code points, like the core (`[...value].length`), not in graphemes:
/// "👍🏽" is one character on screen but two code points, and the core refuses by code points.
public enum InputCheck {
    /// The text length the core counts: Unicode code points.
    public static func length(_ text: String) -> Int { text.unicodeScalars.count }

    /// nil — the text may be sent; otherwise the core code it would get (`input:required`, …).
    public static func code(_ text: String, maxLength: Int) -> String? {
        if text.isEmpty { return "input:required" }
        if length(text) > maxLength { return "input:too-long" }
        for u in text.unicodeScalars {
            switch u.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: return "input:control"
            default: continue
            }
        }
        if text.hasPrefix("-") { return "input:option-like" }
        return nil
    }

    /// The human-readable reason for a check code (also for the core's `400 input:*`).
    public static func message(_ code: String, maxLength: Int? = nil) -> String {
        switch code {
        case "input:required": return tr("Введите текст.", "Type some text.")
        case "input:too-long":
            if let m = maxLength { return tr("Слишком длинно: не больше \(m) символов.", "Too long: at most \(m) characters.") }
            return tr("Слишком длинный текст.", "The text is too long.")
        case "input:control": return tr("Только одна строка: без переносов и управляющих символов.", "One line only: no line breaks or control characters.")
        case "input:option-like": return tr("Текст не может начинаться с «-».", "The text can't start with \"-\".")
        case "input:pattern": return tr("Плагин не принимает такой текст — проверьте формат.", "The plugin doesn't accept this text — check the format.")
        default: return tr("Хаб не принял текст.", "The hub didn't accept the text.")
        }
    }

    /// The character counter under a field: shown only near the limit.
    public static func counter(_ text: String, maxLength: Int) -> String? {
        let n = length(text)
        return n * 5 >= maxLength * 4 ? "\(n)/\(maxLength)" : nil
    }
}

extension ConfirmPresenter {
    /// Ask for typed text (immediate input actions and the confirmation sheet with a field). nil — the human cancelled.
    /// The default asks nothing: a presenter without a field cannot run input actions.
    public func prompt(_ request: InputPrompt) async -> String? { nil }
}

// MARK: - countdown (G18 `until=`)

public enum Countdown {
    /// The remaining time as `mm:ss`, from an hour on `h:mm:ss`; past the moment — `00:00`.
    public static func text(until: Date, now: Date = Date()) -> String {
        let s = max(0, Int(until.timeIntervalSince(now).rounded(.up)))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%02d:%02d", m, sec)
    }
}

// MARK: - jobs (G6)

public enum JobsText {
    /// The elapsed time of a running job: `42 s`, `3:05`, `1:02:03`.
    public static func elapsed(since start: Date?, now: Date = Date()) -> String {
        guard let start else { return "" }
        let s = max(0, Int(now.timeIntervalSince(start)))
        if s < 60 { return tr("\(s) с", "\(s) s") }
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    public static var header: String { tr("Работает в фоне", "Running in the background") }
    public static var stop: String { tr("Остановить", "Stop") }
    public static var backgroundHelp: String {
        tr("Запустит фоновую задачу: она продолжит работать после нажатия, её видно на странице плагина в «Работает в фоне».",
           "Starts a background job: it keeps running after the click; see \"Running in the background\" on the plugin page.")
    }
}

// MARK: - plugin keys (G8)

/// `GET /secrets/:plugin`: the plugin's declared keys in declaration order, never values. The daemon lists at most 32;
/// `more` — how many declared keys it left out (0 when it listed all, or an older daemon).
public struct SecretsList: Decodable, Sendable, Hashable {
    public var plugin: String
    public var keychain: Bool
    public var secrets: [PluginSecret]
    public var more: Int

    public init(plugin: String, keychain: Bool = true, secrets: [PluginSecret], more: Int = 0) {
        self.plugin = plugin; self.keychain = keychain; self.secrets = secrets; self.more = max(0, more)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        plugin = (try? c.decode(String.self, forKey: .plugin)) ?? ""
        keychain = (try? c.decode(Bool.self, forKey: .keychain)) ?? true
        secrets = c.lossyList(PluginSecret.self, forKey: .secrets) ?? []
        more = max(0, ((try? c.decodeIfPresent(Int.self, forKey: .more)) ?? nil) ?? 0)
    }

    enum CodingKeys: String, CodingKey { case plugin, keychain, secrets, more }

    /// The line under the listed keys when the daemon left some out; nil — it listed them all.
    public var moreText: String? { more > 0 ? tr("и ещё \(more)", "and \(more) more") : nil }
}

public struct PluginSecret: Codable, Sendable, Hashable, Identifiable {
    public enum State: String, Codable, Sendable {
        case set, unset, denied, error, unavailable, unknown
    }

    public var key: String
    public var why: String?
    public var env: String?
    public var state: State
    public var editable: Bool
    public var reason: String?
    public var error: String?
    public var id: String { key }

    public init(key: String, why: String? = nil, env: String? = nil, state: State, editable: Bool, reason: String? = nil, error: String? = nil) {
        self.key = key; self.why = why; self.env = env; self.state = state; self.editable = editable; self.reason = reason; self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        why = try? c.decodeIfPresent(String.self, forKey: .why)
        env = try? c.decodeIfPresent(String.self, forKey: .env)
        state = ((try? c.decodeIfPresent(String.self, forKey: .state)) ?? nil).flatMap(State.init(rawValue:)) ?? .unknown
        editable = (try? c.decodeIfPresent(Bool.self, forKey: .editable)) ?? false
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
    }

    enum CodingKeys: String, CodingKey { case key, why, env, state, editable, reason, error }

    /// The state in words (the badge on the row).
    public var stateText: String {
        switch state {
        case .set: return tr("задан", "set")
        case .unset: return tr("не задан", "not set")
        case .denied: return tr("недоступен", "not allowed")
        case .error: return tr("связка ключей не ответила", "keychain didn't answer")
        case .unavailable: return tr("нет связки ключей", "no keychain")
        case .unknown: return "?"
        }
    }

    /// Why the key can't be entered here (`denied` reasons); nil — nothing to explain.
    public var deniedText: String? {
        guard state == .denied else { return nil }
        switch reason {
        case "reserved": return tr("Этот ключ зарезервирован хабом.", "This key is reserved by the hub.")
        case "foreign-namespace": return tr("Ключ из чужого пространства имён: плагин его не получит.", "A key from another namespace: the plugin won't receive it.")
        case "untrusted": return tr("Плагины из Plugins/local ключей не получают.", "Plugins from Plugins/local don't receive keys.")
        default: return tr("Неверное имя ключа.", "Invalid key name.")
        }
    }
}

/// The value restrictions of `PUT /secrets/:plugin/:key` (the value goes through `security -i`, which splits its line on
/// whitespace and parses quotes): printable ASCII without spaces, quotes and backslashes, 1…3072 characters.
public enum SecretValue {
    public static let maxLength = 3072

    /// nil — the value can be saved; otherwise the reason, in words.
    public static func problem(_ value: String) -> String? {
        if value.isEmpty { return tr("Вставьте значение ключа.", "Paste the key value.") }
        if value.count > maxLength { return tr("Слишком длинно: не больше \(maxLength) символов.", "Too long: at most \(maxLength) characters.") }
        for u in value.unicodeScalars where !(0x21...0x7E).contains(u.value) || u == "\"" || u == "'" || u == "\\" {
            if u == " " || u == "\t" || u == "\n" || u == "\r" {
                return tr("Без пробелов и переносов строк — проверьте, что вставили только ключ.", "No spaces or line breaks — check that you pasted just the key.")
            }
            return tr("Только печатные символы ASCII, без кавычек и «\\». Такой ключ задайте в Терминале: security add-generic-password.",
                      "Printable ASCII only, without quotes or \"\\\". Set such a key in Terminal: security add-generic-password.")
        }
        return nil
    }

    /// The restriction shown under the field before anything is typed.
    public static var hint: String {
        tr("Печатные символы ASCII без пробелов, кавычек и «\\», до \(maxLength) символов. Значение уходит прямо в связку ключей macOS — хаб его не показывает и не пишет в журнал.",
           "Printable ASCII without spaces, quotes or \"\\\", up to \(maxLength) characters. The value goes straight to the macOS keychain — the hub never shows or logs it.")
    }
}

// MARK: - banner buttons (G5)

/// Notification categories for banners with plugin buttons: macOS attaches buttons through a category, so each distinct
/// set of buttons (titles and levels) gets its own category id; banners without buttons keep the plain "Open" one.
public enum NotifyCategory {
    public static let plain = "agenthub.event"
    /// Action ids of the plugin buttons: `agenthub.act.<index>` into `userInfo["actions"]`.
    public static let actionPrefix = "agenthub.act."

    public static func identifier(for actions: [NotifyAction]) -> String {
        guard !actions.isEmpty else { return plain }
        // SHA-256 (first 128 bits): stable across launches (Swift's Hasher is seeded per process) and, unlike a 64-bit
        // FNV-1a, not collidable by a plugin choosing labels; `Registry` still verifies the stored set on a hit
        let digest = SHA256.hash(data: Data(canonicalKey(actions).utf8))
        return plain + ".a." + digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    /// What makes two button sets the same category: titles and levels in order (offer ids live in `userInfo`).
    public static func canonicalKey(_ actions: [NotifyAction]) -> String {
        actions.map { "\($0.level.rawValue)\u{1f}\($0.label)" }.joined(separator: "\u{1e}")
    }

    /// The button sets registered as categories, oldest first, at most `limit` (banners still on screen keep working, the
    /// registration stays small). A hit on an id whose stored set differs (a collision) replaces the stored set, so the
    /// category is re-registered with the buttons of this banner instead of showing another set's titles.
    public struct Registry: Sendable {
        public private(set) var sets: [(id: String, actions: [NotifyAction])] = []
        public let limit: Int
        private let identify: @Sendable ([NotifyAction]) -> String

        public init(limit: Int, identify: @escaping @Sendable ([NotifyAction]) -> String = NotifyCategory.identifier(for:)) {
            self.limit = max(1, limit); self.identify = identify
        }

        /// The category id for this set; `changed` — the registration changed and the categories must be set again.
        public mutating func register(_ actions: [NotifyAction]) -> (id: String, changed: Bool) {
            let id = identify(actions)
            guard !actions.isEmpty else { return (id, false) }
            let key = NotifyCategory.canonicalKey(actions)
            if let i = sets.firstIndex(where: { $0.id == id }) {
                if NotifyCategory.canonicalKey(sets[i].actions) == key { return (id, false) }
                sets.remove(at: i)
            }
            sets.append((id, actions))
            if sets.count > limit { sets.removeFirst(sets.count - limit) }
            return (id, true)
        }
    }

    /// The button list as `userInfo` (plist types only).
    public static func userInfo(_ actions: [NotifyAction]) -> [[String: String]] {
        actions.map { ["offer": $0.offer, "label": $0.label, "level": $0.level.rawValue] }
    }

    /// The button pressed (`agenthub.act.<i>`) back from `userInfo`; nil — not a plugin button.
    public static func action(id: String, userInfo: [AnyHashable: Any]) -> NotifyAction? {
        guard id.hasPrefix(actionPrefix), let i = Int(id.dropFirst(actionPrefix.count)),
              let list = userInfo["actions"] as? [[String: String]], i >= 0, i < list.count,
              let offer = list[i]["offer"], let label = list[i]["label"] else { return nil }
        return NotifyAction(offer: offer, label: label, level: ActionLevel(rawValue: list[i]["level"] ?? "") ?? .unknown)
    }
}

/// One list element decoded leniently: a broken element becomes nil instead of failing the whole list
/// (`[T?]` alone does not do that — Optional decoding only accepts `null`).
struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
    /// A list whose broken elements are skipped; a missing or non-list value — nil.
    func lossyList<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        ((try? decodeIfPresent([Lossy<T>].self, forKey: key)) ?? nil)?.compactMap(\.value)
    }
}
