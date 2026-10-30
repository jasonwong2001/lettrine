import Foundation

// Searches never occupy the queue that orders saves, moves and settings.
// A new query cancels the previous scan for that window between files/lines.
final class LibrarySearch {
    final class Request {
        private let lock = NSLock()
        private var stopped = false
        var cancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
        func cancel() { lock.lock(); stopped = true; lock.unlock() }
    }
    private let lock = NSLock()
    private var requests: [String: Request] = [:]
    private let queue = DispatchQueue(label: "io.github.jasonwong2001.lettrine.search", qos: .userInitiated, attributes: .concurrent)

    func begin(_ tab: String) -> Request {
        lock.lock(); defer { lock.unlock() }
        requests[tab]?.cancel()
        let request = Request(); requests[tab] = request
        return request
    }
    func cancel(_ tab: String) {
        lock.lock(); let request = requests.removeValue(forKey: tab); lock.unlock()
        request?.cancel()
    }
    func run(_ request: Request, files: [JSON], folder: String, options: JSON,
             progress: @escaping (JSON) -> Void, completion: @escaping (JSON) -> Void) {
        queue.async {
            let query = options["text"] as? String ?? ""
            let regex = options["useRegexp"] as? Bool == true, whole = options["wholeWord"] as? Bool == true
            let sensitive = options["caseSensitive"] as? Bool == true
            let matcher: NSRegularExpression
            do {
                var pattern = regex ? query : NSRegularExpression.escapedPattern(for: query)
                if whole { pattern = "(?<![\\p{L}\\p{N}_])(?:" + pattern + ")(?![\\p{L}\\p{N}_])" }
                matcher = try NSRegularExpression(pattern: pattern, options: sensitive ? [] : [.caseInsensitive])
            } catch {
                completion(["error": error.localizedDescription, "nameMatches": [], "contentMatches": []]); return
            }
            func matches(_ text: NSString, range: NSRange? = nil) -> Bool {
                let range = range ?? NSRange(location: 0, length: text.length)
                return matcher.firstMatch(in: text as String, range: range) != nil
            }
            var names: [String] = [], contents: [Int: [Any]] = [:]
            func result() -> JSON { ["nameMatches": names, "contentMatches": contents.keys.sorted().compactMap { contents[$0] }] }
            if query.isEmpty || folder.isEmpty { completion(result()); return }
            let candidates = files.compactMap { file -> (JSON, String)? in
                guard let path = file["path"] as? String else { return nil }
                let prefix = folder.hasSuffix("/") ? folder : folder + "/"
                return (file, path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path)
            }
            for (_, relative) in candidates {
                if request.cancelled { completion(["cancelled": true]); return }
                if names.count < 100 && matches(relative as NSString) { names.append(relative) }
            }
            progress(result())
            // Bound both parallel disk reads and temporary decoded buffers.
            let resultsLock = NSLock(), workers = min(4, max(1, candidates.count))
            var published = 0, lastProgress = Date.timeIntervalSinceReferenceDate
            DispatchQueue.concurrentPerform(iterations: workers) { worker in
              for index in stride(from: worker, to: candidates.count, by: workers) {
                if request.cancelled { return }
                resultsLock.lock(); let full = contents.count >= 100; resultsLock.unlock()
                if full { return }
                let (file, relative) = candidates[index]
                let hits: [JSON] = autoreleasepool {
                    guard let path = file["path"] as? String, (file["size"] as? Int ?? 0) <= 2 * 1024 * 1024,
                          let data = try? Data(contentsOf: fileURL(path), options: .mappedIfSafe),
                          data.count <= 2 * 1024 * 1024,
                          data.withUnsafeBytes({ bytes in bytes.isEmpty || memchr(bytes.baseAddress!, 0, bytes.count) == nil }),
                          let decoded = String(data: data, encoding: .utf8) else { return [] }
                    let text = decoded as NSString
                    // Most files have no hit. Search them once instead of
                    // allocating and matching every Markdown line.
                    if !regex && !matches(text) { return [] }
                    var hits: [JSON] = [], line = 0
                    text.enumerateSubstrings(in: NSRange(location: 0, length: text.length), options: [.byLines, .substringNotRequired]) { _, range, _, stop in
                        line += 1
                        if request.cancelled { stop.pointee = true; return }
                        if matches(text, range: range) {
                            let snippet = text.substring(with: range)
                            hits.append(["line": line, "text": String(snippet.prefix(500))])
                            if hits.count >= 2 { stop.pointee = true }
                        }
                    }
                    return hits
                }
                if hits.isEmpty { continue }
                resultsLock.lock()
                if contents.count < 100 { contents[index] = [relative, hits] }
                let now = Date.timeIntervalSinceReferenceDate
                if contents.count != published && now - lastProgress >= 0.08 {
                    progress(result()); published = contents.count; lastProgress = now
                }
                resultsLock.unlock()
              }
            }
            completion(request.cancelled ? ["cancelled": true] : result())
        }
    }
}
