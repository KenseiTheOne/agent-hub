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
