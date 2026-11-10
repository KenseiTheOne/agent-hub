import Foundation

/// Tree of plugin output lines: a flat list with `level` (the `--` prefix in SwiftBar) → nested nodes.
/// A node with children is a submenu in the menu and a block in the panel.
public struct ItemNode: Sendable, Hashable, Identifiable {
    public var id: Int
    public var item: Item
    public var children: [ItemNode]

    public var hasChildren: Bool { !children.isEmpty }

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
            if it.offer == nil, it.stat != nil {
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
}

public enum BlockSegment: Sendable, Hashable {
    case stats([ItemNode])
    case gauges([ItemNode])
    case strip(ItemNode)
    case list([ItemNode])
}
