import Foundation

// The hub's windows (confirmations, refusals, permissions, typed text, removal …) are not modal: a modal loop
// (`NSApp.runModal`) spins inside a main-actor task, and while it does nothing else on the main actor runs — the store
// stops applying stream events, so the menu bar icon, the "Needs you" list and the answer cards stand still. A
// window is shown as a plain panel instead and its answer is awaited. This file is the part without AppKit: whose turn
// it is, when a window gives up by itself, and that whoever waits is resumed exactly once.

/// How a hub window ended.
public enum WindowResult<Value: Sendable>: Sendable {
    /// The human pressed a button (sent the field).
    case answer(Value)
    /// Esc, the window was closed, the app is quitting — or the window never got its turn before the app quit.
    case cancelled
    /// The deadline passed (a confirmation token's lifetime): the window closed by itself, or was never shown because
    /// the deadline passed while it waited in the queue.
    case expired

    /// The answer, if there was one.
    public var value: Value? {
        if case .answer(let v) = self { return v }
        return nil
    }
}

extension WindowResult: Equatable where Value: Equatable {}

/// One hub window on screen at a time; the next request waits for the current window to end. A queue rather than
/// windows on top of each other or a refusal: a second window almost always belongs to another flow (a refusal from a
/// setting while a confirmation is open), both need the human, and neither may be lost or cover the other.
///
/// The shell supplies `show`: put the window on screen, call `answer` when the human answers (nil — Esc or closed), and
/// return how to take the window off the screen. However many times and from wherever `answer`, the deadline and
/// `cancelAll` fire, the awaiting side is resumed once, with the first of them.
@MainActor
public final class WindowQueue {
    /// Takes the window off the screen. Called once, when the window ends.
    public typealias Close = @MainActor () -> Void
    /// Hands the human's answer back; nil — cancelled. Only the first call counts.
    public typealias Answer<Value> = @MainActor (Value?) -> Void

    private var current: Pending?
    private var waiting: [Pending] = []
    private let now: () -> Date

    public init(now: @escaping () -> Date = { Date() }) { self.now = now }

    /// A window is on screen.
    public var isShowing: Bool { current != nil }
    /// Requests waiting for the window on screen to end.
    public var waitingCount: Int { waiting.count }

    /// Ask for a window and wait for how it ends. `deadline` — the moment the window stops making sense (a confirmation
    /// token's lifetime, counted from when the request came, not from when the window got its turn): the window is closed
    /// then and the result is `.expired`.
    public func present<Value: Sendable>(until deadline: Date? = nil,
                                         show: @escaping @MainActor (_ answer: @escaping Answer<Value>) -> Close) async -> WindowResult<Value> {
        await withCheckedContinuation { continuation in
            waiting.append(Slot<Value>(queue: self, deadline: deadline, show: show, continuation: continuation))
            advance()
        }
    }

    /// End every window as cancelled — the one on screen and those waiting (the app is quitting).
    public func cancelAll() {
        let rest = waiting
        waiting = []
        for slot in rest { slot.cancel() }
        current?.cancel()
    }

    private func advance() {
        guard current == nil, !waiting.isEmpty else { return }
        let next = waiting.removeFirst()
        current = next
        next.open(now: now())
    }

    fileprivate func ended(_ slot: Pending) {
        guard current === slot else { return }
        current = nil
        advance()
    }

    /// A request without its value type, so requests of different kinds share one line.
    @MainActor
    fileprivate class Pending {
        func open(now: Date) {}
        func cancel() {}
    }

    @MainActor
    private final class Slot<Value: Sendable>: Pending {
        private weak var queue: WindowQueue?
        private let deadline: Date?
        private let show: @MainActor (@escaping Answer<Value>) -> Close
        /// nil once resumed — what makes the resume happen exactly once.
        private var continuation: CheckedContinuation<WindowResult<Value>, Never>?
        private var close: Close?
        private var timer: Task<Void, Never>?

        init(queue: WindowQueue, deadline: Date?, show: @escaping @MainActor (@escaping Answer<Value>) -> Close,
             continuation: CheckedContinuation<WindowResult<Value>, Never>) {
            self.queue = queue; self.deadline = deadline; self.show = show; self.continuation = continuation
        }

        override func open(now: Date) {
            // its time ran out in the queue: an expired confirmation is not worth showing
            if let deadline, deadline <= now { finish(.expired); return }
            let close = show { [weak self] value in self?.finish(value.map { .answer($0) } ?? .cancelled) }
            // answered while being shown (a window that could not be built): nothing is on screen to wait for
            guard continuation != nil else { close(); return }
            self.close = close
            if let deadline {
                timer = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSince(now))))
                    guard !Task.isCancelled else { return }
                    self?.finish(.expired)
                }
            }
        }

        override func cancel() { finish(.cancelled) }

        private func finish(_ result: WindowResult<Value>) {
            // closing the window may report "closed" back here — by then this request is already over
            guard let continuation else { return }
            self.continuation = nil
            timer?.cancel()
            timer = nil
            let close = self.close
            self.close = nil
            close?()
            continuation.resume(returning: result)
            queue?.ended(self)
        }
    }
}

/// What the human is told when a window closed because its time ran out: a short notice that goes away by itself, so a
/// window that vanished (or never got its turn) is not a riddle.
public enum ExpiryNotice {
    /// How long the notice stays on screen unless the human closes it sooner.
    public static let seconds: TimeInterval = 4
    public static var report: Report {
        Report(title: tr("Срок запроса вышел", "The request timed out"),
               detail: tr("Ничего не сделано. Повторите действие, если оно ещё нужно.", "Nothing was done. Repeat the action if you still need it."))
    }
}

/// When a confirmation or consent window gives up: the core's token lives `expiresInMs` from the moment it was issued,
/// and a click after that only gets "confirm again". The window shows the remaining time and closes at the deadline.
public enum WindowExpiry {
    /// The window closes this long before the token dies, so a click at the last second still reaches the core in time.
    public static let margin: TimeInterval = 2

    /// The moment to close a window for a token that lives `expiresInMs` from `now`; nil — the request has no lifetime
    /// (the shell's own confirmations).
    public static func deadline(expiresInMs: Int?, now: Date = Date()) -> Date? {
        guard let ms = expiresInMs, ms > 0 else { return nil }
        let life = Double(ms) / 1000
        return now.addingTimeInterval(life - min(margin, life / 2))
    }

    /// The small print in a confirmation: how long it is still valid; in the last seconds — what is about to happen,
    /// so the window going away is no surprise.
    public static func confirmText(until: Date, now: Date = Date()) -> String {
        let left = Countdown.text(until: until, now: now)
        if isLast(until: until, now: now) { return tr("Окно закроется через \(left)", "Closes in \(left)") }
        return tr("Подтверждение действует ещё \(left)", "Valid for \(left)")
    }

    /// The same for the permissions window (a sentence of its note).
    public static func consentText(until: Date, now: Date = Date()) -> String {
        let left = Countdown.text(until: until, now: now)
        if isLast(until: until, now: now) { return tr("Окно закроется через \(left).", "The window closes in \(left).") }
        return tr("Согласие действует ещё \(left).", "Consent is valid for \(left).")
    }

    /// The last seconds are shown louder.
    public static func isLast(until: Date, now: Date = Date()) -> Bool { until.timeIntervalSince(now) <= 10 }
}

/// Deadlines by token: a window for the same token may be shown again (the core refused the typed text and the sheet
/// reopens with the reason) — its time still runs from the first showing, not from the reopening.
@MainActor
public final class TokenDeadlines {
    private var byToken: [String: Date] = [:]

    public init() {}

    /// The deadline for this token: remembered from the first call, and kept once it has passed — a dead token gets no
    /// new life from being asked about again. An empty token (the shell's own confirmations) is not remembered.
    public func deadline(token: String, expiresInMs: Int?, now: Date = Date()) -> Date? {
        byToken = byToken.filter { $0.value > now || $0.key == token }
        if !token.isEmpty, let known = byToken[token] { return known }
        let d = WindowExpiry.deadline(expiresInMs: expiresInMs, now: now)
        if !token.isEmpty, let d { byToken[token] = d }
        return d
    }
}
