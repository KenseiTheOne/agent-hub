import Foundation
import Testing
@testable import AgentHubKit

// Plugin contract 2 (2026-11-09): the shell builds the UI from what the plugin declared — icon, "hub too old",
// connections, own notification switches, action refusal text. It contains no names of specific plugins.
@Suite(.serialized) struct ContractV2Tests {
    @Test func pluginIconDecodesOnlyValidDeclarations() throws {
        let ok = try JSONDecoder().decode(PluginIcon.self, from: Data(##"{"symbol":"gauge.with.dots.needle.50percent","color":"#0a84ff"}"##.utf8))
        #expect(ok.symbol == "gauge.with.dots.needle.50percent" && ok.color == "#0A84FF" && ok.rgb == 0x0A84FF)
        // invalid color — no color (the icon is intact); invalid symbol — no icon
        let noColor = try JSONDecoder().decode(PluginIcon.self, from: Data(##"{"symbol":"moon","color":"red"}"##.utf8))
        #expect(noColor.color == nil && noColor.rgb == nil)
        #expect((try? JSONDecoder().decode(PluginIcon.self, from: Data(##"{"symbol":"../Moon Fill"}"##.utf8))) == nil)
        #expect(PluginIcon(symbol: "moon", color: "#5E5CE6") != nil)
        #expect(PluginIcon(symbol: "Moon") == nil)
        // in the plugin state: a broken icon does not break the plugin
        let st = try JSONDecoder().decode(HubState.self, from: Data(##"{"seq":1,"contract":2,"plugins":[{"id":"a","title":"A","icon":{"symbol":"checklist","color":"#FF375F"},"contract":2},{"id":"b","title":"B","icon":{"symbol":"!"}}]}"##.utf8))
        #expect(st.contract == 2)
        #expect(st.plugins.map(\.id) == ["a", "b"])
        #expect(st.plugins[0].icon?.symbol == "checklist" && st.plugins[0].contract == 2)
        #expect(st.plugins[1].icon == nil)
        #expect(try JSONDecoder().decode(HubState.self, from: Data(##"{"seq":1}"##.utf8)).contract == nil, "older daemon — nil")
    }

    @MainActor @Test func iconBookPrefersInstalledDeclaration() throws {
        let book = PluginIconBook()
        let cat = try JSONDecoder().decode(RegistryCatalog.self, from: Data(##"{"configured":true,"plugins":[{"id":"a","version":"1","icon":{"symbol":"star","color":"#FFD60A"}},{"id":"c","version":"1","icon":{"symbol":"leaf"}}]}"##.utf8))
        book.absorb(catalog: cat)
        #expect(book.icon("a")?.symbol == "star")
        var st = HubState(plugins: [PluginState(id: "a", title: "A", status: .ok, icon: PluginIcon(symbol: "checklist", color: "#FF375F"))])
        book.absorb(state: st)
        #expect(book.icon("a")?.symbol == "checklist", "the installed one takes precedence over the catalog")
        book.absorb(catalog: cat)
        #expect(book.icon("a")?.symbol == "checklist", "the catalog does not override the installed one")
        #expect(book.icon("c")?.symbol == "leaf")
        // the installed one stopped declaring an icon — no icon (neutral), not the catalog one
        st.plugins[0].icon = nil
        book.absorb(state: st)
        #expect(book.icon("a") == nil)
        #expect(PluginIconBook.neutralSymbol == "puzzlepiece.extension")
        let rq = try JSONDecoder().decode(OwnRequest.self, from: Data(##"{"requestId":"r1","id":"mine","icon":{"symbol":"moon","color":"#5E5CE6"}}"##.utf8))
        book.absorb(requests: [rq])
        #expect(book.icon("mine")?.color == "#5E5CE6")
    }

    @Test func catalogNeedsNewerHub() throws {
        let cat = try JSONDecoder().decode(RegistryCatalog.self, from: Data(##"{"configured":true,"plugins":[{"id":"future","version":"1.0.0","contract":3,"needsHub":{"need":3,"have":2}},{"id":"today","version":"1.0.0","contract":2}]}"##.utf8))
        let future = try #require(cat.plugins.first { $0.id == "future" })
        #expect(future.needsHub == CatalogPlugin.NeedsHub(need: 3, have: 2))
        L10n.shared.lang = .ru
        #expect(future.needsHubText?.contains("Нужен хаб новее") == true)
        #expect(future.needsHubText?.contains("контракт плагинов 3") == true)
        #expect(cat.plugins.first { $0.id == "today" }?.needsHubText == nil)
        // an index entry with an unparseable contract (daemon: needsHub.need = null) — also "hub too old", without a number
        let odd = try JSONDecoder().decode(RegistryCatalog.self, from: Data(##"{"configured":true,"plugins":[{"id":"odd","version":"1.0.0","needsHub":{"need":null,"have":2}}]}"##.utf8))
        let o = try #require(odd.plugins.first)
        #expect(o.needsHub == CatalogPlugin.NeedsHub(need: nil, have: 2))
        #expect(o.needsHubText?.contains("более новый контракт плагинов") == true)
        // an install refusal — a clear text, not "permissions did not match"
        #expect(Explain.text(code: "registry:hub-too-old", status: 409, label: "Future").contains("нужен хаб новее"))
        #expect(Explain.text(code: "own:hub-too-old", status: 409, label: "Mine").contains("нужен хаб новее"))
        // an own folder requires a newer contract: the previous copy keeps working, the reason in words
        let own = try JSONDecoder().decode(OwnSourceInfo.self, from: Data(##"{"status":"broken","error":"own:hub-too-old","need":3,"have":2}"##.utf8))
        #expect(own.reason == "нужен хаб новее: плагин в папке требует контракт 3, а хаб понимает 2")
        L10n.shared.lang = .en
        #expect(future.needsHubText?.contains("Needs a newer hub") == true)
        #expect(own.reason?.contains("needs a newer hub") == true)
        L10n.shared.lang = .ru
    }

    @Test func consentCarriesDeclaredIcon() throws {
        let c = try JSONDecoder().decode(ConsentRequest.self, from: Data(##"{"token":"t","id":"x","icon":{"symbol":"moon","color":"#5E5CE6"},"permissions":[{"kind":"connections","what":"https://mcp.example.com/mcp scope=read tools=a","why":"тикеты"}]}"##.utf8))
        #expect(c.icon?.symbol == "moon")
        L10n.shared.lang = .ru
        #expect(c.permissions.first?.kindLabel == "Подключение")
        L10n.shared.lang = .en
        #expect(c.permissions.first?.kindLabel == "Connection")
        L10n.shared.lang = .ru
    }
}

@Suite(.serialized) struct ConnectionPermissionTests {
    @Test func connectionPermissionReadsAsHumanLine() {
        L10n.shared.lang = .ru
        let p = PluginPermission(kind: "connections", what: "tix: https://mcp.example.com/mcp scope=read tools=a,b", why: nil)
        #expect(p.plainText == "mcp.example.com — вход ведёт хаб, плагин токена не видит")
        let q = PluginPermission(kind: "connections", what: "https://mcp.example.com/mcp scope=read tools=a", why: "тикеты")
        #expect(q.plainText == "тикеты — вход ведёт хаб, плагин токена не видит")
        #expect(PluginPermission.counted("connections", 2) == "2 подключения")
        #expect(p.shortKindLabel == "подключение к сервису")
    }
}
