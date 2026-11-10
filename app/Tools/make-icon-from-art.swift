// The app icon from art: large sizes (≥128) — app/Resources/AppIcon-source.png, small ones (16–64) — the same art
// or a separate simplified one (optional second argument). The last argument is the directory for AppIcon.iconset.
//   swift app/Tools/make-icon-from-art.swift app/Resources/AppIcon-source.png <dir> && iconutil -c icns <dir>/AppIcon.iconset -o app/Resources/AppIcon.icns
//   swift app/Tools/make-icon-from-art.swift <large art> <small art> <dir>

import AppKit
let argv = CommandLine.arguments
guard argv.count == 3 || argv.count == 4 else {
  FileHandle.standardError.write("make-icon-from-art.swift <art> [<small art>] <directory>\n".data(using: .utf8)!)
  exit(64)
}
let outDir = argv[argv.count - 1]
let bigArt = argv[1], smallArt = argv.count == 4 ? argv[2] : argv[1]
func prepare(_ path: String) -> (NSImage, NSRect) {
let src = NSImage(contentsOfFile: path)!
let rep = NSBitmapImageRep(data: src.tiffRepresentation!)!
let w = rep.pixelsWide, h = rep.pixelsHigh
// bbox of solid alpha (>= 230) — the tile itself, ignoring soft fringe
var minX = w, minY = h, maxX = 0, maxY = 0
for y in stride(from: 0, to: h, by: 2) { for x in stride(from: 0, to: w, by: 2) {
  if let c = rep.colorAt(x: x, y: y), c.alphaComponent >= 0.9 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } } }
let inset = 14 // drop the outermost antialiased rim
let crop = NSRect(x: minX + inset, y: h - maxY + inset, width: maxX - minX - 2 * inset, height: maxY - minY - 2 * inset)
return (src, crop)
}
let big = prepare(bigArt), small = prepare(smallArt)
func render(_ size: Int) -> Data {
  let (src, crop) = size <= 64 ? small : big
  let S = CGFloat(size), tile = S * 824 / 1024, off = (S - tile) / 2
  let canvas = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: canvas)
  let r = NSRect(x: off, y: off + S * 0.006, width: tile, height: tile)
  let path = NSBezierPath(roundedRect: r, xRadius: tile * 0.235, yRadius: tile * 0.235)
  let sh = NSShadow(); sh.shadowColor = NSColor(white: 0, alpha: 0.35); sh.shadowBlurRadius = S * 0.012; sh.shadowOffset = NSSize(width: 0, height: -S * 0.006)
  NSGraphicsContext.saveGraphicsState(); sh.set(); NSColor(red: 0.20, green: 0.16, blue: 0.62, alpha: 1).setFill(); path.fill(); NSGraphicsContext.restoreGraphicsState()
  NSGraphicsContext.saveGraphicsState(); path.addClip()
  NSGraphicsContext.current?.imageInterpolation = .high
  src.draw(in: r, from: crop, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  NSGraphicsContext.restoreGraphicsState()
  return canvas.representation(using: .png, properties: [:])!
}
let iconset = "\(outDir)/AppIcon.iconset"
try? FileManager.default.createDirectory(atPath: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  try! render(base).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(base)x\(base).png"))
  try! render(base * 2).write(to: URL(fileURLWithPath: "\(iconset)/icon_\(base)x\(base)@2x.png"))
}
try! render(1024).write(to: URL(fileURLWithPath: "\(outDir)/AppIcon-1024.png"))
