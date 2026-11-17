import AgentHubKit
import AppKit
import SwiftUI

// What a plugin's body is drawn with in the panel: rows and nested rows, collapsible details, stat / gauge / strip
// cards, offer buttons and links, badges.

/// A body node in the panel: a row, nested rows indented; offers as capsules.
struct BlockNode: View {
    let store: HubStore
    let node: ItemNode
    let depth: Int
    @Environment(\.pluginPageId) private var pluginId

    var body: some View {
        let it = node.item
        if node.chart != nil {
            PluginChartView(store: store, node: node, card: false)
        } else if let c = node.control {
            // a control reached directly (inside details, a gauge card): drawn on its own
            if c == .table { PluginTableView(store: store, node: node, card: false) } else { ControlsGrid(store: store, nodes: [node]) }
        } else {
            lineBody(it)
        }
    }

    @ViewBuilder private func lineBody(_ it: Item) -> some View {
        // a top-level heading over rows with `bar=` (a ranked list) reads as a card title, like the chart cards
        let barHeading = depth == 0 && node.children.contains { $0.item.bar != nil }
        let titleFont = Font.system(size: barHeading ? 15 : depth == 0 ? 13 : 12, weight: depth == 0 && node.hasChildren ? .semibold : .regular)
        VStack(alignment: .leading, spacing: barHeading ? 12 : 5) {
            if it.separator || (it.isDetails && node.hasChildren) {
                EmptyView()
            } else if let offer = it.offer {
                if it.isLink {
                    OfferLink(store: store, item: it, offer: offer, depth: depth)
                } else {
                    OfferButton(store: store, item: it, offer: offer)
                }
            } else if it.bar != nil {
                BarLineView(item: it, depth: depth)
            } else {
                HStack(spacing: 7) {
                    if let st = it.status { Circle().fill(st.color).frame(width: 7, height: 7) }
                    if let sym = it.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                        Image(systemName: sym).font(.system(size: 12))
                            .foregroundStyle(swiftBarColor(it.iconColor ?? it.color) ?? .white.opacity(0.6))
                    }
                    // `font=mono`: a monospaced title (ids, hashes, aligned figures)
                    let font = it.isMono ? titleFont.monospaced() : titleFont
                    Text(it.title)
                        .font(font)
                        .foregroundStyle(swiftBarColor(it.color) ?? (depth == 0 ? .white : .white.opacity(0.65)))
                        .textSelection(.enabled)
                        .reportsTruncation(it.title, font: font)
                    if let s = it.session { SessionTag(session: s) }
                    if let badge = it.badge { BadgeView(text: badge, color: it.badgeColor) }
                }
                // a row with text selection: an AppKit field lies over it — an AppKit tooltip (HoverTip), not .help
                .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
            }
            if node.hasChildren, it.isDetails {
                DetailsDisclosure(store: store, node: node, depth: depth, pluginId: pluginId)
            } else if node.hasChildren {
                // capsule offers gather in one row below; link offers (`link=true`) and controls (a toggle carries its
                // own offer) stay in place
                let gathered: (ItemNode) -> Bool = { $0.item.offer != nil && !$0.item.isLink && $0.control == nil }
                let offers = node.children.filter(gathered)
                let rest = node.children.filter { !gathered($0) }
                let runs = ItemTree.runs(rest)
                let hasControls = runs.contains { if case .node = $0 { return false } else { return true } }
                // rows with `bar=` (a ranked list under a heading) line up with the heading, like controls
                let flush = hasControls || rest.contains { $0.item.bar != nil }
                VStack(alignment: .leading, spacing: hasControls ? 10 : flush ? 10 : 4) {
                    ForEach(Array(runs.enumerated()), id: \.offset) { _, run in
                        switch run {
                        case .controls(let nodes): ControlsGrid(store: store, nodes: nodes)
                        case .table(let n): PluginTableView(store: store, node: n, card: false)
                        case .chart(let n): PluginChartView(store: store, node: n, card: false)
                        case .node(let n): BlockNode(store: store, node: n, depth: depth + 1)
                        }
                    }
                    if !offers.isEmpty {
                        HStack(spacing: 6) { ForEach(offers) { o in OfferButton(store: store, item: o.item, offer: o.item.offer!) } }
                    }
                }
                // controls and tables under a heading line line up with it, as in the "Page" design
                .padding(.leading, flush ? 0 : 16)
            }
        }
    }
}

/// `details=true`: service details (process numbers, schedules) are collapsed and expand on click.
///
/// The control itself is the shared `RowDisclosure` (the whole header — chevron + title — is one plain button). What is
/// specific here: the open state also lives in `DetailsMemory` (AgentHubKit), keyed by the plugin, the details title
/// and its depth, so a page rebuilt by a plugin refresh (a new view identity) keeps the block open — and two plugins
/// with the same title don't open each other's blocks.
struct DetailsDisclosure: View {
    let store: HubStore
    let node: ItemNode
    let depth: Int
    let pluginId: String
    private let openStore: State<Bool>

    init(store: HubStore, node: ItemNode, depth: Int, pluginId: String) {
        self.store = store
        self.node = node
        self.depth = depth
        self.pluginId = pluginId
        openStore = State(initialValue: DetailsMemory.isOpen(plugin: pluginId, depth: depth, title: node.item.title))
    }

    var body: some View {
        // read here, not inside the binding: the body must depend on the state to be redrawn when it flips
        let open = openStore.wrappedValue
        let binding = Binding<Bool>(get: { open }, set: { now in
            openStore.wrappedValue = now
            DetailsMemory.set(now, plugin: pluginId, depth: depth, title: node.item.title)
        })
        RowDisclosure(isExpanded: binding, chevron: .white.opacity(0.5), spacing: 3, fillsRow: false) {
            VStack(alignment: .leading, spacing: 3) {
                ForEach(node.children) { BlockNode(store: store, node: $0, depth: depth + 1) }
            }
            .padding(.leading, 14).padding(.top, 2)
        } label: {
            Text(node.item.title.isEmpty ? tr("Подробности", "Details") : node.item.title)
                .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
        }
    }
}

/// The id of the plugin whose rows are being drawn: set by the plugin page (and by any other place that draws a
/// plugin's rows), read by `BlockNode` for per-plugin view memory. "" — outside a plugin.
struct PluginPageIdKey: EnvironmentKey {
    static let defaultValue: String = ""
}

extension EnvironmentValues {
    var pluginPageId: String {
        get { self[PluginPageIdKey.self] }
        set { self[PluginPageIdKey.self] = newValue }
    }
}

/// A number card (Panel.dc.html): a caption, a large value, a line below it in the `color=` color.
extension Item {
    /// The font for this line's title: `font=mono` keeps the size and weight and makes it monospaced (cards, chart titles,
    /// `bar=` lines, table group headings and the popover card use it, like plain lines and table rows).
    func titleFont(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: isMono ? .monospaced : .default)
    }
}

struct StatCard: View {
    let item: Item

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.stat ?? "").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                .reportsTruncation(item.stat ?? "", font: .system(size: 12))
            Text(item.title).font(item.titleFont(22, .bold)).lineLimit(1).minimumScaleFactor(0.6)
                .reportsTruncation(item.title, font: item.titleFont(22, .bold))
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
            let title = Text(it.title).font(it.titleFont(13, .semibold))
            let note = it.note.map { Text($0).font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)) }
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    title.lineLimit(1).fixedSize()
                    Spacer(minLength: 6)
                    if let note { note.lineLimit(1).fixedSize() }
                }
                VStack(alignment: .leading, spacing: 2) {
                    title.lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .reportsTruncation(it.title, font: it.titleFont(13, .semibold))
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
            Text(node.item.title).font(node.item.titleFont(13, .semibold))
                .reportsTruncation(node.item.title, font: node.item.titleFont(13, .semibold))
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
            Text(it.title).font(it.titleFont(12, .semibold)).lineLimit(1)
                .reportsTruncation(it.title, font: it.titleFont(12, .semibold))
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
    /// Table rows use a smaller capsule, a table header — a filled one.
    var style = CapsuleStyle(height: 26, expand: false)
    /// An immediate input action (G1) draws its text field in place (the plugin page); false — a capsule that asks for the
    /// text in a sheet (the popover, tight rows).
    var inlineInput = true

    /// What the core will certainly reject (connection, unpinned build, pause, bridge) — the button is disabled, and the tooltip
    /// says why (without the bridge — how to start it).
    private var block: ActionBlock? { store.gate(offer: offer) }

    var body: some View {
        if inlineInput, let spec = offer.input, offer.level == .immediate {
            OfferInputField(store: store, item: item, offer: offer, spec: spec)
        } else {
            capsule
        }
    }

    private var capsule: some View {
        HStack(spacing: 4) {
            Button {
                Task { await store.perform(offer: offer, label: item.title) }
            } label: {
                HStack(spacing: 5) {
                    if let sym = item.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil { Image(systemName: sym) }
                    // "…": asks first or asks for text; `font=mono` keeps the style's size and weight (re-review 74)
                    Text(item.title + (offer.level == .immediate && offer.input == nil ? "" : "…"))
                        .fontDesign(item.isMono ? .monospaced : nil)
                    if store.busyAction == offer.id { ProgressView().controlSize(.mini) }
                }
            }
            .buttonStyle(style)
            .help(block.map { BridgeText.help($0, primitive: offer.primitive, store) } ?? helpText)
            .disabled(store.busyAction != nil || block != nil)
            if offer.background { BackgroundMark() }
        }
    }

    private var helpText: String {
        let level = offer.level == .immediate ? (offer.label ?? "") : offer.level == .confirmCost ? tr("С подтверждением: тратит квоту или выходит в сеть", "Asks first: uses quota or the network") : tr("С подтверждением", "Asks first")
        return offer.background ? [level, JobsText.backgroundHelp].filter { !$0.isEmpty }.joined(separator: "\n") : level
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
        let font = Font.system(size: depth == 0 ? 13 : 12, design: item.isMono ? .monospaced : .default)
        HStack(spacing: 7) {
            if let sym = item.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                Image(systemName: sym).font(.system(size: 12))
                    .foregroundStyle(swiftBarColor(item.iconColor ?? item.color) ?? .white.opacity(0.6))
            }
            Button {
                Task { await store.perform(offer: offer, label: item.title) }
            } label: {
                Text(item.title + (offer.level == .immediate && offer.input == nil ? "" : "…"))
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
