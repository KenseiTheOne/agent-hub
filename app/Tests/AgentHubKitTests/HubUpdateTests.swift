import Foundation
import Testing
@testable import AgentHubKit

// Updating the hub itself (docs/hub-updates.md): parsing /state.hubUpdate and events, popover and Settings rows,
// quitting the app on hub-update.restarting without /shutdown.

private func info(_ json: String) throws -> HubUpdateInfo {
    try JSONDecoder().decode(HubUpdateInfo.self, from: Data(json.utf8))
}

private let base = #""installed":true,"running":"0.2.0","label":"0.2.0","current":{"label":"0.2.0","version":"0.2.0","tag":"v0.2.0","commit":"abcdef1234567890"},"previous":{"label":"0.1.0"},"enabled":true,"setting":true,"config":true,"configured":true,"checkedAt":"2026-11-06T10:00:00.000Z","nextCheckAt":"2026-11-06T16:20:00.000Z","error":null,"checking":false"#

/// Tests in other suites change the language in parallel: compare against both translations, not against tr() at check time.
private func either(_ s: String?, _ ru: String, _ en: String) -> Bool { s == ru || s == en }
private func has(_ s: String?, _ ru: String, _ en: String) -> Bool { (s ?? "").contains(ru) || (s ?? "").contains(en) }

@Suite struct HubUpdateTests {
    @Test func decodesStateAndEvents() throws {
        let i = try info("{\(base),\"available\":{\"version\":\"0.3.0\",\"tag\":\"v0.3.0\"},\"install\":{\"phase\":\"idle\"},\"blocked\":null}")
        #expect(i.installed && i.available?.version == "0.3.0" && i.previous?.label == "0.1.0" && i.install.phase == "idle")
        // broken and missing fields don't break parsing
        let partial = try info(#"{"install":{"phase":7}}"#)
        #expect(!partial.installed && partial.install.phase == "idle" && partial.available == nil)
        var st = HubState()
        let ev = SSEEvent(id: "9", event: "hub-update.status", data: "{\"hubUpdate\":{\(base),\"install\":{\"phase\":\"building\",\"label\":\"0.3.0\",\"step\":\"build\"}}}")
        guard case .hubUpdate(let u)? = HubEvent.decode(ev) else { Issue.record("not hub-update.status"); return }
        let changed = st.apply(.hubUpdate(u))
        #expect(changed)
        #expect(st.hubUpdate?.install.phase == "building")
        guard case .hubRestarting(let label)? = HubEvent.decode(SSEEvent(id: "10", event: "hub-update.restarting", data: #"{"label":"0.3.0","op":"install"}"#)) else { Issue.record("not hub-update.restarting"); return }
        #expect(label == "0.3.0")
        let s = try JSONDecoder().decode(HubState.self, from: Data("{\"seq\":1,\"hubUpdate\":{\(base),\"install\":{\"phase\":\"idle\"}}}".utf8))
        #expect(s.hubUpdate?.label == "0.2.0")
    }

    @Test func popoverLine() throws {
        let avail = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"done\",\"op\":\"install\",\"label\":\"0.2.0\"}}")
        let l = try #require(HubUpdateText.line(avail))
        #expect(l.kind == .available && l.title.contains("0.3.0") && l.detail?.contains("0.2.0") == true && l.button != nil && l.note == nil)
        // release notes (the tag message subject) — on a separate row; no hashes in the popover row
        let noted = try info("{\(base),\"available\":{\"version\":\"0.3.0\",\"tag\":\"v0.3.0\",\"commit\":\"1234567890abcdef1234567890abcdef12345678\",\"notes\":{\"subject\":\"Быстрее поповер\",\"body\":\"строка\"}},\"install\":{\"phase\":\"idle\"}}")
        let nl = try #require(HubUpdateText.line(noted))
        #expect(nl.note == "Быстрее поповер" && !(nl.detail ?? "").contains("1234567") && !nl.title.contains("1234567"))
        // build steps are reflected: clone → build → verify
        for (step, ru, en) in [("clone", "загрузка", "downloading"), ("build", "сборка", "building"), ("verify", "проверка", "checking"), ("selftest", "проверка", "checking")] {
            let b = try info("{\(base),\"install\":{\"phase\":\"building\",\"op\":\"install\",\"label\":\"0.3.0\",\"step\":\"\(step)\"}}")
            #expect(has(HubUpdateText.line(b)?.title, ru, en), "\(step)")
        }
        // the result of a successful update — for a while, with "Was …"; if a newer one is already out, it's shown
        let doneNow = try info("{\(base),\"install\":{\"phase\":\"done\",\"op\":\"install\",\"label\":\"0.2.0\",\"from\":\"0.1.0-dev.6ceb3d8\",\"finishedAt\":\"\(ISO8601DateFormatter().string(from: Date()))\"}}")
        let dl = try #require(HubUpdateText.line(doneNow))
        #expect(dl.kind == .done && dl.title.contains("0.2.0") && either(dl.detail, "Было 0.1.0 (сборка из коммита)", "Was 0.1.0 (build from a commit)") && dl.button == nil)
        let doneOld = try info("{\(base),\"install\":{\"phase\":\"done\",\"op\":\"install\",\"label\":\"0.2.0\",\"finishedAt\":\"2020-01-01T00:00:00.000Z\"}}")
        #expect(HubUpdateText.line(doneOld) == nil)
        let building = try info("{\(base),\"install\":{\"phase\":\"building\",\"op\":\"install\",\"label\":\"0.3.0\",\"step\":\"clone\"}}")
        #expect(HubUpdateText.line(building)?.kind == .progress)
        #expect(HubUpdateText.line(building)?.button == nil)
        let failed = try info("{\(base),\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.0\",\"error\":\"hub-update:build-failed\",\"finishedAt\":\"\(ISO8601DateFormatter().string(from: Date()))\"}}")
        #expect(HubUpdateText.line(failed)?.kind == .failed)
        // an old failure and nothing new — no row; not migrated — none either
        let old = try info("{\(base),\"install\":{\"phase\":\"failed\",\"label\":\"0.3.0\",\"finishedAt\":\"2020-01-01T00:00:00.000Z\"}}")
        #expect(HubUpdateText.line(old) == nil)
        let dev = try info(#"{"installed":false,"available":{"version":"0.3.0"},"install":{"phase":"idle"}}"#)
        #expect(HubUpdateText.line(dev) == nil)
    }

    @Test func settingsTexts() throws {
        let fixed: (Date) -> String = { _ in "T" }
        let ok = try info("{\(base),\"install\":{\"phase\":\"idle\"}}")
        // version — without hashes; tag and commit — under "Details"
        #expect(HubUpdateText.currentText(ok).hasSuffix(": 0.2.0"))
        #expect(HubUpdateText.detailLines(ok).first?.contains("v0.2.0") == true && HubUpdateText.detailLines(ok).first?.contains("abcdef1") == true)
        #expect(either(HubUpdateText.displayLabel("0.1.0-dev.6ceb3d8"), "0.1.0 (сборка из коммита)", "0.1.0 (build from a commit)"))
        #expect(either(HubUpdateText.displayLabel("0.1.0-dev.6ceb3d8.dirty"), "0.1.0 (сборка из рабочей папки)", "0.1.0 (build from the working folder)"))
        #expect(HubUpdateText.displayLabel("0.2.0-rc.1") == "0.2.0-rc.1")
        #expect(HubUpdateText.checkLine(ok, date: fixed).text.contains("T"))
        #expect(!HubUpdateText.checkLine(ok, date: fixed).warn)
        let err = try info("{\(base.replacingOccurrences(of: "\"error\":null", with: "\"error\":\"hub-update:remote\"")),\"install\":{\"phase\":\"idle\"}}")
        #expect(HubUpdateText.checkLine(err, date: fixed).warn)
        let failed = try info("{\(base),\"install\":{\"phase\":\"failed\",\"label\":\"0.3.0\",\"error\":\"hub-update:selftest-failed\",\"log\":\"/l/x.log\"}}")
        let st = try #require(HubUpdateText.installLine(failed))
        #expect(st.failed && st.log == "/l/x.log" && st.text.contains("0.3.0"))
        // no tautology like "failed: build failed"
        let bf = try info("{\(base),\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.1\",\"error\":\"hub-update:build-failed\"}}")
        #expect(either(HubUpdateText.installLine(bf)?.text, "Не удалось обновить до 0.3.1: ошибка сборки", "Couldn't update to 0.3.1: build error"))
        // a 0.3.0 failure with 0.3.1 available doesn't linger in Settings (same as in the popover)
        let superseded = try info("{\(base),\"available\":{\"version\":\"0.3.1\"},\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.0\",\"error\":\"hub-update:interrupted\"}}")
        #expect(HubUpdateText.installLine(superseded) == nil)
        // the same version didn't install — "again"
        let retry = try info("{\(base),\"available\":{\"version\":\"0.3.1\"},\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.1\",\"error\":\"hub-update:build-failed\"}}")
        #expect(either(HubUpdateText.installButton(retry), "Обновить до 0.3.1 ещё раз", "Retry update to 0.3.1"))
        #expect(either(HubUpdateText.installButton(superseded), "Обновить до 0.3.1", "Update to 0.3.1"))
        #expect(HubUpdateText.reason("hub-update:trial-timeout") != "hub-update:trial-timeout")
        #expect(HubUpdateText.denied("peer:cli").isEmpty == false)
        #expect(HubUpdateText.denied("hub-update:estop") != HubUpdateText.denied("hub-update:busy"))
        // buttons: only the pinned build, connected, not paused
        #expect(HubUpdateText.canAct(ok, isApp: true, live: true))
        #expect(!HubUpdateText.canAct(ok, isApp: false, live: true))
        var paused = ok
        paused.blocked = "estop"
        #expect(!HubUpdateText.canAct(paused, isApp: true, live: true))
    }

    @Test func failedLineYieldsToNewerRelease() throws {
        let now = ISO8601DateFormatter().string(from: Date())
        // 0.3.0 didn't install, 0.3.1 is out — "0.3.1 available" with "Update" right away, not a day of "failed"
        let newer = try info("{\(base),\"available\":{\"version\":\"0.3.1\"},\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.0\",\"finishedAt\":\"\(now)\"}}")
        let l = try #require(HubUpdateText.line(newer))
        #expect(l.kind == .available && l.title.contains("0.3.1") && l.button != nil)
        // the same version is available again — still "failed"
        let same = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"failed\",\"op\":\"install\",\"label\":\"0.3.0\",\"finishedAt\":\"\(now)\"}}")
        #expect(HubUpdateText.line(same)?.kind == .failed)
    }

    @Test func previousButtonFollowsVersionOrder() throws {
        // after "Roll back to 0.1.0" from 0.2.0: current 0.1.0, previous 0.2.0, 0.2.0 available — no second button
        let back = #""installed":true,"label":"0.1.0","current":{"label":"0.1.0"},"previous":{"label":"0.2.0"},"enabled":true,"setting":true,"config":true,"configured":true,"checking":false"#
        let same = try info("{\(back),\"available\":{\"version\":\"0.2.0\"},\"install\":{\"phase\":\"done\"}}")
        #expect(HubUpdateText.previousButton(same) == nil)
        // previous is newer than current, something else is available — "Return to", not "Roll back to"
        let other = try info("{\(back),\"install\":{\"phase\":\"done\"}}")
        let title = try #require(HubUpdateText.previousButton(other))
        #expect(title == tr("Вернуться на 0.2.0", "Return to 0.2.0"))
        // the usual case — "Roll back to"
        let normal = try info("{\(base),\"install\":{\"phase\":\"idle\"}}")
        #expect(HubUpdateText.previousButton(normal) == tr("Откатить на 0.1.0", "Roll back to 0.1.0"))
    }

    @Test func readyPhaseAsksForSecondPress() throws {
        let ready = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"ready\",\"op\":\"install\",\"label\":\"0.3.0\",\"waiting\":2,\"waitingCards\":2,\"waitingSessions\":1}}")
        let l = try #require(HubUpdateText.line(ready))
        // the button is short (fits in the popover), the number waiting is in the explanation
        #expect(l.kind == .ready && l.title.contains("0.3.0") && either(l.button, "Перезапустить", "Restart") && l.detail?.contains("2") == true)
        #expect(has(l.detail, "карточки", "cards"))
        let st = try #require(HubUpdateText.installLine(ready))
        #expect(!st.failed && st.text.contains("0.3.0"))
        // in ready, "Update to the same version" isn't shown, rollback is unavailable
        #expect(!HubUpdateText.showInstallButton(ready) && !HubUpdateText.canRollback(ready))
        // only sessions are waiting (no hub cards) — don't mention cards
        let sessions = try info("{\(base),\"install\":{\"phase\":\"ready\",\"op\":\"install\",\"label\":\"0.3.0\",\"waiting\":2,\"waitingCards\":0,\"waitingSessions\":2}}")
        let sd = HubUpdateText.readyDetail(sessions.install)
        #expect(sd.contains("2") && !has(sd, "карточ", "card"))
        // older daemon (no breakdown) — as before, cards
        let legacy = try info("{\(base),\"install\":{\"phase\":\"ready\",\"op\":\"install\",\"label\":\"0.3.0\",\"waiting\":1}}")
        #expect(has(HubUpdateText.readyDetail(legacy.install), "карточ", "card"))
        // "Update to …" isn't shown during a build
        let building = try info("{\(base),\"available\":{\"version\":\"0.3.0\"},\"install\":{\"phase\":\"building\",\"op\":\"install\",\"label\":\"0.3.0\",\"step\":\"build\"}}")
        #expect(!HubUpdateText.showInstallButton(building))
        #expect(HubUpdateText.progressPhases.contains("rolling-back") && !HubUpdateText.progressPhases.contains("ready"))
    }

    @Test func installConfirmShowsTagCommitAndWarnings() throws {
        let plain = try info("{\(base),\"available\":{\"version\":\"0.3.0\",\"tag\":\"v0.3.0\",\"commit\":\"1234567890abcdef1234567890abcdef12345678\"},\"install\":{\"phase\":\"idle\"}}")
        let c = try #require(HubUpdateText.installConfirm(plain))
        // dialog: version and notes; tag and commit — under "Details"; the button is "Update", not "Run"
        #expect(c.title.contains("0.3.0") && !c.text.contains("1234567") && c.details.contains("v0.3.0") && c.details.contains("1234567") && !c.details.contains("12345678"))
        #expect(either(c.button, "Обновить", "Update") && c.text.contains("\n\n"))
        let noted = try info("{\(base),\"available\":{\"version\":\"0.3.0\",\"tag\":\"v0.3.0\",\"commit\":\"1234567890abcdef1234567890abcdef12345678\",\"notes\":{\"subject\":\"Тема релиза\",\"body\":\"1\\n2\\n3\\n4\\n5\"}},\"install\":{\"phase\":\"idle\"}}")
        let nc = try #require(HubUpdateText.installConfirm(noted))
        #expect(nc.text.hasPrefix("Тема релиза\n1\n2\n3\n…"))
        // rollback — also with confirmation
        let rb = try #require(HubUpdateText.rollbackConfirm(plain))
        #expect(rb.title.contains("0.1.0") && either(rb.button, "Откатить", "Roll back"))
        let moved = try info("{\(base),\"available\":{\"version\":\"1.0.0\",\"tag\":\"v1.0.0\",\"commit\":\"\(String(repeating: "d", count: 40))\",\"moved\":{\"old\":\"\(String(repeating: "c", count: 40))\",\"new\":\"\(String(repeating: "d", count: 40))\"}},\"install\":{\"phase\":\"idle\"}}")
        #expect(moved.available?.moved?.old.hasPrefix("ccc") == true)
        let m = try #require(HubUpdateText.installConfirm(moved))
        // a moved tag is the exception: both commits right in the text (they're what needs checking)
        #expect(m.text.contains("ccccccc") && m.text.contains("ddddddd") && m.text.contains("1.0.0"))
        #expect(HubUpdateText.majorJump(from: "0.2.0", to: "1.0.0") && !HubUpdateText.majorJump(from: "0.2.0", to: "0.3.0"))
        #expect(HubUpdateText.line(moved)?.kind == .failed && HubUpdateText.line(moved)?.button != nil)
        #expect(HubUpdateText.reason("hub-update:not-on-main") != "hub-update:not-on-main")
        #expect(HubUpdateText.denied("hub-update:tag-moved") != HubUpdateText.reason("hub-update:tag-moved"))
    }

    @Test func ownUpdatePinNoteIsQuiet() throws {
        let cd = String(repeating: "a", count: 40)
        let done = try info("{\(base.replacingOccurrences(of: "\"commit\":\"abcdef1234567890\"", with: "\"commit\":\"abcdef1234567890\",\"cdhash\":\"\(cd)\"")),\"install\":{\"phase\":\"done\",\"op\":\"install\",\"label\":\"0.2.0\"}}")
        let own = AppPinInfo(kind: "cdhash", fingerprint: "cdhash:\(cd)", by: "agenthub hub-update", under: "hub")
        #expect(HubUpdateText.pinChangeIsOwnUpdate(own, done))
        #expect(either(own.originText, "обновлением хаба", "by a hub update"))
        // same by, but a different build — the note stays
        let other = AppPinInfo(kind: "cdhash", fingerprint: "cdhash:\(String(repeating: "b", count: 40))", by: "agenthub hub-update")
        #expect(!HubUpdateText.pinChangeIsOwnUpdate(other, done))
        #expect(!HubUpdateText.pinChangeIsOwnUpdate(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:\(cd)", by: "agenthub pin-app"), done))
        // pinned by the installer (scripts/install.sh → agenthub hub install) — labelled as such, not "origin unknown"
        #expect(either(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:\(cd)", by: "agenthub hub install", under: "terminal").originText, "установщиком хаба", "by the hub installer"))
        // hub from a working folder: the hint points to the installer
        #expect(HubUpdateText.notInstalledText.contains("scripts/install.sh"))
    }

    @Test func homebrewManagedHub() throws {
        // a Homebrew-installed hub: the version comes from the brew package, the texts point to `brew upgrade agent-hub`
        let none = try info("{\(base),\"source\":\"brew\",\"brew\":\"/opt/homebrew/opt/agent-hub/libexec\",\"install\":{\"phase\":\"idle\"}}")
        #expect(none.isBrew && none.brew == "/opt/homebrew/opt/agent-hub/libexec")
        let upToDate = HubUpdateText.checkLine(none, date: { _ in "T" })
        #expect(!upToDate.warn)
        #expect(has(upToDate.text, "обновления приходят из Homebrew: brew upgrade agent-hub", "updates come from Homebrew: brew upgrade agent-hub"))
        #expect(!upToDate.text.contains("next") && !upToDate.text.contains("следующая"), "no git schedule in brew mode")
        #expect(has(HubUpdateText.checkExplain(for: none), "через Homebrew", "with Homebrew"))
        #expect(HubUpdateText.checkExplain(for: try info("{\(base),\"install\":{\"phase\":\"idle\"}}")) == HubUpdateText.checkExplain, "git hub — the old explanation")
        #expect(HubUpdateText.detailLines(none).contains { has($0, "Источник: Homebrew", "Source: Homebrew") })

        let avail = try info("{\(base),\"source\":\"brew\",\"available\":{\"version\":\"0.3.0\",\"tag\":null,\"commit\":\"1234567890abcdef1234567890abcdef12345678\",\"brew\":true},\"install\":{\"phase\":\"idle\"}}")
        #expect(avail.available?.brew == true)
        #expect(has(HubUpdateText.checkLine(avail, date: { _ in "T" }).text, "в Homebrew есть 0.3.0", "Homebrew has 0.3.0"))
        let l = try #require(HubUpdateText.line(avail))
        #expect(l.kind == .available && l.button != nil, "the usual Update button")
        let c = try #require(HubUpdateText.installConfirm(avail))
        #expect(has(c.text, "из пакета Homebrew", "from the Homebrew package"))
        #expect(either(c.details, "Homebrew · коммит 1234567", "Homebrew · commit 1234567"))
        #expect(HubUpdateText.detailLines(avail).contains { $0.contains("0.3.0 · Homebrew") })

        let copying = try info("{\(base),\"source\":\"brew\",\"install\":{\"phase\":\"building\",\"op\":\"install\",\"label\":\"0.3.0\",\"step\":\"clone\"}}")
        #expect(has(HubUpdateText.line(copying)?.title, "копирование исходников из Homebrew", "copying sources from Homebrew"))

        // the formula was uninstalled while the hub stays (base already has "error":null — replace it, not a duplicate key)
        let failed = base.replacingOccurrences(of: #""error":null"#, with: #""error":"hub-update:brew-missing""#)
        let gone = try info("{\(failed),\"source\":\"brew\",\"install\":{\"phase\":\"idle\"}}")
        let g = HubUpdateText.checkLine(gone, date: { _ in "T" })
        #expect(g.warn && g.text.contains("brew install KenseiTheOne/tap/agent-hub"))
    }

    @MainActor @Test func restartingQuitsWithoutShutdown() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in snapshotFrame(1, peer: "app") + sseFrame(2, "hub-update.restarting", #"{"label":"0.3.0","op":"install"}"#) }
        let store = HubStore(client: HubClient(socketPath: d.path))
        var asked = 0
        store.onHubRestart = { asked += 1 }
        store.start()
        #expect(await waitFor { asked == 1 })
        #expect(store.hubRestarting)
        #expect(await store.shutdownDaemonOnQuit(arguments: ["AgentHub"]) == .skipped)
        #expect(!d.requests.contains { $0.uri == "/shutdown" }, "the daemon restarts itself — /shutdown would stop it for good")
    }
}
