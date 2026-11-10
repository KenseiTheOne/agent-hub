import AgentHubKit
import AppKit
import SwiftUI

/// Status colors and icons — the same in the menu, the icon and the panel.
extension HubStatus {
    // Colors as in the approved prototype: blocker red, waiting orange, normal green, unknown grey.
    var nsColor: NSColor {
        switch self {
        case .ok: return .systemGreen
        case .unknown: return .systemGray
        case .wait: return .systemOrange
        case .block: return .systemRed
        case .error: return .systemRed
        }
    }

    /// Glyph inside the status circle: ! / clock / ✓ / ? / ×.
    var glyph: String {
        switch self {
        case .ok: return "checkmark"
        case .unknown: return "questionmark"
        case .wait: return "clock"
        case .block: return "exclamationmark"
        case .error: return "xmark"
        }
    }

    var color: Color { Color(nsColor: nsColor) }

    var symbol: String {
        switch self {
        case .ok: return "checkmark.circle.fill"
        case .unknown: return "questionmark.circle.fill"
        case .wait: return "hourglass.circle.fill"
        case .block: return "exclamationmark.octagon.fill"
        case .error: return "xmark.octagon.fill"
        }
    }
}

/// Color from the SwiftBar `color=` parameter (`red`, `#ff8800`, `#ff8800,#ffaa00` — light and dark theme: we take the first).
func swiftBarColor(_ raw: String?) -> Color? {
    guard let raw, !raw.isEmpty else { return nil }
    let s = raw.split(separator: ",").first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
    switch s {
    case "red": return .red
    case "green": return .green
    case "blue": return .blue
    case "orange": return .orange
    case "yellow": return .yellow
    case "gray", "grey": return .gray
    case "purple": return .purple
    case "pink": return .pink
    default: break
    }
    guard s.hasPrefix("#"), s.count == 7, let v = UInt32(s.dropFirst(), radix: 16) else { return nil }
    return Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

/// Images for the menu bar item and menu items. NSMenu recolors template images into one color,
/// so colored dots are drawn as regular images (isTemplate = false).
@MainActor
enum StatusImages {
    private static var dotCache: [HubStatus: NSImage] = [:]

    /// A colored status dot for menu items.
    static func dot(_ status: HubStatus, diameter: CGFloat = 9) -> NSImage {
        if let img = dotCache[status], diameter == 9 { return img }
        let size = NSSize(width: diameter + 4, height: diameter + 4)
        let img = NSImage(size: size, flipped: false) { rect in
            status.nsColor.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 2)).fill()
            return true
        }
        img.isTemplate = false
        if diameter == 9 { dotCache[status] = img }
        return img
    }

    /// Menu bar icon by `MenuBarLook` (AgentHubKit): the cop bot in a cap from `Resources/MenuBar`.
    /// All calm — a template image (macOS tints it: light and dark menu bar, highlight). Otherwise the image
    /// is drawn at render time (drawingHandler): the bot — `NSColor.labelColor` resolved in the current menu bar appearance
    /// (NSAppearance.currentDrawing: VibrantLight/VibrantDark) — the same tone (~85–90 %) as the template and the number
    /// next to it, not solid black/white; `dark` — a fallback hint from the SwiftUI environment. On top — the emblem on
    /// the cap, filled with the state color; when paused, to the right of the bot — a "‖" mark in the bot's color (the image is wider
    /// by `pauseMarkWidth`). The waiting count and "ТЕСТ" are separate text next to it (MenuBarLabel), the icon isn't clipped.
    /// "Quiet" (the "safe to shut down" verdict) — the bot is dimmed (`glyphAlpha`), the emblem is a cutout (quiet) or indigo
    /// (quiet, but the computer will be needed later; emblem at full strength); work in progress — the emblem is blue. No connection — the bot
    /// is paler than "quiet", with a "?" mark on the right (`unknownMark`): "I know nothing" must not look like "safe to shut down".
    static let pauseMarkWidth: CGFloat = 7

    static func menuBarIcon(look: MenuBarLook, dark: Bool) -> NSImage {
        guard let glyph = MenuBarArt.glyph else { return fallbackIcon(look) }
        if look.isTemplate {
            let img = glyph.copy() as! NSImage
            img.isTemplate = true
            img.accessibilityDescription = "Agent Hub"
            return img
        }
        let emblemColor: NSColor? = switch look.emblem {
        case .orange: .systemOrange
        case .red: .systemRed
        case .gray: .systemGray
        case .blue: .systemBlue
        case .indigo: .systemIndigo
        case nil: nil
        }
        let alpha = look.glyphAlpha
        let pause = look.pauseMark
        let unknown = look.unknownMark
        let size = NSSize(width: glyph.size.width + (pause || unknown ? pauseMarkWidth : 0), height: glyph.size.height)
        let img = NSImage(size: size, flipped: false) { rect in
            let ink = menuBarInk(dark: dark).withAlphaComponent(menuBarInk(dark: dark).alphaComponent * alpha)
            let botRect = NSRect(origin: rect.origin, size: glyph.size)
            MenuBarArt.draw(glyph, tint: ink, in: botRect)
            if let emblemColor, let emblem = MenuBarArt.emblem {
                MenuBarArt.draw(emblem, tint: emblemColor, in: botRect)
            }
            if pause {
                // "‖": two 1.75 × 8 pt bars centered vertically, to the right of the bot
                ink.setFill()
                let h: CGFloat = 8, w: CGFloat = 1.75, y = rect.midY - h / 2
                let x0 = botRect.maxX + 1
                NSBezierPath(roundedRect: NSRect(x: x0, y: y, width: w, height: h), xRadius: 0.6, yRadius: 0.6).fill()
                NSBezierPath(roundedRect: NSRect(x: x0 + w + 1.75, y: y, width: w, height: h), xRadius: 0.6, yRadius: 0.6).fill()
            }
            if unknown {
                // "?" to the right of the bot — no connection: the menu bar text color without dimming, so the mark is readable
                let q = NSAttributedString(string: "?", attributes: [.font: NSFont.systemFont(ofSize: 10, weight: .heavy),
                                                                    .foregroundColor: menuBarInk(dark: dark)])
                let qs = q.size()
                q.draw(at: NSPoint(x: botRect.maxX + (pauseMarkWidth - qs.width) / 2 + 0.5, y: rect.midY - qs.height / 2))
            }
            return true
        }
        img.isTemplate = false
        img.accessibilityDescription = "Agent Hub"
        return img
    }

    /// Menu bar text color in the current drawing appearance: `labelColor` resolved in sRGB (for the template and system
    /// menu bar text it's ~85 % black in light and ~90 % white in dark). Outside drawing — by `dark`.
    static func menuBarInk(dark: Bool) -> NSColor {
        let current = NSAppearance.currentDrawing()
        let isDark = current.bestMatch(from: [.aqua, .darkAqua]).map { $0 == .darkAqua } ?? dark
        var ink: NSColor?
        current.performAsCurrentDrawingAppearance {
            ink = NSColor.labelColor.usingColorSpace(.sRGB)
        }
        if let ink, (ink.brightnessComponent > 0.5) == isDark { return ink }
        return isDark ? NSColor(white: 1, alpha: 0.9) : NSColor(white: 0, alpha: 0.85)
    }

    /// No resources (a build without a bundle and without sources nearby): an SF Symbol, as before.
    private static func fallbackIcon(_ look: MenuBarLook) -> NSImage {
        let name = look == .offline ? "cube.transparent" : look.pauseMark ? "pause.circle" : "cube"
        let img = NSImage(systemSymbolName: name, accessibilityDescription: "Agent Hub")?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)) ?? NSImage()
        img.isTemplate = true
        return img
    }
}

/// Menu bar icon images: the bot template and the emblem mask on the same 22×22 pt canvas (@1x/@2x/@3x).
/// From the bundle (`Contents/Resources`, placed by scripts/bundle.sh); for `swift run` without a bundle — from the sources
/// (`app/Resources/MenuBar`).
@MainActor
enum MenuBarArt {
    static let glyph = load("MenuBarIcon")
    static let emblem = load("MenuBarEmblem")

    static func load(_ name: String) -> NSImage? {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Resources/MenuBar").standardizedFileURL
        for dir in [Bundle.main.resourceURL, source].compactMap({ $0 }) {
            let base = dir.appendingPathComponent("\(name).png")
            guard FileManager.default.fileExists(atPath: base.path) else { continue }
            let img = NSImage(size: NSSize(width: 22, height: 22))
            for suffix in ["", "@2x", "@3x"] {
                let url = dir.appendingPathComponent("\(name)\(suffix).png")
                guard let rep = NSImageRep(contentsOf: url) else { continue }
                rep.size = NSSize(width: 22, height: 22)
                img.addRepresentation(rep)
            }
            if !img.representations.isEmpty { return img }
        }
        return nil
    }

    /// Draw an image mask in a solid color (the image alpha is the shape).
    /// The color's opacity is applied to the whole layer: otherwise a semi-transparent fill over an opaque mask
    /// (sourceAtop) would give the same solid color.
    static func draw(_ image: NSImage, tint: NSColor, in rect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.setAlpha(tint.alphaComponent)
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
        image.draw(in: rect)
        tint.withAlphaComponent(1).setFill()
        rect.fill(using: .sourceAtop)
        ctx.endTransparencyLayer()
        ctx.restoreGState()
    }
}

/// Status icon: a colored circle with a glyph (as in the prototype) — distinguishable even without color.
struct StatusGlyph: View {
    let status: HubStatus
    var size: CGFloat = 16
    /// A session question — its own color (indigo) and "?".
    var question = false

    var body: some View {
        ZStack {
            Circle().fill(question ? Color(nsColor: .systemIndigo) : status.color)
            Image(systemName: question ? "questionmark" : status.glyph)
                .font(.system(size: size * 0.55, weight: .heavy))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(status.label)
    }
}

/// Plugin SF Symbol: the one the plugin declared itself (`<agenthub.icon symbol=…>`, contract 2) — the icon doesn't jump
/// with the status; otherwise the header's `sfimage`, otherwise a neutral one. The hub doesn't know icons of specific plugins.
@MainActor
func pluginSymbol(_ p: PluginState) -> String { pluginSymbol(id: p.id, sfimage: p.header.first?.sfImage, icon: p.icon) }

@MainActor
func pluginSymbol(id: String, sfimage: String? = nil, icon: PluginIcon? = nil) -> String {
    if let s = (icon ?? PluginIconBook.shared.icon(id))?.symbol, NSImage(systemSymbolName: s, accessibilityDescription: nil) != nil { return s }
    if let s = sfimage, NSImage(systemSymbolName: s, accessibilityDescription: nil) != nil { return s }
    return PluginIconBook.neutralSymbol
}

/// Tile palette (160° gradient): from the plugin-declared color to its darker shade; without a declaration — neutral.
@MainActor
func pluginPalette(_ id: String, icon: PluginIcon? = nil) -> (Color, Color) {
    func hex(_ v: UInt32) -> Color { Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255) }
    guard let v = (icon ?? PluginIconBook.shared.icon(id))?.rgb else { return (hex(0x8E8E93), hex(0x5E5E63)) }
    return (hex(v), hex(darker(v)))
}

/// The same color ~28 % darker — the bottom edge of the tile gradient.
func darker(_ v: UInt32, _ k: Double = 0.72) -> UInt32 {
    let r = UInt32(Double((v >> 16) & 0xFF) * k), g = UInt32(Double((v >> 8) & 0xFF) * k), b = UInt32(Double(v & 0xFF) * k)
    return (r << 16) | (g << 8) | b
}

/// Plugin tile: gradient from the palette, white icon, a thin light stroke.
struct PluginTile: View {
    let id: String
    var sfimage: String? = nil
    var size: CGFloat = 36
    var radius: CGFloat = 10
    /// The icon if it's known on the spot (consent window); otherwise from PluginIconBook by id.
    var icon: PluginIcon? = nil

    var body: some View {
        let (a, b) = pluginPalette(id, icon: icon)
        Image(systemName: pluginSymbol(id: id, sfimage: sfimage, icon: icon))
            .font(.system(size: size * 0.46, weight: .medium))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: radius).fill(LinearGradient(colors: [a, b], startPoint: UnitPoint(x: 0.33, y: 0), endPoint: UnitPoint(x: 0.67, y: 1))))
            .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(Color.white.opacity(0.25), lineWidth: 0.5))
    }
}

func hexColor(_ v: UInt32, _ a: Double = 1) -> Color {
    Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: a)
}

/// A disabled button is visible right away: dimmed and colorless (while the hub is paused, in an unpinned build).
/// ButtonStyle doesn't get `isEnabled` itself — we read it from the environment in a nested View.
private struct EnabledLook<Content: View>: View {
    @Environment(\.isEnabled) private var isEnabled
    let content: Content

    var body: some View {
        content
            .saturation(isEnabled ? 1 : 0)
            .opacity(isEnabled ? 1 : 0.38)
    }
}

/// The prototype capsule: fill, thin stroke, 12 pt 600.
struct CapsuleStyle: ButtonStyle {
    var fill: Color = .white.opacity(0.12)
    var stroke: Color = .white.opacity(0.14)
    var text: Color = .white
    var height: CGFloat = 32
    var expand = true
    /// The shape is concentric with the container (`containerShape`, e.g. a sidebar card) instead of a capsule.
    var concentric = false

    func makeBody(configuration: Configuration) -> some View {
        let shape = concentric ? AnyShape(ConcentricRectangle(corners: .concentric(minimum: .fixed(10)), isUniform: true)) : AnyShape(Capsule())
        return EnabledLook(content: configuration.label
            .font(.system(size: 12, weight: .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .foregroundStyle(text)
            .padding(.horizontal, 12)
            .frame(maxWidth: expand ? .infinity : nil)
            .frame(height: height)
            .background(shape.fill(fill.opacity(configuration.isPressed ? 0.7 : 1)))
            .overlay(shape.stroke(stroke, lineWidth: 0.5))
            .contentShape(shape))
    }
}

/// A small action capsule in a row ("Reply", "Show", "Go to"): padding 5×11.
struct PillStyle: ButtonStyle {
    var fill: Color = hexColor(0x0A84FF)
    var text: Color = .white

    func makeBody(configuration: Configuration) -> some View {
        EnabledLook(content: configuration.label
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(text)
            .padding(.vertical, 5).padding(.horizontal, 11)
            .background(Capsule().fill(fill.opacity(configuration.isPressed ? 0.7 : 1)))
            .contentShape(Capsule()))
    }
}

/// Hub pause (internal name — estop): what exactly gets turned off. A hint at the button and in the banner.
var pauseHubHelp: String {
    tr("Пауза хаба выключает: ответы сессиям из хаба, запуск, прерывание и остановку сессий, переход во вкладки, кнопки действий плагинов, установку и обновление плагинов. Работают: статусы, уведомления, открытие ссылок и файлов. Сами сессии не останавливаются: они спрашивают в терминале.",
       "Pausing the hub turns off: replying to sessions from the hub, launching, interrupting and stopping sessions, switching to tabs, plugin action buttons and installing or updating plugins. Still working: statuses, notifications, opening links and files. Sessions themselves keep running and ask in the terminal.")
}

var resumeHubHelp: String {
    tr("Снять паузу можно только из закреплённой сборки приложения", "Only the pinned app build can resume the hub")
}
