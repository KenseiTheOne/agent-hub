import Foundation
import Testing
@testable import AgentHubKit

// The terminal layer in the shell (AH-33): sessions[].terminalInfo and /state.terminals decode, buttons follow what the session's
// terminal supports, the cmux bridge gates only cmux sessions, Settings → Terminal texts, the terminal.focus primitive.
@Suite(.serialized, .hubLang(.ru)) struct TerminalLayerTests {
    static let json = #"""
    {"primitives":[{"name":"session.focus","level":"immediate"},{"name":"terminal.focus","level":"immediate"},
                   {"name":"cmux.focus","level":"immediate","aliasOf":"terminal.focus","deprecated":true},
                   {"name":"session.interrupt","level":"confirm","appOnly":true},{"name":"session.launch","level":"confirm-cost","appOnly":true}],
     "peer":{"class":"app"},
     "bridge":{"online":false},
     "sessions":[
       {"sessionId":"c","status":"busy","pid":1,"surfaceId":"S1","terminal":"cmux","focusable":true,
        "terminalInfo":{"adapter":"cmux","label":"cmux","capabilities":["focus","read-screen","send-text","send-esc","launch"],"focusable":true,"via":"bridge"}},
       {"sessionId":"t","status":"busy","pid":2,"terminal":"tmux","focusable":true,
        "terminalInfo":{"adapter":"tmux","label":"tmux","capabilities":["focus","read-screen","send-text","send-esc","launch"],"focusable":true,"via":null}},
       {"sessionId":"i","status":"busy","pid":3,"terminal":"iterm2","focusable":true,
        "terminalInfo":{"adapter":"iterm2","label":"iTerm2","capabilities":["focus","launch"],"focusable":true}},
       {"sessionId":"g","status":"idle","pid":4,"terminal":null,"focusable":false,"terminalInfo":null}],
     "terminals":{"adapters":[
        {"id":"cmux","label":"cmux","capabilities":["focus","read-screen","send-text","send-esc","launch"],"via":"bridge","installed":true,"available":false,"reason":"bridge-offline","sessions":1},
        {"id":"tmux","label":"tmux","capabilities":["focus","read-screen","send-text","send-esc","launch"],"via":null,"installed":true,"available":true,"reason":null,"sessions":1},
        {"id":"iterm2","label":"iTerm2","capabilities":["focus","launch"],"via":null,"installed":true,"available":true,"reason":null,"sessions":1},
        {"id":"terminal-app","label":"Terminal","capabilities":["focus","launch"],"via":null,"installed":true,"available":true,"reason":null,"sessions":0}],
      "launch":{"adapter":"iterm2","why":"sessions"},"prefer":"auto"}}
    """#

    @MainActor func store() throws -> HubStore {
        let state = try JSONDecoder().decode(HubState.self, from: Data(Self.json.utf8))
        return HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: state)
    }

    @Test func decodesTerminalInfoAndTerminals() throws {
        let state = try JSONDecoder().decode(HubState.self, from: Data(Self.json.utf8))
        #expect(state.sessions.map(\.terminal) == ["cmux", "tmux", "iterm2", nil], "contract 3: terminal stays the adapter id")
        #expect(state.sessions[2].terminalInfo?.label == "iTerm2")
        #expect(state.sessions[2].terminalInfo?.supports("send-esc") == false)
        #expect(state.sessions[0].terminalInfo?.needsBridge == true && state.sessions[1].terminalInfo?.needsBridge == false)
        #expect(state.sessions[3].terminalInfo == nil)
        #expect(state.terminals?.adapters.map(\.id) == ["cmux", "tmux", "iterm2", "terminal-app"])
        #expect(state.terminals?.launchAdapter?.label == "iTerm2")
        #expect(state.primitives.first { $0.name == "cmux.focus" }?.aliasOf == "terminal.focus")
        // an older daemon: no terminals, no terminalInfo
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"sessions":[{"sessionId":"a","terminal":"cmux","focusable":true}]}"#.utf8))
        #expect(old.terminals == nil && old.sessions[0].terminalInfo == nil)
    }

    /// The bridge gates only cmux sessions; a terminal without a capability disables its button with a tooltip naming it.
    @MainActor @Test func buttonsFollowTheSessionsTerminal() throws {
        L10n.shared.lang = .en
        defer { L10n.shared.lang = .ru }
        let store = try store()
        let by = Dictionary(uniqueKeysWithValues: store.sessions.map { ($0.sessionId, $0) })
        #expect(store.gate(primitive: "session.focus", session: by["c"]!, capability: "focus") == .noBridge)
        #expect(store.gate(primitive: "session.focus", session: by["t"]!, capability: "focus") == nil, "tmux doesn't wait for the cmux bridge")
        #expect(store.gate(primitive: "session.focus", session: by["i"]!, capability: "focus") == nil)
        #expect(store.canFocus(by["t"]!) && store.canFocus(by["i"]!) && !store.canFocus(by["c"]!))
        #expect(store.focusRequest(sessionId: "g") == nil, "no terminal found — no button")
        let esc = store.gate(primitive: "session.interrupt", session: by["i"]!, capability: "send-esc")
        #expect(esc == .unsupported(terminal: "iTerm2", capability: "send-esc"))
        #expect(esc?.help == "iTerm2 can't press Esc from the hub — interrupt the turn in the tab")
        #expect(store.gate(primitive: "session.interrupt", session: by["t"]!, capability: "send-esc") == nil)
        #expect(store.sessionsWaitingForBridge, "a cmux session while the bridge is offline — the banner shows")
        store.handle(SSEEvent(id: "9", event: "bridge.connected", data: #"{"pid":5}"#))
        #expect(!store.sessionsWaitingForBridge && store.canFocus(by["c"]!))
        // tab id focus: terminal.focus, not the deprecated alias
        #expect(store.tabFocusPrimitive == "terminal.focus")
    }

    @MainActor @Test func launchFollowsTheLaunchTerminal() throws {
        let store = try store()
        #expect(store.launchTerminal?.id == "iterm2")
        #expect(store.launchGate() == nil, "iTerm2 doesn't need the cmux bridge")
        var state = try JSONDecoder().decode(HubState.self, from: Data(Self.json.utf8))
        state.terminals?.launch = TerminalsInfo.Launch(adapter: "cmux", why: "installed")
        let cmux = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: state)
        #expect(cmux.launchGate() == .noBridge)
        state.terminals?.launch = nil
        let none = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: state)
        #expect(none.launchGate() == .noLaunchTerminal)
        // an older daemon: cmux only, through the bridge
        state.terminals = nil
        let old = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: state)
        #expect(old.launchGate() == .noBridge)
    }

    @Test func settingsTexts() throws {
        let state = try JSONDecoder().decode(HubState.self, from: Data(Self.json.utf8))
        let ts = try #require(state.terminals)
        L10n.shared.lang = .en
        #expect(TerminalText.status(ts.adapters[0], bridgeOnline: false) == "1 session · bridge not connected")
        #expect(TerminalText.status(ts.adapters[3], bridgeOnline: false) == "installed")
        #expect(TerminalText.ready(ts.adapters[0], bridgeOnline: true) && !TerminalText.ready(ts.adapters[0], bridgeOnline: false))
        #expect(TerminalText.capability("send-esc") == "Esc (interrupt)")
        #expect(TerminalText.unsupported(terminal: "Terminal", capability: "read-screen") == "Terminal doesn't support: read the screen")
        #expect(TerminalText.launchWhy("sessions") == "most sessions run there")
        #expect(TerminalText.launchNote("tmux") == "A new tmux tab opens in the background. The prompt goes as a 0600 file and is deleted after reading.")
        #expect(PluginPermission(kind: "effects", what: "terminal.focus").plainText == "switch to a terminal tab")
        L10n.shared.lang = .ru
        #expect(TerminalText.status(ts.adapters[1], bridgeOnline: false) == "1 сессия · установлен")
        #expect(TerminalText.unsupported(terminal: "iTerm2", capability: "focus") == "iTerm2 не умеет переходить во вкладку из хаба")
        #expect(TerminalText.launchNote("iTerm2").hasPrefix("Новая вкладка iTerm2 откроется в фоне."))
        #expect(PluginPermission(kind: "effects", what: "cmux.focus").plainText == "переводить во вкладку терминала")
        // refusal codes of the terminal layer have their own texts
        for code in ["facts:no-terminal", "facts:esc-unsupported", "facts:no-launch-terminal", "facts:tmux-failed", "facts:osascript-failed", "terminal:unsupported"] {
            #expect(Explain.covers(code), "\(code)")
        }
    }
}
