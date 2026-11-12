import Foundation
import Testing
@testable import AgentHubKit

// Daemon and app lifecycle (2026-11-06): quitting the app asks the daemon to exit (POST /shutdown), starting
// the app without a daemon brings up the launchd job (`launchctl kickstart`) — via a substitutable runner.

/// Runner double: records calls and answers with codes per launchctl subcommand; onRun — what else to do
/// (e.g. "bring up the daemon" on kickstart).
final class RecordingRunner: CommandRunner, @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [[String]] = []
    let codes: [String: Int32]
    let onRun: (@Sendable ([String]) -> Void)?
    init(codes: [String: Int32] = [:], onRun: (@Sendable ([String]) -> Void)? = nil) { self.codes = codes; self.onRun = onRun }
    var calls: [[String]] { lock.withLock { _calls } }
    func run(_ executable: String, _ arguments: [String]) async -> Int32 {
        lock.withLock { _calls.append([executable] + arguments) }
        onRun?(arguments)
        return codes[arguments.first ?? ""] ?? 0
    }
}

/// A daemon double that comes up on the first kickstart and goes away after `lifetime`.
final class KickstartedDaemon: @unchecked Sendable {
    private let lock = NSLock()
    private var daemon: FakeDaemon?
    private var started = false
    let path: String
    let lifetime: Double
    init(path: String, lifetime: Double) { self.path = path; self.lifetime = lifetime }
    func kick(_ args: [String]) {
        guard args.first == "kickstart" else { return }
        let first: Bool = lock.withLock { defer { started = true }; return !started }
        guard first, let d = try? FakeDaemon(path: path) else { return }
        d.events = { _, _ in snapshotFrame(1, peer: "app") }
        lock.withLock { daemon = d }
        DispatchQueue.global().asyncAfter(deadline: .now() + lifetime) { [weak self] in self?.stop() }
    }
    /// Once only: stopping the NIO double again would hang on a closed group.
    func stop() {
        let d: FakeDaemon? = lock.withLock { defer { daemon = nil }; return daemon }
        d?.shutdown()
    }
}

@Suite(.serialized, .hubLang(.ru)) struct LifecycleTests {
    @MainActor @Test func quitSendsShutdownFromPinnedBuild() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in snapshotFrame(1, peer: "app") }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        #expect(await waitFor { store.peer?.isApp == true })
        let r = await store.shutdownDaemonOnQuit(arguments: ["AgentHub"])
        #expect(r == .requested)
        #expect(d.requests.contains { $0.method == "POST" && $0.uri == "/shutdown" })
        #expect(store.quitting)
    }

    @MainActor @Test func quitSkipsShutdownForUnpinnedOrDiagnostic() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.peerClass = "cli"
        d.events = { _, _ in snapshotFrame(1, peer: "cli") }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        #expect(await waitFor { store.peer?.isApp == false })
        #expect(await store.shutdownDaemonOnQuit(arguments: ["AgentHub"]) == .skipped)
        #expect(!d.requests.contains { $0.uri == "/shutdown" }, "an unpinned copy doesn't stop the daemon")
        #expect(QuitPolicy.isDiagnostic(arguments: ["AgentHub", "--snapshot-panel", "/tmp/x.png", "--quit-after-snapshot"]))
        #expect(!QuitPolicy.shouldStopDaemon(peer: PeerInfo(class: "app", reason: nil), arguments: ["AgentHub", "--self-test-popover"]))
        #expect(QuitPolicy.shouldStopDaemon(peer: nil, arguments: ["AgentHub"]), "class not known yet — the daemon decides")
    }

    @MainActor @Test func startWithoutDaemonCallsKickstart() async throws {
        // the daemon came up on kickstart and left again after 0.3 s: the next kickstart only after a pause
        let path = "/tmp/ahf-kick-\(UUID().uuidString.prefix(6)).sock"
        let home = (path as NSString).deletingLastPathComponent
        let fake = KickstartedDaemon(path: path, lifetime: 0.3)
        defer { fake.stop() }
        let runner = RecordingRunner(onRun: { fake.kick($0) })
        let store = HubStore(client: HubClient(socketPath: path))
        store.daemonStarter = DaemonStarter(home: home, defaultHome: home, uid: 501, runner: runner)
        store.daemonSocketWait = 1
        store.daemonStartCooldown = 2.5
        store.start()
        defer { store.stop() }
        #expect(await waitFor { runner.calls.count >= 2 })
        let t0 = Date()
        #expect(runner.calls[0] == ["/bin/launchctl", "print", "gui/501/com.kensei.agenthub"])
        #expect(runner.calls[1] == ["/bin/launchctl", "kickstart", "gui/501/com.kensei.agenthub"])
        // the daemon left, the stream reconnects (0.5 → 1 s), but until the pause ends — not a single new call
        try? await Task.sleep(for: .milliseconds(1500))
        #expect(runner.calls.count == 2, "pause between attempts to bring up the daemon")
        // the pause is over — brings it up again
        #expect(await waitFor(8) { runner.calls.count >= 4 })
        #expect(Date().timeIntervalSince(t0) >= 2.4)
    }

    @MainActor @Test func kickstartWithoutSocketIsNotCountedInCooldown() async throws {
        // kickstart returned 0 but the socket didn't appear (the job was still stopping): the next reconnect
        // brings it up again without waiting for the 30-second pause
        let home = "/tmp/ahf-kick-\(UUID().uuidString.prefix(6))"
        let runner = RecordingRunner()
        let store = HubStore(client: HubClient(socketPath: home + "/hub.sock"))
        store.daemonStarter = DaemonStarter(home: home, defaultHome: home, uid: 501, runner: runner)
        store.daemonSocketWait = 0.3
        store.start()
        defer { store.stop() }
        #expect(await waitFor(5) { runner.calls.count >= 4 })
        #expect(runner.calls.map { $0[1] }.prefix(4) == ["print", "kickstart", "print", "kickstart"])
    }

    @Test func diagnosticLaunchesDoNotStartDaemon() {
        for a in ["--snapshot-panel", "--quit-after-snapshot", "--snapshot-menubar", "--print-status-item", "--show-popover", "--self-test-popover", "--self-test-status-menu"] {
            #expect(!QuitPolicy.startsDaemon(arguments: ["AgentHub", a]), "\(a) — doesn't bring up the daemon")
            #expect(QuitPolicy.isDiagnostic(arguments: ["AgentHub", a]), "\(a) — and doesn't stop it")
        }
        #expect(QuitPolicy.startsDaemon(arguments: ["AgentHub"]))
        #expect(QuitPolicy.startsDaemon(arguments: ["AgentHub", "--open-panel"]))
    }

    @Test func appPinPathChangedUpdatesSnapshot() throws {
        let ev = SSEEvent(id: "5", event: "app-pin.path-changed", data: #"{"appPin":{"kind":"cdhash","fingerprint":"cdhash:\#(String(repeating: "a", count: 40))","path":"/Users/x/AgentHub.app"},"old":"/Users/y/AgentHub.app"}"#)
        let hub = try #require(HubEvent.decode(ev))
        guard case .appPinPathChanged(let p) = hub else { Issue.record("not app-pin.path-changed"); return }
        #expect(p.path == "/Users/x/AgentHub.app")
        var st = HubState()
        let changed = st.apply(hub)
        #expect(changed)
        #expect(st.appPin?.path == "/Users/x/AgentHub.app")
        #expect(JournalEntry(index: 0, raw: ["type": .string("app-pin-path-changed")]).typeLabel != "app-pin-path-changed")
    }

    @MainActor @Test func notInstalledShowsBannerWithoutKickstart() async throws {
        let home = "/tmp/ahf-kick-\(UUID().uuidString.prefix(6))"
        let runner = RecordingRunner(codes: ["print": 113])
        let store = HubStore(client: HubClient(socketPath: home + "/hub.sock"))
        store.daemonStarter = DaemonStarter(home: home, defaultHome: home, uid: 501, runner: runner)
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.daemonLaunch == .notInstalled })
        #expect(runner.calls.map { $0[1] } == ["print"], "no job — kickstart isn't called")
        #expect(store.daemonLaunch.offlineTitle.contains("launchd"))
        #expect(store.daemonLaunch.offlineHint?.contains("install --apply") == true)
    }

    @MainActor @Test func testCopyNeverTouchesLaunchd() async throws {
        let runner = RecordingRunner()
        let s = DaemonStarter(home: "/tmp/ahf-test-home", defaultHome: "/Users/x/Library/Application Support/AgentHub", uid: 501, runner: runner)
        #expect(!s.enabled)
        #expect(await s.start() == .skipped)
        #expect(runner.calls.isEmpty)
        let store = HubStore(client: HubClient(socketPath: "/tmp/ahf-test-home/hub.sock"))
        store.daemonStarter = s
        store.start()
        defer { store.stop() }
        try? await Task.sleep(for: .milliseconds(800))
        #expect(runner.calls.isEmpty)
    }

    @MainActor @Test func quittingDoesNotRestartDaemon() async throws {
        let d = try FakeDaemon()
        d.events = { _, _ in snapshotFrame(1, peer: "app") }
        let runner = RecordingRunner()
        let home = (d.path as NSString).deletingLastPathComponent
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.daemonStarter = DaemonStarter(home: home, defaultHome: home, uid: 501, runner: runner)
        store.start()
        #expect(await waitFor { store.connection.isLive })
        #expect(await store.shutdownDaemonOnQuit(arguments: ["AgentHub"]) == .requested)
        // the daemon left after the app — the shell doesn't bring it up again, even if the stream is started anew
        // ("Retry" button, start()): the quitting flag guards this, not the cancelled stream task
        d.shutdown()
        store.daemonSocketWait = 0.2
        store.reconnect()
        defer { store.stop() }
        try? await Task.sleep(for: .milliseconds(1200))
        #expect(runner.calls.isEmpty)
    }
}

// "Launch at login" (decision 2026-11-07): the setting for the daemon + app pair lives in the daemon.
@Suite(.serialized, .hubLang(.ru)) struct LaunchAtLoginTests {
    @MainActor @Test func launchAtLoginWritesToDaemonAndFollowsEvents() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in snapshotFrame(1, peer: "app") }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.peer?.isApp == true })
        #expect(store.state?.launchAtLogin == nil, "older daemon — no setting")
        await store.setLaunchAtLogin(false)
        #expect(d.requests.contains { $0.method == "PUT" && $0.uri == "/settings/launch-at-login" })
        #expect(store.state?.launchAtLogin?.setting == false)
    }

    @MainActor @Test func settingsChangedEventUpdatesLaunchAtLogin() async throws {
        let d = try FakeDaemon()
        defer { d.shutdown() }
        d.events = { _, _ in
            snapshotFrame(1, peer: "app") + sseFrame(2, "settings.changed", #"{"id":2,"type":"settings.changed","launchAtLogin":false}"#)
        }
        let store = HubStore(client: HubClient(socketPath: d.path))
        store.start()
        defer { store.stop() }
        #expect(await waitFor { store.state?.launchAtLogin?.setting == false })
    }

    @Test func stateDecodesLaunchAtLogin() throws {
        let on = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"launchAtLogin":{"setting":true}}"#.utf8))
        #expect(on.launchAtLogin?.setting == true)
        let off = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"launchAtLogin":{"setting":false}}"#.utf8))
        #expect(off.launchAtLogin?.setting == false)
        let old = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1}"#.utf8))
        #expect(old.launchAtLogin == nil)
        let hub = try JSONDecoder().decode(HubInfo.self, from: Data(#"{"home":"/h","testMode":false,"cli":"/x/agenthub"}"#.utf8))
        #expect(hub.cli == "/x/agenthub")
    }

    @Test func legacyLoginItemIsRetiredOnlyForLiveHub() throws {
        let live = "/Users/x/Library/Application Support/AgentHub"
        let ready = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"launchAtLogin":{"setting":true,"launchAgent":"ok"},"appPin":{"kind":"cdhash","fingerprint":"cdhash:x","path":"/Apps/AgentHub.app"}}"#.utf8))
        #expect(LegacyLoginItem.shouldUnregister(registered: true, arguments: ["AgentHub"], home: live, defaultHome: live, state: ready))
        #expect(!LegacyLoginItem.shouldUnregister(registered: false, arguments: ["AgentHub"], home: live, defaultHome: live, state: ready), "nothing to unregister")
        #expect(!LegacyLoginItem.shouldUnregister(registered: true, arguments: ["AgentHub", "--snapshot-panel", "/tmp/x.png"], home: live, defaultHome: live, state: ready), "diagnostic run")
        #expect(!LegacyLoginItem.shouldUnregister(registered: true, arguments: ["AgentHub"], home: "/tmp/ahl", defaultHome: live, state: ready), "test copy")
    }

    /// Review: unregister only when the daemon will definitely launch the app at login itself.
    @Test func legacyLoginItemStaysUntilDaemonLaunchesApp() throws {
        let live = "/Users/x/Library/Application Support/AgentHub"
        func st(_ json: String) throws -> HubState { try JSONDecoder().decode(HubState.self, from: Data(json.utf8)) }
        let pin = #""appPin":{"kind":"cdhash","fingerprint":"cdhash:x","path":"/Apps/AgentHub.app"}"#
        #expect(!LegacyLoginItem.shouldUnregister(registered: true, arguments: ["AgentHub"], home: live, defaultHome: live, state: nil), "no snapshot yet")
        #expect(!LegacyLoginItem.daemonLaunchesApp(try st("{\"seq\":1,\(pin)}")), "daemon predates supervision: no launchAtLogin")
        #expect(!LegacyLoginItem.daemonLaunchesApp(try st(#"{"seq":1,"launchAtLogin":{"setting":true},"appPin":{"kind":"cdhash","fingerprint":"cdhash:x"}}"#)), "pin without a path (--cert, written before 2026-11-06)")
        #expect(!LegacyLoginItem.daemonLaunchesApp(try st(#"{"seq":1,"launchAtLogin":{"setting":true},"appPin":{"kind":"cdhash","fingerprint":"cdhash:x","path":""}}"#)))
        #expect(!LegacyLoginItem.daemonLaunchesApp(try st("{\"seq\":1,\"launchAtLogin\":{\"setting\":true,\"launchAgent\":\"missing\"},\(pin)}")), "LaunchAgent not installed")
        #expect(LegacyLoginItem.daemonLaunchesApp(try st("{\"seq\":1,\"launchAtLogin\":{\"setting\":true},\(pin)}")), "the daemon didn't check the LaunchAgent — as before")
        #expect(LegacyLoginItem.daemonLaunchesApp(try st("{\"seq\":1,\"launchAtLogin\":{\"setting\":false,\"launchAgent\":\"outdated\"},\(pin)}")))
    }

    /// Review: an old LaunchAgent — a flag in /state, the toggle is locked.
    @Test func launchAgentOutdatedFlag() throws {
        let s = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"launchAtLogin":{"setting":true,"launchAgent":"outdated"}}"#.utf8))
        #expect(s.launchAtLogin?.agentOutdated == true && s.launchAtLogin?.launchAgent == "outdated")
        let ok = try JSONDecoder().decode(HubState.self, from: Data(#"{"seq":1,"launchAtLogin":{"setting":true}}"#.utf8))
        #expect(ok.launchAtLogin?.agentOutdated == false && ok.launchAtLogin?.launchAgent == nil)
        #expect(LaunchAgentHint.text.contains("install --apply"))
    }

    @Test func pinPathHintWhenPinnedWithoutPath() {
        #expect(!PinPathHint.needed(nil))
        #expect(!PinPathHint.needed(AppPinInfo(kind: "none", fingerprint: "none")), "not pinned — its own red banner")
        #expect(!PinPathHint.needed(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:x", path: "/Apps/AgentHub.app")))
        #expect(PinPathHint.needed(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:x")))
        #expect(PinPathHint.needed(AppPinInfo(kind: "cdhash", fingerprint: "cdhash:x", path: "")))
        let live = HubInfo(home: "/Users/x/Library/Application Support/AgentHub", testMode: false, cli: "/Users/x/agent-hub/daemon/bin/agenthub")
        #expect(PinPathHint.command(hub: live, bundlePath: "/Users/x/agent-hub/app/build/AgentHub.app")
                == "env -u NODE_OPTIONS node /Users/x/agent-hub/daemon/bin/agenthub pin-app /Users/x/agent-hub/app/build/AgentHub.app")
        let test = HubInfo(home: "/tmp/ah l", testMode: true, cli: "/r/daemon/bin/agenthub")
        let cmd = PinPathHint.command(hub: test, bundlePath: "/tmp/b/AgentHub.app")
        #expect(cmd.hasPrefix("AGENTHUB_HOME='/tmp/ah l' env -u NODE_OPTIONS node /r/daemon/bin/agenthub pin-app"))
        #expect(PinPathHint.command(hub: nil, bundlePath: nil).hasPrefix("env -u NODE_OPTIONS node agenthub pin-app <"), "unpinned copy — a placeholder instead of its own path")
    }
}

@Test(.hubLang(.ru)) func lifecycleJournalLabels() {
    func label(_ type: String, _ f: [String: JSONValue] = [:]) -> String {
        JournalEntry(index: 0, raw: f.merging(["type": .string(type)]) { a, _ in a }).typeLabel
    }
    // parallel tests switch the language — check not the text but that labels exist and differ
    for t in ["shutdown-requested", "app-lost", "app-launch", "app-launch-skipped", "app-restart-stopped", "app-supervise", "app-supervise-resumed"] {
        #expect(label(t) != t, "\(t) — with a human-readable label")
    }
    #expect(label("stop", ["reason": .string("shutdown")]) != label("stop"))
    #expect(label("app-launch", ["reason": .string("lost")]) != label("app-launch", ["reason": .string("start")]))
    // "Launch at login" and the build path (2026-11-07)
    #expect(label("stop", ["reason": .string("login-off")]) != label("stop"))
    let gate = ["wait", "stay", "exit"].map { label("app-login-gate", ["decision": .string($0)]) }
    #expect(Set(gate).count == 3 && !gate.contains("app-login-gate"))
    #expect(label("app-launch-skipped", ["why": .string("no-path")]).contains("agenthub pin-app"))
    #expect(label("hub-update-ready") != "hub-update-ready")
    #expect(JournalEntry(index: 0, raw: ["type": .string("shutdown-requested")]).isAction)
}

@Test(.hubLang(.ru)) func daemonProbeSeesListeningSocket() throws {
    #expect(!DaemonProbe.listening("/tmp/ahf-none-\(UUID().uuidString.prefix(6)).sock"), "no file — no daemon")
    let d = try FakeDaemon()
    #expect(DaemonProbe.listening(d.path), "the double is listening — daemon present, no kickstart needed")
    d.shutdown()
    #expect(!DaemonProbe.listening(d.path))
}
