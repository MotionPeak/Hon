// Generates the Hon app icon at every macOS size.
// Run from the project root:  swift Tools/GenerateIcon.swift

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

func rgba(_ r: Double, _ g: Double, _ b: Double, _ a: Double = 1) -> CGColor {
    CGColor(colorSpace: sRGB, components: [CGFloat(r), CGFloat(g), CGFloat(b), CGFloat(a)])!
}

/// A superellipse ("squircle") path — the modern macOS icon silhouette.
func squirclePath(center: CGPoint, halfSide: CGFloat, exponent n: Double = 5) -> CGPath {
    let path = CGMutablePath()
    let steps = 768
    for i in 0...steps {
        let t = Double(i) / Double(steps) * 2.0 * .pi
        let ct = cos(t), st = sin(t)
        let x = pow(abs(ct), 2.0 / n) * (ct < 0 ? -1.0 : 1.0)
        let y = pow(abs(st), 2.0 / n) * (st < 0 ? -1.0 : 1.0)
        let p = CGPoint(x: center.x + CGFloat(x) * halfSide,
                        y: center.y + CGFloat(y) * halfSide)
        if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
    }
    path.closeSubpath()
    return path
}

func capsule(_ rect: CGRect) -> CGPath {
    let r = min(rect.width, rect.height) / 2
    return CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil)
}

func drawIcon(into ctx: CGContext, size S: CGFloat) {
    let center = CGPoint(x: S / 2, y: S / 2)
    let half = S * 0.4025                       // squircle half-side -> side ~0.805 S
    let squircle = squirclePath(center: center, halfSide: half)

    // Drop shadow + opaque base behind the squircle.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -S * 0.018),
                  blur: S * 0.055, color: rgba(0, 0, 0, 0.36))
    ctx.addPath(squircle)
    ctx.setFillColor(rgba(0.10, 0.09, 0.18))
    ctx.fillPath()
    ctx.restoreGState()

    // Everything below is clipped inside the squircle.
    ctx.saveGState()
    ctx.addPath(squircle)
    ctx.clip()

    // Background: deep indigo -> violet -> periwinkle, top-left to bottom-right.
    let bg = CGGradient(colorsSpace: sRGB,
                        colors: [rgba(0.14, 0.12, 0.38),
                                 rgba(0.34, 0.27, 0.84),
                                 rgba(0.47, 0.43, 0.98)] as CFArray,
                        locations: [0, 0.58, 1])!
    ctx.drawLinearGradient(bg,
                           start: CGPoint(x: center.x - half, y: center.y + half),
                           end: CGPoint(x: center.x + half, y: center.y - half),
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])

    // Soft light bloom in the upper-left.
    let bloom = CGGradient(colorsSpace: sRGB,
                           colors: [rgba(1, 1, 1, 0.26), rgba(1, 1, 1, 0)] as CFArray,
                           locations: [0, 1])!
    ctx.drawRadialGradient(bloom,
                           startCenter: CGPoint(x: S * 0.33, y: S * 0.74), startRadius: 0,
                           endCenter: CGPoint(x: S * 0.33, y: S * 0.74), endRadius: S * 0.66,
                           options: [])

    // Grounding toward the bottom edge.
    let ground = CGGradient(colorsSpace: sRGB,
                            colors: [rgba(0, 0, 0, 0), rgba(0.02, 0.01, 0.10, 0.30)] as CFArray,
                            locations: [0, 1])!
    ctx.drawLinearGradient(ground,
                           start: center,
                           end: CGPoint(x: center.x, y: center.y - half),
                           options: [.drawsAfterEndLocation])

    // Warm glow so the monogram feels lit from within.
    let glow = CGGradient(colorsSpace: sRGB,
                          colors: [rgba(1.0, 0.78, 0.40, 0.24),
                                   rgba(1.0, 0.78, 0.40, 0)] as CFArray,
                          locations: [0, 1])!
    ctx.drawRadialGradient(glow,
                           startCenter: center, startRadius: 0,
                           endCenter: center, endRadius: S * 0.40,
                           options: [])

    // Thin inner rim light just inside the squircle edge.
    ctx.addPath(squircle)
    ctx.setStrokeColor(rgba(1, 1, 1, 0.14))
    ctx.setLineWidth(S * 0.008)
    ctx.strokePath()

    ctx.restoreGState()  // drop the squircle clip

    drawGlyph(into: ctx, size: S, center: center)
}

/// An "H" monogram with a gently rising crossbar — letter + quiet growth.
func drawGlyph(into ctx: CGContext, size S: CGFloat, center: CGPoint) {
    let w = S * 0.122                   // stroke weight
    let gw = S * 0.415                  // glyph width, outer to outer
    let gh = S * 0.470                  // glyph height
    let topY = center.y + gh / 2
    let botY = center.y - gh / 2
    let lx = center.x - gw / 2 + w / 2  // left stroke centre x
    let rx = center.x + gw / 2 - w / 2  // right stroke centre x

    // Two equal vertical strokes.
    let glyph = CGMutablePath()
    glyph.addPath(capsule(CGRect(x: lx - w / 2, y: botY, width: w, height: gh)))
    glyph.addPath(capsule(CGRect(x: rx - w / 2, y: botY, width: w, height: gh)))

    // Crossbar — rises left-to-right, balanced around the centre line.
    let aLeft = CGPoint(x: lx, y: center.y - S * 0.050)
    let bRight = CGPoint(x: rx, y: center.y + S * 0.050)
    let len = hypot(bRight.x - aLeft.x, bRight.y - aLeft.y)
    let angle = atan2(bRight.y - aLeft.y, bRight.x - aLeft.x)
    let mid = CGPoint(x: (aLeft.x + bRight.x) / 2, y: (aLeft.y + bRight.y) / 2)
    var tf = CGAffineTransform(translationX: mid.x, y: mid.y).rotated(by: angle)
    glyph.addPath(CGPath(roundedRect: CGRect(x: -(len + w) / 2, y: -w / 2,
                                             width: len + w, height: w),
                         cornerWidth: w / 2, cornerHeight: w / 2, transform: &tf))

    // Shadow pass — one soft shadow lifts the glyph off the background.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -S * 0.013),
                  blur: S * 0.032, color: rgba(0, 0, 0, 0.34))
    ctx.addPath(glyph)
    ctx.setFillColor(rgba(0.97, 0.72, 0.27))
    ctx.fillPath()
    ctx.restoreGState()

    // Gold gradient + a top sheen, both clipped to the glyph.
    ctx.saveGState()
    ctx.addPath(glyph)
    ctx.clip()
    let gold = CGGradient(colorsSpace: sRGB,
                          colors: [rgba(1.0, 0.90, 0.52), rgba(0.94, 0.57, 0.13)] as CFArray,
                          locations: [0, 1])!
    ctx.drawLinearGradient(gold,
                           start: CGPoint(x: center.x, y: topY),
                           end: CGPoint(x: center.x, y: botY),
                           options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    let sheen = CGGradient(colorsSpace: sRGB,
                           colors: [rgba(1, 1, 1, 0.34), rgba(1, 1, 1, 0)] as CFArray,
                           locations: [0, 1])!
    ctx.drawLinearGradient(sheen,
                           start: CGPoint(x: center.x, y: topY),
                           end: CGPoint(x: center.x, y: center.y + S * 0.03),
                           options: [])
    ctx.restoreGState()
}

func renderPNG(size: Int, to url: URL) {
    guard let ctx = CGContext(data: nil, width: size, height: size,
                              bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
        fatalError("could not create \(size)px context")
    }
    ctx.setShouldAntialias(true)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high
    drawIcon(into: ctx, size: CGFloat(size))

    guard let image = ctx.makeImage(),
          let dest = CGImageDestinationCreateWithURL(url as CFURL,
                                                     UTType.png.identifier as CFString,
                                                     1, nil) else {
        fatalError("could not encode \(size)px PNG")
    }
    CGImageDestinationAddImage(dest, image, nil)
    if !CGImageDestinationFinalize(dest) {
        fatalError("could not write \(url.lastPathComponent)")
    }
}

// MARK: - Entry point

var scriptPath = #filePath
if !scriptPath.hasPrefix("/") {
    scriptPath = FileManager.default.currentDirectoryPath + "/" + scriptPath
}
let projectRoot = URL(fileURLWithPath: scriptPath).standardizedFileURL
    .deletingLastPathComponent()       // Tools/
    .deletingLastPathComponent()       // project root
let iconset = projectRoot.appendingPathComponent("Hon/Assets.xcassets/AppIcon.appiconset",
                                                 isDirectory: true)
try? FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

for size in [16, 32, 64, 128, 256, 512, 1024] {
    renderPNG(size: size, to: iconset.appendingPathComponent("icon_\(size).png"))
    print("rendered icon_\(size).png")
}

let contents = """
{
  "images" : [
    { "size" : "16x16",   "idiom" : "mac", "filename" : "icon_16.png",   "scale" : "1x" },
    { "size" : "16x16",   "idiom" : "mac", "filename" : "icon_32.png",   "scale" : "2x" },
    { "size" : "32x32",   "idiom" : "mac", "filename" : "icon_32.png",   "scale" : "1x" },
    { "size" : "32x32",   "idiom" : "mac", "filename" : "icon_64.png",   "scale" : "2x" },
    { "size" : "128x128", "idiom" : "mac", "filename" : "icon_128.png",  "scale" : "1x" },
    { "size" : "128x128", "idiom" : "mac", "filename" : "icon_256.png",  "scale" : "2x" },
    { "size" : "256x256", "idiom" : "mac", "filename" : "icon_256.png",  "scale" : "1x" },
    { "size" : "256x256", "idiom" : "mac", "filename" : "icon_512.png",  "scale" : "2x" },
    { "size" : "512x512", "idiom" : "mac", "filename" : "icon_512.png",  "scale" : "1x" },
    { "size" : "512x512", "idiom" : "mac", "filename" : "icon_1024.png", "scale" : "2x" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
"""
do {
    try contents.write(to: iconset.appendingPathComponent("Contents.json"),
                       atomically: true, encoding: .utf8)
    print("wrote Contents.json")
} catch {
    print("ERROR writing Contents.json: \(error)")
    exit(1)
}
print("done -> \(iconset.path)")
