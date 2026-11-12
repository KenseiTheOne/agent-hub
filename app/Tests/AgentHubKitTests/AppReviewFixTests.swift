import Foundation
import Testing
@testable import AgentHubKit

// Review fixes, app side (2026-11-12, FIX-D): typed input that keeps being refused ends with a reason (D2), input length
// in code points like the core (D3), the inline field's text kept by offer id across row shifts (D4), banner categories
// keyed by SHA-256 and verified on a hit (D5), the `revoked` extension status, the secrets list cap (`more`). The daemon is the FakeDaemon double (ReviewFixTests.swift).

@Suite(.serialized) struct AppReviewFixTests {
    // MARK: D2 — no silent stop after repeated refusals

    @MainActor @Test func inputRefusedEveryTimeEndsWithAReason() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        // the plugin's pattern refuses whatever the human types
        d.reply = { method, uri in method == "POST" && uri == "/actions/o1" ? (400, #"{"error":"input:pattern"}"#) : nil }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = PromptPresenter()
        p.answers = Array(repeating: "again", count: 10)
        store.presenter = p
        L10n.shared.lang = .en
        defer { L10n.shared.lang = .ru }
        let offer = Offer(id: "o1", kind: "action", level: .immediate, label: "Rename", input: OfferInput(maxLength: 64))
        #expect(!(await store.perform(offer: offer, label: "Rename", input: "first")))
        #expect(d.requests.filter { $0.uri == "/actions/o1" }.count == 7, "the typed text and six retries")
        #expect(p.prompts.count == 6)
        #expect(p.reports.count == 1, "out of retries: the last refusal is reported, not dropped")
        #expect(p.reports.first?.title == "Couldn't: Rename")
        #expect(p.reports.first?.detail.contains("input:pattern") == true)
        #expect(store.busyAction == nil)
    }

    // MARK: D3 — length in code points

    @Test func inputLengthCountsCodePointsLikeTheCore() {
        // "👍🏽" is one grapheme but two code points; "é" as e + combining accent — two code points
        let thumbs = "👍🏽"
        #expect(thumbs.count == 1 && InputCheck.length(thumbs) == 2)
        #expect(InputCheck.code(String(repeating: thumbs, count: 3), maxLength: 5) == "input:too-long", "6 code points over a limit of 5")
        #expect(InputCheck.code(String(repeating: thumbs, count: 2), maxLength: 4) == nil)
        #expect(InputCheck.code("e\u{301}e\u{301}", maxLength: 3) == "input:too-long")
        #expect(InputCheck.code("привет 👋", maxLength: 8) == nil, "8 code points fit 8")
        #expect(InputCheck.counter(String(repeating: thumbs, count: 2), maxLength: 5) == "4/5", "the counter counts what the core counts")
    }

    // MARK: D4 — the inline field's text by offer id

    @MainActor @Test func inputDraftsSurviveTheFieldAndAreBounded() {
        let st = try! JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"peer":{"class":"app","reason":null}}"#.utf8))
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: st)
        #expect(store.inputDraft("o1") == "")
        store.setInputDraft("o1", "half-typed")
        store.setInputDraft("o2", "other")
        // a refresh recreates the field (rows above shifted): the new view reads the same text by offer id
        #expect(store.inputDraft("o1") == "half-typed" && store.inputDraft("o2") == "other")
        store.setInputDraft("o1", "")
        #expect(store.inputDraft("o1") == "" && store.inputDrafts["o1"] == nil, "sent or cleared — no draft left")
        for i in 0..<(HubStore.maxInputDrafts + 5) { store.setInputDraft("x\(i)", "t\(i)") }
        #expect(store.inputDrafts.count == HubStore.maxInputDrafts)
        #expect(store.inputDraft("o2") == "", "the oldest draft goes first")
        #expect(store.inputDraft("x\(HubStore.maxInputDrafts + 4)") == "t\(HubStore.maxInputDrafts + 4)")
        // typing again into an old field makes it the newest
        store.setInputDraft("x5", "edited")
        store.setInputDraft("y", "new")
        #expect(store.inputDraft("x5") == "edited")
    }

    // MARK: D5 — banner categories

    @Test func categoryIdIsSHA256OfTheButtonSet() {
        let a = [NotifyAction(offer: "o1", label: "Retry", level: .confirm)]
        let id = NotifyCategory.identifier(for: a)
        #expect(id.hasPrefix("agenthub.event.a."))
        #expect(id.dropFirst("agenthub.event.a.".count).count == 32, "128 bits of SHA-256 in hex")
        #expect(id == NotifyCategory.identifier(for: [NotifyAction(offer: "o2", label: "Retry", level: .confirm)]))
        #expect(id != NotifyCategory.identifier(for: [NotifyAction(offer: "o1", label: "Retry", level: .immediate)]))
        #expect(id != NotifyCategory.identifier(for: [NotifyAction(offer: "o1", label: "Retry ", level: .confirm)]))
    }

    @Test func categoryRegistryVerifiesTheStoredSetOnAHit() {
        // every set gets the same id: a forced collision
        var r = NotifyCategory.Registry(limit: 3, identify: { $0.isEmpty ? NotifyCategory.plain : "agenthub.event.a.same" })
        let a = [NotifyAction(offer: "o1", label: "Retry", level: .confirm)]
        let b = [NotifyAction(offer: "o2", label: "Delete", level: .confirmCost)]
        #expect(r.register([]) == (NotifyCategory.plain, false), "no buttons — the plain category, nothing registered")
        #expect(r.register(a) == ("agenthub.event.a.same", true))
        #expect(r.register([NotifyAction(offer: "o9", label: "Retry", level: .confirm)]).changed == false, "the same titles and levels — a hit")
        #expect(r.register(b).changed, "the id is taken by other buttons: the stored set is replaced and registered again")
        #expect(r.sets.count == 1 && r.sets[0].actions == b)
    }

    // MARK: revoked extension (daemon C4)

    @Test func revokedExtensionIsLabelledAndNotPending() throws {
        // an older payload without `pending`: the count comes from the items, and a revoked item is not waiting for anyone
        let json = #"{"dir":"/x","enabled":true,"items":[{"path":"services/a.mjs","kind":"service","status":"revoked","loaded":true,"restartRequired":true},{"path":"routes/b.mjs","kind":"route","status":"pending"}]}"#
        let info = try JSONDecoder().decode(ExtensionsInfo.self, from: Data(json.utf8))
        #expect(info.items[0].status == .revoked && !info.items[0].needsApproval && info.items[0].restartRequired)
        #expect(info.pending == 1)
        L10n.shared.lang = .en
        #expect(info.items[0].statusText == "approval revoked — runs until restart")
        L10n.shared.lang = .ru
        #expect(info.items[0].statusText == "одобрение отозвано — работает до перезапуска")
    }

    // MARK: secrets list cap (daemon C3)

    @Test func secretsListCarriesTheLeftOutCount() throws {
        let capped = try JSONDecoder().decode(SecretsList.self, from: Data(#"{"plugin":"tool","keychain":true,"secrets":[{"key":"tool.a","state":"unset","editable":true}],"more":7}"#.utf8))
        #expect(capped.secrets.count == 1 && capped.more == 7)
        L10n.shared.lang = .en
        #expect(capped.moreText == "and 7 more")
        L10n.shared.lang = .ru
        #expect(capped.moreText == "и ещё 7")
        // an older daemon or a full list: no line; a broken value counts as none
        let all = try JSONDecoder().decode(SecretsList.self, from: Data(#"{"plugin":"tool","secrets":[]}"#.utf8))
        #expect(all.more == 0 && all.moreText == nil)
        let odd = try JSONDecoder().decode(SecretsList.self, from: Data(#"{"plugin":"tool","secrets":[],"more":-3}"#.utf8))
        #expect(odd.moreText == nil)
        let bad = try JSONDecoder().decode(SecretsList.self, from: Data(#"{"plugin":"tool","secrets":[],"more":"x"}"#.utf8))
        #expect(bad.more == 0)
    }

    @Test func categoryRegistryKeepsTheNewestSets() {
        var r = NotifyCategory.Registry(limit: 2)
        let sets = ["One", "Two", "Three"].map { [NotifyAction(offer: "o", label: $0, level: .confirm)] }
        for s in sets { #expect(r.register(s).changed) }
        #expect(r.sets.map(\.actions) == Array(sets.suffix(2)), "the oldest category is dropped first")
        #expect(!r.register(sets[2]).changed)
    }
}
