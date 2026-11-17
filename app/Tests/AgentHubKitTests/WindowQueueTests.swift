import Foundation
import Testing
@testable import AgentHubKit

// The hub's windows are not modal (2026-11-17): a window's answer is awaited, so the main actor — and with it the store's
// stream — keeps running while a window is open. Here: whose turn it is (`WindowQueue`), that whoever waits is resumed
// exactly once however the window ends, that a confirmation gives up by itself when its token runs out, and that the
// store goes on applying stream events with a window open. The daemon is the FakeDaemon double (ReviewFixTests.swift).

/// What "the screen" saw: which windows were put up, which were taken down, and how to answer the ones still up.
@MainActor
final class Screen {
    var shown: [String] = []
    var closed: [String] = []
    private var answers: [String: WindowQueue.Answer<Bool>] = [:]

    func window(_ name: String) -> @MainActor (@escaping WindowQueue.Answer<Bool>) -> WindowQueue.Close {
        { answer in
            self.shown.append(name)
            self.answers[name] = answer
            return { self.closed.append(name) }
        }
    }

    /// The human answers the window `name` (nil — Esc or the window was closed). Works after the window is gone, too:
    /// a late click must change nothing.
    func answer(_ name: String, _ value: Bool?) { answers[name]?(value) }
}

/// A presenter built on the queue, like the shell's: every window waits for its turn and for an answer from the test.
@MainActor
final class QueuePresenter: ConfirmPresenter {
    let queue = WindowQueue()
    let screen = Screen()
    private let deadlines = TokenDeadlines()
    var reports: [(title: String, detail: String)] = []

    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool {
        let until = deadlines.deadline(token: request.token, expiresInMs: request.expiresInMs)
        return await queue.present(until: until, show: screen.window("confirm:\(actionLabel)")) == .answer(true)
    }

    func consent(_ request: ConsentRequest) async -> Bool {
        let until = deadlines.deadline(token: request.token, expiresInMs: request.expiresInMs)
        return await queue.present(until: until, show: screen.window("consent:\(request.id)")) == .answer(true)
    }

    func report(title: String, detail: String) async {
        reports.append((title, detail))
        _ = await queue.present(show: screen.window("report:\(title)"))
    }
}

/// A clock the test moves by hand.
@MainActor
final class TestClock {
    var now = Date(timeIntervalSince1970: 1_800_000_000)
}

@Suite(.hubLang(.ru)) struct WindowQueueTests {
    @MainActor @Test func secondWindowWaitsForTheFirstToEnd() async {
        let queue = WindowQueue()
        let screen = Screen()
        let first = Task { await queue.present(show: screen.window("first")) }
        let second = Task { await queue.present(show: screen.window("second")) }
        #expect(await waitFor { screen.shown == ["first"] && queue.waitingCount == 1 })
        // the second one is neither on screen nor refused: it waits
        #expect(queue.isShowing && screen.closed.isEmpty)
        screen.answer("first", true)
        #expect(await first.value == .answer(true))
        #expect(await waitFor { screen.shown == ["first", "second"] })
        #expect(screen.closed == ["first"] && queue.waitingCount == 0)
        screen.answer("second", false)
        #expect(await second.value == .answer(false))
        #expect(screen.closed == ["first", "second"] && !queue.isShowing)
    }

    @MainActor @Test func everyWayOfClosingResumesOnce() async {
        let queue = WindowQueue()
        let screen = Screen()
        // Esc first, then a late click, the window reporting "closed" and the app quitting: the first one counts, the
        // rest find nobody waiting (a second resume of the continuation would crash the test run)
        let esc = Task { await queue.present(show: screen.window("esc")) }
        #expect(await waitFor { screen.shown == ["esc"] })
        screen.answer("esc", nil)
        screen.answer("esc", true)
        screen.answer("esc", nil)
        queue.cancelAll()
        #expect(await esc.value == .cancelled)
        #expect(screen.closed == ["esc"], "the window is taken down once")

        // a click first, then Esc and quitting
        let click = Task { await queue.present(show: screen.window("click")) }
        #expect(await waitFor { screen.shown == ["esc", "click"] })
        screen.answer("click", true)
        screen.answer("click", nil)
        queue.cancelAll()
        #expect(await click.value == .answer(true))
        #expect(screen.closed == ["esc", "click"])
        #expect(!queue.isShowing && queue.waitingCount == 0)
    }

    @MainActor @Test func closingTheWindowMayReportBackWithoutASecondResume() async {
        let queue = WindowQueue()
        var closes = 0
        // an AppKit window tells its delegate "closed" from inside the call that closes it
        let result: WindowResult<Bool> = await queue.present { answer in
            Task { @MainActor in answer(true) }
            return {
                closes += 1
                answer(nil)
            }
        }
        #expect(result == .answer(true))
        #expect(closes == 1 && !queue.isShowing)
    }

    @MainActor @Test func answerGivenWhileTheWindowIsBeingShown() async {
        let queue = WindowQueue()
        var closes = 0
        // a window that could not be built answers at once: it is still taken down, and the line moves on
        let result: WindowResult<Bool> = await queue.present { answer in
            answer(nil)
            return { closes += 1 }
        }
        #expect(result == .cancelled)
        #expect(closes == 1 && !queue.isShowing)
        let screen = Screen()
        let next = Task { await queue.present(show: screen.window("next")) }
        #expect(await waitFor { screen.shown == ["next"] })
        screen.answer("next", true)
        #expect(await next.value == .answer(true))
    }

    @MainActor @Test func deadlineClosesTheWindowAsExpired() async {
        let queue = WindowQueue()
        let screen = Screen()
        let started = Date()
        let result = await queue.present(until: started.addingTimeInterval(0.2), show: screen.window("confirm"))
        #expect(result == .expired)
        #expect(result.value == nil, "an expired window is not an answer")
        #expect(Date().timeIntervalSince(started) >= 0.15, "not before its time")
        #expect(screen.shown == ["confirm"] && screen.closed == ["confirm"], "the window closed by itself")
        // a click that was already on its way changes nothing and opens nothing
        screen.answer("confirm", true)
        #expect(!queue.isShowing && queue.waitingCount == 0)
    }

    @MainActor @Test func answerBeforeTheDeadlineCancelsIt() async {
        let queue = WindowQueue()
        let screen = Screen()
        let task = Task { await queue.present(until: Date().addingTimeInterval(0.2), show: screen.window("confirm")) }
        #expect(await waitFor { screen.shown == ["confirm"] })
        screen.answer("confirm", true)
        #expect(await task.value == .answer(true))
        // the deadline passes with the next window already up: it must not be the one that gets closed
        let next = Task { await queue.present(show: screen.window("next")) }
        #expect(await waitFor { screen.shown == ["confirm", "next"] })
        try? await Task.sleep(for: .milliseconds(350))
        #expect(queue.isShowing && screen.closed == ["confirm"])
        screen.answer("next", false)
        #expect(await next.value == .answer(false))
    }

    @MainActor @Test func confirmationThatExpiredInTheQueueIsNeverShown() async {
        let clock = TestClock()
        let queue = WindowQueue(now: { clock.now })
        let screen = Screen()
        let first = Task { await queue.present(show: screen.window("first")) }
        #expect(await waitFor { screen.shown == ["first"] })
        // the token's time runs from the request, not from the window's turn
        let second = Task { await queue.present(until: clock.now.addingTimeInterval(60), show: screen.window("second")) }
        let third = Task { await queue.present(show: screen.window("third")) }
        #expect(await waitFor { queue.waitingCount == 2 })
        clock.now += 61
        screen.answer("first", true)
        #expect(await first.value == .answer(true))
        #expect(await second.value == .expired)
        #expect(await waitFor { screen.shown == ["first", "third"] }, "the expired one is skipped, the next gets its turn")
        screen.answer("third", nil)
        #expect(await third.value == .cancelled)
        #expect(screen.closed == ["first", "third"])
    }

    @MainActor @Test func quittingEndsTheShownWindowAndTheWaitingOnes() async {
        let queue = WindowQueue()
        let screen = Screen()
        let tasks = ["a", "b", "c"].map { name in Task { await queue.present(show: screen.window(name)) } }
        #expect(await waitFor { screen.shown == ["a"] && queue.waitingCount == 2 })
        queue.cancelAll()
        for t in tasks { #expect(await t.value == .cancelled) }
        #expect(screen.shown == ["a"], "the waiting ones never reached the screen")
        #expect(screen.closed == ["a"] && !queue.isShowing && queue.waitingCount == 0)
        // nothing is left to cancel
        queue.cancelAll()
    }

    @MainActor @Test func windowsOfDifferentKindsShareOneLine() async {
        let queue = WindowQueue()
        let screen = Screen()
        var shownText = false
        let yesNo = Task { await queue.present(show: screen.window("confirm")) }
        let text: Task<WindowResult<String>, Never> = Task {
            await queue.present { answer in
                shownText = true
                answer("typed")
                return {}
            }
        }
        #expect(await waitFor { screen.shown == ["confirm"] && queue.waitingCount == 1 })
        #expect(!shownText)
        screen.answer("confirm", true)
        #expect(await yesNo.value == .answer(true))
        #expect(await text.value == .answer("typed"))
        #expect(await text.value.value == "typed")
    }

    // MARK: lifetime

    @Test func windowClosesShortlyBeforeTheTokenDies() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        // the core's confirmations live two minutes: the window gives up two seconds earlier, so a last-second click still lands
        #expect(WindowExpiry.deadline(expiresInMs: 120_000, now: now) == now.addingTimeInterval(118))
        // a very short life is not eaten whole by the margin
        #expect(WindowExpiry.deadline(expiresInMs: 1_000, now: now) == now.addingTimeInterval(0.5))
        // the shell's own confirmations have no lifetime
        #expect(WindowExpiry.deadline(expiresInMs: nil, now: now) == nil)
        #expect(WindowExpiry.deadline(expiresInMs: 0, now: now) == nil)
    }

    @Test func countdownTextIsLiveAndInBothLanguages() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let until = now.addingTimeInterval(118)
        #expect(WindowExpiry.confirmText(until: until, now: now) == "Подтверждение действует ещё 01:58")
        #expect(WindowExpiry.confirmText(until: until, now: now.addingTimeInterval(60)) == "Подтверждение действует ещё 00:58")
        #expect(WindowExpiry.consentText(until: until, now: now.addingTimeInterval(60)) == "Согласие действует ещё 00:58.")
        // the last ten seconds say what is about to happen
        #expect(!WindowExpiry.isLast(until: until, now: now) && WindowExpiry.isLast(until: until, now: now.addingTimeInterval(108)))
        #expect(WindowExpiry.confirmText(until: until, now: now.addingTimeInterval(110)) == "Окно закроется через 00:08")
        #expect(WindowExpiry.consentText(until: until, now: now.addingTimeInterval(110)) == "Окно закроется через 00:08.")
        #expect(WindowExpiry.confirmText(until: until, now: now.addingTimeInterval(500)) == "Окно закроется через 00:00")
        L10n.shared.lang = .en
        #expect(WindowExpiry.confirmText(until: until, now: now) == "Valid for 01:58")
        #expect(WindowExpiry.consentText(until: until, now: now) == "Consent is valid for 01:58.")
        #expect(WindowExpiry.confirmText(until: until, now: now.addingTimeInterval(110)) == "Closes in 00:08")
        #expect(WindowExpiry.consentText(until: until, now: now.addingTimeInterval(110)) == "The window closes in 00:08.")
        L10n.shared.lang = .ru
    }

    @MainActor @Test func reopenedSheetKeepsTheTokensFirstDeadline() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let deadlines = TokenDeadlines()
        let first = deadlines.deadline(token: "tok", expiresInMs: 120_000, now: now)
        #expect(first == now.addingTimeInterval(118))
        // the core refused the typed text 40 s later and the sheet reopens: the token is no younger for that
        #expect(deadlines.deadline(token: "tok", expiresInMs: 120_000, now: now.addingTimeInterval(40)) == first)
        // another token has its own time
        #expect(deadlines.deadline(token: "other", expiresInMs: 120_000, now: now.addingTimeInterval(40)) == now.addingTimeInterval(158))
        // the shell's own confirmations (no token) are never remembered
        #expect(deadlines.deadline(token: "", expiresInMs: 60_000, now: now) == now.addingTimeInterval(58))
        #expect(deadlines.deadline(token: "", expiresInMs: 60_000, now: now.addingTimeInterval(10)) == now.addingTimeInterval(68))
        #expect(deadlines.deadline(token: "", expiresInMs: nil, now: now) == nil)
        // a dead token stays dead: reopening its sheet after the deadline gets the passed moment, not a new life
        #expect(deadlines.deadline(token: "tok", expiresInMs: 120_000, now: now.addingTimeInterval(500)) == first)
    }

    // MARK: the field of an input action in a window

    @Test func fieldInAWindowSaysWhyTheTextCannotBeSent() {
        // an empty field is not ready, but nothing is wrong with it yet
        #expect(InputCheck.problem("", maxLength: 10) == nil && !InputCheck.canSend("", maxLength: 10))
        #expect(InputCheck.problem("ok", maxLength: 10) == nil && InputCheck.canSend("ok", maxLength: 10))
        #expect(InputCheck.problem("12345678901", maxLength: 10) == InputCheck.message("input:too-long", maxLength: 10))
        #expect(!InputCheck.canSend("12345678901", maxLength: 10))
        #expect(InputCheck.problem("-x", maxLength: 10) == InputCheck.message("input:option-like") && !InputCheck.canSend("-x", maxLength: 10))
        // the text the core has just refused: its reason stays until the human changes the text
        #expect(InputCheck.problem("123", maxLength: 10, refusedText: "123", refusal: "why") == "why")
        #expect(!InputCheck.canSend("123", maxLength: 10, refusedText: "123"))
        #expect(InputCheck.problem("1234", maxLength: 10, refusedText: "123", refusal: "why") == nil)
        #expect(InputCheck.canSend("1234", maxLength: 10, refusedText: "123"))
    }

    // MARK: the shell has no modal path left

    /// The store only stays live while a window is open if nothing in the shell runs a nested event loop: a modal alert
    /// or `runModal` inside a main-actor task is exactly what froze the icon, the "waiting for you" list and the cards.
    @Test func shellSourcesStartNoModalLoop() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/AgentHub")
        let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil).filter { $0.pathExtension == "swift" }
        #expect(files.count > 10)
        var found: [String] = []
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for (n, line) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let code = line.trimmingCharacters(in: .whitespaces)
                if code.hasPrefix("//") { continue }
                for banned in ["runModal(", "NSAlert(", "beginModalSession(", "beginSheetModal("] where code.contains(banned) {
                    found.append("\(file.lastPathComponent):\(n + 1) \(banned)")
                }
            }
        }
        #expect(found.isEmpty, "a hub window is awaited through HubWindow, never run modally: \(found)")
    }

    @Test func expiredWindowLeavesAShortNotice() {
        #expect(ExpiryNotice.report.title == "Срок запроса вышел")
        #expect(ExpiryNotice.report.detail.contains("Ничего не сделано"))
        #expect(ExpiryNotice.report.rows.isEmpty && !ExpiryNotice.report.canRetry && !ExpiryNotice.report.canFocus, "a notice, not a question")
        #expect(ExpiryNotice.seconds >= 2 && ExpiryNotice.seconds <= 8, "long enough to read, short enough not to be in the way")
    }
}

@Suite(.serialized, .hubLang(.ru)) struct WindowStoreTests {
    private static let confirm = #"{"error":"confirm-required","needsConfirm":true,"token":"tok","level":"confirm-cost","text":"asks","cost":"quota","expiresInMs":120000}"#

    private static func body(_ r: FakeDaemon.Request) -> [String: JSONValue] {
        (try? JSONDecoder().decode([String: JSONValue].self, from: Data(r.body.utf8))) ?? [:]
    }

    @MainActor @Test func storeAppliesStreamEventsWhileAConfirmationIsOpen() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, n in snapshotFrame(n == 0 ? 10 : 11, peer: "app") }
        d.replyBody = { method, uri, raw in
            guard method == "POST", uri == "/actions/run" else { return nil }
            let b = (try? JSONDecoder().decode([String: JSONValue].self, from: Data(raw.utf8))) ?? [:]
            return b["confirmToken"] == nil ? (428, Self.confirm) : (200, #"{"ok":true,"result":{"ok":true,"code":0}}"#)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = QueuePresenter()
        store.presenter = p
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.connection.isLive && store.state?.seq == 10 })

        let action = Task { await store.perform(id: "run", args: nil, label: "Run") }
        #expect(await waitFor { p.screen.shown == ["confirm:Run"] })
        #expect(store.busyAction == "run", "the action is waiting for the human")

        // the window is open and nobody answered — the stream goes on: an event handed to the store is applied …
        store.handle(SSEEvent(id: "10", event: "estop", data: #"{"type":"estop","on":true}"#))
        #expect(store.estop)
        // … and so is whatever the live connection brings (here: a reconnect with a fresh snapshot)
        d.dropStreams()
        #expect(await waitFor { store.state?.seq == 11 && !store.estop })
        #expect(d.eventRequests.count >= 2)
        #expect(p.screen.closed.isEmpty && store.busyAction == "run", "the window is still open")
        #expect(d.requests.filter { $0.uri == "/actions/run" }.count == 1)

        p.screen.answer("confirm:Run", true)
        #expect(await action.value)
        let posts = d.requests.filter { $0.uri == "/actions/run" }
        #expect(posts.count == 2 && Self.body(posts[1])["confirmToken"]?.stringValue == "tok")
        #expect(p.reports.isEmpty && store.busyAction == nil)
    }

    @MainActor @Test func confirmationRunningOutIsAQuietNo() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        // a token that lives 400 ms: the window gives up after 200
        d.reply = { method, uri in
            method == "POST" && uri == "/actions/run"
                ? (428, #"{"error":"confirm-required","needsConfirm":true,"token":"tok","level":"confirm","text":"asks","expiresInMs":400}"#) : nil
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = QueuePresenter()
        store.presenter = p
        let ok = await store.perform(id: "run", args: nil, label: "Run")
        #expect(!ok)
        #expect(p.screen.shown == ["confirm:Run"] && p.screen.closed == ["confirm:Run"], "the window closed by itself")
        #expect(p.reports.isEmpty && p.screen.shown.count == 1, "no second window says the confirmation ran out")
        #expect(d.requests.filter { $0.uri == "/actions/run" }.count == 1, "the dead token is not sent")
        #expect(store.busyAction == nil && !p.queue.isShowing)
        // a click that was already on its way does nothing
        p.screen.answer("confirm:Run", true)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(d.requests.filter { $0.uri == "/actions/run" }.count == 1)
    }

    @MainActor @Test func refusalWaitsBehindAnOpenConfirmation() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.reply = { method, uri in method == "POST" && uri == "/actions/run" ? (428, Self.confirm) : nil }
        let store = HubStore(client: HubClient(socketPath: d.path))
        let p = QueuePresenter()
        store.presenter = p
        let action = Task { await store.perform(id: "run", args: nil, label: "Run") }
        #expect(await waitFor { p.screen.shown == ["confirm:Run"] })
        // another flow has something to say while the confirmation is open: it waits its turn, neither is lost
        let other = Task { await p.report(title: "refused", detail: "why") }
        #expect(await waitFor { p.queue.waitingCount == 1 })
        #expect(p.screen.shown == ["confirm:Run"])
        p.screen.answer("confirm:Run", false)
        #expect(await action.value == false)
        #expect(await waitFor { p.screen.shown == ["confirm:Run", "report:refused"] })
        p.screen.answer("report:refused", nil)
        await other.value
        #expect(p.screen.closed == ["confirm:Run", "report:refused"] && !p.queue.isShowing)
    }
}
