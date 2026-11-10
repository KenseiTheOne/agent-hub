import Foundation
import Testing
@testable import AgentHubKit

// Plugin contract 3 (2026-11-10) in the shell: a loud consent window line for writes to Claude Code and system
// interception points (`risk` on a permission from the daemon) and tooltips with the full text for every truncated plugin text.
@Suite(.serialized) struct ContractV3Tests {
    @Test func permissionRiskDecodesAndExplains() throws {
        let list = try JSONDecoder().decode([PluginPermission].self, from: Data(##"""
        [{"kind":"fsRead","what":"~/x","why":"r"},
         {"kind":"fsWrite","what":"~/Library/Caches/p","why":"кэш"},
         {"kind":"fsWrite","what":"~/.claude/settings.json","why":"модель по умолчанию","risk":"claude-code","added":true},
         {"kind":"fsWrite","what":"~/.zshrc","why":"x","risk":""}]
        """##.utf8))
        #expect(list.map(\.risk) == [nil, nil, "claude-code", nil], "an empty risk is the same as none")
        L10n.shared.lang = .ru
        let w = try #require(list[2].riskWarning)
        #expect(w.title.hasPrefix("Место перехвата"))
        #expect(w.text.contains("хуки (hooks)") && w.text.contains("apiKeyHelper") && w.text.contains("права (permissions)") && w.text.contains("env"))
        #expect(list[1].riskWarning == nil)
        // every kind of place has its own text in both languages; an unknown one gets a generic text
        for kind in ["claude-code", "autostart", "shell", "bin", "terminals", "ssh", "git", "hub", "future-kind"] {
            let p = PluginPermission(kind: "fsWrite", what: "~/x", risk: kind)
            L10n.shared.lang = .ru
            let ru = try #require(p.riskWarning)
            L10n.shared.lang = .en
            let en = try #require(p.riskWarning)
            #expect(ru.text != en.text && !en.text.isEmpty, "\(kind)")
            #expect(en.title.hasPrefix("Takeover location"))
        }
        L10n.shared.lang = .ru
        // a dangerous permission is first in the window, even before own buttons and new ones
        let ordered = PluginPermission.byWeight([PluginPermission(kind: "actions", what: "a [confirm] x", added: true), list[1], list[2]], addedFirst: false)
        #expect(ordered.first?.risk == "claude-code")
    }

    /// session.focus: the "Go to" button follows the core's "tab found" flag (focusable), without knowing the terminal; a daemon
    /// without session.focus — the old way, cmux.focus by the registry tab.
    @MainActor @Test func sessionFocusByCoreTabFlag() throws {
        let json = #"""
        {"primitives":[{"name":"cmux.focus","level":"immediate"},{"name":"session.focus","level":"immediate"}],
         "bridge":{"online":true},
         "sessions":[{"sessionId":"a","status":"idle","surfaceId":"S1","workspaceId":"W1","terminal":"cmux","focusable":true},
                     {"sessionId":"b","status":"idle","surfaceId":"S2","focusable":false},
                     {"sessionId":"c","status":"idle"}]}
        """#
        let state = try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
        #expect(state.sessions.map(\.focusable) == [true, false, nil])
        #expect(state.sessions[0].terminal == "cmux")
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: state)
        #expect(store.sessionFocusPrimitive && store.focusPrimitive)
        let a = try #require(store.focusRequest(sessionId: "a"))
        #expect(a.primitive == "session.focus" && a.args == ["sessionId": .string("a")])
        #expect(store.focusRequest(sessionId: "b") == nil, "the core didn't find the tab — no button, even though surfaceId is present")
        #expect(store.focusRequest(sessionId: "c") == nil)
        #expect(store.focusRequest(sessionId: "нет такой") == nil)
        // without the bridge — disabled, like cmux.focus (the cmux adapter goes through the bridge)
        #expect(ActionBlock.bridgePrimitives.contains("session.focus"))
        // an older daemon: only cmux.focus — by the registry tab
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"primitives":[{"name":"cmux.focus","level":"immediate"}],"sessions":[{"sessionId":"a","status":"idle","surfaceId":"S1","workspaceId":"W1"}]}"#.utf8))
        let oldStore = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: old)
        let o = try #require(oldStore.focusRequest(sessionId: "a"))
        #expect(o.primitive == "cmux.focus" && o.args == ["surfaceId": .string("S1"), "workspaceId": .string("W1")])
        // permission label in the consent window
        L10n.shared.lang = .ru
        #expect(PluginPermission(kind: "effects", what: "session.focus").plainText == "переводить во вкладку сессии")
        L10n.shared.lang = .en
        #expect(PluginPermission(kind: "effects", what: "session.focus").plainText == "switch to a session's tab")
        L10n.shared.lang = .ru
    }

    @Test func pluginTextHelpIsFullClippedAndOneLine() {
        // an "Agents" row that doesn't fit in the sidebar and the page rows
        let head = Item(title: #"Run "my-runner-public-final-cleanup" was stopped"#, params: ["status": "wait"])
        #expect(PluginText.rowHelp(head) == #"Run "my-runner-public-final-cleanup" was stopped"#)
        // the plugin's own tooltip= beats the text
        #expect(PluginText.rowHelp(Item(title: "A", params: ["tooltip": "полностью"])) == "полностью")
        // card: label, value, the line under it — joined with " — ", in one line
        let card = Item(title: "04:30", params: ["stat": "Следующий\nзапуск", "note": "через 2 ч"])
        #expect(PluginText.cardHelp(card) == "Следующий запуск — 04:30 — через 2 ч")
        // empty — no tooltip
        #expect(PluginText.rowHelp(Item(title: "  ")) == nil)
        #expect(PluginText.help(nil, "") == nil)
        // long — up to 300 chars, like SidebarStatus.clip
        let long = String(repeating: "очень длинная строка ", count: 40)
        let h = PluginText.rowHelp(Item(title: long))
        #expect(h?.count == SidebarStatus.helpLimit && h?.hasSuffix("…") == true)
    }

    @Test func heroAndTileHelpCarryTheWholeHeadline() throws {
        L10n.shared.lang = .en
        let p = try JSONDecoder().decode(PluginState.self, from: Data(##"""
        {"id":"agents","title":"Background agents","status":"wait","statusLabels":{"wait":{"label":"A run needs a look","hint":"A run failed, was stopped or lost its session — take a look"}},
         "header":[{"title":"Run \"my-runner-public-final-cleanup\" was stopped","params":{"tile":"1 stop","tileLabel":"Agents"}}]}
        """##.utf8))
        let hero = try #require(PluginText.heroHelp(p))
        #expect(hero.hasPrefix(#"Run "my-runner-public-final-cleanup" was stopped — "#))
        #expect(PluginText.tileHelp(p).contains(#"my-runner-public-final-cleanup" was stopped"#))
        // sidebar: the same full header in the tooltip, even though the row is truncated with an ellipsis
        let side = SidebarStatus.plugin(p)
        #expect(side.help == #"Run "my-runner-public-final-cleanup" was stopped"#)
        L10n.shared.lang = .ru
    }

    @Test func terminalPermissionReadsPlainAndLoud() throws {
        let list = try JSONDecoder().decode([PluginPermission].self, from: Data(##"""
        [{"kind":"terminal","what":"read-screen","why":"узнать, свободна ли сессия"},
         {"kind":"terminal","what":"send /model /effort","why":"сменить модель","risk":"terminal"},
         {"kind":"terminal","what":"send *","why":null,"risk":"terminal"}]
        """##.utf8))
        L10n.shared.lang = .ru
        #expect(list[0].kindLabel == "Терминал")
        #expect(list[0].riskWarning == nil)
        #expect(list[0].plainText?.hasPrefix("узнать, свободна ли сессия — узнавать, пусто ли поле ввода") == true)
        #expect(list[1].plainText?.contains("/model, /effort") == true)
        // "*" — directly: any request and slash command; mode lines ("!" — shell, "#", "&") the hub doesn't type
        #expect(list[2].plainText?.hasPrefix("набирать во вкладки Claude Code любые запросы и slash-команды") == true)
        #expect(list[2].plainText?.contains("«!»") == true)
        #expect(list[1].plainText?.contains("до трёх коротких аргументов") == true)
        let w = try #require(list[1].riskWarning)
        #expect(w.title.hasPrefix("Набор в сессии Claude Code") && w.text.contains("журнале"))
        L10n.shared.lang = .en
        #expect(try #require(list[1].riskWarning).title.hasPrefix("Typing into Claude Code"))
        #expect(PluginPermission.counted("terminal", 2) == "2 terminal permissions")
        L10n.shared.lang = .ru
        #expect(PluginPermission.counted("terminal", 2) == "2 права терминала")
        // typing — loud, first; reading — next to actions
        let ordered = PluginPermission.byWeight([PluginPermission(kind: "fsRead", what: "~/x"), list[0], list[1]], addedFirst: false)
        #expect(ordered.map(\.what) == ["send /model /effort", "read-screen", "~/x"])
    }

    @Test func lineStylingParams() {
        let it = Item(title: "Task", params: ["badge": "blocked", "badgeColor": "#F06A6A", "iconColor": "purple", "link": "true"])
        #expect(it.badgeColor == "#F06A6A")
        #expect(it.iconColor == "purple")
        #expect(it.isLink)
        let plain = Item(title: "Task", params: ["badgeColor": "", "link": "yes"])
        #expect(plain.badgeColor == nil && plain.iconColor == nil && !plain.isLink)
    }
}
