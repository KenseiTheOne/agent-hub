import AgentHubKit
import AppKit

/// `--snapshot-menubar <png>`: the menu bar icon in every state on a light and a dark bar — synthetic, for
/// documentation (the real menu bar cannot be captured without the Screen Recording permission). The template image is drawn the same way
/// the system does it: in the menu bar text color; the number — in the menu bar font.
@MainActor
enum MenuBarSnapshot {
    static let looks: [(MenuBarLook, Bool, String)] = [
        (.calm, false, tr("обычный", "normal")),
        (.working, false, tr("идёт работа", "working")),
        (.waiting(2), false, tr("ждут: 2", "waiting: 2")),
        // the number on the red badge is the waiting count, not the blockers
        (.blocked(1), false, tr("блокер, ждут 1", "blocker, 1 waiting")),
        (.paused(0, blocker: false), false, tr("пауза хаба", "hub paused")),
        (.paused(1, blocker: true), false, tr("пауза + блокер", "paused + blocker")),
        (.quiet, false, tr("тихо", "quiet")),
        (.quietNeedsOn, false, tr("тихо, но позже нужен", "quiet, needs on")),
        (.offline, false, tr("нет связи", "offline")),
        (.waiting(2), true, tr("тестовая копия", "test copy")),
    ]

    static func write(to path: String) {
        let cell = NSSize(width: 130, height: 54)
        let scale: CGFloat = 3
        let size = NSSize(width: cell.width * CGFloat(looks.count), height: cell.height * 2)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        for (row, name) in [(0, NSAppearance.Name.darkAqua), (1, NSAppearance.Name.aqua)] {
            guard let appearance = NSAppearance(named: name) else { continue }
            appearance.performAsCurrentDrawingAppearance {
                let dark = name == .darkAqua
                let y = CGFloat(row) * cell.height
                (dark ? NSColor(white: 0.13, alpha: 1) : NSColor(white: 0.93, alpha: 1)).setFill()
                NSRect(x: 0, y: y, width: size.width, height: cell.height).fill()
                // menu bar text color (labelColor in this appearance) — macOS paints the template and the number with it
                let ink = StatusImages.menuBarInk(dark: dark)
                for (i, (look, test, label)) in looks.enumerated() {
                    let x = CGFloat(i) * cell.width
                    let img = StatusImages.menuBarIcon(look: look, dark: dark)
                    let iconRect = NSRect(x: x + 30, y: y + 22, width: img.size.width, height: 22)
                    if img.isTemplate { MenuBarArt.draw(img, tint: ink, in: iconRect) } else { img.draw(in: iconRect) }
                    if let t = look.labelText(test: test) {
                        let s = NSAttributedString(string: t, attributes: [.font: NSFont.menuBarFont(ofSize: 0), .foregroundColor: ink])
                        s.draw(at: NSPoint(x: iconRect.maxX + 3, y: iconRect.minY + 3))
                    }
                    let cap = NSAttributedString(string: label, attributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: ink.withAlphaComponent(0.6)])
                    cap.draw(at: NSPoint(x: x + (cell.width - cap.size().width) / 2, y: y + 5))
                }
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        if let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            print("menubar-snapshot=\(path)")
            fflush(stdout)
        }
    }
}
