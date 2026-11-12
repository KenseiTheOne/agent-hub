import AgentHubKit
import Accessibility
import AppKit
import SwiftUI

// Plugin page charts (hub 0.1.3, optional within contract 3): `chart=bars`, `chart=share`, `bar=` on a line or a table
// row and `spark=` on the first header line. An older hub ignores the keys and draws the lines as plain text. The data
// and its parsing live in AgentHubKit (`PluginBarChart`, `PluginShareChart`, `Item.spark`); these views only draw it.
// Nothing here knows a plugin: the highlight color is the plugin's declared icon color (`pluginAccent`) or `color=`.

/// The plugin's own color (`<agenthub.icon color=…>`) for highlights; without a declaration — the system blue.
struct PluginAccentKey: EnvironmentKey {
    static let defaultValue: Color = hexColor(0x0A84FF)
}

extension EnvironmentValues {
    var pluginAccent: Color {
        get { self[PluginAccentKey.self] }
        set { self[PluginAccentKey.self] = newValue }
    }
}

@MainActor
func pluginAccent(_ p: PluginState) -> Color {
    guard let v = (p.icon ?? PluginIconBook.shared.icon(p.id))?.rgb else { return hexColor(0x0A84FF) }
    return hexColor(v)
}

enum ChartPalette {
    /// Stacked series without `colors=`: bottom layer first.
    static let series: [UInt32] = [0x64D2FF, 0xBF5AF2, 0xFF9F0A, 0x30D158, 0x0A84FF, 0xFF375F, 0xFFD60A]
    /// Share parts without `color=`.
    static let share: [UInt32] = [0xBF5AF2, 0x0A84FF, 0x64D2FF, 0x30D158, 0xFF9F0A, 0xFF375F, 0xFFD60A]
    static let bar = Color.white.opacity(0.32)
    static let empty = Color.white.opacity(0.1)
    static let over = hexColor(0xFF9F0A, 0.85)

    static func color(_ raw: String?, _ i: Int, _ list: [UInt32]) -> Color {
        swiftBarColor(raw) ?? hexColor(list[i % list.count])
    }
}

/// A card like the other page cards, a little roomier for a chart.
private struct ChartCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 18).padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 18).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
    }
}

/// A horizontal dashed line across the frame (the average).
private struct DashedRule: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.minX, y: rect.midY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        return p
    }
}

/// A chart line on the page: `chart=bars` or `chart=share`, as a card of its own or nested without one.
struct PluginChartView: View {
    let store: HubStore
    let node: ItemNode
    let card: Bool

    var body: some View {
        switch node.chart {
        case .bars?: BarChartView(store: store, node: node, card: card)
        case .share?: ShareChartView(node: node, card: card)
        case nil: EmptyView()
        }
    }
}

/// The children of a chart line below it: tables, controls, charts and plain lines, as under a list heading.
struct PluginChildRuns: View {
    let store: HubStore
    let nodes: [ItemNode]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(ItemTree.runs(nodes).enumerated()), id: \.offset) { _, run in
                switch run {
                case .controls(let ns): ControlsGrid(store: store, nodes: ns)
                case .table(let n): PluginTableView(store: store, node: n, card: false)
                case .chart(let n): PluginChartView(store: store, node: n, card: false)
                case .node(let n): BlockNode(store: store, node: n, depth: 1)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - chart=bars

/// `chart=bars`: the title with `note=` or a segment/select child on the right, the bars (stacked when `stack=`), the
/// labels under them, an optional legend, then the other children (a table under the chart, for example).
struct BarChartView: View {
    let store: HubStore
    let node: ItemNode
    let card: Bool
    @Environment(\.pluginAccent) private var accent

    var body: some View {
        if let chart = PluginBarChart(node.item) {
            let kids = node.children.filter { !$0.item.separator }
            let control = kids.first { $0.control == .segment || $0.control == .select }
            let rest = kids.filter { $0.id != control?.id }
            let content = VStack(alignment: .leading, spacing: 12) {
                header(control)
                BarChartPlot(chart: chart, highlight: swiftBarColor(node.item.color) ?? accent, title: node.item.title)
                if chart.legend && chart.isStacked { legend(chart) }
                if !rest.isEmpty {
                    Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5)
                    PluginChildRuns(store: store, nodes: rest)
                }
            }
            if card { content.modifier(ChartCard()) } else { content.frame(maxWidth: .infinity, alignment: .leading) }
        }
    }

    @ViewBuilder private func header(_ control: ItemNode?) -> some View {
        let it = node.item
        HStack(alignment: .center, spacing: 10) {
            if !it.title.isEmpty {
                Text(it.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    .reportsTruncation(it.title, font: .system(size: 15, weight: .semibold))
                    .hoverHelp(PluginText.rowHelp(it), always: it.tooltip != nil)
            }
            Spacer(minLength: 8)
            if let n = it.note {
                Text(n).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55)).lineLimit(1)
                    .reportsTruncation(n, font: .system(size: 12))
                    .hoverHelp(n)
            }
            if let c = control {
                if c.control == .segment {
                    ViewThatFits(in: .horizontal) {
                        SegmentTrack(store: store, node: c)
                        SelectControl(store: store, node: c)
                    }
                } else {
                    SelectControl(store: store, node: c)
                }
            }
        }
    }

    private func legend(_ chart: PluginBarChart) -> some View {
        HStack(spacing: 14) {
            ForEach(Array(chart.series.enumerated()), id: \.offset) { i, name in
                HStack(spacing: 6) {
                    RoundedRectangle(cornerRadius: 2).fill(ChartPalette.color(i < chart.colors.count ? chart.colors[i] : nil, i, ChartPalette.series))
                        .frame(width: 8, height: 8)
                    Text(name).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                }
            }
        }
    }
}

/// The plot of `chart=bars`: bars bottom-aligned with value captions above them, the dashed average line, labels below.
///
/// Drawn on one `Canvas`, not as a view per bar (2026-11-12): a page with two 30-bar charts was ~200 SwiftUI views,
/// accessibility elements and AppKit tooltip views, and switching a range of 14 ↔ 30 days created or tore down dozens of
/// them, which took ~200 ms of the main thread per redraw — the switch felt sluggish. Now every redraw is two canvases
/// and one tooltip view, whatever the number of bars. Tooltips: every bar column (full height) carries its `tips=` entry
/// as an AppKit tooltip rectangle (`ChartTips`); VoiceOver gets the bars through `accessibilityChartDescriptor`.
struct BarChartPlot: View {
    let chart: PluginBarChart
    let highlight: Color
    var title = ""

    static let labelsHeight: CGFloat = 15

    var body: some View {
        let layout = BarLayout(chart)
        VStack(spacing: 6) {
            Canvas { ctx, size in drawPlot(ctx, size, layout) }
                .frame(height: CGFloat(chart.height))
                .overlay(ChartTips(tips: chart.bars.map(\.tip), gap: layout.gap))
            if chart.bars.contains(where: { $0.label != nil }) {
                Canvas { ctx, size in drawLabels(ctx, size, layout) }
                    .frame(height: Self.labelsHeight)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityChartDescriptor(BarChartDescriptor(chart: chart, title: title))
    }

    /// Bar geometry shared by the plot, the labels and the tooltip rectangles.
    struct BarLayout {
        let count: Int
        let gap: CGFloat
        let radius: CGFloat

        init(_ chart: PluginBarChart) {
            count = chart.bars.count
            gap = count <= 16 ? 8 : count <= 32 ? 4 : 2
            radius = count > 20 ? 3 : 5
        }

        /// The horizontal span of bar `i` in a row `width` wide.
        func column(_ i: Int, width: CGFloat) -> (x: CGFloat, w: CGFloat) {
            guard count > 0 else { return (0, 0) }
            let w = max(0, (width - gap * CGFloat(count - 1)) / CGFloat(count))
            return (CGFloat(i) * (w + gap), w)
        }
    }

    private var hasValueLabels: Bool { chart.bars.contains { $0.valueLabel != nil } }
    /// The bars' share of the plot: the rest is room for the captions above the tallest bar.
    private var plotHeight: CGFloat { CGFloat(chart.height) - (hasValueLabels ? 17 : 2) }

    private func height(_ b: PluginBarChart.Bar) -> CGFloat {
        guard b.total > 0, chart.scaleMax > 0 else { return 2 }
        let visible = CGFloat(b.layers.filter { $0 > 0 }.count)
        // a fixed `max=` clips taller bars at the top of the plot
        return min(plotHeight, max(3, visible * 2, plotHeight * CGFloat(chart.fraction(b.total))))
    }

    private func fill(_ b: PluginBarChart.Bar) -> Color {
        if b.total <= 0 { return ChartPalette.empty }
        if b.highlighted { return highlight }
        if b.aboveAverage && chart.tint { return ChartPalette.over }
        return ChartPalette.bar
    }

    private func layerColor(_ i: Int) -> Color {
        ChartPalette.color(i < chart.colors.count ? chart.colors[i] : nil, i, ChartPalette.series)
    }

    private func drawPlot(_ ctx: GraphicsContext, _ size: CGSize, _ l: BarLayout) {
        for b in chart.bars {
            let (x, w) = l.column(b.id, width: size.width)
            guard w > 0 else { continue }
            let h = min(height(b), size.height)
            let rect = CGRect(x: x, y: size.height - h, width: w, height: h)
            let r = min(l.radius, w / 2)
            let shape = UnevenRoundedRectangle(topLeadingRadius: r, bottomLeadingRadius: min(2, w / 2),
                                               bottomTrailingRadius: min(2, w / 2), topTrailingRadius: r).path(in: rect)
            if chart.isStacked && b.total > 0 {
                var c = ctx
                c.clip(to: shape)
                var y = rect.maxY
                for (i, lh) in PluginBarChart.layerHeights(b.layers, height: Double(h)).enumerated() where lh > 0 {
                    c.fill(Path(CGRect(x: x, y: y - CGFloat(lh), width: w, height: CGFloat(lh))), with: .color(layerColor(i)))
                    y -= CGFloat(lh)
                }
            } else {
                ctx.fill(shape, with: .color(fill(b)))
            }
            if let v = b.valueLabel {
                let text = ctx.resolve(Text(v).font(.system(size: 10.5, weight: b.highlighted ? .semibold : .regular))
                    .foregroundStyle(b.highlighted ? .white : .white.opacity(0.7)))
                Self.drawFitted(ctx, text, centerX: x + w / 2, bottom: rect.minY - 3, width: w, minScale: 0.5)
            }
        }
        if let avg = chart.avg, chart.averageVisible { drawAverage(ctx, size, avg) }
    }

    private func drawAverage(_ ctx: GraphicsContext, _ size: CGSize, _ avg: Double) {
        let y = size.height - plotHeight * CGFloat(avg / chart.scaleMax)
        var rule = Path()
        rule.move(to: CGPoint(x: 0, y: y))
        rule.addLine(to: CGPoint(x: size.width, y: y))
        ctx.stroke(rule, with: .color(.white.opacity(0.3)), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        let text = ctx.resolve(Text(chart.avgLabel ?? tr("ср.", "avg")).font(.system(size: 11)).foregroundStyle(.white.opacity(0.6)))
        let ts = text.measure(in: CGSize(width: size.width, height: 40))
        let box = CGRect(x: size.width - ts.width - 10, y: y + 3 - ts.height - 2, width: ts.width + 10, height: ts.height + 2)
        ctx.fill(RoundedRectangle(cornerRadius: 4).path(in: box), with: .color(hexColor(0x1F1F26, 0.85)))
        ctx.draw(text, at: CGPoint(x: box.midX, y: box.midY), anchor: .center)
    }

    private func drawLabels(_ ctx: GraphicsContext, _ size: CGSize, _ l: BarLayout) {
        for b in chart.bars {
            guard let s = b.label else { continue }
            let (x, w) = l.column(b.id, width: size.width)
            let text = ctx.resolve(Text(s).font(.system(size: 11, weight: b.highlighted ? .semibold : .regular))
                .foregroundStyle(b.highlighted ? .white : .white.opacity(0.5)))
            Self.drawFitted(ctx, text, centerX: x + w / 2, bottom: size.height, width: w, minScale: 0.6)
        }
    }

    /// One line of text centered over `centerX` with its bottom at `bottom`, shrunk down to `minScale` to fit `width`
    /// (like `minimumScaleFactor`); still wider — drawn at `minScale`, overflowing evenly on both sides.
    private static func drawFitted(_ ctx: GraphicsContext, _ text: GraphicsContext.ResolvedText, centerX: CGFloat, bottom: CGFloat,
                                   width: CGFloat, minScale: CGFloat) {
        let ts = text.measure(in: CGSize(width: CGFloat.greatestFiniteMagnitude, height: 40))
        let k = ts.width > width && ts.width > 0 ? max(minScale, width / ts.width) : 1
        var c = ctx
        c.translateBy(x: centerX, y: bottom)
        if k < 1 { c.scaleBy(x: k, y: k) }
        c.draw(text, at: .zero, anchor: .bottom)
    }

    static func number(_ v: Double, _ unit: String?) -> String {
        let s = v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v)
        return unit.map { "\(s) \($0)" } ?? s
    }
}

/// VoiceOver for `chart=bars`: the bars as a data series (label → value), read on demand — no view per bar.
struct BarChartDescriptor: AXChartDescriptorRepresentable {
    let chart: PluginBarChart
    let title: String

    func makeChartDescriptor() -> AXChartDescriptor {
        let names = chart.bars.map { $0.label ?? String($0.id + 1) }
        let top = max(chart.scaleMax, 1)
        let x = AXCategoricalDataAxisDescriptor(title: "", categoryOrder: names)
        let y = AXNumericDataAxisDescriptor(title: chart.unit ?? "", range: 0...top, gridlinePositions: chart.avg.map { [$0] } ?? []) {
            BarChartPlot.number($0, chart.unit)
        }
        let points = chart.bars.map { b in
            AXDataPoint(x: names[b.id], y: b.total, additionalValues: [], label: [b.valueLabel, b.tip].compactMap { $0 }.joined(separator: ". "))
        }
        return AXChartDescriptor(title: title, summary: nil, xAxis: x, yAxis: y, additionalAxes: [],
                                 series: [AXDataSeriesDescriptor(name: "", isContinuous: false, dataPoints: points)])
    }
}

/// Tooltips of a bar chart: one transparent AppKit view with a tooltip rectangle per bar column (`addToolTip`), instead of
/// a `HoverTip` view per bar. Same behavior as `HoverTip`: instant, multi-line, shown in an inactive app, transparent to
/// the mouse.
struct ChartTips: NSViewRepresentable {
    let tips: [String?]
    let gap: CGFloat

    func makeNSView(context: Context) -> ChartTipsView {
        HoverTip.enableInstantTips()
        let v = ChartTipsView()
        v.setAccessibilityElement(false)
        v.update(tips: tips, gap: gap)
        return v
    }

    func updateNSView(_ v: ChartTipsView, context: Context) {
        v.update(tips: tips, gap: gap)
    }
}

final class ChartTipsView: NSView {
    private var tips: [String?] = []
    private var gap: CGFloat = 0
    private var laidOut: (NSSize, [String?], CGFloat)?
    /// The tooltip owners, held for as long as their tooltip rectangles exist.
    private var owners: [NSString] = []

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var isOpaque: Bool { false }

    func update(tips: [String?], gap: CGFloat) {
        guard tips != self.tips || gap != self.gap else { return }
        self.tips = tips
        self.gap = gap
        rebuild()
    }

    // SwiftUI sizes the view by setting its frame, which does not always call `layout()`
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        rebuild()
    }

    override func layout() {
        super.layout()
        rebuild()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let w = window else { return }
        if !w.allowsToolTipsWhenApplicationIsInactive { w.allowsToolTipsWhenApplicationIsInactive = true }
        laidOut = nil
        rebuild()
    }

    /// The tooltip rectangles follow the bar columns of `BarChartPlot.BarLayout`; rebuilt only when the size or the texts change.
    private func rebuild() {
        let key = (bounds.size, tips, gap)
        if let l = laidOut, l.0 == key.0, l.1 == key.1, l.2 == key.2 { return }
        laidOut = key
        removeAllToolTips()
        owners = []
        guard window != nil, !tips.isEmpty, bounds.width > 0 else { return }
        let n = CGFloat(tips.count)
        let w = max(0, (bounds.width - gap * (n - 1)) / n)
        for (i, t) in tips.enumerated() {
            guard let t, !t.isEmpty else { continue }
            // the gap belongs half to each neighbor, so the pointer between bars still finds a tooltip
            let x0 = max(0, CGFloat(i) * (w + gap) - gap / 2)
            let x1 = min(bounds.width, CGFloat(i) * (w + gap) + w + gap / 2)
            // AppKit does not retain a tooltip owner: a short string bridged to a tagged/temporary NSString would be freed
            // right after this call (a crash or another bar's text on hover), so the view keeps every owner alive
            let owner = NSString(string: t)
            owners.append(owner)
            addToolTip(NSRect(x: x0, y: 0, width: x1 - x0, height: bounds.height), owner: owner, userData: nil)
        }
    }
}

// MARK: - chart=share

/// `chart=share`: one rounded bar of the children's shares and a legend: dot · title · percent · `note=`.
struct ShareChartView: View {
    let node: ItemNode
    let card: Bool

    var body: some View {
        if let chart = PluginShareChart(node) {
            let content = VStack(alignment: .leading, spacing: 12) {
                if !node.item.title.isEmpty {
                    Text(node.item.title).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                        .reportsTruncation(node.item.title, font: .system(size: 15, weight: .semibold))
                        .hoverHelp(PluginText.rowHelp(node.item), always: node.item.tooltip != nil)
                }
                GeometryReader { g in
                    let widths = PluginBarChart.layerHeights(chart.parts.map(\.value), height: Double(g.size.width))
                    HStack(spacing: 0) {
                        ForEach(Array(chart.parts.enumerated()), id: \.offset) { i, p in
                            if widths[i] > 0 {
                                Rectangle().fill(ChartPalette.color(p.color, i, ChartPalette.share)).frame(width: CGFloat(widths[i]))
                            }
                        }
                    }
                }
                .frame(height: 14)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(chart.parts.enumerated()), id: \.offset) { i, p in row(p, i) }
                }
            }
            if card { content.modifier(ChartCard()) } else { content.frame(maxWidth: .infinity, alignment: .leading) }
        }
    }

    private func row(_ p: PluginShareChart.Part, _ i: Int) -> some View {
        HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 3).fill(ChartPalette.color(p.color, i, ChartPalette.share)).frame(width: 9, height: 9)
            Text(p.title).font(.system(size: 13)).lineLimit(1)
                .reportsTruncation(p.title, font: .system(size: 13))
            Spacer(minLength: 6)
            Text(p.percentText).font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).fixedSize()
            if let n = p.note {
                Text(n).font(.system(size: 13, weight: .semibold)).lineLimit(1).fixedSize()
                    .frame(minWidth: 64, alignment: .trailing)
            }
        }
        .accessibilityElement(children: .combine)
        .hoverHelp(PluginText.help(tooltip: p.item.tooltip, p.title, p.note), always: p.item.tooltip != nil)
    }
}

// MARK: - bar=

/// A thin progress bar 0…100: a dim track and a fill in `color`; a visible value is at least as wide as it is tall.
struct ThinBar: View {
    let percent: Double
    let color: Color
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                if percent > 0 {
                    Capsule().fill(color).frame(width: max(height, g.size.width * CGFloat(percent) / 100))
                }
            }
        }
        .frame(height: height)
        .accessibilityElement()
        .accessibilityValue("\(Int(percent.rounded()))%")
    }
}

/// A body line with `bar=`: the title (and badge) on the left, `note=` on the right, the bar under them. `color=` tints the
/// bar, not the title.
struct BarLineView: View {
    let item: Item
    let depth: Int
    @Environment(\.pluginAccent) private var accent

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(item.title).font(.system(size: depth == 0 ? 13 : 12.5)).lineLimit(1)
                    .reportsTruncation(item.title, font: .system(size: depth == 0 ? 13 : 12.5))
                if let badge = item.badge {
                    Text(badge).font(.system(size: 11)).foregroundStyle(swiftBarColor(item.badgeColor) ?? .white.opacity(0.5)).lineLimit(1)
                }
                Spacer(minLength: 8)
                if let n = item.note {
                    Text(n).font(.system(size: 13, weight: .semibold)).lineLimit(1).fixedSize()
                }
            }
            ThinBar(percent: item.bar ?? 0, color: swiftBarColor(item.color) ?? accent)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .hoverHelp(PluginText.rowHelp(item), always: item.tooltip != nil)
    }
}

// MARK: - spark=

/// A mini bar sparkline: the last bar in `highlight`, bars above `avg` tinted, the others dim; `showAverage` draws the
/// dashed average line.
struct SparkBars: View {
    let values: [Double]
    var avg: Double? = nil
    let highlight: Color
    var spacing: CGFloat = 3
    var radius: CGFloat = 2
    var showAverage = false
    /// `sparkMax=`: a fixed scale top (taller bars are clipped); nil — the largest value or the average.
    var fixedTop: Double? = nil

    var body: some View {
        GeometryReader { g in
            let top = fixedTop ?? max(values.max() ?? 0, avg ?? 0)
            ZStack(alignment: .bottom) {
                HStack(alignment: .bottom, spacing: spacing) {
                    ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                        RoundedRectangle(cornerRadius: radius)
                            .fill(color(i, v))
                            .frame(height: top > 0 && v > 0 ? max(2, g.size.height * CGFloat(min(1, v / top))) : 1)
                            .frame(maxWidth: .infinity)
                    }
                }
                if showAverage, let a = avg, top > 0, a <= top {
                    DashedRule().stroke(Color.white.opacity(0.28), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .frame(height: 1)
                        .offset(y: -g.size.height * CGFloat(a / top))
                }
            }
            .frame(width: g.size.width, height: g.size.height, alignment: .bottom)
        }
        .accessibilityHidden(true)
    }

    private func color(_ i: Int, _ v: Double) -> Color {
        if v <= 0 { return ChartPalette.empty }
        if i == values.count - 1 { return highlight }
        if let a = avg, v > a { return ChartPalette.over }
        return ChartPalette.bar
    }
}
