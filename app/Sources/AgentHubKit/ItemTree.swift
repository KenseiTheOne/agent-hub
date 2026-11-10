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
            if let c = node.control {
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
}

public enum ChildRun: Sendable, Hashable {
    case controls([ItemNode])
    case table(ItemNode)
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
            return Row(node: r,
                       cells: (0..<n).map { $0 < cells.count ? cells[$0] : "" },
                       colors: (0..<n).map { $0 < colors.count ? colors[$0] : nil },
                       slot: kids.filter { !$0.item.isIconOnly },
                       icons: kids.filter { $0.item.isIconOnly })
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
