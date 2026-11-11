import Foundation

/// Texts for the "Settings → Notifications" section (2026-11-09): kind names and descriptions, security exceptions, quiet hours.
/// Data: `NotificationsInfo` from `/state.notifications`; the daemon decides what to show (`daemon/lib/push/prefs.mjs`).
public enum NotificationsText {
    public static func kindTitle(_ kind: String) -> String {
        switch kind {
        case "sessions": return tr("Сессии ждут ответа", "Sessions waiting for you")
        case "updates": return tr("Обновления хаба и плагинов", "Hub and plugin updates")
        case "problems": return tr("Сбои и предупреждения плагинов", "Plugin failures and warnings")
        default: return tr("Прочее от плагинов", "Everything else from plugins")
        }
    }

    public static func kindDetail(_ kind: String) -> String {
        switch kind {
        case "sessions": return tr("Сессия ждёт ответа или разрешения; ответы из хаба приостановлены лимитом одобрений",
                                   "A session needs an answer or a permission; hub replies paused by the approval limit")
        case "updates": return tr("Новая версия, собрана и ждёт перезапуска, установлена, не удалась; свой плагин обновлён из папки",
                                  "A new version, built and waiting for a restart, installed, failed; an own plugin updated from its folder")
        case "problems": return tr("Плагин не может прочитать данные или перестал работать, сервис не принял токен, квота",
                                   "A plugin can't read its data or stopped working, a service rejected a token, quota warnings")
        default: return tr("События без вида и всё от плагинов сообщества",
                           "Events without a kind and everything from community plugins")
        }
    }

    /// Header of the per-plugin toggles block (contract 2): the daemon builds the rows from installed plugins.
    public static var pluginsHeader: String { tr("По плагинам", "By plugin") }

    /// Caption under a plugin toggle: what it declared (its rule labels in the hub language).
    public static func pluginDetail(_ p: NotificationsInfo.PluginToggle) -> String {
        let list = p.labels.prefix(4).joined(separator: "; ")
        let more = p.labels.count > 4 ? tr(" и ещё \(p.labels.count - 4)", " and \(p.labels.count - 4) more") : ""
        if list.isEmpty { return tr("Свои уведомления плагина", "The plugin's own notifications") }
        return list + more
    }

    /// The toggle was turned off by migrating an earlier setting (before contract 2 the kind the plugin belonged to was
    /// off), and the person has not touched it yet.
    public static var pluginLegacyNote: String {
        tr("Выключено по прежней настройке уведомлений.", "Off because of an earlier notification setting.")
    }

    /// What "off" means, as one line under the toggles.
    public static var mutedExplain: String {
        tr("Выключенный вид не приходит никак — ни баннером, ни утренней сводкой. Событие по-прежнему видно в поповере и в журнале. Менять настройки может только закреплённая сборка приложения.",
           "A kind that's off never reaches you — no banner, no morning digest. The event still shows in the popover and in the log. Only the pinned app build can change these settings.")
    }

    /// A security exception row: hub events in their own words, plugin rules as "Plugin: label".
    public static func securityTitle(_ item: NotificationsInfo.SecurityItem) -> String {
        if item.plugin == "@hub" {
            switch item.key {
            case "app-pin-changed": return tr("Сменилось закрепление приложения", "The app pin changed")
            case "app-pin-path-changed": return tr("Сменился путь закреплённой сборки", "The pinned build's path changed")
            case "app-restart-stopped": return tr("Agent Hub падает — перезапуск остановлен", "Agent Hub keeps crashing — restart stopped")
            case "hub-update-tag-moved": return tr("Тег релиза Agent Hub перенесён — возможна подмена", "Agent Hub release tag moved — possible substitution")
            case "hub-update-suspect": return tr("Обновление Agent Hub остановлено — возможна подмена", "Agent Hub update stopped — possible substitution")
            case "plugin-own-unexpected": return tr("Свой плагин записан мимо Agent Hub", "Own plugin written behind Agent Hub's back")
            default: return item.label.isEmpty ? item.key : item.label
            }
        }
        let who = (item.pluginTitle ?? item.plugin).trimmingCharacters(in: .whitespaces)
        let what = item.label.isEmpty ? item.key : item.label
        return who.isEmpty ? what : "\(who): \(what)"
    }

    /// Why security exceptions cannot be turned off.
    public static var securityExplain: String {
        tr("Приходят при любых выключателях здесь, даже когда уведомления выключены, и config.json их не переопределяет. Это сигналы о возможной подмене (приложения, его пути, релиза — и то, что плагин объявил сигналом подмены) и о том, что хаб перестал поднимать приложение. Выключатель для них первым делом щёлкнула бы подменённая сборка — поэтому его нет. Молчат они, только если служба уведомлений выключена в config.json — тогда здесь будет предупреждение.",
           "Delivered whatever the switches here say, even with notifications off, and config.json can't override them. They warn about a possible substitution (of the app, its path, a release — and what a plugin declares as a tamper signal) and about the hub giving up on restarting the app. A substituted build would flip such a switch first — so there isn't one. They stay silent only if the notification service is off in config.json — this section then shows a warning.")
    }

    /// What shows right away during quiet hours, per the daemon rules (quietException): an app pin or pin path change,
    /// a moved release tag and an update stopped on suspected substitution, a hub update failure, and whatever a plugin
    /// marked urgent (quiet="true"). "Agent Hub keeps crashing" is not one of them: it goes into the digest.
    public static var quietExplain: String {
        tr("Когда вы отошли от Mac, в тихие часы баннеры придерживаются и приходят одной сводкой после конца. Сразу показываются только срочные: смена закрепления приложения или его пути, признаки подмены релиза, сбой обновления хаба и то, что плагин пометил срочным; «Agent Hub падает» — тоже в сводку. У Mac баннеры приходят как обычно.",
           "While you're away from the Mac, during quiet hours banners are held and arrive as one digest when they end. Only urgent ones show right away: an app pin or path change, signs of a substituted release, a failed hub update, and what a plugin marks urgent; \"Agent Hub keeps crashing\" goes into the digest too. At the Mac, banners show as usual.")
    }

    /// The quiet hours time zone if it differs from the Mac's current one (services.push.timezone in config.json); nil if they match.
    public static func quietZone(_ q: NotificationsInfo.Quiet, current: String = TimeZone.current.identifier) -> String? {
        guard let tz = q.timezone, !tz.isEmpty, tz != current else { return nil }
        return tr("Время — по поясу \(tz) (services.push.timezone в config.json), а у Mac сейчас \(current).",
                  "Times are in \(tz) (services.push.timezone in config.json); the Mac is on \(current) now.")
    }

    /// A hint about where the quiet hours currently come from; nil if set here.
    public static func quietSource(_ q: NotificationsInfo.Quiet) -> String? {
        switch q.from {
        case "config": return tr("Сейчас — из config.json (services.push.quietStart/quietEnd). После правки здесь действует эта настройка.",
                                 "Currently from config.json (services.push.quietStart/quietEnd). Once changed here, this setting applies.")
        default: return nil
        }
    }

    /// How notifications arrive: macOS banners only; when the person counts as away (idle threshold from the daemon).
    public static func channels(_ n: NotificationsInfo) -> String {
        // the "away" threshold comes from the daemon (services.push.idleThresholdMs); an older daemon gives no number
        if let ms = n.awayAfterMs, ms > 0 {
            let min = max(1, Int((Double(ms) / 60_000).rounded()))
            return tr("Баннеры macOS. Без клавиатуры и мыши дольше \(min) мин — вы отошли от Mac: в тихие часы баннеры ждут сводки, а баннер сессии, которая ждёт ответа, придёт, когда вы вернётесь (или через несколько минут).",
                      "macOS banners. No keyboard or mouse for more than \(min) min means you're away from the Mac: during quiet hours banners wait for the digest, and a waiting session's banner comes when you're back (or after a few minutes).")
        }
        return tr("Баннеры macOS.", "macOS banners.")
    }

    /// Time options for quiet hours: every 30 minutes, plus the current value if it falls between them.
    public static func timeOptions(including current: String) -> [String] {
        var out: [String] = []
        for m in stride(from: 0, to: 24 * 60, by: 30) { out.append(String(format: "%02d:%02d", m / 60, m % 60)) }
        if !out.contains(current), Self.minutes(current) != nil { out.append(current) }
        return out.sorted { (Self.minutes($0) ?? 0) < (Self.minutes($1) ?? 0) }
    }

    static func minutes(_ s: String) -> Int? {
        let p = s.split(separator: ":")
        guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]), (0..<24).contains(h), (0..<60).contains(m) else { return nil }
        return h * 60 + m
    }

    /// A daemon error on a notification settings change → text for the dialog; nil means the generic error text.
    public static func error(_ code: String?) -> String? {
        switch code {
        case "args:quiet:empty": return tr("Начало и конец тихих часов совпадают — выберите разное время.", "Quiet hours start and end at the same time — pick different times.")
        case "args:quiet:time": return tr("Время тихих часов — в виде ЧЧ:ММ.", "Quiet hours take HH:MM.")
        case "args:kinds:enum": return tr("Такого вида уведомлений хаб не знает — обновите хаб.", "The hub doesn't know this notification kind — update the hub.")
        default: return nil
        }
    }
}
