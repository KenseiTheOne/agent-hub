import Foundation
import Testing
@testable import AgentHubKit

// "Is it safe to shut down" (the daemon's idle service, /state.idle): parsing the snapshot and the idle.verdict event, the menu bar icon look
// by verdict and priorities, the popover card (titles, lines, "N more", "Also checked").

private func verdict(_ json: String) throws -> IdleVerdict {
    try JSONDecoder().decode(IdleVerdict.self, from: Data(json.utf8))
}

// the new daemon's order (2026-11-09): work, the computer is needed, then the "waiting for an answer" info as the last line
private let busyJSON = #"{"verdict":"busy","items":[{"source":"sessions","kind":"busy","text":"2 сессии работают: demo-d9, alpha-05","target":"sessions"},{"source":"plugin:agents","kind":"busy","text":"Прогон «m81-gold» идёт, 12 мин","target":"plugin:agents"},{"source":"plugin:my-runner","kind":"busy","text":"Идёт исследование рынка (вручную) с 13:30 до ≈15:30","target":"plugin:my-runner"},{"source":"plugins","kind":"busy","text":"Обновляется плагин: Прогоны 0.5.1","target":"manager"},{"source":"plugin:hermes","kind":"busy","text":"Hermes: 1 задача в работе","target":"plugin:hermes"},{"source":"plugin:x","kind":"needs-on","text":"Прогон в 04:30 — нужен включённый Mac"},{"source":"sessions","kind":"waiting","text":"1 сессия ждёт ответа: alpha-1d — ответить можно и после включения","target":"sessions"}],"checked":["обновления"],"since":"2026-11-07T10:00:00.000Z"}"#

@Suite struct IdleTests {
    @Test func decodesStateAndEvent() throws {
        let v = try verdict(busyJSON)
        #expect(v.verdict == .busy && v.items.count == 7 && v.items[0].kind == .busy && v.items[5].kind == .needsOn && v.items[5].target == nil)
        #expect(v.items[6].kind == .waiting)
        // a daemon before 2026-11-09: "too early" only because of waiting sessions — recomputed by obstacles (waiting sessions do not change the verdict)
        let oldWait = try verdict(#"{"verdict":"busy","items":[{"source":"sessions","kind":"waiting","text":"x"}],"checked":[]}"#)
        #expect(oldWait.verdict == .quiet)
        let oldWaitNeeds = try verdict(#"{"verdict":"busy","items":[{"source":"sessions","kind":"waiting","text":"x"},{"source":"n","kind":"needs-on","text":"y"}],"checked":[]}"#)
        #expect(oldWaitNeeds.verdict == .quietNeedsOn)
        // an unknown line kind is work: "too early" stays
        #expect(try verdict(#"{"verdict":"busy","items":[{"source":"s","kind":"later","text":"x"}],"checked":[]}"#).verdict == .busy)
        #expect(v.checked == ["обновления"] && v.since != nil)
        // an unknown line kind and broken fields do not break parsing
        let odd = try verdict(#"{"verdict":"quiet-needs-on","items":[{"kind":"later","text":"x"},{"text":5}],"checked":7}"#)
        #expect(odd.verdict == .quietNeedsOn && odd.items.map(\.kind) == [.other, .other] && odd.checked.isEmpty)
        // review: "checking" (verdict null, the daemon just started) — same as no verdict; the event resets it too
        let checking = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"idle":{"verdict":null,"items":[],"checked":[]}}"#.utf8))
        #expect(checking.idle == nil)
        guard case .idle(let none)? = HubEvent.decode(SSEEvent(id: "4", event: "idle.verdict", data: #"{"idle":{"verdict":null,"items":[],"checked":[]}}"#)) else {
            Issue.record("idle.verdict with null was not parsed"); return
        }
        #expect(none == nil)
        let item = try JSONDecoder().decode(IdleVerdict.self, from: Data(#"{"verdict":"quiet-needs-on","items":[{"source":"plugin:n","kind":"unknown","text":"x","plugin":"Прогоны","trusted":false}],"checked":[]}"#.utf8))
        #expect(item.items[0].kind == .unknown && item.items[0].plugin == "Прогоны" && item.items[0].trusted == false)
        // a snapshot without idle (older daemon) — nil
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8))
        #expect(old.idle == nil)
        let s = try JSONDecoder().decode(HubState.self, from: Data("{\"seq\":1,\"idle\":\(busyJSON)}".utf8))
        #expect(s.idle?.verdict == .busy)
        var st = HubState()
        guard case .idle(let e)? = HubEvent.decode(SSEEvent(id: "3", event: "idle.verdict", data: #"{"idle":{"verdict":"quiet","items":[],"checked":["сессии"]}}"#)) else {
            Issue.record("not idle.verdict"); return
        }
        let changed = st.apply(.idle(e))
        #expect(changed)
        #expect(st.idle?.verdict == .quiet && st.idle?.checked == ["сессии"])
    }

    @Test func menuBarPriorities() {
        let busy = IdleVerdict(verdict: .busy)
        let needs = IdleVerdict(verdict: .quietNeedsOn)
        let quiet = IdleVerdict(verdict: .quiet)
        // no verdict — as before
        #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: false, idle: nil) == .calm)
        #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: false, idle: busy) == .working)
        #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: false, idle: needs) == .quietNeedsOn)
        #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: false, idle: quiet) == .quiet)
        // block > waiting > work
        #expect(MenuBarLook.make(status: .block, waiting: 2, live: true, estop: false, idle: busy) == .blocked(2))
        #expect(MenuBarLook.make(status: .ok, waiting: 2, live: true, estop: false, idle: busy) == .waiting(2))
        // a runner plugin in "doing nothing" mode (status=wait all the time) is not "waiting": the icon follows the verdict
        #expect(MenuBarLook.make(status: .wait, waiting: 0, live: true, estop: false, idle: quiet) == .quiet)
        #expect(MenuBarLook.make(status: .wait, waiting: 0, live: true, estop: false, idle: busy) == .working)
        // no connection and pause — as before, the verdict does not override them
        #expect(MenuBarLook.make(status: .ok, waiting: 0, live: false, estop: false, idle: quiet) == .offline)
        #expect(MenuBarLook.make(status: .ok, waiting: 0, live: true, estop: true, idle: busy) == .paused(0, blocker: false))
        // emblem and dimming
        #expect(MenuBarLook.working.emblem == .blue && MenuBarLook.working.glyphAlpha == 1)
        #expect(MenuBarLook.quietNeedsOn.emblem == .indigo && MenuBarLook.quietNeedsOn.glyphAlpha < 1)
        #expect(MenuBarLook.quiet.emblem == nil && MenuBarLook.quiet.glyphAlpha < 1 && !MenuBarLook.quiet.isTemplate)
        #expect(MenuBarLook.quiet.glyphAlpha > MenuBarLook.offline.glyphAlpha, "quiet is more visible than \"no connection\"")
        // review: "no connection" differs from "quiet" not only by alpha — a "?" sign on the right
        #expect(MenuBarLook.offline.unknownMark && !MenuBarLook.quiet.unknownMark && !MenuBarLook.quietNeedsOn.unknownMark && !MenuBarLook.calm.unknownMark)
        #expect(!MenuBarLook.offline.pauseMark)
        #expect(MenuBarLook.working.count == nil && MenuBarLook.quiet.labelText(test: false) == nil)
    }

    @Test func cardRowsCollapseAndExpand() throws {
        let v = try verdict(busyJSON)
        let c = IdleCard.make(v)
        #expect(c.rows.count == IdleCard.maxRows && c.hidden == 3 && !c.collapsible)
        #expect(c.rows.map(\.mark) == [.busy, .busy, .busy, .busy])
        let e = IdleCard.make(v, expanded: true)
        #expect(e.rows.count == 7 && e.hidden == 0 && e.collapsible)
        #expect(e.rows[5].mark == .attention, "the computer is needed — \"!\"")
        #expect(e.rows.last?.mark == .info && e.rows.last?.hint == IdleCard.waitingHint, "waiting for an answer — info \"○\" with its own hint")
        #expect(e.rows.dropLast().allSatisfy { $0.hint == nil })
        // no more than four — nothing to expand
        let small = IdleVerdict(verdict: .busy, items: Array(v.items.prefix(4)))
        #expect(IdleCard.make(small).hidden == 0 && !IdleCard.make(small, expanded: true).collapsible)
        #expect(IdleCard.make(v).tone == .blue)
        #expect(IdleCard.make(IdleVerdict(verdict: .quiet)).tone == .green)
        #expect(IdleCard.make(IdleVerdict(verdict: .quietNeedsOn)).tone == .orange)
    }

    /// Review: a verbose plugin does not take all lines of the collapsed card; "checked" is short.
    @Test func cardOneRowPerPluginWhenFolded() {
        let items: [IdleVerdict.Item] = [
            .init(source: "plugin:build", kind: .busy, text: "Сборка: экспорт", plugin: "Сборка"),
            .init(source: "plugin:build", kind: .busy, text: "Сборка: Тесты Unity: 112 из 340", plugin: "Сборка"),
            .init(source: "plugin:build", kind: .busy, text: "Сборка: Линт 4 пакетов", plugin: "Сборка"),
            .init(source: "plugin:hermes", kind: .busy, text: "Hermes: 1 задача в работе", plugin: "Hermes", trusted: true),
            .init(source: "sessions", kind: .waiting, text: "1 сессия ждёт ответа"),
            .init(source: "sessions", kind: .busy, text: "2 сессии работают"),
            .init(source: "plugin:batch", kind: .needsOn, text: "Прогон в 04:30 — нужен включённый Mac", plugin: "Прогоны", trusted: true),
        ]
        let v = IdleVerdict(verdict: .busy, items: items)
        let c = IdleCard.make(v)
        #expect(c.rows.map(\.text) == ["Сборка: экспорт", "Hermes: 1 задача в работе", "1 сессия ждёт ответа", "2 сессии работают"])
        #expect(c.hidden == 3 && c.rows[0].plugin == "Сборка" && c.rows[2].plugin == nil)
        #expect(c.rows[2].mark == .info && c.rows[2].hint != nil && c.rows[3].mark == .busy)
        let e = IdleCard.make(v, expanded: true)
        #expect(e.rows.count == 7 && e.hidden == 0 && e.collapsible)
        // 4 lines, but two from one plugin — 3 collapsed, there is something to expand
        let four = IdleVerdict(verdict: .busy, items: Array(items.prefix(4)))
        #expect(IdleCard.make(four).rows.count == 2 && IdleCard.make(four).hidden == 2 && IdleCard.make(four, expanded: true).collapsible)
        // "don't know" has its own sign
        let u = IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "sessions", kind: .unknown, text: "Не знаю про сессии")]))
        #expect(u.rows.first?.mark == .unknown && u.tone == .orange)
    }

    @Test func needsOnHead() {
        #expect(IdleCard.needsOnHead("Прогон в 04:30 — нужен включённый Mac") == "прогон в 04:30")
        #expect(IdleCard.needsOnHead("Hermes в 07:00 — нужен Mac") == "Hermes в 07:00")
        #expect(IdleCard.needsOnHead("NAS — бэкап") == "NAS")
        #expect(IdleCard.needsOnHead(String(repeating: "я", count: 60)) == nil)
    }
}

extension TextTests {
    @Test func idleCardTexts() throws {
        L10n.shared.lang = .ru
        let quiet = IdleCard.make(IdleVerdict(verdict: .quiet, checked: ["Сессии", "Агенты", "Идущие обновления"]))
        #expect(quiet.title == "Можно выключать" && quiet.subtitle == "ничего не потеряется")
        #expect(quiet.checkedLine == "Проверено: Сессии, Агенты, Идущие обновления")
        // review: no more than four names, long ones are truncated, as in tiles
        let many = IdleCard.make(IdleVerdict(verdict: .quiet, checked: ["Сессии", "Агенты", "Очень длинное название синтетического плагина", "Hermes", "Прогоны", "Идущие обновления"]))
        #expect(many.checkedLine == "Проверено: Сессии, Агенты, Очень длинное наз…, Hermes и ещё 2")
        let needs = IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "plugin:my-runner", kind: .needsOn, text: "Прогон в 04:30 — нужен включённый Mac", trusted: true)], checked: ["Сессии"]))
        #expect(needs.title == "Можно, но прогон в 04:30")
        #expect(needs.checkedLine == "Ещё проверено: Сессии")
        // review: a third-party plugin's phrase does not go into the title ("OK, but shutting down is not allowed")
        let foreign = IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "plugin:x", kind: .needsOn, text: "X: выключать нельзя — совсем", trusted: false)]))
        #expect(foreign.title == "Можно, но не всё пройдёт")
        // review: a failed participant or the sessions plugin did not answer — "not everything is known", not "nothing will be lost"
        let unknown = IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "plugin:batch", kind: .unknown, text: "Прогоны: сбой — последнее: Прогон в 04:30 — нужен включённый Mac (01:30)")]))
        #expect(unknown.title == "Можно, но не всё известно" && unknown.subtitle != "ничего не потеряется")
        let two = IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "a", kind: .needsOn, text: "A"), .init(source: "b", kind: .needsOn, text: "B")]))
        #expect(two.title == "Можно, но не всё пройдёт")
        let busy = IdleCard.make(try verdict(busyJSON))
        #expect(busy.title == "Пока рано" && busy.subtitle == "идёт работа — выключение её прервёт")
        // 2026-11-09: waiting for an answer is neither "too early" nor "the question will be lost": safe to shut down, an info line
        let waitOnly = IdleCard.make(IdleVerdict(verdict: .quiet, items: [.init(source: "sessions", kind: .waiting, text: "x")]))
        #expect(waitOnly.tone == .green && waitOnly.title == "Можно выключать" && waitOnly.subtitle == "работы не видно — ждущие ответа подождут")
        #expect(waitOnly.rows.map(\.mark) == [.info])
        let fromOld = IdleCard.make(try verdict(#"{"verdict":"busy","items":[{"source":"sessions","kind":"waiting","text":"x"}],"checked":[]}"#))
        #expect(fromOld.title == "Можно выключать", "old daemon: \"too early\" is not shown because of waiting sessions alone")
        // waiting sessions and the batch run at 04:30 — the title follows the batch run (the info does not override it)
        let waitNeeds = IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "plugin:my-runner", kind: .needsOn, text: "Прогон в 04:30 — нужен включённый Mac", trusted: true), .init(source: "sessions", kind: .waiting, text: "x")]))
        #expect(waitNeeds.title == "Можно, но прогон в 04:30" && waitNeeds.rows.map(\.mark) == [.attention, .info])
        // the hint is only the truth: sleep does not affect it, after shutdown — claude --resume, the question dialog will not come back by itself
        #expect(IdleCard.waitingHint.contains("claude --resume") && IdleCard.waitingHint.hasPrefix("Сон сессию не трогает"))
        #expect(!IdleCard.waitingHint.contains("пропад"))
        // review 2026-11-09: background work of a waiting session is not visible in the status — the hint says it will be cut off
        #expect(IdleCard.waitingHint.hasSuffix("Фоновые агенты и команды сессии при выключении остановятся и сами не продолжатся"))
        #expect(IdleCard.moreLabel(3) == "ещё 3")
        let runNeeds = IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "n", kind: .needsOn, text: "Прогон в 04:30 — нужен включённый Mac", trusted: true)])
        #expect(MenuBarLook.quietNeedsOn.tooltip(status: .ok, waiting: 0, testMark: nil, idle: runNeeds) == "Agent Hub: тихо, но: Прогон в 04:30 — нужен включённый Mac")
        #expect(MenuBarLook.quiet.tooltip(status: .ok, waiting: 0, testMark: nil) == "Agent Hub: тихо — можно выключать")
        L10n.shared.lang = .en
        #expect(IdleCard.make(IdleVerdict(verdict: .quiet)).title == "OK to shut down")
        #expect(needs.title != IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "n", kind: .needsOn, text: "Run at 04:30 — needs the Mac on", trusted: true)])).title)
        // review: no capital letter in the middle of a phrase ("OK, but Run at 04:30")
        #expect(IdleCard.make(IdleVerdict(verdict: .quietNeedsOn, items: [.init(source: "n", kind: .needsOn, text: "Run at 04:30 — needs the Mac on", trusted: true)])).title == "OK — Run at 04:30 needs the Mac")
        #expect(IdleCard.make(IdleVerdict(verdict: .quiet, items: [.init(source: "sessions", kind: .waiting, text: "x")])).subtitle == "no work in sight — the waiting sessions can wait")
        #expect(IdleCard.make(try verdict(busyJSON)).subtitle == "work is running — shutting down would interrupt it")
        #expect(IdleCard.waitingHint.contains("claude --resume") && IdleCard.waitingHint.hasPrefix("Sleep doesn't touch the session"))
        #expect(!IdleCard.waitingHint.contains("loses"))
        #expect(IdleCard.waitingHint.hasSuffix("The session's background agents and commands stop at shutdown and won't resume on their own"))
        #expect(IdleCard.make(IdleVerdict(verdict: .quiet, checked: ["Sessions", "A", "B", "C", "D"])).checkedLine == "Checked: Sessions, A, B, C and 1 more")
        #expect(IdleCard.make(try verdict(busyJSON)).title == "Not yet")
        #expect(MenuBarLook.working.tooltip(status: .ok, waiting: 0, testMark: nil) == "Agent Hub: work in progress — too early to shut down")
        L10n.shared.lang = .ru
    }
}
