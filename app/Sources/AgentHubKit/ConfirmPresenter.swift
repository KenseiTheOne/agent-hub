import Foundation

// How the store reports to the human and asks them: the report a window shows, and the presenter protocol the
// AgentHub target implements with the hub's own windows (tests use a double).

/// What the shell tells the human when something didn't work. `title` is the reason in one phrase, `rows` say what and
/// where, `hint` — what to do, `code` — the small print for a bug report. `canFocus` / `canRetry` add the "Go to tab" and
/// "Try again" buttons. `plainTitle` / `plainDetail` — the same for a presenter that has two strings only.
public struct Report: Sendable, Equatable {
    public struct Row: Sendable, Equatable {
        public var label: String
        public var value: String
        public var note: String?
        public init(label: String, value: String, note: String? = nil) { self.label = label; self.value = value; self.note = note }
    }
    public var title: String
    public var detail: String
    public var rows: [Row]
    public var hint: String?
    public var code: String?
    public var canFocus: Bool
    public var canRetry: Bool
    public var plainTitle: String
    public var plainDetail: String

    public init(title: String, detail: String = "", rows: [Row] = [], hint: String? = nil, code: String? = nil, canFocus: Bool = false, canRetry: Bool = false,
                plainTitle: String? = nil, plainDetail: String? = nil) {
        self.title = title; self.detail = detail; self.rows = rows; self.hint = hint; self.code = code; self.canFocus = canFocus; self.canRetry = canRetry
        self.plainTitle = plainTitle ?? title; self.plainDetail = plainDetail ?? detail
    }
}

/// What the human pressed in a report window.
public enum ReportChoice: Sendable, Equatable { case ok, focus, retry }

extension ConfirmPresenter {
    /// A report with rows and buttons. The default shows its two plain strings and offers nothing.
    public func report(_ report: Report) async -> ReportChoice {
        await self.report(title: report.plainTitle, detail: report.plainDetail)
        return .ok
    }
}

/// How the shell asks the human. Implementation — the hub's own windows in the AgentHub target (`AlertPresenter`: one
/// window at a time through `WindowQueue`); in tests — a double.
///
/// Every method is awaited and none may block the main actor: a window is a non-modal panel whose answer comes back
/// through a continuation, so while it is open the store keeps applying stream events (the menu bar icon, the
/// "Needs you" list and the answer cards stay live). A method returns when the human has answered or the window
/// was closed another way (Esc, the token's lifetime ran out, the app is quitting) — the "no" answer in each case.
@MainActor
public protocol ConfirmPresenter: AnyObject {
    /// Show the text and cost **from the core**; true — the human agreed. false also when the confirmation's lifetime
    /// (`expiresInMs`) ran out with the window open: the window closes by itself and a short notice says so (`ExpiryNotice`).
    func confirm(_ request: ConfirmRequest, actionLabel: String) async -> Bool
    /// Show a core refusal or a connection error; returns when the human has closed it.
    func report(title: String, detail: String) async
    /// A refusal with rows, advice and buttons ("Go to tab", "Try again"); what the human pressed. A requirement, not
    /// only an extension method — the store holds the presenter as `any ConfirmPresenter`. Default: the two plain strings.
    @discardableResult func report(_ report: Report) async -> ReportChoice
    /// Plugin permissions window (`428 consent-required`): permissions with "why", new ones marked. true — the human agreed.
    func consent(_ request: ConsentRequest) async -> Bool
    /// Typed text for an input action (G1): the field alone (immediate) or inside the core's confirmation (`request.confirm`).
    /// nil — the human cancelled. Default (PluginInput.swift): nil.
    func prompt(_ request: InputPrompt) async -> String?
    /// The registry key window (`428 consent-required`, `kind: "registry-key"`): both fingerprints and what accepting
    /// means. true — the human accepted the new key. Default (below): false — a presenter without the window accepts nothing.
    func registryKey(_ request: RegistryKeyConsent) async -> Bool
}

extension ConfirmPresenter {
    public func registryKey(_ request: RegistryKeyConsent) async -> Bool { false }
}
