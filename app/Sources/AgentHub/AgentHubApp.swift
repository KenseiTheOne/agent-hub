import AgentHubKit
import AppKit
import Observation
import ServiceManagement
import SwiftUI

/// Launch arguments (for manual checks; a normal launch has none).
///   --home <dir>              daemon directory (otherwise AGENTHUB_HOME, otherwise ~/Library/Application Support/AgentHub)
///   --open-panel              open the panel right away; prints `panel-window-id=<N>` for `screencapture -l`
///   --snapshot-panel <png>    wait for a live snapshot and save an image of the panel window (own window, no screen recording permission);
///                             prints `first-responder=<class>[ field-editor] key=<bool>` (a text field that took focus by itself)
///   --quit-after-snapshot     quit after the snapshot
///   --reopen-panel            with --open-panel/--snapshot-panel: once the state is live, close the panel and open it
///                             again (a reopen from the popover: the content exists at the window's first display)
///   --tooltip <text part>     with --snapshot-panel: print the window's hints (`tooltip=x,y,w,h <text>`) and draw the
///                             hint card whose text contains this part in the snapshot (`HoverTip`, `TipWindow`,
///                             `TooltipProbe`), under its element; if not found, `tooltip-error=not-found`
///   --panel-section <section> panel section on open: sessions | launch | manager | journal | settings | plugin:<id>
///   --manager-tab catalog     open "Catalog" in the plugin manager right away (screenshots)
///   --panel-width <pt>        panel window width on open (narrow layout check; no narrower than the 960 minimum)
///   --panel-height <pt>       panel window height on open (snapshots of long sections, such as Settings)
///   --settings-focus hub-update  Settings scrolled to the "Hub updates" card (like "Details" from the popover; snapshots)
///   --settings-focus notifications  Settings scrolled to the "Notifications" card (snapshots)
///   --settings-focus connections    Settings scrolled to the "Connections" card (snapshots)
///   --settings-focus terminal       Settings scrolled to the "Terminal" card (snapshots)
///   --show-popover            show the popover content in a separate window; prints `popover-window-id=<N>`
///   --demo-cards              show two synthetic cards in "Answers" (screenshots only; they cannot be answered)
///   --demo-sessions           add synthetic sessions (effort, ultracode, one per terminal), for screenshots only
///   --snapshot-menubar <png>  draw the menu bar icon in every state on a light and a dark bar (synthetic,
///                             no screen recording permission) and quit
///   --print-status-item       print `statusitem-window-id=<N>` and the icon tooltip (`screencapture -l <N>`)
///   --snapshot-popover <png>  show the popover as a window (like --show-popover), wait for a live snapshot, save an image
///                             (own window, no screen recording permission) and quit
///   --idle-expanded           the "Can I shut down" card in the popover starts expanded (snapshots)
///   --arrange-plugins         the panel sidebar starts in the plugin rearranging mode (snapshots)
///   --open-tile <plugin id>   the popover starts with that plugin's tile expanded (its detail card; snapshots)
///   --snapshot-report <png>   draw the "It didn't work" window with sample content and quit (synthetic; nothing is run)
///   --snapshot-confirm <png>  draw the "Update the hub?" confirmation with sample content and quit (synthetic); with
///                             --confirm-sample <plugin|plugin-input|plugin-input-unplaced|plugin-fix:<parent row>|plugin-hostile|plugin-cost-community|cost|input|prompt|rollback|registry-key|expired> another window of the same kind instead:
///                             a core confirmation with a cost and a live countdown, the same with a text field, the
///                             text field alone, a plugin rollback, the "accept the new registry key?" window with
///                             two sample keys (--confirm-cost is the old spelling of `cost`)
///   --snapshot-consent <png>  capture the consent window and quit (own window, no screen recording permission): from the
///                             first request for an own plugin (`POST /registry/own/approve` without a token installs
///                             nothing) or, with --consent-install <id>, from `POST /registry/install` (an update with
///                             permission growth); needs the pinned build (class app). The daemon treats such a launch as
///                             diagnostic (peer.diagnostic): it installs or changes nothing; without permission growth it
///                             is 409 consent:nothing, not an install; a human's window is not reset
///
/// The keys that make a launch diagnostic (snapshots, self-checks) are read in one place, `DiagnosticLaunch` in the Kit,
/// next to their list `QuitPolicy.diagnosticArguments` — this file takes them from there and never spells them in code.
struct LaunchOptions {
    var openPanel = false
    var section: PanelSection?
    var snapshotPath: String?
    var quitAfterSnapshot = false
    var showPopover = false
    var demoCards = false
    var managerCatalog = false
    var panelWidth: CGFloat?
    var panelHeight: CGFloat?
    var menubarSnapshot: String?
    var printStatusItem = false
    var demoSessions = false
    var popoverSnapshot: String?
    var idleExpanded = false
    var arrangePlugins = false
    var openTile: String?
    var settingsFocus: String?
    var consentSnapshot: String?
    var reportSnapshot: String?
    var confirmSnapshot: String?
    var consentInstall: String?
    var confirmSample: String?
    var selfTestPopover = false
    var selfTestStatusMenu = false
    var tooltip: String?
    var reopenPanel = false

    static let current: LaunchOptions = {
        let a = CommandLine.arguments
        var o = LaunchOptions()
        let d = DiagnosticLaunch(arguments: a)
        o.snapshotPath = d.snapshotPanel
        o.openPanel = a.contains("--open-panel") || d.snapshotPanel != nil
        o.quitAfterSnapshot = d.quitAfterSnapshot
        o.reopenPanel = a.contains("--reopen-panel")
        o.popoverSnapshot = d.snapshotPopover
        o.showPopover = d.showPopover || d.snapshotPopover != nil
        o.demoCards = a.contains("--demo-cards")
        o.demoSessions = a.contains("--demo-sessions")
        if let i = a.firstIndex(of: "--manager-tab"), i + 1 < a.count { o.managerCatalog = a[i + 1] == "catalog" }
        o.menubarSnapshot = d.snapshotMenubar
        o.printStatusItem = d.printStatusItem
        o.idleExpanded = a.contains("--idle-expanded")
        o.arrangePlugins = a.contains("--arrange-plugins")
        if let i = a.firstIndex(of: "--open-tile"), i + 1 < a.count { o.openTile = a[i + 1] }
        o.confirmSnapshot = d.snapshotConfirm
        o.reportSnapshot = d.snapshotReport
        o.consentSnapshot = d.snapshotConsent
        o.selfTestPopover = d.selfTestPopover
        o.selfTestStatusMenu = d.selfTestStatusMenu
        if let i = a.firstIndex(of: "--confirm-sample"), i + 1 < a.count { o.confirmSample = a[i + 1] } else if a.contains("--confirm-cost") { o.confirmSample = "cost" }
        if let i = a.firstIndex(of: "--consent-install"), i + 1 < a.count { o.consentInstall = a[i + 1] }
        if let i = a.firstIndex(of: "--tooltip"), i + 1 < a.count { o.tooltip = a[i + 1] }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "hub-update" { o.settingsFocus = SettingsView.Anchor.hubUpdate }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "notifications" { o.settingsFocus = SettingsView.Anchor.notifications }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "connections" { o.settingsFocus = SettingsView.Anchor.connections }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "terminal" { o.settingsFocus = SettingsView.Anchor.terminal }
        if let i = a.firstIndex(of: "--panel-width"), i + 1 < a.count, let w = Double(a[i + 1]) { o.panelWidth = max(PanelMetrics.minWindowWidth, CGFloat(w)) }
        if let i = a.firstIndex(of: "--panel-height"), i + 1 < a.count, let h = Double(a[i + 1]) { o.panelHeight = max(400, min(4000, CGFloat(h))) }
        if let i = a.firstIndex(of: "--panel-section"), i + 1 < a.count {
            o.section = PanelSection(argument: a[i + 1])
        }
        return o
    }()
}

/// Where to open the panel (from the popover, a notification's "Open", a launch argument).
@MainActor
@Observable
final class PanelRouter {
    var section: PanelSection?
    /// Which Settings card to scroll to on open (`SettingsView.Anchor`); cleared once scrolled.
    var settingsFocus: String?
    /// The openWindow action from the scene (only a SwiftUI view can provide it); the popover and notifications call through it.
    @ObservationIgnored var openWindowAction: OpenWindowAction?
    /// The MenuBarExtra popover window (.window style), to close it before opening another window.
    @ObservationIgnored weak var popoverWindow: NSWindow?

    func open(_ section: PanelSection?) {
        closePopover()
        if let section { self.section = section }
        openWindowAction?(id: PanelWindow.id)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Close the menu bar popover if it is open. It closes the same way as a click on the icon
    /// (the NSStatusItem button), so SwiftUI knows the popover is closed and the next click opens it again.
    /// The screenshot window (`--show-popover`) is not the popover and is left alone.
    func closePopover() {
        guard let w = popoverWindow, w.isVisible, !LaunchOptions.current.showPopover else { return }
        // a click on our own icon button takes the same path as a human: SwiftUI closes the popover and remembers it
        // (calling orderOut/close on the window directly broke its state: the next icon click did not open the popover)
        StatusItemTip.statusButton()?.performClick(nil)
        if w.isVisible { w.orderOut(nil) }
    }
}

/// Shared app objects: socket client, store, the hub's windows (presenter), notifications, panel router.
@MainActor
final class AppModel {
    static let shared = AppModel()

    let store: HubStore
    let presenter = AlertPresenter()
    let router = PanelRouter()
    /// The icon's context menu (right click, ⌃-click).
    let statusMenu: StatusItemMenu
    private(set) var notifier: Notifier?
    private var popoverWindow: NSWindow?

    private init() {
        let socketPath = HubPaths.socketPath()
        // memory of test stands that no longer exist (hubLang:/pinNoteAck:/… of deleted /tmp directories) and the old
        // bundle-wide keys, before anything uses them
        HubDefaults.prune(keep: socketPath)
        // language without a daemon connection: the last effective one for this hub, not the macOS language
        L10n.shared.remember(socketPath: socketPath)
        store = HubStore(client: HubClient(socketPath: socketPath))
        store.rememberPluginOrder()
        store.presenter = presenter
        statusMenu = StatusItemMenu(store: store, router: router)
        router.section = LaunchOptions.current.section
        router.settingsFocus = LaunchOptions.current.settingsFocus
        // Notifications only in a built .app (UNUserNotificationCenter crashes without a bundle).
        if Bundle.main.bundleIdentifier != nil {
            let n = Notifier(store: store) { [router] target in
                switch target {
                case .plugin(let id): router.open(PanelSection.plugin(id).resolved)
                case .manager: router.open(.manager)
                case .sessions: router.open(.sessions)
                }
            }
            notifier = n
            store.onNotify = { [weak n] note in n?.show(note) }
            store.onLanguageChange = { [weak n, store] in
                n?.registerCategory()
                if LaunchOptions.current.demoCards { store.showDemoCards(DemoCards.all) }
                if LaunchOptions.current.demoSessions { store.showDemoSessions(DemoSessions.all) }
            }
        }
        if LaunchOptions.current.demoCards { store.showDemoCards(DemoCards.all) }
        // No daemon (after a normal exit launchd does not keep it running): start the job with `launchctl kickstart`.
        // Default directory only: DaemonStarter leaves a test copy (--home, AGENTHUB_HOME) alone. And not for a
        // diagnostic launch (snapshots, self-checks, --print-status-item): it quits by itself.
        if QuitPolicy.startsDaemon(arguments: CommandLine.arguments) { store.daemonStarter = DaemonStarter(home: HubPaths.home()) }
        // "Launch at login" is now a daemon setting for the daemon + app pair (decision 2026-11-07): at login the daemon
        // launches the app. The old Login Items registration would launch it a second way, even with the setting off,
        // so remove it, but only based on a state snapshot showing that the daemon will launch the app itself
        // (LegacyLoginItem.daemonLaunchesApp; live hub only and not a diagnostic launch).
        store.onSnapshot = { state in LegacyLoginItemCleanup.run(state: state) }
        // The hub is switching to another version (`hub-update.restarting`, docs/hub-updates.md): quit without /shutdown,
        // the daemon restarts from the new version and launches the new app itself. Diagnostic launches do not quit.
        // terminate runs on the next main loop pass, not inside the stream event handler: otherwise the nested terminate
        // loop spins inside a main-thread task and quitting hangs until SIGTERM from the daemon.
        if !QuitPolicy.isDiagnostic(arguments: CommandLine.arguments) { store.onHubRestart = { DispatchQueue.main.async { NSApp.terminate(nil) } } }
        store.start()
        statusMenu.install()
        if LaunchOptions.current.openPanel { Task { await reportPanelWindow() } }
        if LaunchOptions.current.showPopover { Task { await showPopoverWindow() } }
        if let path = LaunchOptions.current.consentSnapshot { Task { await snapshotConsent(to: path) } }
        if let path = LaunchOptions.current.confirmSnapshot { Task { await snapshotConfirm(to: path) } }
        if let path = LaunchOptions.current.reportSnapshot { Task { await snapshotReport(to: path) } }
        if let path = LaunchOptions.current.menubarSnapshot { Task { MenuBarSnapshot.write(to: path); NSApp.terminate(nil) } }
        if LaunchOptions.current.printStatusItem { Task { await printStatusItem() } }
        if LaunchOptions.current.demoSessions { store.showDemoSessions(DemoSessions.all) }
        #if DEBUG
        // Popover close self-check (debug build only): click the icon → popover open → Settings from the router →
        // popover closed, panel open → click again → popover open. The clicks happen in-process
        // (performClick on our own button), without the Accessibility permission.
        if LaunchOptions.current.selfTestPopover { Task { await selfTestPopover() } }
        // Icon context menu self-check: right click (and ⌃-click) → menu, popover closed → a left click opens the
        // popover again. The clicks are events posted to our own process queue, without the Accessibility permission.
        if LaunchOptions.current.selfTestStatusMenu { Task { await selfTestStatusMenu() } }
        #endif
    }

    #if DEBUG
    private func selfTestPopover() async {
        for _ in 0..<100 where StatusItemTip.statusButton() == nil { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .milliseconds(1000))
        var out: [String] = []
        for cycle in 1...3 {
            StatusItemTip.statusButton()?.performClick(nil)
            var shown = false
            for _ in 0..<25 { try? await Task.sleep(for: .milliseconds(80)); if router.popoverWindow?.isVisible == true { shown = true; break } }
            out.append("c\(cycle):click→\(shown ? "open" : "closed")")
            router.open(cycle == 2 ? .manager : .settings)
            try? await Task.sleep(for: .milliseconds(900))
            out.append("c\(cycle):open-window→popover \(router.popoverWindow?.isVisible == true ? "open" : "closed"), panel \(panelWindow()?.isVisible == true ? "shown" : "hidden")")
        }
        print("selftest " + out.joined(separator: " | "))
        fflush(stdout)
        NSApp.terminate(nil)
    }

    private func selfTestStatusMenu() async {
        for _ in 0..<100 where StatusItemTip.statusButton() == nil { try? await Task.sleep(for: .milliseconds(100)) }
        for _ in 0..<50 where !store.connection.isLive { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .milliseconds(1000))
        let m = statusMenu
        m.autoCancelAfter = 0.6
        func popover() -> Bool { router.popoverWindow?.isVisible == true }
        func wait(_ cond: () -> Bool) async -> Bool {
            for _ in 0..<30 { if cond() { return true }; try? await Task.sleep(for: .milliseconds(80)) }
            return cond()
        }
        var out: [String] = []
        var ok = true
        for cycle in 1...3 {
            // rounds 1 and 3: menu over an open popover; round 2: with it closed
            if cycle != 2 {
                StatusItemTip.statusButton()?.performClick(nil)
                let shown = await wait(popover)
                ok = ok && shown
                out.append("c\(cycle):click→\(shown ? "open" : "closed")")
            }
            let before = m.openCount
            let ctrl = cycle == 3
            m.postClick(right: !ctrl, control: ctrl, up: false)
            let opened = await wait { m.openCount > before }
            m.postClick(right: !ctrl, control: ctrl, up: true)
            let atOpen = m.popoverVisibleAtOpen
            let closed = await wait { !m.isOpen }
            try? await Task.sleep(for: .milliseconds(400))
            let after = popover()
            ok = ok && opened && !atOpen && closed && !after
            out.append("c\(cycle):\(ctrl ? "ctrl-click" : "right-click")→menu \(opened ? "shown" : "none") [\(m.lastTitles.joined(separator: ", "))], popover at menu \(atOpen ? "open" : "closed"), after \(after ? "open" : "closed")")
            // the main point: after the menu a left click opens the popover again
            StatusItemTip.statusButton()?.performClick(nil)
            let again = await wait(popover)
            out.append("c\(cycle):click→\(again ? "open" : "closed")")
            StatusItemTip.statusButton()?.performClick(nil)
            let shut = await wait { !popover() }
            ok = ok && again && shut
        }
        // the "Pause hub" item is the same action as the button; after it the menu offers "Resume hub"
        // (a debug build cannot resume: only the pinned build can, which is checked manually on the bundle)
        if !store.estop {
            m.performItem(at: 1)
            let paused = await wait { store.estop }
            let before = m.openCount
            m.postClick(right: true, up: false)
            _ = await wait { m.openCount > before }
            m.postClick(right: true, up: true)
            _ = await wait { !m.isOpen }
            // an unpinned (debug) build cannot resume: the item is there but disabled, "(Resume hub)"
            let resume = tr("Снять паузу", "Resume hub")
            ok = ok && paused && m.lastTitles.contains(store.canAct ? resume : "(\(resume))")
            out.append("pause-item→estop \(paused ? "on" : "off"), menu [\(m.lastTitles.joined(separator: ", "))]")
        }
        print("selftest-status-menu \(ok ? "ok" : "FAIL") " + out.joined(separator: " | "))
        fflush(stdout)
        NSApp.terminate(nil)
    }
    #endif

    /// The icon button's window (for `screencapture -l`) and its tooltip, after the scene has rendered.
    private func printStatusItem() async {
        for _ in 0..<100 where !(store.connection.isLive && store.state != nil) { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .milliseconds(1200))
        let w = StatusItemTip.statusButton()?.window
        print("statusitem-window-id=\(w.map { String($0.windowNumber) } ?? "none")")
        print("statusitem-frame=\(w.map { NSStringFromRect($0.frame) } ?? "none")")
        print("statusitem-tooltip=\((StatusItemTip.current ?? "none").replacingOccurrences(of: "\n", with: " | "))")
        fflush(stdout)
    }

    /// `--reopen-panel`: close the panel once the state is live and open it again, the way a human reopens it from the
    /// popover — the page content already exists at the window's first display (where AppKit picks a first responder).
    private func reopenPanel() async {
        for _ in 0..<100 where !(panelWindow()?.isVisible == true && store.connection.isLive && store.state != nil) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        try? await Task.sleep(for: .milliseconds(800))
        panelWindow()?.close()
        for _ in 0..<50 where panelWindow()?.isVisible == true { try? await Task.sleep(for: .milliseconds(100)) }
        try? await Task.sleep(for: .milliseconds(300))
        router.open(LaunchOptions.current.section)
        print("panel-reopened")
        fflush(stdout)
    }

    private func panelWindow() -> NSWindow? {
        NSApp.windows.first { ($0.identifier?.rawValue ?? "").hasPrefix(PanelWindow.id) || $0.title == "Agent Hub" }
    }

    private func reportPanelWindow() async {
        if LaunchOptions.current.reopenPanel { await reopenPanel() }
        for _ in 0..<100 {
            if let w = panelWindow(), w.isVisible {
                // a size set for snapshots (and a test copy's window) does not become the live hub's panel size
                if !HubDefaults.autosavesPanelFrame() { w.setFrameAutosaveName("") }
                if LaunchOptions.current.panelWidth != nil || LaunchOptions.current.panelHeight != nil {
                    w.setContentSize(NSSize(width: LaunchOptions.current.panelWidth ?? w.contentLayoutRect.width, height: LaunchOptions.current.panelHeight ?? w.contentLayoutRect.height))
                    try? await Task.sleep(for: .milliseconds(300))
                }
                print("panel-window-id=\(w.windowNumber)")
                printWindowChrome(w)
                fflush(stdout)
                if let path = LaunchOptions.current.snapshotPath { await snapshot(w, to: path, tooltip: LaunchOptions.current.tooltip) }
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        print("panel-window-id=none")
        fflush(stdout)
    }

    /// For manual layout checks: the traffic light button frames (in window coordinates, origin at the top left)
    /// and the window corner radius, if the system reports it.
    private func printWindowChrome(_ w: NSWindow) {
        let h = w.frame.height
        for (name, kind) in [("close", NSWindow.ButtonType.closeButton), ("mini", .miniaturizeButton), ("zoom", .zoomButton)] {
            guard let b = w.standardWindowButton(kind), let sv = b.superview else { continue }
            let r = sv.convert(b.frame, to: nil)
            print("panel-button-\(name)=x:\(Int(r.minX)) y:\(Int(h - r.maxY)) w:\(Int(r.width)) h:\(Int(r.height))")
        }
        if w.responds(to: NSSelectorFromString("_cornerRadius")), let r = w.value(forKey: "_cornerRadius") as? CGFloat {
            print("panel-corner-radius=\(r)")
        }
    }

    /// The menu bar popover only opens on a click (there is no programmatic way without the Accessibility permission), so
    /// for a screenshot the same content is shown in a borderless window with the same glass.
    private func showPopoverWindow() async {
        for _ in 0..<100 where store.state == nil { try? await Task.sleep(for: .milliseconds(100)) }
        let host = NSHostingView(rootView: PopoverView(store: store, router: router).frame(width: PopoverView.width))
        let size = host.fittingSize
        let w = KeyPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.hasShadow = true
        w.isMovableByWindowBackground = true
        w.contentView = host
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        popoverWindow = w
        try? await Task.sleep(for: .milliseconds(800))
        print("popover-window-id=\(w.windowNumber)")
        fflush(stdout)
        if let path = LaunchOptions.current.popoverSnapshot {
            // the content may have grown after the first frame (a verdict, an expanded card), so size the window to it
            try? await Task.sleep(for: .milliseconds(700))
            w.setContentSize(host.fittingSize)
            await snapshot(w, to: path, quit: true)
        }
    }

    /// Consent window snapshot (`--snapshot-consent`): the window the presenter shows, by the same path as for a human.
    /// The request comes from the daemon: to a diagnostic launch it answers only with the window (428) and never
    /// installs, not even an update without permission growth (then 409 consent:nothing and snapshot-error=no-consent).
    private func snapshotConsent(to path: String) async {
        for _ in 0..<100 where !(store.connection.isLive && store.state != nil) { try? await Task.sleep(for: .milliseconds(100)) }
        await store.loadRegistry()
        var req: ConsentRequest?
        if let id = LaunchOptions.current.consentInstall {
            if case .needsConsent(let r)? = try? await store.client.registryInstall(id) { req = r }
        } else if let q = store.ownRequests.first, case .needsConsent(let r)? = try? await store.client.registryOwnApprove(q.requestId) {
            req = r
        }
        guard let req else {
            print("snapshot-error=no-consent")
            fflush(stdout)
            NSApp.terminate(nil)
            return
        }
        // the list settles after the first frame (the "scrolled to the end" mark), so the window is sized again
        await snapshotWindow(to: path, settle: .milliseconds(600)) { [presenter] in _ = await presenter.consent(req) }
    }

    /// `--snapshot-report`: the refusal window with every part filled in — for looking at the layout without a real refusal.
    private func snapshotReport(to path: String) async {
        let sample = Report(
            title: tr("В строке ввода есть текст", "There's text in the input line"),
            detail: tr("Пример окна: ничего не запускалось.", "A sample window: nothing was run."),
            rows: [
                Report.Row(label: tr("Действие", "Action"), value: tr("Набрать команду во вкладке", "Type a command into the tab")),
                Report.Row(label: tr("Вкладка", "Tab"), value: tr("релиз 0.1.6", "release 0.1.6"), note: tr("терминал, рабочее пространство 3", "terminal, workspace 3")),
                Report.Row(label: tr("Хотел набрать", "Wanted to type"), value: "/model claude-opus-5-5, /effort medium"),
            ],
            hint: tr("Сотрите или отправьте текст во вкладке и нажмите «Повторить».", "Clear or send the text in the tab and press \"Try again\"."),
            code: "prompt-not-empty · 3f0f76ea-b6e4-4e45-97f0-aed028912915", canFocus: true, canRetry: true)
        await snapshotWindow(to: path) { [presenter] in _ = await presenter.report(sample) }
    }

    /// `--snapshot-confirm`: the confirmation window with every part filled in (a hub update), or — `--confirm-sample` —
    /// another window of the same kind: a core confirmation with a cost and its countdown, the same with a text field,
    /// the text field alone, a plugin rollback, the "timed out" notice, the registry key window (sample keys: a diagnostic launch is refused
    /// `POST /registry/key/accept`, so there is no real answer to draw). For looking at the layout without asking
    /// anything for real.
    private func snapshotConfirm(to path: String) async {
        let action = tr("Запустить прогон", "Start a run")
        let cost = ConfirmRequest(token: "", level: .confirmCost,
                                  text: tr("Пример окна: «Запустить прогон» для задачи T-1. Ничего не запускается.", "A sample window: \"Start a run\" for task T-1. Nothing is run."),
                                  cost: tr("тратит квоту Claude", "uses Claude quota"), expiresInMs: 60_000, row: tr("T-1 · починить вход", "T-1 · fix sign-in"))
        let field = OfferInput(placeholder: tr("Что сделать", "What to do"), maxLength: 80)
        let sample = LaunchOptions.current.confirmSample ?? ""
        if sample == "plugin-cost-community" || sample == "plugin-cost-community-unwarned" {
            // a community plugin's confirm-cost action that says "free, local only" about itself (task 124): the hub keeps
            // its own warning next to those words; -unwarned draws it as 0.1.8 did, the hub's line gone
            var req = ConfirmRequest(token: "", level: .confirmCost, text: "", expiresInMs: 104_000)
            req.parts = ConfirmParts(plugin: "Handy Tools", tier: tr("плагин сообщества", "community plugin"),
                                     title: tr("Синхронизировать заметки", "Sync the notes"), command: "handy.5m.mjs --action sync",
                                     costNet: sample == "plugin-cost-community"
                                         ? tr("Команда может тратить ресурсы или выходить в сеть", "The command may use resources or access the network") : nil,
                                     note: tr("бесплатно, только локально", "free, local only"), notePlugin: true)
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.confirm(req, actionLabel: "Sync") }
            return
        }
        if sample == "plugin-hostile" {
            // a community plugin that names its action like the hub's own window (task 123): quoted, and said to be its
            var req = ConfirmRequest(token: "", level: .confirm, text: "", expiresInMs: 104_000)
            req.parts = ConfirmParts(plugin: "Handy Tools", tier: tr("плагин сообщества", "community plugin"),
                                     title: "Update the hub?", command: "handy.5m.mjs --action run")
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.confirm(req, actionLabel: "Update") }
            return
        }
        if sample.hasPrefix("plugin-fix:") {
            // a "Fix" button under a tab row (task 122): "Where" is the parent row the core sent, resolved the way the
            // store resolves it
            let parent = String(sample.dropFirst("plugin-fix:".count))
            var req = ConfirmRequest(token: "", level: .confirm, text: "", expiresInMs: 104_000)
            let parts = ConfirmParts(plugin: tr("Пример плагина", "Sample plugin"), tier: tr("официальный плагин", "official plugin"),
                                     title: tr("Починить", "Fix it"), command: "sample.30s.mjs --action fix", row: "Fix", parentRow: parent)
            req.parts = parts
            req = req.placed(sessions: [], actionLabel: "Fix")
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.confirm(req, actionLabel: "Fix") }
            return
        }
        switch LaunchOptions.current.confirmSample {
        case "plugin":
            // a plugin action by parts: the title is the action, rows say where and what the plugin warns about
            var req = ConfirmRequest(token: "", level: .confirmCost, text: "", expiresInMs: 104_000)
            req.parts = ConfirmParts(plugin: tr("Пример плагина", "Sample plugin"), tier: tr("официальный плагин", "official plugin"),
                                     title: tr("Привести вкладку к базе: набрать /model и /effort", "Bring the tab to the base: type /model and /effort"),
                                     command: "sample.30s.mjs --action apply 0f3c1a2b-5d6e-4f70-8a9b-c0d1e2f3a4b5",
                                     note: tr("из хаба не отменить: прежние модель и effort вкладки вернёте только вы", "can't be undone from the hub: only you can bring back the tab's previous model and effort"),
                                     notePlugin: true)
            req.place = tr("my-project · «релиз»", "my-project · \"release\"")
            req.placeNote = tr("терминал, вкладка 3", "terminal, tab 3")
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.confirm(req, actionLabel: tr("Привести", "Fix")) }
        case "plugin-input", "plugin-input-unplaced":
            // a plugin action that asks for text, by parts: "Where" names the session's tab (task 125); the -unplaced
            // spelling draws it as 0.1.8 did, without the place, for a before/after
            var req = ConfirmRequest(token: "", level: .confirm, text: "", expiresInMs: 104_000, input: field)
            req.parts = ConfirmParts(plugin: tr("Пример плагина", "Sample plugin"), tier: tr("официальный плагин", "official plugin"),
                                     title: tr("Отправить текст в сессию", "Send text to the session"),
                                     command: "sample.30s.mjs --action send 0f3c1a2b-5d6e-4f70-8a9b-c0d1e2f3a4b5")
            if LaunchOptions.current.confirmSample == "plugin-input" {
                req.place = tr("my-project · «релиз»", "my-project · \"release\"")
                req.placeNote = tr("терминал, вкладка 3", "terminal, tab 3")
            }
            await snapshotWindow(to: path) { [presenter] in
                _ = await presenter.prompt(InputPrompt(actionLabel: tr("Отправить", "Send"), input: field, confirm: req, text: tr("запусти тесты", "run the tests")))
            }
        case "cost":
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.confirm(cost, actionLabel: action) }
        case "input":
            await snapshotWindow(to: path) { [presenter] in
                _ = await presenter.prompt(InputPrompt(actionLabel: action, input: field, confirm: cost, text: tr("починить вход", "fix sign-in")))
            }
        case "prompt":
            // the text the core has just refused, with its reason under the field
            await snapshotWindow(to: path) { [presenter] in
                _ = await presenter.prompt(InputPrompt(actionLabel: action, input: field, text: "T 1", error: InputCheck.message("input:pattern")))
            }
        case "expired":
            await snapshotWindow(to: path) { await HubWindow.expiredNotice() }
        case "rollback":
            await snapshotWindow(to: path) { _ = await RollbackWindow.ask(title: tr("Пример", "Sample"), from: "1.4.0", to: "1.3.2") }
        case "registry-key":
            // the key window as the daemon's 428 fills it (a diagnostic launch may not ask for the real one: 403 peer:diagnostic)
            let sample = RegistryKeyConsent(token: "", expiresInMs: 120_000, change: RegistryKeyChange(
                registry: "default", trust: "official",
                was: RegistryKeyRef(keyId: "9F3A61C2D05B7E44", fingerprint: "5d1c0a7f3b9e42618ac4f0d27be19a63"),
                now: RegistryKeyRef(keyId: "C41E08B7A2F6D935", fingerprint: "e8a27b40c96f1d53b07a4e92d1c85f3e"),
                since: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-900))))
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.registryKey(sample) }
        default:
            var req = ConfirmRequest(token: "", level: .confirm, text: "", title: tr("Обновить хаб до 0.2.0?", "Update the hub to 0.2.0?"), button: tr("Обновить", "Update"),
                                     details: tr("тег v0.2.0 · коммит 1a2b3c4", "tag v0.2.0 · commit 1a2b3c4"))
            req.layout = ConfirmLayout(
                subtitle: "0.1.9 → 0.2.0",
                heading: tr("Пример окна: ничего не устанавливается", "A sample window: nothing is installed"),
                points: [tr("Первая строка описания выпуска: что изменилось для человека.", "The first line of the release description: what changed for the human."),
                         tr("Вторая строка — подлиннее, чтобы было видно, как переносится текст в списке и где встаёт точка.", "The second line is longer, to show how text wraps in the list and where the dot goes."),
                         tr("Третья строка.", "The third line.")],
                warnings: [tr("Это смена старшей версии (0.1.9 → 0.2.0).", "This is a major version change (0.1.9 → 0.2.0).")],
                note: tr("Хаб соберёт версию отдельно (несколько минут), проверит её и перезапустится в неё. При ошибке останется на 0.1.9.",
                         "The hub builds this version separately (a few minutes), checks it and restarts into it. On error it stays on 0.1.9."))
            let update = req
            await snapshotWindow(to: path) { [presenter] in _ = await presenter.confirm(update, actionLabel: action) }
        }
    }

    /// Draw a hub window for a snapshot key: `ask` opens it exactly as for a human (the presenter, `HubWindow`), and the
    /// window that came up on screen is what gets captured — no second way to build one.
    private func snapshotWindow(to path: String, settle: Duration = .zero, _ ask: @escaping @MainActor () async -> Void) async {
        Task { await ask() }
        for _ in 0..<100 where HubWindow.current == nil { try? await Task.sleep(for: .milliseconds(20)) }
        guard let w = HubWindow.current else {
            print("snapshot-error=no-window")
            fflush(stdout)
            NSApp.terminate(nil)
            return
        }
        if settle > .zero {
            try? await Task.sleep(for: settle)
            HubWindow.refit(w)
        }
        await snapshot(w, to: path, quit: true)
    }

    /// A snapshot of our own window via cacheDisplay, without the Screen Recording permission.
    private func snapshot(_ w: NSWindow, to path: String, quit: Bool = false, tooltip: String? = nil) async {
        for _ in 0..<100 where !(store.connection.isLive && store.state != nil) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        try? await Task.sleep(for: .milliseconds(1500))
        // who has the keyboard when the window shows: a text field's editor here means it grabbed focus by itself
        let fr = w.firstResponder
        print("first-responder=\(fr.map { String(describing: type(of: $0)) } ?? "none")\((fr as? NSTextView)?.isFieldEditor == true ? " field-editor" : "") key=\(w.isKeyWindow)")
        guard let view = w.contentView?.superview ?? w.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        var out: NSBitmapImageRep = rep
        if let probe = tooltip {
            // the window's hints as a list; the one containing probe as its card under its element
            let tips = TooltipProbe.tips(in: w)
            // the window shows tooltips even in an inactive app (the stand runs in the background, like the panel over a terminal)
            print("tooltips-inactive=\(w.allowsToolTipsWhenApplicationIsInactive) app-active=\(NSApp.isActive)")
            for t in tips { print("tooltip=\(Int(t.rect.minX)),\(Int(view.bounds.height - t.rect.maxY)),\(Int(t.rect.width)),\(Int(t.rect.height)) \(t.text)") }
            // the first left to right, top to bottom: for identical texts this picks the sidebar item where the line is truncated
            let ordered = tips.sorted { ($0.rect.minX, -$0.rect.maxY) < ($1.rect.minX, -$1.rect.maxY) }
            if let hit = ordered.first(where: { $0.text.contains(probe) }), let img = TooltipProbe.render(hit.text, above: hit.above) {
                let size = view.bounds.size
                let k = CGFloat(rep.pixelsWide) / max(size.width, 1)
                let canvas = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: rep.pixelsWide, pixelsHigh: rep.pixelsHigh, bitsPerSample: 8,
                                              samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
                if let canvas, let ctx = NSGraphicsContext(bitmapImageRep: canvas) {
                    // the image context is in pixels: everything is drawn with the screen scale k
                    NSGraphicsContext.saveGraphicsState()
                    NSGraphicsContext.current = ctx
                    rep.draw(in: NSRect(x: 0, y: 0, width: CGFloat(rep.pixelsWide), height: CGFloat(rep.pixelsHigh)))
                    // as `TipWindow` places it: centered above a bar column, or like at a pointer slightly right of the
                    // element's start and below it
                    let m = TipBubbleView.snapshotMargin
                    var origin = hit.above ? NSPoint(x: hit.rect.midX - img.size.width / 2, y: hit.rect.maxY + 2 - m)
                                           : NSPoint(x: hit.rect.minX + 14 - m, y: hit.rect.minY - img.size.height - 2 + m)
                    origin.x = min(origin.x, size.width - img.size.width - 4)
                    origin.y = max(origin.y, 4)
                    let box = NSRect(x: origin.x * k, y: origin.y * k, width: img.size.width * k, height: img.size.height * k)
                    // the card draws its own background and border
                    img.draw(in: box)
                    NSGraphicsContext.restoreGraphicsState()
                    canvas.size = size
                    out = canvas
                }
                print("tooltip-shown=\(hit.text)")
            } else {
                print("tooltip-error=not-found")
            }
            fflush(stdout)
        }
        if let png = out.representation(using: .png, properties: [:]) {
            do {
                try png.write(to: URL(fileURLWithPath: path))
                print("snapshot=\(path)")
            } catch {
                print("snapshot-error=\(error.localizedDescription)")
            }
            fflush(stdout)
        }
        if quit || LaunchOptions.current.quitAfterSnapshot { NSApp.terminate(nil) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // LSUIElement: no Dock icon; the panel opens from the popover
        NSApp.setActivationPolicy(.accessory)
    }

    /// Every quit (the "Quit Agent Hub" item in the icon menu and the popover, ⌘Q, logging out) goes through here:
    /// "closing the hub closes the daemon too". The pinned build asks the daemon to exit (`POST /shutdown`,
    /// waiting at most 2 s for the reply), the daemon exits with code 0, and launchd does not restart it. Diagnostic
    /// launches (snapshots, self-checks) and an unpinned copy leave the daemon alone.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        MainActor.assumeIsolated {
            // a hub window still open is answered "cancelled": whoever awaits it goes on (and stops) instead of hanging
            HubWindow.closeAll()
            if QuitPolicy.isDiagnostic(arguments: CommandLine.arguments) { return .terminateNow }
            let store = AppModel.shared.store
            // quitting for a hub update (`hub-update.restarting`): no /shutdown needed (the daemon restarts itself, code 75),
            // nothing to wait for, so quit right away. .terminateLater with a task would not wait for it here: the main
            // thread is busy with the nested terminate loop (quitting hung until SIGTERM from the daemon).
            if QuitPolicy.terminateNow(hubRestarting: store.hubRestarting, arguments: CommandLine.arguments) {
                store.stop()
                return .terminateNow
            }
            Task { @MainActor in
                _ = await store.shutdownDaemonOnQuit()
                sender.reply(toApplicationShouldTerminate: true)
            }
            return .terminateLater
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}

struct AgentHubApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    private let store = AppModel.shared.store
    private let router = AppModel.shared.router

    var body: some Scene {
        // The popover (.window style), as in the prototype: plugin tiles, "Needs you", Panel/Session/Pause hub capsules.
        MenuBarExtra {
            PopoverView(store: store, router: router)
        } label: {
            MenuBarLabel(store: store, router: router)
        }
        .menuBarExtraStyle(.window)

        Window("Agent Hub", id: PanelWindow.id) {
            PanelView(store: store, router: router)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1180, height: 760)
    }
}

/// Remove the app's old Login Items registration (`SMAppService.mainApp`): "Launch at login" is now stored
/// by the daemon, and the daemon launches the app at login (decision 2026-11-07). When to remove it: `LegacyLoginItem`.
enum LegacyLoginItemCleanup {
    @MainActor private static var done = false

    @MainActor static func run(state: HubState) {
        guard !done else { return }
        let status = SMAppService.mainApp.status
        let registered = status == .enabled || status == .requiresApproval
        if !registered { done = true; return }
        guard LegacyLoginItem.shouldUnregister(registered: registered, arguments: CommandLine.arguments, home: HubPaths.home(), state: state) else { return }
        done = true
        do {
            try SMAppService.mainApp.unregister()
            NSLog("AgentHub: legacy login item unregistered — the hub service launches the app at login now")
        } catch {
            NSLog("AgentHub: couldn't unregister the legacy login item: \(error.localizedDescription)")
        }
    }
}
