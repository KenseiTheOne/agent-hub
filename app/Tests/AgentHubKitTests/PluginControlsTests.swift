import Foundation
import Testing
@testable import AgentHubKit

// Plugin page controls (hub 0.1.1, optional within contract 3): segment, select, toggle and table lines.
@Suite struct PluginControlsTests {
    private func items(_ json: String) throws -> [Item] {
        try JSONDecoder().decode([Item].self, from: Data(json.utf8))
    }

    @Test func accessorsReadTheParams() {
        #expect(Item(title: "Model", params: ["segment": "true"]).isSegment)
        #expect(!Item(title: "Model", params: ["segment": "yes"]).isSegment)
        #expect(Item(title: "Style", params: ["select": "true"]).isSelect)
        #expect(Item(title: "U", params: ["toggle": "on"]).toggleState == true)
        #expect(Item(title: "U", params: ["toggle": "off"]).toggleState == false)
        #expect(Item(title: "U", params: ["toggle": "maybe"]).toggleState == nil)
        #expect(Item(title: "U").toggleState == nil)
        #expect(Item(title: "T", params: ["table": "true"]).isTable)
        #expect(Item(title: "x", params: ["selected": "true"]).isSelected)
        #expect(Item(title: "x", params: ["icon": "true"]).isIconOnly)
        #expect(Item(title: "x", params: ["group": "true"]).isGroup)
        #expect(Item(title: "x", params: ["header": "true"]).isHeader)
        let plain = Item(title: "x")
        #expect(!plain.isSegment && !plain.isSelect && !plain.isTable && !plain.isSelected && !plain.isIconOnly && !plain.isGroup && !plain.isHeader)
    }

    @Test func cellsSplitOnBrokenBar() {
        #expect(Item.splitCells("Tab¦State¦Model¦Effort") == ["Tab", "State", "Model", "Effort"])
        #expect(Item.splitCells("¦¦#FFB454") == ["", "", "#FFB454"], "empty entries keep their place")
        #expect(Item.splitCells(" idle ¦ Opus 5.5 ") == ["idle", "Opus 5.5"])
        #expect(Item.splitCells("a|b") == ["a|b"], "only U+00A6 separates")
        #expect(Item.splitCells("") == [] && Item.splitCells(nil) == [])
        let row = Item(title: "alpha", params: ["cells": "idle¦Opus 5.5¦xhigh", "cellColors": "¦¦#FFB454", "columns": "A¦B"])
        #expect(row.cells == ["idle", "Opus 5.5", "xhigh"])
        #expect(row.cellColors == [nil, nil, "#FFB454"])
        #expect(row.columns == ["A", "B"])
        #expect(Item(title: "x").cellColors.isEmpty)
    }

    @Test func controlKindsAndBlockSegments() throws {
        // the parsed output of the spec example as the daemon sends it (params as strings, offers on children)
        let list = try items(#"""
        [{"title":"Model","level":0,"params":{"segment":"true"}},
         {"title":"Default","level":1,"params":{"arg":"default"},"offer":{"id":"o1","kind":"action","action":"set-model","level":"immediate"}},
         {"title":"Opus 5.5","level":1,"params":{"selected":"true"}},
         {"title":"Output style","level":0,"params":{"select":"true","note":"next message"}},
         {"title":"Explanatory","level":1,"params":{"selected":"true"}},
         {"title":"Ultracode","level":0,"params":{"toggle":"off","note":"multi-agent"},"offer":{"id":"o2","kind":"action","action":"ultracode-on","level":"immediate"}},
         {"title":"Open sessions · 13","level":0,"params":{"table":"true","columns":"Tab¦State¦Model¦Effort"}},
         {"title":"alpha","level":1,"params":{"cells":"idle¦Opus 5.5¦xhigh"}},
         {"title":"Plain","level":0,"params":{}},
         {"title":"Empty segment","level":0,"params":{"segment":"true"}}]
        """#)
        let nodes = ItemTree.build(list)
        #expect(nodes.map(\.control) == [.segment, .select, .toggle, .table, nil, nil], "segment/select/table need children, toggle does not")
        let segs = ItemTree.segments(nodes)
        #expect(segs.count == 3)
        if case .controls(let c) = segs[0] { #expect(c.map(\.item.title) == ["Model", "Output style", "Ultracode"], "a toggle with an offer is a control, not a list line") } else { Issue.record("controls") }
        if case .table(let t) = segs[1] { #expect(t.children.count == 1) } else { Issue.record("table") }
        if case .list(let l) = segs[2] { #expect(l.map(\.item.title) == ["Plain", "Empty segment"]) } else { Issue.record("list") }
    }

    @Test func childRunsGroupControlsUnderAHeading() {
        let items = [
            Item(title: "For new sessions"),
            Item(title: "Model", level: 1, params: ["segment": "true"]), Item(title: "A", level: 2, params: ["selected": "true"]),
            Item(title: "Ultracode", level: 1, params: ["toggle": "on"]),
            Item(title: "Footnote", level: 1),
            Item(title: "Sessions", level: 1, params: ["table": "true"]), Item(title: "row", level: 2),
        ]
        let root = ItemTree.build(items)[0]
        let runs = ItemTree.runs(root.children)
        #expect(runs.count == 3)
        if case .controls(let c) = runs[0] { #expect(c.map(\.item.title) == ["Model", "Ultracode"]) } else { Issue.record("controls") }
        if case .node(let n) = runs[1] { #expect(n.item.title == "Footnote") } else { Issue.record("node") }
        if case .table(let t) = runs[2] { #expect(t.item.title == "Sessions") } else { Issue.record("table") }
    }

    @Test func tableModelRowsGroupsAndHeaderButtons() throws {
        let list = try items(#"""
        [{"title":"Open sessions · 13","level":0,"params":{"table":"true","columns":"Tab¦State¦Model¦Effort"}},
         {"title":"Apply base · 2","level":1,"params":{"header":"true"},"offer":{"id":"h","kind":"action","action":"apply-all","level":"confirm"}},
         {"title":"alpha","level":1,"params":{"cells":"idle¦Opus 5.5¦high","cellColors":"¦¦#FFB454","sfimage":"circle.fill","iconColor":"#8E8E93"}},
         {"title":"Fix","level":2,"params":{"arg":"a"},"offer":{"id":"f","kind":"action","action":"apply","level":"immediate"}},
         {"title":"Switch","level":2,"params":{"icon":"true","sfimage":"arrow.up.forward.app"},"offer":{"id":"s","kind":"effect","primitive":"session.focus","level":"immediate"}},
         {"title":"beta","level":1,"params":{"cells":"busy"}},
         {"title":"after the turn","level":2,"params":{"color":"#8E8E93"}},
         {"title":"As base · 9","level":1,"params":{"group":"true"}},
         {"title":"gamma","level":2,"params":{"cells":"waiting¦Opus 5.5¦medium¦extra"}},
         {"title":"Switch","level":3,"params":{"icon":"true"},"offer":{"id":"s2","kind":"effect","primitive":"session.focus","level":"immediate"}}]
        """#)
        let node = ItemTree.build(list)[0]
        let t = PluginTable(node)
        #expect(t.columns == ["Tab", "State", "Model", "Effort"])
        #expect(t.columnCount == 5, "the widest cells= (in a group too) adds a column")
        #expect(t.headerOffers.map(\.item.title) == ["Apply base · 2"])
        #expect(t.entries.count == 3)
        guard case .row(let alpha) = t.entries[0], case .row(let beta) = t.entries[1], case .group(let g, let rows) = t.entries[2] else {
            Issue.record("entries"); return
        }
        #expect(alpha.cells == ["idle", "Opus 5.5", "high", ""])
        #expect(alpha.colors == [nil, nil, "#FFB454", nil])
        #expect(alpha.slot.map(\.item.title) == ["Fix"] && alpha.icons.map(\.item.title) == ["Switch"])
        #expect(beta.cells == ["busy", "", "", ""] && beta.slot.map(\.item.title) == ["after the turn"] && beta.icons.isEmpty)
        #expect(g.item.title == "As base · 9")
        #expect(rows.map(\.item.title) == ["gamma"] && rows[0].icons.count == 1)
        #expect(rows[0].cells == ["waiting", "Opus 5.5", "medium", "extra"])
        #expect(t.hasMarks)
    }

    @Test func headerNeedsAnOfferAndGroupKeyDropsTheCount() {
        // header=true without an offer is a plain row; an offer without header=true too
        let items = [
            Item(title: "T", params: ["table": "true"]),
            Item(title: "note", level: 1, params: ["header": "true"]),
            Item(title: "go", level: 1, offer: Offer(id: "x", kind: "effect", primitive: "open.url", level: .immediate)),
        ]
        let t = PluginTable(ItemTree.build(items)[0])
        #expect(t.headerOffers.isEmpty && t.entries.count == 2 && t.columnCount == 1 && !t.hasMarks)
        #expect(PluginTable.groupKey("As base · 9") == "As base")
        #expect(PluginTable.groupKey("Как базовые · 12") == "Как базовые")
        #expect(PluginTable.groupKey("Idle (3)") == "Idle")
        #expect(PluginTable.groupKey("Version 2") == "Version 2", "a number that is part of the title stays")
        #expect(PluginTable.groupKey("· 9") == "· 9")
    }
}
