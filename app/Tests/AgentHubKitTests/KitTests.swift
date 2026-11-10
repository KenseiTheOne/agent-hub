import Foundation
import Testing
@testable import AgentHubKit

// Synthetic data shaped per docs/api.md — no real sessionId values or paths.

let stateJSON = #"""
{
  "version": "0.1.0", "now": "2026-11-04T13:00:00.000Z", "pid": 123, "seq": 57,
  "estop": false, "status": "wait", "waitingSessions": 1,
  "severity": {"ok":0,"unknown":1,"wait":2,"block":3,"error":4},
  "plugins": [
    {"id":"quota","source":"builtin","trusted":true,"file":"/x/quota.5m.mjs","type":"standard","title":"Quota",
     "version":"1.0.0","interval":"5m","schedule":null,"effects":["open.url"],
     "actions":[{"id":"check","level":"confirm","title":null}],
     "status":"ok","error":null,"lastRunAt":"2026-11-04T12:59:59.000Z","durationMs":31,"pid":null,"events":["week-80"],
     "header":[{"title":"Квота 42%","level":0,"status":"ok","params":{"sfimage":"gauge"}}],
     "body":[
       {"title":"Неделя","level":0,"params":{}},
       {"title":"42% из 100%","level":1,"params":{"color":"#ff8800"}},
       {"title":"","level":0,"separator":true,"params":{}},
       {"title":"Открыть","level":0,"params":{},"offer":{"id":"abc","kind":"effect","primitive":"open.url","action":null,"level":"immediate","label":"Открыть https://example.com"}}
     ]},
    {"id":"sessions","source":"local","trusted":false,"type":"streamable","title":"Сессии","status":"wait",
     "header":[{"title":"1 ждёт","level":0,"status":"wait","params":{}}],
     "body":[{"title":"demo","level":0,"params":{"pid":"4242","n":5},"session":{"id":"s-1","pid":4242,"verified":false,"label":"не Claude Code"}}],
     "newFieldFromFutureDaemon": {"x": 1}}
  ],
  "sessions": [{"sessionId":"s-2","pid":2220,"startSec":1792600000,"status":"waiting","waitingFor":"permission prompt",
                "name":"demo","surfaceId":"sf","workspaceId":"ws","sources":["plugin:sessions"],"interactive":false,"updatedAt":0}],
  "primitives": [{"name":"open.url","level":"immediate","remoteAllowed":false,"appOnly":false}],
  "peer": {"class":"cli","reason":"peer:app-signature"}
}
"""#

@Test func decodesState() throws {
    let s = try JSONDecoder().decode(HubState.self, from: Data(stateJSON.utf8))
    #expect(s.seq == 57)
    #expect(s.status == .wait)
    #expect(s.waitingSessions == 1)
    #expect(s.plugins.count == 2)
    #expect(s.plugins[0].headline == "Квота 42%")
    #expect(s.plugins[0].body[3].offer?.id == "abc")
    #expect(s.plugins[0].actions.first?.level == .confirm)
    #expect(s.plugins[1].body[0].params["n"] == "5")
    #expect(s.plugins[1].body[0].session?.verified == false)
    #expect(s.peer == PeerInfo(class: "cli", reason: "peer:app-signature"))
    #expect(s.pluginsByAttention.map(\.id) == ["sessions", "quota"])
}

@Test func unknownStatusIsUnknown() throws {
    let s = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"x","status":"weird"}"#.utf8))
    #expect(s.status == .unknown)
    #expect(s.title == "x")
}

@Test func worstStatusOrder() {
    #expect(HubStatus.worst([.ok, .unknown, .wait]) == .wait)
    #expect(HubStatus.worst([.block, .error, .ok]) == .error)
    #expect(HubStatus.worst([]) == .ok)
}

@Test func sseParserSplitsChunksAndUTF8() {
    var p = SSEParser()
    let text = "id: 5\nevent: estop\ndata: {\"on\":true,\"t\":\"ё\"}\n\n: ping\n\nid: 6\r\nevent: plugin.removed\r\ndata: {\"plugin\":\"a\"}\r\n\r\n"
    let bytes = Array(text.utf8)
    var events: [SSEEvent] = []
    // cut in the middle of a multibyte "ё"
    let cut = bytes.firstIndex(of: 0xD1)! + 1
    events += p.push(bytes[..<cut])
    events += p.push(bytes[cut...])
    #expect(events.count == 2)
    #expect(events[0] == SSEEvent(id: "5", event: "estop", data: "{\"on\":true,\"t\":\"ё\"}"))
    #expect(events[1].event == "plugin.removed")
    #expect(p.lastEventId == "6")
    #expect(p.comments == 1)
}

@Test func sseMultilineData() {
    var p = SSEParser()
    let ev = p.push(Array("data: a\ndata: b\n\n".utf8))
    #expect(ev == [SSEEvent(id: nil, event: "message", data: "a\nb")])
}

@Test func applyEvents() throws {
    var s = try JSONDecoder().decode(HubState.self, from: Data(stateJSON.utf8))
    let pluginEv = SSEEvent(id: "58", event: "plugin",
                            data: #"{"id":58,"type":"plugin","plugin":{"id":"quota","status":"error","title":"Quota"},"status":"error"}"#)
    s.apply(try #require(HubEvent.decode(pluginEv)))
    #expect(s.status == .error)
    #expect(s.plugins.first { $0.id == "quota" }?.status == .error)

    s.apply(try #require(HubEvent.decode(SSEEvent(id: "59", event: "plugin.removed", data: #"{"plugin":"quota"}"#))))
    #expect(s.plugins.map(\.id) == ["sessions"])
    #expect(s.status == .wait)

    s.apply(try #require(HubEvent.decode(SSEEvent(id: "60", event: "sessions", data: #"{"sessions":[]}"#))))
    #expect(s.waitingSessions == 0)

    s.apply(try #require(HubEvent.decode(SSEEvent(id: "61", event: "estop", data: #"{"on":true}"#))))
    #expect(s.estop)

    #expect(HubEvent.decode(SSEEvent(id: "62", event: "plugin", data: "не json")) == nil)
    if case .other(let t, _)? = HubEvent.decode(SSEEvent(id: "63", event: "push.sent", data: #"{"k":1}"#)) {
        #expect(t == "push.sent")
    } else {
        Issue.record("expected .other")
    }
}

@Test func itemTreeNestsAndSplitsBlocks() throws {
    let items = [
        Item(title: "A"), Item(title: "a1", level: 1), Item(title: "a11", level: 2), Item(title: "a2", level: 1),
        Item(title: "", separator: true),
        Item(title: "B"), Item(title: "b-gap", level: 3), Item(title: "C"),
    ]
    let tree = ItemTree.build(items)
    #expect(tree.map(\.item.title) == ["A", "", "B", "C"])
    #expect(tree[0].children.map(\.item.title) == ["a1", "a2"])
    #expect(tree[0].children[0].children.map(\.item.title) == ["a11"])
    #expect(tree[2].children.map(\.item.title) == ["b-gap"])
    let blocks = ItemTree.blocks(items)
    #expect(blocks.count == 2)
    #expect(blocks[1].map(\.item.title) == ["B", "C"])
}

@Test func socketPathResolution() {
    #expect(HubPaths.socketPath(arguments: ["x", "--home", "/tmp/h"], environment: ["AGENTHUB_HOME": "/tmp/e"]) == "/tmp/h/hub.sock")
    #expect(HubPaths.socketPath(arguments: ["x"], environment: ["AGENTHUB_HOME": "/tmp/e"]) == "/tmp/e/hub.sock")
    #expect(HubPaths.socketPath(arguments: ["x"], environment: [:]).hasSuffix("/Library/Application Support/AgentHub/hub.sock"))
    #expect(HubPaths.checkSocket("/nonexistent/hub.sock") != nil)
}

@Test func journalEntrySummary() throws {
    let r = try JSONDecoder().decode(JournalResponse.self, from: Data(#"{"entries":[{"ts":"t","type":"action-denied","peer":"cli","error":"peer:cli","pid":7}]}"#.utf8))
    #expect(r.entries.first?.type == "action-denied")
    #expect(r.entries.first?.summary == "error=peer:cli peer=cli pid=7")
}

@MainActor
@Test func storeHandlesSnapshotThenEvents() throws {
    let store = HubStore(client: HubClient(socketPath: "/nonexistent/hub.sock"))
    #expect(store.worstStatus == .unknown)
    let snap = "{\"id\":57,\"type\":\"snapshot\",\"state\":\(stateJSON)}"
    store.handle(SSEEvent(id: "57", event: "snapshot", data: snap))
    #expect(store.connection == .live)
    #expect(store.worstStatus == .wait)
    #expect(store.waitingCount == 1)
    #expect(store.activeEvents.contains("quota:week-80"))
    store.handle(SSEEvent(id: "58", event: "event.raised", data: #"{"plugin":"x","key":"x:y"}"#))
    #expect(store.activeEvents.contains("x:y"))
    store.handle(SSEEvent(id: "59", event: "event.cleared", data: #"{"plugin":"x","key":"x:y"}"#))
    #expect(!store.activeEvents.contains("x:y"))
    #expect(store.state?.seq == 59)
}

// MARK: - cards, launch, manager, notifications (synthetic data shaped per docs/hook.md and docs/plugins-registry.md)

let cardsJSON = #"""
{"cards":[
  {"requestId":"0123456789abcdef0123456789abcdef","sessionId":"s-1","sessionName":"demo","surfaceId":null,"claudePid":1,
   "subagent":false,"kind":"permission","tool":"Bash","summary":"Bash: git","questions":null,"decisions":["once","deny"],
   "createdAt":"2026-11-04T13:00:00.000Z","expiresAt":"2026-11-04T13:01:50.000Z","futureField":1},
  {"requestId":"fedcba9876543210fedcba9876543210","sessionId":"s-2","kind":"question","tool":"AskUserQuestion","summary":"AskUserQuestion",
   "questions":[{"question":"Какой?","header":"Выбор","multiSelect":false,"options":[{"label":"A","description":null},{"label":"B"}]},
                {"question":"Что ещё?","multiSelect":true,"options":[{"label":"x"},{"label":"y"},{"label":"z"}]}],
   "decisions":["answer","deny"]}
 ],"paused":false,"estop":false}
"""#

@Test func decodesHookCards() throws {
    let r = try JSONDecoder().decode(HookCardsResponse.self, from: Data(cardsJSON.utf8))
    #expect(r.cards.count == 2)
    #expect(r.cards[0].kind == .permission)
    #expect(r.cards[0].summary == "Bash: git")
    #expect(r.cards[0].questions.isEmpty)
    #expect(r.cards[0].expiresDate != nil)
    #expect(r.cards[1].questions[1].multiSelect)
    #expect(r.cards[1].questions[0].options[1].description == nil)
}

@Test func respondArgsAreNarrow() throws {
    let r = try JSONDecoder().decode(HookCardsResponse.self, from: Data(cardsJSON.utf8))
    let q = r.cards[1]
    #expect(RespondChoice.allowOnce.args(requestId: "r") == ["requestId": .string("r"), "decision": .string("once")])
    #expect(RespondChoice.deny.args(requestId: "r")["decision"] == .string("deny"))
    let answers: [QuestionAnswer] = [.options([1]), .other("свой")]
    #expect(q.isComplete(answers))
    let a = RespondChoice.answer(answers).args(requestId: "r")
    #expect(a["decision"] == .string("answer"))
    let parsed = try JSONDecoder().decode(JSONValue.self, from: Data(try #require(a["answers"]?.stringValue).utf8))
    #expect(parsed == .array([.array([.number(1)]), .string("свой")]))
    // without multiSelect — exactly one option; an empty answer and "Other" made of spaces are not allowed
    #expect(!q.isComplete([.options([0, 1]), .options([0])]))
    #expect(!q.isComplete([.options([]), .options([0])]))
    #expect(!q.isComplete([.options([0]), .other("   ")]))
    #expect(!q.isComplete([.options([5]), .options([0])]))
    #expect(q.isComplete([.options([0]), .options([0, 2])]))
    #expect(!r.cards[0].isComplete([]))
    // the arguments contain nothing but requestId/decision/answers
    #expect(Set(a.keys) == ["requestId", "decision", "answers"])
}

@Test func launchDraftValidation() {
    var d = LaunchDraft()
    #expect(!d.isValid)
    d.folder = "~/Projects"
    d.name = "Game - Level editor (1)"
    #expect(d.isValid)
    #expect(d.args["cwd"]?.stringValue?.hasPrefix("/") == true)
    #expect(LaunchDraft.nameProblem("a; rm -rf /") != nil)
    #expect(LaunchDraft.nameProblem("Game — Level") != nil, "the daemon will not accept an em dash")
    #expect(LaunchDraft.nameProblem("-x") != nil)
    #expect(LaunchDraft.nameProblem(String(repeating: "a", count: 65)) != nil)
    d.folder = "relative/path"
    #expect(!d.isValid)
}

@Test func decodesRegistry() throws {
    let cat = try JSONDecoder().decode(RegistryCatalog.self, from: Data(#"""
    {"configured":true,"generatedAt":"2026-11-04T00:00:00Z","fetchedAt":null,"error":null,"plugins":[
      {"id":"demo","version":"1.2.0","title":"Demo","desc":"d","author":{"github":"someone"},"official":false,"label":null,
       "permissions":[{"kind":"net","what":"api.example.com","why":"статусы"},{"kind":"effects","what":"open.url"}],
       "installed":"1.1.0","updateAvailable":true,"growth":[{"kind":"net","what":"api.example.com","why":"статусы"}],
       "blocked":null,"builtin":false,"platformOk":true}]}
    """#.utf8))
    #expect(cat.configured)
    #expect(cat.plugins[0].author == PluginAuthor(github: "someone"))
    #expect(cat.plugins[0].newerVersion == "1.2.0")
    #expect(cat.plugins[0].updateGrows)
    #expect(cat.plugins[0].updateAvailable)
    #expect(cat.plugins[0].growth?.count == 1)
    #expect(cat.plugins[0].permissions[1].why == nil)
    let consent = try JSONDecoder().decode(ConsentRequest.self, from: Data(#"""
    {"error":"consent-required","needsConsent":true,"token":"t","expiresInMs":120000,"id":"demo","title":"Demo","version":"1.2.0",
     "fromVersion":"1.1.0","update":true,"sha256":"x","permissions":[{"kind":"net","what":"a","why":"b","added":true},{"kind":"effects","what":"open.url"}],
     "added":[{"kind":"net","what":"a"}]}
    """#.utf8))
    #expect(consent.update && consent.addedCount == 1)
    let inst = try JSONDecoder().decode(RegistryInstalled.self, from: Data(#"{"installed":[{"id":"demo","version":"1.1.0","official":true,"disabled":null,"permissions":[]}],"local":[{"id":"dev","source":"local","label":"непроверенный","blocked":null,"permissions":[]}]}"#.utf8))
    #expect(inst.installed[0].official)
    #expect(inst.local[0].label == "непроверенный")
}

@Test func tierFromDaemonNotFromMetadata() throws {
    // tier present — taken as is; absent (old daemon) — derived from source and official
    let inst = try JSONDecoder().decode(RegistryInstalled.self, from: Data(#"""
    {"installed":[{"id":"my-runner","version":"0.2.0","tier":"official","official":true,"removable":true,"permissions":[]},
                  {"id":"demo","version":"1.0.0","official":false,"permissions":[]}],
     "local":[{"id":"dev","source":"local","tier":"local","label":"непроверенный","permissions":[]}]}
    """#.utf8))
    #expect(inst.installed[0].tier == .official && inst.installed[0].tier.removable)
    #expect(inst.installed[1].tier == .community && inst.installed[1].tier.removable)
    #expect(inst.local[0].tier == .local && !inst.local[0].tier.removable)
    let st = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"quota","source":"builtin","tier":"builtin","trusted":true,"title":"Квота","status":"ok"}"#.utf8))
    #expect(st.tier == .builtin && !st.tier.removable)
    let old = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"hermes","source":"installed","official":true,"trusted":true,"title":"Hermes","status":"ok"}"#.utf8))
    #expect(old.tier == .official)
    let cat = try JSONDecoder().decode(CatalogPlugin.self, from: Data(#"{"id":"hermes","version":"1.1.0","tier":"official","official":true}"#.utf8))
    #expect(cat.tier == .official)
}

@MainActor
@Test func storeRoutesNotifyAndCardEvents() throws {
    let store = HubStore(client: HubClient(socketPath: "/nonexistent/hub.sock"))
    let snap = "{\"id\":57,\"type\":\"snapshot\",\"state\":\(stateJSON)}"
    store.handle(SSEEvent(id: "57", event: "snapshot", data: snap))
    var got: [PushNotify] = []
    store.onNotify = { got.append($0) }
    store.handle(SSEEvent(id: "58", event: "push.notify", data: #"{"notifyId":"n-12345678","title":"Прогоны не запустятся","subtitle":"my-runner","body":"Unity","plugin":"my-runner","key":"my-runner:run-blocker","digest":false}"#))
    #expect(got.map(\.notifyId) == ["n-12345678"])
    #expect(got.first?.plugin == "my-runner")
    if case .hookCardRemoved(let id, let why)? = HubEvent.decode(SSEEvent(id: "59", event: "hook.card.removed", data: #"{"requestId":"abc","sessionId":"s","reason":"answered-elsewhere"}"#)) {
        #expect(id == "abc" && why == "answered-elsewhere")
    } else {
        Issue.record("expected hookCardRemoved")
    }
    store.showDemoCards([HookCard(requestId: "demo1", sessionId: "s", kind: .permission, tool: "Bash")])
    #expect(store.visibleCards.count == 1)
}

@Test func hookPausedEventDecodes() throws {
    let ev = SSEEvent(id: "70", event: "hook.paused", data: #"{"until":"2026-11-04T12:00:00.000Z","limit":10}"#)
    if case .hookPaused(let until)? = HubEvent.decode(ev) {
        #expect(until == "2026-11-04T12:00:00.000Z")
    } else {
        Issue.record("expected hookPaused")
    }
}

// MARK: - pinning the build (appPin, app-pin.changed event)

@Test func appPinDecodesAndApplies() throws {
    let json = #"{"seq":1,"estop":false,"status":"ok","plugins":[],"sessions":[],"appPin":{"kind":"cdhash","fingerprint":"cdhash:1347dd31e6cd68e8bc2f1d14281796fcecc09afd","changedAt":"2026-11-05T10:00:00.000Z","by":"agenthub pin-app","under":"terminal","source":"check","generation":2}}"#
    var st = try JSONDecoder().decode(HubState.self, from: Data(json.utf8))
    let pin = try #require(st.appPin)
    #expect(pin.kind == "cdhash")
    #expect(pin.shortFingerprint == "cdhash 1347dd31e6cd…")
    #expect(pin.changedDate != nil)
    #expect(pin.isRecent(now: pin.changedDate!.addingTimeInterval(3600)))
    #expect(!pin.isRecent(now: pin.changedDate!.addingTimeInterval(3 * 24 * 3600)))
    // daemon older than 2026-11-05 — no old: not the first pin
    #expect(pin.old == nil && !pin.isFirstPin)
    // old from the daemon: none — first pin, a fingerprint — re-pin
    let first = try JSONDecoder().decode(AppPinInfo.self, from: Data(#"{"kind":"cdhash","fingerprint":"cdhash:aa","old":"none"}"#.utf8))
    #expect(first.isFirstPin)
    let again = try JSONDecoder().decode(AppPinInfo.self, from: Data(#"{"kind":"cdhash","fingerprint":"cdhash:bb","old":"cdhash:aa"}"#.utf8))
    #expect(!again.isFirstPin)
    // old daemon without appPin — nil, not an error
    #expect(try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"plugins":[]}"#.utf8)).appPin == nil)
    let ev = HubEvent.decode(SSEEvent(id: "2", event: "app-pin.changed",
        data: #"{"type":"app-pin.changed","old":"cdhash:aa","appPin":{"kind":"cdhash","fingerprint":"cdhash:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","changedAt":"2026-11-05T11:00:00.000Z","by":"неизвестно"}}"#))
    guard case .appPinChanged(let p)? = ev else { Issue.record("not app-pin.changed"); return }
    let changed = st.apply(.appPinChanged(p))
    #expect(changed)
    #expect(st.appPin?.fingerprint.hasPrefix("cdhash:bbbb") == true)
    #expect(st.appPin?.by == "неизвестно")
}

// MARK: - language and texts (UI pass 2026-11-05). Serialized: the language is a process-wide setting.

@Suite(.serialized) struct TextTests {
    @Test func explainCodes() {
        L10n.shared.lang = .ru
        #expect(HubStore.explain(code: "peer:app-signature", status: 403, label: "X").contains("не закреплена"))
        // since 2026-11-06 bundle.sh does not pin by default — the advice "rebuild (scripts/bundle.sh)" does not help
        PinAdvice.shared.update(pinPath: nil, installed: true)
        #expect(HubStore.explain(code: "peer:app-requirement-missing", status: 403, label: "X").contains("bash install.sh"))
        #expect(!HubStore.explain(code: "peer:app-signature", status: 403, label: "X").contains("(scripts/bundle.sh)"))
        #expect(!HubStore.explain(code: "facts:something-new", status: 409, label: "X").contains("facts:"), "the raw code is only at the second level")
        // the shell does not know codes of specific plugins — only generic core codes (contract 2)
        #expect(!Explain.covers("facts:runner-patch-required") && !Explain.covers("facts:run-lock"))
        #expect(HubStore.explain(code: "registry:hub-too-old", status: 409, label: "X").contains("нужен хаб новее"))
        #expect(HubStore.explain(code: "facts:bridge-offline", status: 409, label: "X").contains("Мост cmux"))
        #expect(HubStore.explain(code: "facts:action-changed", status: 409, label: "X").contains("обновил вывод"))
        #expect(HubStore.explain(code: "estop", status: 423, label: "X").contains("Хаб на паузе"))
        #expect(!HubStore.explain(code: "registry:not-found", status: 0, label: "X").contains("HTTP 0"))
    }

    @Test func everyDaemonCodeHasText() {
        for code in Explain.knownCodes { #expect(Explain.covers(code), "no text for \(code)") }
    }

    @Test func explainsPluginRefusal() {
        L10n.shared.lang = .ru
        // contract 2: the plugin writes the refusal explanation itself (message= in the hub language) — shown as is
        let r: JSONValue = .object(["ok": .bool(false), "code": .number(3), "reason": .string("not-running"), "message": .string("Прогон сейчас не идёт")])
        #expect(HubStore.explainFailure(result: r, label: "Остановить") == "«Остановить»: Прогон сейчас не идёт")
        // without message — the plugin's code as is, the shell has no texts of its own for plugin codes
        #expect(HubStore.explainFailure(result: .object(["reason": .string("not-running")]), label: "X") == "«X»: плагин отказал (not-running).")
        #expect(HubStore.explainFailure(result: .object(["reason": .string("zzz"), "message": .string("  ")]), label: "X").contains("плагин отказал (zzz)"))
        L10n.shared.lang = .en
        #expect(HubStore.explainFailure(result: .object(["message": .string("The run isn't going")]), label: "Stop") == "\"Stop\": The run isn't going")
        L10n.shared.lang = .ru
        #expect(HubStore.explainFailure(result: .object(["code": .number(2)]), label: "X").contains("код 2"))
    }

    @Test func switchesLanguageWithoutRestart() throws {
        L10n.shared.apply(setting: "en", effective: "en")
        #expect(L10n.shared.setting == .en && L10n.shared.lang == .en)
        #expect(HubStatus.wait.label == "Needs attention")
        #expect(PluginTier.builtin.label == "built-in")
        #expect(HubStore.explain(code: "estop", status: 423, label: "X").contains("Resume"))
        let st = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"quota","title":"Quota","status":"wait","statusLabels":{"wait":{"label":"Running low","hint":"h"}},"header":[{"title":"x","params":{"tile":"62%"}}]}"#.utf8))
        #expect(st.statusLabel() == "Running low" && st.statusHint() == "h")
        #expect(st.statusLabel(.ok) == "All good", "without its own label — the shared table")
        #expect(st.tileValue == "62%")
        L10n.shared.apply(setting: "system", effective: "ru")
        #expect(HubStatus.wait.label == "Нужно внимание")
        #expect(plural(5, ru: ("сессия", "сессии", "сессий"), en: ("session", "sessions")) == "сессий")
    }

    @Test func langFromSnapshotAndEvent() throws {
        let st = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"plugins":[],"lang":{"setting":"ru","effective":"ru","system":"en"}}"#.utf8))
        #expect(st.lang?.setting == "ru" && st.lang?.system == "en")
    }

    @Test func pinNoteTexts() throws {
        L10n.shared.lang = .ru
        let pin = AppPinInfo(kind: "cdhash", fingerprint: "cdhash:1347dd31e6cd68e8", changedAt: "2026-11-05T10:57:00.000Z", by: "agenthub pin-app", under: "claude-code")
        #expect(pin.originText == "из сессии Claude Code")
        #expect(pin.ackKey == "cdhash:1347dd31e6cd68e8|2026-11-05T10:57:00.000Z")
        #expect(AppPinInfo(kind: "cdhash", fingerprint: "x", by: "manual").originText == "config.json изменён вручную")
        L10n.shared.lang = .en
        #expect(pin.originText == "from a Claude Code session")
        L10n.shared.lang = .ru
    }

    @Test func journalLabels() {
        L10n.shared.lang = .ru
        let e = JournalEntry(index: 0, raw: ["type": .string("estop-set"), "on": .bool(true), "peer": .string("cli")])
        #expect(e.typeLabel == "Пауза хаба включена (кем: терминал)")
        #expect(e.isAction)
        let d = JournalEntry(index: 1, raw: ["type": .string("action-denied"), "action": .string("session.stop"), "error": .string("peer:cli")])
        #expect(d.result?.ok == false && d.result?.text == "peer:cli")
    }

    @Test func consentNewOnlyOnUpdate() throws {
        let first = try JSONDecoder().decode(ConsentRequest.self, from: Data(#"{"token":"t","id":"x","update":false,"permissions":[{"kind":"net","what":"a","added":true}]}"#.utf8))
        #expect(first.addedCount == 0, "on first install there are no \"new\" permissions")
    }
}

@Test func splitHeadlineKeepsQuotedColons() {
    #expect(PluginState.splitHeadline("Прогоны не запустятся: Unity открыт")! == ("Прогоны не запустятся", "Unity открыт"))
    #expect(PluginState.splitHeadline("Задача «demo: утренний итог» упала") == nil)
    #expect(PluginState.splitHeadline("Прогон «a: b» упал: код 1")! == ("Прогон «a: b» упал", "код 1"))
    #expect(PluginState.splitHeadline("Job \"x: y\" failed") == nil)
    #expect(PluginState.splitHeadline("12:30 старт") == nil)
}

@Test func blockSegmentsGroupStatsGaugesStrips() {
    let items = [
        Item(title: "04:30", params: ["stat": "Следующий запуск"]), Item(title: "3", params: ["stat": "План"]),
        Item(title: "5-часовое окно", params: ["gauge": "31"]), Item(title: "спокойно", level: 1),
        Item(title: "Последние прогоны", params: ["strip": "true"]), Item(title: "03.11", level: 1),
        Item(title: "Что мешает"), Item(title: "мак не на зарядке", level: 1),
    ]
    let segs = ItemTree.segments(ItemTree.build(items))
    #expect(segs.count == 4)
    if case .stats(let s) = segs[0] { #expect(s.map(\.item.title) == ["04:30", "3"]) } else { Issue.record("stats") }
    if case .gauges(let g) = segs[1] { #expect(g[0].item.gauge == 31 && g[0].children.count == 1) } else { Issue.record("gauges") }
    if case .strip(let n) = segs[2] { #expect(n.children.map(\.item.title) == ["03.11"]) } else { Issue.record("strip") }
    if case .list(let l) = segs[3] { #expect(l.map(\.item.title) == ["Что мешает"]) } else { Issue.record("list") }
    #expect(Item(title: "x", params: ["gauge": "140"]).gauge == 100)
    #expect(Item(title: "x", params: ["details": "true"]).isDetails)
}

@Test func consentOrderPutsWeightiestAndNewFirst() {
    let list = [
        PluginPermission(kind: "fsRead", what: "a"), PluginPermission(kind: "fsRead", what: "b"),
        PluginPermission(kind: "exec", what: "c"), PluginPermission(kind: "actions", what: "stop"),
        PluginPermission(kind: "watch", what: "d", added: true),
    ]
    #expect(PluginPermission.byWeight(list, addedFirst: false).map(\.what) == ["stop", "c", "d", "a", "b"])
    #expect(PluginPermission.byWeight(list, addedFirst: true).map(\.what) == ["d", "stop", "c", "a", "b"])
    L10n.shared.lang = .ru
    // the number goes before the kind and is inflected; a single kind is not repeated (parallel suites change the language — compare against both)
    let all = PluginPermission.summary(list)
    #expect(all == "5 прав: 1 своя кнопка · 1 запуск программ · 1 слежение · 2 чтения файлов" || all == "5 permissions: 1 own button · 1 program run · 1 watch · 2 file reads")
    let one = PluginPermission.summary(Array(list.prefix(2)))
    #expect(one == "2 права: чтение файлов" || one == "2 permissions: reads files")
    let four = PluginPermission.counted("exec", 4)
    #expect(four == "4 запуска программ" || four == "4 program runs")
    let five = PluginPermission.counted("actions", 5)
    #expect(five == "5 своих кнопок" || five == "5 own buttons")
}

@Test func registryConnectCommandUsesFullCliPathAndHome() throws {
    let custom = try JSONDecoder().decode(RegistryCatalog.self, from: Data(#"{"configured":false,"missing":["index-url","public-key"],"plugins":[],"connect":{"cli":"/Users/u/My Projects/agent-hub/daemon/bin/agenthub","home":"/tmp/ahr","defaultHome":false}}"#.utf8))
    #expect(custom.connectCommand(url: "U", key: "K") == "AGENTHUB_HOME=/tmp/ahr '/Users/u/My Projects/agent-hub/daemon/bin/agenthub' install --registry-url U --registry-pubkey K --apply --no-launchd")
    let std = try JSONDecoder().decode(RegistryCatalog.self, from: Data(#"{"configured":false,"plugins":[],"connect":{"cli":"/x/bin/agenthub","home":"/h","defaultHome":true}}"#.utf8))
    #expect(std.connectCommand(url: "U", key: "K").hasPrefix("/x/bin/agenthub install"))
}

@Test func menuBarLookByState() {
    #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: false) == .calm)
    #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: false).isTemplate)
    #expect(MenuBarLook.make(status: .ok, waiting: 3, live: true, estop: false) == .waiting(3))
    // status=wait of a plugin without waiting sessions and cards does not color the icon (decision 2026-11-07)
    #expect(MenuBarLook.make(status: .wait, waiting: 0, live: true, estop: false) == .calm)
    #expect(MenuBarLook.make(status: .wait, waiting: 1, live: true, estop: false) == .waiting(1))
    #expect(MenuBarLook.waiting(0).count == nil)
    #expect(MenuBarLook.waiting(3).count == 3)
    #expect(MenuBarLook.waiting(3).emblem == .orange)
    // worst status block/error — red emblem, the waiting count next to it stays
    #expect(MenuBarLook.make(status: .block, waiting: 2, live: true, estop: false) == .blocked(2))
    #expect(MenuBarLook.make(status: .error, waiting: 0, live: true, estop: false).emblem == .red)
    // pause: a "‖" sign next to it and a grey emblem; a blocker is not hidden while paused — red emblem; no connection outranks everything
    #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: true) == .paused(0, blocker: false))
    #expect(MenuBarLook.paused(0, blocker: false).emblem == .gray)
    #expect(MenuBarLook.paused(0, blocker: false).pauseMark && !MenuBarLook.calm.pauseMark && !MenuBarLook.blocked(1).pauseMark)
    #expect(!MenuBarLook.paused(0, blocker: false).isTemplate)
    #expect(MenuBarLook.make(status: .block, waiting: 1, live: true, estop: true) == .paused(1, blocker: true))
    #expect(MenuBarLook.make(status: .error, waiting: 0, live: true, estop: true).emblem == .red)
    #expect(MenuBarLook.paused(1, blocker: true).count == 1)
    #expect(MenuBarLook.make(status: .block, waiting: 5, live: false, estop: true) == .offline)
    #expect(MenuBarLook.offline.count == nil && MenuBarLook.offline.emblem == nil && MenuBarLook.offline.glyphAlpha < 1)
}

@Test func menuBarTextAndTooltip() {
    // the language is shared (L10n.shared), and TextTests switch it in parallel — check both variants
    let test = MenuBarLook.calm.labelText(test: true)
    #expect(test == "ТЕСТ" || test == "TEST")
    #expect(MenuBarLook.calm.labelText(test: false) == nil)
    #expect(MenuBarLook.waiting(2).labelText(test: false) == "2")
    let t2 = MenuBarLook.waiting(2).labelText(test: true)
    #expect(t2 == "ТЕСТ 2" || t2 == "TEST 2")
    // the tooltip while paused with a blocker names the blocker, not just "hub paused"
    let tip = MenuBarLook.paused(0, blocker: true).tooltip(status: .block, waiting: 0, testMark: nil)
    #expect(tip.contains(HubStatus.block.label))
    #expect(tip.contains("паузе") || tip.contains("paused"))
    let calmPause = MenuBarLook.paused(0, blocker: false).tooltip(status: .ok, waiting: 0, testMark: nil)
    #expect(!calmPause.contains(HubStatus.block.label))
    let withTest = MenuBarLook.calm.tooltip(status: .ok, waiting: 1, testMark: "ТЕСТ · /tmp/ahl")
    #expect(withTest.hasSuffix("\nТЕСТ · /tmp/ahl"))
}

@Test func testMarkForCustomHome() {
    let def = "/Users/u/Library/Application Support/AgentHub"
    #expect(TestMark.label(home: def, defaultHome: def, daemonTestMode: false) == nil)
    #expect(TestMark.label(home: def + "/", defaultHome: def, daemonTestMode: nil) == nil)
    let t = TestMark.label(home: "/tmp/ahl", defaultHome: def, daemonTestMode: nil)
    #expect(t?.hasSuffix(" · /tmp/ahl") == true)
    // the language is shared (L10n.shared), and TextTests switch it in parallel — check both variants
    #expect(t?.hasPrefix("ТЕСТ") == true || t?.hasPrefix("TEST") == true)
    // the daemon itself says it is a test one (a different socket, AGENTHUB_HOME on the daemon)
    #expect(TestMark.label(home: def, defaultHome: def, daemonTestMode: true) != nil)
    let st = try? JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"estop":false,"status":"ok","plugins":[],"sessions":[],"hub":{"home":"/tmp/ahl","testMode":true,"builtinDir":"/tmp/ahl/Builtin","builtin":"copy"}}"#.utf8))
    #expect(st?.hub == HubInfo(home: "/tmp/ahl", testMode: true, builtinDir: "/tmp/ahl/Builtin", builtin: "copy"))
}

@Test func pluginAuthorNameFirstAndProfileLink() throws {
    let a = try JSONDecoder().decode(PluginAuthor.self, from: Data(#"{"name":"Kensei","github":"KenseiTheOne"}"#.utf8))
    #expect(a.display == "Kensei · @KenseiTheOne")
    #expect(a.profileURL?.absoluteString == "https://github.com/KenseiTheOne")
    #expect(PluginAuthor(github: "only").display == "@only")
    #expect(PluginAuthor(name: "Имя").display == "Имя")
    #expect(PluginAuthor(name: "x", github: "bad login/../x").github == nil)
    let old = try JSONDecoder().decode(PluginAuthor.self, from: Data(#""someone""#.utf8))
    #expect(old.github == "someone")
    let p = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"q","author":{"name":"Kensei","github":"KenseiTheOne"}}"#.utf8))
    #expect(p.author?.name == "Kensei")
    let none = try JSONDecoder().decode(PluginState.self, from: Data(#"{"id":"q","author":{}}"#.utf8))
    #expect(none.author == nil)
}

@Test func catalogUpdateVersionOnlyWhenNewer() {
    #expect(PluginVersion.compare("1.10.0", "1.9.3") == .orderedDescending)
    #expect(PluginVersion.compare("1.2", "1.2.0") == .orderedSame)
    #expect(PluginVersion.compare("0.3.0", "1.0.0") == .orderedAscending)
    var c = CatalogPlugin(id: "x", version: "1.2.1", installed: "1.2.0", updateAvailable: true)
    #expect(c.newerVersion == "1.2.1")
    c.version = "1.2.0"   // a rebuilt archive of the same version — "Update" without a number
    #expect(c.newerVersion == nil)
    #expect(c.updateKind == .rebuild)
    // the catalog version is older than the installed one (the registry withdrew the release): this is a rollback, not "Update"
    c.version = "1.1.0"
    #expect(c.newerVersion == nil)
    #expect(c.updateKind == .older("1.1.0"))
    #expect(c.updateKind?.isRollback == true)
    c.version = "1.3.0"
    #expect(c.updateKind == .newer("1.3.0"))
    #expect(c.updateKind?.isRollback == false)
    // the catalog version is blocked by the registry — nothing to update to
    c.blocked = "bad release"
    #expect(c.updateKind == nil && c.newerVersion == nil)
    c.blocked = nil
    c.updateAvailable = false
    c.version = "2.0.0"
    #expect(c.newerVersion == nil)
    #expect(c.updateKind == nil)
    #expect(!c.updateGrows)
}

// Session effort (last turn) and cmux bridge state (2026-11-05, notes after a live build).
@Test func sessionEffortDecodesOnlyKnownLevels() throws {
    let list = try JSONDecoder().decode([SessionInfo].self, from: Data(#"[{"sessionId":"a","effort":"xhigh","ultracode":true},{"sessionId":"b","effort":"ultra"},{"sessionId":"c"}]"#.utf8))
    #expect(list[0].effortLabel == "xhigh")
    #expect(list[0].ultracode == true)
    #expect(list[1].effortLabel == nil)
    #expect(list[2].effort == nil && list[2].ultracode == nil)
}

@Test func bridgeLaunchCommandAddsHomeOnlyForCustomHub() throws {
    let s = try JSONDecoder().decode(HubState.self, from: Data(#"{"bridge":{"online":false,"command":"/Users/u/My Projects/agent-hub/bridge/agenthub-bridge","home":"/tmp/ahk","defaultHome":false}}"#.utf8))
    #expect(s.bridge?.online == false)
    #expect(s.bridge?.launchCommand == "AGENTHUB_HOME=/tmp/ahk '/Users/u/My Projects/agent-hub/bridge/agenthub-bridge'")
    let std = BridgeInfo(online: true, command: "/x/bridge/agenthub-bridge", home: "/h", defaultHome: true)
    #expect(std.launchCommand == "/x/bridge/agenthub-bridge")
    let old = try JSONDecoder().decode(HubState.self, from: Data("{}".utf8))
    #expect(old.bridge == nil)
}

@MainActor
@Test func bridgeEventsToggleFocusAvailability() throws {
    let state = try JSONDecoder().decode(HubState.self, from: Data(#"{"primitives":[{"name":"cmux.focus","level":"immediate"}],"bridge":{"online":false,"command":"/x/agenthub-bridge","home":"/h","defaultHome":true}}"#.utf8))
    let store = HubStore(client: HubClient(socketPath: "/tmp/none.sock"), preview: state)
    #expect(store.focusPrimitive && !store.bridgeOnline && !store.canFocusTabs)
    store.handle(SSEEvent(id: "7", event: "bridge.connected", data: #"{"pid":5}"#))
    #expect(store.bridgeOnline && store.canFocusTabs)
    store.handle(SSEEvent(id: "8", event: "bridge.disconnected", data: #"{"pid":5,"reason":"stale"}"#))
    #expect(!store.bridgeOnline && !store.canFocusTabs)
    // demo sessions — for display only
    store.showDemoSessions([SessionInfo(sessionId: "d", status: "idle", effort: "low")])
    #expect(store.sessions.map(\.sessionId) == ["d"])
    #expect(store.isDemo(store.sessions[0]))
}

// MARK: - plugin updates (daemon background check)

@Suite struct PluginUpdatesTests {
    static let snapshot = #"""
    {"seq":3,"plugins":[],"pluginUpdates":{"enabled":true,"setting":true,"config":true,"configured":true,
     "checkedAt":"2026-11-05T10:00:00.000Z","nextCheckAt":null,"error":null,
     "items":[{"id":"my-runner","title":"Прогоны","installed":"0.3.0","version":"0.4.0","sha256":"x","tier":"official","permissionsGrow":true,"added":[{"kind":"watch","what":"$AGENTHUB_USAGE_FILE","why":"кэш","added":true}]},
              {"broken":true}]}}
    """#

    @Test func decodesFromSnapshotAndEvent() throws {
        var st = try JSONDecoder().decode(HubState.self, from: Data(Self.snapshot.utf8))
        #expect(st.pluginUpdates?.enabled == true)
        #expect(st.pluginUpdates?.items.map(\.id) == ["my-runner"], "the broken entry is skipped")
        #expect(st.pluginUpdates?.items.first?.permissionsGrow == true)
        let ev = HubEvent.decode(SSEEvent(id: "4", event: "plugins.updates",
            data: #"{"type":"plugins.updates","pluginUpdates":{"enabled":false,"setting":false,"config":true,"configured":true,"items":[]}}"#))
        guard case .pluginUpdates(let u)? = ev else { Issue.record("not plugins.updates"); return }
        let changed = st.apply(.pluginUpdates(u))
        #expect(changed)
        #expect(st.pluginUpdates?.enabled == false && st.pluginUpdates?.items.isEmpty == true)
        // old daemon without the field
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"plugins":[]}"#.utf8))
        #expect(old.pluginUpdates == nil)
    }

    @Test func notificationTarget() {
        #expect(NotifyTarget.of(plugin: "@hub", key: "@hub:plugin-update:my-runner:0.4.0") == .manager)
        #expect(NotifyTarget.of(plugin: "@hub", key: "@hub:app-pin-changed") == .sessions)
        #expect(NotifyTarget.of(plugin: "quota", key: "quota:week-80") == .plugin("quota"))
        #expect(NotifyTarget.of(plugin: nil, key: nil) == .sessions)
    }
}

// Texts depend on the process language — in the same serialized group as TextTests.
extension TextTests {
    @Test func popoverLineTexts() {
        L10n.shared.lang = .ru
        let one = [PluginUpdate(id: "my-runner", title: nil, installed: "0.3.0", version: "0.4.0")]
        let l1 = PluginUpdateLine.make(one)
        #expect(l1?.title == "Доступно обновление: my-runner 0.4.0")
        #expect(l1?.single == "my-runner" && l1?.grows == false)
        #expect(l1?.detail == "Установлена 0.3.0")
        let grows = [PluginUpdate(id: "my-runner", title: "Прогоны", installed: "0.3.0", version: "0.4.0", permissionsGrow: true)]
        #expect(PluginUpdateLine.make(grows)?.detail?.contains("больше прав") == true)
        #expect(l1?.button == "Обновить" && l1?.rows.isEmpty == true)
        let two = [PluginUpdate(id: "hermes", installed: "1.1.1", version: "1.2.0")] + grows
        let l2 = PluginUpdateLine.make(two)
        #expect(l2?.title == "Обновления плагинов: 2")
        // several: the button only opens the manager — not an orange "Update"; "more permissions" is on its own row
        #expect(l2?.single == nil && l2?.grows == false && l2?.button == "Открыть")
        #expect(l2?.detail == nil)
        #expect(l2?.rows.map { "\($0.name) \($0.version) \($0.grows)" } == ["hermes 1.2.0 false", "Прогоны 0.4.0 true"])
        #expect(l2?.more == 0)
        let many = (1...5).map { PluginUpdate(id: "p\($0)", title: "Очень длинное название плагина \($0)", installed: "1.0.0", version: "12.10.\($0)") }
        let l3 = PluginUpdateLine.make(many)
        #expect(l3?.rows.count == PluginUpdateLine.maxRows && l3?.more == 2)
        #expect(l3?.rows.last?.version == "12.10.3", "the version is separate from the name, not truncated with it")
        #expect(PluginUpdateLine.moreLabel(2) == "и ещё 2")
        #expect(PluginUpdateLine.make([]) == nil)
        L10n.shared.lang = .en
        #expect(PluginUpdateLine.make(one)?.title == "Update available: my-runner 0.4.0")
        #expect(PluginUpdateLine.make(two)?.title == "Plugin updates: 2")
        #expect(PluginUpdateLine.make(two)?.button == "Open")
        L10n.shared.apply(setting: "system", effective: "ru")
    }

    @Test func pluginUpdatesStatusLine() {
        L10n.shared.lang = .ru
        let fmt: (Date) -> String = { _ in "T" }
        let at = "2026-11-05T10:00:00.000Z"
        // the first check failed: not "Not checked yet", no advice about the button
        var info = PluginUpdates(enabled: true, checkedAt: nil, nextCheckAt: at, error: "registry:fetch")
        var l = PluginUpdatesStatus.line(info, date: fmt)
        #expect(l.text == "Проверить не удалось: нет связи с каталогом · повтор: T")
        #expect(l.warn)
        info.error = "registry:not-found"
        #expect(PluginUpdatesStatus.line(info, date: fmt).text == "Проверить не удалось: файл каталога не найден · повтор: T")
        // there was a successful one, the last attempt failed
        info = PluginUpdates(enabled: true, checkedAt: at, nextCheckAt: at, error: "registry:signature", items: [PluginUpdate(id: "a", installed: "1", version: "2")])
        #expect(PluginUpdatesStatus.line(info, date: fmt).text == "Последняя проверка: T · последняя попытка не удалась: подпись каталога не сошлась · повтор: T · доступно обновлений: 1")
        // all good
        info = PluginUpdates(enabled: true, checkedAt: at, nextCheckAt: at)
        l = PluginUpdatesStatus.line(info, date: fmt)
        #expect(l.text == "Последняя проверка: T · следующая: T" && !l.warn)
        #expect(PluginUpdatesStatus.line(PluginUpdates(enabled: true), date: fmt).text == "Ещё не проверялось")
        // turned off in settings: neither an error nor "next", even if an old daemon sent an error
        l = PluginUpdatesStatus.line(PluginUpdates(enabled: false, setting: false, nextCheckAt: nil, error: "registry:fetch"), date: fmt)
        #expect(l.text == "Выключено" && !l.warn)
        #expect(PluginUpdatesStatus.line(PluginUpdates(enabled: false, config: false), date: fmt).text.contains("config.json"))
        #expect(PluginUpdatesStatus.line(PluginUpdates(configured: false), date: fmt).text.contains("не подключён"))
        #expect(PluginUpdatesStatus.errorText("registry:index-entry") == "каталог повреждён")
        #expect(PluginUpdatesStatus.errorText("weird") == "ошибка weird")
        L10n.shared.lang = .en
        #expect(PluginUpdatesStatus.line(PluginUpdates(enabled: true, nextCheckAt: at, error: "registry:http"), date: fmt).text == "Couldn't check: can't reach the catalog · retry: T")
        L10n.shared.apply(setting: "system", effective: "ru")
    }
}

// Panel sidebar (variant C): the language switches — so it is in the serialized TextTests, like the other texts.
extension TextTests {
    private func sidebarPlugin(_ status: HubStatus, header: String?, error: String? = nil, title: String = "Прогоны") -> PluginState {
        var p = PluginState(id: "batch", title: title, status: status,
                            header: header.map { [Item(title: $0, level: 0, params: [:])] } ?? [])
        p.error = error
        return p
    }

    @Test func pluginLineIsHeadlineWithSeverityTone() {
        L10n.shared.lang = .ru
        let runs = SidebarStatus.plugin(sidebarPlugin(.block, header: "Прогоны не запустятся: открыт Unity на Game — закройте до 04:30"))
        // the plugin name at the start of the header is not repeated on the second line (mockup C), the tooltip has it in full
        #expect(runs.text == "не запустятся: открыт Unity на Game — закройте до 04:30", "header title without the name, the layout truncates it")
        #expect(runs.tone == .alarm && runs.help == "Прогоны не запустятся: открыт Unity на Game — закройте до 04:30")
        #expect(SidebarStatus.accessibilityLabel(title: "Прогоны", status: runs) == "Прогоны, Прогоны не запустятся: открыт Unity на Game — закройте до 04:30")
        #expect(SidebarStatus.plugin(sidebarPlugin(.error, header: "Сбой")).tone == .alarm)
        #expect(SidebarStatus.plugin(sidebarPlugin(.wait, header: "1 остановлен · 1 идёт")).tone == .attention)
        #expect(SidebarStatus.plugin(sidebarPlugin(.ok, header: "неделя 42%")).tone == .calm)
        #expect(SidebarStatus.plugin(sidebarPlugin(.unknown, header: "—")).tone == .calm)
        // line breaks in the title — joined into one line
        #expect(SidebarStatus.plugin(sidebarPlugin(.ok, header: "неделя 42%\n  сброс в пн")).text == "неделя 42% сброс в пн")
        // no header — the status label; a failure without a header — "Plugin failure: …", as on the page
        #expect(SidebarStatus.plugin(sidebarPlugin(.ok, header: nil)).text == "Всё в порядке")
        let crash = SidebarStatus.plugin(sidebarPlugin(.error, header: nil, error: "exit 1"))
        #expect(crash == SidebarStatus(text: "Сбой плагина: exit 1", tone: .alarm))
        #expect(SidebarStatus.plugin(sidebarPlugin(.block, header: "   ")).text == "Мешает работе")
        L10n.shared.lang = .en
        let en = SidebarStatus.plugin(sidebarPlugin(.block, header: "Runs won't start: Unity is open on Game — close it before 04:30"))
        #expect(en.text == "Runs won't start: Unity is open on Game — close it before 04:30" && en.tone == .alarm)
        #expect(SidebarStatus.plugin(sidebarPlugin(.ok, header: nil)).text == "All good")
        #expect(SidebarStatus.plugin(sidebarPlugin(.error, header: nil, error: "signal SIGKILL")).text == "Plugin failure: signal SIGKILL")
        let runsEn = SidebarStatus.plugin(sidebarPlugin(.block, header: "Runs won't start: Unity is open", title: "Runs"))
        #expect(runsEn.text == "won't start: Unity is open" && runsEn.help == "Runs won't start: Unity is open")
        L10n.shared.lang = .ru
    }

    @Test func pluginFailureBeatsStaleHeader() {
        L10n.shared.lang = .ru
        // on failure (pluginFailed) the daemon leaves the header alone — it is from the last successful frame
        let q = SidebarStatus.plugin(sidebarPlugin(.error, header: "Неделя 42% · сброс в пн", error: "timeout", title: "Квота"))
        #expect(q.text == "Сбой плагина: timeout" && q.tone == .alarm)
        #expect(q.help == "Неделя 42% · сброс в пн — Сбой плагина: timeout")
        #expect(SidebarStatus.accessibilityLabel(title: "Квота", status: q) == "Квота, Неделя 42% · сброс в пн — Сбой плагина: timeout")
        // error without a reason — a plain header line
        #expect(SidebarStatus.plugin(sidebarPlugin(.error, header: "Сбой", title: "Квота")).text == "Сбой")
        L10n.shared.lang = .en
        let en = SidebarStatus.plugin(sidebarPlugin(.error, header: "Week 42%", error: "timeout", title: "Quota"))
        #expect(en.text == "Plugin failure: timeout" && en.help == "Week 42% — Plugin failure: timeout")
        L10n.shared.lang = .ru
    }

    @Test func sidebarHelpIsClipped() {
        // the tooltip does not grow down forever: a plugin header up to 16 KB is truncated to helpLimit with an ellipsis
        let long = String(repeating: "очень длинная шапка ", count: 100)
        let s = SidebarStatus(text: "коротко", tone: .calm, help: long)
        #expect(s.help.count == SidebarStatus.helpLimit)
        #expect(s.help.hasSuffix("…"))
        #expect(SidebarStatus(text: "коротко", tone: .calm).help == "коротко", "a short one — as is")
    }

    @Test func pluginHeaderRepeatingTitle() {
        L10n.shared.lang = .ru
        // header = name (SwiftBar-style plugins) — not a status: the status label, VoiceOver does not repeat the name
        let w = SidebarStatus.plugin(sidebarPlugin(.ok, header: "Погода", title: "Погода"))
        #expect(w == SidebarStatus(text: "Всё в порядке", tone: .calm))
        #expect(SidebarStatus.accessibilityLabel(title: "Погода", status: w) == "Погода, Всё в порядке")
        let tomato = sidebarPlugin(.wait, header: "помидор", title: "Помидор")
        #expect(SidebarStatus.plugin(tomato) == SidebarStatus(text: tomato.statusLabel(), tone: .attention))
        // only the whole name is cut off, followed by a separator
        #expect(SidebarStatus.dropTitle("Квота", from: "Квота: неделя 42%") == "неделя 42%")
        #expect(SidebarStatus.dropTitle("Прогон", from: "Прогоны запустятся") == "Прогоны запустятся")
        #expect(SidebarStatus.dropTitle("Прогон", from: "прогон — 3 задачи") == "3 задачи")
        #expect(SidebarStatus.dropTitle("Прогон", from: "Прогон:") == "Прогон:", "nothing but the name — the line stays as it was")
        L10n.shared.lang = .ru
    }

    @Test func offlineDimsLastSnapshot() {
        L10n.shared.lang = .ru
        let p = SidebarStatus.plugin(sidebarPlugin(.block, header: "Прогоны не запустятся", title: "Прогоны"), live: false)
        #expect(p.text == "не запустятся" && p.tone == .calm)
        #expect(p.help == "Прогоны не запустятся — нет связи с хабом, данные на момент обрыва")
        let busy = (1...5).map { SessionInfo(sessionId: "b\($0)", status: "busy") }
        let waiting = (1...2).map { SessionInfo(sessionId: "w\($0)", status: "waiting") }
        let s = SidebarStatus.sessions(waiting + busy, live: false)
        #expect(s.text == "2 ждут ответа · 5 работают" && s.tone == .calm)
        #expect(s.help == "2 ждут ответа · 5 работают — нет связи с хабом, данные на момент обрыва")
        // no sessions — not "no open sessions", but honestly: we don't know
        #expect(SidebarStatus.sessions([], live: false) == SidebarStatus(text: "нет связи с хабом", tone: .calm))
        let u = SidebarStatus.updates([PluginUpdate(id: "batch", title: "Прогоны", installed: "0.4.0", version: "0.4.1")], live: false)
        #expect(u?.tone == .calm && u?.help == "Доступны обновления: Прогоны 0.4.1 — нет связи с хабом, данные на момент обрыва")
        L10n.shared.lang = .en
        #expect(SidebarStatus.sessions([], live: false).text == "no connection to the hub")
        #expect(SidebarStatus.sessions(busy, live: false).help == "5 working — no connection to the hub, data as of the disconnect")
        L10n.shared.lang = .ru
    }

    @Test func sessionsSummary() {
        L10n.shared.lang = .ru
        let busy = (1...5).map { SessionInfo(sessionId: "b\($0)", status: "busy") }
        let waiting = (1...2).map { SessionInfo(sessionId: "w\($0)", status: "waiting") }
        let s = SidebarStatus.sessions(waiting + busy, waiting: 2)
        #expect(s.text == "2 ждут ответа · 5 работают" && s.tone == .attention)
        #expect(SidebarStatus.sessions([busy[0]], waiting: 0).text == "1 работает")
        #expect(SidebarStatus.sessions([busy[0]], waiting: 0).tone == .calm)
        #expect(SidebarStatus.sessions(Array(waiting.prefix(1)), waiting: 1).text == "1 ждёт ответа")
        // waiting sessions in the list are counted even if the snapshot counter lags behind
        #expect(SidebarStatus.sessions(waiting + busy, waiting: 0).text == "2 ждут ответа · 5 работают")
        // only answer cards waiting — also "waiting"
        #expect(SidebarStatus.sessions([], waiting: 3).text == "3 ждут ответа")
        let idle = (1...3).map { SessionInfo(sessionId: "i\($0)", status: "idle") }
        #expect(SidebarStatus.sessions(idle, waiting: 0).text == "3 простаивают")
        #expect(SidebarStatus.sessions([], waiting: 0) == SidebarStatus(text: "нет открытых сессий", tone: .calm))
        L10n.shared.lang = .en
        #expect(SidebarStatus.sessions(waiting + busy, waiting: 2).text == "2 waiting for you · 5 working")
        #expect(SidebarStatus.sessions(idle, waiting: 0).text == "3 idle")
        #expect(SidebarStatus.sessions([], waiting: 0).text == "no open sessions")
        L10n.shared.lang = .ru
    }

    @Test func sessionsWaitingCountsSessionsNotCards() {
        L10n.shared.lang = .ru
        let one = [SessionInfo(sessionId: "s1", status: "busy")]
        // two subagent cards of one session, `claude agents` status still busy — one waiting, none working
        #expect(SidebarStatus.sessions(one, cardSessions: ["s1", "s1"]).text == "1 ждёт ответа")
        let two = one + [SessionInfo(sessionId: "s2", status: "busy")]
        #expect(SidebarStatus.sessions(two, cardSessions: ["s1", "s1"]).text == "1 ждёт ответа · 1 работает")
        // a waiting session in the list and a card of the same session — counted once
        let w = [SessionInfo(sessionId: "w1", status: "waiting")]
        #expect(SidebarStatus.sessions(w, waiting: 1, cardSessions: ["w1"]).text == "1 ждёт ответа")
        // a card of a session not in the list (not yet in the registry) — also waiting
        #expect(SidebarStatus.sessions(w, cardSessions: ["x"]).text == "2 ждут ответа")
        // cards without sessionId — each counts separately
        #expect(SidebarStatus.sessions([], cardSessions: ["", ""]).text == "2 ждут ответа")
        L10n.shared.lang = .ru
    }

    @Test func sessionsFollowSessionsPlugin() {
        L10n.shared.lang = .ru
        func plugin(_ st: HubStatus, header: [Item], body: [Item] = [], error: String? = nil) -> PluginState {
            var p = PluginState(id: NotifyTarget.sessionsPlugin, title: "Сессии", status: st, header: header, body: body)
            p.error = error
            return p
        }
        // the source cannot be read: the plugin's reason in orange, not "no open sessions"
        let broken = plugin(.unknown, header: [Item(title: "Не видно сессий: claude agents --json не отвечает", status: .unknown, event: "source-broken")])
        #expect(SidebarStatus.sessions([], plugin: broken) == SidebarStatus(text: "Не видно сессий: claude agents --json не отвечает", tone: .attention))
        // part of the source is broken by a body line, there are sessions
        let partial = plugin(.unknown, header: [Item(title: "1 сессия работает")],
                             body: [Item(title: "Часть сессий не видна", status: .unknown, event: "source-broken")])
        let b1 = SidebarStatus.sessions([SessionInfo(sessionId: "b", status: "busy")], plugin: partial)
        #expect(b1.text == "1 работает · Часть сессий не видна" && b1.tone == .attention)
        // the plugin crashed — red, the reason in the tooltip
        let failed = plugin(.error, header: [Item(title: "2 сессии работают")], error: "timeout")
        let f = SidebarStatus.sessions([], plugin: failed)
        #expect(f.text == "Плагин сессий не ответил" && f.tone == .alarm)
        #expect(f.help == "Плагин сессий не ответил: timeout")
        let f2 = SidebarStatus.sessions([SessionInfo(sessionId: "w", status: "waiting")], plugin: failed)
        #expect(f2.text == "Плагин сессий не ответил · 1 ждёт ответа" && f2.help == "Плагин сессий не ответил: timeout · 1 ждёт ответа")
        // cut off mid-turn — orange
        let died = plugin(.wait, header: [Item(title: "1 сессия оборвалась", status: .wait)],
                          body: [Item(title: "ES — оборвалась посреди работы", status: .wait, event: "died:abc")])
        let d = SidebarStatus.sessions([SessionInfo(sessionId: "b", status: "busy")], plugin: died)
        #expect(d.text == "1 оборвалась · 1 работает" && d.tone == .attention)
        #expect(SidebarStatus.sessions([], plugin: died).text == "1 оборвалась")
        // the plugin has not figured things out yet (unknown with a header) — its words in grey
        let starting = plugin(.unknown, header: [Item(title: "Сбой плагина сессий")])
        #expect(SidebarStatus.sessions([], plugin: starting) == SidebarStatus(text: "Сбой плагина сессий", tone: .calm))
        // all good — as without the plugin
        let ok = plugin(.ok, header: [Item(title: "Нет открытых сессий")])
        #expect(SidebarStatus.sessions([], plugin: ok).text == "нет открытых сессий")
        L10n.shared.lang = .en
        #expect(SidebarStatus.sessions([], plugin: failed).text == "The sessions plugin failed")
        #expect(SidebarStatus.sessions([], plugin: failed).help == "The sessions plugin failed: timeout")
        #expect(SidebarStatus.sessions([], plugin: died).text == "1 stopped mid-turn")
        #expect(SidebarStatus.sessions([], plugin: broken).text == "Не видно сессий: claude agents --json не отвечает")
        L10n.shared.lang = .ru
    }

    @Test func updatesLineAndCount() {
        L10n.shared.lang = .ru
        #expect(SidebarStatus.updates([]) == nil, "no updates — a single line")
        #expect(SidebarStatus.updatesCount([]) == nil)
        let one = [PluginUpdate(id: "batch", title: "Прогоны", installed: "0.4.0", version: "0.4.1")]
        let u1 = SidebarStatus.updates(one)
        #expect(u1?.text == "1 обновление" && u1?.tone == .calm)
        #expect(u1?.help == "Доступны обновления: Прогоны 0.4.1")
        #expect(SidebarStatus.updatesCount(one) == "1")
        let five = (1...5).map { PluginUpdate(id: "p\($0)", installed: "1.0.0", version: "1.1.0", permissionsGrow: $0 == 3) }
        #expect(SidebarStatus.updates(Array(five.prefix(2)))?.text == "2 обновления")
        #expect(SidebarStatus.updates(five)?.text == "5 обновлений")
        #expect(SidebarStatus.updates(five)?.tone == .attention, "the new version asks for more permissions — attention")
        #expect(SidebarStatus.updatesCount(five) == "5")
        L10n.shared.lang = .en
        #expect(SidebarStatus.updates(one)?.text == "1 update")
        #expect(SidebarStatus.updates(five)?.text == "5 updates")
        #expect(SidebarStatus.updates(one)?.help == "Updates available: Прогоны 0.4.1")
        L10n.shared.lang = .ru
    }

    @Test func accessibilityLabelHasTitleAndFullStatus() {
        let st = SidebarStatus(text: "2 обновления", tone: .calm, help: "Доступны обновления: Прогоны 0.4.1, Квота 1.1.0")
        #expect(SidebarStatus.accessibilityLabel(title: "Плагины", status: st) == "Плагины, Доступны обновления: Прогоны 0.4.1, Квота 1.1.0")
        #expect(SidebarStatus.accessibilityLabel(title: "Журнал", status: nil) == "Журнал", "an item without a status — just the name")
    }
}
