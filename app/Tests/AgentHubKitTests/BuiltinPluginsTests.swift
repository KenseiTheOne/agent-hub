import Foundation
import Testing
@testable import AgentHubKit

// Built-ins with a switch and plugins held back by a missing requirement (/state.builtinPlugins, /state.heldPlugins, events
// plugins.held and settings.changed): parsing, applying events, and the Plugins page texts built from what the plugin declared.

private let builtinStateJSON = #"""
{"seq":3,"plugins":[{"id":"alpha","title":"Alpha","status":"ok","header":[],"body":[]}],
 "builtinPlugins":[
   {"id":"alpha","title":"Alpha","desc":"first","version":"1.0.0","enabled":true,"running":true,"held":null,
    "requires":[{"name":"Tool A","url":"https://example.com/a","note":"the program it reads","check":"~/.a","present":true}]},
   {"id":"beta","title":"Beta","enabled":false,"running":false,"held":"off","requires":[]},
   {"id":"gamma","title":"Gamma","enabled":true,"running":false,"held":"requires",
    "requires":[{"name":"Tool G","url":"https://example.com/g","note":"программа, которую читает плагин","check":"~/.g","present":false}]},
   {"title":"no id — skipped"}],
 "heldPlugins":[
   {"id":"beta","source":"builtin","reason":"off","requires":[]},
   {"id":"gamma","source":"builtin","reason":"requires","requires":[{"name":"Tool G","url":"https://example.com/g","check":"~/.g","present":false}]},
   {"id":"loc","source":"local","reason":"requires","requires":[{"name":"Tool L","url":"https://example.com/l","check":"/opt/l","present":false}]}]}
"""#

@Suite(.hubLang(.ru)) struct BuiltinPluginsTests {
    @Test func decodesStateLists() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(builtinStateJSON.utf8))
        let b = try #require(st.builtinPlugins)
        #expect(b.map(\.id) == ["alpha", "beta", "gamma"])
        #expect(b[0].enabled && b[0].running && b[0].held == nil && b[0].missingRequirements.isEmpty)
        #expect(!b[1].enabled && b[1].held == "off")
        #expect(b[2].held == "requires" && b[2].missingRequirements.map(\.name) == ["Tool G"])
        #expect(st.heldPlugins.map(\.id) == ["beta", "gamma", "loc"] && st.heldPlugins[2].source == "local")
        // the plugin has no section: it is not in plugins
        #expect(st.plugins.map(\.id) == ["alpha"])
    }

    @Test func olderDaemonHasNoSwitches() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"plugins":[]}"#.utf8))
        #expect(st.builtinPlugins == nil && st.heldPlugins.isEmpty)
    }

    @Test func appliesEvents() throws {
        var st = try JSONDecoder().decode(HubState.self, from: Data(builtinStateJSON.utf8))
        // settings.changed after a switch: only builtinPlugins
        let changed = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"settings.changed","builtinPlugins":[{"id":"beta","title":"Beta","enabled":true,"running":true}]}"#.utf8))
        let c1 = st.applyHeld(changed)
        #expect(c1)
        #expect(st.builtinPlugins?.map(\.id) == ["beta"] && st.builtinPlugins?[0].enabled == true)
        #expect(st.heldPlugins.count == 3)
        // plugins.held after a scan: both lists
        let held = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"plugins.held","builtinPlugins":[],"heldPlugins":[]}"#.utf8))
        let c2 = st.applyHeld(held)
        #expect(c2)
        #expect(st.builtinPlugins == [] && st.heldPlugins.isEmpty)
        // another settings.changed (the language) leaves them alone
        let lang = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"type":"settings.changed","lang":{"setting":"en","effective":"en"}}"#.utf8))
        let c3 = st.applyHeld(lang)
        #expect(!c3)
    }

    @Test func textsUseTheDeclaredNameAndNote() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(builtinStateJSON.utf8))
        let b = try #require(st.builtinPlugins)
        #expect(HeldText.builtinStatus(b[0]) == nil)
        #expect(HeldText.builtinStatus(b[1]) == "Выключен: не запускается и не показывается")
        #expect(HeldText.builtinStatus(b[2]) == "Нужен Tool G — не найден: программа, которую читает плагин. Появится сам, когда программа найдётся.")
        #expect(HeldText.requirementLine(st.heldPlugins[2].missingRequirements) == "Нужен Tool L — не найден")
        #expect(HeldText.requirementLine([]) == nil)
    }

    @Test(.hubLang(.en)) func englishTexts() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(builtinStateJSON.utf8))
        let b = try #require(st.builtinPlugins)
        #expect(HeldText.builtinStatus(b[1]) == "Off: not run and not shown")
        #expect(HeldText.requirementLine(st.heldPlugins[2].missingRequirements) == "Requires Tool L — not found")
    }
}
