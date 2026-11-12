import Testing
@testable import AgentHubKit

/// Re-review 62: every test case runs with a language of its own (`L10n.$scope`), whatever the macOS language and whatever
/// other suites running in parallel do. A suite trait applies to each of its tests (recursive); a test that switches the
/// language (`L10n.shared.lang = .en`) changes only its own scope.
struct HubLangTrait: SuiteTrait, TestTrait, TestScoping {
    let lang: Lang
    var isRecursive: Bool { true }

    func provideScope(for test: Test, testCase: Test.Case?, performing function: @Sendable () async throws -> Void) async throws {
        // the suite itself: its tests get their own scopes
        if testCase == nil && test.isSuite { return try await function() }
        try await L10n.$scope.withValue(LangScope(lang)) { try await function() }
    }
}

extension Trait where Self == HubLangTrait {
    /// The language the test expects (the texts in the assertions are in it).
    static func hubLang(_ lang: Lang) -> Self { HubLangTrait(lang: lang) }
}
