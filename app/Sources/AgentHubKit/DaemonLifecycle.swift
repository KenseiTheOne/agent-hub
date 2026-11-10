import Foundation

// Daemon and app lifecycle (decision 2026-11-06): "If the hub is dead but the daemon is alive, the daemon restores the hub. Closing
// the hub closes the daemon too."
//
// - Quitting the app ("Quit Agent Hub", ⌘Q, logout) → `POST /shutdown`: the daemon stops normally
//   with code 0, and launchd (KeepAlive.SuccessfulExit = false) does not restart it.
//   An unpinned build (class other than app) does not stop the daemon — the daemon would reject its `/shutdown` (403).
// - The app starts and there is no daemon (launchd does not keep it after a normal exit) → the app brings the
//   job up itself: `launchctl print gui/<uid>/com.kensei.agenthub` (is it loaded) → `launchctl kickstart …` and waits for
//   the socket. The job is not loaded — the banner "hub service not installed: agenthub install". Only for the default
//   directory: launchd does not bring up a test copy (`--home`, `AGENTHUB_HOME`), its daemon is started by hand.

/// Whether anyone listens on the daemon socket: no file or the connection is refused (the daemon exited or crashed) — no.
public enum DaemonProbe {
    public static func listening(_ path: String) -> Bool {
        var st = stat()
        guard lstat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFSOCK else { return false }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return true } // nothing to check with — assume it is there
        defer { close(fd) }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return true }
        withUnsafeMutableBytes(of: &addr.sun_path) { buf in
            for (i, b) in bytes.enumerated() { buf[i] = b }
            buf[bytes.count] = 0
        }
        let r = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        return r == 0
    }
}

/// Runner of an external command (`launchctl`). In tests — a double that records the calls.
public protocol CommandRunner: Sendable {
    /// → exit code (-1 — could not launch).
    func run(_ executable: String, _ arguments: [String]) async -> Int32
}

/// A real launch via `Process`, without a shell; output is discarded.
public struct ProcessRunner: CommandRunner {
    public init() {}

    public func run(_ executable: String, _ arguments: [String]) async -> Int32 {
        await withCheckedContinuation { (cont: CheckedContinuation<Int32, Never>) in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = arguments
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            p.terminationHandler = { cont.resume(returning: $0.terminationStatus) }
            do { try p.run() } catch { cont.resume(returning: -1) }
        }
    }
}

/// The outcome of an attempt to bring the daemon up.
public enum DaemonStartOutcome: Sendable, Equatable {
    /// `kickstart` succeeded — the job is started (or was already running).
    case started
    /// The job is not in launchd: `agenthub install --apply` was not run (or `uninstall` was).
    case notInstalled
    /// `kickstart` returned an error.
    case failed(Int32)
    /// A test copy (non-default directory) — launchd is not touched.
    case skipped
}

/// Bring up the daemon's LaunchAgent if its process is not there.
public struct DaemonStarter: Sendable {
    public static let label = "com.kensei.agenthub"
    public static let launchctl = "/bin/launchctl"

    public let home: String
    public let defaultHome: String
    public let uid: uid_t
    public let runner: any CommandRunner

    public init(home: String, defaultHome: String = HubPaths.defaultHome, uid: uid_t = getuid(), runner: any CommandRunner = ProcessRunner()) {
        self.home = home
        self.defaultHome = defaultHome
        self.uid = uid
        self.runner = runner
    }

    /// `gui/<uid>/com.kensei.agenthub`.
    public var service: String { "gui/\(uid)/\(Self.label)" }

    /// Default directory only: launchd brings up the live hub, not a test copy.
    public var enabled: Bool {
        (home as NSString).standardizingPath == (defaultHome as NSString).standardizingPath
    }

    public func start() async -> DaemonStartOutcome {
        guard enabled else { return .skipped }
        // print: is the job loaded (no — code 113 "Could not find service")
        if await runner.run(Self.launchctl, ["print", service]) != 0 { return .notInstalled }
        // without -k: a running daemon is not restarted, a stopped one is started
        let code = await runner.run(Self.launchctl, ["kickstart", service])
        return code == 0 ? .started : .failed(code)
    }
}

/// An attempt to bring the daemon up — for the connection banner.
public enum DaemonLaunchState: Sendable, Equatable {
    case idle
    case starting
    case notInstalled
    case failed(Int32)

    /// Title of the "no connection" banner.
    public var offlineTitle: String {
        switch self {
        case .idle: return tr("Нет связи со службой хаба — переподключаюсь сам", "Lost connection to the hub service — reconnecting")
        case .starting: return tr("Запускаю службу хаба…", "Starting the hub service…")
        case .notInstalled: return tr("Служба хаба не установлена: задания launchd нет", "The hub service isn't installed: no launchd job")
        case .failed(let c): return tr("Не удалось запустить службу хаба (launchctl, код \(c)) — переподключаюсь сам", "Couldn't start the hub service (launchctl, code \(c)) — reconnecting")
        }
    }

    /// What the human should do; nil — the detail from the connection error. No daemon — /state.hub.cli is unknown: the CLI is looked up in
    /// the hub directory's install (Versions/current), otherwise — the repository working copy.
    public var offlineHint: String? { offlineHint(home: HubPaths.home()) }

    public func offlineHint(home: String, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> String? {
        guard self == .notInstalled else { return nil }
        return ReinstallHint.text(hub: nil, home: home, fileExists: fileExists)
    }
}

/// The result of asking the daemon to exit when the app quits.
public enum QuitShutdown: Sendable, Equatable {
    /// 202 — the daemon is stopping.
    case requested
    /// Not asked: this copy is not pinned (class other than app), no connection, or a diagnostic exit.
    case skipped
    /// The daemon answered otherwise (403 etc.) or did not answer.
    case failed(String)
}

/// When quitting the app asks the daemon to exit, and when startup brings the daemon up.
public enum QuitPolicy {
    /// Keys of diagnostic launches (snapshots, self-checks, icon output). The same list as APP_DIAGNOSTIC_ARGS in
    /// daemon/lib/peer.mjs: the daemon does not treat such a process as the app for supervision (its exit is not a crash).
    public static let diagnosticArguments: Set<String> = [
        "--quit-after-snapshot", "--snapshot-panel", "--snapshot-menubar", "--print-status-item", "--show-popover", "--snapshot-popover", "--snapshot-consent",
        "--self-test-popover", "--self-test-status-menu",
    ]

    /// Diagnostic launches that exit on their own (snapshots, self-checks) neither bring the daemon up nor stop it.
    public static func isDiagnostic(arguments: [String]) -> Bool {
        arguments.contains { diagnosticArguments.contains($0) }
    }

    /// Whether to bring the daemon up if it is not there (`DaemonStarter`): not for a diagnostic launch — otherwise a snapshot against
    /// the default directory would bring up the live daemon.
    public static func startsDaemon(arguments: [String]) -> Bool {
        !isDiagnostic(arguments: arguments)
    }

    /// Whether to quit right away (`.terminateNow`), without the asynchronous `/shutdown`: a diagnostic launch or a quit for a hub
    /// update (`hub-update.restarting`) — the daemon restarts itself (code 75), nothing to wait for.
    public static func terminateNow(hubRestarting: Bool, arguments: [String]) -> Bool {
        hubRestarting || isDiagnostic(arguments: arguments)
    }

    /// Whether to ask for `/shutdown`: class app (or not yet known — the daemon decides) and not a diagnostic launch.
    public static func shouldStopDaemon(peer: PeerInfo?, arguments: [String]) -> Bool {
        !isDiagnostic(arguments: arguments) && peer?.isApp != false
    }
}

// MARK: - "Launch at login" (decision 2026-11-07)
//
// The toggle in Settings controls the daemon + app pair and is stored in the daemon (`settings.json →
// launchAtLogin`, `PUT /settings/launch-at-login`, app only). At login launchd brings the pair up
// (the daemon's RunAtLoad), and the daemon launches the app after 2 s; when off, the daemon waits for the app and exits. The app's own
// registration in Login Items (`SMAppService.mainApp`, the former toggle) is no longer needed:
// the app would launch at login even with the setting off, and with it on — by a second route. So it is
// removed — but only when the daemon will surely launch the app itself: after the first state snapshot, if the daemon knows
// the setting (`state.launchAtLogin` is present — it is not older than app supervision), the pin has a build path
// (`appPin.path` — without it the daemon does not launch the app) and the LaunchAgent is installed. Otherwise the registration stays
// (it launches the app at login, as before), and the "run agenthub pin-app" banner says what is missing.

/// Whether to remove the old `SMAppService.mainApp` registration.
public enum LegacyLoginItem {
    /// Yes — if it exists (`.enabled` or `.requiresApproval`), the launch is not diagnostic (snapshot, self-check),
    /// the hub directory is the default (a test copy — `--home`, `AGENTHUB_HOME` — does not touch the live hub's system
    /// settings) and the daemon will launch the app at login itself (`daemonLaunchesApp`).
    public static func shouldUnregister(registered: Bool, arguments: [String], home: String, defaultHome: String = HubPaths.defaultHome, state: HubState?) -> Bool {
        registered && !QuitPolicy.isDiagnostic(arguments: arguments)
            && (home as NSString).standardizingPath == (defaultHome as NSString).standardizingPath
            && daemonLaunchesApp(state)
    }

    /// The daemon will launch the app at login: it knows "Launch at login", the pin has a build path, the LaunchAgent
    /// is installed (not `missing`). No snapshot yet — no.
    public static func daemonLaunchesApp(_ state: HubState?) -> Bool {
        guard let state, let login = state.launchAtLogin else { return false }
        guard let path = state.appPin?.path, !path.isEmpty else { return false }
        return login.launchAgent != "missing"
    }
}

/// A pin without a build path (`appPin.path`): the daemon will neither restart a crashed app nor launch it at login
/// — the fallback "bundle of the last connection" no longer exists (decision 2026-11-07). A banner with the `agenthub pin-app` command.
public enum PinPathHint {
    /// Whether to show it: the build is pinned (cdhash or certificate), but there is no path.
    public static func needed(_ pin: AppPinInfo?) -> Bool {
        guard let pin, pin.kind != "none" else { return false }
        return (pin.path ?? "").isEmpty
    }

    /// Command: the full path to the daemon CLI (`/state.hub.cli`, otherwise `agenthub`), `AGENTHUB_HOME=…` — if the hub is not in the default
    /// directory; the bundle — this copy's, only if it is the pinned one (class app), otherwise — a placeholder.
    public static func command(hub: HubInfo?, bundlePath: String?) -> String {
        func q(_ v: String) -> String { v.range(of: #"^[A-Za-z0-9_./:@%+=-]+$"#, options: .regularExpression) != nil ? v : "'" + v.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let cli = hub?.cli.map(q) ?? "agenthub"
        let home = hub.flatMap { h in h.testMode ? h.home.map { "AGENTHUB_HOME=\(q($0)) " } : nil } ?? ""
        let app = bundlePath.map(q) ?? tr("<путь к AgentHub.app>", "<path to AgentHub.app>")
        return "\(home)env -u NODE_OPTIONS node \(cli) pin-app \(app)"
    }
}

/// The daemon's LaunchAgent is old (`/state.launchAtLogin.launchAgent = "outdated"`, KeepAlive true — a plist from before 2026-11-06):
/// "Launch at login" does not work with it; the toggle is disabled with this hint.
public enum LaunchAgentHint {
    public static var text: String { text(hub: nil) }

    public static func text(hub: HubInfo?, home: String = HubPaths.home(), fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> String {
        tr("Служба хаба установлена со старым LaunchAgent: при выключенной настройке она поднималась бы снова, а закрыть хаб было бы нельзя. Переустановите её. ",
           "The hub service uses an old LaunchAgent: with this setting off it would keep restarting, and the hub couldn't be closed. Reinstall it. ")
            + ReinstallHint.text(hub: hub, home: home, fileExists: fileExists)
    }
}

/// How to reinstall the launchd job. A hub from an install (`Versions/current`, the installer's path) — rerun the
/// installer (the same version is repaired without a rebuild) or the installed version's CLI by full path; such a person may not
/// even have an agent-hub working copy. A hub from the repository — its CLI (full path from `/state.hub.cli`).
public enum ReinstallHint {
    /// CLI: `/state.hub.cli` (daemon connected), otherwise the CLI of the hub directory's installed version, otherwise nil.
    public static func cli(hub: HubInfo?, home: String, fileExists: (String) -> Bool) -> String? {
        if let c = hub?.cli, !c.isEmpty { return c }
        let p = (home as NSString).appendingPathComponent("Versions/current/src/daemon/bin/agenthub")
        return fileExists(p) ? p : nil
    }

    /// Path for the shell: the home directory as "$HOME" (inside double quotes a tilde would not expand).
    static func shellPath(_ p: String, userHome: String = NSHomeDirectory()) -> String {
        if !userHome.isEmpty, p.hasPrefix(userHome + "/") {
            let rest = String(p.dropFirst(userHome.count))
            return rest.range(of: #"^[A-Za-z0-9_./ :@%+=-]+$"#, options: .regularExpression) != nil ? "\"$HOME\(rest)\"" : "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'"
        }
        return p.range(of: #"^[A-Za-z0-9_./:@%+=-]+$"#, options: .regularExpression) != nil ? p : "'" + p.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    public static func text(hub: HubInfo?, home: String, fileExists: (String) -> Bool, userHome: String = NSHomeDirectory()) -> String {
        let env = hub.flatMap { h in h.testMode ? h.home.map { "AGENTHUB_HOME=\(shellPath($0, userHome: userHome)) " } : nil } ?? ""
        guard let cli = cli(hub: hub, home: home, fileExists: fileExists) else {
            return tr("Из папки репозитория agent-hub: env -u NODE_OPTIONS node daemon/bin/agenthub install --apply",
                      "From the agent-hub repository folder: env -u NODE_OPTIONS node daemon/bin/agenthub install --apply")
        }
        let cmd = "\(env)env -u NODE_OPTIONS node \(shellPath(cli, userHome: userHome)) install --apply"
        if cli.contains("/Versions/") {
            return tr("Запустите установщик ещё раз (bash install.sh — та же версия чинится без пересборки) или в Терминале: \(cmd)",
                      "Run the installer again (bash install.sh — the same version is repaired without a rebuild) or in Terminal: \(cmd)")
        }
        return tr("В Терминале: \(cmd)", "In Terminal: \(cmd)")
    }
}
