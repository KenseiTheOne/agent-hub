import Foundation

// The live stream of `GET /events`: connecting and reconnecting, bringing the daemon up, applying each event to the
// store's state; the journal load.

extension HubStore {
    // MARK: - live stream

    /// Connect to `GET /events` and keep the stream; on a drop — reconnect with backoff 0.5 → 30 s.
    public func start() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                // the store is held for one pass only, never across the backoff sleep
                guard let delay = await self?.streamPass() else { return }
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    /// One connection attempt: keep the stream until it drops, then say how long to wait before the next attempt
    /// (nil — the task was cancelled).
    private func streamPass() async -> Double? {
        await runStream()
        if Task.isCancelled { return nil }
        let delay = backoff
        backoff = min(backoff * 2, Self.maxBackoff)
        return delay
    }

    public func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Reconnect right away (the "Try again" button). The daemon is started again without a pause between attempts.
    public func reconnect() {
        stop()
        backoff = Self.minBackoff
        lastDaemonStart = nil
        connection = .connecting
        start()
    }

    /// No connection and no daemon (no socket or the connection was refused — `DaemonProbe`): start the launchd job and
    /// wait for the socket. The daemon is alive but closed the stream (re-pin, drop) — leave it alone. No more often than once per
    /// `daemonStartCooldown`; not while quitting and not for a test copy.
    func startDaemonIfNeeded() async {
        guard let starter = daemonStarter, starter.enabled, !quitting else { return }
        if DaemonProbe.listening(client.socketPath) { return }
        if let t = lastDaemonStart, Date().timeIntervalSince(t) < daemonStartCooldown { return }
        lastDaemonStart = Date()
        daemonLaunch = .starting
        switch await starter.start() {
        case .started:
            daemonLaunch = .idle
            let until = Date().addingTimeInterval(daemonSocketWait)
            while Date() < until, HubPaths.checkSocket(client.socketPath) != nil, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
            }
            // kickstart succeeded but there's no socket: the job was still stopping (kickstart into an exiting process returns 0 but
            // starts nothing) — don't count the attempt, the next reconnection will start it again
            if HubPaths.checkSocket(client.socketPath) != nil { lastDaemonStart = nil }
            backoff = Self.minBackoff
        case .notInstalled: daemonLaunch = .notInstalled
        case .failed(let c): daemonLaunch = .failed(c)
        case .skipped: daemonLaunch = .idle
        }
    }

    /// The live hub can be restarted from the app (a test copy has no launchd job).
    public var canRestartHub: Bool { daemonStarter?.enabled == true }

    /// "Restart hub": start the detached restart (`DaemonStarter.restartArguments`) and mark the quit as a restart, so
    /// the app quits without `/shutdown` (that would stop the daemon for good instead of letting launchd bring it up).
    /// true — started, the caller quits the app; false — nothing was done.
    @discardableResult
    public func restartHub(appPath: String, launch: (String, [String]) -> Bool = HubStore.launchDetached) -> Bool {
        guard let starter = daemonStarter, starter.enabled else { return false }
        hubRestarting = true
        if launch("/bin/sh", starter.restartArguments(appPath: appPath)) { return true }
        hubRestarting = false
        return false
    }

    /// Start a process and don't wait for it: it outlives the app that started it.
    public nonisolated static func launchDetached(_ executable: String, _ arguments: [String]) -> Bool {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = arguments
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run(); return true } catch { return false }
    }

    /// Quitting the app: stop the stream and ask the daemon to exit (`POST /shutdown`) if this copy is
    /// the pinned build. We wait no longer than 2 s for the reply.
    public func shutdownDaemonOnQuit(arguments: [String] = CommandLine.arguments) async -> QuitShutdown {
        quitting = true
        stop()
        // quitting for a hub update: the daemon restarts itself (code 75), /shutdown would stop it for good
        if hubRestarting { return .skipped }
        guard QuitPolicy.shouldStopDaemon(peer: peer, arguments: arguments), HubPaths.checkSocket(client.socketPath) == nil else { return .skipped }
        do {
            let r = try await client.shutdown()
            return r.status == 202 ? .requested : .failed(r.code ?? "http-\(r.status)")
        } catch {
            return .failed((error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
    }

    private func runStream() async {
        if !connection.isLive { connection = .connecting }
        if lastEventId != nil {
            if snapshotNext {
                lastEventId = nil
            } else if let pid = try? await client.daemonPid(), pid != state?.pid {
                // Event numbers restart in a new daemon instance: an old Last-Event-ID could
                // collide with other events and the daemon would send "missed" events instead of a snapshot.
                lastEventId = nil
            } else if let p = try? await client.peer(), p.class != state?.peer?.class {
                // The peer class changed (another build was pinned — this one became cli): the replay doesn't carry `peer`
                // and doesn't replay hook.* — we need a snapshot, otherwise the cards and buttons would stay from the old class.
                lastEventId = nil
            }
        }
        snapshotNext = false
        do {
            for try await ev in client.events(lastEventId: lastEventId) {
                handle(ev)
            }
            if Task.isCancelled || quitting { return }
            connection = .offline(tr("служба хаба закрыла поток", "the hub service closed the stream"))
        } catch {
            if Task.isCancelled || quitting { return }
            connection = .offline((error as? LocalizedError)?.errorDescription ?? String(describing: error))
        }
        // no daemon (exited normally — launchd doesn't keep it, or hasn't started yet) — start the job
        await startDaemonIfNeeded()
    }

    /// Apply one SSE event (extracted for tests).
    public func handle(_ ev: SSEEvent) {
        // `: ping` — the stream is alive; don't touch the snapshot and connection
        if ev.isKeepalive {
            if state != nil, connection.isLive { lastEventAt = Date() }
            return
        }
        if let id = ev.id { lastEventId = id }
        lastEventAt = Date()
        guard let hub = HubEvent.decode(ev) else { return }
        if case .snapshot = hub {
            activeEvents = []
        }
        // the stream is alive: a snapshot or events of the same daemon replayed by Last-Event-ID
        if state != nil || { if case .snapshot = hub { return true } else { return false } }() {
            connection = .live
            backoff = Self.minBackoff
            daemonLaunch = .idle
        }
        if state == nil, case .snapshot(let s) = hub { state = s } else { state?.apply(hub) }
        if case .snapshot(let s) = hub, let l = s.lang {
            let before = L10n.shared.lang
            L10n.shared.apply(setting: l.setting, effective: l.effective)
            if L10n.shared.lang != before { onLanguageChange?() }
        }
        if let id = ev.id.flatMap(Int.init) { state?.seq = id }
        // advice for an unpinned copy ("open the pinned build: <path>") — from the fresh snapshot
        PinAdvice.shared.update(pinPath: state?.appPin?.path, installed: state?.hubUpdate?.installed)
        switch hub {
        case .snapshot(let s):
            // events already active in plugins arrive in the snapshot as plugin.events
            for p in s.plugins { for e in p.events { activeEvents.insert("\(p.id):\(e)") } }
            onSnapshot?(s)
            Task { [weak self] in await self?.loadCards() }
            if managerVisible { Task { [weak self] in await self?.loadRegistry() } }
        case .raised(let key, _, _): activeEvents.insert(key)
        case .cleared(let key, _): activeEvents.remove(key)
        case .action, .estop, .awake:
            if journalVisible { Task { [weak self] in await self?.loadJournal() } }
            if case .estop(true) = hub { cards = []; cardsChangedByEvent() }
        case .pushNotify(let n):
            onNotify?(n)
        case .secretsChanged(let plugin, _):
            if secrets[plugin] != nil { Task { [weak self] in await self?.loadSecrets(plugin) } }
        case .pluginUpdates:
            if managerVisible { Task { [weak self] in await self?.loadRegistry() } }
        case .hookCard:
            Task { [weak self] in await self?.loadCards() }
        case .hookCardRemoved(let id, _):
            cards.removeAll { $0.requestId == id }
            cardsChangedByEvent()
        case .hookPaused(let until):
            // the daemon has already removed all cards; re-read to show the pause (cardsError) and an empty list,
            // and once more at the end of the pause (loadCards schedules a recheck), so the banner clears itself
            cards = []
            cardsError = Self.pausedText
            pausedUntil = until.flatMap(PluginUpdatesStatus.parseDate)
            cardsAppliedSeq = cardsLoadSeq
            Task { [weak self] in await self?.loadCards() }
        case .hubRestarting:
            // the hub is switching to another version: quit without /shutdown (the new daemon will launch the new app)
            hubRestarting = true
            onHubRestart?()
        case .appPinChanged:
            // the daemon will close AgentHub.app connections; the next one comes with a snapshot, but we re-read the class right away
            snapshotNext = true
            Task { [weak self] in await self?.refreshPeer() }
        case .other(let type, let data):
            if type == "settings.changed", let l = data["lang"] {
                L10n.shared.apply(setting: l["setting"]?.stringValue, effective: l["effective"]?.stringValue)
                state?.lang = LangInfo(setting: l["setting"]?.stringValue ?? "system", effective: l["effective"]?.stringValue ?? "ru")
                onLanguageChange?()
            }
            // "Launch at login" was changed by another copy of the app (or this one — the reply has already been applied)
            if type == "settings.changed", case .bool(let on)? = data["launchAtLogin"] {
                let agent = state?.launchAtLogin?.launchAgent
                state?.launchAtLogin = LaunchAtLoginInfo(setting: on, launchAgent: agent)
            }
            // "Notifications" was changed by another copy of the app (or this one — the reply has already been applied)
            if type == "settings.changed", let n = data["notifications"],
               let raw = try? JSONEncoder().encode(n), let info = try? JSONDecoder().decode(NotificationsInfo.self, from: raw) {
                state?.notifications = info
            }
            // a built-in was turned on or off (settings.changed), or a scan held a plugin back or let it run (plugins.held)
            if type == "settings.changed" || type == "plugins.held" { state?.applyHeld(data) }
            // OAuth connections (oauth service): login started, finished, expired, "Disconnect"
            if type == "connections.changed", let list = ConnectionInfo.list(from: data["connections"]) { state?.connections = list }
            // external extensions (G4): a file appeared, changed or went, an approval or a revocation
            if type == "extensions.changed", let e = data["extensions"], let raw = try? JSONEncoder().encode(e),
               let info = try? JSONDecoder().decode(ExtensionsInfo.self, from: raw) { state?.extensions = info }
            // a registry's key in config.json stopped matching the accepted one, was accepted or was put back
            if type == "plugins.registry-keys", let list = RegistryKeyChange.list(from: data["changed"]) { state?.registryKeys = list }
            if type.hasPrefix("plugins."), managerVisible { Task { [weak self] in await self?.loadRegistry() } }
            // an own plugin request or an own plugin folder changed: the popover shows requests even without the manager
            else if type == "plugins.own-request" || type == "plugins.own" { Task { [weak self] in await self?.loadRegistry() } }
            // the cmux bridge connected / disconnected (bye or stopped polling) — "Go to tab" buttons of cmux sessions follow it right away
            if type == "bridge.connected" || type == "bridge.disconnected" {
                let on = type == "bridge.connected"
                if state?.bridge == nil { state?.bridge = BridgeInfo(online: on) }
                state?.bridge?.online = on
                if on { state?.bridge?.since = ISODate.string(Date()) } else { state?.bridge?.since = nil; state?.bridge?.version = nil }
            }
            if type == "bridge.launch.registered" || type == "bridge.launch.timeout",
               let sid = data["sessionId"]?.stringValue, lastLaunch?.sessionId == sid {
                lastLaunch?.state = type == "bridge.launch.registered" ? .registered : .timeout
            }
        default: break
        }
    }

    // MARK: - log

    public func loadJournal() async {
        do {
            journal = try await client.journal(limit: 300).reversed()
            journalError = nil
        } catch {
            journalError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        }
    }
}
