import AgentHubKit
import AppKit
import SwiftUI

// Plugin page controls (hub 0.1.1, optional within contract 3): `segment=true`, `select=true`, `toggle=on|off` and
// `table=true` body lines. Every clickable part runs a plugin offer the same way `OfferButton` does: `store.gate(offer:)`
// disables it and says why in the tooltip, the core decides on confirmation, the busy offer shows a spinner.

/// The tooltip of an offer: what blocks it (pause, bridge, unpinned build), otherwise its confirmation level.
@MainActor
enum OfferHelp {
    static func text(_ offer: Offer, _ store: HubStore) -> String {
        if let block = store.gate(offer: offer) { return BridgeText.help(block, primitive: offer.primitive, store) }
        switch offer.level {
        case .immediate: return offer.label ?? ""
        case .confirmCost: return tr("С подтверждением: тратит квоту или выходит в сеть", "Asks first: uses quota or the network")
        default: return tr("С подтверждением", "Asks first")
        }
    }

    /// The button title: "…" after an offer that asks first (as on `OfferButton`).
    static func title(_ item: Item, _ offer: Offer?) -> String {
        item.title + (offer.map { $0.level == .immediate ? "" : "…" } ?? "")
    }
}

// MARK: - segment / select / toggle

/// Consecutive control lines: a label column (the line titles) and a control column, as in the "Page" design.
struct ControlsGrid: View {
    let store: HubStore
    let nodes: [ItemNode]

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            ForEach(nodes) { n in
                GridRow {
                    Text(n.item.title)
                        .font(.system(size: 13)).foregroundStyle(.white.opacity(0.8))
                        // as wide as the longest label (up to 170 pt, then it wraps), not always 170
                        .lineLimit(2).frame(maxWidth: 170, alignment: .leading).fixedSize(horizontal: true, vertical: false)
                        .reportsTruncation(n.item.title, font: .system(size: 13))
                        .hoverHelp(PluginText.rowHelp(n.item), always: n.item.tooltip != nil)
                    PluginControlView(store: store, node: n)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One control (without its label) and the line's `note=` beside it.
struct PluginControlView: View {
    let store: HubStore
    let node: ItemNode

    var body: some View {
        HStack(spacing: 10) {
            Group {
                switch node.control {
                case .segment?:
                    // too many options for the width — the same choice as a popup button
                    ViewThatFits(in: .horizontal) {
                        SegmentTrack(store: store, node: node)
                        SelectControl(store: store, node: node)
                    }
                case .select?:
                    SelectControl(store: store, node: node)
                case .toggle?:
                    ToggleControl(store: store, node: node)
                default:
                    EmptyView()
                }
            }
            .layoutPriority(1)
            if let n = node.item.note {
                Text(n).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.5))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .reportsTruncation(n, font: .system(size: 11.5))
                    .hoverHelp(n)
            }
        }
    }
}

/// `segment=true`: options in one shared track, the `selected=true` one highlighted.
struct SegmentTrack: View {
    let store: HubStore
    let node: ItemNode

    var body: some View {
        HStack(spacing: 0) {
            ForEach(node.children.filter { !$0.item.separator }) { SegmentButton(store: store, item: $0.item) }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color.white.opacity(0.08)))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(node.item.title)
    }
}

struct SegmentButton: View {
    let store: HubStore
    let item: Item
    private let hoverState = State(initialValue: false)

    var body: some View {
        let selected = item.isSelected
        let offer = item.offer
        let block = offer.flatMap { store.gate(offer: $0) }
        let enabled = !selected && offer != nil && block == nil && store.busyAction == nil
        Button {
            if let offer { Task { await store.perform(offer: offer, label: item.title) } }
        } label: {
            HStack(spacing: 4) {
                if let sym = item.sfImage, NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                    Image(systemName: sym).font(.system(size: 11))
                }
                Text(selected ? item.title : OfferHelp.title(item, offer)).lineLimit(1)
                if let offer, store.busyAction == offer.id { ProgressView().controlSize(.mini) }
            }
            .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
            .foregroundStyle(.white.opacity(selected || enabled ? 1 : 0.4))
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(selected ? 0.22 : hoverState.wrappedValue && enabled ? 0.08 : 0)))
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        // the selected option is not a button to press; an option without an offer is shown, but can't be chosen
        .allowsHitTesting(!selected)
        .disabled(!selected && !enabled)
        .onHover { hoverState.wrappedValue = $0 }
        .accessibilityAddTraits(selected ? .isSelected : [])
        .hoverHelp(selected ? PluginText.help(tooltip: item.tooltip, item.note) : offer.map { OfferHelp.text($0, store) } ?? PluginText.help(tooltip: item.tooltip, item.note),
                   always: true)
    }
}

/// `select=true`: the current option with a chevron; a menu of all options (`note=` dimmed under the title).
struct SelectControl: View {
    let store: HubStore
    let node: ItemNode

    var body: some View {
        let options = node.children.filter { !$0.item.separator }
        let current = options.first { $0.item.isSelected }?.item
        let offers = options.compactMap(\.item.offer)
        let busy = offers.contains { $0.id == store.busyAction }
        let usable = offers.contains { store.gate(offer: $0) == nil }
        HStack(spacing: 6) {
            Menu {
                ForEach(options) { o in
                    let it = o.item
                    if it.isSelected {
                        // a checkmark on the current option; choosing it again does nothing
                        Toggle(isOn: Binding(get: { true }, set: { _ in })) { label(it, it.title) }
                    } else if let offer = it.offer {
                        let block = store.gate(offer: offer)
                        Button { Task { await store.perform(offer: offer, label: it.title) } } label: { label(it, OfferHelp.title(it, offer)) }
                            .disabled(block != nil || store.busyAction != nil)
                    } else {
                        Button {} label: { label(it, it.title) }.disabled(true)
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Text(current?.title ?? tr("Выбрать…", "Choose…")).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.6))
                }
                .font(.system(size: 13))
                .foregroundStyle(.white)
                .padding(.leading, 12).padding(.trailing, 10)
                .frame(height: 28)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.08)))
                .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
                .contentShape(RoundedRectangle(cornerRadius: 7))
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .fixedSize()
            .disabled(!usable || store.busyAction != nil)
            .accessibilityLabel(node.item.title)
            .accessibilityValue(current?.title ?? "")
            // nothing to choose: say why (the first block), otherwise the full current value
            .hoverHelp(usable ? PluginText.help(tooltip: current?.tooltip, current?.title, current?.note)
                              : offers.first.map { OfferHelp.text($0, store) } ?? tr("Выбрать не из чего", "Nothing to choose from"),
                       always: true)
            if busy { ProgressView().controlSize(.mini) }
        }
    }

    @ViewBuilder private func label(_ it: Item, _ title: String) -> some View {
        Text(title)
        if let n = it.note { Text(n) }
    }
}

/// `toggle=on|off`: a switch in the state the plugin printed; a click runs the line's offer (the plugin flips it).
struct ToggleControl: View {
    let store: HubStore
    let node: ItemNode

    var body: some View {
        let it = node.item
        let on = it.toggleState ?? false
        let offer = it.offer
        let block = offer.flatMap { store.gate(offer: $0) }
        HStack(spacing: 6) {
            Toggle(it.title, isOn: Binding(get: { on }, set: { _ in
                if let offer { Task { await store.perform(offer: offer, label: it.title) } }
            }))
            .toggleStyle(.switch)
            .labelsHidden()
            .tint(hexColor(0x0A84FF))
            .disabled(offer == nil || block != nil || store.busyAction != nil)
            .hoverHelp(offer.map { OfferHelp.text($0, store) } ?? PluginText.rowHelp(it), always: offer != nil || it.tooltip != nil)
            if let offer, store.busyAction == offer.id { ProgressView().controlSize(.mini) }
        }
    }
}

// MARK: - table

/// Widths of the two trailing slots, the same in every row so the columns line up: buttons and notes, icon buttons.
struct TableSlotWidths: Equatable {
    var text: CGFloat = 0
    var icon: CGFloat = 0
}

struct TableSlotWidthsKey: PreferenceKey {
    static let defaultValue = TableSlotWidths()
    static func reduce(value: inout TableSlotWidths, nextValue: () -> TableSlotWidths) {
        let n = nextValue()
        value = TableSlotWidths(text: max(value.text, n.text), icon: max(value.icon, n.icon))
    }
}

/// One table row: `columns` data cells (the first wider), then the two trailing slots, right-aligned.
struct TableRowLayout: Layout {
    var columns: Int
    var textSlot: CGFloat
    var iconSlot: CGFloat
    var spacing: CGFloat = 12

    private func weight(_ i: Int) -> CGFloat { i == 0 ? 1.5 : 1 }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let h = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
        return CGSize(width: proposal.width ?? 600, height: proposal.height ?? h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let n = min(columns, subviews.count)
        let slots = (textSlot > 0 ? textSlot + spacing : 0) + (iconSlot > 0 ? iconSlot + spacing : 0)
        let avail = max(0, bounds.width - slots - spacing * CGFloat(max(0, n - 1)))
        let unit = avail / (0..<n).reduce(0) { $0 + weight($1) }
        var x = bounds.minX
        for i in 0..<n {
            let w = unit * weight(i)
            subviews[i].place(at: CGPoint(x: x, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: w, height: bounds.height))
            x += w + spacing
        }
        if subviews.count > n {
            let right = bounds.maxX - (iconSlot > 0 ? iconSlot + spacing : 0)
            subviews[n].place(at: CGPoint(x: right, y: bounds.midY), anchor: .trailing, proposal: ProposedViewSize(width: textSlot, height: bounds.height))
        }
        if subviews.count > n + 1 {
            subviews[n + 1].place(at: CGPoint(x: bounds.maxX, y: bounds.midY), anchor: .trailing, proposal: ProposedViewSize(width: iconSlot, height: bounds.height))
        }
    }
}

/// `table=true`: the title (and `header=true` buttons), column titles, ~34 pt rows, collapsible `group=true` subheadings.
struct PluginTableView: View {
    let store: HubStore
    let node: ItemNode
    /// On a page segment of its own the table is a card; nested in a list line it draws without one.
    let card: Bool
    private let widthsState = State(initialValue: TableSlotWidths())

    var body: some View {
        let t = PluginTable(node)
        let widths = widthsState.wrappedValue
        let content = VStack(alignment: .leading, spacing: 4) {
            if !node.item.title.isEmpty || !t.headerOffers.isEmpty {
                HStack(spacing: 12) {
                    Text(node.item.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white.opacity(0.75))
                        .lineLimit(1)
                        .reportsTruncation(node.item.title, font: .system(size: 13, weight: .semibold))
                        .hoverHelp(PluginText.rowHelp(node.item), always: node.item.tooltip != nil)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(t.headerOffers) { o in
                        OfferButton(store: store, item: o.item, offer: o.item.offer!,
                                    style: CapsuleStyle(fill: hexColor(0x0A84FF), stroke: .clear, height: 28, expand: false))
                            .fixedSize()
                    }
                }
                .padding(.bottom, 4)
            }
            if !t.columns.isEmpty {
                TableRowLayout(columns: t.columnCount, textSlot: widths.text, iconSlot: widths.icon) {
                    ForEach(0..<t.columnCount, id: \.self) { i in
                        let title = i < t.columns.count ? t.columns[i] : ""
                        Text(title).lineLimit(1)
                            .reportsTruncation(title, font: .system(size: 11, weight: .semibold))
                            .hoverHelp(title)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Color.clear.frame(width: 0, height: 0)
                    Color.clear.frame(width: 0, height: 0)
                }
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.42))
                .padding(.horizontal, 10)
                .frame(height: 18)
                .accessibilityElement(children: .combine)
            }
            ForEach(t.entries) { e in
                switch e {
                case .row(let r):
                    TableRowView(store: store, row: r, columns: t.columnCount, widths: widths, marks: t.hasMarks, inGroup: false)
                case .group(let g, let rows):
                    TableGroupView(store: store, table: node, group: g, rows: rows, columns: t.columnCount, widths: widths, marks: t.hasMarks)
                }
            }
        }
        .onPreferenceChange(TableSlotWidthsKey.self) { w in MainActor.assumeIsolated { widthsState.wrappedValue = w } }
        if card {
            content
                .padding(.horizontal, 16).padding(.vertical, 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 16).fill(Color.white.opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
        } else {
            content.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// A `group=true` row: a subheading (chevron + title) that collapses its rows. A plain button, not a `DisclosureGroup`
/// (which on macOS toggles only from its chevron, see `DetailsDisclosure`); the state lives in `TableGroupMemory`.
struct TableGroupView: View {
    let store: HubStore
    let group: ItemNode
    let rows: [PluginTable.Row]
    let columns: Int
    let widths: TableSlotWidths
    let marks: Bool
    private let key: String
    private let openStore: State<Bool>

    init(store: HubStore, table: ItemNode, group: ItemNode, rows: [PluginTable.Row], columns: Int, widths: TableSlotWidths, marks: Bool) {
        self.store = store; self.group = group; self.rows = rows; self.columns = columns; self.widths = widths; self.marks = marks
        key = PluginTable.groupKey(table.item.title) + "|" + PluginTable.groupKey(group.item.title)
        openStore = State(initialValue: !TableGroupMemory.closed.contains(key))
    }

    var body: some View {
        let open = openStore.wrappedValue
        VStack(alignment: .leading, spacing: 4) {
            Button {
                let now = !openStore.wrappedValue
                openStore.wrappedValue = now
                if now { TableGroupMemory.closed.remove(key) } else { TableGroupMemory.closed.insert(key) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text(group.item.title).font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
                        .reportsTruncation(group.item.title, font: .system(size: 11.5, weight: .semibold))
                    if let n = group.item.note {
                        Text(n).font(.system(size: 11.5)).lineLimit(1).foregroundStyle(.white.opacity(0.4))
                    }
                }
                .foregroundStyle(swiftBarColor(group.item.color) ?? .white.opacity(0.5))
                .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverHelp(PluginText.rowHelp(group.item), always: group.item.tooltip != nil)
            .accessibilityAddTraits(.isButton)
            .accessibilityValue(open ? tr("развёрнуто", "expanded") : tr("свёрнуто", "collapsed"))
            if open {
                ForEach(rows) { TableRowView(store: store, row: $0, columns: columns, widths: widths, marks: marks, inGroup: true) }
            }
        }
    }
}

/// Which table groups are collapsed (groups start expanded), for the app's lifetime: survives page rebuilds.
@MainActor
enum TableGroupMemory {
    static var closed: Set<String> = []
}

/// A table row: a state dot and the title, the cells, buttons and notes, icon buttons.
struct TableRowView: View {
    let store: HubStore
    let row: PluginTable.Row
    let columns: Int
    let widths: TableSlotWidths
    let marks: Bool
    let inGroup: Bool

    var body: some View {
        let it = row.item
        TableRowLayout(columns: columns, textSlot: widths.text, iconSlot: widths.icon) {
            title(it)
            ForEach(0..<max(0, columns - 1), id: \.self) { i in cell(row.cells[i], color: row.colors[i]) }
            HStack(spacing: 6) { ForEach(row.slot) { slotItem($0.item) } }
                .fixedSize()
                .background(GeometryReader { g in Color.clear.preference(key: TableSlotWidthsKey.self, value: TableSlotWidths(text: g.size.width)) })
                .frame(maxWidth: .infinity, alignment: .trailing)
            HStack(spacing: 2) { ForEach(row.icons) { IconOfferButton(store: store, item: $0.item) } }
                .fixedSize()
                .background(GeometryReader { g in Color.clear.preference(key: TableSlotWidthsKey.self, value: TableSlotWidths(icon: g.size.width)) })
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .font(.system(size: 13))
        .padding(.horizontal, 10)
        .frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(inGroup ? 0 : 0.04)))
    }

    @ViewBuilder private func title(_ it: Item) -> some View {
        HStack(spacing: 8) {
            if marks {
                Group {
                    if let sym = it.sfImage, sym != "circle.fill", NSImage(systemSymbolName: sym, accessibilityDescription: nil) != nil {
                        Image(systemName: sym).font(.system(size: 10))
                            .foregroundStyle(swiftBarColor(it.iconColor ?? it.color) ?? .white.opacity(0.6))
                    } else if it.sfImage != nil || it.status != nil {
                        // `sfimage=circle.fill` (or a `status=`): the small state dot of the design
                        Circle().fill(swiftBarColor(it.iconColor ?? it.color) ?? it.status?.color ?? .white.opacity(0.35)).frame(width: 7, height: 7)
                    }
                }
                .frame(width: 10)
            }
            if let offer = it.offer {
                // a row with its own offer: the title is a link
                OfferLink(store: store, item: it, offer: offer, depth: 1)
            } else {
                Text(it.title).lineLimit(1)
                    .foregroundStyle(swiftBarColor(it.color) ?? .white.opacity(inGroup ? 0.78 : 1))
                    .reportsTruncation(it.title, font: .system(size: 13))
                if let s = it.session { SessionTag(session: s) }
                if let badge = it.badge { BadgeView(text: badge, color: it.badgeColor) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
    }

    private func cell(_ text: String, color: String?) -> some View {
        let c = swiftBarColor(color)
        let font = Font.system(size: 13, weight: c == nil ? .regular : .semibold)
        return Text(text).font(font).lineLimit(1)
            .foregroundStyle(c ?? .white.opacity(inGroup ? 0.62 : 0.72))
            .reportsTruncation(text, font: font)
            .hoverHelp(text)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func slotItem(_ it: Item) -> some View {
        if let offer = it.offer {
            OfferButton(store: store, item: it, offer: offer,
                        style: CapsuleStyle(fill: .white.opacity(0.1), stroke: .white.opacity(0.18), height: 24, expand: false))
                .fixedSize()
        } else {
            Text(it.title).font(.system(size: 11.5)).lineLimit(1)
                .foregroundStyle(swiftBarColor(it.color) ?? .white.opacity(0.48))
                .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
        }
    }
}

/// `icon=true`: an icon-only offer button; the title is its tooltip and accessibility label. Without an offer —
/// just the icon, dimmed.
struct IconOfferButton: View {
    let store: HubStore
    let item: Item
    private let hoverState = State(initialValue: false)

    var body: some View {
        let offer = item.offer
        let block = offer.flatMap { store.gate(offer: $0) }
        let enabled = offer != nil && block == nil && store.busyAction == nil
        let sym = item.sfImage.flatMap { NSImage(systemSymbolName: $0, accessibilityDescription: nil) != nil ? $0 : nil } ?? "questionmark.circle"
        Button {
            if let offer { Task { await store.perform(offer: offer, label: item.title) } }
        } label: {
            Group {
                if let offer, store.busyAction == offer.id {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: sym).font(.system(size: 13))
                }
            }
            .foregroundStyle(swiftBarColor(item.iconColor ?? item.color) ?? .white.opacity(enabled ? (hoverState.wrappedValue ? 0.95 : 0.6) : 0.3))
            .frame(width: 28, height: 24)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(hoverState.wrappedValue && enabled ? 0.1 : 0)))
            .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .onHover { hoverState.wrappedValue = $0 }
        .accessibilityLabel(item.title)
        .hoverHelp(block.map { _ in OfferHelp.text(offer!, store) } ?? OfferHelp.title(item, offer), always: true)
    }
}
