// pdfd: lazuli's PDF renderer, a loopback TCP daemon on PDFKit (DESIGN B9, ARCHITECTURE §5).
//
// Usage: pdfd --cache <H>/data/lazuli/cache/pdf --discovery ~/.cache/lazuli/pdfd-<sha8 of H>.json [--idle 300] [--cap-mb 300]
// Build: swiftc -O pdfd.swift -o pdfd-<sha8>   (sys/sidecars.js does this when the layout starts)
//
// It listens on 127.0.0.1 at a random port and writes {version, pid, port, token, startedAt, bin, cache} to the
// discovery file (mode 0600); `cache` is the --cache argument exactly as given, so a client can tell whether this
// daemon renders into its own app home. A client sends one JSON object per line; the first must be {op:"hello", token}.
// Requests carry `id`; every answer echoes it. Errors are {id, error:{code, message}}, code one of
// auth bad_request not_found encrypted render_failed.
// A connection must send hello within 5 s of being accepted, and at most 16 may wait for it; connections
// before hello do not count as clients for idle exit.
//
//   hello   {token}              → {ok:true, version, pid}
//   open    {path}               → {doc, pages, title, sizes:[[w,h]…], hasOutline}
//   render  {doc, page, width}   → {path, width, height, ms}
//   search  {doc, query, limit?} → {hits:[{page, rects:[[x,y,w,h]…], snippet}], truncated}
//   links   {doc, page}          → {links:[{rect, kind:"page"|"url", page?, url?}]}
//   outline {doc}                → {items:[{title, page, depth}]}
//   text    {doc, page}          → {text}
//   close   {doc}, ping {}       → {ok:true}
//
// Pages are 1-based. `doc` is the docKey: the first 16 hex of sha1("<path>|<revision>"), revision =
// "<mtime s>.<ns 9 digits>|<size>|<inode>|<ctime s>.<ns 9 digits>" (stat, symlinks followed), so a rewrite
// within the same second at the same size still gives a new key; renders of a replaced revision are
// deleted once no client holds it open. Sizes are display
// points (page rotation applied); rects are fractions of the displayed page, top-left origin. Search ignores
// case, width and whitespace (PDFKit breaks some lines inside words) and matches NFC against NFD; `limit`
// defaults to 100, at most 1000. `text` joins the line fragments PDFKit splits off one baseline. A render is a
// JPEG q90 file <cache>/<docKey>/p<page>-w<width>-<seq>.jpg that is never rewritten (S3); its `path` is
// relative to the app home when the cache sits at <H>/data/lazuli/cache/pdf, else absolute. The same page
// and width asked again answers the file already there. The cache folder stays under --cap-mb (counted in
// 4 KiB blocks) by deleting the least recently requested files; its totals are rebuilt from the folder at
// start. The daemon exits --idle seconds after its last connection closes, at once when a newer daemon took
// the discovery file and nobody is connected, and on SIGHUP (hc kill), SIGTERM or SIGINT.
//
// Answers are ASCII-only JSON (non-ASCII as \uXXXX). stderr (the hc terminal: `hc read <tN>`) logs every
// connection, every request with its outcome and time, and a line that stays unfinished for 2 s.

import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import PDFKit

let maxLine = 1_048_576
/// Connections accepted but not yet past hello; more are refused at once.
let maxPending = 16
/// A connection must complete hello this long after it was accepted.
let helloSeconds = 5.0
let protocolVersion = 1
let maxWidth = 8192
let maxPixels = 64_000_000
let maxText = 120_000
let defaultLimit = 100
let maxLimit = 1000
let appHomeSuffix = "/data/lazuli/cache/pdf"

struct Failure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

func log(_ text: String) {
    FileHandle.standardError.write(Data("pdfd: \(text)\n".utf8))
}

func nowMs() -> UInt64 {
    UInt64(Date().timeIntervalSince1970 * 1000)
}

func round5(_ v: CGFloat) -> Double {
    let d = Double(v)
    return d.isFinite ? (d * 100_000).rounded() / 100_000 : 0
}

func round2(_ v: CGFloat) -> Double {
    let d = Double(v)
    return d.isFinite ? (d * 100).rounded() / 100 : 0
}

// MARK: - Options

struct Options {
    var cache = ""
    /// --cache as given (discovery reports it unchanged).
    var cacheArg = ""
    var discovery = ""
    var idle: Double = 300
    var capBytes: Int64 = 300 * 1024 * 1024
}

func usage(_ why: String) -> Never {
    log(why)
    log("usage: pdfd --cache <dir> --discovery <file> [--idle <seconds>] [--cap-mb <MB>]")
    exit(2)
}

func expandPath(_ p: String) -> String {
    (NSString(string: p).expandingTildeInPath as NSString).standardizingPath
}

func parseOptions(_ args: [String]) -> Options {
    var o = Options()
    var i = 1
    while i < args.count {
        let name = args[i]
        guard i + 1 < args.count else { usage("missing value for \(name)") }
        let value = args[i + 1]
        switch name {
        case "--cache":
            o.cacheArg = value
            o.cache = expandPath(value)
        case "--discovery": o.discovery = expandPath(value)
        case "--idle":
            guard let v = Double(value), v > 0 else { usage("bad --idle \(value)") }
            o.idle = v
        case "--cap-mb":
            guard let v = Int64(value), v > 0 else { usage("bad --cap-mb \(value)") }
            o.capBytes = v * 1024 * 1024
        default: usage("unknown argument \(name)")
        }
        i += 2
    }
    if o.cache.isEmpty || o.discovery.isEmpty { usage("--cache and --discovery are required") }
    return o
}

// MARK: - Page geometry

/// A page's crop box and rotation, and the mapping from page space to the displayed page.
struct Geometry {
    let box: CGRect
    let rotation: Int

    init(_ page: PDFPage) {
        box = page.bounds(for: .cropBox)
        rotation = ((page.rotation % 360) + 360) % 360
    }

    /// The displayed size in points: the crop box, turned by the rotation.
    var size: CGSize {
        rotation % 180 == 0 ? box.size : CGSize(width: box.height, height: box.width)
    }

    /// A page-space rect → [x, y, w, h] as fractions of the displayed page, top-left origin.
    /// /Rotate turns the page clockwise: at 90° the page's left edge becomes the top.
    func normalized(_ r: CGRect) -> [Double] {
        let w = box.width, h = box.height
        let x0 = r.minX - box.minX, x1 = r.maxX - box.minX
        let y0 = r.minY - box.minY, y1 = r.maxY - box.minY
        var X0 = x0, X1 = x1, Y0 = y0, Y1 = y1
        switch rotation {
        case 90: X0 = y0; X1 = y1; Y0 = w - x1; Y1 = w - x0
        case 180: X0 = w - x1; X1 = w - x0; Y0 = h - y1; Y1 = h - y0
        case 270: X0 = h - y1; X1 = h - y0; Y0 = x0; Y1 = x1
        default: break
        }
        let s = size
        guard s.width > 0, s.height > 0 else { return [0, 0, 0, 0] }
        let clamp = { (v: CGFloat) in min(max(v, 0), 1) }
        let left = clamp(X0 / s.width), right = clamp(X1 / s.width)
        let top = clamp((s.height - Y1) / s.height), bottom = clamp((s.height - Y0) / s.height)
        return [round5(left), round5(top), round5(right - left), round5(bottom - top)]
    }
}

// MARK: - Render cache

/// The JPEG folder: what is in it, which file answers a page at a width, and LRU eviction.
final class RenderCache {
    struct Entry {
        var size: Int64
        var used: UInt64
    }

    let dir: String
    let appHome: String?
    let cap: Int64
    private(set) var total: Int64 = 0
    private var entries: [String: Entry] = [:]  // "<docKey>/<name>.jpg"
    private var latest: [String: String] = [:]  // "<docKey>/p<page>-w<width>" → entry
    private var seq: UInt64 = 0

    init(dir: String, cap: Int64) {
        self.dir = dir
        self.cap = cap
        appHome = dir.hasSuffix(appHomeSuffix) ? String(dir.dropLast(appHomeSuffix.count)) : nil
    }

    /// p<page>-w<width>-<seq>.jpg → its parts.
    static func parse(_ name: String) -> (page: Int, width: Int, seq: UInt64)? {
        guard name.hasPrefix("p"), name.hasSuffix(".jpg") else { return nil }
        let parts = name.dropFirst().dropLast(4).split(separator: "-")
        guard parts.count == 3, parts[1].hasPrefix("w"),
              let page = Int(parts[0]), let width = Int(parts[1].dropFirst()), let seq = UInt64(parts[2])
        else { return nil }
        return (page, width, seq)
    }

    private static func slot(_ docKey: String, _ page: Int, _ width: Int) -> String {
        "\(docKey)/p\(page)-w\(width)"
    }

    /// Totals from the folder: every render file, `used` = its modification time. Stray temp files
    /// older than a minute and empty folders go.
    func rebuild() {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        entries = [:]
        latest = [:]
        total = 0
        let now = Date()
        for docKey in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] {
            let sub = "\(dir)/\(docKey)"
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: sub, isDirectory: &isDir), isDir.boolValue else { continue }
            let names = (try? fm.contentsOfDirectory(atPath: sub)) ?? []
            var bestSeq: [String: UInt64] = [:]
            for name in names {
                let file = "\(sub)/\(name)"
                guard let attrs = try? fm.attributesOfItem(atPath: file) else { continue }
                let modified = (attrs[.modificationDate] as? Date) ?? now
                if name.hasSuffix(".tmp") {
                    if now.timeIntervalSince(modified) > 60 { unlink(file) }
                    continue
                }
                guard let p = RenderCache.parse(name) else { continue }
                let size = RenderCache.onDisk(attrs)
                let rel = "\(docKey)/\(name)"
                entries[rel] = Entry(size: size, used: UInt64(max(0, modified.timeIntervalSince1970 * 1000)))
                total += size
                seq = max(seq, p.seq)
                let key = RenderCache.slot(docKey, p.page, p.width)
                if p.seq >= bestSeq[key] ?? 0 {
                    bestSeq[key] = p.seq
                    latest[key] = rel
                }
            }
            rmdir(sub)  // only succeeds when empty
        }
        evict(keep: nil)
    }

    /// The file already rendered for that page and width, if it is still on disk; marks it used.
    func cached(_ docKey: String, _ page: Int, _ width: Int) -> String? {
        let key = RenderCache.slot(docKey, page, width)
        guard let rel = latest[key] else { return nil }
        guard FileManager.default.fileExists(atPath: "\(dir)/\(rel)") else {
            forget(rel)
            return nil
        }
        entries[rel]?.used = nowMs()
        return rel
    }

    /// A name never used before for a new render: `seq` rises past the clock and every name on disk.
    func newName(_ docKey: String, _ page: Int, _ width: Int) throws -> String {
        seq = max(seq + 1, nowMs())
        try FileManager.default.createDirectory(atPath: "\(dir)/\(docKey)", withIntermediateDirectories: true)
        return "\(docKey)/p\(page)-w\(width)-\(seq).jpg"
    }

    /// Bytes a file takes on disk: its size rounded up to whole 4 KiB blocks, as `du` counts it.
    static func onDisk(_ attrs: [FileAttributeKey: Any]?) -> Int64 {
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        return (size + 4095) / 4096 * 4096
    }

    func added(_ rel: String, docKey: String, page: Int, width: Int) {
        let size = RenderCache.onDisk(try? FileManager.default.attributesOfItem(atPath: "\(dir)/\(rel)"))
        if let old = entries[rel] { total -= old.size }
        entries[rel] = Entry(size: size, used: nowMs())
        total += size
        latest[RenderCache.slot(docKey, page, width)] = rel
        evict(keep: rel)
    }

    private func forget(_ rel: String) {
        if let e = entries.removeValue(forKey: rel) { total -= e.size }
        let parts = rel.split(separator: "/", maxSplits: 1)
        if parts.count == 2, let p = RenderCache.parse(String(parts[1])) {
            let key = RenderCache.slot(String(parts[0]), p.page, p.width)
            if latest[key] == rel { latest.removeValue(forKey: key) }
        }
    }

    /// Deletes every render of a document revision and its folder.
    func purge(_ docKey: String) {
        let sub = "\(dir)/\(docKey)"
        for name in (try? FileManager.default.contentsOfDirectory(atPath: sub)) ?? [] {
            unlink("\(sub)/\(name)")
            forget("\(docKey)/\(name)")
        }
        rmdir(sub)
    }

    /// Deletes the least recently requested files (ties by name) until the total fits the cap.
    func evict(keep: String?) {
        guard total > cap else { return }
        let order = entries.sorted { a, b in
            a.value.used != b.value.used ? a.value.used < b.value.used : a.key < b.key
        }
        for (rel, _) in order where total > cap {
            if rel == keep { continue }
            unlink("\(dir)/\(rel)")
            forget(rel)
            if let slash = rel.firstIndex(of: "/") { rmdir("\(dir)/\(rel[..<slash])") }
        }
    }

    func absolute(_ rel: String) -> String { "\(dir)/\(rel)" }

    /// What a client shows: relative to the app home when the cache lives in it.
    func published(_ rel: String) -> String {
        guard let home = appHome else { return absolute(rel) }
        let full = absolute(rel)
        return String(full.dropFirst(home.count + 1))
    }
}

// MARK: - Rendering

func renderJPEG(_ page: PDFPage, _ g: Geometry, width: Int, height: Int, to path: String) throws {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                              space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else { throw Failure("render_failed", "no bitmap context for \(width)x\(height)") }
    ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.interpolationQuality = .high
    let size = g.size
    ctx.scaleBy(x: CGFloat(width) / size.width, y: CGFloat(height) / size.height)
    // Draws in display space: rotation applied, origin at the crop box, clipped to it.
    page.draw(with: .cropBox, to: ctx)
    guard let image = ctx.makeImage() else { throw Failure("render_failed", "the page did not draw") }
    let tmp = path + ".tmp"
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: tmp) as CFURL, "public.jpeg" as CFString, 1, nil)
    else { throw Failure("render_failed", "cannot write \(tmp)") }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
        unlink(tmp)
        throw Failure("render_failed", "JPEG encoding failed")
    }
    // Renamed into place, so a reader never sees half a file.
    guard rename(tmp, path) == 0 else {
        unlink(tmp)
        throw Failure("render_failed", "cannot move the page into the cache")
    }
}

// MARK: - Page text

/// Unicode White_Space in the BMP.
@inline(__always)
func isSpace(_ u: unichar) -> Bool {
    switch u {
    case 0x09 ... 0x0D, 0x20, 0x85, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000: return true
    default: return false
    }
}

/// A text without its whitespace, and where each remaining UTF-16 unit came from. Search runs on
/// it: PDFKit breaks lines inside words in some files (Chrome's PDFs among them), so "lazy dog"
/// must also match "la\nzy dog" and "가나다라" must match "가나\n다라".
final class Compact {
    let text: NSString
    let origin: [Int32]

    init(_ s: NSString) {
        var units = [unichar](repeating: 0, count: s.length)
        s.getCharacters(&units, range: NSRange(location: 0, length: s.length))
        var kept = [unichar]()
        var origin = [Int32]()
        kept.reserveCapacity(units.count)
        origin.reserveCapacity(units.count)
        for (i, u) in units.enumerated() where !isSpace(u) {
            kept.append(u)
            origin.append(Int32(i))
        }
        text = NSString(characters: kept, length: kept.count)
        self.origin = origin
    }

    /// A range of `text` → the range of the original text it spans, whitespace between included.
    func original(_ r: NSRange) -> NSRange {
        let from = Int(origin[r.location])
        let to = Int(origin[r.location + r.length - 1]) + 1
        return NSRange(location: from, length: to - from)
    }
}

/// A page's text with its lines rebuilt from their positions: fragments PDFKit splits off one
/// baseline are joined again, with a space where a gap separates them.
func pageText(_ page: PDFPage) -> String {
    guard let raw = page.string, !raw.isEmpty else { return "" }
    let s = raw as NSString
    guard let all = page.selection(for: NSRange(location: 0, length: s.length)) else { return raw }
    var out = ""
    var prev: CGRect?
    for line in all.selectionsByLine() {
        guard let text = line.string, !text.isEmpty else { continue }
        let b = line.bounds(for: page)
        if let p = prev {
            let h = max(1, min(p.height, b.height))
            if !b.isNull, !p.isNull, abs(p.midY - b.midY) < h * 0.5, b.minX >= p.maxX - h * 0.5 {
                if b.minX - p.maxX > h * 0.2, out.last?.isWhitespace == false, text.first?.isWhitespace == false {
                    out += " "
                }
            } else {
                out += "\n"
            }
        }
        out += text
        prev = b
    }
    return out
}

// MARK: - Documents and connections

final class Doc {
    let key: String
    let path: String
    let document: PDFDocument
    var refs = 0
    /// Search text per page index, made on first search.
    var compact: [Int: Compact] = [:]

    init(key: String, path: String, document: PDFDocument) {
        self.key = key
        self.path = path
        self.document = document
    }

    func compactText(_ index: Int, _ page: PDFPage) -> Compact {
        if let c = compact[index] { return c }
        let c = Compact((page.string ?? "") as NSString)
        compact[index] = c
        return c
    }
}

/// JSON with every non-ASCII UTF-16 unit written as \uXXXX: the wire stays plain ASCII both ways, so
/// no client-side encoding question (NFD Hangul, emoji) can cut a line short.
func asciiJSON(_ data: Data) -> Data {
    if !data.contains(where: { $0 >= 0x80 }) { return data }
    guard let s = String(data: data, encoding: .utf8) else { return data }
    let hex = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(data.count * 2)
    for u in s.utf16 {
        if u < 0x80 {
            out.append(UInt8(u))
        } else {
            out += [0x5C, 0x75, hex[Int(u >> 12) & 15], hex[Int(u >> 8) & 15], hex[Int(u >> 4) & 15], hex[Int(u) & 15]]
        }
    }
    return Data(out)
}

/// Up to 160 bytes of a line for a log: printable ASCII as is, everything else as \xNN.
func preview(_ bytes: ArraySlice<UInt8>) -> String {
    var s = ""
    for b in bytes.prefix(160) {
        s += (0x20 ..< 0x7F).contains(b) ? String(UnicodeScalar(b)) : String(format: "\\x%02x", b)
    }
    return bytes.count > 160 ? s + "…" : s
}

final class Connection {
    let fd: Int32
    let name: String
    var authed = false
    var docs: [String: Int] = [:]  // docKey → opens on this connection; guarded by the daemon lock

    init(fd: Int32, name: String) {
        self.fd = fd
        self.name = name
    }

    /// Writes one answer line (ASCII JSON). Answers too large for a client's line limit become an error.
    @discardableResult
    func send(_ object: [String: Any]) -> Bool {
        var data: Data
        if JSONSerialization.isValidJSONObject(object),
           let d = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]),
           case let ascii = asciiJSON(d), ascii.count < maxLine {
            data = ascii
        } else {
            let fallback: [String: Any] = [
                "id": object["id"] ?? NSNull(),
                "error": ["code": "render_failed", "message": "the answer is too large or not JSON"],
            ]
            data = (try? JSONSerialization.data(withJSONObject: fallback)) ?? Data("{}".utf8)
        }
        data.append(0x0A)
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return false }
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, base + offset, raw.count - offset)
                if n < 0 {
                    if errno == EINTR { continue }
                    log("\(name): write failed: \(String(cString: strerror(errno)))")
                    return false
                }
                offset += n
            }
            return true
        }
    }
}

final class Daemon {
    let opts: Options
    let token: String
    let cache: RenderCache
    let startedAt = nowMs()
    let lock = NSLock()
    var docs: [String: Doc] = [:]
    var connections = 0
    var served = 0
    var pending = 0  // connections before hello: they do not keep the daemon from idling out
    var idleSince = Date()
    var revisions: [String: String] = [:]  // path → docKey of its latest opened revision
    var listenFd: Int32 = -1
    var port: UInt16 = 0
    var signalSources: [DispatchSourceSignal] = []

    init(_ opts: Options) {
        self.opts = opts
        var bytes = [UInt8](repeating: 0, count: 24)
        arc4random_buf(&bytes, bytes.count)
        token = bytes.map { String(format: "%02x", $0) }.joined()
        cache = RenderCache(dir: opts.cache, cap: opts.capBytes)
    }

    // MARK: lifecycle

    func run() -> Never {
        signal(SIGPIPE, SIG_IGN)
        for sig in [SIGHUP, SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { [unowned self] in self.shutdown("signal \(sig)") }
            source.resume()
            signalSources.append(source)
        }
        lock.lock()
        cache.rebuild()
        lock.unlock()
        do {
            try listen()
            try writeDiscovery()
        } catch let f as Failure {
            log(f.message)
            exit(1)
        } catch {
            log("\(error)")
            exit(1)
        }
        log("listening on 127.0.0.1:\(port), cache \(opts.cache) (\(cache.total / 1_048_576) MB)")
        acceptLoop()
    }

    func shutdown(_ why: String) -> Never {
        removeDiscoveryIfOurs()
        log("exit: \(why)")
        exit(0)
    }

    private func listen() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw Failure("render_failed", "socket: \(String(cString: strerror(errno)))") }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, Darwin.listen(fd, 32) == 0 else {
            throw Failure("render_failed", "bind/listen: \(String(cString: strerror(errno)))")
        }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        listenFd = fd
        port = UInt16(bigEndian: addr.sin_port)
    }

    private func discoveryData() throws -> Data {
        let object: [String: Any] = [
            "version": protocolVersion,
            "pid": Int(getpid()),
            "port": Int(port),
            "token": token,
            "startedAt": Int(startedAt),
            "bin": CommandLine.arguments[0],
            "cache": opts.cacheArg,
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    }

    /// Written to a private temp file, then renamed over the discovery file.
    private func writeDiscovery() throws {
        let parent = (opts.discovery as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let data = try discoveryData()
        let tmp = "\(opts.discovery).tmp-\(getpid())"
        let fd = Darwin.open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0o600)
        guard fd >= 0 else { throw Failure("render_failed", "cannot write \(tmp)") }
        let ok = data.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return false }
            return Darwin.write(fd, base, raw.count) == raw.count
        }
        fchmod(fd, 0o600)
        Darwin.close(fd)
        guard ok, rename(tmp, opts.discovery) == 0 else {
            unlink(tmp)
            throw Failure("render_failed", "cannot write \(opts.discovery)")
        }
    }

    private func discoveryIsOurs() -> Bool {
        guard let data = FileManager.default.contents(atPath: opts.discovery),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return object["token"] as? String == token
    }

    private func removeDiscoveryIfOurs() {
        if discoveryIsOurs() { unlink(opts.discovery) }
    }

    private func acceptLoop() -> Never {
        var lastOwnerCheck = Date()
        while true {
            var pfd = pollfd(fd: listenFd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, 1000)
            if ready > 0, pfd.revents & Int16(POLLIN) != 0 {
                let fd = accept(listenFd, nil, nil)
                if fd >= 0 { serve(fd) }
            }
            lock.lock()
            let idle = connections == 0 ? Date().timeIntervalSince(idleSince) : -1
            lock.unlock()
            if idle >= opts.idle { shutdown("idle for \(Int(idle)) s") }
            // A newer daemon took the discovery file: leave once nobody uses this one.
            if idle >= 0, Date().timeIntervalSince(lastOwnerCheck) >= 10 {
                lastOwnerCheck = Date()
                if !discoveryIsOurs() { shutdown("replaced by a newer daemon") }
            }
        }
    }

    private func serve(_ fd: Int32) {
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, socklen_t(MemoryLayout<Int32>.size))
        lock.lock()
        if pending >= maxPending {
            lock.unlock()
            Darwin.close(fd)
            log("refused a connection: \(maxPending) connections are already waiting for hello")
            return
        }
        pending += 1
        served += 1
        let conn = Connection(fd: fd, name: "c\(served)")
        lock.unlock()
        log("\(conn.name): connected")
        let thread = Thread { [unowned self] in self.readLoop(conn) }
        thread.stackSize = 8 << 20
        thread.start()
    }

    /// Hello passed: the connection stops counting as pending and starts counting against idle exit.
    private func authenticated(_ conn: Connection) {
        lock.lock()
        conn.authed = true
        pending -= 1
        connections += 1
        lock.unlock()
    }

    private func readLoop(_ conn: Connection) {
        var why = "client closed"
        defer { disconnected(conn, why) }
        var buffer = [UInt8]()
        var chunk = [UInt8](repeating: 0, count: 65536)
        var partialSince: Date?
        var warned = false
        let helloBy = Date().addingTimeInterval(helloSeconds)
        while true {
            // Waits in slices, so a line that never ends is reported instead of waited on silently, and a
            // connection without hello is closed at its absolute deadline.
            var timeout: Int32 = 2000
            if !conn.authed {
                let left = helloBy.timeIntervalSinceNow
                if left <= 0 {
                    why = "no hello within \(Int(helloSeconds)) s"
                    return
                }
                timeout = Int32(min(2000, max(1, (left * 1000).rounded(.up))))
            }
            var pfd = pollfd(fd: conn.fd, events: Int16(POLLIN), revents: 0)
            let ready = poll(&pfd, 1, timeout)
            if ready == 0 {
                if let since = partialSince, !warned, Date().timeIntervalSince(since) >= 2 {
                    warned = true
                    log("\(conn.name): \(buffer.count) bytes without a newline for 2 s: \(preview(buffer[...]))")
                }
                continue
            }
            if ready < 0 {
                if errno == EINTR { continue }
                why = "poll failed: \(String(cString: strerror(errno)))"
                return
            }
            let n = Darwin.read(conn.fd, &chunk, chunk.count)
            if n == 0 { return }
            if n < 0 {
                if errno == EINTR || errno == EAGAIN { continue }
                why = "read failed: \(String(cString: strerror(errno)))"
                return
            }
            buffer.append(contentsOf: chunk[0 ..< n])
            var start = 0
            while let newline = buffer[start...].firstIndex(of: 0x0A) {
                let line = Array(buffer[start ..< newline])
                start = newline + 1
                if line.count > maxLine {
                    why = "line too long"
                    return
                }
                if !handleLine(line, conn) {
                    why = "refused"
                    return
                }
            }
            buffer.removeFirst(start)
            if buffer.isEmpty {
                partialSince = nil
            } else if start > 0 || partialSince == nil {
                partialSince = Date()
            }
            if start > 0 { warned = false }
            if buffer.count > maxLine {
                conn.send(["id": NSNull(), "error": ["code": "bad_request", "message": "line too long"]])
                why = "line too long"
                return
            }
        }
    }

    private func disconnected(_ conn: Connection, _ why: String) {
        Darwin.close(conn.fd)
        lock.lock()
        for (key, count) in conn.docs { release(key, count) }
        conn.docs = [:]
        if conn.authed {
            connections -= 1
            if connections == 0 { idleSince = Date() }
        } else {
            pending -= 1
        }
        lock.unlock()
        log("\(conn.name): disconnected (\(why))")
    }

    // MARK: requests

    /// Answers one line; false closes the connection (failed hello). Every request is logged with its
    /// outcome and time.
    private func handleLine(_ line: [UInt8], _ conn: Connection) -> Bool {
        if line.isEmpty || line == [0x0D] { return true }
        guard let object = try? JSONSerialization.jsonObject(with: Data(line)), let req = object as? [String: Any] else {
            log("\(conn.name): not a JSON object (\(line.count) bytes): \(preview(line[...]))")
            return conn.send(["id": NSNull(), "error": ["code": "bad_request", "message": "not a JSON object"]])
        }
        let id = req["id"] ?? NSNull()
        let op = req["op"] as? String ?? ""
        if !conn.authed {
            guard op == "hello", req["token"] as? String == token else {
                log("\(conn.name): refused \(op.isEmpty ? "(no op)" : op) before hello")
                conn.send(["id": id, "error": ["code": "auth", "message": "the first request must be hello with the token"]])
                return false
            }
            authenticated(conn)
        }
        let started = Date()
        var answer: [String: Any]
        do {
            answer = try dispatch(op, req, conn)
        } catch let f as Failure {
            answer = ["error": ["code": f.code, "message": f.message]]
        } catch {
            answer = ["error": ["code": "render_failed", "message": "\(error)"]]
        }
        answer["id"] = id
        let outcome = (answer["error"] as? [String: Any])?["code"] as? String ?? "ok"
        let sent = conn.send(answer)
        let ms = Int((Date().timeIntervalSince(started) * 1000).rounded())
        log("\(conn.name): #\(id) \(op) \(line.count) bytes → \(outcome) in \(ms) ms\(sent ? "" : ", answer not sent")")
        return sent
    }

    private func dispatch(_ op: String, _ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        switch op {
        case "hello": return ["ok": true, "version": protocolVersion, "pid": Int(getpid())]
        case "ping": return ["ok": true]
        case "open", "render", "search", "links", "outline", "text", "close": break
        default: throw Failure("bad_request", "unknown op \(op.isEmpty ? "(none)" : op)")
        }
        // PDFKit is used from one thread at a time.
        lock.lock()
        defer { lock.unlock() }
        switch op {
        case "open": return try opOpen(req, conn)
        case "render": return try opRender(req, conn)
        case "search": return try opSearch(req, conn)
        case "links": return try opLinks(req, conn)
        case "outline": return try opOutline(req, conn)
        case "text": return try opText(req, conn)
        default: return try opClose(req, conn)
        }
    }

    private func string(_ req: [String: Any], _ key: String) throws -> String {
        guard let s = req[key] as? String, !s.isEmpty else {
            throw Failure("bad_request", "\(key) must be a non-empty string")
        }
        return s
    }

    private func integer(_ req: [String: Any], _ key: String) throws -> Int {
        guard let n = req[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), let i = Int(exactly: n.doubleValue) else {
            throw Failure("bad_request", "\(key) must be an integer")
        }
        return i
    }

    private func doc(_ req: [String: Any], _ conn: Connection) throws -> Doc {
        let key = try string(req, "doc")
        guard conn.docs[key] != nil, let d = docs[key] else { throw Failure("not_found", "no open document \(key)") }
        return d
    }

    private func page(_ req: [String: Any], _ d: Doc) throws -> (PDFPage, Int) {
        let n = try integer(req, "page")
        guard n >= 1, n <= d.document.pageCount, let p = d.document.page(at: n - 1) else {
            throw Failure("bad_request", "page \(n) is outside 1...\(d.document.pageCount)")
        }
        return (p, n)
    }

    private func release(_ key: String, _ count: Int) {
        guard let d = docs[key] else { return }
        d.refs -= count
        if d.refs <= 0 {
            docs.removeValue(forKey: key)
            if revisions[d.path] != key { cache.purge(key) }
        }
    }

    /// "<mtime s>.<ns>|<size>|<inode>|<ctime s>.<ns>" of a regular file (symlinks followed), or nil.
    /// file/pdf-client.js builds the same text with `stat -L -f "%.9Fm|%z|%i|%.9Fc"`.
    private func revision(_ path: String) -> String? {
        var st = stat()
        guard stat(path, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG else { return nil }
        return String(format: "%ld.%09ld|%lld|%llu|%ld.%09ld",
                      st.st_mtimespec.tv_sec, st.st_mtimespec.tv_nsec, Int64(st.st_size), UInt64(st.st_ino),
                      st.st_ctimespec.tv_sec, st.st_ctimespec.tv_nsec)
    }

    private func docKey(_ path: String, _ revision: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data("\(path)|\(revision)".utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(16))
    }

    private func opOpen(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let path = try string(req, "path")
        guard path.hasPrefix("/") else { throw Failure("bad_request", "path must be absolute") }
        guard let rev = revision(path) else { throw Failure("not_found", "no file at \(path)") }
        let key = docKey(path, rev)
        // A new revision of a file: the old one's renders go now, or when its last client lets go.
        if let old = revisions[path], old != key, docs[old] == nil { cache.purge(old) }
        revisions[path] = key
        let d: Doc
        if let open = docs[key] {
            d = open
        } else {
            guard let document = PDFDocument(url: URL(fileURLWithPath: path)) else {
                throw Failure("render_failed", "not a readable PDF")
            }
            if document.isLocked && !document.unlock(withPassword: "") {
                throw Failure("encrypted", "the PDF needs a password")
            }
            d = Doc(key: key, path: path, document: document)
            docs[key] = d
        }
        d.refs += 1
        conn.docs[key, default: 0] += 1
        let document = d.document
        var sizes: [[Double]] = []
        sizes.reserveCapacity(document.pageCount)
        for i in 0 ..< document.pageCount {
            guard let p = document.page(at: i) else {
                sizes.append([0, 0])
                continue
            }
            let s = Geometry(p).size
            sizes.append([round2(s.width), round2(s.height)])
        }
        let title = (document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String)
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        return [
            "doc": key,
            "pages": document.pageCount,
            "title": title ?? NSNull(),
            "sizes": sizes,
            "hasOutline": (document.outlineRoot?.numberOfChildren ?? 0) > 0,
        ]
    }

    private func opRender(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let started = Date()
        let d = try doc(req, conn)
        let (page, n) = try self.page(req, d)
        let width = try integer(req, "width")
        guard width >= 1, width <= maxWidth else { throw Failure("bad_request", "width must be 1...\(maxWidth)") }
        let g = Geometry(page)
        let size = g.size
        let w = Double(size.width), h = Double(size.height)
        guard w.isFinite, h.isFinite, w > 0, h > 0 else { throw Failure("render_failed", "the page has no usable area") }
        // Bounded in Double first: an extreme crop box must give an error for this page, not trap the daemon.
        let scaled = max(1, (h * Double(width) / w).rounded())
        guard scaled.isFinite, scaled <= Double(maxWidth * 4), Double(width) * scaled <= Double(maxPixels) else {
            throw Failure("render_failed", "page \(n) is too large to draw \(width) px wide (\(round2(size.width))x\(round2(size.height)) pt)")
        }
        let height = Int(scaled)
        let ms = { Int((Date().timeIntervalSince(started) * 1000).rounded()) }
        if let rel = cache.cached(d.key, n, width) {
            return ["path": cache.published(rel), "width": width, "height": height, "ms": ms()]
        }
        let rel = try cache.newName(d.key, n, width)
        try autoreleasepool {
            try renderJPEG(page, g, width: width, height: height, to: cache.absolute(rel))
        }
        cache.added(rel, docKey: d.key, page: n, width: width)
        return ["path": cache.published(rel), "width": width, "height": height, "ms": ms()]
    }

    /// Every match of the compact query in a page's compact text: case- and width-insensitive and
    /// canonically equivalent (NFC and NFD Hangul match). Ranges are in the compact text.
    private func matches(_ c: Compact, _ query: NSString) -> [NSRange] {
        var out: [NSRange] = []
        let s = c.text
        var from = 0
        while from < s.length {
            let r = s.range(of: query as String, options: [.caseInsensitive, .widthInsensitive],
                            range: NSRange(location: from, length: s.length - from))
            if r.location == NSNotFound || r.length == 0 { break }
            out.append(r)
            from = r.location + r.length
        }
        return out
    }

    /// Up to 40 characters each side of match `r` (a range of `map.text`) in `text`, the string `map`
    /// was made from, whitespace collapsed.
    private func snippet(_ r: NSRange, in text: NSString, _ map: Compact) -> String {
        let s = text
        let hit = map.original(r)
        let from = max(0, hit.location - 40)
        let to = min(s.length, hit.location + hit.length + 40)
        let range = s.rangeOfComposedCharacterSequences(for: NSRange(location: from, length: to - from))
        return s.substring(with: range)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private func rects(_ page: PDFPage, _ r: NSRange, _ g: Geometry) -> [[Double]] {
        guard let selection = page.selection(for: r) else { return [] }
        var out: [[Double]] = []
        for line in selection.selectionsByLine() {
            let b = line.bounds(for: page)
            if !b.isNull, !b.isEmpty { out.append(g.normalized(b)) }
        }
        if out.isEmpty {
            let b = selection.bounds(for: page)
            if !b.isNull, !b.isEmpty { out.append(g.normalized(b)) }
        }
        return out
    }

    private func opSearch(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let d = try doc(req, conn)
        let query = Compact(try string(req, "query").precomposedStringWithCanonicalMapping as NSString).text
        guard query.length > 0 else { throw Failure("bad_request", "query is blank") }
        var limit = defaultLimit
        if req["limit"] != nil && !(req["limit"] is NSNull) { limit = try integer(req, "limit") }
        limit = min(max(limit, 1), maxLimit)
        var hits: [[String: Any]] = []
        var truncated = false
        pages: for i in 0 ..< d.document.pageCount {
            guard let page = d.document.page(at: i) else { continue }
            let c = d.compactText(i, page)
            let found = matches(c, query)
            if found.isEmpty { continue }
            let g = Geometry(page)
            let raw = (page.string ?? "") as NSString
            let lines = pageText(page) as NSString
            let rebuilt = Compact(lines)
            // The rebuilt lines read better; they hold the same characters unless PDFKit disagrees with itself.
            let (source, map) = rebuilt.text.isEqual(to: c.text as String) ? (lines, rebuilt) : (raw, c)
            for r in found {
                if hits.count == limit {
                    truncated = true
                    break pages
                }
                hits.append(["page": i + 1, "rects": rects(page, c.original(r), g), "snippet": snippet(r, in: source, map)])
            }
        }
        return ["hits": hits, "truncated": truncated]
    }

    private func opLinks(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let d = try doc(req, conn)
        let (page, _) = try self.page(req, d)
        let g = Geometry(page)
        var links: [[String: Any]] = []
        for a in page.annotations {
            let type = (a.type ?? "").replacingOccurrences(of: "/", with: "")
            guard type == "Link" else { continue }
            let rect = g.normalized(a.bounds)
            if let url = a.url ?? (a.action as? PDFActionURL)?.url {
                links.append(["rect": rect, "kind": "url", "url": url.absoluteString])
                continue
            }
            let destination = a.destination ?? (a.action as? PDFActionGoTo)?.destination
            if let target = destination?.page {
                let index = d.document.index(for: target)
                if index != NSNotFound { links.append(["rect": rect, "kind": "page", "page": index + 1]) }
            }
        }
        return ["links": links]
    }

    private func opOutline(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let d = try doc(req, conn)
        var items: [[String: Any]] = []
        func pageOf(_ node: PDFOutline) -> Any {
            let destination = node.destination ?? (node.action as? PDFActionGoTo)?.destination
            guard let target = destination?.page else { return NSNull() }
            let index = d.document.index(for: target)
            return index == NSNotFound ? NSNull() : index + 1
        }
        func walk(_ node: PDFOutline, _ depth: Int) {
            for i in 0 ..< node.numberOfChildren where items.count < 20_000 {
                guard let child = node.child(at: i) else { continue }
                items.append(["title": child.label ?? "", "page": pageOf(child), "depth": depth])
                if depth < 64 { walk(child, depth + 1) }
            }
        }
        if let root = d.document.outlineRoot { walk(root, 0) }
        return ["items": items]
    }

    private func opText(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let d = try doc(req, conn)
        let (page, _) = try self.page(req, d)
        let s = pageText(page) as NSString
        if s.length <= maxText { return ["text": s as String] }
        let cut = s.rangeOfComposedCharacterSequence(at: maxText).location
        return ["text": s.substring(to: cut)]
    }

    private func opClose(_ req: [String: Any], _ conn: Connection) throws -> [String: Any] {
        let key = try string(req, "doc")
        guard let count = conn.docs[key] else { throw Failure("not_found", "no open document \(key)") }
        if count <= 1 { conn.docs.removeValue(forKey: key) } else { conn.docs[key] = count - 1 }
        release(key, 1)
        return ["ok": true]
    }
}

let daemon = Daemon(parseOptions(CommandLine.arguments))
daemon.run()
