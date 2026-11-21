import Foundation
import Testing
@testable import AgentHubKit

// Task 100: a plugin action's confirmation by parts — decoded from a 428 next to the whole text, and "where" resolved
// against the store's sessions (the tab a session argument names), not shown as a bare id.

private let body = """
{"error":"confirm-required","needsConfirm":true,"token":"t","level":"confirm-cost","text":"whole text","cost":"whole cost",
 "expiresInMs":60000,"row":"Fix",
 "parts":{"plugin":"P","tier":"official plugin","title":"Bring the tab to the base","command":"p.mjs --action apply AB-1",
          "arg":"ab-1","row":"Fix","parentRow":null,"costNet":null,"note":"can't be undone","notePlugin":true,"input":null,"background":false}}
"""

@Test func confirmPartsDecodeNextToTheWholeText() throws {
    let r = try JSONDecoder().decode(ConfirmRequest.self, from: Data(body.utf8))
    #expect(r.text == "whole text")
    let p = try #require(r.parts)
    #expect(p.title == "Bring the tab to the base")
    #expect(p.note == "can't be undone")
    #expect(p.notePlugin)
    #expect(p.costNet == nil)
    #expect(r.place == nil, "place is the store's, never decoded")
}

@Test(.hubLang(.en)) func confirmPlaceNamesTheSessionTabNotItsId() throws {
    let r = try JSONDecoder().decode(ConfirmRequest.self, from: Data(body.utf8))
    let s = SessionInfo(sessionId: "AB-1", status: "idle", name: "release", cwd: "/x/my-project")
    let placed = r.placed(sessions: [s], actionLabel: "Fix")
    #expect(placed.place?.hasPrefix("my-project · ") == true)
    #expect(placed.place?.contains("release") == true)
    #expect(placed.place?.contains("AB-1") == false)
    // no such session: the row says only "Fix", which is the button itself — nothing to add
    #expect(r.placed(sessions: [], actionLabel: "Fix").place == nil)
}

@Test func confirmPlaceFallsBackToTheParentRow() {
    let p = ConfirmParts(plugin: "P", tier: "t", title: "Approve", command: "c", arg: "r9", row: "Fix", parentRow: "Tab alpha")
    #expect(p.place(sessions: [], actionLabel: "Fix")?.value == "Tab alpha")
    let own = ConfirmParts(plugin: "P", tier: "t", title: "Approve", command: "c", row: "Approve")
    #expect(own.place(sessions: [], actionLabel: "Approve") == nil, "a row repeating the action title adds nothing")
}

// Task 125: the windows that also ask for text get the same "where" as a plain confirmation — the field itself, the retry
// after the core refused the text, and a banner button that reaches an input action without its field.
@Suite(.serialized, .hubLang(.en)) struct ConfirmPartsInputTests {
    private static let parts428 = """
    {"error":"confirm-required","needsConfirm":true,"token":"tok","level":"confirm","text":"whole text",
     "input":{"placeholder":"Note","maxLength":20},"row":"Fix",
     "parts":{"plugin":"P","tier":"official plugin","title":"Add a note","command":"p.mjs note","row":"Fix","parentRow":"Tab alpha"}}
    """

    @MainActor @Test func inputPromptsAreRequestsWithTheirPlace() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.replyBody = { method, uri, raw in
            guard method == "POST", uri == "/actions/o1" || uri == "/actions/o2" else { return nil }
            let b = (try? JSONDecoder().decode([String: JSONValue].self, from: Data(raw.utf8))) ?? [:]
            if b["confirmToken"] == nil { return (428, Self.parts428) }
            if b["input"]?.stringValue == "123" { return (400, #"{"error":"input:pattern"}"#) }
            return (200, #"{"ok":true,"result":{"ok":true,"code":0}}"#)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = PromptPresenter()
        p.answers = ["123", "hello", "from banner"]
        store.presenter = p
        let offer = Offer(id: "o1", kind: "action", action: "note", level: .confirm, label: "Fix", input: OfferInput(placeholder: "Note", maxLength: 20))
        #expect(await store.perform(offer: offer, label: "Fix"))
        #expect(await store.perform(id: "o2", args: nil, label: "Fix"))
        #expect(p.prompts.count == 3)
        // the field, the retry after `input:pattern`, the banner button
        for prompt in p.prompts { #expect(prompt.confirm?.place == "Tab alpha") }
        #expect(p.prompts[1].error != nil)
    }
}

// Task 123: the action's name is the plugin's words — the window quotes it, drops control characters and always says whose
// action it is. Task 124: parts this shell can't read leave the whole text, the confirmation still decodes.
@Suite(.hubLang(.en)) struct ConfirmPartsTitleTests {
    @Test func titleIsQuotedAndCleaned() {
        let p = ConfirmParts(plugin: "Evil\u{202E}Plug", tier: "community plugin", title: "Update\nthe hub?\u{200B}", command: "c")
        #expect(p.windowTitle(actionLabel: "Go") == "\u{201C}Update the hub?\u{201D}")
        #expect(p.byline == "Action of the plugin \u{201C}Evil Plug\u{201D} · community plugin")
        let untitled = ConfirmParts(plugin: "P", tier: "t", title: nil, command: "c")
        #expect(untitled.windowTitle(actionLabel: "Go") == "\u{201C}Go\u{201D}")
        let long = ConfirmParts(plugin: "P", tier: "t", title: String(repeating: "a", count: 200), command: "c")
        #expect(long.windowTitle(actionLabel: "Go").count == 82)
    }

    @Test func unreadablePartsLeaveTheWholeText() throws {
        let raw = #"{"token":"t","level":"confirm","text":"whole text","parts":{"tier":"x","command":"c"}}"#
        let r = try JSONDecoder().decode(ConfirmRequest.self, from: Data(raw.utf8))
        #expect(r.parts == nil && r.text == "whole text")
    }
}
