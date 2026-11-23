import Foundation
import Testing
@testable import AgentHubKit

// Task 120: plugins in the sidebar and the menu — alphabetical by default, a hand-made order remembered until "Default".

private func p(_ id: String, _ title: String, _ status: HubStatus = .ok) -> PluginState {
    PluginState(id: id, title: title, status: status)
}

private let daemonOrder = [p("q", "Quota"), p("bg", "background agents"), p("c", "ClickUp"), p("a10", "Agent 10"), p("a9", "Agent 9")]

@Suite struct PluginOrderTests {
    @Test func defaultIsAlphabeticalLikeFinder() {
        // case-insensitive, numbers by value ("Agent 9" before "Agent 10")
        #expect(PluginOrder.apply([], to: daemonOrder).map(\.id) == ["a9", "a10", "bg", "c", "q"])
    }

    @Test func savedOrderWinsAndNewPluginsGoAfterAlphabetically() {
        // "gone" is no longer installed, "c" is listed twice; a9/a10/bg were installed after the order was saved
        let out = PluginOrder.apply(["q", "gone", "c", "c"], to: daemonOrder).map(\.id)
        #expect(out == ["q", "c", "a9", "a10", "bg"])
    }

    @Test func encodeDecodeRoundTripSkipsBlankLines() {
        #expect(PluginOrder.decode(PluginOrder.encode(["a", "b"])) == ["a", "b"])
        #expect(PluginOrder.decode("") == [])
        #expect(PluginOrder.decode("a\n\n b \n") == ["a", "b"])
    }

    @Test func moveOntoTarget() {
        #expect(PluginOrder.move("c", onto: "a", in: ["a", "b", "c"]) == ["c", "a", "b"])
        #expect(PluginOrder.move("a", onto: "c", in: ["a", "b", "c"]) == ["b", "c", "a"])
        #expect(PluginOrder.move("a", onto: "a", in: ["a", "b"]) == ["a", "b"])
        #expect(PluginOrder.move("x", onto: "a", in: ["a", "b"]) == ["a", "b"])
    }

    @Test func stepStopsAtEdges() {
        #expect(PluginOrder.step("b", by: -1, in: ["a", "b", "c"]) == ["b", "a", "c"])
        #expect(PluginOrder.step("b", by: 1, in: ["a", "b", "c"]) == ["a", "c", "b"])
        #expect(PluginOrder.step("a", by: -1, in: ["a", "b"]) == ["a", "b"])
        #expect(PluginOrder.step("b", by: 1, in: ["a", "b"]) == ["a", "b"])
    }

    @Test func alphabeticalArrangementIsSavedAsDefault() {
        #expect(PluginOrder.toSave(["a9", "a10", "bg", "c", "q"], plugins: daemonOrder) == "")
        #expect(PluginOrder.toSave(["q", "a9", "a10", "bg", "c"], plugins: daemonOrder) == "q\na9\na10\nbg\nc")
    }

    @Test func menuPutsAttentionFirstThenTheGivenOrder() {
        let order = PluginOrder.apply(["q", "c"], to: [p("c", "ClickUp", .error), p("q", "Quota"), p("bg", "BG")])
        #expect(HubState.byAttention(order).map(\.id) == ["c", "q", "bg"])
    }

    @Test func replacingKeepsHiddenIdsInPlace() {
        // the sidebar hides "s" (the sessions plugin); the menu still sees it at its place
        #expect(PluginOrder.replacing(visible: ["c", "a"], in: ["a", "s", "c"]) == ["c", "s", "a"])
    }

    @Test @MainActor func storeRemembersTheOrderAcrossLaunchesUntilDefault() throws {
        let suite = "agenthub.test.pluginOrder.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let state = HubState(plugins: daemonOrder)
        let client = HubClient(socketPath: "/tmp/order-test.sock")
        let key = HubDefaults.key(PluginOrder.defaultsBase, socketPath: client.socketPath)

        let first = HubStore(client: client, preview: state)
        first.rememberPluginOrder(in: defaults)
        #expect(first.orderedPlugins.map(\.id) == ["a9", "a10", "bg", "c", "q"])
        #expect(!first.pluginOrderIsCustom)
        first.arrangePlugins(["q", "c", "a9", "a10", "bg"])
        #expect(first.pluginOrderIsCustom)

        // the next launch reads it back
        let second = HubStore(client: client, preview: state)
        second.rememberPluginOrder(in: defaults)
        #expect(second.orderedPlugins.map(\.id) == ["q", "c", "a9", "a10", "bg"])
        #expect(second.pluginsByAttention.map(\.id) == ["q", "c", "a9", "a10", "bg"])

        // "Default" removes the saved value
        second.resetPluginOrder()
        #expect(defaults.string(forKey: key) == nil)
        #expect(second.orderedPlugins.map(\.id) == ["a9", "a10", "bg", "c", "q"])
    }

    @Test @MainActor func popoverListsPluginsAsTheSidebarDoes() throws {
        // the sidebar: the sessions plugin's row first, then the panel's order; attention does not move rows
        let suite = "agenthub.test.pluginOrder.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let sessions = p(NotifyTarget.sessionsPlugin, "Sessions")
        let store = HubStore(client: HubClient(socketPath: "/tmp/order-sidebar.sock"),
                             preview: HubState(plugins: [p("q", "Quota"), p("c", "ClickUp", .error), sessions, p("bg", "BG")]))
        store.rememberPluginOrder(in: defaults)
        #expect(store.pluginsAsInSidebar.map(\.id) == [NotifyTarget.sessionsPlugin, "bg", "c", "q"])
        store.arrangePlugins(["q", NotifyTarget.sessionsPlugin, "c", "bg"])
        #expect(store.pluginsAsInSidebar.map(\.id) == [NotifyTarget.sessionsPlugin, "q", "c", "bg"])
    }
}
