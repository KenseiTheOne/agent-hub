import Foundation

// Reply cards (permission requests and questions of sessions) and launching a session from the form.

extension HubStore {
    // MARK: - reply cards

    public func showDemoCards(_ list: [HookCard]) { demoCards = list }
    /// What to show in "Replies": real cards, then demo ones.
    public var visibleCards: [HookCard] { cards + demoCards }


    /// The cards were changed here (an event, an accepted reply) while an answer may still be on its way: every answer
    /// asked for before this moment is void (it could bring a removed card back), and the list is read again —
    /// unless the caller reads it itself (`reload: false`).
    func cardsChangedByEvent(reload: Bool = true) {
        guard cardsLoadsInFlight > 0 else { return }
        cardsAppliedSeq = cardsLoadSeq
        if reload { Task { [weak self] in await self?.loadCards() } }
    }

    public func loadCards() async {
        cardsLoadSeq += 1
        let seq = cardsLoadSeq
        cardsLoadsInFlight += 1
        let answer: Result<HookCardsResponse, Error>
        do { answer = .success(try await client.hookCards()) } catch { answer = .failure(error) }
        cardsLoadsInFlight -= 1
        guard seq > cardsAppliedSeq else { return }
        cardsAppliedSeq = seq
        do {
            let r = try answer.get()
            cards = r.cards
            cardsErrorIsPeer = false
            if r.paused {
                cardsError = Self.pausedText
                if let u = r.pausedUntil.flatMap(PluginUpdatesStatus.parseDate) { pausedUntil = u }
                schedulePauseRecheck()
            } else {
                cardsError = nil
                pausedUntil = nil
                pauseRecheck?.cancel()
            }
        } catch let e as HubError {
            cards = []
            pauseRecheck?.cancel()
            cardsErrorIsPeer = false
            switch e {
            case .socket, .transport:
                // no connection — the "connection lost" banner covers it; the raw error text doesn't need a second copy
                cardsError = nil
                return
            default: break
            }
            switch e.code {
            case "peer:cli", "peer:app-signature", "peer:app-requirement-missing":
                cardsErrorIsPeer = true
                cardsError = tr("Ответы сессиям видит только закреплённая сборка приложения.", "Only the pinned app build can see session replies.") + " " + PinAdvice.shared.openPinned
            case "no-hook-service":
                cardsError = tr("Служба ответов сессиям не запущена.", "The session reply service isn't running.")
            default:
                cardsError = e.errorDescription
            }
        } catch {
            cardsErrorIsPeer = false
            cardsError = String(describing: error)
        }
    }

    /// Re-read cards at the end of the reply pause: the daemon sends no "pause ended" event.
    func schedulePauseRecheck() {
        pauseRecheck?.cancel()
        if let u = pausedUntil, u <= Date() { pausedUntil = nil }
        let delay = Self.pauseRecheckDelay(until: pausedUntil, now: Date())
        pauseRecheck = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.loadCards()
        }
    }

    /// In how many seconds to recheck the pause: at `until` (+0.5 s), without it — every 15 s; at least every 10 min.
    nonisolated static func pauseRecheckDelay(until: Date?, now: Date) -> TimeInterval {
        guard let until else { return 15 }
        return min(600, max(2, until.timeIntervalSince(now) + 0.5))
    }

    /// Peer class from `GET /peer` (after a pin change); if it changed — re-read the cards.
    func refreshPeer() async {
        guard let p = try? await client.peer() else { return }
        guard state?.peer?.class != p.class || state?.peer?.reason != p.reason else { return }
        state?.peer = p
        await loadCards()
    }

    /// Reply to a card. `session.respond` is "immediate" level: the card itself is the consent (docs/hook.md).
    public func respond(_ card: HookCard, _ choice: RespondChoice) async {
        if demoCards.contains(card) {
            await presenter?.report(title: tr("Это демо-карточка", "This is a demo card"), detail: tr("Её показал аргумент --demo-cards для скриншота; сессия её не ждёт.", "It was added by --demo-cards for a screenshot; no session is waiting on it."))
            return
        }
        guard respondingTo == nil else { return }
        respondingTo = card.requestId
        defer { respondingTo = nil }
        let label = card.kind == .question ? tr("Ответ сессии «\(card.sessionName ?? String(card.sessionId.prefix(8)))»", "Reply to \"\(card.sessionName ?? String(card.sessionId.prefix(8)))\"")
                                           : "\(card.summary ?? card.tool ?? tr("Разрешение", "Permission"))"
        do {
            let outcome = try await client.invoke("session.respond", args: choice.args(requestId: card.requestId))
            switch outcome {
            case .done(let ok, let result):
                if ok { cards.removeAll { $0.requestId == card.requestId }; cardsChangedByEvent(reload: false) }
                else {
                    let why = result?["error"]?.stringValue
                    await presenter?.report(title: tr("Ответ не принят", "Reply not accepted"), detail: why == "rate-limit"
                        ? Explain.text(code: "rate-limit", status: 200, label: label)
                        : Explain.failure(result: result, label: label, limitMs: actionLimitMs))
                }
            case .needsConfirm:
                await presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите.", "\(label): try again."))
            case .denied(let status, let code):
                if code == "facts:not-pending" { cards.removeAll { $0.requestId == card.requestId }; cardsChangedByEvent(reload: false) }
                await deny(label, status: status, code: code)
            }
        } catch {
            await reportOffline(error)
        }
        await loadCards()
    }

    // MARK: - session launch

    /// `session.launch` from the form: the core will require a confirmation with a cost (428), the launch terminal opens the tab.
    @discardableResult
    public func launch(_ draft: LaunchDraft) async -> Bool {
        guard busyAction == nil else { return false }
        busyAction = "session.launch"
        defer { busyAction = nil }
        let label = tr("Запуск сессии «\(draft.name)»", "Launch session \"\(draft.name)\"")
        do {
            var outcome = try await client.invoke("session.launch", args: draft.args)
            if case .needsConfirm(let req) = outcome {
                guard let presenter, await presenter.confirm(req, actionLabel: label) else { return false }
                outcome = try await client.invoke("session.launch", args: draft.args, confirmToken: req.token)
            }
            switch outcome {
            case .done(let ok, let result):
                if ok {
                    lastLaunch = LaunchStatus(sessionId: result?["sessionId"]?.stringValue, name: draft.name, state: .started)
                    return true
                }
                await presenter?.report(title: tr("Сессия не запущена", "Session not launched"), detail: Explain.failure(result: result, label: label, limitMs: actionLimitMs))
            case .needsConfirm:
                await presenter?.report(title: tr("Хаб снова просит подтверждение", "The hub asks to confirm again"), detail: tr("\(label): повторите.", "\(label): try again."))
            case .denied(let status, let code):
                await deny(label, status: status, code: code)
            }
        } catch {
            await reportOffline(error)
        }
        return false
    }
}
