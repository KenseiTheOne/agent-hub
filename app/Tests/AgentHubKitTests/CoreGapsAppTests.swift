import Foundation
import Testing
@testable import AgentHubKit

// Core gaps, app side (2026-11-12): typed input for actions (G1), the confirmation row (G10), background jobs (G6), banner
// buttons and click target (G5), plugin keys (G8), `max=`/`sparkMax=`/`until=`/`font=mono` (G18), every declared
// connection. The daemon is the FakeDaemon double (ReviewFixTests.swift).

/// A presenter that answers prompts from a script and records what it was asked.
@MainActor
final class PromptPresenter: ConfirmPresenter {
    var prompts: [InputPrompt] = []
    var answers: [String?] = []
    var confirms: [ConfirmRequest] = []
    var reports: [(title: String, detail: String)] = []
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool { confirms.append(request); return true }
    func report(title: String, detail: String) { reports.append((title, detail)) }
    func consent(_ request: ConsentRequest) async -> Bool { false }
    func prompt(_ request: InputPrompt) async -> String? {
        prompts.append(request)
        return answers.isEmpty ? nil : answers.removeFirst()
    }
}

private func body(_ r: FakeDaemon.Request) -> [String: JSONValue] {
    (try? JSONDecoder().decode([String: JSONValue].self, from: Data(r.body.utf8))) ?? [:]
}

@Suite(.serialized) struct CoreGapsAppTests {
    // MARK: G1 — offers with input, the 428 field

    @Test func offerDecodesInputAndBackground() throws {
        let o = try JSONDecoder().decode(Offer.self, from: Data(#"{"id":"o1","kind":"action","action":"note","level":"confirm","label":"Note","input":{"placeholder":"Note text","maxLength":99999,"pattern":"^.{1,200}$"},"background":true}"#.utf8))
        #expect(o.input == OfferInput(placeholder: "Note text", maxLength: 4000, pattern: "^.{1,200}$"))
        #expect(o.background)
        // an older daemon: no fields — an ordinary button; a broken input does not break the offer
        let plain = try JSONDecoder().decode(Offer.self, from: Data(#"{"id":"o2","kind":"action","level":"immediate"}"#.utf8))
        #expect(plain.input == nil && !plain.background)
        let odd = try JSONDecoder().decode(Offer.self, from: Data(#"{"id":"o3","level":"immediate","input":{"placeholder":"","maxLength":"x"}}"#.utf8))
        #expect(odd.input == OfferInput(placeholder: nil, maxLength: OfferInput.defaultMaxLength))
    }

    @Test func inputChecksMirrorTheCore() {
        #expect(InputCheck.code("", maxLength: 10) == "input:required")
        #expect(InputCheck.code("12345678901", maxLength: 10) == "input:too-long")
        #expect(InputCheck.code("a\nb", maxLength: 10) == "input:control")
        #expect(InputCheck.code("a\u{200B}b", maxLength: 10) == "input:control", "format characters too")
        #expect(InputCheck.code("-rf", maxLength: 10) == "input:option-like")
        #expect(InputCheck.code("привет 👋", maxLength: 10) == nil, "code points are counted, not bytes")
        L10n.shared.lang = .en
        #expect(InputCheck.message("input:too-long", maxLength: 200) == "Too long: at most 200 characters.")
        #expect(Explain.text(code: "input:pattern", status: 400, label: "Note").contains("check the format"))
        L10n.shared.lang = .ru
        #expect(InputCheck.message("input:option-like").contains("«-»"))
        #expect(InputCheck.counter("abc", maxLength: 10) == nil)
        #expect(InputCheck.counter("abcdefghi", maxLength: 10) == "9/10")
    }

    @Test func confirmDecodesRowInputBackground() throws {
        let req = try JSONDecoder().decode(ConfirmRequest.self, from: Data(#"{"error":"confirm-required","needsConfirm":true,"token":"t","level":"confirm","text":"\"Tool\" asks to: \"Add a note\". Button on the row \"Build #12\".","cost":null,"expiresInMs":120000,"row":"Build #12","input":{"placeholder":"Note","maxLength":200},"background":true}"#.utf8))
        #expect(req.row == "Build #12" && req.input?.maxLength == 200 && req.background == true)
        // the core already quoted the row — the sheet does not repeat it
        #expect(req.extraRow(actionLabel: "Add a note") == nil)
        var other = req
        other.text = "\"Tool\" asks to: \"Add a note\"."
        #expect(other.extraRow(actionLabel: "Add a note") == "Build #12")
        #expect(other.extraRow(actionLabel: "Build #12") == nil, "the row that only repeats the button title")
        // an older daemon: no row, no field
        let old = try JSONDecoder().decode(ConfirmRequest.self, from: Data(#"{"token":"t","level":"confirm","text":"x"}"#.utf8))
        #expect(old.row == nil && old.input == nil && old.extraRow(actionLabel: "x") == nil)
    }

    @MainActor @Test func confirmLevelInputAsksInTheSheetAndResendsWithToken() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.replyBody = { method, uri, raw in
            guard method == "POST", uri == "/actions/o1" else { return nil }
            let b = (try? JSONDecoder().decode([String: JSONValue].self, from: Data(raw.utf8))) ?? [:]
            if b["confirmToken"] == nil {
                return (428, #"{"error":"confirm-required","needsConfirm":true,"token":"tok","level":"confirm","text":"asks","input":{"placeholder":"Note","maxLength":20},"row":"Build #12"}"#)
            }
            // the plugin's pattern refuses digits; the token is still good (input is checked before the confirmation)
            if b["input"]?.stringValue == "123" { return (400, #"{"error":"input:pattern"}"#) }
            return (200, #"{"ok":true,"result":{"ok":true,"code":0}}"#)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = PromptPresenter()
        p.answers = ["123", "hello"]
        store.presenter = p
        let offer = Offer(id: "o1", kind: "action", action: "note", level: .confirm, label: "Note", input: OfferInput(placeholder: "Note", maxLength: 20))
        L10n.shared.lang = .en
        let ok = await store.perform(offer: offer, label: "Note")
        #expect(ok)
        let posts = d.requests.filter { $0.uri == "/actions/o1" }
        #expect(posts.count == 3)
        #expect(body(posts[0])["input"] == nil, "the first request goes without text: the 428 brings the field")
        #expect(body(posts[1])["input"]?.stringValue == "123" && body(posts[1])["confirmToken"]?.stringValue == "tok")
        #expect(body(posts[2])["input"]?.stringValue == "hello" && body(posts[2])["confirmToken"]?.stringValue == "tok")
        #expect(p.prompts.count == 2)
        #expect(p.prompts[0].confirm?.token == "tok" && p.prompts[0].input.maxLength == 20 && p.prompts[0].error == nil)
        #expect(p.prompts[1].text == "123" && p.prompts[1].error?.contains("check the format") == true)
        #expect(p.confirms.isEmpty && p.reports.isEmpty)
        L10n.shared.lang = .ru
    }

    @MainActor @Test func immediateInputSendsTypedTextOnce() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.reply = { method, uri in method == "POST" && uri == "/actions/o2" ? (200, #"{"ok":true,"result":{"ok":true,"code":0}}"#) : nil }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = PromptPresenter()
        store.presenter = p
        let offer = Offer(id: "o2", kind: "action", level: .immediate, label: "Rename", input: OfferInput(maxLength: 64))
        #expect(await store.perform(offer: offer, label: "Rename", input: "new name"))
        #expect(p.prompts.isEmpty, "the inline field already had the text")
        // pressed where there is no field (a table row, the popover): the sheet asks; cancelled — nothing is sent
        #expect(!(await store.perform(offer: offer, label: "Rename")))
        #expect(p.prompts.count == 1 && p.prompts[0].confirm == nil)
        let posts = d.requests.filter { $0.uri == "/actions/o2" }
        #expect(posts.count == 1 && body(posts[0])["input"]?.stringValue == "new name" && body(posts[0])["confirmToken"] == nil)
    }

    @MainActor @Test func inputOffersAreAppOnly() {
        let st = try! JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"peer":{"class":"cli","reason":null}}"#.utf8))
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: st)
        let plain = Offer(id: "a", kind: "action", level: .immediate)
        #expect(store.gate(offer: plain) == nil)
        var typed = plain
        typed.input = OfferInput()
        #expect(store.gate(offer: typed) == .notPinned)
    }

    // MARK: G6 — jobs

    @Test func jobsDecodeAndFollowEvents() throws {
        var st = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"plugins":[{"id":"tool","title":"Tool","actions":[{"id":"sync","level":"immediate","title":"Sync","arg":null,"background":true,"net":"none"}],"jobs":[{"id":"9f2c4e1a7b3d5c60","actionId":"sync","title":"Sync","startedAt":"2026-11-12T10:00:00.000Z","pid":4242}]}]}"#.utf8))
        let p = try #require(st.plugins.first)
        #expect(p.jobs.count == 1 && p.jobs[0].startDate != nil && p.actions[0].background == true && p.actions[0].net == "none")
        let started = SSEEvent(id: "2", event: "job.started", data: #"{"plugin":"tool","actionId":"sync","job":"aaaaaaaaaaaaaaaa","pid":5,"ts":"2026-11-12T10:01:00.000Z"}"#)
        let ev = try #require(HubEvent.decode(started))
        let added = st.apply(ev)
        #expect(added)
        #expect(st.plugins[0].jobs.map(\.id) == ["9f2c4e1a7b3d5c60", "aaaaaaaaaaaaaaaa"] && st.plugins[0].jobs[1].title == "Sync")
        let again = st.apply(ev)
        #expect(!again, "the same job twice — no change")
        let exited = SSEEvent(id: "3", event: "job.exited", data: #"{"plugin":"tool","actionId":"sync","job":"9f2c4e1a7b3d5c60","ok":false,"code":null,"signal":"SIGTERM","cancelled":"cancelled"}"#)
        guard case .job(let j)? = HubEvent.decode(exited) else { Issue.record("job.exited not decoded"); return }
        #expect(!j.started && j.cancelled == "cancelled" && j.signal == "SIGTERM")
        let removed = st.apply(.job(j))
        #expect(removed)
        #expect(st.plugins[0].jobs.map(\.id) == ["aaaaaaaaaaaaaaaa"])
        // an older daemon: no jobs
        #expect(try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"x"}"#.utf8)).jobs.isEmpty)
    }

    @Test func elapsedAndCountdownTexts() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        L10n.shared.lang = .en
        #expect(JobsText.elapsed(since: t0, now: t0.addingTimeInterval(42)) == "42 s")
        #expect(JobsText.elapsed(since: t0, now: t0.addingTimeInterval(185)) == "3:05")
        #expect(JobsText.elapsed(since: t0, now: t0.addingTimeInterval(3723)) == "1:02:03")
        #expect(JobsText.elapsed(since: nil) == "")
        L10n.shared.lang = .ru
        #expect(Countdown.text(until: t0.addingTimeInterval(65), now: t0) == "01:05")
        #expect(Countdown.text(until: t0.addingTimeInterval(64.2), now: t0) == "01:05", "a started second counts")
        #expect(Countdown.text(until: t0.addingTimeInterval(3 * 3600 + 7), now: t0) == "3:00:07")
        #expect(Countdown.text(until: t0, now: t0.addingTimeInterval(30)) == "00:00", "stops at zero")
    }

    @MainActor @Test func stopSendsJobCancel() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.reply = { method, uri in method == "POST" && uri == "/actions/job.cancel" ? (200, #"{"ok":true,"result":{"ok":true}}"#) : nil }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.presenter = PromptPresenter()
        await store.cancelJob(PluginJob(id: "9f2c4e1a7b3d5c60", actionId: "sync", title: "Sync"))
        let post = try #require(d.requests.first { $0.uri == "/actions/job.cancel" })
        #expect(body(post)["args"]?["job"]?.stringValue == "9f2c4e1a7b3d5c60")
    }

    // MARK: G5 — banner buttons

    @Test func pushNotifyDecodesButtonsAndHref() throws {
        let n = try JSONDecoder().decode(PushNotify.self, from: Data(#"{"notifyId":"n1","title":"Build","plugin":"tool","key":"tool:build-failed","digest":false,"actions":[{"offer":"o1","label":"Retry","level":"confirm"},{"offer":"o2","label":"  ","level":"immediate"},{"offer":"o3","label":"Mute","level":"immediate"},{"offer":"o4","label":"Third","level":"immediate"}],"href":"https://ci.example.com/run/12"}"#.utf8))
        #expect(n.actions.map(\.offer) == ["o1", "o3"], "an empty title is dropped, at most two")
        #expect(n.href?.host == "ci.example.com")
        #expect(n.actions[0].asOffer.level == .confirm && n.actions[0].asOffer.id == "o1")
        // only plain http(s) as a click target
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@example.com/", "not a url"] {
            let x = try JSONDecoder().decode(PushNotify.self, from: Data(#"{"notifyId":"n","title":"t","href":"\#(bad)"}"#.utf8))
            #expect(x.href == nil, "\(bad)")
        }
        // an older daemon: no buttons, no target — unchanged behavior
        let old = try JSONDecoder().decode(PushNotify.self, from: Data(#"{"notifyId":"n2","title":"t","actions":"x"}"#.utf8))
        #expect(old.actions.isEmpty && old.href == nil)
    }

    @Test func notificationCategoriesPerButtonSet() {
        let a = [NotifyAction(offer: "o1", label: "Retry", level: .confirm)]
        let b = [NotifyAction(offer: "o9", label: "Retry", level: .confirm)]
        let c = [NotifyAction(offer: "o1", label: "Retry", level: .immediate)]
        #expect(NotifyCategory.identifier(for: []) == NotifyCategory.plain)
        #expect(NotifyCategory.identifier(for: a) == NotifyCategory.identifier(for: b), "the same buttons share a category; offer ids live in userInfo")
        #expect(NotifyCategory.identifier(for: a) != NotifyCategory.identifier(for: c))
        #expect(NotifyCategory.identifier(for: a).hasPrefix("agenthub.event.a."))
        let info: [AnyHashable: Any] = ["actions": NotifyCategory.userInfo(a + c)]
        #expect(NotifyCategory.action(id: "agenthub.act.1", userInfo: info) == c[0])
        #expect(NotifyCategory.action(id: "agenthub.act.2", userInfo: info) == nil)
        #expect(NotifyCategory.action(id: "agenthub.open", userInfo: info) == nil)
    }

    // MARK: G8 — plugin keys

    @Test func secretsDecodeAndValueRules() throws {
        let list = try JSONDecoder().decode(SecretsList.self, from: Data(#"{"plugin":"tool","keychain":true,"secrets":[{"key":"tool.token","why":"API token","env":"AGENTHUB_SECRET_TOOL_TOKEN","state":"set","editable":true},{"key":"oauth.x","state":"denied","reason":"reserved","editable":false},{"key":"tool.other","state":"weird","editable":true},{"nokey":1}]}"#.utf8))
        #expect(list.secrets.map(\.key) == ["tool.token", "oauth.x", "tool.other"])
        #expect(list.secrets[0].state == .set && list.secrets[1].state == .denied && list.secrets[2].state == .unknown)
        L10n.shared.lang = .en
        #expect(list.secrets[0].stateText == "set" && list.secrets[1].deniedText == "This key is reserved by the hub.")
        #expect(SecretValue.problem("sk-live_ABC.123~") == nil)
        #expect(SecretValue.problem("") != nil)
        #expect(SecretValue.problem("abc def")?.contains("No spaces") == true)
        #expect(SecretValue.problem("abc\n")?.contains("No spaces") == true)
        for bad in ["a\"b", "a'b", "a\\b", "ключ", "a\u{7f}"] { #expect(SecretValue.problem(bad)?.contains("Printable ASCII") == true, "\(bad)") }
        #expect(SecretValue.problem(String(repeating: "x", count: 3073))?.contains("3072") == true)
        #expect(Explain.text(code: "args:value:chars", status: 400, label: "k").contains("Printable ASCII"))
        L10n.shared.lang = .ru
        #expect(SecretValue.hint.contains("ASCII"))
    }

    @MainActor @Test func secretsLoadWriteRemoveAndRefreshOnEvent() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        let hits = Hits()
        d.replyBody = { method, uri, raw in
            switch (method, uri) {
            case ("GET", "/secrets/tool"):
                let n = hits.next("get")
                return (200, #"{"plugin":"tool","keychain":true,"secrets":[{"key":"tool.token","why":"API","env":"AGENTHUB_SECRET_TOOL_TOKEN","state":"\#(n >= 2 ? "set" : "unset")","editable":true}]}"#)
            case ("PUT", "/secrets/tool/tool.token"):
                return raw.contains(#""value":"sk-1""#) ? (200, #"{"ok":true,"restarted":"restart","secret":{"key":"tool.token","state":"set","editable":true}}"#) : (400, #"{"error":"args:value:chars"}"#)
            case ("DELETE", "/secrets/tool/tool.token"):
                return (200, #"{"ok":true,"restarted":"restart","secret":{"key":"tool.token","state":"unset","editable":true}}"#)
            case ("GET", "/secrets/nope"):
                return (404, #"{"error":"not-found"}"#)
            default: return nil
            }
        }
        d.events = { _, n in
            n == 0 ? snapshotFrame(1, peer: "app") + sseFrame(2, "secrets.changed", #"{"id":2,"type":"secrets.changed","plugin":"tool","key":"tool.token","state":"set"}"#) : ""
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = PromptPresenter()
        store.presenter = p
        await store.loadSecrets("tool")
        #expect(store.secrets["tool"]?.secrets.first?.state == .unset)
        await store.loadSecrets("nope")
        #expect(store.secrets["nope"] == nil, "a refusal: no Keys section")
        #expect(await store.writeSecret(plugin: "tool", key: "tool.token", value: "sk-1"))
        #expect(store.secrets["tool"]?.secrets.first?.state == .set)
        #expect(await store.writeSecret(plugin: "tool", key: "tool.token", value: nil))
        #expect(store.secrets["tool"]?.secrets.first?.state == .unset)
        #expect(!(await store.writeSecret(plugin: "tool", key: "tool.token", value: "bad value")))
        #expect(p.reports.count == 1)
        // secrets.changed re-reads a loaded plugin
        let before = d.requests.filter { $0.uri == "/secrets/tool" && $0.method == "GET" }.count
        store.start()
        defer { store.stop() }
        #expect(await waitFor { d.requests.filter { $0.uri == "/secrets/tool" && $0.method == "GET" }.count > before })
    }

    // MARK: G18 — rendering params

    @Test func chartMaxIsAFixedTop() throws {
        let c = try #require(PluginBarChart(Item(title: "By day", params: ["chart": "bars", "values": "10,50,200", "avg": "150", "max": "100"])))
        #expect(c.scaleMax == 100 && c.fixedMax)
        #expect(c.fraction(50) == 0.5 && c.fraction(200) == 1, "values above max are clipped at the top")
        #expect(!c.averageVisible, "an average above max is not drawn")
        let auto = try #require(PluginBarChart(Item(title: "x", params: ["chart": "bars", "values": "10,50", "avg": "20", "max": "-3"])))
        #expect(auto.scaleMax == 50 && !auto.fixedMax && auto.averageVisible)
        #expect(Item(title: "h", params: ["sparkMax": "100"]).sparkMax == 100)
        #expect(Item(title: "h", params: ["sparkMax": "abc"]).sparkMax == nil)
    }

    @Test func untilAndMonoParams() {
        #expect(Item(title: "h", params: ["until": "2026-11-12T10:00:00.000Z"]).until == Date(timeIntervalSince1970: 1_794_477_600))
        #expect(Item(title: "h", params: ["until": "2026-11-12T13:00:00+03:00"]).until == Date(timeIntervalSince1970: 1_794_477_600))
        #expect(Item(title: "h", params: ["until": "tomorrow"]).until == nil)
        #expect(Item(title: "x", params: ["font": "mono"]).isMono)
        #expect(Item(title: "x", params: ["font": "Menlo"]).isMono == false)
    }

    @MainActor @Test func everyDeclaredConnectionIsListed() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"connections":[{"id":"a","title":"A","plugin":"tool","state":"connected"},{"id":"b","title":"B","plugin":"tool","state":"disconnected"},{"id":"c","title":"C","plugin":"other","state":"connected"}]}"#.utf8))
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: st)
        #expect(store.connectionInfos(forPlugin: "tool").map(\.id) == ["a", "b"])
        #expect(store.connectionInfo(forPlugin: "tool")?.id == "a")
    }
}

// MARK: - non-Claude agent sessions, the subscribe permission

@Suite(.serialized) struct ExternalSessionsAppTests {
    static let state = #"{"seq":1,"primitives":[{"name":"session.focus","level":"immediate"}],"sessions":[],"externalSessions":[{"sessionId":"cx-1","pid":48213,"startSec":1792600000,"kind":"external","agent":"codex","name":"Refactor auth","owner":"agents","updatedAt":0,"terminal":"iterm2","focusable":true,"terminalInfo":{"adapter":"iterm2","label":"iTerm2","capabilities":["focus","launch"],"focusable":true,"via":null}},{"sessionId":"cx-2","agent":null,"name":null,"owner":"agents","focusable":false},{"pid":1}]}"#

    @MainActor @Test func externalSessionsDecodeFocusAndFollowEvent() throws {
        var st = try JSONDecoder().decode(HubState.self, from: Data(Self.state.utf8))
        #expect(st.externalSessions.map(\.sessionId) == ["cx-1", "cx-2"], "a broken entry is skipped")
        #expect(st.waitingSessions == 0 && st.sessions.isEmpty, "not counted with Claude sessions")
        L10n.shared.lang = .en
        #expect(st.externalSessions[1].displayName == "agent · cx-2")
        let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: st)
        let req = try #require(store.focusRequest(external: st.externalSessions[0]))
        #expect(req.primitive == "session.focus" && req.args["sessionId"]?.stringValue == "cx-1")
        #expect(store.focusRequest(external: st.externalSessions[1]) == nil, "not focusable — no button")
        #expect(store.gate(external: st.externalSessions[0]) == nil)
        let ev = try #require(HubEvent.decode(SSEEvent(id: "2", event: "sessions.external", data: #"{"sessions":[{"sessionId":"cx-3","focusable":true}]}"#)))
        let changed = st.apply(ev)
        #expect(changed && st.externalSessions.map(\.sessionId) == ["cx-3"])
        // an older daemon: no field
        #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8)).externalSessions.isEmpty)
        #expect(PluginPermission(kind: "subscribe", what: "agents:run-done").kindLabel == "Event subscription")
        L10n.shared.lang = .ru
        #expect(PluginPermission(kind: "subscribe", what: "agents:run-done").kindLabel == "Подписка на события")
    }
}

// MARK: - hub extensions (G4), terminal adapter texts

@Suite(.serialized) struct ExtensionsAppTests {
    static let info = #"{"dir":"~/Library/Application Support/AgentHub/Extensions","enabled":true,"testAutoApprove":false,"consent":"An extension is code that runs inside the daemon.","pending":1,"items":[{"path":"services/my-sync.mjs","file":"/x/Extensions/services/my-sync.mjs","kind":"service","name":"my-sync","sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","size":812,"mtime":"2026-11-12T10:00:00.000Z","status":"pending","loaded":false,"restartRequired":false,"approvedSha256":null,"autoApproved":false,"error":null,"errorText":null},{"path":"routes/r.mjs","kind":"route","status":"approved","loaded":true,"restartRequired":true},{"kind":"route"}]}"#

    @MainActor @Test func extensionsDecodeApproveAndFollowEvents() async throws {
        let info = try JSONDecoder().decode(ExtensionsInfo.self, from: Data(Self.info.utf8))
        #expect(info.items.map(\.path) == ["services/my-sync.mjs", "routes/r.mjs"] && info.pending == 1)
        #expect(info.items[0].needsApproval && info.items[0].shortSha == "0123456789ab" && !info.items[1].needsApproval && info.items[1].restartRequired)
        L10n.shared.lang = .en
        #expect(info.items[0].kindLabel == "service" && info.items[1].statusText == "approved, running")
        #expect(SidebarStatus.extensionsWaiting(info)?.text == "extensions waiting for approval: 1")
        #expect(SidebarStatus.extensionsWaiting(ExtensionsInfo()) == nil)
        let d = try FakeDaemon()
        defer { d.shutdown() }
        let hits = Hits()
        d.replyBody = { method, uri, raw in
            switch (method, uri) {
            case ("POST", "/extensions/approve"):
                return hits.next("approve") == 1 ? (409, #"{"error":"extensions:changed","sha256":"ff"}"#) : (200, #"{"ok":true,"item":{}}"#)
            case ("GET", "/extensions"): return (200, Self.info)
            case ("POST", "/extensions/revoke"): return (200, #"{"ok":true,"item":{}}"#)
            default: return nil
            }
        }
        d.events = { _, n in
            n == 0 ? snapshotFrame(1, peer: "app") + sseFrame(2, "extensions.changed", #"{"id":2,"type":"extensions.changed","extensions":\#(Self.info)}"#) : ""
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = PromptPresenter()
        store.presenter = p
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.state?.extensions?.items.count == 2 })
        let item = info.items[0]
        #expect(!(await store.approveExtension(item)), "the file changed: refused")
        #expect(p.reports.last?.detail.contains("open the approval again") == true)
        #expect(await store.approveExtension(item))
        let post = try #require(d.requests.last { $0.uri == "/extensions/approve" })
        #expect(post.body.contains(#""sha256":"0123456789abcdef"#) && post.body.contains(#""path":"services\/my-sync.mjs""#) || post.body.contains(#""path":"services/my-sync.mjs""#))
        await store.revokeExtension(info.items[1])
        #expect(d.requests.contains { $0.uri == "/extensions/revoke" && $0.body.contains("r.mjs") })
        #expect(Explain.covers("extensions:changed"))
        L10n.shared.lang = .ru
    }

    @Test func terminalAdapterOwnTexts() throws {
        let ts = try JSONDecoder().decode(TerminalsInfo.self, from: Data(#"{"adapters":[{"id":"wez","label":"WezTerm","capabilities":["focus"],"installed":true,"available":false,"reason":"no-cli","reasonText":"Install the wezterm CLI","needsSetup":true,"messages":{},"source":"extension","sessions":0},{"id":"iterm2","label":"iTerm2","capabilities":["focus"],"available":true,"sessions":1}]}"#.utf8))
        let w = ts.adapters[0]
        #expect(w.isExtension && w.needsSetup && w.reasonText == "Install the wezterm CLI")
        #expect(!ts.adapters[1].isExtension && ts.adapters[1].reasonText == nil)
        L10n.shared.lang = .en
        #expect(TerminalText.status(w, bridgeOnline: false) == "needs setup")
        L10n.shared.lang = .ru
    }
}

// MARK: - several registries (G19), http connections (G7)

@Suite(.serialized) struct RegistriesAppTests {
    @Test func singleRegistryLooksAsBefore() throws {
        let c = try JSONDecoder().decode(RegistryCatalog.self, from: Data(#"{"configured":true,"generatedAt":"2026-11-12T10:00:00Z","plugins":[{"id":"a","version":"1.0.0","tier":"official","registry":"default","registryLabel":null,"tierLabel":"official plugin"}],"registries":[{"name":"default","trust":"official","configured":true,"generatedAt":"2026-11-12T10:00:00Z","plugins":1}]}"#.utf8))
        #expect(!c.multiRegistry && c.plugins[0].registryLabel == nil && c.plugins[0].registry == "default")
        // an older daemon: no registries at all
        let old = try JSONDecoder().decode(RegistryCatalog.self, from: Data(#"{"configured":true,"plugins":[{"id":"a","version":"1"}]}"#.utf8))
        #expect(old.registries.isEmpty && old.plugins[0].registryLabel == nil && !old.plugins[0].capped)
    }

    @Test func severalRegistriesCarryLabelsAndStatus() throws {
        let c = try JSONDecoder().decode(RegistryCatalog.self, from: Data(#"{"configured":true,"generatedAt":"2026-11-12T10:00:00Z","plugins":[{"id":"b","version":"1.0.0","tier":"community","registry":"corp","registryLabel":"corp","tierLabel":"community plugin · corp","capped":true}],"registries":[{"name":"default","trust":"official","configured":true,"fetchedAt":"2026-11-12T10:00:00Z","plugins":3},{"name":"corp","trust":"community","configured":true,"error":"registry:signature"},{"bad":1}],"shadowed":[{"id":"x","registry":"corp","by":"default"}]}"#.utf8))
        #expect(c.multiRegistry && c.registries.map(\.name) == ["default", "corp"])
        #expect(c.plugins[0].registryLabel == "corp" && c.plugins[0].capped && c.shadowed.first?.by == "default")
        L10n.shared.lang = .en
        #expect(c.registries[1].statusLine == "corp: error — registry:signature")
        #expect(c.registries[0].statusLine.hasPrefix("default: fetched") && c.registries[0].statusLine.hasSuffix("3 plugins"))
        let consent = try JSONDecoder().decode(ConsentRequest.self, from: Data(#"{"token":"t","id":"b","tier":"community","registry":"corp","registryLabel":"corp"}"#.utf8))
        #expect(consent.registryLabel == "corp" && RegistryText.from("corp") == "from the \"corp\" registry")
        let st = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"b","registry":"corp","registryLabel":""}"#.utf8))
        #expect(st.registry == "corp" && st.registryLabel == nil, "an empty label is no label")
        L10n.shared.lang = .ru
    }

    @Test func httpConnectionLineAndPortBusy() throws {
        let c = try JSONDecoder().decode(ConnectionInfo.self, from: Data(#"{"id":"api","title":"Example","plugin":"tool","state":"disconnected","type":"http","apiHosts":["api.example.com"],"methods":["GET","POST"],"paths":["/v1/"],"tools":[]}"#.utf8))
        L10n.shared.lang = .en
        #expect(c.isHTTP && ConnectionsText.toolsLine(c) == "Only requests to api.example.com (GET, POST) under /v1/")
        #expect(ConnectionsText.error("oauth:port-busy", title: "Example")?.contains("port") == true)
        let mcp = try JSONDecoder().decode(ConnectionInfo.self, from: Data(#"{"id":"m","title":"M","state":"connected","tools":["get_user"]}"#.utf8))
        #expect(!mcp.isHTTP && ConnectionsText.toolsLine(mcp) == "Only the get_user tool")
        L10n.shared.lang = .ru
    }
}
