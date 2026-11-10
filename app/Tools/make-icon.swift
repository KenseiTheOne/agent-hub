// Draws the app icon (gradient rounded square + SF Symbol) into an .iconset.
// Usage: swift app/Tools/make-icon.swift <dir.iconset>; then iconutil -c icns <dir.iconset>.
// Fallback: scripts/bundle.sh calls it only if there is neither app/Resources/AppIcon.icns nor the
// AppIcon-source.png art (in that case — make-icon-from-art.swift). Not run when AppIcon.icns exists.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func render(_ px: Int) -> Data? {
    let size = CGFloat(px)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = size * 0.1
    let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
    let path = NSBezierPath(roundedRect: rect, xRadius: rect.width * 0.225, yRadius: rect.width * 0.225)
    NSGradient(starting: NSColor(calibratedRed: 0.16, green: 0.20, blue: 0.36, alpha: 1),
               ending: NSColor(calibratedRed: 0.05, green: 0.07, blue: 0.14, alpha: 1))?.draw(in: path, angle: -90)
    let cfg = NSImage.SymbolConfiguration(pointSize: rect.width * 0.5, weight: .semibold)
        .applying(.init(paletteColors: [NSColor(calibratedRed: 0.55, green: 0.80, blue: 1, alpha: 1)]))
    if let sym = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)?.withSymbolConfiguration(cfg) {
        let s = sym.size
        sym.draw(in: NSRect(x: (size - s.width) / 2, y: (size - s.height) / 2, width: s.width, height: s.height))
    }
    // status dot
    let d = rect.width * 0.2
    let dot = NSRect(x: rect.maxX - d * 1.35, y: rect.minY + d * 0.35, width: d, height: d)
    NSColor(calibratedRed: 0.20, green: 0.85, blue: 0.45, alpha: 1).setFill()
    NSBezierPath(ovalIn: dot).fill()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

for (name, px) in [("16x16", 16), ("16x16@2x", 32), ("32x32", 32), ("32x32@2x", 64), ("128x128", 128),
                   ("128x128@2x", 256), ("256x256", 256), ("256x256@2x", 512), ("512x512", 512), ("512x512@2x", 1024)] {
    guard let data = render(px) else { fatalError("failed to draw \(name)") }
    try data.write(to: URL(fileURLWithPath: "\(out)/icon_\(name).png"))
}
print("ok \(out)")
