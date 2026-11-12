import Foundation
import Testing
@testable import AgentHubKit

// Plugin page charts (hub 0.1.3, optional within contract 3): chart=bars, chart=share, bar=, spark=.
@Suite struct PluginChartsTests {
    private func items(_ json: String) throws -> [Item] {
        try JSONDecoder().decode([Item].self, from: Data(json.utf8))
    }

    @Test func numberAndLabelLists() {
        #expect(Item.splitNumbers("503,332,16.77, 94 ") == [503, 332, 16.77, 94])
        #expect(Item.splitNumbers("1,,x,-4,inf") == [1, 0, 0, 0, 0], "broken, empty, negative and infinite entries keep their place as 0")
        #expect(Item.splitNumbers("") == [] && Item.splitNumbers(nil) == [] && Item.splitNumbers("  ") == [])
        #expect(Item.splitLabels("29,30,31") == ["29", "30", "31"])
        #expect(Item.splitLabels("Wed, Nov 11¦Thu, Nov 12") == ["Wed, Nov 11", "Thu, Nov 12"], "¦ wins over commas")
        #expect(Item.splitLabels("$3,0 тыс.¦$698") == ["$3,0 тыс.", "$698"])
        #expect(Item.splitTips(#"Nov 10\n$698¦¦Nov 11\nTotal 1.75B\nAPI price $101"#) == ["Nov 10\n$698", "", "Nov 11\nTotal 1.75B\nAPI price $101"])
    }

    @Test func plainBarsFromTheDaemonJSON() throws {
        // as the daemon sends it: a quoted value with "\\n" arrives as the two characters backslash and n
        let list = try items(#"""
        [{"title":"By day","level":0,"params":{"chart":"bars","values":"503,332,0,845,101","labels":"29,30,31,1,2",
          "valueLabels":"$503¦$332¦¦$845¦$101","avg":"342","avgLabel":"avg $342","highlight":"last","unit":"$","height":"120",
          "tips":"Thu Oct 29\\n$503¦Fri Oct 30\\n$332¦¦¦Mon Nov 2, by 16:00\\n$101"}}]
        """#)
        let c = try #require(PluginBarChart(list[0]))
        #expect(c.bars.map(\.total) == [503, 332, 0, 845, 101])
        #expect(c.bars.map(\.label) == ["29", "30", "31", "1", "2"])
        #expect(c.bars.map(\.valueLabel) == ["$503", "$332", nil, "$845", "$101"])
        #expect(c.bars.map(\.tip) == ["Thu Oct 29\n$503", "Fri Oct 30\n$332", nil, nil, "Mon Nov 2, by 16:00\n$101"])
        #expect(c.bars.map(\.highlighted) == [false, false, false, false, true])
        #expect(c.bars.map(\.aboveAverage) == [true, false, false, true, false])
        #expect(c.avg == 342 && c.avgLabel == "avg $342" && c.unit == "$" && c.height == 120 && c.tint && !c.isStacked)
        #expect(c.scaleMax == 845)
        #expect(ItemTree.build(list)[0].chart == .bars)
    }

    @Test func barsOptions() {
        let base = ["chart": "bars", "values": "1,2,3"]
        #expect(PluginBarChart(Item(title: "x", params: base.merging(["highlight": "1"]) { $1 }))?.bars.map(\.highlighted) == [false, true, false])
        #expect(PluginBarChart(Item(title: "x", params: base.merging(["highlight": "9"]) { $1 }))?.bars.contains(where: \.highlighted) == false)
        #expect(PluginBarChart(Item(title: "x", params: base.merging(["tint": "none"]) { $1 }))?.tint == false)
        #expect(PluginBarChart(Item(title: "x", params: base.merging(["height": "9000"]) { $1 }))?.height == 400)
        #expect(PluginBarChart(Item(title: "x", params: base))?.height == PluginBarChart.defaultHeight)
        // the average above every bar sets the scale
        #expect(PluginBarChart(Item(title: "x", params: base.merging(["avg": "10"]) { $1 }))?.scaleMax == 10)
        #expect(PluginBarChart(Item(title: "x", params: ["chart": "bars"])) == nil, "no values — nothing to draw")
        #expect(PluginBarChart(Item(title: "x", params: ["chart": "pie", "values": "1"])) == nil)
        #expect(Item(title: "x", params: ["chart": "pie"]).chartKind == nil)
        #expect(ItemTree.build([Item(title: "x", params: ["chart": "bars"])])[0].chart == nil, "an empty chart is a plain line")
    }

    @Test func stackedSeries() throws {
        let it = Item(title: "Tokens by day", params: [
            "chart": "bars", "stack": "Cache read,Cache write,Output", "series": "990,797,23;29.7,19.7,1.2;7.1,3.1",
            "colors": "#64D2FF,#BF5AF2,#FF9F0A", "legend": "true", "labels": "29,30,31",
        ])
        let c = try #require(PluginBarChart(it))
        #expect(c.isStacked && c.legend)
        #expect(c.series == ["Cache read", "Cache write", "Output"])
        #expect(c.colors == ["#64D2FF", "#BF5AF2", "#FF9F0A"])
        #expect(c.bars.count == 3)
        #expect(c.bars[0].layers == [990, 29.7, 7.1])
        #expect(c.bars[2].layers == [23, 1.2, 0], "a short series is padded with zeros")
        #expect(abs(c.bars[0].total - 1026.8) < 1e-9)
        // stack= without series= falls back to values=
        let plain = try #require(PluginBarChart(Item(title: "x", params: ["chart": "bars", "stack": "a,b", "values": "4,5"])))
        #expect(!plain.isStacked && plain.bars.map(\.total) == [4, 5])
    }

    @Test func layerHeightsKeepProportionsWithATwoPointMinimum() {
        let h = PluginBarChart.layerHeights([990, 29.7, 7.1], height: 140)
        #expect(abs(h.reduce(0, +) - 140) < 1e-9, "the layers fill the bar")
        #expect(h[1] >= 2 && h[2] >= 2, "thin visible layers stay visible")
        #expect(abs(h[1] - 140 * 29.7 / 1026.8) < 0.1, "a layer above the minimum keeps (almost) its true size")
        #expect(h[2] == 2, "raised to the minimum: \(h[2])")
        // a zero layer stays zero; nothing to draw — all zeros
        let z = PluginBarChart.layerHeights([10, 0, 0.001], height: 50)
        #expect(z[1] == 0 && z[2] == 2 && abs(z[0] - 48) < 1e-9)
        #expect(PluginBarChart.layerHeights([0, 0], height: 50) == [0, 0])
        // the minimums do not fit — plain proportions
        let tight = PluginBarChart.layerHeights([1, 1, 1], height: 4)
        #expect(tight.allSatisfy { abs($0 - 4.0 / 3) < 1e-9 })
        // proportional when every layer is above the minimum
        #expect(PluginBarChart.layerHeights([1, 3], height: 100) == [25, 75])
    }

    @Test func shareChartFromChildren() throws {
        let list = try items(#"""
        [{"title":"Where it goes · 7 days","level":0,"params":{"chart":"share"}},
         {"title":"Background Workflow","level":1,"params":{"value":"2050","note":"$2,050","color":"#BF5AF2"}},
         {"title":"The sessions themselves","level":1,"params":{"value":"665","note":"$665"}},
         {"title":"Subagents","level":1,"params":{"value":"316.4","note":"$316"}},
         {"title":"Rounding","level":1,"params":{"value":"0.5"}},
         {"title":"No value","level":1,"params":{}}]
        """#)
        let node = ItemTree.build(list)[0]
        #expect(node.chart == .share)
        let c = try #require(PluginShareChart(node))
        #expect(c.parts.map(\.title) == ["Background Workflow", "The sessions themselves", "Subagents", "Rounding"], "a child without value= is not a part")
        #expect(abs(c.total - 3031.9) < 1e-9)
        #expect(c.parts.map(\.percentText) == ["68%", "22%", "10%", "<1%"])
        #expect(c.parts[0].note == "$2,050" && c.parts[0].color == "#BF5AF2" && c.parts[1].color == nil)
        // all zero or no children — not a chart, a plain line
        let zero = ItemTree.build([Item(title: "S", params: ["chart": "share"]), Item(title: "a", level: 1, params: ["value": "0"])])[0]
        #expect(zero.chart == nil && PluginShareChart(zero) == nil)
        #expect(ItemTree.build([Item(title: "S", params: ["chart": "share"])])[0].chart == nil)
    }

    @Test func chartsAreSegmentsAndChildRuns() {
        let body = [
            Item(title: "1", params: ["stat": "Yesterday"]),
            Item(title: "By day", params: ["chart": "bars", "values": "1,2"]),
            Item(title: "Range", level: 1, params: ["segment": "true"]), Item(title: "14 days", level: 2, params: ["selected": "true"]),
            Item(title: "Where", params: ["chart": "share"]), Item(title: "a", level: 1, params: ["value": "1"]),
            Item(title: "Plain"),
        ]
        let segs = ItemTree.segments(ItemTree.build(body))
        #expect(segs.count == 4)
        if case .chart(let n) = segs[1] { #expect(n.item.title == "By day" && n.children.count == 1) } else { Issue.record("bars") }
        if case .chart(let n) = segs[2] { #expect(n.item.title == "Where") } else { Issue.record("share") }
        let root = ItemTree.build([Item(title: "Heading"), Item(title: "c", level: 1, params: ["chart": "bars", "values": "3"]), Item(title: "x", level: 1)])[0]
        let runs = ItemTree.runs(root.children)
        if case .chart(let n) = runs[0] { #expect(n.item.title == "c") } else { Issue.record("chart run") }
    }

    @Test func barOnLinesAndTableRows() throws {
        #expect(Item(title: "Opus", params: ["bar": "98.5"]).bar == 98.5)
        #expect(Item(title: "x", params: ["bar": "140"]).bar == 100)
        #expect(Item(title: "x", params: ["bar": "-3"]).bar == 0)
        #expect(Item(title: "x", params: ["bar": "lots"]).bar == nil && Item(title: "x").bar == nil)
        #expect(Item(title: "x", params: ["barColumn": "3"]).barColumn == 3)
        #expect(Item(title: "x", params: ["barColumn": "0"]).barColumn == nil)
        let list = try items(#"""
        [{"title":"By token type","level":0,"params":{"table":"true","columns":"Type¦Today¦7 days¦Share of cost","barColumn":"4"}},
         {"title":"Cache read","level":1,"params":{"cells":"230M¦7.23B¦18%","bar":"18"}},
         {"title":"Output","level":1,"params":{"cells":"828K¦34.1M¦61%","bar":"61","barColumn":"2"}},
         {"title":"No bar","level":1,"params":{"cells":"1¦2¦3"}},
         {"title":"Out of range","level":1,"params":{"cells":"1¦2¦3","bar":"5","barColumn":"9"}}]
        """#)
        let t = PluginTable(ItemTree.build(list)[0])
        let rows = t.entries.compactMap { if case .row(let r) = $0 { return r } else { return nil } }
        #expect(rows.map(\.barCell) == [2, 0, nil, nil], "the table's barColumn, a row's own, no bar, a column that does not exist")
    }

    @Test func sparkOnTheHeader() {
        let head = Item(title: "Today $101", params: ["tile": "$101", "spark": "503,332,17,101", "sparkAvg": "342", "sparkLabel": "14 days", "sparkNote": "avg $342 a day"])
        #expect(head.spark == [503, 332, 17, 101])
        #expect(head.sparkAvg == 342 && head.sparkLabel == "14 days" && head.sparkNote == "avg $342 a day")
        #expect(Item(title: "x").spark.isEmpty && Item(title: "x", params: ["sparkAvg": "0"]).sparkAvg == nil)
    }
}
