import AgentHubKit
import AppKit
import SwiftUI

// The rows above a panel section: the connection pill, hub-wide banners (pause, no daemon, pinning, a changed
// registry key, damaged files, notifications, the hook) and the terminal bridge notice.

struct ConnectionPill: View {
    let store: HubStore

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(store.connection == .connecting ? Color.yellow : Color.red).frame(width: 7, height: 7)
            Text(store.connection == .connecting ? tr("подключаюсь…", "connecting…") : tr("хаб не отвечает", "hub not responding")).font(.system(size: 12))
        }
        .padding(.horizontal, 10).frame(height: 26)
        .background(Capsule().fill(Color.white.opacity(0.08)))
        .help({ if case .offline(let why) = store.connection { return why } else { return store.client.socketPath } }())
    }
}

/// Banners above a section: hub pause, connection, unbuilt build, a re-pin note.
struct PanelBanners: View {
    let store: HubStore
    let openJournal: () -> Void
    // per hub (socket): a test copy's "That was me" doesn't dismiss the live hub's note
    private let ackStore = AppStorage(wrappedValue: "", HubDefaults.key("pinNoteAck", socketPath: HubPaths.socketPath()))
    private let detailsStore = State(initialValue: false)
    private let notifyHiddenStore = AppStorage(wrappedValue: false, HubDefaults.key("notifyDeniedHidden", socketPath: HubPaths.socketPath()))
    private let hookHiddenStore = AppStorage(wrappedValue: false, HubDefaults.key("hookMissingHidden", socketPath: HubPaths.socketPath()))

    var body: some View {
        VStack(spacing: 8) {
            if store.estop {
                // only the pinned build can resume: an unpinned one only gets the path via the file
                Banner(fill: Color(red: 1, green: 69 / 255, blue: 58 / 255).opacity(0.16), stroke: Color(red: 1, green: 120 / 255, blue: 110 / 255).opacity(0.35),
                       icon: "pause.circle.fill", iconColor: hexColor(0xFFB3AD),
                       title: tr("Хаб на паузе — ответы, запуски и действия выключены", "Hub paused — replies, launches and actions are off"),
                       detail: store.canAct ? tr("Снять паузу можно и без приложения: удалите файл \(estopPath)", "You can also resume without the app: delete the file \(estopPath)")
                                            : tr("Снять паузу можно из закреплённой сборки или удалив файл \(estopPath)", "Resume from the pinned build, or delete the file \(estopPath)"),
                       buttons: store.canAct ? [(tr("Снять паузу", "Resume hub"), true, { Task { await store.setEstop(false) } })] : [])
                    .help(pauseHubHelp)
            }
            if case .offline(let why) = store.connection {
                // no daemon: the app brings it up itself (launchctl kickstart); no job — "agenthub install"
                Banner(fill: hexColor(0xFF9F0A, 0.14), stroke: hexColor(0xFF9F0A, 0.3), icon: "bolt.horizontal.circle", iconColor: .orange,
                       title: store.daemonLaunch.offlineTitle,
                       detail: store.daemonLaunch.offlineHint ?? why, buttons: [(RetryText.button, true, { store.reconnect() })])
            }
            // no pin at all — the red banner below covers it (pinNote); "open the pinned build" is out of place then
            if let peer = store.peer, !peer.isApp, store.state?.appPin?.kind != "none" {
                Banner(fill: hexColor(0xFFD60A, 0.12), stroke: hexColor(0xFFD60A, 0.3), icon: "lock.trianglebadge.exclamationmark", iconColor: .yellow,
                       title: tr("Эта копия приложения не закреплена — ответы, запуски и остановки недоступны",
                                 "This copy of the app isn't pinned — replies, launches and stops are unavailable"),
                       detail: PinAdvice.shared.openPinned + " " + tr("Подробности: класс «\(peer.class)»", "Details: class \"\(peer.class)\"") + (peer.reason.map { ", \($0)" } ?? ""), buttons: [])
            }
            pinNote
            registryKeys
            damagedFiles
            notificationsDenied
            hookMissing
        }
    }

    /// A registry's key in `config.json` is not the one the hub accepted (`/state.registryKeys`): a row per registry.
    /// Not dismissable — it goes away when the key is accepted or put back. The pinned build opens the key window;
    /// another copy only names the ways to accept.
    @ViewBuilder private var registryKeys: some View {
        ForEach(store.registryKeyChanges) { k in
            let canAccept = store.canAct && k.now != nil
            Banner(fill: hexColor(0xFF9F0A, 0.14), stroke: hexColor(0xFF9F0A, 0.3), icon: "key.horizontal.fill", iconColor: .orange,
                   title: RegistryKeyText.bannerTitle(k), detail: RegistryKeyText.bannerDetail(k, canAccept: store.canAct),
                   buttons: (canAccept ? [(RegistryKeyText.review, true, { Task { await store.acceptRegistryKey(k.registry) } })] : [])
                       + [(tr("Журнал", "Log"), false, openJournal)],
                   detailLines: 4)
        }
    }

    /// No verified hook event has ever reached this hub (`/state.hook`): a quiet row with the install command.
    /// "Dismiss" is remembered per hub; Settings → Hub service keeps saying it.
    @ViewBuilder private var hookMissing: some View {
        if HookText.shows(store.state?.hook, hidden: hookHiddenStore.wrappedValue) {
            HookNotice(hook: store.state?.hook) { hookHiddenStore.wrappedValue = true }
        }
    }

    /// macOS does not let this app show notifications: a quiet row with the way to System Settings. "Dismiss" is
    /// remembered per hub; Settings → Notifications keeps saying it.
    @ViewBuilder private var notificationsDenied: some View {
        if NotifyPermissionText.shows(NotifyPermissionModel.shared.status, hubEnabled: store.state?.notifications?.enabled, hidden: notifyHiddenStore.wrappedValue) {
            Banner(fill: Color.white.opacity(0.06), stroke: Color.white.opacity(0.1), icon: "bell.slash", iconColor: .white.opacity(0.7),
                   title: NotifyPermissionText.title, detail: NotifyPermissionText.detail,
                   buttons: [(NotifyPermissionText.button, true, { NotifyPermissionModel.openSystemSettings() }),
                             (NotifyPermissionText.hide, false, { notifyHiddenStore.wrappedValue = true })],
                   detailLines: 3)
        }
    }

    /// State files the daemon could not read when it started (`/state.damagedFiles`): one row per file — which file,
    /// where its copy is, what to do. The row stays until the daemon restarts (that is when the fact goes away).
    @ViewBuilder private var damagedFiles: some View {
        ForEach(store.state?.damagedFiles ?? []) { d in
            let text = DamagedFileText.detail(d, home: store.home, restartCommand: DaemonStarter(home: store.home).restartCommand)
            Banner(fill: hexColor(0xFF9F0A, 0.14), stroke: hexColor(0xFF9F0A, 0.3), icon: "doc.badge.ellipsis", iconColor: .orange,
                   title: DamagedFileText.title(d),
                   detail: [text, DamagedFileText.reason(d)].compactMap { $0 }.joined(separator: "\n"),
                   buttons: [(tr("Показать в Finder", "Show in Finder"), false, {
                       NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: DamagedFileText.revealPath(d, home: store.home))])
                   }), (tr("Журнал", "Log"), false, openJournal)],
                   detailLines: 6)
        }
    }

    /// The pause file next to the hub socket (the hub directory), with ~ in place of the home folder.
    private var estopPath: String {
        let dir = (store.client.socketPath as NSString).deletingLastPathComponent
        return ((dir as NSString).appendingPathComponent("ESTOP") as NSString).abbreviatingWithTildeInPath
    }

    @ViewBuilder private var pinNote: some View {
        if let pin = store.state?.appPin {
            if pin.kind == "none" {
                Banner(fill: hexColor(0xFF453A, 0.14), stroke: hexColor(0xFF453A, 0.35), icon: "exclamationmark.shield", iconColor: .red,
                       title: tr("Приложение не закреплено — подтверждения не работают", "App isn't pinned — confirmations won't work"),
                       detail: PinAdvice.shared.repairOnly, buttons: [(tr("Журнал", "Log"), false, openJournal)])
            } else if PinPathHint.needed(pin) {
                // decision 2026-11-07: without appPin.path the daemon doesn't restart the app (there's no fallback path)
                let cmd = PinPathHint.command(hub: store.state?.hub, bundlePath: store.peer?.isApp == true ? Bundle.main.bundlePath : nil)
                Banner(fill: hexColor(0xFF9F0A, 0.14), stroke: hexColor(0xFF9F0A, 0.3), icon: "arrow.clockwise.circle", iconColor: .orange,
                       title: tr("Хаб не знает, откуда запускать приложение: после падения и при входе в систему оно не запустится. Выполните agenthub pin-app",
                                 "The hub doesn't know where to launch the app from: it won't start after a crash or at login. Run agenthub pin-app"),
                       detail: cmd,
                       buttons: [(tr("Скопировать", "Copy"), true, {
                           NSPasteboard.general.clearContents()
                           NSPasteboard.general.setString(cmd, forType: .string)
                       }), (tr("Журнал", "Log"), false, openJournal)])
            }
            // the pin change was made by the hub update itself, and the install confirms it — the result is already in the "Updated
            // to …" line, a "rebuilt and pinned" note adds nothing (someone else's change with the same by — the note stays)
            if pin.kind != "none", pin.isRecent(), ackStore.wrappedValue != pin.ackKey, !HubUpdateText.pinChangeIsOwnUpdate(pin, store.hubUpdate) {
                let when = pin.changedDate.map(Fmt.dateTime) ?? "?"
                let head = pin.kind == "cert" ? tr("Закреплено по сертификату", "Pinned by certificate")
                    : pin.isFirstPin ? tr("Приложение закреплено", "App pinned") : tr("Приложение пересобрано и закреплено", "App rebuilt and pinned")
                VStack(alignment: .leading, spacing: 6) {
                    Banner(fill: Color.white.opacity(0.06), stroke: Color.white.opacity(0.1), icon: "checkmark.shield", iconColor: hexColor(0x7EE29B),
                           title: "\(head) · \(when) · \(pin.originText)", detail: nil,
                           buttons: [(tr("Это я", "It was me"), true, { ackStore.wrappedValue = pin.ackKey }), (tr("Журнал", "Log"), false, openJournal)],
                           disclosure: (tr("Подробности", "Details"), detailsStore.projectedValue,
                                        tr("Отпечаток: \(pin.shortFingerprint) · записал: \(pin.byText) · запись в журнале: app-requirement-changed",
                                           "Fingerprint: \(pin.shortFingerprint) · written by: \(pin.byText) · log entry: app-requirement-changed")))
                }
            }
        }
    }
}

struct Banner: View {
    var fill: Color
    var stroke: Color
    var icon: String
    var iconColor: Color
    var title: String
    var detail: String?
    var buttons: [(String, Bool, () -> Void)]
    var disclosure: (String, Binding<Bool>, String)? = nil
    /// How many lines the detail may take; a row whose detail is the instruction itself needs more than two.
    var detailLines: Int = 2

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(iconColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 12.5, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    if let detail { Text(detail).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).lineLimit(detailLines).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                }
                Spacer(minLength: 6)
                if let d = disclosure {
                    Button(d.0) { d.1.wrappedValue.toggle() }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))
                }
                ForEach(Array(buttons.enumerated()), id: \.offset) { _, b in
                    Button(b.0, action: b.2)
                        .buttonStyle(CapsuleStyle(fill: b.1 ? .white : .white.opacity(0.12), stroke: b.1 ? .clear : .white.opacity(0.14), text: b.1 ? .black : .white, height: 26, expand: false))
                }
            }
            if let d = disclosure, d.1.wrappedValue {
                Text(d.2).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.6)).textSelection(.enabled).padding(.leading, 25)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(RoundedRectangle(cornerRadius: 14).fill(fill))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(stroke, lineWidth: 0.5))
    }
}

/// Texts about the cmux bridge: the tooltip on the disabled "Go to" button and the banner with the launch command.
@MainActor
enum BridgeText {
    static func command(_ store: HubStore) -> String { store.state?.bridge?.launchCommand ?? "agenthub-bridge" }

    static func disabledHelp(_ store: HubStore) -> String {
        tr("Мост cmux не подключён — переход во вкладки недоступен. Запустите во вкладке cmux: \(command(store))",
           "The cmux bridge isn't connected — switching to tabs is unavailable. Run in a cmux tab: \(command(store))")
    }

    static func interruptHelp(_ store: HubStore) -> String {
        tr("Мост cmux не подключён — прервать ход (Esc во вкладке) нельзя. Запустите во вкладке cmux: \(command(store))",
           "The cmux bridge isn't connected — can't interrupt the turn (Esc in the tab). Run in a cmux tab: \(command(store))")
    }

    static func launchHelp(_ store: HubStore) -> String {
        tr("Мост cmux не подключён — запуск сессии недоступен. Запустите во вкладке cmux: \(command(store))",
           "The cmux bridge isn't connected — launching a session is unavailable. Run in a cmux tab: \(command(store))")
    }

    /// The tooltip on a disabled action button: without the bridge — with the command to start it.
    static func help(_ block: ActionBlock, primitive: String?, _ store: HubStore) -> String {
        guard block == .noBridge else { return block.help }
        switch primitive {
        case "session.interrupt": return interruptHelp(store)
        case "session.launch": return launchHelp(store)
        default: return disabledHelp(store)
        }
    }
}

/// "The hub hasn't heard from the Claude Code hook": what it means and the command that connects the hook, whole and
/// selectable, with "Copy" (the hub does not install the hook itself) and "Dismiss".
struct HookNotice: View {
    let hook: HookInfo?
    let hide: () -> Void
    private let copiedStore = State(initialValue: false)

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "link.badge.plus").font(.system(size: 14, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
                VStack(alignment: .leading, spacing: 2) {
                    Text(HookText.title).font(.system(size: 12.5, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    Text(HookText.detail(hook)).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 8) {
                Text(HookText.command(hook)).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.85))
                    .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.25)))
                Button(copiedStore.wrappedValue ? tr("Скопировано", "Copied") : tr("Скопировать", "Copy")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(HookText.command(hook), forType: .string)
                    copiedStore.wrappedValue = true
                }
                .buttonStyle(CapsuleStyle(fill: .white, stroke: .clear, text: .black, height: 26, expand: false))
                Button(NotifyPermissionText.hide, action: hide)
                    .buttonStyle(CapsuleStyle(fill: Color.white.opacity(0.14), stroke: .clear, text: .white, height: 26, expand: false))
            }
            .padding(.leading, 24)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5))
    }
}

/// The "cmux bridge not connected" banner with the launch command and "Copy". The title is about what's unavailable where
/// it appears: in the session list — "Go to tab", in the "New session" form — launching; in Settings there's no title
/// (the status line above the banner already says what's unavailable).
struct BridgeNotice: View {
    enum Place { case focus, launch, settings }
    let store: HubStore
    var place: Place = .focus
    private let copiedStore = State(initialValue: false)

    static func title(_ place: Place) -> String? {
        switch place {
        case .focus: return tr("Мост cmux не подключён — «Перейти во вкладку» недоступно для сессий в cmux", "The cmux bridge isn't connected — Go to tab is unavailable for cmux sessions")
        case .launch: return tr("Мост cmux не подключён — запуск сессии недоступен", "The cmux bridge isn't connected — launching a session is unavailable")
        case .settings: return nil
        }
    }

    var body: some View {
        let cmd = BridgeText.command(store)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 14, weight: .semibold)).foregroundStyle(.orange)
                VStack(alignment: .leading, spacing: 2) {
                    if let title = Self.title(place) {
                        Text(title).font(.system(size: 12.5, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    }
                    Text(tr("Запустите мост в отдельной вкладке cmux и закрепите её — хаб подхватит его сам:", "Start the bridge in a separate cmux tab and pin it — the hub picks it up by itself:"))
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 8) {
                Text(cmd).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.85))
                    .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.25)))
                Button(copiedStore.wrappedValue ? tr("Скопировано", "Copied") : tr("Скопировать", "Copy")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(cmd, forType: .string)
                    copiedStore.wrappedValue = true
                }
                .buttonStyle(CapsuleStyle(fill: .white, stroke: .clear, text: .black, height: 26, expand: false))
            }
            .padding(.leading, 24)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(hexColor(0xFF9F0A, 0.10)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(hexColor(0xFF9F0A, 0.28), lineWidth: 0.5))
    }
}
