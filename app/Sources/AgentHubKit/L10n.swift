import Foundation
import Observation

// UI language (UI pass 2026-11-05). The table is compiled into the code: a String Catalog (.xcstrings) does not build
// without Xcode (Command Line Tools only), and Bundle lookup follows the macOS language, not the hub setting.
//
// The language setting lives in the daemon (<home>/settings.json, PUT /settings/lang, app class only); the app
// gets the effective language in /state.lang and the settings.changed event. Before and without a daemon connection it uses the last
// effective language of this hub (UserDefaults, keyed by socket, so a test directory has its own), and if there was none yet,
// "system" by the daemon's rule: ru if the first macOS language is Russian, otherwise en. Otherwise a Russian hub would
// speak English while the connection is down (and in the first seconds of launch, and during an update restart).
//
// `tr("…", "…")` reads `L10n.shared.lang`, an @Observable property, so SwiftUI redraws the views where the
// string was read right after a language change: no app restart is needed.

public enum Lang: String, Sendable, Codable, CaseIterable {
    case ru, en

    /// The first macOS language: ru… → ru, otherwise en (like the daemon's `detectSystemLang`).
    public static var system: Lang {
        let first = Locale.preferredLanguages.first?.lowercased() ?? ""
        return first == "ru" || first.hasPrefix("ru-") || first.hasPrefix("ru_") ? .ru : .en
    }
}

public enum LangSetting: String, Sendable, Codable, CaseIterable {
    case system, ru, en
}

/// A language of its own for one task tree (re-review 62): inside `L10n.$scope.withValue(LangScope(.en)) { … }` the shared
/// language (`L10n.shared.lang`, so `tr`, `plural`, `locale`) and the language setting (`setting`, `settingKnown`) are read
/// from and written to this box, not the app-wide values. Tests run each case in its own scope (the `.hubLang` trait), so
/// parallel suites can neither see nor break another suite's language or setting, and the macOS language does not matter.
/// The app never sets a scope.
public final class LangScope: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Lang
    private var settingValue: LangSetting = .system
    private var settingKnownValue = false
    public init(_ lang: Lang) { value = lang }
    public var lang: Lang {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }
    public var setting: LangSetting {
        get { lock.lock(); defer { lock.unlock() }; return settingValue }
        set { lock.lock(); settingValue = newValue; lock.unlock() }
    }
    public var settingKnown: Bool {
        get { lock.lock(); defer { lock.unlock() }; return settingKnownValue }
        set { lock.lock(); settingKnownValue = newValue; lock.unlock() }
    }
}

@Observable
public final class L10n: @unchecked Sendable {
    public static let shared = L10n()

    /// The task tree's own language box (tests); nil — the app-wide language.
    @TaskLocal public static var scope: LangScope?

    private var appLang: Lang = Lang.system
    /// The effective language: the app-wide value, or the task's scope for `shared` (see `LangScope`).
    public var lang: Lang {
        get {
            if let s = L10n.scope, self === L10n.shared { return s.lang }
            return appLang
        }
        set {
            if let s = L10n.scope, self === L10n.shared { s.lang = newValue } else { appLang = newValue }
        }
    }
    private var appSetting: LangSetting = .system
    private var appSettingKnown = false
    /// The language setting (system, Russian, English): the app-wide value, or the task's scope for `shared`, like `lang`.
    public var setting: LangSetting {
        get {
            if let s = L10n.scope, self === L10n.shared { return s.setting }
            return appSetting
        }
        set {
            if let s = L10n.scope, self === L10n.shared { s.setting = newValue } else { appSetting = newValue }
        }
    }
    /// The language setting is known: it came from the daemon or was remembered for this hub. If not, "Language" in Settings has no
    /// selected segment rather than an invented "System". Scoped like `setting`.
    public private(set) var settingKnown: Bool {
        get {
            if let s = L10n.scope, self === L10n.shared { return s.settingKnown }
            return appSettingKnown
        }
        set {
            if let s = L10n.scope, self === L10n.shared { s.settingKnown = newValue } else { appSettingKnown = newValue }
        }
    }

    public var locale: Locale { Locale(identifier: lang == .en ? "en_US" : "ru_RU") }

    /// Where to remember the last effective language; nil means do not remember (tests, previews).
    @ObservationIgnored private var memory: (defaults: UserDefaults, key: String)?

    public init() {}

    /// Language memory key for the hub on this socket.
    public static func memoryKey(socketPath: String) -> String { "hubLang:" + socketPath }

    /// Memory key for the language setting (system, Russian, English) for the hub on this socket.
    public static func settingMemoryKey(socketPath: String) -> String { "hubLangSetting:" + socketPath }

    /// Remember the hub language on this socket and immediately take the remembered one (before the first daemon snapshot).
    public func remember(in defaults: UserDefaults = .standard, socketPath: String) {
        let key = Self.memoryKey(socketPath: socketPath)
        memory = (defaults, key)
        settingMemory = (defaults, Self.settingMemoryKey(socketPath: socketPath))
        if let e = defaults.string(forKey: key).flatMap(Lang.init(rawValue:)), e != lang { lang = e }
        if let s = defaults.string(forKey: Self.settingMemoryKey(socketPath: socketPath)).flatMap(LangSetting.init(rawValue:)) {
            if s != setting { setting = s }
            settingKnown = true
        }
    }

    @ObservationIgnored private var settingMemory: (defaults: UserDefaults, key: String)?

    /// Daemon response: the setting and the effective language.
    public func apply(setting: String?, effective: String?) {
        if let s = setting.flatMap(LangSetting.init(rawValue:)) {
            if s != self.setting { self.setting = s }
            if !settingKnown { settingKnown = true }
            if let m = settingMemory, m.defaults.string(forKey: m.key) != s.rawValue { m.defaults.set(s.rawValue, forKey: m.key) }
        }
        if let e = effective.flatMap(Lang.init(rawValue:)) {
            if e != lang { lang = e }
            if let m = memory, m.defaults.string(forKey: m.key) != e.rawValue { m.defaults.set(e.rawValue, forKey: m.key) }
        }
    }
}

/// A string in the effective language.
public func tr(_ ru: String, _ en: String) -> String {
    L10n.shared.lang == .en ? en : ru
}

/// Russian plural forms: 1 сессия, 2 сессии, 5 сессий.
public func pluralRu(_ n: Int, _ one: String, _ few: String, _ many: String) -> String {
    let a = abs(n) % 100, b = a % 10
    if a > 10 && a < 20 { return many }
    if b == 1 { return one }
    if b >= 2 && b <= 4 { return few }
    return many
}

public func plural(_ n: Int, ru: (String, String, String), en: (String, String)) -> String {
    L10n.shared.lang == .en ? (n == 1 ? en.0 : en.1) : pluralRu(n, ru.0, ru.1, ru.2)
}

// MARK: - statuses

extension HubStatus {
    /// The shared table, for when a plugin has no labels of its own (<agenthub.status>).
    public var label: String {
        switch self {
        case .ok: return tr("Всё в порядке", "All good")
        case .unknown: return tr("Нет данных", "No data")
        case .wait: return tr("Нужно внимание", "Needs attention")
        case .block: return tr("Мешает работе", "Blocking")
        case .error: return tr("Сбой", "Failure")
        }
    }

    public var hint: String {
        switch self {
        case .ok: return tr("Плагин в порядке, делать ничего не нужно", "The plugin is fine, nothing to do")
        case .unknown: return tr("Плагин пока ничего не сообщил или его источник не читается", "The plugin hasn't reported yet or can't read its source")
        case .wait: return tr("Стоит посмотреть: что-то ждёт вас или скоро станет проблемой", "Worth a look: something needs you or will soon be a problem")
        case .block: return tr("Что-то мешает работе — без вас не решится", "Something is in the way — it won't resolve without you")
        case .error: return tr("Плагин упал или вернул ошибку", "The plugin crashed or returned an error")
        }
    }
}

/// A plugin's own status label from its metadata.
public struct StatusLabel: Codable, Sendable, Hashable {
    public var label: String
    public var hint: String?
}

extension PluginState {
    /// Status label: the plugin's own (in the hub language, translated by the core), otherwise the shared one.
    public func statusLabel(_ s: HubStatus? = nil) -> String {
        let st = s ?? status
        return statusLabels[st.rawValue]?.label ?? st.label
    }

    public func statusHint(_ s: HubStatus? = nil) -> String {
        let st = s ?? status
        return statusLabels[st.rawValue]?.hint ?? st.hint
    }

    /// "Build will not start: disk busy…" → ("Build will not start", "disk busy…"). A colon inside quotes
    /// ("demo: morning summary", "a: b") is part of the name, not a separator. No separator → nil.
    public static func splitHeadline(_ h: String) -> (String, String)? {
        var depth = 0
        var inStraight = false
        var i = h.startIndex
        while i < h.endIndex {
            let c = h[i]
            switch c {
            case "«", "“", "„": depth += 1
            case "»", "”": depth = max(0, depth - 1)
            case "\"": inStraight.toggle()
            case ":":
                let next = h.index(after: i)
                if depth == 0, !inStraight, next < h.endIndex, h[next] == " " {
                    let head = String(h[..<i]).trimmingCharacters(in: .whitespaces)
                    let tail = String(h[h.index(after: next)...]).trimmingCharacters(in: .whitespaces)
                    return head.isEmpty || tail.isEmpty ? nil : (head, tail)
                }
            default: break
            }
            i = h.index(after: i)
        }
        return nil
    }

    /// A blocker row in the popover's "Waiting for you": "Build will not start: disk busy…" → title and subtitle. Without a colon
    /// the plugin's header itself is the title (it holds the gist: "Task 'demo: morning summary' failed"), and the subtitle is the plugin and
    /// the status label; the plugin's generic label ("Task failed or the service is not responding") as the title would push out the gist.
    public var attentionLines: (title: String, sub: String) {
        if let pair = Self.splitHeadline(headline) { return pair }
        let label = statusLabel()
        let head = headline.trimmingCharacters(in: .whitespaces)
        if head.isEmpty || head == title { return (label, title) }
        return (head, "\(title) · \(label)")
    }

    /// Popover tile caption: the header parameter `tileLabel=` (a short plugin name: "Agents" instead of "Background agents";
    /// the tile holds one line of ~110 pt), otherwise the plugin title.
    public var tileLabel: String {
        if let t = header.first(where: { !$0.separator })?.params["tileLabel"]?.trimmingCharacters(in: .whitespaces), !t.isEmpty { return t }
        return title
    }

    /// A short value for the popover tile: the header parameter `tile=` (the plugin writes it), otherwise "—".
    public var tileValue: String {
        if let t = header.first(where: { !$0.separator })?.params["tile"], !t.isEmpty { return t }
        switch status {
        case .ok: return "✓"
        case .error, .block: return "!"
        default: return "—"
        }
    }
}

extension PluginTier {
    public var label: String {
        switch self {
        case .builtin: return tr("встроенный", "built-in")
        case .official: return tr("официальный", "official")
        case .own: return tr("свой", "own")
        case .community: return tr("сообщество", "community")
        case .local: return tr("локальный", "local")
        }
    }
}

// MARK: - own plugins from folders

extension OwnSourceInfo {
    /// The line under an own plugin in the installed list; nil if the folder is fine.
    public var statusText: String? {
        switch status {
        case "ok", "unknown": return nil
        case "update":
            let v = nextVersion.map { " \($0)" } ?? ""
            if downgrade {
                return tr("В папке версия\(v) старше установленной — поставлю по кнопке «Обновить»", "The folder has an older version\(v) — it installs when you press Update")
            }
            if growth.isEmpty {
                return tr("В папке новая версия\(v) с другим набором прав — поставлю по кнопке «Обновить»", "The folder has a new version\(v) with a different set of permissions — it installs when you press Update")
            }
            return tr("В папке новая версия\(v) — она просит больше прав: обновится после вашего согласия",
                      "The folder has a new version\(v) — it asks for more permissions: it updates once you agree")
        case "unverified":
            return tr("Запись о плагине сделана мимо хаба — он работает как сторонний. Если это были вы — подтвердите заявку выше",
                      "The plugin's record was written behind the hub's back — it runs as third-party. If it was you, approve the request above")
        case "paused": return tr("В папке новая версия — поставлю, когда снимете паузу хаба", "The folder has a new version — it installs once the hub is resumed")
        case "missing": return tr("Папки нет — работает последняя установленная копия", "The folder is gone — the last installed copy keeps running")
        default:
            return tr("Папка не проходит проверку — работает последняя установленная копия", "The folder fails the check — the last installed copy keeps running")
                + (reason.map { ": " + $0 } ?? "")
        }
    }

    /// The "broken" reason in plain words (the first linter error or the code).
    public var reason: String? {
        if let e = errors.first { return e }
        switch error {
        case "own:moved": return tr("на месте папки — ссылка или другая папка", "the folder was replaced by a link or another folder")
        case "own:id-changed": return tr("в папке теперь другой плагин", "the folder now holds a different plugin")
        case "own:unreadable": return tr("папка не читается", "the folder can't be read")
        case "own:ambiguous", "own:no-plugin": return tr("в папке не найден плагин", "no plugin found in the folder")
        case "own:hub-too-old":
            // the plugin in the folder needs a newer contract than the hub has: the previous copy keeps running and updates after a hub update
            if let n = need, let h = have {
                return tr("нужен хаб новее: плагин в папке требует контракт \(n), а хаб понимает \(h)", "needs a newer hub: the plugin in the folder requires contract \(n), the hub understands \(h)")
            }
            return tr("нужен хаб новее", "needs a newer hub")
        case nil: return nil
        default: return error
        }
    }

    /// A warning (in orange), not information: the copy works, but the folder is wrong.
    public var isProblem: Bool { status == "missing" || status == "broken" || status == "unverified" }
}

extension ConsentSource {
    /// The line under the consent window title: where it installs from.
    public var line: String {
        guard isOwn else { return tr("подпись реестра ✓ · sha256 совпадает ✓", "registry signature ✓ · sha256 matches ✓") }
        let fp = fingerprint.map { String($0.prefix(12)) } ?? "?"
        return tr("своя папка · \(shownPath) · отпечаток \(fp)", "own folder · \(shownPath) · fingerprint \(fp)")
    }

    /// Who can change the folder and what follows from that.
    public var writableNote: String {
        if writableMine, !groupWritable.isEmpty {
            return tr("Менять папку могут процессы под вашим пользователем — и ваша группа (см. предупреждение ниже). Правки с тем же набором прав хаб поставит сам; новые права, откат версии и громкие уведомления — снова через это окно или кнопку «Обновить».",
                      "Processes running as your user can change the folder — and so can your group (see the warning below). Edits with the same permissions install by themselves; new permissions, an older version and loud notifications come back through this window or the Update button.")
        }
        return writableMine
            ? tr("Менять папку могут только процессы под вашим пользователем — в том числе агенты, которые работают в этом репозитории. Правки с тем же набором прав хаб поставит сам; новые права, откат версии и громкие уведомления — снова через это окно или кнопку «Обновить».",
                 "Only processes running as your user can change the folder — including agents working in this repository. Edits with the same permissions install by themselves; new permissions, an older version and loud notifications come back through this window or the Update button.")
            : tr("Папку может менять не только вы — хаб такой папке не доверяет.", "Others can change the folder — the hub doesn't trust such a folder.")
    }

    /// The loud line of the consent window for the source folder itself: writable by your group (umask 002). The install is
    /// allowed (decision 2026-11-11), but the human must see who else can change the plugin. nil — nothing to warn about.
    public var riskWarning: (title: String, text: String)? {
        guard isOwn, risk == "group-writable" else { return nil }
        let files = groupWritable.prefix(3).joined(separator: ", ") + (groupWritable.count > 3 ? "…" : "")
        let which = files.isEmpty ? "" : tr(" (запись для группы: \(files))", " (group write: \(files))")
        return (tr("Папку плагина может менять ваша группа, а не только вы", "Your group can change the plugin folder, not only you"),
                tr("Права папки допускают запись для группы\(which) — так бывает при umask 002. На Mac это обычно группа staff, то есть все учётные записи этого компьютера. Правки с тем же набором прав хаб ставит сам, без этого окна, — чужая правка получит доверие вашего плагина. Надёжнее убрать запись для группы: chmod -R g-w \(shownPath)",
                   "The folder permissions allow group write\(which) — that's what umask 002 does. On a Mac that's usually the staff group, i.e. every account on this computer. The hub installs edits with the same permissions by itself, without this window — someone else's edit would get your plugin's trust. Safer to remove group write: chmod -R g-w \(shownPath)"))
    }
}

extension PluginMigration {
    /// The move note in the consent window and the request. toRegistry is the registry catalog install window over an own
    /// plugin (the reverse move).
    public func text(title: String, toRegistry: Bool = false) -> String {
        let v = version.map { " \($0)" } ?? ""
        if toRegistry, from == "own" {
            let p = pathShort ?? path ?? "?"
            return tr("Заменит свой «\(title)»\(v) из папки \(p) на плагин из каталога реестра. Слежение за папкой прекратится; данные плагина сохранятся.",
                      "Replaces your own \"\(title)\"\(v) from \(p) with the plugin from the registry catalog. The hub stops following the folder; the plugin's data is kept.")
        }
        switch from {
        case "catalog":
            let name = self.title ?? title
            let what = tier == "official" ? tr("официальным плагином", "the official plugin") : tr("плагином", "the plugin")
            return tr("id совпадает с \(what) «\(name)» из каталога (он не установлен). Свой плагин получит всё, что хаб хранит под этим id: его секреты в связке ключей, данные и правила уведомлений. Ставьте, только если это ваш плагин.",
                      "The id matches \(what) \"\(name)\" from the catalog (not installed). Your own plugin gets everything the hub keeps under this id: its secrets in the keychain, data and notification rules. Install only if this is your plugin.")
        case "official", "community":
            let what = from == "official" ? tr("официальный", "the official") : tr("плагин сообщества", "the community plugin")
            return tr("Заменит \(what) «\(title)»\(v) из каталога на свой из этой папки. Обновления из каталога для него приходить перестанут; данные плагина сохранятся.",
                      "Replaces \(what) \"\(title)\"\(v) from the catalog with your own from this folder. Catalog updates stop for it; the plugin's data is kept.")
        case "own":
            let p = pathShort ?? path ?? "?"
            return tr("Сейчас «\(title)»\(v) стоит из другой папки (\(p)) — дальше хаб будет следить за этой.",
                      "\"\(title)\"\(v) is now installed from another folder (\(p)) — from now on the hub follows this one.")
        default:
            return tr("Заменит установленный «\(title)»\(v).", "Replaces the installed \"\(title)\"\(v).")
        }
    }
}

extension PluginRequirement {
    /// "Needs <program>": the plugin declares the name.
    public var label: String { tr("Нужен \(name)", "Needs \(name)") }
    /// The hint on a dimmed "Install".
    public var missingHint: String {
        tr("Сначала установите \(name) — без него плагину нечего показывать. Поставить плагин всё равно можно.",
           "Install \(name) first — without it the plugin has nothing to show. You can still install the plugin.")
    }
}

// MARK: - sessions

extension SessionInfo {
    /// A name like the terminal tab's: `-n` (name) → "сессия 1a2b3c4d".
    public var displayName: String {
        if let n = name, !n.isEmpty { return n }
        return tr("сессия \(sessionId.prefix(8))", "session \(sessionId.prefix(8))")
    }

    /// The state in plain words.
    public var stateLabel: String {
        switch status {
        case "waiting":
            if let w = waitingText { return tr("ждёт вас: \(w)", "needs you: \(w)") }
            return tr("ждёт вас", "needs you")
        case "busy": return tr("работает", "working")
        case "idle": return tr("свободна", "idle")
        default: return tr("состояние неизвестно", "status unknown")
        }
    }

    /// A "Waiting for you" row in the popover: "X is waiting for you" · what it waits for. If that is unknown (session files only, without
    /// `claude agents --json`), the title is the name and the caption is a complete phrase, not a fragment of the "answer".
    public var attentionLines: (title: String, sub: String) {
        if let w = waitingText { return (tr("\(displayName) ждёт вас", "\(displayName) needs you"), w) }
        return (displayName, tr("ждёт ответа в терминале", "waiting for you in the terminal"))
    }

    public var waitingText: String? {
        guard let w = waitingFor?.lowercased(), !w.isEmpty else { return nil }
        if w.contains("permission") { return tr("разрешение", "permission") }
        if w.contains("question") || w.contains("choice") { return tr("ответ на вопрос", "an answer") }
        if w.contains("input") || w.contains("message") || w.contains("prompt") { return tr("ваше сообщение", "your message") }
        return waitingFor
    }
}

// MARK: - plugin permissions

extension PluginPermission {
    public var kindLabel: String {
        switch kind {
        case "fsRead": return tr("Чтение", "Read")
        case "fsWrite": return tr("Запись", "Write")
        case "watch": return tr("Слежение", "Watch")
        case "exec": return tr("Команда", "Command")
        case "secrets": return tr("Секрет", "Secret")
        case "net": return tr("Сеть", "Network")
        case "effects": return tr("Действие хаба", "Hub action")
        case "actions": return tr("Своя кнопка", "Own button")
        case "push": return tr("Громкое уведомление", "Loud notification")
        case "connections": return tr("Подключение", "Connection")
        case "terminal": return tr("Терминал", "Terminal")
        case "subscribe": return tr("Подписка на события", "Event subscription")
        default: return kind
        }
    }

    /// The main line of a permission in the permission window, in plain words. An own button: its name and how it will ask; a hub action:
    /// what it does; everything else: the author's "why" (nil if the author did not write one).
    public var plainText: String? {
        switch kind {
        case "actions":
            let level = what.range(of: #"\[([a-z-]+)\]"#, options: .regularExpression).map { String(what[$0].dropFirst().dropLast()) }
            let ask = level == "confirm-cost" ? tr("спросит подтверждения и предупредит о цене", "asks first and warns about the cost")
                : level == "immediate" ? tr("без подтверждения", "no confirmation") : tr("спросит подтверждения", "asks first")
            return "\(why ?? what.split(separator: " ").first.map(String.init) ?? what) — \(ask)"
        case "push":
            // "alarm [security, quiet]": security arrives under any toggles, quiet arrives during quiet hours too
            var how: [String] = []
            if what.contains("security") { how.append(tr("при любых выключателях уведомлений", "whatever the notification switches say")) }
            if what.contains("quiet") { how.append(tr("и в тихие часы", "even in quiet hours")) }
            return "\(why ?? what.split(separator: " ").first.map(String.init) ?? what) — \(how.joined(separator: " "))"
        case "connections":
            // "[id: ]https://mcp.example.com/mcp scope=read tools=a,b": the hub handles the service login, the plugin calls its tools
            let host = what.split(separator: " ").first { $0.hasPrefix("https://") }.flatMap { URL(string: String($0))?.host } ?? what
            let how = tr("вход ведёт хаб, плагин токена не видит", "the hub keeps the sign-in, the plugin never sees the token")
            return "\(why ?? host) — \(how)"
        case "terminal":
            // "read-screen": input field signs without screen text; "send /model /effort": typing a line starting with that word;
            // "send *": any line. Only in a Claude Code session with a verified signature, not while paused.
            let parts = what.split(separator: " ").map(String.init)
            let how: String
            if parts.first == "read-screen" {
                how = tr("узнавать, пусто ли поле ввода и свободна ли сессия Claude Code (текст экрана плагин не видит)",
                         "check whether a Claude Code session is free and its input is empty (the plugin never sees the screen text)")
            } else if parts.dropFirst() == ["*"] {
                how = tr("набирать во вкладки Claude Code любые запросы и slash-команды и нажимать Enter (строки с «!», «#», «&» в начале хаб не набирает)",
                         "type any prompt or slash command into Claude Code tabs and press Enter (the hub never types lines starting with \"!\", \"#\" or \"&\")")
            } else {
                let words = parts.dropFirst().joined(separator: ", ")
                how = tr("набирать во вкладки Claude Code команды \(words) (до трёх коротких аргументов) и нажимать Enter",
                         "type the \(words) commands (up to three short arguments) into Claude Code tabs and press Enter")
            }
            return why.map { "\($0) — \(how)" } ?? how
        case "effects":
            switch what {
            case "open.url": return tr("открывать ссылки в браузере", "open links in the browser")
            case "open.file": return tr("открывать файлы и папки", "open files and folders")
            case "open.*": return tr("открывать ссылки и файлы", "open links and files")
            case "terminal.focus", "cmux.focus": return tr("переводить во вкладку терминала", "switch to a terminal tab")
            case "session.focus": return tr("переводить во вкладку сессии", "switch to a session's tab")
            case "session.interrupt": return tr("прерывать ход сессии", "interrupt a session's turn")
            case "session.stop": return tr("завершать сессию (с подтверждением)", "end a session (asks first)")
            default: return why ?? what
            }
        default: return why
        }
    }

    /// The technical form of the permission (path, command, URL), small under the main line.
    public var technical: String { what }

    /// The loud line of the consent window (contract 3): writing to a place from which Claude Code or the system can be hijacked.
    /// The title says what it means in one phrase, the text says why exactly this place is dangerous. nil means an ordinary place.
    public var riskWarning: (title: String, text: String)? {
        guard let r = risk else { return nil }
        // Claude Code mode characters (terminal permission send ! # &, 2026-11-10) are louder than ordinary typing
        if r == "terminal-mode" {
            return (tr("Команды оболочки и память Claude Code: плагин сможет набирать строки с «!», «#» или «&»",
                       "Shell commands and Claude Code memory: the plugin can type lines starting with \"!\", \"#\" or \"&\""),
                    tr("Строку с «!» Claude Code выполнит в оболочке сразу, без своих разрешений и без вашего подтверждения; с «#» — запишет в память, которую читает каждая следующая сессия; с «&» — запустит фоновую задачу. Это почти то же, что дать плагину ваш терминал. Соглашайтесь, только если плагину это действительно нужно и вы доверяете автору.",
                       "Claude Code runs a \"!\" line in the shell at once, without its own permissions and without asking you; a \"#\" line goes into memory every later session reads; a \"&\" line starts a background task. This is close to handing the plugin your terminal. Agree only if the plugin really needs it and you trust the author."))
        }
        // typing into tabs (terminal send permission, contract 3) is not a place on disk, but the same kind of hijack
        if r == "terminal" {
            return (tr("Набор в сессии Claude Code: плагин сможет вводить строки во вкладки от вашего имени",
                       "Typing into Claude Code: the plugin can enter lines into your tabs on your behalf"),
                    tr("Строку плагина Claude Code исполнит как вашу и с вашими правами: команду или запрос (если право — «любые строки», это любой запрос агенту, в том числе с режимом auto). Хаб набирает только в сессию с проверенной подписью, когда поле ввода пусто и ход не идёт, не на паузе и не чаще нескольких раз в минуту; каждая отправка — в журнале. Соглашайтесь, только если доверяете автору.",
                       "Claude Code runs the plugin's line as yours, with your permissions: a command or a prompt (with \"any line\" that is any prompt to the agent, auto mode included). The hub types only into a session with a verified signature, when its input is empty and no turn is running, never while paused and at most a few times a minute; every send is logged. Agree only if you trust the author."))
        }
        let title = tr("Место перехвата: через эту запись можно подменить работу Claude Code или системы",
                       "Takeover location: this write can change how Claude Code or the system behaves")
        let text: String
        switch r {
        case "claude-code":
            text = tr("Настройки Claude Code: через хуки (hooks), переменные окружения (env), apiKeyHelper, права (permissions), MCP-серверы, statusLine и команды плагин сможет запускать свои команды в каждой сессии, читать переписку и выдать себе разрешения. Соглашайтесь, только если доверяете автору.",
                      "Claude Code settings: through hooks, environment variables (env), apiKeyHelper, permissions, MCP servers, statusLine and commands the plugin can run its own commands in every session, read conversations and grant itself permissions. Agree only if you trust the author.")
        case "autostart":
            text = tr("Автозапуск: плагин сможет поставить программу, которая будет запускаться при каждом входе в систему — мимо хаба и этого окна.",
                      "Autostart: the plugin can install a program that runs at every login — bypassing the hub and this window.")
        case "shell":
            text = tr("Файлы запуска оболочки: их команды выполняются в каждом новом терминале и в сессиях Claude Code (окружение, PATH, псевдонимы).",
                      "Shell startup files: their commands run in every new terminal and in Claude Code sessions (environment, PATH, aliases).")
        case "bin":
            text = tr("Каталог программ из PATH или глобальных пакетов npm: можно подложить свою программу под именем claude, git или node (или подменить сам Claude Code) — она запустится вместо настоящей.",
                      "A program folder on PATH or the global npm packages: a program named claude, git or node placed here (or a replaced Claude Code) runs instead of the real one.")
        case "terminals":
            text = tr("Настройки терминала и привязка вкладок: команда, которую терминал запускает в каждой новой вкладке, и сведения, в какой вкладке какая сессия Claude Code (по ним хаб набирает во вкладки).",
                      "Terminal settings and tab bindings: the command a terminal runs in every new tab, and which tab holds which Claude Code session (the hub types into tabs by it).")
        case "ssh":
            text = tr("SSH: плагин сможет добавить свой ключ доступа или перенаправить подключения.",
                      "SSH: the plugin can add its own access key or redirect connections.")
        case "git":
            text = tr("Настройки git: хуки и псевдонимы git выполняют команды в каждом репозитории.",
                      "Git settings: git hooks and aliases run commands in every repository.")
        case "hub":
            text = tr("Каталог самого Agent Hub: настройки хаба, установленные плагины и закрепление приложения — так обходят проверки хаба.",
                      "Agent Hub's own folder: hub settings, installed plugins and the app pin — a way around the hub's checks.")
        default:
            text = tr("Через это место можно перехватить Claude Code или систему.", "This location can be used to take over Claude Code or the system.")
        }
        return (title, text)
    }

    /// Short form, for the permissions line in a catalog card.
    public var shortKindLabel: String {
        switch kind {
        case "fsRead": return tr("чтение файлов", "reads files")
        case "fsWrite": return tr("запись файлов", "writes files")
        case "watch": return tr("слежение", "watches")
        case "exec": return tr("запуск программ", "runs programs")
        case "secrets": return tr("секреты", "secrets")
        case "net": return tr("сеть", "network")
        case "effects": return tr("действия хаба", "hub actions")
        case "actions": return tr("свои кнопки", "own buttons")
        case "push": return tr("громкие уведомления", "loud notifications")
        case "connections": return tr("подключение к сервису", "service connection")
        case "terminal": return tr("терминал", "terminal")
        default: return kind
        }
    }

    /// Permission weight: what matters more to a human goes higher in the permission window.
    public var weight: Int {
        // a hijack location (contract 3) goes above everything: a human must see it first
        if risk != nil { return -1 }
        return ["actions": 0, "effects": 1, "push": 2, "terminal": 2, "connections": 3, "exec": 3, "secrets": 4, "net": 5, "fsWrite": 6, "watch": 7, "fsRead": 8][kind] ?? 9
    }

    /// Order in the permission window: new ones (on update) first, then by weight; within a kind, as the daemon sent them.
    public static func byWeight(_ list: [PluginPermission], addedFirst: Bool) -> [PluginPermission] {
        list.enumerated().sorted { a, b in
            let ka = (addedFirst && a.element.added ? 0 : 1, a.element.weight, a.offset)
            let kb = (addedFirst && b.element.added ? 0 : 1, b.element.weight, b.offset)
            return ka < kb
        }.map(\.element)
    }

    /// Permission kind with a count: "2 file reads", "1 program run", "3 own buttons".
    public static func counted(_ kind: String, _ n: Int) -> String {
        let w: String
        switch kind {
        case "fsRead": w = plural(n, ru: ("чтение файлов", "чтения файлов", "чтений файлов"), en: ("file read", "file reads"))
        case "fsWrite": w = plural(n, ru: ("запись файлов", "записи файлов", "записей файлов"), en: ("file write", "file writes"))
        case "watch": w = plural(n, ru: ("слежение", "слежения", "слежений"), en: ("watch", "watches"))
        case "exec": w = plural(n, ru: ("запуск программ", "запуска программ", "запусков программ"), en: ("program run", "program runs"))
        case "secrets": w = plural(n, ru: ("секрет", "секрета", "секретов"), en: ("secret", "secrets"))
        case "net": w = plural(n, ru: ("сетевой адрес", "сетевых адреса", "сетевых адресов"), en: ("network address", "network addresses"))
        case "effects": w = plural(n, ru: ("действие хаба", "действия хаба", "действий хаба"), en: ("hub action", "hub actions"))
        case "actions": w = plural(n, ru: ("своя кнопка", "своих кнопки", "своих кнопок"), en: ("own button", "own buttons"))
        case "push": w = plural(n, ru: ("громкое уведомление", "громких уведомления", "громких уведомлений"), en: ("loud notification", "loud notifications"))
        case "connections": w = plural(n, ru: ("подключение", "подключения", "подключений"), en: ("connection", "connections"))
        case "terminal": w = plural(n, ru: ("право терминала", "права терминала", "прав терминала"), en: ("terminal permission", "terminal permissions"))
        default: w = kind
        }
        return "\(n) \(w)"
    }

    /// "17 permissions: 3 own buttons · 4 program runs · …", a summary above the list so the count is visible. With a single
    /// kind, no repeated number: "2 permissions: file read".
    public static func summary(_ list: [PluginPermission]) -> String {
        var counts: [(String, Int, Int)] = []
        for p in list {
            if let i = counts.firstIndex(where: { $0.0 == p.kind }) { counts[i].1 += 1 } else { counts.append((p.kind, 1, p.weight)) }
        }
        let total = plural(list.count, ru: ("право", "права", "прав"), en: ("permission", "permissions"))
        if counts.count == 1, let only = counts.first {
            return "\(list.count) \(total): " + PluginPermission(kind: only.0, what: "", why: nil, added: false).shortKindLabel
        }
        let parts = counts.sorted { $0.2 < $1.2 }.map { k, n, _ in counted(k, n) }
        return "\(list.count) \(total): " + parts.joined(separator: " · ")
    }
}

// MARK: - core refusals

/// Core refusal texts: code → what happened in plain words. The raw code only at the second level ("Details").
public enum Explain {
    /// Every code the core can return to the app (a test checks that each has a text).
    public static let knownCodes: [String] = [
        "estop", "confirm:invalid", "consent:invalid", "not-found", "rate-limit",
        "peer:cli", "peer:uid", "peer:app-signature", "peer:app-requirement-missing", "peer:app-probe", "peer:no-peercred",
        "peer:no-pid", "peer:no-process", "peer:error", "peer:unknown",
        "facts:action-changed", "facts:bad-arg", "facts:bridge-offline", "facts:actions-off", "facts:unknown-session",
        "facts:not-running", "facts:not-pending", "facts:paused", "facts:not-interactive", "facts:non-interactive",
        "facts:bad-name", "facts:bad-cwd", "facts:forbidden-cwd", "facts:offer-not-allowed", "facts:no-surface",
        "facts:unknown-surface", "facts:workspace-mismatch", "facts:pid-mismatch", "facts:proc-start-mismatch",
        "facts:no-session-file", "facts:session-file-mismatch", "facts:session-file-unreadable", "facts:no-cmux-session",
        "facts:bad-url", "facts:scheme", "facts:credentials-in-url", "facts:risky-type", "facts:not-a-file",
        "facts:executable", "facts:relative-path", "facts:no-launch-dir", "facts:no-hook-service", "facts:verify-error",
        "facts:bound-elsewhere", "facts:bundle", "facts:alias", "facts:open-with", "registry:hub-too-old", "own:hub-too-old",
        "registry:no-index-url", "registry:no-public-key", "registry:foreign-key", "registry:signature",
        "registry:global-signature", "registry:rollback", "registry:blocklist", "registry:lint", "registry:sha256",
        "registry:fetch", "registry:http", "registry:network-disabled", "registry:redirect", "registry:too-large",
        "registry:url-scheme", "registry:not-found", "registry:no-catalog", "registry:platform", "registry:id",
        "registry:id-taken", "registry:archive", "registry:archive-url", "registry:archive-main",
        "registry:archive-version", "registry:archive-permissions", "registry:index-json", "registry:index-version",
        "registry:index-plugins", "registry:index-entry", "registry:index-duplicate", "registry:catalog-changed",
        "registry:install", "registry:write", "registry:disabled", "bridge-offline", "no-hook-service",
        "own:no-app", "own:lint", "own:not-found", "own:not-dir", "own:no-plugin", "own:ambiguous", "own:path",
        "own:path-relative", "own:unreadable", "own:no-request", "own:id-changed", "own:no-source",
        "own:path-changed", "own:request-conflict", "own:too-many-requests", "consent:nothing", "peer:diagnostic",
        "facts:no-terminal", "facts:no-tab", "facts:focus-unsupported", "facts:esc-unsupported", "facts:launch-unsupported",
        "facts:no-launch-terminal", "facts:terminal-test-mode", "facts:terminal-failed", "facts:tmux-failed", "facts:tmux-timeout",
        "facts:osascript-failed", "facts:osascript-timeout", "facts:not-installed", "terminal:unsupported",
        "input:required", "input:too-long", "input:control", "input:option-like", "input:pattern", "facts:jobs-limit", "facts:no-job",
        "secrets:disabled", "secrets:not-declared", "secrets:reserved", "secrets:foreign-namespace", "secrets:untrusted", "secrets:bad-key",
        "secrets:no-keychain", "secrets:keychain", "args:value:required", "args:value:chars", "args:value:length",
        "extensions:changed", "extensions:not-found", "extensions:disabled", "extensions:write-failed", "extensions:unsafe-file",
        "extensions:too-large",
    ]

    /// Whether the code has its own text (not the generic fallback).
    public static func covers(_ code: String) -> Bool { known(code, label: "x") != nil }

    public static func text(code: String, status: Int, label: String) -> String {
        if let t = known(code, label: label) { return t }
        // a refinement after the second colon (facts:non-interactive:no-tty, signature:failed) falls back to the main code
        let parts = code.split(separator: ":", maxSplits: 2).map(String.init)
        if parts.count == 3, let t = known("\(parts[0]):\(parts[1])", label: label) { return t }
        if code.hasPrefix("args:") { return tr("«\(label)»: неверные данные запроса.", "\"\(label)\": invalid request.") }
        if code.hasPrefix("facts:") { return tr("«\(label)»: хаб сверил запрос со своими данными и отказал.", "\"\(label)\": the hub checked the request against what it knows and refused.") }
        if code.hasPrefix("peer:") { return tr("Эта копия приложения не закреплена — действие ей недоступно.", "This copy of the app isn't pinned, so the action isn't available.") }
        if code.hasPrefix("registry:") { return tr("Менеджер плагинов отказал.", "The plugin manager refused.") }
        return tr("«\(label)»: хаб отказал.", "\"\(label)\": the hub refused.")
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func known(_ code: String, label l: String) -> String? {
        let q = L10n.shared.lang == .en ? "\"\(l)\"" : "«\(l)»"
        switch code {
        case "estop":
            return tr("Хаб на паузе — это действие выключено. Нажмите «Снять паузу».", "The hub is paused, so this action is off. Press Resume hub.")
        case "input:required", "input:too-long", "input:control", "input:option-like", "input:pattern":
            return "\(q): " + InputCheck.message(code)
        case "extensions:changed":
            return tr("Файл расширения изменился — проверьте его снова.", "The extension file changed — review it again.")
        case "extensions:not-found":
            return tr("Файла расширения больше нет.", "The extension file is gone.")
        case "extensions:disabled":
            return tr("Внешние расширения выключены в config.json (extensions.enabled).", "External extensions are off in config.json (extensions.enabled).")
        case "extensions:write-failed":
            return tr("Хаб не смог записать одобрение — ничего не изменилось.", "The hub couldn't record the approval — nothing changed.")
        case "extensions:unsafe-file":
            return tr("Файл чужой или его могут менять другие пользователи — такой хаб не загрузит.", "The file belongs to someone else or others may write it — the hub won't load it.")
        case "extensions:too-large":
            return tr("Файл больше 1 МБ — хаб такой не загрузит.", "The file is over 1 MB — the hub won't load it.")
        case "facts:jobs-limit":
            return tr("\(q): у плагина уже работает максимум фоновых задач — дождитесь конца одной или остановите её.",
                      "\(q): the plugin already runs the maximum number of background jobs — wait for one to end or stop it.")
        case "facts:no-job":
            return tr("Эта фоновая задача уже закончилась.", "This background job has already ended.")
        case "secrets:disabled":
            return tr("Служба ключей хаба не запущена.", "The hub's key service isn't running.")
        case "secrets:not-declared":
            return tr("Плагин больше не объявляет этот ключ.", "The plugin no longer declares this key.")
        case "secrets:reserved", "secrets:foreign-namespace", "secrets:untrusted", "secrets:bad-key":
            return tr("Этот ключ нельзя задать из приложения.", "This key can't be set from the app.")
        case "secrets:no-keychain":
            return tr("Нет связки ключей macOS (тестовый хаб).", "No macOS keychain (a test hub).")
        case "secrets:keychain":
            return tr("Связка ключей macOS не ответила — ничего не изменилось. Попробуйте ещё раз.", "The macOS keychain didn't answer — nothing changed. Try again.")
        case "args:value:required", "args:value:chars", "args:value:length":
            return SecretValue.problem(code == "args:value:length" ? String(repeating: "x", count: SecretValue.maxLength + 1) : code == "args:value:chars" ? "\"" : "") ?? ""
        case "own:no-app":
            return tr("Приложение не закреплено — свой плагин подтвердить некому.", "The app isn't pinned — there's nobody to confirm your own plugin.")
        case "own:lint":
            return tr("Плагин в папке не прошёл проверку (та же, что у реестра) — не установлен.", "The plugin in the folder failed the check (same as the registry's) — not installed.")
        case "own:not-found", "own:not-dir":
            return tr("Папки нет или это не папка.", "The folder doesn't exist or isn't a folder.")
        case "own:no-plugin", "own:path", "own:path-relative", "own:unreadable":
            return tr("В папке не найден плагин: нужна папка <id> с файлом <id>.<интервал>.<расширение> или репозиторий с agenthub/<id>.",
                      "No plugin in the folder: pick an <id> folder with <id>.<interval>.<ext>, or a repository with agenthub/<id>.")
        case "own:ambiguous":
            return tr("В agenthub/ несколько плагинов — выберите папку одного из них.", "agenthub/ holds several plugins — pick the folder of one.")
        case "own:no-request":
            return tr("Заявка уже снята или истекла.", "The request was already withdrawn or expired.")
        case "own:id-changed", "own:no-source":
            return tr("В папке теперь другой плагин — добавьте её заново.", "The folder now holds a different plugin — add it again.")
        case "own:path-changed":
            return tr("Папку заявки заменили (ссылкой или другой папкой) — ставить не из той папки, о которой просили, нельзя. Отклоните заявку и добавьте папку заново.",
                      "The request's folder was replaced (by a link or another folder) — it won't install from a folder other than the one requested. Decline the request and add the folder again.")
        case "own:request-conflict":
            return tr("Уже ждёт заявка на этот плагин из другой папки — сначала подтвердите или отклоните её.", "A request for this plugin from another folder is already waiting — approve or decline it first.")
        case "own:too-many-requests":
            return tr("Ждут подтверждения слишком много заявок — подтвердите или отклоните их.", "Too many requests are waiting — approve or decline them.")
        case "consent:nothing":
            return tr("Согласовывать нечего: права не растут.", "Nothing to agree to: permissions don't grow.")
        case "peer:diagnostic":
            return tr("Диагностический запуск приложения ничего не меняет.", "A diagnostic app run doesn't change anything.")
        case "confirm:invalid":
            return tr("Подтверждение просрочено или уже использовано — повторите действие.", "The confirmation expired or was already used — try again.")
        case "consent:invalid":
            return tr("Согласие просрочено — повторите установку.", "The consent expired — install again.")
        case "not-found":
            return tr("\(q): плагин уже обновил вывод — нажмите кнопку ещё раз.", "\(q): the plugin has updated — press the button again.")
        case "rate-limit":
            return tr("Слишком много одобрений подряд — ответы из хаба приостановлены на минуту.", "Too many approvals in a row — hub replies are paused for a minute.")
        case "peer:cli", "peer:app-signature", "peer:app-probe", "peer:unknown", "peer:no-peercred", "peer:no-pid", "peer:no-process", "peer:error":
            return tr("Эта сборка приложения не закреплена — подтверждаемые действия ей недоступны.", "This app build isn't pinned, so it can't confirm actions.") + " " + PinAdvice.shared.openPinned
        case "peer:app-requirement-missing":
            return tr("Приложение не закреплено — подтверждения не работают.", "The app isn't pinned — confirmations won't work.") + " " + PinAdvice.shared.repairOnly
        case "peer:uid":
            return tr("Запрос пришёл от другого пользователя macOS — хаб его не принимает.", "The request came from another macOS user — the hub won't accept it.")
        case "facts:action-changed", "facts:bad-arg":
            return tr("\(q): плагин обновил вывод — нажмите кнопку ещё раз.", "\(q): the plugin has updated — press the button again.")
        case "facts:bridge-offline", "bridge-offline":
            return tr("Мост cmux не запущен — откройте agenthub-bridge во вкладке cmux.", "The cmux bridge isn't running — open agenthub-bridge in a cmux tab.")
        case "facts:actions-off":
            return tr("Служба действий хаба не запущена.", "The hub's action service isn't running.")
        case "facts:unknown-session", "facts:bound-elsewhere":
            return tr("Сессия уже закрыта или хаб её не узнал.", "The session is gone or the hub doesn't recognize it.")
        case "facts:not-running":
            return tr("\(q): ход уже закончился — прерывать нечего.", "\(q): the turn already ended — nothing to interrupt.")
        case "facts:not-pending":
            return tr("На этот запрос уже ответили (в хабе, терминале или с телефона) или он истёк.", "This request was already answered (in the hub, terminal or on your phone) or it expired.")
        case "facts:paused":
            return tr("Ответы из хаба приостановлены на минуту: слишком много одобрений подряд.", "Replies from the hub are paused for a minute: too many approvals in a row.")
        case "facts:not-interactive", "facts:non-interactive":
            return tr("Это фоновая сессия (claude -p) — из хаба ей не ответить и не остановить.", "This is a background session (claude -p) — the hub can't reply to or stop it.")
        case "facts:bad-name":
            return tr("Имя сессии: только буквы, цифры, пробел и . _ ( ) -.", "Session name: letters, digits, spaces and . _ ( ) - only.")
        case "facts:bad-cwd":
            return tr("Такой папки нет или путь не полный.", "That folder doesn't exist or the path isn't absolute.")
        case "facts:forbidden-cwd":
            return tr("В папках ~/.claude и самого хаба сессии не запускаются.", "Sessions can't be launched in ~/.claude or the hub's own folder.")
        case "facts:offer-not-allowed":
            return tr("Промпт вводит только человек: плагин не может предложить запуск сессии.", "Only a person can enter a prompt: a plugin can't suggest launching a session.")
        case "facts:no-surface", "facts:unknown-surface", "facts:workspace-mismatch", "facts:no-cmux-session", "facts:no-tab":
            return tr("Вкладка закрыта или переместилась.", "The tab was closed or moved.")
        case "facts:no-terminal":
            return tr("Хаб не нашёл вкладку этой сессии: её терминал не поддерживается или вкладка закрыта.", "The hub couldn't find this session's tab: its terminal isn't supported or the tab is closed.")
        case "facts:focus-unsupported":
            return tr("Терминал этой сессии не умеет переходить во вкладку.", "This session's terminal can't switch to its tab.")
        case "facts:esc-unsupported":
            return tr("Терминал этой сессии не умеет нажимать Esc из хаба — прервите ход во вкладке.", "This session's terminal can't press Esc from the hub — interrupt the turn in the tab.")
        case "facts:launch-unsupported", "facts:no-launch-terminal":
            return tr("Нет терминала, в котором хаб может открыть новую вкладку (Настройки → Терминал).", "There's no terminal the hub can open a new tab in (Settings → Terminal).")
        case "facts:terminal-test-mode":
            return tr("Тестовая копия хаба не трогает настоящие терминалы.", "A test copy of the hub doesn't touch real terminals.")
        case "facts:tmux-failed", "facts:tmux-timeout":
            return tr("\(q): tmux не выполнил команду — сервер tmux остановлен или вкладка закрыта.", "\(q): tmux didn't run the command — the tmux server is down or the pane is closed.")
        case "facts:osascript-failed", "facts:osascript-timeout":
            return tr("\(q): терминал не ответил на AppleScript — разрешите хабу управлять им: Системные настройки → Конфиденциальность и безопасность → Автоматизация.",
                      "\(q): the terminal didn't answer AppleScript — allow the hub to control it: System Settings → Privacy & Security → Automation.")
        case "facts:not-installed":
            return tr("\(q): терминал не установлен.", "\(q): the terminal isn't installed.")
        case "facts:terminal-failed":
            return tr("\(q): терминал не ответил.", "\(q): the terminal didn't respond.")
        case "terminal:unsupported":
            return tr("Терминал этой сессии этого не умеет.", "This session's terminal doesn't support that.")
        case "facts:pid-mismatch", "facts:proc-start-mismatch", "facts:session-file-mismatch", "facts:no-session-file", "facts:session-file-unreadable":
            return tr("Сессия перезапустилась или закрылась — обновите список и попробуйте ещё раз.", "The session restarted or closed — refresh and try again.")
        case "facts:bad-url", "facts:scheme", "facts:credentials-in-url":
            return tr("Ссылка не открыта: хаб открывает только обычные http/https-адреса.", "Link not opened: the hub only opens plain http/https addresses.")
        case "facts:executable":
            return tr("Файл не открыт: это программа или скрипт — хаб такие не запускает.", "File not opened: it's a program or script, and the hub won't run those.")
        case "facts:bundle":
            return tr("Не открыто: это программа или пакет, а не обычная папка — его можно лишь показать в Finder.", "Not opened: it's an app or a package, not a plain folder — it can only be shown in Finder.")
        case "facts:alias", "facts:open-with":
            return tr("Файл не открыт: это ярлык Finder или у файла своя программа для открытия — хаб такие не открывает, только показывает в Finder.", "File not opened: it's a Finder alias or has its own app set to open it — the hub won't open those, only show them in Finder.")
        case "facts:risky-type":
            return tr("Файл не открыт: хаб открывает только документы, картинки и медиа — остальное можно лишь показать в Finder.", "File not opened: the hub only opens documents, images and media — other files can only be shown in Finder.")
        case "facts:not-a-file", "facts:relative-path":
            return tr("Файл не найден.", "File not found.")
        case "facts:no-launch-dir":
            return tr("Запуск недоступен: не настроена папка запуска.", "Launching is unavailable: the launch folder isn't set up.")
        case "facts:no-hook-service", "no-hook-service":
            return tr("Служба ответов сессиям не запущена.", "The session reply service isn't running.")
        case "facts:verify-error":
            return tr("Хаб не смог проверить запрос — попробуйте ещё раз.", "The hub couldn't verify the request — try again.")
        case "registry:hub-too-old", "own:hub-too-old":
            return tr("\(q): нужен хаб новее — плагин требует более новый контракт плагинов. Обновите Agent Hub и повторите.",
                      "\(q): needs a newer hub — the plugin requires a newer plugin contract. Update Agent Hub and try again.")
        case "registry:no-index-url", "registry:no-public-key":
            return tr("Каталог плагинов не подключён — хаб не знает, откуда брать плагины.", "Plugin catalog isn't connected — the hub doesn't know where to get plugins.")
        case "registry:foreign-key", "registry:signature", "registry:global-signature", "registry:key-format", "registry:sig-format":
            return tr("Каталог отвергнут: подпись не сошлась. Возможна подмена — ничего не установлено.", "Catalog rejected: signature mismatch. It may be tampered with; nothing was installed.")
        case "registry:rollback":
            return tr("Каталог старее уже полученного — отвергнут как возможный откат.", "Catalog is older than the one already accepted — rejected as a possible rollback.")
        case "registry:blocklist":
            return tr("\(q) заблокирован реестром.", "\(q) is blocked by the registry.")
        case "registry:lint", "registry:archive-permissions":
            return tr("\(q): права в архиве не совпали с каталогом — не установлено.", "\(q): permissions in the archive don't match the catalog — not installed.")
        case "registry:sha256":
            return tr("Архив \(q) не совпал с подписанным каталогом — не установлено.", "The \(q) archive doesn't match the signed catalog — not installed.")
        case "registry:fetch", "registry:http", "registry:redirect":
            return tr("Нет связи с каталогом плагинов — проверьте интернет и нажмите «Обновить».", "Can't reach the plugin catalog — check your connection and retry.")
        case "registry:network-disabled":
            return tr("Сеть для каталога выключена в настройках хаба (allowNetwork: false).", "Network access for the catalog is turned off in hub settings (allowNetwork: false).")
        case "registry:not-found":
            return tr("Файл каталога не найден по указанному адресу.", "The catalog file wasn't found at that address.")
        case "registry:url-scheme":
            return tr("Адрес каталога должен начинаться с https:// или file://.", "The catalog address must start with https:// or file://.")
        case "registry:too-large":
            return tr("Каталог или архив больше допустимого — отвергнут.", "The catalog or archive is too large — rejected.")
        case "registry:no-catalog":
            return tr("Каталог ещё не загружен — нажмите «Загрузить».", "The catalog isn't loaded yet — press Load.")
        case "registry:platform":
            return tr("\(q) не поддерживает эту систему.", "\(q) doesn't support this system.")
        case "registry:id", "registry:id-taken":
            return tr("\(q): такое имя уже занято встроенным или другим плагином.", "\(q): that name is already taken by a built-in or another plugin.")
        case "registry:archive", "registry:archive-url", "registry:archive-main", "registry:archive-version":
            return tr("Архив \(q) повреждён или не совпадает с каталогом.", "The \(q) archive is damaged or doesn't match the catalog.")
        case "registry:index-json", "registry:index-version", "registry:index-plugins", "registry:index-entry", "registry:index-duplicate":
            return tr("Каталог повреждён — хаб не смог его прочитать.", "The catalog is damaged — the hub couldn't read it.")
        case "registry:catalog-changed":
            return tr("Каталог обновился, пока шла установка — повторите.", "The catalog changed during installation — try again.")
        case "registry:install", "registry:write":
            return tr("\(q): не удалось записать файлы плагина.", "\(q): couldn't write the plugin's files.")
        case "registry:disabled":
            return tr("Служба менеджера плагинов не запущена.", "The plugin manager service isn't running.")
        default:
            return nil
        }
    }

    /// Failure of an already executed action (200, ok: false): an explanation from the plugin itself (`message=`, contract 2, in the
    /// hub language, shown as is), its reason code, exit code or timeout. The app knows no specific plugins'
    /// codes.
    public static func failure(result: JSONValue?, label: String) -> String {
        let q = L10n.shared.lang == .en ? "\"\(label)\"" : "«\(label)»"
        if let msg = result?["message"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !msg.isEmpty {
            return "\(q): \(msg)"
        }
        if let why = result?["reason"]?.stringValue, !why.isEmpty {
            return tr("\(q): плагин отказал (\(why)).", "\(q): the plugin refused (\(why)).")
        }
        if result?["timedOut"]?.boolValue == true { return tr("\(q): команда не уложилась в 30 с и остановлена.", "\(q): the command took over 30 s and was stopped.") }
        if let code = result?["code"]?.intValue { return tr("\(q): команда завершилась с ошибкой (код \(code)).", "\(q): the command failed (exit code \(code)).") }
        if let e = result?["error"]?.stringValue { return text(code: "facts:\(e)", status: 200, label: label) }
        return label
    }
}

// MARK: - journal

extension JournalEntry {
    /// Why the app was not launched (`skipped` in `app-launch`), short and lowercase.
    static func launchSkipText(_ why: String) -> String {
        switch why {
        case "test-mode": return tr("тестовый каталог", "test folder")
        case "unsupported": return tr("на этой платформе не умеет", "not supported on this platform")
        case "no-path": return tr("путь сборки не записан", "build path not recorded")
        case "pin-mismatch": return tr("сборка не та, что закреплена", "not the pinned build")
        case "limited": return tr("приложение падает — перезапуск остановлен", "the app keeps crashing — restart stopped")
        default: return why
        }
    }

    /// The human-readable name of a journal entry; the raw type on expand.
    public var typeLabel: String {
        switch type {
        case "action": return tr("Действие", "Action")
        case "action-denied": return tr("Отказано", "Denied")
        case "action-confirm-requested": return tr("Запрошено подтверждение", "Confirmation requested")
        case "estop", "estop-set":
            let on = fields["on"]?.boolValue ?? false
            let by = fields["peer"]?.stringValue
            let who = by == "app" ? tr("приложение", "app") : by == "cli" ? tr("терминал", "terminal") : nil
            let base = on ? tr("Пауза хаба включена", "Hub paused") : tr("Пауза хаба снята", "Hub resumed")
            return who.map { tr("\(base) (кем: \($0))", "\(base) (by \($0))") } ?? base
        case "app-requirement-changed":
            // old/new are pin fingerprints (`none` means not pinned, `unknown` means the daemon does not remember the previous one,
            // daemon/lib/app-pin.mjs); a first pin follows the same rule as the banner and push (AppPinInfo)
            let old = fields["old"]?.stringValue ?? "none", new = fields["new"]?.stringValue ?? ""
            if new == "none" { return tr("Закрепление приложения снято", "App unpinned") }
            return AppPinInfo.isFirstPin(old: old) ? tr("Приложение закреплено", "App pinned") : tr("Приложение закреплено заново", "App re-pinned")
        case "plugin-add": return tr("Плагин подключён", "Plugin loaded")
        case "plugin-remove": return tr("Плагин отключён", "Plugin unloaded")
        case "plugin-exit": return tr("Плагин завершился", "Plugin exited")
        case "plugin-installed": return tr("Плагин установлен", "Plugin installed")
        case "plugin-updated": return tr("Плагин обновлён", "Plugin updated")
        case "plugin-removed-by-user": return tr("Плагин удалён", "Plugin removed")
        case "start": return tr("Хаб запущен", "Hub started")
        case "stop":
            switch fields["reason"]?.stringValue {
            case "shutdown": return tr("Хаб остановлен вместе с приложением", "Hub stopped with the app")
            case "login-off": return tr("Хаб остановлен: «Запускать при входе» выключен", "Hub stopped: Launch at login is off")
            default: return tr("Хаб остановлен", "Hub stopped")
            }
        // daemon and app lifecycle (the app service, POST /shutdown)
        case "shutdown-requested": return tr("Приложение закрыто — хаб останавливается", "App quit — stopping the hub")
        case "app-lost": return tr("Приложение пропало", "App disappeared")
        case "app-launch":
            // ok / code / skipped: a failed launch (open returned an error) is not a success
            let why = fields["reason"]?.stringValue
            if let sk = fields["skipped"]?.stringValue, !sk.isEmpty {
                return tr("Приложение не запущено: \(Self.launchSkipText(sk))", "App not launched: \(Self.launchSkipText(sk))")
            }
            if fields["ok"]?.boolValue == false {
                let code = fields["code"].flatMap { $0.intValue.map(String.init) ?? $0.stringValue }
                return code.map { tr("Не удалось запустить приложение (код \($0))", "Couldn't launch the app (code \($0))") } ?? tr("Не удалось запустить приложение", "Couldn't launch the app")
            }
            switch why {
            case "start": return tr("Хаб запустил приложение", "Hub launched the app")
            case "hub-update": return tr("Хаб запустил новую версию приложения", "Hub launched the new app version")
            case "hub-update-relaunch", "relaunch": return tr("Хаб вернул приложение", "Hub reopened the app")
            default: return tr("Хаб перезапустил приложение", "Hub restarted the app")
            }
        case "app-launch-skipped":
            // without appPin.path the daemon does not launch the app (decision 2026-11-07): what a human should do
            if fields["why"]?.stringValue == "no-path" {
                return tr("Приложение не запущено: путь сборки не записан — выполните agenthub pin-app", "App not launched: build path not recorded — run agenthub pin-app")
            }
            return tr("Приложение не запущено", "App not launched")
        case "app-login-gate":
            switch fields["decision"]?.stringValue {
            case "wait": return tr("«Запускать при входе» выключен — хаб ждёт приложение", "Launch at login is off — the hub is waiting for the app")
            case "exit": return tr("«Запускать при входе» выключен — приложение не открыто, хаб остановлен", "Launch at login is off — the app isn't open, hub stopped")
            default: return tr("Хаб запущен приложением — остаётся", "Hub started by the app — staying up")
            }
        case "app-restart-stopped": return tr("Приложение падает — перезапуск остановлен", "App keeps crashing — restart stopped")
        case "app-supervise": return tr("Надзор за приложением", "App supervision")
        case "app-supervise-resumed": return tr("Надзор за приложением снова включён", "App supervision resumed")
        case "app-pin-path-changed": return tr("Сменился путь закреплённой сборки", "Pinned build path changed")
        // old entries (before 2026-11-07 the daemon remembered the bundle of the last connection)
        case "app-path-seen": return tr("Хаб запомнил, откуда запускать приложение", "Hub noted where to launch the app from")
        case "service-start": return tr("Служба запущена", "Service started")
        case "service-error": return tr("Сбой службы", "Service error")
        case "denied": return tr("Запрос отклонён", "Request denied")
        case "hook": return tr("Запрос сессии", "Session request")
        case "hook-denied": return tr("Запрос сессии отклонён", "Session request denied")
        case "settings-changed": return tr("Настройка изменена", "Setting changed")
        case "warning": return tr("Предупреждение", "Warning")
        case "registry-fetched": return tr("Каталог загружен", "Catalog loaded")
        // hub update (docs/hub-updates.md)
        case "hub-update-check": return tr("Проверка обновлений хаба", "Hub update check")
        case "hub-update-available": return tr("Доступна новая версия хаба", "New hub version available")
        case "hub-update-start": return fields["op"]?.stringValue == "rollback" ? tr("Откат хаба начат", "Hub rollback started") : tr("Обновление хаба начато", "Hub update started")
        case "hub-update-built": return tr("Новая версия хаба собрана", "New hub version built")
        case "hub-update-ready": return tr("Новая версия хаба собрана — ждёт перезапуска", "New hub version built — waiting to restart")
        // the version is in the target column (label): the caption is short so the column does not cut it
        case "hub-update-switch": return fields["op"]?.stringValue == "rollback" ? tr("Откат хаба — перезапуск", "Hub rollback — restarting") : tr("Переключение хаба — перезапуск", "Hub switch — restarting")
        case "hub-update-installed": return fields["op"]?.stringValue == "rollback" ? tr("Хаб возвращён на прежнюю версию", "Hub rolled back") : tr("Хаб обновлён", "Hub updated")
        case "hub-update-failed": return fields["op"]?.stringValue == "rollback" ? tr("Откат хаба не удался", "Hub rollback failed") : tr("Обновление хаба не удалось", "Hub update failed")
        case "hub-update-restore": return tr("Файлы установки хаба возвращены", "Hub install files restored")
        case "hub-update-pruned": return tr("Старые версии хаба удалены", "Old hub versions removed")
        case "hub-update-app-terminated": return tr("Приложение закрыто для обновления", "App closed for the update")
        default: return type
        }
    }

    /// This is a hub action (for the "actions only" filter).
    public var isAction: Bool {
        type.hasPrefix("action") || type.hasPrefix("estop") || type.hasPrefix("plugin-installed") || type.hasPrefix("plugin-updated")
            || type == "plugin-removed-by-user" || type == "app-requirement-changed" || type == "settings-changed"
            || type == "shutdown-requested" || type == "app-launch"
            || type == "hub-update-start" || type == "hub-update-switch" || type == "hub-update-installed" || type == "hub-update-failed"
    }

    /// The entry target: action, plugin, session, hub version (label in hub-update-*). An action offer id (16 hex,
    /// "b13fd09157e55b7f") means nothing to a human, so it is used only when there is nothing else to name.
    public var target: String {
        let keys = ["title", "plugin", "actionId", "primitive", "label", "key", "value", "sessionId", "route"]
        var parts = keys.compactMap { k -> String? in
            guard let v = fields[k]?.stringValue, !v.isEmpty else { return nil }
            return k == "sessionId" ? String(v.prefix(8)) : v
        }
        if let a = fields["action"]?.stringValue, !a.isEmpty, parts.isEmpty || a.wholeMatch(of: /[0-9a-f]{16,}/) == nil {
            parts.insert(a, at: 0)
        }
        var seen = Set<String>()
        return parts.filter { seen.insert($0).inserted }.prefix(3).joined(separator: " · ")
    }

    /// Result: "app ✓", "403 peer:cli".
    public var result: (text: String, ok: Bool)? {
        if type == "action-denied" || type == "denied" || type == "hook-denied" {
            return (fields["error"]?.stringValue ?? tr("отказ", "denied"), false)
        }
        if type == "action" {
            let ok = fields["ok"]?.boolValue ?? false
            return ("\(fields["peer"]?.stringValue ?? "?") \(ok ? "✓" : "✕")", ok)
        }
        if let p = fields["peer"]?.stringValue { return (p, true) }
        return nil
    }
}

// MARK: - app pinning

extension AppPinInfo {
    /// "from a Claude Code session" / "from a terminal" / "config.json edited by hand".
    public var originText: String {
        if by == "manual" { return tr("config.json изменён вручную", "config.json was edited by hand") }
        if by == "agenthub hub-update rollback" { return tr("откатом обновления хаба", "by a hub update rollback") }
        if by == "agenthub hub-update" { return tr("обновлением хаба", "by a hub update") }
        if by == "agenthub hub migrate" { return tr("переводом хаба в отдельную установку", "by moving the hub to a separate install") }
        if by == "agenthub hub install" { return tr("установщиком хаба", "by the hub installer") }
        switch under {
        case "claude-code": return tr("из сессии Claude Code", "from a Claude Code session")
        case "terminal": return tr("из терминала", "from Terminal")
        case "no-tty": return tr("из скрипта без терминала", "from a script (no terminal)")
        default: return tr("откуда — неизвестно", "source unknown")
        }
    }

    /// The "It was me" key: the note is hidden for this pin, and the next one will show again.
    public var ackKey: String { "\(fingerprint)|\(changedAt ?? "")" }

    /// Who wrote it: "agenthub pin-app".
    public var byText: String {
        switch by {
        case nil, "unknown": return tr("неизвестно", "unknown")
        case "manual": return tr("вручную", "by hand")
        default: return by ?? ""
        }
    }
}

// MARK: - dates

public enum Fmt {
    public static func dateTime(_ d: Date) -> String {
        d.formatted(.dateTime.day().month(.abbreviated).hour().minute().locale(L10n.shared.locale))
    }

    public static func time(_ d: Date) -> String {
        d.formatted(.dateTime.hour().minute().locale(L10n.shared.locale))
    }

    /// "3 min", "2 h 05 min".
    public static func duration(_ s: TimeInterval) -> String {
        let m = max(0, Int(s / 60))
        if m < 1 { return tr("сейчас", "now") }
        if m < 60 { return tr("\(m) мин", "\(m) min") }
        return tr("\(m / 60) ч \(String(format: "%02d", m % 60)) мин", "\(m / 60) h \(String(format: "%02d", m % 60)) min")
    }
}

extension HookCard {
    /// How long it has been waiting (from createdAt).
    public var age: TimeInterval? {
        guard let c = createdAt, let d = parseISODate(c) else { return nil }
        return max(0, Date().timeIntervalSince(d))
    }
}
