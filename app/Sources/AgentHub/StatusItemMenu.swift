import AgentHubKit
import AppKit

/// Context menu of the menu bar icon — right click or ⌃-click: "Panel", "Pause hub" / "Resume hub",
/// "Quit Agent Hub". MenuBarExtra doesn't know about right clicks, so a local event monitor catches a click
/// on the window of its own NSStatusItem button and swallows it (the popover doesn't open), and the menu is shown with
/// `NSMenu.popUp` under the button. A left click without ⌃ passes through the monitor as is — SwiftUI opens the popover.
@MainActor
final class StatusItemMenu: NSObject, NSMenuDelegate {
    private let store: HubStore
    private let router: PanelRouter
    private var monitor: Any?
    private var showing = false
    private weak var tracking: NSMenu?

    /// For self-test: whether the menu is open, how many times it opened, whether the popover was visible when it opened, the items.
    private(set) var isOpen = false
    private(set) var openCount = 0
    private(set) var popoverVisibleAtOpen = false
    private(set) var lastTitles: [String] = []
    /// Self-test: close the menu by itself this many seconds after opening.
    var autoCancelAfter: TimeInterval?

    init(store: HubStore, router: PanelRouter) {
        self.store = store
        self.router = router
    }

    func install() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .rightMouseUp, .leftMouseDown, .leftMouseUp]) { [weak self] event in
            let swallow = MainActor.assumeIsolated { self?.handle(event) ?? false }
            return swallow ? nil : event
        }
    }

    /// true — the event is swallowed (it won't reach the icon button).
    private func handle(_ event: NSEvent) -> Bool {
        guard let w = event.window, String(describing: type(of: w)).contains("StatusBar"),
              let button = StatusItemTip.statusButton(), button.window === w,
              button.bounds.contains(button.convert(event.locationInWindow, from: nil)) else { return false }
        let ctrl = event.modifierFlags.contains(.control)
        switch event.type {
        case .rightMouseDown:
            break
        case .leftMouseDown where ctrl:
            break
        case .rightMouseUp:
            return true
        case .leftMouseUp where ctrl:
            return true
        default:
            return false
        }
        // the menu comes after returning from the monitor: popUp runs its own tracking loop
        Task { @MainActor [weak self] in self?.show() }
        return true
    }

    private func show() {
        guard !showing, let button = StatusItemTip.statusButton() else { return }
        showing = true
        defer { showing = false }
        router.closePopover()
        let menu = build()
        button.highlight(true)
        // the point is the menu's top-left corner in button coordinates: slightly below its bottom edge, like status item menus
        let y = button.isFlipped ? button.bounds.maxY + 5 : button.bounds.minY - 5
        menu.popUp(positioning: nil, at: NSPoint(x: button.bounds.minX, y: y), in: button)
        button.highlight(false)
    }

    private func build() -> NSMenu {
        let m = NSMenu()
        m.autoenablesItems = false
        m.delegate = self
        item(m, tr("Панель", "Panel"), #selector(openPanel))
        // the same action as the "Pause hub" / "Resume hub" button (PauseHubButton): pausing only while connected
        // the intent is fixed when the menu is built: while it's open the pause state may change (terminal, ESTOP file),
        // and clicking "Pause hub" must not lift it (togglePause takes representedObject, not store.estop)
        let resume = store.estop
        let pause = item(m, resume ? tr("Снять паузу", "Resume hub") : tr("Пауза хаба", "Pause hub"), #selector(togglePause(_:)))
        pause.representedObject = NSNumber(value: !resume)
        // only the pinned build can resume
        pause.isEnabled = resume ? store.canAct : store.connection.isLive
        pause.toolTip = resume ? (store.canAct ? resumeHubHelp : ActionBlock.notPinned.help) : pauseHubHelp
        m.addItem(.separator())
        item(m, tr("Выйти из Agent Hub", "Quit Agent Hub"), #selector(quit))
        return m
    }

    @discardableResult
    private func item(_ m: NSMenu, _ title: String, _ action: Selector) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
        i.target = self
        m.addItem(i)
        return i
    }

    @objc private func openPanel() { router.open(nil) }

    /// Pause or resume — as the item said when the menu was opened.
    @objc private func togglePause(_ sender: NSMenuItem) {
        guard let on = (sender.representedObject as? NSNumber)?.boolValue else { return }
        Task { await store.setEstop(on) }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    func menuWillOpen(_ menu: NSMenu) {
        isOpen = true
        tracking = menu
        openCount += 1
        popoverVisibleAtOpen = router.popoverWindow?.isVisible == true
        lastTitles = menu.items.map { $0.isSeparatorItem ? "—" : ($0.isEnabled ? $0.title : "(\($0.title))") }
        if let t = autoCancelAfter {
            // a timer in menu tracking mode: the regular loop isn't running at this time
            let timer = Timer(timeInterval: t, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.tracking?.cancelTracking() }
            }
            RunLoop.main.add(timer, forMode: .common)
        }
    }

    func menuDidClose(_ menu: NSMenu) { isOpen = false }

    #if DEBUG
    /// Self-test: a click on its own icon button in-process (the event goes to the app queue — the same path through the
    /// monitor as a real click; no Accessibility permission). `control` — a ⌃ left click.
    func postClick(right: Bool, control: Bool = false, up: Bool) {
        guard let b = StatusItemTip.statusButton(), let w = b.window else { return }
        let p = b.convert(NSPoint(x: b.bounds.midX, y: b.bounds.midY), to: nil)
        let type: NSEvent.EventType = right ? (up ? .rightMouseUp : .rightMouseDown) : (up ? .leftMouseUp : .leftMouseDown)
        guard let e = NSEvent.mouseEvent(with: type, location: p, modifierFlags: control ? .control : [],
                                         timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                         context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return }
        NSApp.postEvent(e, atStart: false)
    }

    /// Self-test: run a menu item by index — the same selector as when chosen with the mouse.
    func performItem(at index: Int) {
        build().performActionForItem(at: index)
    }
    #endif
}
