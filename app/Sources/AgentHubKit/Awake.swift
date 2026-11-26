import Foundation

// "Stay awake with the lid closed" (`/state.awake`, event `awake`, `POST /awake`).
// The daemon owns all of it: the system flag, the rights to change it and the battery guard that brings sleep back
// below a fixed charge. The shell only shows the state, sends the switch and marks the menu bar icon while the flag is
// on (so a forgotten flag is visible). The charge is not a setting: the shell only repeats the number the daemon sent.

/// `awake` in `/state`, the `awake` event and the reply of `POST /awake`.
/// No section (an older daemon) is the same as `supported == false`: no row anywhere.
public struct AwakeInfo: Codable, Sendable, Hashable {
    /// The machine has a lid to close. false — nothing to switch, no row.
    public var supported: Bool
    /// The hub was given the rights to change the flag (`agenthub awake grant`). Without them it can neither switch it
    /// nor bring sleep back at the battery threshold.
    public var granted: Bool
    public var on: Bool
    /// nil — the daemon doesn't know (no battery, or it couldn't read it).
    public var onBattery: Bool?
    /// Battery charge in percent; nil — unknown.
    public var charge: Int?
    /// Below this charge on battery the daemon brings sleep back by itself (at exactly this much it doesn't yet).
    /// The daemon's own fixed number, shown as it came: nothing here changes it.
    public var threshold: Int

    /// For a section without the number: what the daemon uses.
    public static let defaultThreshold = 10

    public init(supported: Bool = true, granted: Bool = true, on: Bool = false, onBattery: Bool? = nil, charge: Int? = nil,
                threshold: Int = AwakeInfo.defaultThreshold) {
        self.supported = supported; self.granted = granted; self.on = on
        self.onBattery = onBattery; self.charge = charge; self.threshold = threshold
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // a broken or missing field falls to the quiet side: no row, no rights, off
        supported = (try? c.decode(Bool.self, forKey: .supported)) ?? false
        granted = (try? c.decode(Bool.self, forKey: .granted)) ?? false
        on = (try? c.decode(Bool.self, forKey: .on)) ?? false
        onBattery = try? c.decodeIfPresent(Bool.self, forKey: .onBattery)
        charge = try? c.decodeIfPresent(Int.self, forKey: .charge)
        threshold = (try? c.decode(Int.self, forKey: .threshold)) ?? Self.defaultThreshold
    }

    enum CodingKeys: String, CodingKey { case supported, granted, on, onBattery, charge, threshold }

    /// The mark on the menu bar icon: while the flag is on, whoever turned it on and whether or not the hub has the rights.
    public var marksIcon: Bool { supported && on }
}

/// How the switch looks, by the daemon's section alone.
public enum AwakeLook: Equatable, Sendable {
    case off
    case on
    /// The hub has no rights to change the flag: greyed, not clickable. `on` — the flag is on anyway (turned on outside
    /// the hub): shown as on, and the hint warns that the hub can't bring sleep back at the battery threshold.
    case unavailable(on: Bool)

    /// nil — no row at all: no section (an older daemon) or a machine without a lid.
    public static func make(_ info: AwakeInfo?) -> AwakeLook? {
        guard let info, info.supported else { return nil }
        if !info.granted { return .unavailable(on: info.on) }
        return info.on ? .on : .off
    }

    public var isOn: Bool {
        switch self {
        case .on, .unavailable(on: true): return true
        case .off, .unavailable(on: false): return false
        }
    }

    public var isAvailable: Bool {
        if case .unavailable = self { return false }
        return true
    }
}

/// The switch row as the popover, the panel and the icon menu draw it: the look plus the connection.
public struct AwakeRow: Equatable, Sendable {
    public var look: AwakeLook
    public var isOn: Bool
    /// Clickable: connected and the hub has the rights. Unlike resuming the hub, the terminal may switch it too, so the
    /// app's class doesn't matter here.
    public var enabled: Bool
    /// The hint: what the switch does, or why it can't be clicked.
    public var help: String

    public static var title: String { tr("Не спать с закрытой крышкой", "Stay awake with the lid closed") }

    /// nil — no row (`AwakeLook.make`).
    public static func make(_ info: AwakeInfo?, live: Bool, hub: HubInfo? = nil) -> AwakeRow? {
        guard let info, let look = AwakeLook.make(info) else { return nil }
        let help: String
        if !live {
            help = ActionBlock.offline.help
        } else {
            switch look {
            case .off, .on: help = AwakeText.help(threshold: info.threshold)
            case .unavailable(on: false): help = AwakeText.notGranted(hub: hub)
            case .unavailable(on: true): help = AwakeText.onWithoutRights(threshold: info.threshold, hub: hub)
            }
        }
        return AwakeRow(look: look, isOn: look.isOn, enabled: live && look.isAvailable, help: help)
    }
}

public enum AwakeText {
    /// The terminal command that gives the hub the rights: the daemon CLI by full path when the hub told it
    /// (`/state.hub.cli`) and `AGENTHUB_HOME=…` for a test copy, like the other terminal hints; otherwise the bare name.
    public static func grantCommand(hub: HubInfo?) -> String {
        func q(_ v: String) -> String { v.range(of: #"^[A-Za-z0-9_./:@%+=-]+$"#, options: .regularExpression) != nil ? v : "'" + v.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        guard let cli = hub?.cli, !cli.isEmpty else { return "agenthub awake grant" }
        let home = hub.flatMap { h in h.testMode ? h.home.map { "AGENTHUB_HOME=\(q($0)) " } : nil } ?? ""
        return "\(home)env -u NODE_OPTIONS node \(q(cli)) awake grant"
    }

    /// Added to the hint of the greyed row: what a click on it does.
    public static var clickCopies: String { tr("Щелчок по строке копирует эту команду.", "A click on the row copies this command.") }

    /// Title of the icon menu item while the hub has no rights: a click copies the grant command instead of switching.
    public static var menuCopies: String {
        tr("Не спать с закрытой крышкой — скопировать команду", "Stay awake with the lid closed — copy the command")
    }

    /// The row's title right after that click.
    public static var copied: String { tr("Команда скопирована", "Command copied") }

    public static func help(threshold: Int) -> String {
        tr("Компьютер не уснёт, когда крышка закрыта, — сессии продолжат работать. На батарее хаб сам вернёт сон, когда заряд упадёт ниже \(threshold)%.",
           "The computer stays awake when the lid is closed, so sessions keep working. On battery the hub brings sleep back by itself once the charge drops below \(threshold)%.")
    }

    public static func notGranted(hub: HubInfo?) -> String {
        tr("Хабу не выданы права на этот переключатель. Выполните в Терминале: \(grantCommand(hub: hub))",
           "The hub hasn't been given the rights for this switch. Run in Terminal: \(grantCommand(hub: hub))")
    }

    public static func onWithoutRights(threshold: Int, hub: HubInfo?) -> String {
        tr("Режим включён, но прав у хаба нет: он не сможет вернуть сон, когда заряд упадёт ниже \(threshold)%. Выдайте права в Терминале: \(grantCommand(hub: hub))",
           "It's on, but the hub has no rights: it can't bring sleep back when the charge drops below \(threshold)%. Grant them in Terminal: \(grantCommand(hub: hub))")
    }

    /// The card in Settings: what the mode does and where it is switched. Nothing to set there.
    public static func about(threshold: Int) -> String {
        tr("Пока режим включён, компьютер не засыпает с закрытой крышкой. На батарее хаб следит за зарядом и, когда он упадёт ниже \(threshold)%, сам возвращает обычный сон, чтобы батарея не села. Включается в окне хаба у значка в строке меню и в панели.",
           "While it's on, the computer doesn't sleep with the lid closed. On battery the hub watches the charge and brings normal sleep back once it drops below \(threshold)%, so the battery doesn't run flat. Turn it on in the hub's menu bar window or in the panel.")
    }

    /// The line added to the menu bar icon's tooltip while the flag is on.
    public static var iconNote: String { tr("Компьютер не уснёт с закрытой крышкой", "The computer stays awake with the lid closed") }

    /// "Now: …" in Settings; nil — the daemon doesn't know the power source.
    public static func power(_ info: AwakeInfo) -> String? {
        guard let onBattery = info.onBattery else { return nil }
        if !onBattery { return tr("Сейчас: питание от сети", "Now: on power") }
        return info.charge.map { tr("Сейчас: от батареи, заряд \($0)%", "Now: on battery, \($0)% charge") } ?? tr("Сейчас: от батареи", "Now: on battery")
    }

    /// Why the switch wasn't changed (the daemon's code); nil — not one of this feature's codes.
    public static func error(_ code: String?) -> String? {
        guard let code, Explain.awakeCodes.contains(code) else { return nil }
        return Explain.known(code, label: AwakeRow.title)
    }
}

/// What `POST /awake` answered. A refusal carries the section too: after one the daemon checks the rights again, so
/// the row turns grey at once instead of waiting for the event.
public struct AwakeReply: Equatable, Sendable {
    public var status: Int
    /// The daemon's refusal code; nil for 200.
    public var code: String?
    /// The section as it is now; nil — the reply has none (an older daemon; the `awake` event brings it).
    public var awake: AwakeInfo?

    public var ok: Bool { status == 200 }

    public init(status: Int, code: String? = nil, awake: AwakeInfo? = nil) {
        self.status = status; self.code = code; self.awake = awake
    }

    public init(status: Int, body: Data) {
        struct Body: Decodable { var awake: AwakeInfo? }
        self.init(status: status, code: status == 200 ? nil : HubClient.errorCode(body),
                  awake: (try? JSONDecoder().decode(Body.self, from: body))?.awake)
    }
}

/// `--demo-awake <off|on|unavailable|on-unavailable>`: a made-up section for snapshots of the switch in each look without
/// a daemon. The app then shows a ready state through a client that reaches nothing (`HubClient(detached:)`): a click
/// on the made-up switch or quitting sends nothing to whatever daemon runs in that directory. Only for a test copy
/// (`--home`, `AGENTHUB_HOME`): the live hub never shows a made-up switch.
public enum AwakeDemo {
    public static let argument = "--demo-awake"

    public static func info(named name: String) -> AwakeInfo? {
        switch name {
        case "off": return AwakeInfo(on: false, onBattery: false, charge: 100)
        case "on": return AwakeInfo(on: true, onBattery: true, charge: 64)
        case "unavailable": return AwakeInfo(granted: false, on: false, onBattery: false, charge: 100)
        case "on-unavailable": return AwakeInfo(granted: false, on: true, onBattery: true, charge: 64)
        default: return nil
        }
    }

    public static func info(arguments: [String] = CommandLine.arguments,
                            environment: [String: String] = ProcessInfo.processInfo.environment,
                            liveHome: String = HubPaths.defaultHome) -> AwakeInfo? {
        guard let i = arguments.firstIndex(of: argument), i + 1 < arguments.count else { return nil }
        guard !samePlace(HubPaths.home(arguments: arguments, environment: environment), liveHome) else { return nil }
        return info(named: arguments[i + 1])
    }

    /// Whether two paths name one directory: through symbolic links, `..`, a trailing slash and another letter case
    /// (the usual macOS volume ignores it; on one that doesn't, two such directories are taken for one — the careful side).
    static func samePlace(_ a: String, _ b: String) -> Bool {
        func canonical(_ path: String) -> String {
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath()
            // the path as the volume spells it; a directory that isn't there yet has only the resolved one
            let real = (try? url.resourceValues(forKeys: [.canonicalPathKey]))?.canonicalPath ?? url.path
            return real.precomposedStringWithCanonicalMapping.lowercased()
        }
        return canonical(a) == canonical(b)
    }
}
