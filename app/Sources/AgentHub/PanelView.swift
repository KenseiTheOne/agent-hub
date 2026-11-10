import AgentHubKit
import AppKit
import ServiceManagement
import SwiftUI

enum PanelWindow {
    static let id = "panel"
}

/// Panel sections (Panel.dc.html): "Agents" — Sessions and plugin pages; "Hub" — Log, Plugins, Settings.
/// Session replies are built into Sessions; launching is a modal over them.
enum PanelSection: Hashable {
    case sessions
    case plugin(String)
    case launch
    case manager
    case journal
    case settings

    static let overview = PanelSection.sessions
    static let responses = PanelSection.sessions

    /// The sessions plugin's page is Sessions: the plugin has no sidebar item of its own, and the reply cards and session
    /// buttons live only there. The popover tile, "Open" in a notification and "Show" on a blocker all lead there.
    var resolved: PanelSection {
        if case .plugin(let id) = self, id == NotifyTarget.sessionsPlugin { return .sessions }
        return self
    }

    /// From the `--panel-section` argument.
    init?(argument v: String) {
        switch v {
        case "overview", "sessions", "responses": self = .sessions
        case "launch": self = .launch
        case "manager", "plugins": self = .manager
        case "journal": self = .journal
        case "settings": self = .settings
        default:
            guard v.hasPrefix("plugin:") else { return nil }
            self = .plugin(String(v.dropFirst(7)))
        }
    }
}

/// Panel window layout. The window has an empty unified toolbar (`PanelChrome`): system corner radius
/// 26 pt, traffic lights at (19, 19) from the top-left corner, 14×14. The sidebar card is inset from the window edge by
/// `margin`, its radius is concentric with the window (26 − 6 = 20, `ConcentricRectangle`); the traffic lights sit inside it with a 13 pt margin
/// on top and left — the same as the menu item icons (`cardPadding` + `rowPadding`).
enum PanelMetrics {
    static let margin: CGFloat = 6
    static let cardPadding: CGFloat = 6
    static let rowPadding: CGFloat = 7
    /// Height of the traffic-light row: its center (26 pt from the window top) is mid-row.
    static let lightsRow: CGFloat = 28
    /// A gutter on the right for the page scroll bar: content and banners are inset by it, the indicator sits in it.
    static let scrollGutter: CGFloat = 14
    /// Sidebar 280 (variant C, 2026-11-06): below the name — the status in words as a second line.
    static let sidebarWidth: CGFloat = 280
    /// Minimum window width: grew from the former 900 along with the sidebar (+60), so the right part is no narrower than before.
    static let minWindowWidth: CGFloat = 960
    /// The system window radius with a unified toolbar (macOS 26; measured as `panel-corner-radius=` in --open-panel).
    static let windowRadius: CGFloat = 26
    static var cardRadius: CGFloat { windowRadius - margin }
}

/// The panel: glass, a floating sidebar, the section title in the content, banners only when needed.
struct PanelView: View {
    let store: HubStore
    let router: PanelRouter
    // @State in the macOS 27 SDK is a macro whose plugin (SwiftUIMacros) ships only with Xcode, not with the CLT.
    // So State storage is declared explicitly: the same property wrapper, without the macro.
    private let selectionStore = State<PanelSection>(initialValue: AppModel.shared.router.section.map { $0 == .launch ? .sessions : $0.resolved } ?? .sessions)
    private var selection: PanelSection { get { selectionStore.wrappedValue } nonmutating set { selectionStore.wrappedValue = newValue } }
    private let launchStore = State(initialValue: AppModel.shared.router.section == .launch)
    private var launching: Bool { get { launchStore.wrappedValue } nonmutating set { launchStore.wrappedValue = newValue } }
    private let searchStore = State(initialValue: "")

    var body: some View {
        HStack(spacing: 0) {
            Sidebar(store: store, selection: selectionStore.projectedValue)
                .frame(width: PanelMetrics.sidebarWidth)
                .padding(PanelMetrics.margin)
            VStack(alignment: .leading, spacing: 12) {
                // the manager has its own "Plugins" header with a toggle — don't duplicate the common one
                // the header and banners use the same right inset as the scroll content below, so the edges line up
                Group {
                    if selection != .manager { header }
                    PanelBanners(store: store, openJournal: { selection = .journal })
                }
                .padding(.trailing, selection == .manager ? 0 : PanelMetrics.scrollGutter)
                detail.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    // the scroll bar sits next to the cards, not over them: the content is inset from the edge,
                    // the indicator stays at the ScrollView edge (the manager has its own full-width margins)
                    .contentMargins(.trailing, selection == .manager ? 0 : PanelMetrics.scrollGutter, for: .scrollContent)
            }
            .padding(.top, 18).padding(.trailing, 20).padding(.leading, 14)
        }
        // as in the prototype: the window's traffic lights sit inside the sidebar card (a row for them in Sidebar), no title bar
        .ignoresSafeArea(.container, edges: .top)
        .frame(minWidth: PanelMetrics.minWindowWidth, minHeight: 600)
        .environment(\.colorScheme, .dark)
        // the backing covers the whole window, without its own frame or radius: the system rounds the corners (one radius, the system one)
        .background(GlassBackground(tint: hexColor(0x15151B, 0.84)).ignoresSafeArea())
        .background(PanelChrome())
        .sheet(isPresented: launchStore.projectedValue) {
            LaunchSessionView(store: store, close: { launching = false })
        }
        .onChange(of: selection) { _, new in
            store.journalVisible = (new == .journal)
            store.managerVisible = (new == .manager)
        }
        .onChange(of: router.section) { _, new in open(new) }
        .onAppear {
            open(router.section)
            store.journalVisible = (selection == .journal)
            store.managerVisible = (selection == .manager)
        }
    }

    private func open(_ s: PanelSection?) {
        guard let s = s?.resolved else { return }
        if s == .launch { selection = .sessions; launching = true } else { selection = s }
        router.section = nil
    }

    // MARK: section header

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 17, weight: .bold))
                // a plugin's desc can be longer than a line at the window's minWidth — it wraps to a second line rather than truncating
                Text(subtitle).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if !store.connection.isLive { ConnectionPill(store: store) }
            if selection == .sessions || selection == .journal {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(.secondary)
                    TextField(tr("Поиск", "Search"), text: searchStore.projectedValue).textFieldStyle(.plain).font(.system(size: 12))
                }
                .padding(.horizontal, 10).frame(width: 190, height: 28)
                .background(Capsule().fill(Color.white.opacity(0.08)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
            }
            if selection == .sessions {
                // without the bridge the form still opens: it shows how to start the bridge
                let block = store.gate(primitive: "session.launch", needsBridge: false)
                Button { launching = true } label: { Label(tr("Новая сессия", "New session"), systemImage: "plus") }
                    .buttonStyle(CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 30, expand: false))
                    .disabled(block != nil)
                    .help(block?.help ?? "")
            }
        }
    }

    private var title: String {
        switch selection {
        case .sessions, .launch: return tr("Сессии", "Sessions")
        case .plugin(let id): return store.plugin(id)?.title ?? id
        case .manager: return tr("Плагины", "Plugins")
        case .journal: return tr("Журнал", "Log")
        case .settings: return tr("Настройки", "Settings")
        }
    }

    private var subtitle: String {
        switch selection {
        case .sessions, .launch:
            // the same count as the Sessions row in the sidebar: waiting sessions and sessions with a card — by sessionId
            let w = SidebarStatus.waitingCount(store.sessions, waiting: store.waitingCount, cardSessions: store.visibleCards.map(\.sessionId))
            return SidebarStatus.sessionsSubtitle(open: store.sessions.count, waiting: w)
        case .plugin(let id):
            guard let p = store.plugin(id) else { return "" }
            return p.desc ?? p.statusLabel()
        case .manager: return tr("установленные и каталог реестра", "installed and registry catalog")
        case .journal: return tr("действия хаба", "hub actions")
        case .settings: return tr("язык, автозапуск, уведомления, подключения, обновления хаба и плагинов, мост cmux, закрепление приложения", "language, launch at login, notifications, connections, hub and plugin updates, cmux bridge, app pinning")
        }
    }

    @ViewBuilder private var detail: some View {
        let search = searchStore.wrappedValue
        switch selection {
        case .sessions, .launch: SessionsView(store: store, search: search)
        case .plugin(let id):
            if let p = store.plugin(id) { PluginDetailView(store: store, plugin: p) }
            else { ContentUnavailableView(tr("Плагин удалён или больше не запускается", "Plugin was removed or no longer runs"), systemImage: "puzzlepiece", description: Text(id)) }
        case .manager: PluginManagerView(store: store).padding(.horizontal, -20)
        case .journal: JournalView(store: store, search: search)
        case .settings: SettingsView(store: store, router: router, openJournal: { selection = .journal })
        }
    }
}

// MARK: - sidebar

struct Sidebar: View {
    let store: HubStore
    @Binding var selection: PanelSection

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // the window's traffic-light row (the system draws the buttons, `PanelMetrics`); on the right — the test copy label
            HStack {
                Spacer(minLength: Self.lightsWidth)
                // the label takes all the space to the right of the traffic lights: the test directory path is shortened only when needed
                if let t = store.testMark { TestBadge(text: t).frame(maxWidth: Self.testBadgeMaxWidth, alignment: .trailing) }
            }
            .frame(height: PanelMetrics.lightsRow)
            .padding(.bottom, 6)
            // sections and items scroll: two-line items don't get squeezed when there are many plugins, while the traffic-light
            // row at the top and "Pause hub" at the bottom stay in place
            ScrollView(.vertical) {
                VStack(alignment: .leading, spacing: 2) {
                    let live = store.connection.isLive
                    section(tr("Агенты", "Agents"))
                    row(.sessions, icon: "terminal", title: tr("Сессии", "Sessions"),
                        status: SidebarStatus.sessions(store.sessions, waiting: store.waitingCount,
                                                       cardSessions: store.visibleCards.map(\.sessionId),
                                                       plugin: store.plugin(NotifyTarget.sessionsPlugin), live: live))
                    ForEach(plugins) { p in
                        row(.plugin(p.id), icon: pluginSymbol(p), title: p.title, status: SidebarStatus.plugin(p, live: live))
                    }
                    section(tr("Хаб", "Hub")).padding(.top, 10)
                    row(.journal, icon: "doc.text", title: tr("Журнал", "Log"))
                    // the number of available plugin updates (the daemon's background check every 6 h) — as a capsule, in words — as a second line
                    row(.manager, icon: "square.grid.2x2", title: tr("Плагины", "Plugins"),
                        status: SidebarStatus.updates(store.pluginUpdates, live: live), count: SidebarStatus.updatesCount(store.pluginUpdates))
                    row(.settings, icon: "gearshape", title: tr("Настройки", "Settings"))
                }
            }
            .scrollIndicators(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            PauseHubButton(store: store, height: 36, concentric: true).padding(.top, 4)
        }
        .padding(PanelMetrics.cardPadding)
        // the card radius is concentric with the window: the system window radius − the inset (ConcentricRectangle, macOS 26)
        .background(SidebarCard.shape.fill(Color.white.opacity(0.06)))
        .overlay(SidebarCard.shape.stroke(Color.white.opacity(0.08), lineWidth: 0.5))
        // for menu items and the pause button the container is the card (window radius − inset)
        .containerShape(RoundedRectangle(cornerRadius: PanelMetrics.cardRadius, style: .continuous))
    }

    private var plugins: [PluginState] {
        (store.state?.plugins ?? []).filter { $0.id != NotifyTarget.sessionsPlugin }
    }

    /// Space for the window's traffic lights on the left of their row.
    private static let lightsWidth: CGFloat = 78
    /// The "TEST" label — up to the card's right edge: the sidebar width minus the card margins, the traffic lights and a gap.
    private static let testBadgeMaxWidth: CGFloat = PanelMetrics.sidebarWidth - 2 * PanelMetrics.cardPadding - lightsWidth - 4

    /// The color of the dot and the second-line text — by severity (mockup C).
    private func toneColor(_ t: SidebarStatus.Tone) -> Color {
        switch t {
        case .calm: return .white.opacity(0.55)
        case .attention: return hexColor(0xFFB454)
        case .alarm: return hexColor(0xFF7A70)
        }
    }

    private func section(_ t: String) -> some View {
        Text(t).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.45)).padding(.horizontal, PanelMetrics.rowPadding).padding(.bottom, 4)
    }

    /// An item: icon and name at 13 pt; on the right — only the number in a capsule (`count`); a second line at 11.5 pt — a severity
    /// dot and the status in words, the tail truncated with an ellipsis (the font doesn't shrink). The full status is in the tooltip
    /// on hover and in the accessibility label. Without a status — a single line of the old height.
    private func row(_ s: PanelSection, icon: String, title: String, status: SidebarStatus? = nil, count: String? = nil) -> some View {
        let on = selection == s
        return Button { selection = s } label: {
            // top-aligned: the icon in a frame the height of the name line — a tall symbol doesn't stretch the item
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: icon).font(.system(size: 14)).frame(width: 20, height: 16).foregroundStyle(on ? hexColor(0x4DA3FF) : .white.opacity(0.75))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(title).font(.system(size: 13)).lineLimit(1).truncationMode(.tail)
                            .reportsTruncation(title, font: .system(size: 13))
                        Spacer(minLength: 4)
                        if let n = count {
                            // the number isn't truncated: the name yields
                            Text(n).font(.system(size: 11, weight: .bold)).foregroundStyle(.white).lineLimit(1).fixedSize()
                                .padding(.horizontal, 5).frame(minWidth: 20, minHeight: 16)
                                .background(Capsule().fill(hexColor(0x0A84FF, 0.9)))
                        }
                    }
                    if let st = status {
                        HStack(alignment: .center, spacing: 5) {
                            Circle().fill(toneColor(st.tone)).frame(width: 6, height: 6)
                            Text(st.text).font(.system(size: 11.5)).foregroundStyle(toneColor(st.tone))
                                .lineLimit(1).truncationMode(.tail)
                                .reportsTruncation(st.text, font: .system(size: 11.5))
                        }
                    }
                }
            }
            .padding(.horizontal, PanelMetrics.rowPadding).padding(.vertical, status == nil ? 0 : 6)
            .frame(minHeight: 34)
            .background(SidebarCard.row.fill(Color.white.opacity(on ? 0.13 : 0)))
            .contentShape(SidebarCard.row)
        }
        .buttonStyle(.plain)
        // tooltip (variant D): the full status line — its tail on the second line may have gone into an ellipsis; an AppKit
        // tooltip (HoverTip), not .help — that one didn't appear over this item
        .hoverHelp(status?.help)
        .accessibilityLabel(SidebarStatus.accessibilityLabel(title: title, status: status))
    }
}

/// Sidebar shapes: the card is concentric with the window, menu items with the card (at the corners) with a 9 pt minimum.
enum SidebarCard {
    static let shape = ConcentricRectangle(corners: .concentric(minimum: .fixed(12)), isUniform: true)
    static let row = ConcentricRectangle(corners: .concentric(minimum: .fixed(9)), isUniform: true)
}

// MARK: - banners

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
                       detail: store.daemonLaunch.offlineHint ?? why, buttons: [(tr("Повторить", "Retry"), true, { store.reconnect() })])
            }
            // no pin at all — the red banner below covers it (pinNote); "open the pinned build" is out of place then
            if let peer = store.peer, !peer.isApp, store.state?.appPin?.kind != "none" {
                Banner(fill: hexColor(0xFFD60A, 0.12), stroke: hexColor(0xFFD60A, 0.3), icon: "lock.trianglebadge.exclamationmark", iconColor: .yellow,
                       title: tr("Эта копия приложения не закреплена — ответы, запуски и остановки недоступны",
                                 "This copy of the app isn't pinned — replies, launches and stops are unavailable"),
                       detail: PinAdvice.shared.openPinned + " " + tr("Подробности: класс «\(peer.class)»", "Details: class \"\(peer.class)\"") + (peer.reason.map { ", \($0)" } ?? ""), buttons: [])
            }
            pinNote
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: icon).font(.system(size: 15, weight: .semibold)).foregroundStyle(iconColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 12.5, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                    if let detail { Text(detail).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.6)).lineLimit(2).textSelection(.enabled) }
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

// MARK: - settings

/// Language (System / Русский / English), launch at login, app pinning.
struct LanguagePicker: View {
    let store: HubStore

    static func title(_ s: LangSetting) -> String {
        switch s {
        case .system: return tr("Системный", "System")
        case .ru: return "Русский"
        case .en: return "English"
        }
    }

    var body: some View {
        // the daemon writes the language only for the pinned build (cli — 403)
        // the setting is unknown (the daemon didn't answer, and it isn't remembered for this hub) — no segment is selected
        SegmentCapsule(selection: Binding(get: { L10n.shared.settingKnown ? (LangSetting.allCases.firstIndex(of: L10n.shared.setting) ?? -1) : -1 },
                                          set: { i in Task { await store.setLang(LangSetting.allCases[i]) } }),
                       titles: LangSetting.allCases.map(Self.title))
            .disabled(!store.canAct || !store.connection.isLive)
            .help(!store.canAct ? ActionBlock.notPinned.help : !store.connection.isLive ? ActionBlock.offline.help : "")
    }
}

struct SettingsView: View {
    /// Cards that can be scrolled to (`PanelRouter.settingsFocus`).
    enum Anchor {
        static let hubUpdate = "settings.hub-update"
        static let notifications = "settings.notifications"
        static let connections = "settings.connections"
    }

    let store: HubStore
    var router: PanelRouter? = nil
    let openJournal: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            content
                .onAppear { scrollToFocus(proxy) }
                .onChange(of: router?.settingsFocus) { _, _ in scrollToFocus(proxy) }
                // the card isn't there yet (the window opened before the daemon snapshot) — scroll once it appears
                .onChange(of: store.hubUpdate != nil) { _, _ in scrollToFocus(proxy) }
                .onChange(of: store.state?.notifications != nil) { _, _ in scrollToFocus(proxy) }
                .onChange(of: store.state?.connections != nil) { _, _ in scrollToFocus(proxy) }
        }
    }

    private func scrollToFocus(_ proxy: ScrollViewProxy) {
        guard let id = router?.settingsFocus else { return }
        if id == Anchor.hubUpdate, store.hubUpdate == nil { return }
        if id == Anchor.notifications, store.state?.notifications == nil { return }
        if id == Anchor.connections, store.state?.connections == nil { return }
        // after layout: the "Hub updates" card is third; at the usual window height it's at the bottom edge
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .top) }
            router?.settingsFocus = nil
        }
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                card {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tr("Язык", "Language")).font(.system(size: 13, weight: .semibold))
                        LanguagePicker(store: store)
                        Text(tr("«Системный» — русский, если он первый в языках macOS, иначе английский. Язык меняется сразу и для плагинов; менять его может только закреплённая сборка приложения.",
                                "\"System\" means Russian if it's first in your macOS languages, otherwise English. It switches right away, plugins included; only the pinned app build can change it."))
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
                    }
                }
                card { LaunchAtLoginSettings(store: store) }
                card { NotificationsSettings(store: store, openJournal: openJournal) }.id(Anchor.notifications)
                card { ConnectionsSettings(store: store) }.id(Anchor.connections)
                if let h = store.hubUpdate { card { HubUpdateSettings(store: store, info: h) }.id(Anchor.hubUpdate) }
                if let u = store.state?.pluginUpdates { card { PluginUpdatesSettings(store: store, info: u) } }
                if let pin = store.state?.appPin {
                    card {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(tr("Закрепление приложения", "App pinning")).font(.system(size: 13, weight: .semibold))
                            Text(pin.kind == "none" ? tr("Не закреплено — подтверждения не работают", "Not pinned — confirmations won't work")
                                 : "\(pin.kind == "cert" ? tr("По сертификату", "By certificate") : tr("По отпечатку сборки", "By build fingerprint")) · \(pin.changedDate.map(Fmt.dateTime) ?? "?") · \(pin.originText)")
                                .font(.system(size: 12))
                            Text(tr("Отпечаток: \(pin.shortFingerprint) · записал: \(pin.byText)", "Fingerprint: \(pin.shortFingerprint) · written by: \(pin.byText)"))
                                .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                            // the bundle the hub launches at login and after a crash (appPin.path): a change is visible here
                            if let path = pin.path {
                                Text(tr("Хаб запускает: \(path)", "Hub launches: \(path)"))
                                    .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            } else if PinPathHint.needed(pin) {
                                // without a path the daemon doesn't launch the app — neither at login nor after a crash (decision 2026-11-07)
                                Text(tr("Путь сборки не записан — хаб не запустит приложение ни при входе, ни после падения. Выполните: \(PinPathHint.command(hub: store.state?.hub, bundlePath: store.peer?.isApp == true ? Bundle.main.bundlePath : nil))",
                                        "The build path isn't recorded — the hub won't launch the app at login or after a crash. Run: \(PinPathHint.command(hub: store.state?.hub, bundlePath: store.peer?.isApp == true ? Bundle.main.bundlePath : nil))"))
                                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).textSelection(.enabled)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Button(tr("Открыть журнал", "Open log"), action: openJournal).buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))
                        }
                    }
                }
                card { BridgeSettings(store: store) }
                card {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tr("Служба хаба", "Hub service")).font(.system(size: 13, weight: .semibold))
                        Text(store.connection.isLive ? tr("Хаб работает", "Hub running") : tr("Хаб не отвечает", "Hub not responding")).font(.system(size: 12))
                        Text(store.client.socketPath).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.55)).textSelection(.enabled)
                    }
                }
            }
        }
    }

    private func card<V: View>(@ViewBuilder _ v: () -> V) -> some View {
        v().padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
    }
}

/// Notifications (2026-11-09): a master switch, per-kind switches, quiet hours and security exceptions that can't be
/// turned off. The daemon writes the settings (`PUT /settings/notifications`, pinned build only); a disabled kind
/// doesn't arrive at all, but stays in the popover and the log.
struct NotificationsSettings: View {
    let store: HubStore
    let openJournal: () -> Void

    private var canEdit: Bool { store.connection.isLive && store.canAct }
    private var lockHelp: String { !store.canAct ? ActionBlock.notPinned.help : !store.connection.isLive ? ActionBlock.offline.help : "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let n = store.state?.notifications {
                content(n)
            } else {
                // the daemon stores the settings: without its answer (or with an older daemon) we don't make anything up
                HStack {
                    Text(tr("Уведомления", "Notifications")).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Text(tr("неизвестно", "unknown")).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
                if store.connection.isLive {
                    Text(tr("Служба хаба старше этой настройки — обновите хаб", "The hub service predates this setting — update the hub"))
                        .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder private func content(_ n: NotificationsInfo) -> some View {
        Toggle(tr("Уведомления", "Notifications"),
               isOn: Binding(get: { n.enabled }, set: { v in Task { await store.setNotifications(.object(["enabled": .bool(v)])) } }))
            .toggleStyle(.switch).font(.system(size: 13, weight: .semibold))
            .disabled(!canEdit).help(lockHelp)
        Text(NotificationsText.channels(n))
            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        if !n.service {
            Text(tr("Служба уведомлений выключена в config.json (services.push.enabled) — не приходит ничего, даже исключения безопасности.",
                    "The notification service is off in config.json (services.push.enabled) — nothing arrives, not even security exceptions."))
                .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
        }

        VStack(alignment: .leading, spacing: 6) {
            ForEach(NotificationsInfo.kinds, id: \.self) { kind in
                VStack(alignment: .leading, spacing: 1) {
                    Toggle(NotificationsText.kindTitle(kind),
                           isOn: Binding(get: { n.enabled && n.kindOn(kind) },
                                         set: { v in Task { await store.setNotifications(.object(["kinds": .object([kind: .bool(v)])])) } }))
                        .toggleStyle(.switch).font(.system(size: 12.5))
                    Text(NotificationsText.kindDetail(kind))
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                }
            }
            // plugins' own toggles (contract 2): rows come from installed plugins with kind="plugin" rules;
            // no plugin — no row
            if !n.plugins.isEmpty {
                Text(NotificationsText.pluginsHeader).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.8))
                    .padding(.top, 4)
                ForEach(n.plugins) { p in
                    VStack(alignment: .leading, spacing: 1) {
                        Toggle(isOn: Binding(get: { n.enabled && p.on },
                                             set: { v in Task { await store.setNotifications(.object(["plugins": .object([p.id: .bool(v)])])) } })) {
                            HStack(spacing: 6) {
                                PluginTile(id: p.id, size: 16, radius: 4)
                                Text(p.title)
                            }
                        }
                        .toggleStyle(.switch).font(.system(size: 12.5))
                        Text(NotificationsText.pluginDetail(p))
                            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5)).fixedSize(horizontal: false, vertical: true)
                        if p.legacy && !p.on {
                            Text(NotificationsText.pluginLegacyNote)
                                .font(.system(size: 11)).foregroundStyle(.white.opacity(0.45)).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
        .padding(.leading, 12)
        // the master switch is off — kinds aren't touched (their values are kept until it's turned back on)
        .disabled(!canEdit || !n.enabled).opacity(n.enabled ? 1 : 0.55).help(lockHelp)
        Text(NotificationsText.mutedExplain)
            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        Button(tr("Открыть журнал", "Open log"), action: openJournal).buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(hexColor(0x4DA3FF))

        Divider().opacity(0.4).padding(.vertical, 2)
        quietHours(n)

        Divider().opacity(0.4).padding(.vertical, 2)
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: "lock.fill").font(.system(size: 11)).foregroundStyle(.white.opacity(0.7))
                Text(tr("Не отключаются", "Can't be turned off")).font(.system(size: 12.5, weight: .semibold))
            }
            ForEach(n.security) { item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("•").foregroundStyle(.white.opacity(0.5))
                    Text(NotificationsText.securityTitle(item)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                }
            }
            Text(NotificationsText.securityExplain)
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private func quietHours(_ n: NotificationsInfo) -> some View {
        let q = n.quiet
        Toggle(tr("Тихие часы", "Quiet hours"),
               isOn: Binding(get: { q.enabled }, set: { v in Task { await store.setNotifications(.object(["quiet": .object(["enabled": .bool(v)])])) } }))
            .toggleStyle(.switch).font(.system(size: 12.5, weight: .semibold))
            .disabled(!canEdit).help(lockHelp)
        HStack(spacing: 8) {
            Text(tr("с", "from")).font(.system(size: 12))
            timePicker(q.start) { v in ["start": .string(v)] }
            Text(tr("до", "to")).font(.system(size: 12))
            timePicker(q.end) { v in ["end": .string(v)] }
        }
        .disabled(!canEdit || !q.enabled).opacity(q.enabled ? 1 : 0.55).help(lockHelp)
        Text(NotificationsText.quietExplain)
            .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        if let src = NotificationsText.quietSource(q) {
            Text(src).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
        }
        if let zone = NotificationsText.quietZone(q) {
            Text(zone).font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func timePicker(_ value: String, patch: @escaping (String) -> [String: JSONValue]) -> some View {
        Picker("", selection: Binding(get: { value }, set: { v in
            guard v != value else { return }
            Task { await store.setNotifications(.object(["quiet": .object(patch(v))])) }
        })) {
            ForEach(NotificationsText.timeOptions(including: value), id: \.self) { Text($0).tag($0) }
        }
        .labelsHidden().pickerStyle(.menu).fixedSize()
        .font(.system(size: 12, design: .monospaced))
    }
}

/// "Check for plugin updates": the daemon's background check of the signed catalog (every 6 h). The daemon writes the setting
/// (pinned build only); `services.plugins.checkUpdates = false` in config.json overrides it.
struct PluginUpdatesSettings: View {
    let store: HubStore
    let info: PluginUpdates

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // the header — like the neighbouring "Hub updates" card
            Text(tr("Обновления плагинов", "Plugin updates")).font(.system(size: 13, weight: .semibold))
            Toggle(tr("Проверять обновления плагинов", "Check for plugin updates"),
                   isOn: Binding(get: { info.setting }, set: { v in Task { await store.setCheckPluginUpdates(v) } }))
                .toggleStyle(.switch).font(.system(size: 12.5))
                .disabled(!store.connection.isLive || !info.config || !store.canAct)
                .help(!store.canAct ? ActionBlock.notPinned.help : "")
            // the interval — in the same wording as "Hub updates" (HubUpdateText.checkExplain)
            Text(tr("Несколько раз в день хаб скачивает подписанный каталог реестра и сообщает о новых версиях установленных плагинов — одним уведомлением на версию. Сам ничего не ставит: обновление — кнопкой «Обновить» в «Плагинах». Менять настройку может только закреплённая сборка приложения.",
                    "A few times a day the hub downloads the signed registry catalog and tells you about new versions of installed plugins — one notification per version. It never installs anything itself: update with the Update button in Plugins. Only the pinned app build can change this setting."))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            let status = PluginUpdatesStatus.line(info)
            Text(status.text).font(.system(size: 11.5)).foregroundStyle(status.warn ? hexColor(0xFFC56B) : .white.opacity(0.55))
                .fixedSize(horizontal: false, vertical: true)
            // the same check as the background one (a new version notification — once)
            Button(store.hubUpdateBusy == "plugins-check" ? tr("Проверяю…", "Checking…") : tr("Проверить сейчас", "Check now")) { Task { await store.checkPluginUpdatesNow() } }
                .font(.system(size: 12))
                .disabled(!store.connection.isLive || !store.canAct || !info.config || !info.setting || !info.configured || store.hubUpdateBusy != nil)
                .help(!store.canAct ? ActionBlock.notPinned.help : "")
        }
    }
}

/// "cmux bridge" in settings: whether it's connected (since when, version) or how to start it.
struct BridgeSettings: View {
    let store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tr("Мост cmux", "cmux bridge")).font(.system(size: 13, weight: .semibold))
            if let b = store.state?.bridge {
                HStack(spacing: 6) {
                    Circle().fill(b.online ? Color.green : Color.orange).frame(width: 7, height: 7)
                    Text(b.online ? tr("Подключён", "Connected") + (sinceText(b).map { tr(" · с \($0)", " · since \($0)") } ?? "") + (b.version.map { " · v\($0)" } ?? "")
                                  : tr("Не подключён — переход во вкладки и запуск сессий недоступны", "Not connected — switching to tabs and launching sessions are unavailable"))
                        .font(.system(size: 12))
                }
                if !b.online { BridgeNotice(store: store, place: .settings) }
                Text(tr("Мост живёт в закреплённой вкладке cmux и выполняет для хаба три операции: перейти во вкладку, Esc, новая вкладка.", "The bridge lives in a pinned cmux tab and runs three operations for the hub: switch to a tab, Esc, new tab."))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(BridgeSettingsText.missing(stateKnown: store.state != nil))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
            }
        }
    }

    private func sinceText(_ b: BridgeInfo) -> String? {
        guard let s = b.since else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (f.date(from: s) ?? ISO8601DateFormatter().date(from: s)).map(Fmt.dateTime)
    }
}

/// "Launch at login" — the daemon + app pair (decision 2026-11-07). The setting lives in the daemon
/// (`settings.json → launchAtLogin`), only the pinned build writes it; at login launchd brings the pair up
/// (the daemon, then the daemon starts the app). Off — neither starts at login; an app opened by hand
/// brings up the daemon itself. Recovery of a crashed app works with any setting.
struct LaunchAtLoginSettings: View {
    let store: HubStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            let info = store.state?.launchAtLogin
            if let info {
                Toggle(tr("Запускать при входе", "Launch at login"),
                       isOn: Binding(get: { info.setting }, set: { v in Task { await store.setLaunchAtLogin(v) } }))
                    .toggleStyle(.switch).font(.system(size: 13, weight: .semibold))
                    .disabled(!store.connection.isLive || !store.canAct || info.agentOutdated)
                    .help(!store.canAct ? ActionBlock.notPinned.help : !store.connection.isLive ? ActionBlock.offline.help
                          : info.agentOutdated ? LaunchAgentHint.text(hub: store.state?.hub) : "")
            } else {
                // the daemon stores the setting: without its answer it's unknown — don't draw a made-up "on"
                HStack {
                    Text(tr("Запускать при входе", "Launch at login")).font(.system(size: 13, weight: .semibold))
                    Spacer()
                    Text(tr("неизвестно", "unknown")).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
                .help(store.connection.isLive ? "" : ActionBlock.offline.help)
            }
            Text(tr("Служба хаба и приложение запускаются вместе при входе в систему. Выключено — при входе не запускается ни то, ни другое; открытое вручную приложение само поднимает службу. Упавшее приложение хаб перезапускает в обоих случаях. Менять настройку может только закреплённая сборка приложения.",
                    "The hub service and the app start together when you log in. Off — neither starts at login; when you open the app yourself, it starts the service. The hub restarts a crashed app either way. Only the pinned app build can change this setting."))
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            if info?.agentOutdated == true, store.connection.isLive {
                // a LaunchAgent from before 2026-11-06 (KeepAlive true): a disabled setting under it would become a "start → exit" loop,
                // and the app couldn't be closed — the toggle is locked until the LaunchAgent is reinstalled
                Text(LaunchAgentHint.text(hub: store.state?.hub))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if info == nil, store.connection.isLive {
                Text(tr("Служба хаба старше этой настройки — обновите хаб", "The hub service predates this setting — update the hub"))
                    .font(.system(size: 11.5)).foregroundStyle(hexColor(0xFFC56B)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - plugin

/// Plugin page: a hero header card in the status tone, the body as lists, offers as capsules,
/// "About the plugin" on the second level.
struct PluginDetailView: View {
    let store: HubStore
    let plugin: PluginState
    private let aboutStore = State(initialValue: false)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                hero
                // sign-in to a service the plugin declared (<agenthub.connection>): "Connect" right on its page
                PluginConnectionBanner(store: store, pluginId: plugin.id)
                ForEach(Array(ItemTree.blocks(plugin.body).enumerated()), id: \.offset) { _, block in
                    ForEach(Array(ItemTree.segments(block).enumerated()), id: \.offset) { _, seg in segment(seg) }
                }
                about
            }
            .padding(.bottom, 20)
        }
    }

    /// Layout per the prototype: a row of number cards, cards with a bar, a strip, a list.
    @ViewBuilder private func segment(_ seg: BlockSegment) -> some View {
        switch seg {
        case .stats(let nodes):
            HStack(alignment: .top, spacing: 12) { ForEach(nodes) { StatCard(item: $0.item) } }
        case .gauges(let nodes):
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)], spacing: 12) {
                ForEach(nodes) { GaugeCard(store: store, node: $0) }
            }
        case .strip(let node):
            StripCard(store: store, node: node)
        case .list(let nodes):
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(nodes.enumerated()), id: \.offset) { i, node in
                    if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                    BlockNode(store: store, node: node, depth: 0).padding(.horizontal, 14).padding(.vertical, 9)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
        }
    }

    private var hero: some View {
        let c = plugin.status.color
        let first = plugin.header.first { !$0.separator }
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 14) {
                if let g = first?.gauge {
                    GaugeRing(percent: g, value: plugin.tileValue, caption: first?.gaugeLabel, color: plugin.status == .ok ? hexColor(0x0A84FF) : c)
                } else {
                    PluginTile(id: plugin.id, sfimage: plugin.header.first?.sfImage, size: 44, radius: 12)
                }
                VStack(alignment: .leading, spacing: 4) {
                    // the title isn't truncated with an ellipsis: it wraps (up to three lines), the column takes the full width
                    // full text in a tooltip: the title is truncated after three lines, the explanation after two
                    Text(plugin.headline).font(.system(size: 17, weight: .bold))
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        .reportsTruncation(plugin.headline, font: .system(size: 17, weight: .bold))
                        .hoverHelp(PluginText.help(plugin.headline))
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        StatusGlyph(status: plugin.status, size: 14).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
                        Text(plugin.statusLabel()).font(.system(size: 12, weight: .semibold)).fixedSize()
                        Text("· \(plugin.statusHint())").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                            .reportsTruncation("· \(plugin.statusHint())", font: .system(size: 12))
                    }
                    .hoverHelp(PluginText.help(plugin.statusLabel(), plugin.statusHint()))
                    let rest = plugin.header.dropFirst().filter { !$0.separator && $0.offer == nil }
                    ForEach(Array(rest.enumerated()), id: \.offset) { _, it in
                        Text(it.title).font(.system(size: 12)).foregroundStyle(.white.opacity(0.7)).lineLimit(3)
                            .reportsTruncation(it.title, font: .system(size: 12))
                            .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
                    }
                    if plugin.status == .error, let err = plugin.error {
                        Text(tr("Сбой плагина: \(err)", "Plugin failure: \(err)")).font(.system(size: 12)).foregroundStyle(hexColor(0xFF8A80))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                Button { Task { await store.refresh(plugin: plugin.id) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(CapsuleStyle(height: 28, expand: false))
                    .help(tr("Обновить плагин", "Refresh plugin"))
            }
            let offers = plugin.header.compactMap { it in it.offer.map { (it, $0) } }
            if !offers.isEmpty {
                HStack { ForEach(Array(offers.enumerated()), id: \.offset) { _, o in OfferButton(store: store, item: o.0, offer: o.1) } }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 22).fill(plugin.status == .ok ? Color.white.opacity(0.06) : c.opacity(0.16)))
        .overlay(RoundedRectangle(cornerRadius: 22).strokeBorder(plugin.status == .ok ? Color.white.opacity(0.1) : c.opacity(0.35), lineWidth: 0.5))
    }

    private var about: some View {
        DisclosureGroup(isExpanded: aboutStore.projectedValue) {
            Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                row(tr("Уровень", "Tier"), plugin.tier.label)
                if let v = plugin.version { row(tr("Версия", "Version"), v) }
                if let a = plugin.author {
                    GridRow {
                        Text(tr("Автор", "Author")).foregroundStyle(.secondary)
                        AuthorLine(author: a)
                    }
                }
                row(tr("Обновляется", "Refreshes"), refreshText)
                if !plugin.effects.isEmpty { row(tr("Может", "Can"), plugin.effects.map(effectText).joined(separator: ", ")) }
                if !plugin.actions.isEmpty { row(tr("Свои команды", "Own commands"), plugin.actions.map { "\($0.title ?? $0.id) (\(levelText($0.level)))" }.joined(separator: "; ")) }
                if let t = plugin.lastRunAt, let d = parseDate(t) { row(tr("Последний запуск", "Last run"), Fmt.dateTime(d)) }
                row("id", plugin.id)
                if let f = plugin.file { row(tr("Файл", "File"), f) }
                if !plugin.events.isEmpty { row(tr("События", "Events"), plugin.events.joined(separator: ", ")) }
            }
            .font(.system(size: 11.5))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
        } label: {
            Text(tr("О плагине", "About this plugin")).font(.system(size: 12, weight: .semibold))
        }
        .padding(.horizontal, 4)
    }

    private var refreshText: String {
        if plugin.type == "streamable" { return tr("постоянно", "live") }
        if let s = plugin.schedule { return tr("по расписанию \(s)", "on schedule \(s)") }
        if let i = plugin.interval { return RefreshInterval.text(i) }
        return tr("по запросу", "on demand")
    }

    private func effectText(_ e: String) -> String {
        switch e {
        case "cmux.focus", "session.focus": return tr("перейти во вкладку", "switch to tab")
        case "session.interrupt": return tr("прервать ход", "interrupt")
        case "session.stop": return tr("остановить сессию", "stop session")
        case "open.url": return tr("открыть ссылку", "open link")
        case "open.file": return tr("открыть файл", "open file")
        case "open.*": return tr("открыть ссылку или файл", "open link or file")
        default: return e
        }
    }

    private func levelText(_ l: ActionLevel) -> String {
        switch l {
        case .immediate: return tr("сразу", "immediately")
        case .confirm: return tr("с подтверждением", "asks first")
        case .confirmCost: return tr("с подтверждением: тратит квоту или сеть", "asks first: uses quota or network")
        case .unknown: return "?"
        }
    }

    private func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow {
            Text(k).foregroundStyle(.secondary)
            Text(v).textSelection(.enabled)
        }
    }
}

/// A body node in the panel: a row, nested rows indented; offers as capsules.
struct BlockNode: View {
    let store: HubStore
    let node: ItemNode
    let depth: Int

    var body: some View {
        let it = node.item
        VStack(alignment: .leading, spacing: 5) {
            if it.separator || (it.isDetails && node.hasChildren) {
                EmptyView()
            } else if let offer = it.offer {
                if it.isLink {
                    OfferLink(store: store, item: it, offer: offer, depth: depth)
                } else {
                    OfferButton(store: store, item: it, offer: offer)
                }
            } else {
                HStack(spacing: 7) {
                    if let st = it.status { Circle().fill(st.color).frame(width: 7, height: 7) }
                    if let sym = it.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                        Image(systemName: sym).font(.system(size: 12))
                            .foregroundStyle(swiftBarColor(it.iconColor ?? it.color) ?? .white.opacity(0.6))
                    }
                    Text(it.title)
                        .font(.system(size: depth == 0 ? 13 : 12, weight: depth == 0 && node.hasChildren ? .semibold : .regular))
                        .foregroundStyle(swiftBarColor(it.color) ?? (depth == 0 ? .white : .white.opacity(0.65)))
                        .textSelection(.enabled)
                        .reportsTruncation(it.title, font: .system(size: depth == 0 ? 13 : 12, weight: depth == 0 && node.hasChildren ? .semibold : .regular))
                    if let s = it.session { SessionTag(session: s) }
                    if let badge = it.badge { BadgeView(text: badge, color: it.badgeColor) }
                }
                // a row with text selection: an AppKit field lies over it — an AppKit tooltip (HoverTip), not .help
                .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
            }
            if node.hasChildren, it.isDetails {
                DetailsDisclosure(store: store, node: node, depth: depth)
            } else if node.hasChildren {
                // capsule offers gather in one row below; link offers (`link=true`) stay in place as lines
                let offers = node.children.filter { $0.item.offer != nil && !$0.item.isLink }
                let rest = node.children.filter { $0.item.offer == nil || $0.item.isLink }
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(rest) { BlockNode(store: store, node: $0, depth: depth + 1) }
                    if !offers.isEmpty {
                        HStack(spacing: 6) { ForEach(offers) { o in OfferButton(store: store, item: o.item, offer: o.item.offer!) } }
                    }
                }
                .padding(.leading, 16)
            }
        }
    }
}

/// `details=true`: service details (process numbers, schedules) are collapsed and expand on click.
///
/// Not a `DisclosureGroup` (2026-11-10, bug from a plugin page): on macOS it toggles only from its small chevron, the
/// label text does not react, so a click on the title did nothing. Here the whole header (chevron + title) is one
/// plain button. The open state also lives in `DetailsMemory`, keyed by the details title and its depth, so a page
/// rebuilt by a plugin refresh (a new view identity) keeps the block open.
struct DetailsDisclosure: View {
    let store: HubStore
    let node: ItemNode
    let depth: Int
    private let openStore: State<Bool>

    init(store: HubStore, node: ItemNode, depth: Int) {
        self.store = store
        self.node = node
        self.depth = depth
        openStore = State(initialValue: DetailsMemory.open.contains(DetailsMemory.key(node, depth)))
    }

    var body: some View {
        let open = openStore.wrappedValue
        VStack(alignment: .leading, spacing: 3) {
            Button {
                let now = !openStore.wrappedValue
                openStore.wrappedValue = now
                let key = DetailsMemory.key(node, depth)
                if now { DetailsMemory.open.insert(key) } else { DetailsMemory.open.remove(key) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text(node.item.title.isEmpty ? tr("Подробности", "Details") : node.item.title)
                        .font(.system(size: 11.5))
                }
                .foregroundStyle(.white.opacity(0.5))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(open ? tr("развёрнуто", "expanded") : tr("свёрнуто", "collapsed"))
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(node.children) { BlockNode(store: store, node: $0, depth: depth + 1) }
                }
                .padding(.leading, 14).padding(.top, 2)
            }
        }
    }
}

/// Which `details=true` blocks are open, for the app's lifetime: survives page rebuilds and switching pages.
@MainActor
enum DetailsMemory {
    static var open: Set<String> = []
    static func key(_ node: ItemNode, _ depth: Int) -> String { "\(depth)|\(node.item.title)" }
}

/// A number card (Panel.dc.html): a caption, a large value, a line below it in the `color=` color.
struct StatCard: View {
    let item: Item

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.stat ?? "").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                .reportsTruncation(item.stat ?? "", font: .system(size: 12))
            Text(item.title).font(.system(size: 22, weight: .bold)).lineLimit(1).minimumScaleFactor(0.6)
                .reportsTruncation(item.title, font: .system(size: 22, weight: .bold))
            if let n = item.note {
                Text(n).font(.system(size: 12)).foregroundStyle(swiftBarColor(item.color) ?? .white.opacity(0.6)).lineLimit(2)
                    .reportsTruncation(n, font: .system(size: 12))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
        .hoverHelp(PluginText.cardHelp(item), always: item.tooltip != nil)
    }
}

/// A card with a bar (Panel.dc.html, quota): a title and an explanation on the right, a bar, child rows below.
struct GaugeCard: View {
    let store: HubStore
    let node: ItemNode

    var body: some View {
        let it = node.item
        VStack(alignment: .leading, spacing: 8) {
            // title and explanation in a row; if they don't fit (in Russian "Неделя · Opus — 41% использовано" and "сброс вт 10.11
            // 23:36") — the explanation goes on a line below the title rather than truncating the title
            let title = Text(it.title).font(.system(size: 13, weight: .semibold))
            let note = it.note.map { Text($0).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)) }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    title.lineLimit(1).fixedSize()
                    Spacer(minLength: 6)
                    if let note { note.lineLimit(1).fixedSize() }
                }
                VStack(alignment: .leading, spacing: 2) {
                    title.lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .reportsTruncation(it.title, font: .system(size: 13, weight: .semibold))
                    if let note, let n = it.note { note.lineLimit(1).reportsTruncation(n, font: .system(size: 12)) }
                }
            }
            .hoverHelp(PluginText.help(tooltip: it.tooltip, it.title, it.note), always: it.tooltip != nil)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1))
                    Capsule().fill(swiftBarColor(it.color) ?? hexColor(0x0A84FF)).frame(width: max(6, g.size.width * (it.gauge ?? 0) / 100))
                }
            }
            .frame(height: 6)
            ForEach(node.children) { BlockNode(store: store, node: $0, depth: 1) }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
    }
}

/// A strip (Panel.dc.html, e.g. "Recent runs"): a title and cells — icon, caption, explanation; a cell with
/// an offer (open the summary) is a button.
struct StripCard: View {
    let store: HubStore
    let node: ItemNode

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(node.item.title).font(.system(size: 13, weight: .semibold))
                .reportsTruncation(node.item.title, font: .system(size: 13, weight: .semibold))
                .hoverHelp(PluginText.rowHelp(node.item), always: node.item.tooltip != nil)
            HStack(alignment: .top, spacing: 6) {
                ForEach(node.children) { c in cell(c.item) }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
    }

    @ViewBuilder private func cell(_ it: Item) -> some View {
        let content = VStack(spacing: 3) {
            if let sym = it.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                Image(systemName: sym).font(.system(size: 20)).foregroundStyle(swiftBarColor(it.color) ?? .white.opacity(0.7))
            }
            Text(it.title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
                .reportsTruncation(it.title, font: .system(size: 12, weight: .semibold))
            if let n = it.note {
                Text(n).font(.system(size: 11)).foregroundStyle(.white.opacity(0.55)).lineLimit(2).multilineTextAlignment(.center)
                    .reportsTruncation(n, font: .system(size: 11))
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        if let offer = it.offer {
            // like OfferButton: while paused only "open link/file" works, without a connection — nothing
            let block = store.gate(offer: offer)
            Button { Task { await store.perform(offer: offer, label: it.title) } } label: { content }
                .buttonStyle(.plain)
                .disabled(block != nil || store.busyAction != nil)
                .opacity(block != nil ? 0.5 : 1)
                // a button: what's in the way (pause, bridge) — otherwise the cell's full text (caption on one line, explanation on two)
                .hoverHelp(block.map { BridgeText.help($0, primitive: offer.primitive, store) } ?? PluginText.cardHelp(it) ?? offer.label,
                           always: block != nil || it.tooltip != nil)
        } else {
            content.hoverHelp(PluginText.cardHelp(it), always: it.tooltip != nil)
        }
    }
}

/// The header ring (Panel.dc.html, quota): the share from `gauge=`, the tile value and a caption in the center.
struct GaugeRing: View {
    let percent: Double
    let value: String
    let caption: String?
    let color: Color

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.1), lineWidth: 8)
            Circle().trim(from: 0, to: percent / 100).stroke(color, style: StrokeStyle(lineWidth: 8, lineCap: .round)).rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text(value).font(.system(size: 20, weight: .bold)).lineLimit(1).minimumScaleFactor(0.6)
                if let caption { Text(caption).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.6)).lineLimit(1) }
            }
            .padding(10)
        }
        .frame(width: 96, height: 96)
    }
}

struct SessionTag: View {
    let session: ItemSession

    var body: some View {
        switch session.verified {
        case .some(true):
            Image(systemName: "checkmark.seal.fill").font(.system(size: 11)).foregroundStyle(.green).help(tr("Подпись Claude Code проверена хабом", "Claude Code signature verified by the hub"))
        case .some(false):
            Text(session.label ?? tr("подпись не подтверждена", "signature not verified")).font(.caption2.bold()).foregroundStyle(.red)
                .padding(.horizontal, 5).background(Capsule().fill(Color.red.opacity(0.12)))
        case .none:
            ProgressView().controlSize(.mini).help(tr("Хаб проверяет подпись", "The hub is checking the signature"))
        }
    }
}

/// A plugin offer button — a capsule. The level is shown in the tooltip; the core decides on confirmation.
struct OfferButton: View {
    let store: HubStore
    let item: Item
    let offer: Offer

    /// What the core will certainly reject (connection, unpinned build, pause, bridge) — the button is disabled, and the tooltip
    /// says why (without the bridge — how to start it).
    private var block: ActionBlock? { store.gate(offer: offer) }

    var body: some View {
        Button {
            Task { await store.perform(offer: offer, label: item.title) }
        } label: {
            HStack(spacing: 5) {
                if let sym = item.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil { Image(systemName: sym) }
                Text(item.title + (offer.level == .immediate ? "" : "…"))
                if store.busyAction == offer.id { ProgressView().controlSize(.mini) }
            }
        }
        .buttonStyle(CapsuleStyle(height: 26, expand: false))
        .help(block.map { BridgeText.help($0, primitive: offer.primitive, store) } ?? (offer.level == .immediate ? (offer.label ?? "") : offer.level == .confirmCost ? tr("С подтверждением: тратит квоту или выходит в сеть", "Asks first: uses quota or the network") : tr("С подтверждением", "Asks first")))
        .disabled(store.busyAction != nil || block != nil)
    }
}

/// `link=true`: the same offer as `OfferButton` (same gate, confirmation and tooltip), drawn as a text link —
/// accent color, underline on hover, pointing-hand cursor. The badge, session tag and nesting work as on a plain row.
struct OfferLink: View {
    let store: HubStore
    let item: Item
    let offer: Offer
    let depth: Int
    private let hoverState = State(initialValue: false)

    private var block: ActionBlock? { store.gate(offer: offer) }

    var body: some View {
        let font = Font.system(size: depth == 0 ? 13 : 12)
        HStack(spacing: 7) {
            if let sym = item.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                Image(systemName: sym).font(.system(size: 12))
                    .foregroundStyle(swiftBarColor(item.iconColor ?? item.color) ?? .white.opacity(0.6))
            }
            Button {
                Task { await store.perform(offer: offer, label: item.title) }
            } label: {
                Text(item.title + (offer.level == .immediate ? "" : "…"))
                    .font(font)
                    .foregroundStyle(block != nil ? Color.white.opacity(0.4) : (swiftBarColor(item.color) ?? Color.accentColor))
                    .underline(hoverState.wrappedValue && block == nil)
                    .multilineTextAlignment(.leading)
                    .reportsTruncation(item.title, font: font)
            }
            .buttonStyle(.plain)
            .disabled(store.busyAction != nil || block != nil)
            .onHover { inside in
                hoverState.wrappedValue = inside
                (inside && block == nil ? NSCursor.pointingHand : NSCursor.arrow).set()
            }
            if store.busyAction == offer.id { ProgressView().controlSize(.mini) }
            if let s = item.session { SessionTag(session: s) }
            if let badge = item.badge { BadgeView(text: badge, color: item.badgeColor) }
        }
        .hoverHelp(block.map { BridgeText.help($0, primitive: offer.primitive, store) } ?? PluginText.rowHelp(item),
                   always: block != nil || item.tooltip != nil)
    }
}

/// `badge=` with an optional `badgeColor=`: no color — the neutral capsule; a color — a 20% fill with text in that color.
struct BadgeView: View {
    let text: String
    let color: String?

    var body: some View {
        if let c = swiftBarColor(color) {
            Text(text).font(.caption2.bold()).foregroundStyle(c)
                .padding(.horizontal, 5).background(Capsule().fill(c.opacity(0.2)))
        } else {
            Text(text).font(.caption2.bold()).padding(.horizontal, 5).background(Capsule().fill(.quaternary))
        }
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
        case .focus: return tr("Мост cmux не подключён — «Перейти во вкладку» недоступно", "The cmux bridge isn't connected — Go to tab is unavailable")
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

/// The last turn's effort capsule (Panel.dc.html): the level and ⚡ultracode. Based on the last turn — for an idle
/// session the value may be stale (tooltip).
struct EffortBadge: View {
    let effort: String?
    var ultracode = false
    var compact = false

    var body: some View {
        HStack(spacing: 4) {
            if let effort {
                Text(effort).font(.system(size: compact ? 10.5 : 11, weight: .medium)).foregroundStyle(.white.opacity(0.78))
                    .padding(.horizontal, compact ? 6 : 8).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
            }
            if ultracode {
                Text("⚡ultracode").font(.system(size: compact ? 10.5 : 11, weight: .semibold)).foregroundStyle(hexColor(0xFFD60A))
                    .padding(.horizontal, compact ? 6 : 8).padding(.vertical, 2)
                    .background(Capsule().fill(hexColor(0xFFD60A, 0.14)))
            }
        }
        .fixedSize()
        .help(tr("Effort по последнему ходу сессии — у простаивающей сессии может быть устаревшим", "Effort as of the session's last turn — may be out of date for an idle session"))
    }
}

// MARK: - sessions

struct SessionsView: View {
    let store: HubStore
    let search: String

    var body: some View {
        let sessions = filtered
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                let cards = store.visibleCards
                if let e = store.sessionsNotice {
                    Notice(color: .yellow, icon: "lock.trianglebadge.exclamationmark", title: e)
                }
                // the result of a launch from the form (it closes right away): "waiting for the session" → "appeared" / "didn't appear within a minute"
                if let l = store.lastLaunch {
                    Notice(color: l.state == .timeout ? .orange : l.state == .registered ? .green : .blue, icon: l.symbol, title: l.text,
                           actionTitle: tr("Скрыть", "Dismiss"), onAction: { store.clearLastLaunch() })
                }
                // without the bridge "Go to" is disabled — here you can see how to start it
                if store.focusPrimitive, !store.bridgeOnline, store.sessions.contains(where: { $0.focusable == true || $0.surfaceId != nil }) || cards.contains(where: { $0.surfaceId != nil }) {
                    BridgeNotice(store: store)
                }
                if !cards.isEmpty {
                    Text(tr("Ждут вас", "Needs you")).font(.system(size: 13, weight: .semibold))
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 12, alignment: .top), GridItem(.flexible(), spacing: 12, alignment: .top)], spacing: 12) {
                        ForEach(cards) { card in ResponseCard(store: store, card: card, demo: store.demoCards.contains(card)) }
                    }
                    Text(tr("Можно ответить и в терминале, и с телефона через Remote Control — засчитается первый ответ.", "You can also answer in the terminal or from your phone via Remote Control — the first answer counts."))
                        .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                }
                // the sessions plugin's page leads here (PanelSection.resolved): what isn't in the hub registry —
                // died sessions with "Continue: claude --resume …" and the "no sessions visible" reason — comes from its frame
                let extras = SessionsPluginExtras(store.plugin(NotifyTarget.sessionsPlugin))
                if let t = extras.brokenTitle {
                    Notice(color: .yellow, icon: "exclamationmark.triangle", title: t, detail: extras.brokenDetail)
                }
                if let f = extras.failure {
                    Notice(color: .red, icon: "xmark.octagon", title: tr("Плагин сессий не ответил: \(f)", "The sessions plugin failed: \(f)"),
                           actionTitle: tr("Обновить", "Refresh"), onAction: { Task { await store.refresh(plugin: NotifyTarget.sessionsPlugin) } })
                }
                if !extras.nodes.isEmpty {
                    Text(tr("Требует внимания", "Needs attention")).font(.system(size: 13, weight: .semibold)).padding(.top, cards.isEmpty ? 0 : 6)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(extras.nodes.enumerated()), id: \.offset) { i, node in
                            if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                            BlockNode(store: store, node: node, depth: 0).padding(.horizontal, 14).padding(.vertical, 9)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
                }
                Text(tr("Все сессии", "All sessions")).font(.system(size: 13, weight: .semibold)).padding(.top, cards.isEmpty && extras.nodes.isEmpty ? 0 : 6)
                if sessions.isEmpty {
                    Text(search.isEmpty ? tr("Сессий нет. Здесь — только сессии, чья подпись Claude Code проверена хабом.", "No sessions. Only sessions whose Claude Code signature the hub verified appear here.")
                                        : tr("Ничего не нашлось", "Nothing found"))
                        .font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 10)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(sessions.enumerated()), id: \.element.id) { i, s in
                            if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5) }
                            SessionRow(store: store, session: s, question: cards.contains { $0.sessionId == s.sessionId && $0.kind == .question })
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
                }
                Text(tr("Workflow внутри сессии снаружи не останавливается — «Перейти», затем /workflows во вкладке.", "A Workflow inside a session can't be stopped from outside — use Go to tab, then /workflows in the tab."))
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
            }
            .padding(.bottom, 20)
        }
        .task { await store.loadCards() }
    }

    private var filtered: [SessionInfo] {
        let order = ["waiting": 0, "busy": 1, "idle": 2]
        let all = store.sessions.sorted { (order[$0.status ?? ""] ?? 3, $0.displayName) < (order[$1.status ?? ""] ?? 3, $1.displayName) }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return all }
        return all.filter { $0.displayName.lowercased().contains(q) || ($0.cwd ?? "").lowercased().contains(q) }
    }
}

struct SessionRow: View {
    let store: HubStore
    let session: SessionInfo
    let question: Bool

    private func has(_ name: String) -> Bool { store.state?.primitives.contains { $0.name == name } ?? false }
    /// Why the button won't work: connection, unpinned build (interrupt/stop — app only), pause, bridge.
    private func block(_ primitive: String) -> ActionBlock? { store.gate(primitive: primitive) }

    var body: some View {
        HStack(spacing: 10) {
            glyph
            VStack(alignment: .leading, spacing: 1) {
                Text(session.displayName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text([session.stateLabel, session.cwd].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
            }
            Spacer(minLength: 8)
            if session.kind != nil && session.kind != "interactive" {
                Text(tr("фоновая", "background")).font(.system(size: 10.5, weight: .semibold)).padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Capsule().fill(Color.white.opacity(0.1)))
            }
            if session.effortLabel != nil || session.ultracode == true {
                EffortBadge(effort: session.effortLabel, ultracode: session.ultracode == true)
            }
            Text(age).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).lineLimit(1).frame(width: 70, alignment: .trailing)
            // buttons in a fixed-width column: effort capsules line up in a column, as in the prototype
            HStack(spacing: 10) {
            if let req = focusRequest {
                let b = block(req.primitive)
                Button(tr("Перейти", "Go to tab")) { focus(req) }
                    .buttonStyle(CapsuleStyle(height: 26, expand: false)).disabled(store.busyAction != nil || b != nil)
                    .help(b.map { BridgeText.help($0, primitive: req.primitive, store) } ?? tr("Перейти во вкладку этой сессии", "Switch to this session's tab"))
            }
            if session.status == "busy", has("session.interrupt") {
                Button { if store.isDemo(session) { demo() } else { Task { await store.perform(id: "session.interrupt", args: ["sessionId": .string(session.sessionId)], label: tr("Прервать ход", "Interrupt")) } } } label: { Image(systemName: "hand.raised.circle") }
                    .buttonStyle(.plain).foregroundStyle(.white.opacity(0.7)).disabled(store.busyAction != nil || block("session.interrupt") != nil)
                    .help(block("session.interrupt").map { BridgeText.help($0, primitive: "session.interrupt", store) }
                          ?? tr("Прервать ход (как Esc во вкладке) — с подтверждением", "Interrupt the turn (like Esc in the tab) — asks first"))
            }
            if has("session.stop") {
                Button { if store.isDemo(session) { demo() } else { Task { await store.perform(id: "session.stop", args: ["sessionId": .string(session.sessionId)], label: tr("Завершить сессию", "End session")) } } } label: {
                    Image(systemName: "stop.fill").font(.system(size: 8)).foregroundStyle(hexColor(0xFF8A80))
                        .frame(width: 26, height: 26).background(Circle().fill(hexColor(0xFF453A, 0.18)))
                }
                .buttonStyle(.plain).disabled(store.busyAction != nil || block("session.stop") != nil)
                .help(block("session.stop")?.help ?? tr("Завершить сессию — продолжить позже можно через claude --resume", "End the session — resume later with claude --resume"))
            }
            }
            .frame(width: 150, alignment: .trailing)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .help(details)
    }

    private var details: String {
        var parts: [String] = []
        if let p = session.pid { parts.append(tr("процесс \(p)", "process \(p)")) }
        if let sf = session.surfaceId { parts.append(tr("вкладка \(sf.prefix(8))", "tab \(sf.prefix(8))")) }
        parts.append(session.interactive ? tr("интерактивная", "interactive") : tr("не интерактивная", "not interactive"))
        return parts.joined(separator: " · ")
    }

    /// A demo session (`--demo-sessions`, screenshots): there's no process behind it — the action isn't sent.
    private func demo() {
        store.presenter?.report(title: tr("Это демо-сессия", "This is a demo session"), detail: tr("Её показал аргумент --demo-sessions для скриншота; процесса за ней нет.", "It was added by --demo-sessions for a screenshot; there's no process behind it."))
    }

    /// How long it's been waiting — from the reply card; for others we don't show the age (the hub only knows the time of the last frame).
    private var age: String {
        guard session.isWaiting, let a = store.visibleCards.first(where: { $0.sessionId == session.sessionId })?.age else { return "" }
        return Fmt.duration(a)
    }

    @ViewBuilder private var glyph: some View {
        switch session.status {
        case "waiting": StatusGlyph(status: .wait, size: 20, question: question)
        case "busy": StatusGlyph(status: .ok, size: 20)
        default:
            ZStack { Circle().fill(Color.gray); Image(systemName: "minus").font(.system(size: 10, weight: .heavy)).foregroundStyle(.white) }.frame(width: 20, height: 20)
        }
    }

    /// Go to tab: `session.focus` by the core's "tab found" flag. A demo session (screenshots) — a button for
    /// its tab, without sending.
    private var focusRequest: (primitive: String, args: [String: JSONValue])? {
        if store.isDemo(session) { return session.surfaceId != nil && store.focusPrimitive ? ("session.focus", [:]) : nil }
        return store.focusRequest(sessionId: session.sessionId)
    }

    private func focus(_ req: (primitive: String, args: [String: JSONValue])) {
        if store.isDemo(session) { return demo() }
        Task { await store.perform(id: req.primitive, args: req.args, label: tr("Перейти во вкладку", "Switch to tab")) }
    }
}

// MARK: - log

struct JournalView: View {
    let store: HubStore
    let search: String
    private let onlyActionsStore = State(initialValue: true)
    private let expandedStore = State<String?>(initialValue: nil)

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(tr("Только метаданные: кто, что, для какой сессии, результат. Без текста команд и переписки.", "Metadata only: who, what, which session, result. No command text or conversation."))
                    .font(.system(size: 12)).foregroundStyle(.white.opacity(0.6))
                Spacer()
                Toggle(tr("только действия", "actions only"), isOn: onlyActionsStore.projectedValue).toggleStyle(.switch).controlSize(.mini).font(.system(size: 12))
                Button { Task { await store.loadJournal() } } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(CapsuleStyle(height: 26, expand: false))
            }
            if let e = store.journalError { Text(e).font(.caption).foregroundStyle(.red) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(entries) { e in
                        Button { expandedStore.wrappedValue = expandedStore.wrappedValue == e.id ? nil : e.id } label: { row(e) }.buttonStyle(.plain)
                    }
                }
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.black.opacity(0.22)))
                .clipShape(RoundedRectangle(cornerRadius: 16))
            }
        }
        .task { await store.loadJournal() }
    }

    private var entries: [JournalEntry] {
        let q = search.lowercased()
        return store.journal.filter { e in
            (!onlyActionsStore.wrappedValue || e.isAction) && (q.isEmpty || e.typeLabel.lowercased().contains(q) || e.type.contains(q) || e.summary.lowercased().contains(q))
        }
    }

    private func row(_ e: JournalEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                // the time column — by the language's longest string ("10:58:58 PM" in English, "22:58:58" in Russian):
                // an entry on one line, not "9:57:24 / PM"
                ZStack(alignment: .leading) {
                    Text(verbatim: Self.timeTemplate()).hidden()
                    Text(shortTime(e.ts)).foregroundStyle(.white.opacity(0.5))
                }
                .lineLimit(1).fixedSize().frame(minWidth: 64, alignment: .leading)
                // the name column — 230 pt if there's a target; no target — the name takes its place too (not truncated needlessly)
                let target = e.target
                if target.isEmpty {
                    Text(e.typeLabel).foregroundStyle(hexColor(0x8EC5FF)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(e.typeLabel).foregroundStyle(hexColor(0x8EC5FF)).frame(width: 230, alignment: .leading).lineLimit(1)
                    Text(target).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
                    Spacer(minLength: 6)
                }
                if let r = e.result { Text(r.text).foregroundStyle(r.ok ? hexColor(0x7EE29B) : hexColor(0xFF8A80)).lineLimit(1) }
            }
            if expandedStore.wrappedValue == e.id {
                Text("\(e.type) · \(e.summary)").foregroundStyle(.white.opacity(0.55)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.system(size: 12, design: .monospaced))
        .padding(.horizontal, 14).padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    /// The widest time string in the current language — the sample for the column width.
    static func timeTemplate() -> String {
        var c = DateComponents()
        c.year = 2026; c.month = 1; c.day = 1; c.hour = 22; c.minute = 58; c.second = 58
        let d = Calendar(identifier: .gregorian).date(from: c) ?? Date()
        return d.formatted(.dateTime.hour().minute().second().locale(L10n.shared.locale))
    }

    private func shortTime(_ ts: String?) -> String {
        guard let ts else { return "" }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let d = f.date(from: ts) ?? ISO8601DateFormatter().date(from: ts) else { return ts }
        return d.formatted(.dateTime.hour().minute().second().locale(L10n.shared.locale))
    }
}
