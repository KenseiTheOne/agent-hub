import Foundation

/// Tree of plugin output lines: a flat list with `level` (the `--` prefix in SwiftBar) → nested nodes.
/// A node with children is a submenu in the menu and a block in the panel.
public struct ItemNode: Sendable, Hashable, Identifiable {
    public var id: Int
    public var item: Item
    public var children: [ItemNode]

    public var hasChildren: Bool { !children.isEmpty }

    /// Which control this line is drawn as (`table=true`, `segment=true`, `select=true` need children;
    /// `toggle=on|off` does not); nil — a plain line.
    public var control: PluginControl? {
        if item.isTable, hasChildren { return .table }
        if item.isSegment, hasChildren { return .segment }
        if item.isSelect, hasChildren { return .select }
        if item.toggleState != nil { return .toggle }
        return nil
    }

    /// Which chart this line is drawn as: `chart=bars` with at least one value, `chart=share` with children; nil — none.
    public var chart: PluginChartKind? {
        switch item.chartKind {
        case .bars?: return PluginBarChart(item) != nil ? .bars : nil
        case .share?: return PluginShareChart(self) != nil ? .share : nil
        case nil: return nil
        }
    }

    public init(id: Int, item: Item, children: [ItemNode] = []) {
        self.id = id; self.item = item; self.children = children
    }
}

public enum ItemTree {
    /// Builds the tree; "holes" in levels (a `----` right after a level-0 line) attach to the nearest parent.
    public static func build(_ items: [Item]) -> [ItemNode] {
        var index = 0
        func level(_ i: Int) -> Int { max(0, items[i].level) }
        // children — consecutive lines with a level deeper than the parent
        func parse(parentLevel: Int) -> [ItemNode] {
            var out: [ItemNode] = []
            while index < items.count, level(index) > parentLevel {
                let myIndex = index
                index += 1
                let children = parse(parentLevel: level(myIndex))
                out.append(ItemNode(id: myIndex, item: items[myIndex], children: children))
            }
            return out
        }
        // top level: everything that did not become someone's child
        var roots: [ItemNode] = []
        while index < items.count {
            let myIndex = index
            index += 1
            let children = parse(parentLevel: level(myIndex))
            roots.append(ItemNode(id: myIndex, item: items[myIndex], children: children))
        }
        return roots
    }

    /// Panel blocks: the body is split by top-level separators (`---`).
    public static func blocks(_ items: [Item]) -> [[ItemNode]] {
        var groups: [[ItemNode]] = [[]]
        for node in build(items) {
            if node.item.separator && node.item.level == 0 {
                if !(groups.last?.isEmpty ?? true) { groups.append([]) }
            } else {
                groups[groups.count - 1].append(node)
            }
        }
        return groups.filter { !$0.isEmpty }
    }

    /// Block layout on the plugin page: consecutive `stat=` — a row of number cards, `gauge=` — cards with a
    /// bar, `strip=true` — a strip, everything else — a list.
    public static func segments(_ block: [ItemNode]) -> [BlockSegment] {
        var out: [BlockSegment] = []
        for node in block {
            let it = node.item
            if node.chart != nil {
                out.append(.chart(node))
            } else if let c = node.control {
                // a toggle line carries its own offer: checked before the offer-less kinds below
                if c == .table {
                    out.append(.table(node))
                } else if case .controls(let prev) = out.last {
                    out[out.count - 1] = .controls(prev + [node])
                } else {
                    out.append(.controls([node]))
                }
            } else if it.offer == nil, it.stat != nil {
                if case .stats(let prev) = out.last { out[out.count - 1] = .stats(prev + [node]) } else { out.append(.stats([node])) }
            } else if it.offer == nil, it.gauge != nil {
                if case .gauges(let prev) = out.last { out[out.count - 1] = .gauges(prev + [node]) } else { out.append(.gauges([node])) }
            } else if it.isStrip, node.hasChildren {
                out.append(.strip(node))
            } else if case .list(let prev) = out.last {
                out[out.count - 1] = .list(prev + [node])
            } else {
                out.append(.list([node]))
            }
        }
        return out
    }

    /// Children of a list line: consecutive segment/select/toggle lines gather into one block of controls (a label
    /// column and a control column), a table stays on its own, everything else is drawn line by line.
    public static func runs(_ nodes: [ItemNode]) -> [ChildRun] {
        var out: [ChildRun] = []
        for node in nodes {
            if node.chart != nil { out.append(.chart(node)); continue }
            switch node.control {
            case .table?:
                out.append(.table(node))
            case .some:
                if case .controls(let prev) = out.last { out[out.count - 1] = .controls(prev + [node]) } else { out.append(.controls([node])) }
            case nil:
                out.append(.node(node))
            }
        }
        return out
    }
}

/// The kinds of controls a body line can be drawn as (see `ItemNode.control`).
public enum PluginControl: Sendable, Hashable {
    case segment, select, toggle, table
}

public enum BlockSegment: Sendable, Hashable {
    case stats([ItemNode])
    case gauges([ItemNode])
    case strip(ItemNode)
    case list([ItemNode])
    /// Consecutive segment/select/toggle lines: one card with a label column and a control column.
    case controls([ItemNode])
    case table(ItemNode)
    /// A `chart=bars` or `chart=share` line: a card of its own.
    case chart(ItemNode)
}

public enum ChildRun: Sendable, Hashable {
    case controls([ItemNode])
    case table(ItemNode)
    case chart(ItemNode)
    case node(ItemNode)
}

/// A `table=true` line prepared for drawing: column titles, header buttons, rows and groups of rows.
public struct PluginTable: Sendable, Hashable {
    public struct Row: Sendable, Hashable, Identifiable {
        public var node: ItemNode
        /// `cells=` padded (or cut) to `columnCount - 1`.
        public var cells: [String]
        /// `cellColors=` padded (or cut) the same way; nil — the default color.
        public var colors: [String?]
        /// Row children that are not icon-only: buttons (with an offer) and gray notes (without), in output order.
        public var slot: [ItemNode]
        /// Row children with `icon=true`: icon-only buttons at the right edge.
        public var icons: [ItemNode]
        /// The index in `cells` that draws the row's `bar=` instead of plain text (`barColumn=` on the row or the
        /// table, 1-based with the title column as 1); nil — the bar, if any, goes under the title.
        public var barCell: Int?
        public var id: Int { node.id }
        public var item: Item { node.item }
    }

    public enum Entry: Sendable, Hashable, Identifiable {
        case row(Row)
        case group(ItemNode, [Row])
        public var id: Int {
            switch self {
            case .row(let r): return r.node.id
            case .group(let n, _): return n.id
            }
        }
    }

    public var node: ItemNode
    public var columns: [String]
    public var columnCount: Int
    /// Direct children with an offer and `header=true`: buttons right of the table title.
    public var headerOffers: [ItemNode]
    public var entries: [Entry]

    public init(_ node: ItemNode) {
        self.node = node
        let direct = node.children.filter { !$0.item.separator }
        headerOffers = direct.filter { $0.item.isHeader && $0.item.offer != nil }
        let rowNodes = direct.filter { !($0.item.isHeader && $0.item.offer != nil) }
        // all rows, including those in groups: the widest `cells=` sets the column count when `columns=` is shorter
        let flat = rowNodes.flatMap { $0.item.isGroup ? $0.children.filter { !$0.item.separator } : [$0] }
        columns = node.item.columns
        columnCount = max(1, columns.count, 1 + (flat.map { $0.item.cells.count }.max() ?? 0))
        let n = columnCount - 1
        func row(_ r: ItemNode) -> Row {
            let cells = r.item.cells, colors = r.item.cellColors
            let kids = r.children.filter { !$0.item.separator }
            let bc = (r.item.barColumn ?? node.item.barColumn).map { $0 - 2 }
            return Row(node: r,
                       cells: (0..<n).map { $0 < cells.count ? cells[$0] : "" },
                       colors: (0..<n).map { $0 < colors.count ? colors[$0] : nil },
                       slot: kids.filter { !$0.item.isIconOnly },
                       icons: kids.filter { $0.item.isIconOnly },
                       barCell: r.item.bar != nil ? bc.flatMap { $0 >= 0 && $0 < n ? $0 : nil } : nil)
        }
        entries = rowNodes.map { r in
            r.item.isGroup ? .group(r, r.children.filter { !$0.item.separator }.map(row)) : .row(row(r))
        }
    }

    /// Whether any row has a state dot or icon (`sfimage=` or `status=`): the title column reserves its place.
    public var hasMarks: Bool {
        entries.contains { e in
            switch e {
            case .row(let r): return r.item.sfImage != nil || r.item.status != nil
            case .group(_, let rows): return rows.contains { $0.item.sfImage != nil || $0.item.status != nil }
            }
        }
    }

    /// The memory key of a group: its title without a trailing count (`As base · 9` → `As base`), so a group stays
    /// collapsed or expanded when the number of its rows changes.
    public static func groupKey(_ title: String) -> String {
        let t = title.replacingOccurrences(of: #"\s*(?:[·•:\-–—]\s*\d+|\(\d+\))\s*$"#, with: "", options: .regularExpression)
        return t.isEmpty ? title : t
    }
}

// MARK: - charts

/// Chart kinds of a body line (`chart=`).
public enum PluginChartKind: String, Sendable, Hashable {
    case bars, share
}

/// A `chart=bars` line prepared for drawing: one bar per value (or per index of the stacked series), captions, the
/// average line and per-bar tooltips. All lists are optional and may be shorter than the bars.
public struct PluginBarChart: Sendable, Hashable {
    public struct Bar: Sendable, Hashable, Identifiable {
        public var id: Int
        /// The bar's value: the plain value, or the sum of its stacked layers.
        public var total: Double
        /// Stacked layers bottom to top (one per `stack=` series); a plain bar has one layer.
        public var layers: [Double]
        public var label: String?
        public var valueLabel: String?
        public var tip: String?
        public var highlighted: Bool
        /// Above `avg=` (tinted unless `tint=none`).
        public var aboveAverage: Bool
    }

    public var bars: [Bar]
    /// `stack="a,b,c"`: series names, bottom layer first; empty — plain bars.
    public var series: [String]
    /// `colors="#hex,#hex"`: a color per series (nil — the default palette).
    public var colors: [String?]
    public var avg: Double?
    public var avgLabel: String?
    public var unit: String?
    /// `height=<pt>`: the plot height, 60…400 (default 160).
    public var height: Double
    /// `tint=none` turns off the orange tint of bars above the average.
    public var tint: Bool
    /// `legend=true`: a legend of the stacked series under the chart.
    public var legend: Bool
    /// The scale top: `max=` when given (bars above it are clipped at the top, an average above it is not drawn),
    /// otherwise the largest bar or the average, whichever is higher.
    public var scaleMax: Double
    /// `max=<number>` was given: a fixed scale top.
    public var fixedMax: Bool

    public var isStacked: Bool { !series.isEmpty }

    public static let defaultHeight = 160.0

    /// nil — not `chart=bars` or nothing to draw.
    public init?(_ item: Item) {
        guard item.chartKind == .bars else { return nil }
        let p = item.params
        let names = Item.splitLabels(p["stack"]).filter { !$0.isEmpty }
        var layers: [[Double]] = []
        if !names.isEmpty, let raw = p["series"], !raw.isEmpty {
            let rows = raw.split(separator: ";", omittingEmptySubsequences: false).map { Item.splitNumbers(String($0)) }
            let n = rows.map(\.count).max() ?? 0
            layers = (0..<n).map { i in (0..<names.count).map { s in s < rows.count && i < rows[s].count ? rows[s][i] : 0 } }
            series = names
        } else {
            layers = Item.splitNumbers(p["values"]).map { [$0] }
            series = []
        }
        guard !layers.isEmpty else { return nil }
        let labels = Item.splitLabels(p["labels"])
        let valueLabels = Item.splitLabels(p["valueLabels"])
        let tips = Item.splitTips(p["tips"])
        let avg = p["avg"].flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        var hi: Int?
        switch p["highlight"]?.trimmingCharacters(in: .whitespaces) {
        case "last"?: hi = layers.count - 1
        case let s?: hi = Int(s).flatMap { $0 >= 0 && $0 < layers.count ? $0 : nil }
        case nil: hi = nil
        }
        tint = p["tint"] != "none"
        func at(_ list: [String], _ i: Int) -> String? { i < list.count && !list[i].isEmpty ? list[i] : nil }
        bars = layers.enumerated().map { i, l in
            let total = l.reduce(0, +)
            return Bar(id: i, total: total, layers: l, label: at(labels, i), valueLabel: at(valueLabels, i), tip: at(tips, i),
                       highlighted: i == hi, aboveAverage: avg.map { total > $0 } ?? false)
        }
        colors = Item.splitLabels(p["colors"]).map { $0.isEmpty ? nil : $0 }
        self.avg = avg
        avgLabel = p["avgLabel"].flatMap { $0.isEmpty ? nil : $0 }
        unit = p["unit"].flatMap { $0.isEmpty ? nil : $0 }
        height = p["height"].flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }.map { min(400, max(60, $0)) } ?? Self.defaultHeight
        legend = p["legend"] == "true"
        if let top = Item.positive(p["max"]) {
            scaleMax = top
            fixedMax = true
        } else {
            scaleMax = max(bars.map(\.total).max() ?? 0, avg ?? 0)
            fixedMax = false
        }
    }

    /// A bar's share of the plot height, 0…1: values above a fixed `max=` are clipped at the top.
    public func fraction(_ value: Double) -> Double {
        guard scaleMax > 0, value > 0 else { return 0 }
        return min(1, value / scaleMax)
    }

    /// Whether the average line falls inside the scale (a fixed `max=` below the average hides it).
    public var averageVisible: Bool { avg.map { scaleMax > 0 && $0 <= scaleMax } ?? false }

    /// The heights of stacked layers in a bar of `height` points: in true proportion, but a visible (non-zero) layer
    /// gets at least `minLayer` points, taken from the layers above that minimum in proportion to their excess. The sum is
    /// `height`. When the minimums alone do not fit, plain proportions.
    public static func layerHeights(_ values: [Double], height: Double, minLayer: Double = 2) -> [Double] {
        let v = values.map { $0.isFinite && $0 > 0 ? $0 : 0 }
        let total = v.reduce(0, +)
        guard total > 0, height > 0 else { return v.map { _ in 0 } }
        var h = v.map { $0 / total * height }
        let visible = v.indices.filter { v[$0] > 0 }
        guard Double(visible.count) * minLayer <= height else { return h }
        var deficit = 0.0
        var raised = Set<Int>()
        for i in visible where h[i] < minLayer {
            deficit += minLayer - h[i]
            h[i] = minLayer
            raised.insert(i)
        }
        guard deficit > 0 else { return h }
        let donors = visible.filter { !raised.contains($0) }
        let pool = donors.reduce(0) { $0 + (h[$1] - minLayer) }
        guard pool > 0 else { return h }
        for d in donors { h[d] -= deficit * (h[d] - minLayer) / pool }
        return h
    }
}

/// A `chart=share` line prepared for drawing: the parts (children with `value=`), their shares and legend texts.
public struct PluginShareChart: Sendable, Hashable {
    public struct Part: Sendable, Hashable, Identifiable {
        public var id: Int
        public var item: Item
        public var value: Double
        /// value / total, 0…1.
        public var fraction: Double
        public var title: String { item.title }
        public var note: String? { item.note }
        public var color: String? { item.color }
        /// "68%"; "<1%" for a visible part that rounds to zero.
        public var percentText: String {
            let p = fraction * 100
            if p > 0 && p < 0.5 { return "<1%" }
            return "\(Int(p.rounded()))%"
        }
    }

    public var parts: [Part]
    public var total: Double

    /// nil — not `chart=share`, no children with a value, or all values zero.
    public init?(_ node: ItemNode) {
        guard node.item.chartKind == .share else { return nil }
        let kids = node.children.filter { !$0.item.separator && $0.item.params["value"] != nil }
        let values = kids.map { n -> Double in
            let v = Double(n.item.params["value"]!.trimmingCharacters(in: .whitespaces)) ?? 0
            return v.isFinite && v > 0 ? v : 0
        }
        let total = values.reduce(0, +)
        guard total > 0 else { return nil }
        self.total = total
        parts = kids.enumerated().map { i, n in Part(id: n.id, item: n.item, value: values[i], fraction: values[i] / total) }
    }
}
