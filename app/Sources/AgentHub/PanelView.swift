import AgentHubKit
import AppKit
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
                    .tip(block?.help ?? "")
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
        case .settings: return tr("язык, автозапуск, уведомления, подключения, обновления хаба и плагинов, терминал, закрепление приложения", "language, launch at login, notifications, connections, hub and plugin updates, terminal, app pinning")
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
                    agentsHeader
                    if isArranging {
                        pinnedSessionsRow
                    } else {
                        row(.sessions, icon: "terminal", title: tr("Сессии", "Sessions"),
                            status: SidebarStatus.sessions(store.sessions, waiting: store.waitingCount,
                                                           cardSessions: store.visibleCards.map(\.sessionId),
                                                           plugin: store.plugin(NotifyTarget.sessionsPlugin), live: live))
                    }
                    let list = plugins
                    ForEach(Array(list.enumerated()), id: \.element.id) { i, p in
                        if isArranging {
                            arrangeRow(p, at: i, of: list.count)
                        } else {
                            row(.plugin(p.id), icon: pluginSymbol(p), title: p.title, status: SidebarStatus.plugin(p, live: live))
                        }
                    }
                    if isArranging { defaultOrderButton }
                    section(tr("Хаб", "Hub")).padding(.top, 10)
                    row(.journal, icon: "doc.text", title: tr("Журнал", "Log"))
                    // the number of available plugin updates (the daemon's background check every 6 h) — as a capsule, in words — as a second line
                    row(.manager, icon: "square.grid.2x2", title: tr("Плагины", "Plugins"),
                        status: SidebarStatus.extensionsWaiting(store.state?.extensions) ?? SidebarStatus.updates(store.pluginUpdates, live: live),
                        count: SidebarStatus.updatesCount(store.pluginUpdates))
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

    /// Plugins under "Agents": alphabetical, or in the order the human arranged (task 120); the sessions plugin has its own row.
    private var plugins: [PluginState] {
        store.orderedPlugins.filter { $0.id != NotifyTarget.sessionsPlugin }
    }

    // MARK: arranging plugins (task 120)

    /// The rearranging mode: rows get arrows and a handle and can be dragged; "Default" brings back the alphabet.
    /// (State without the macro: see the note on `State` at the top of this file.)
    private let arrangingStore = State(initialValue: LaunchOptions.current.arrangePlugins)
    private var arranging: Bool { get { arrangingStore.wrappedValue } nonmutating set { arrangingStore.wrappedValue = newValue } }
    /// The row a dragged plugin is over right now.
    private let dropTargetStore = State<String?>(initialValue: nil)
    private var dropTarget: String? { get { dropTargetStore.wrappedValue } nonmutating set { dropTargetStore.wrappedValue = newValue } }

    /// Nothing to rearrange with fewer than two plugins — the mode ends by itself.
    private var isArranging: Bool { arranging && plugins.count > 1 }

    /// "Agents" with the rearrange button on the right; in the mode — "Done".
    private var agentsHeader: some View {
        HStack(spacing: 4) {
            Text(tr("Агенты", "Agents")).font(.system(size: 11, weight: .semibold)).foregroundStyle(.white.opacity(0.45))
            Spacer(minLength: 4)
            if plugins.count > 1 {
                Button { arranging = !isArranging; dropTarget = nil } label: {
                    Group {
                        if isArranging { Text(tr("Готово", "Done")).font(.system(size: 11, weight: .semibold)) }
                        else { Image(systemName: "arrow.up.arrow.down").font(.system(size: 11, weight: .semibold)) }
                    }
                    .frame(minWidth: 18, minHeight: 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(isArranging ? hexColor(0x4DA3FF) : .white.opacity(0.45))
                .hoverHelp(isArranging ? nil : tr("Изменить порядок плагинов", "Rearrange plugins"))
                .accessibilityLabel(isArranging ? tr("Готово", "Done") : tr("Изменить порядок плагинов", "Rearrange plugins"))
            }
        }
        .padding(.horizontal, PanelMetrics.rowPadding).padding(.bottom, 4)
    }

    /// "Sessions" in the rearranging mode: the hub's own row, always first — a pin instead of arrows and a handle, and a
    /// thin line under it, so it is clear the alphabet and the arranging are about the plugins below.
    private var pinnedSessionsRow: some View {
        VStack(spacing: 6) {
            HStack(spacing: 9) {
                Image(systemName: "terminal").font(.system(size: 14)).frame(width: 20, height: 16).foregroundStyle(.white.opacity(0.75))
                Text(tr("Сессии", "Sessions")).font(.system(size: 13)).lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "pin.fill").font(.system(size: 11)).foregroundStyle(.white.opacity(0.45))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, PanelMetrics.rowPadding)
            .frame(minHeight: 34)
            .hoverHelp(tr("Сессии всегда первые — порядок меняется только у плагинов ниже", "Sessions always come first — only the plugins below can be rearranged"))
            .accessibilityElement(children: .combine)
            .accessibilityLabel(tr("Сессии, всегда первые", "Sessions, always first"))
            Rectangle().fill(Color.white.opacity(0.12)).frame(height: 0.5).padding(.horizontal, PanelMetrics.rowPadding)
        }
        .padding(.bottom, 2)
    }

    /// A plugin row in the rearranging mode: up/down arrows and a handle; drop another row onto it to put that one here.
    private func arrangeRow(_ p: PluginState, at i: Int, of n: Int) -> some View {
        HStack(spacing: 9) {
            Image(systemName: pluginSymbol(p)).font(.system(size: 14)).frame(width: 20, height: 16).foregroundStyle(.white.opacity(0.75))
            Text(p.title).font(.system(size: 13)).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            stepButton("chevron.up", tr("Выше", "Move up"), enabled: i > 0) { arrange(PluginOrder.step(p.id, by: -1, in: visibleIds)) }
            stepButton("chevron.down", tr("Ниже", "Move down"), enabled: i < n - 1) { arrange(PluginOrder.step(p.id, by: 1, in: visibleIds)) }
            Image(systemName: "line.3.horizontal").font(.system(size: 12)).foregroundStyle(.white.opacity(0.45))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, PanelMetrics.rowPadding)
        .frame(minHeight: 34)
        .background(SidebarCard.row.fill(Color.white.opacity(dropTarget == p.id ? 0.16 : 0.05)))
        .contentShape(SidebarCard.row)
        .draggable(p.id)
        .dropDestination(for: String.self) { ids, _ in
            dropTarget = nil
            guard let id = ids.first, visibleIds.contains(id) else { return false }
            arrange(PluginOrder.move(id, onto: p.id, in: visibleIds))
            return true
        } isTargeted: { over in
            if over { dropTarget = p.id } else if dropTarget == p.id { dropTarget = nil }
        }
        .hoverHelp(tr("Перетащите строку или нажмите стрелку", "Drag the row or press an arrow"))
    }

    private func stepButton(_ symbol: String, _ label: String, enabled: Bool, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            Image(systemName: symbol).font(.system(size: 11, weight: .semibold)).frame(width: 18, height: 18).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white.opacity(enabled ? 0.75 : 0.2))
        .disabled(!enabled)
        .accessibilityLabel(label)
    }

    /// "Default": alphabetical again (nothing to do — dimmed).
    private var defaultOrderButton: some View {
        let custom = store.pluginOrderIsCustom
        return Button { store.resetPluginOrder() } label: {
            Label(tr("По умолчанию (по алфавиту)", "Default (alphabetical)"), systemImage: "textformat.abc")
                .font(.system(size: 11.5)).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, PanelMetrics.rowPadding).frame(minHeight: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(custom ? hexColor(0x4DA3FF) : .white.opacity(0.3))
        .disabled(!custom)
    }

    private var visibleIds: [String] { plugins.map(\.id) }

    /// Save the sidebar's new order into the full one (the hidden sessions plugin keeps its place).
    private func arrange(_ visible: [String]) {
        store.arrangePlugins(PluginOrder.replacing(visible: visible, in: store.orderedPlugins.map(\.id)))
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
