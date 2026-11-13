import Foundation
import Testing
@testable import AgentHubKit

// Review 3 (2026-11-12), tasks 85 and 86: the "catalog not connected" note names the built-in plugins from the state, and
// the language setting is scoped per test case like the language itself.
@Suite(.hubLang(.ru)) struct Review3AppTests {
    @Test func catalogNoteNamesBuiltinsFromState() {
        #expect(RegistryText.worksWithout(builtin: ["Alpha Sessions", " ", "Beta Spend"])
                == "Из каталога ставятся официальные плагины. Встроенные (Alpha Sessions, Beta Spend) и свои из папки работают и без него.")
        #expect(RegistryText.worksWithout(builtin: []) == "Из каталога ставятся официальные плагины. Встроенные и свои из папки работают и без него.",
                "no state yet: no list rather than names the shell would have to know")
        L10n.shared.lang = .en
        #expect(RegistryText.worksWithout(builtin: ["Gamma"]) == "Official plugins come from the catalog. Built-in ones (Gamma) and your own from a folder work without it.")
    }

    @Test func languageSettingStaysInItsScope() async {
        L10n.shared.setting = .ru
        await L10n.$scope.withValue(LangScope(.ru)) {
            #expect(L10n.shared.setting == .system && !L10n.shared.settingKnown, "a fresh scope starts with an unknown setting")
            L10n.shared.apply(setting: "en", effective: "en")
            #expect(L10n.shared.setting == .en && L10n.shared.settingKnown && L10n.shared.lang == .en)
        }
        #expect(L10n.shared.setting == .ru, "the inner scope's apply() did not leak into this test's scope")
        #expect(!L10n.shared.settingKnown)
        // a separate instance is never scoped: its own values, the scope untouched
        let own = L10n()
        own.apply(setting: "en", effective: "en")
        #expect(own.setting == .en && own.settingKnown)
        #expect(L10n.shared.setting == .ru && !L10n.shared.settingKnown)
    }
}

// 13.11: the "New session" Remote Control switch — `remote: false` only when it is off (an older daemon keeps working).
@Suite(.hubLang(.ru)) struct LaunchRemoteSwitchTests {
    @Test func remoteArgumentOnlyWhenOff() {
        var d = LaunchDraft()
        d.folder = "/tmp/x"; d.name = "n"
        #expect(d.args["remote"] == nil)
        d.remoteControl = false
        #expect(d.args["remote"] == .bool(false))
    }
}
