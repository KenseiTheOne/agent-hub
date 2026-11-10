import AgentHubKit
import AppKit
import Observation
import ServiceManagement
import SwiftUI

/// Launch arguments (for manual checks; a normal launch has none).
///   --home <dir>              daemon directory (otherwise AGENTHUB_HOME, otherwise ~/Library/Application Support/AgentHub)
///   --open-panel              open the panel right away; prints `panel-window-id=<N>` for `screencapture -l`
///   --snapshot-panel <png>    wait for a live snapshot and save an image of the panel window (own window, no screen recording permission)
///   --quit-after-snapshot     quit after the snapshot
///   --tooltip <text part>     with --snapshot-panel: print the window's AppKit tooltips (`tooltip=x,y,w,h <text>`) and
///                             show the real tooltip whose text contains this part in the snapshot (`HoverTip`,
///                             `TooltipProbe`), under its element; if not found, `tooltip-error=not-found`
///   --panel-section <section> panel section on open: sessions | launch | manager | journal | settings | plugin:<id>
///   --manager-tab catalog     open "Catalog" in the plugin manager right away (screenshots)
///   --panel-width <pt>        panel window width on open (narrow layout check; no narrower than the 960 minimum)
///   --panel-height <pt>       panel window height on open (snapshots of long sections, such as Settings)
///   --settings-focus hub-update  Settings scrolled to the "Hub updates" card (like "Details" from the popover; snapshots)
///   --settings-focus notifications  Settings scrolled to the "Notifications" card (snapshots)
///   --settings-focus connections    Settings scrolled to the "Connections" card (snapshots)
///   --show-popover            show the popover content in a separate window; prints `popover-window-id=<N>`
///   --demo-cards              show two synthetic cards in "Answers" (screenshots only; they cannot be answered)
///   --demo-sessions           add synthetic sessions (effort, ultracode, cmux tab), for screenshots only
///   --snapshot-menubar <png>  draw the menu bar icon in every state on a light and a dark bar (synthetic,
///                             no screen recording permission) and quit
///   --print-status-item       print `statusitem-window-id=<N>` and the icon tooltip (`screencapture -l <N>`)
///   --snapshot-popover <png>  show the popover as a window (like --show-popover), wait for a live snapshot, save an image
///                             (own window, no screen recording permission) and quit
///   --idle-expanded           the "Can I shut down" card in the popover starts expanded (snapshots)
///   --snapshot-consent <png>  capture the consent window and quit (own window, no screen recording permission): from the
///                             first request for an own plugin (`POST /registry/own/approve` without a token installs
///                             nothing) or, with --consent-install <id>, from `POST /registry/install` (an update with
///                             permission growth); needs the pinned build (class app). The daemon treats such a launch as
///                             diagnostic (peer.diagnostic): it installs or changes nothing; without permission growth it
///                             is 409 consent:nothing, not an install; a human's window is not reset
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
    var settingsFocus: String?
    var consentSnapshot: String?
    var consentInstall: String?
    var tooltip: String?

    static let current: LaunchOptions = {
        let a = CommandLine.arguments
        var o = LaunchOptions()
        o.openPanel = a.contains("--open-panel")
        if let i = a.firstIndex(of: "--snapshot-panel"), i + 1 < a.count {
            o.snapshotPath = (a[i + 1] as NSString).expandingTildeInPath
            o.openPanel = true
        }
        o.quitAfterSnapshot = a.contains("--quit-after-snapshot")
        o.showPopover = a.contains("--show-popover")
        o.demoCards = a.contains("--demo-cards")
        o.demoSessions = a.contains("--demo-sessions")
        if let i = a.firstIndex(of: "--manager-tab"), i + 1 < a.count { o.managerCatalog = a[i + 1] == "catalog" }
        if let i = a.firstIndex(of: "--snapshot-menubar"), i + 1 < a.count { o.menubarSnapshot = (a[i + 1] as NSString).expandingTildeInPath }
        o.printStatusItem = a.contains("--print-status-item")
        if let i = a.firstIndex(of: "--snapshot-popover"), i + 1 < a.count {
            o.popoverSnapshot = (a[i + 1] as NSString).expandingTildeInPath
            o.showPopover = true
        }
        o.idleExpanded = a.contains("--idle-expanded")
        if let i = a.firstIndex(of: "--snapshot-consent"), i + 1 < a.count { o.consentSnapshot = (a[i + 1] as NSString).expandingTildeInPath }
        if let i = a.firstIndex(of: "--consent-install"), i + 1 < a.count { o.consentInstall = a[i + 1] }
        if let i = a.firstIndex(of: "--tooltip"), i + 1 < a.count { o.tooltip = a[i + 1] }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "hub-update" { o.settingsFocus = SettingsView.Anchor.hubUpdate }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "notifications" { o.settingsFocus = SettingsView.Anchor.notifications }
        if let i = a.firstIndex(of: "--settings-focus"), i + 1 < a.count, a[i + 1] == "connections" { o.settingsFocus = SettingsView.Anchor.connections }
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

/// Shared app objects: socket client, store, NSAlert, notifications, panel router.
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
        if let path = LaunchOptions.current.menubarSnapshot { Task { MenuBarSnapshot.write(to: path); NSApp.terminate(nil) } }
        if LaunchOptions.current.printStatusItem { Task { await printStatusItem() } }
        if LaunchOptions.current.demoSessions { store.showDemoSessions(DemoSessions.all) }
        #if DEBUG
        // Popover close self-check (debug build only): click the icon → popover open → Settings from the router →
        // popover closed, panel open → click again → popover open. The clicks happen in-process
        // (performClick on our own button), without the Accessibility permission.
        if CommandLine.arguments.contains("--self-test-popover") { Task { await selfTestPopover() } }
        // Icon context menu self-check: right click (and ⌃-click) → menu, popover closed → a left click opens the
        // popover again. The clicks are events posted to our own process queue, without the Accessibility permission.
        if CommandLine.arguments.contains("--self-test-status-menu") { Task { await selfTestStatusMenu() } }
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

    private func panelWindow() -> NSWindow? {
        NSApp.windows.first { ($0.identifier?.rawValue ?? "").hasPrefix(PanelWindow.id) || $0.title == "Agent Hub" }
    }

    private func reportPanelWindow() async {
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

    /// Consent window snapshot (`--snapshot-consent`): the same ConsentSheet as in the modal dialog, but in a window without
    /// a modal loop. The window comes from the daemon: to a diagnostic launch it answers only with the window (428) and never
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
        let host = NSHostingView(rootView: ConsentSheet(request: req, done: { _ in })
            .frame(width: 520).environment(\.colorScheme, .dark)
            .background(GlassBackground(tint: hexColor(0x282830, 0.84), radius: 26)))
        let w = KeyPanel(contentRect: NSRect(origin: .zero, size: host.fittingSize), styleMask: [.borderless], backing: .buffered, defer: false)
        w.isOpaque = false
        w.backgroundColor = .clear
        w.contentView = host
        w.setContentSize(host.fittingSize)
        w.center()
        w.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(600))
        w.setContentSize(host.fittingSize)
        await snapshot(w, to: path, quit: true)
    }

    /// A snapshot of our own window via cacheDisplay, without the Screen Recording permission.
    private func snapshot(_ w: NSWindow, to path: String, quit: Bool = false, tooltip: String? = nil) async {
        for _ in 0..<100 where !(store.connection.isLive && store.state != nil) {
            try? await Task.sleep(for: .milliseconds(100))
        }
        try? await Task.sleep(for: .milliseconds(1500))
        guard let view = w.contentView?.superview ?? w.contentView,
              let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        var out: NSBitmapImageRep = rep
        if let probe = tooltip {
            // the window's AppKit tooltips as a list; the one containing probe as a real tooltip window under its element
            let tips = TooltipProbe.tips(in: w)
            // the window shows tooltips even in an inactive app (the stand runs in the background, like the panel over a terminal)
            print("tooltips-inactive=\(w.allowsToolTipsWhenApplicationIsInactive) app-active=\(NSApp.isActive)")
            for t in tips { print("tooltip=\(Int(t.rect.minX)),\(Int(view.bounds.height - t.rect.maxY)),\(Int(t.rect.width)),\(Int(t.rect.height)) \(t.text)") }
            // the first left to right, top to bottom: for identical texts this picks the sidebar item where the line is truncated
            let ordered = tips.sorted { ($0.rect.minX, -$0.rect.maxY) < ($1.rect.minX, -$1.rect.maxY) }
            if let hit = ordered.first(where: { $0.text.contains(probe) }), let img = await TooltipProbe.render(hit.tip) {
                let size = view.bounds.size
                let k = CGFloat(rep.pixelsWide) / max(size.width, 1)
                let canvas = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: rep.pixelsWide, pixelsHigh: rep.pixelsHigh, bitsPerSample: 8,
                                              samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
                if let canvas, let ctx = NSGraphicsContext(bitmapImageRep: canvas) {
                    // the image context is in pixels: everything is drawn with the screen scale k
                    NSGraphicsContext.saveGraphicsState()
                    NSGraphicsContext.current = ctx
                    rep.draw(in: NSRect(x: 0, y: 0, width: CGFloat(rep.pixelsWide), height: CGFloat(rep.pixelsHigh)))
                    // like with a cursor: slightly right of the element's start and below it
                    var origin = NSPoint(x: hit.rect.minX + 14, y: hit.rect.minY - img.size.height - 2)
                    origin.x = min(origin.x, size.width - img.size.width - 4)
                    origin.y = max(origin.y, 4)
                    let box = NSRect(x: origin.x * k, y: origin.y * k, width: img.size.width * k, height: img.size.height * k)
                    // the tooltip window background (cacheDisplay does not capture window glass): dark, like tooltips in dark mode
                    let bg = NSBezierPath(roundedRect: box.insetBy(dx: -1 * k, dy: -1 * k), xRadius: 5 * k, yRadius: 5 * k)
                    NSColor(white: 0.16, alpha: 0.97).setFill()
                    bg.fill()
                    NSColor(white: 1, alpha: 0.18).setStroke()
                    bg.lineWidth = 0.5 * k
                    bg.stroke()
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
