import Foundation
import CryptoKit

typealias JSON = [String: Any]
struct NativeError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
func jsonString(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]), let text = String(data: data, encoding: .utf8) else { return "null" }
    return text
}
func readJSON(_ url: URL, fallback: Any = [:]) -> Any {
    guard let data = try? Data(contentsOf: url), let object = try? JSONSerialization.jsonObject(with: data) else { return fallback }
    return object
}
func writeJSON(_ object: Any, to url: URL) throws {
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
}
func fileURL(_ path: String) -> URL { URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL }
func under(_ path: String, _ root: String) -> Bool { path == root || path.hasPrefix(root.hasSuffix("/") ? root : root + "/") }
func relativePath(_ path: String, from directory: String) -> String {
    let target = fileURL(path).pathComponents, base = fileURL(directory).pathComponents
    var common = 0
    while common < min(target.count, base.count) && target[common] == base[common] { common += 1 }
    let result = Array(repeating: "..", count: base.count - common) + Array(target.dropFirst(common))
    return result.isEmpty ? "." : result.joined(separator: "/")
}
func fuzzyScore(_ query: String, _ name: String) -> Int? {
    let q = Array(query.lowercased().utf16), s = Array(name.lowercased().utf16)
    if q.isEmpty { return 0 }
    let boundaries = Set("/.\\- _".utf16)
    var qi = 0, score = 0, last = -2
    for (i, c) in s.enumerated() where qi < q.count {
        if c != q[qi] { continue }
        score += i == last + 1 ? 4 : 1
        if i == 0 || boundaries.contains(s[i - 1]) { score += 6 }
        score -= i / 8; last = i; qi += 1
    }
    return qi == q.count ? score : nil
}
let documentExtensions: Set<String> = Set((Bundle.main.object(forInfoDictionaryKey: "CFBundleDocumentTypes") as? [JSON] ?? []).flatMap { $0["CFBundleTypeExtensions"] as? [String] ?? [] }).union(["rst", "tex", "org"])
// `.mdlive-trash` is a recovery folder that earlier versions created.
let skippedDirectories: Set<String> = ["node_modules", "__pycache__", ".git", ".venv", ".mdlive-trash"]

// All mutable filesystem state runs on this single queue. A rename, queued
// save, settings merge, and their notifications consequently have one order.
final class FileService {
    let queue = DispatchQueue(label: "io.github.jasonwong2001.lettrine.files", qos: .userInitiated)
    let directory: URL
    let resources: URL
    var emit: ((String?, String, Any) -> Void)?
    var authorize: ((URL) -> Void)?
    private let fm = FileManager.default
    private(set) var settings: JSON
    private var paths: [String: String] = [:]
    private var detachedPaths: [String: String] = [:]
    private var aliases: [String: [(String, String?)]] = [:]
    private var roots: [String: String] = [:]
    private var versions: [String: String] = [:]
    private var indexes: [String: [JSON]] = [:]
    private var folderSources: [String: DispatchSourceFileSystemObject] = [:]
    // Finder-launched apps can have a 256-descriptor soft limit. Each directory
    // watch holds one open, so leave room for enumeration, documents and WebKit.
    private let folderWatchLimit: Int = {
        var limit = rlimit()
        guard getrlimit(RLIMIT_NOFILE, &limit) == 0 else { return 64 }
        return Int(min(512, limit.rlim_cur / 4))
    }()
    private var refreshPending = Set<String>()
    private var poller: DispatchSourceTimer?
    private var past: [FileAction] = [], future: [FileAction] = []
    let searches = LibrarySearch()
    struct FileAction { var kind: String; var before: String?; var after: String?; var backup: String?; var label: String; var images: ImageTransaction? = nil }

    init(directory: URL, resources: URL) {
        self.directory = directory; self.resources = resources
        var saved = readJSON(directory.appendingPathComponent("settings.json")) as? JSON ?? [:]
        for _ in 0..<10 { guard let patch = saved.removeValue(forKey: "__patch") as? JSON else { break }; saved.merge(patch) { _, new in new } }
        settings = saved
        try? fm.createDirectory(at: directory.appendingPathComponent("themes"), withIntermediateDirectories: true)
    }
    func startMonitoring() {
        queue.async {
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + 0.7, repeating: 0.7)
            timer.setEventHandler { [weak self] in self?.pollDocuments() }
            timer.resume(); self.poller = timer
        }
    }
    func event(_ channel: String, _ value: Any, tab: String? = nil) { emit?(tab, channel, value) }
    func required(_ payload: JSON, _ key: String) throws -> String {
        guard let value = payload[key] as? String, !value.isEmpty else { throw NativeError("Missing " + key) }
        return value
    }
    func url(_ payload: JSON, _ key: String = "path") throws -> URL { fileURL(try required(payload, key)) }
    func stat(_ url: URL) throws -> JSON {
        let attrs = try fm.attributesOfItem(atPath: url.path)
        return ["path": url.path, "name": url.lastPathComponent, "isDirectory": attrs[.type] as? FileAttributeType == .typeDirectory,
                "size": attrs[.size] as? Int ?? 0, "mtimeMs": (attrs[.modificationDate] as? Date ?? .distantPast).timeIntervalSince1970 * 1000,
                "ctimeMs": (attrs[.creationDate] as? Date ?? .distantPast).timeIntervalSince1970 * 1000,
                "birthtimeMs": (attrs[.creationDate] as? Date ?? .distantPast).timeIntervalSince1970 * 1000]
    }
    func version(_ path: String) -> String? {
        guard let a = try? fm.attributesOfItem(atPath: path), a[.type] as? FileAttributeType == .typeRegular else { return nil }
        return "\(a[.systemFileNumber] ?? 0):\((a[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0):\(a[.size] ?? 0)"
    }
    private func pollDocuments() {
        for (tab, path) in paths {
            guard let next = version(path) else {
                if versions[path] != nil && !fm.fileExists(atPath: path) {
                    paths.removeValue(forKey: tab)
                    aliases[tab, default: []].append((path, nil))
                    event("doc.pathChanged", ["removed": path, "path": NSNull()], tab: tab)
                }
                continue
            }
            guard versions[path] != next else { continue }
            versions[path] = next
            if let info = try? stat(fileURL(path)) { event("doc.diskChanged", info, tab: tab) }
        }
    }
    func watch(_ folder: URL) {
        guard folderSources[folder.path] == nil, folderSources.count < folderWatchLimit else { return }
        let fd = open(folder.path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .rename, .delete], queue: queue)
        source.setCancelHandler { close(fd) }
        source.setEventHandler { [weak self] in
            guard let self = self, !self.refreshPending.contains(folder.path) else { return }
            self.refreshPending.insert(folder.path)
            self.queue.asyncAfter(deadline: .now() + 0.18) {
                self.refreshPending.remove(folder.path)
                self.indexes = self.indexes.filter { !under(folder.path, $0.key) }
                self.event("folder.changed", ["path": folder.path]); self.pollDocuments()
            }
        }
        folderSources[folder.path] = source; source.resume()
    }
    func list(_ folder: URL, limit: Int = 20000) -> [JSON] {
        if let cached = indexes[folder.path] { return cached }
        authorize?(folder)
        var result: [JSON] = [], visited = 0
        func walk(_ dir: URL, _ depth: Int) {
            guard depth <= 32, visited < 20000, result.count < limit else { return }
            watch(dir)
            let options: FileManager.DirectoryEnumerationOptions = settings["showHiddenFiles"] as? Bool == true ? [] : [.skipsHiddenFiles]
            let entries = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey, .fileSizeKey], options: options)) ?? []
            for entry in entries {
                if result.count >= limit || visited >= 20000 { break }
                visited += 1
                // Foundation's enumerator resolves /var to /private/var.
                // Preserve the caller's spelling so indexes, open tabs and
                // rename/save aliases all refer to the same document path.
                let file = dir.appendingPathComponent(entry.lastPathComponent)
                guard !skippedDirectories.contains(file.lastPathComponent), let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isRegularFileKey, .isSymbolicLinkKey, .contentModificationDateKey, .fileSizeKey]), values.isSymbolicLink != true else { continue }
                if values.isDirectory == true {
                    result.append(["name": file.lastPathComponent, "path": file.path, "isDirectory": true])
                    walk(file, depth + 1)
                } else if values.isRegularFile == true && documentExtensions.contains(file.pathExtension.lowercased()) {
                    // The sidebar sorts and labels documents by modification date.
                    result.append(["name": file.lastPathComponent, "path": file.path, "isDirectory": false, "mtimeMs": (values.contentModificationDate ?? .distantPast).timeIntervalSince1970 * 1000, "size": values.fileSize ?? 0])
                }
            }
        }
        walk(folder, 0)
        if indexes.count >= 8, let key = indexes.keys.first { indexes.removeValue(forKey: key) }
        indexes[folder.path] = result
        return result
    }
    func indexed(_ folder: String) -> [JSON] {
        list(fileURL(folder)).filter { $0["isDirectory"] as? Bool != true }
    }
    func closeLibrary(_ tab: String) {
        roots.removeValue(forKey: tab)
        let needed = Array(roots.values) + paths.values.map { fileURL($0).deletingLastPathComponent().path }
        for folder in Array(folderSources.keys) where !needed.contains(where: { under(folder, $0) }) {
            folderSources.removeValue(forKey: folder)?.cancel()
        }
        indexes = indexes.filter { folder, _ in needed.contains(where: { under(folder, $0) || under($0, folder) }) }
    }
    func startSearch(_ payload: JSON, tab: String, completion: @escaping (JSON) -> Void) {
        let request = searches.begin(tab)
        queue.async {
            guard !request.cancelled else { completion(["cancelled": true]); return }
            let folder = payload["folder"] as? String ?? self.roots[tab] ?? ""
            let files = folder.isEmpty ? [] : self.indexed(folder)
            self.searches.run(request, files: files, folder: folder, options: payload, progress: { result in
                guard let id = payload["requestId"] else { return }
                var update = result; update["requestId"] = id
                self.event("search.results", update, tab: tab)
            }, completion: completion)
        }
    }
    func recent(_ name: String) -> [String] { readJSON(directory.appendingPathComponent(name + ".json"), fallback: []) as? [String] ?? [] }
    func cacheRecent(_ incoming: [String], name: String = "recent-files", limit: Int = 40) throws {
        let next = incoming + recent(name).filter { !incoming.contains($0) }
        try writeJSON(Array(next.prefix(limit)), to: directory.appendingPathComponent(name + ".json"))
    }
    func patchSettings(_ patch: JSON) throws -> JSON {
        let hiddenChanged = patch["showHiddenFiles"] as? Bool != nil && patch["showHiddenFiles"] as? Bool != settings["showHiddenFiles"] as? Bool
        settings.merge(patch) { _, new in new }; settings.removeValue(forKey: "__patch")
        if let pinned = settings["pinnedFolders"] as? [String] {
            var seen = Set<String>()
            settings["pinnedFolders"] = pinned.map { fileURL($0).path }.filter { seen.insert($0).inserted }
        }
        for document in paths.values { authorizeImages(fileURL(document)) }
        try writeJSON(settings, to: directory.appendingPathComponent("settings.json"))
        event("setting.changed", settings)
        if hiddenChanged { indexes.removeAll(); event("folder.changed", [:]) }
        return ["ok": true, "settings": settings]
    }
    func historyState() -> JSON { ["canUndo": !past.isEmpty, "canRedo": !future.isEmpty, "undoLabel": past.last?.label ?? "", "redoLabel": future.last?.label ?? ""] }
    func authorizeImages(_ document: URL) {
        guard let root = settings["imageRootPath"] as? String, !root.isEmpty else { return }
        authorize?(root.hasPrefix("/") ? fileURL(root) : document.deletingLastPathComponent().appendingPathComponent(root).standardizedFileURL)
    }
    func vacant(_ url: URL) throws { if fm.fileExists(atPath: url.path) { throw NativeError("“\(url.lastPathComponent)” already exists. Choose a different name.") } }
    func backup(_ path: String) throws -> String {
        let target = directory.appendingPathComponent("file-recovery/" + UUID().uuidString).appendingPathComponent(fileURL(path).lastPathComponent)
        try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try fm.copyItem(at: fileURL(path), to: target); return target.path
    }
    func record(_ action: FileAction) { past.append(action); if past.count > 40 { past.removeFirst() }; future = [] }
    func move(_ from: String, _ to: String, kind: String = "move") throws -> JSON {
        if from == to { return ["path": to, "changes": []] }
        if under(to, from) { throw NativeError("A folder cannot be moved inside itself") }
        try vacant(fileURL(to)); try fm.moveItem(atPath: from, toPath: to)
        record(FileAction(kind: kind, before: from, after: to, label: "\(kind.capitalized) “\(fileURL(from).lastPathComponent)”"))
        let changes: [JSON] = [["from": from, "to": to]]; try apply(changes)
        return ["path": to, "changes": changes]
    }
    func copy(_ from: String, _ to: String) throws -> JSON {
        if under(to, from) { throw NativeError("A folder cannot be copied inside itself") }
        try vacant(fileURL(to)); try fm.copyItem(atPath: from, toPath: to)
        record(FileAction(kind: "copy", before: from, after: to, label: "Copy “\(fileURL(from).lastPathComponent)”"))
        let changes: [JSON] = [["added": to]]; try apply(changes); return ["path": to, "changes": changes]
    }
    func trash(_ path: String) throws -> JSON {
        let saved = try backup(path)
        try fm.trashItem(at: fileURL(path), resultingItemURL: nil)
        record(FileAction(kind: "trash", before: path, backup: saved, label: "Delete “\(fileURL(path).lastPathComponent)”"))
        let changes: [JSON] = [["removed": path]]; try apply(changes); return ["ok": true, "changes": changes]
    }
    func apply(_ changes: [JSON]) throws {
        indexes.removeAll()
        for change in changes {
            let from = change["from"] as? String, to = change["to"] as? String
            if let from = from, let to = to {
                for name in ["recent-files", "recent-folders"] {
                    try writeJSON(recent(name).map { under($0, from) ? to + $0.dropFirst(from.count) : $0 }, to: directory.appendingPathComponent(name + ".json"))
                }
                for path in Set([from] + Array(paths.values).filter { under($0, from) }) { try moveSnapshots(path, to + path.dropFirst(from.count)) }
            }
            for tab in Set(paths.keys).union(aliases.keys) {
                if let from = from, let to = to {
                    if let path = paths[tab], under(path, from) { aliases[tab, default: []].append((from, to)); paths[tab] = to + path.dropFirst(from.count) }
                    if let root = roots[tab], under(root, from) { roots[tab] = to + root.dropFirst(from.count) }
                    if let path = detachedPaths[tab], under(path, from) { detachedPaths[tab] = to + path.dropFirst(from.count) }
                } else if let removed = change["removed"] as? String, let path = paths[tab], under(path, removed) {
                    detachedPaths[tab] = path; aliases[tab, default: []].append((removed, nil)); paths.removeValue(forKey: tab)
                } else if let restored = change["restored"] as? String, paths[tab] == nil,
                          let detached = detachedPaths[tab], under(detached, restored) {
                    paths[tab] = detached; detachedPaths.removeValue(forKey: tab)
                    aliases[tab]?.removeAll(where: { $0.1 == nil && under($0.0, restored) })
                }
                var payload = change; payload["path"] = paths[tab] ?? NSNull()
                if let path = paths[tab] { authorize?(fileURL(path).deletingLastPathComponent()); versions[path] = version(path) }
                event("doc.pathChanged", payload, tab: tab)
            }
        }
        event("folder.changed", [:])
    }
    func history(_ redo: Bool) throws -> JSON {
        guard var action = redo ? future.last : past.last else { return historyState() }
        var changes: [JSON] = []
        if let images = action.images {
            changes = try replayImages(images, redo: redo)
        } else if action.kind == "move" || action.kind == "rename" {
            let from = (redo ? action.before : action.after)!, to = (redo ? action.after : action.before)!
            try vacant(fileURL(to)); try fm.moveItem(atPath: from, toPath: to); changes = [["from": from, "to": to]]
        } else {
            let path = (action.kind == "trash" ? action.before : action.after)!
            let removing = action.kind == "trash" ? redo : !redo
            if removing { action.backup = try backup(path); try fm.trashItem(at: fileURL(path), resultingItemURL: nil); changes = [["removed": path]] }
            else {
                try vacant(fileURL(path))
                guard let saved = action.backup else { throw NativeError("No recovery copy is available") }
                try fm.copyItem(atPath: saved, toPath: path); changes = [["restored": path]]
            }
        }
        if redo { future.removeLast(); past.append(action) } else { past.removeLast(); future.append(action) }
        try apply(changes); var result = historyState(); result["changes"] = changes; return result
    }
    private func snapshotFolder(_ document: String) -> URL {
        let hash = SHA256.hash(data: Data(fileURL(document).path.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("snapshots/" + hash)
    }
    private func legacySnapshotFolder(_ document: String) -> URL {
        let legacy = document.replacingOccurrences(of: "[\\\\/:*?\"<>|\\s]+", with: "_", options: .regularExpression)
        return directory.appendingPathComponent("snapshots/" + legacy)
    }
    func snapshots(_ document: String) -> [JSON] {
        let entries = [snapshotFolder(document), legacySnapshotFolder(document)].flatMap { (try? fm.contentsOfDirectory(at: $0, includingPropertiesForKeys: nil)) ?? [] }
        return entries.filter { $0.pathExtension == "md" }.compactMap { file -> JSON? in
            guard var info = try? stat(file) else { return nil }; info["file"] = file.lastPathComponent; return info
        }.sorted { ($0["mtimeMs"] as? Double ?? 0) > ($1["mtimeMs"] as? Double ?? 0) }.prefix(20).map { $0 }
    }
    func snapshot(_ document: String, _ text: String) throws {
        if let last = snapshots(document).first?["mtimeMs"] as? Double, Date().timeIntervalSince1970 * 1000 - last < 300000 { return }
        let folder = snapshotFolder(document); try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try Data(text.utf8).write(to: folder.appendingPathComponent(stamp + "-" + UUID().uuidString + ".md"), options: .atomic)
        let files = ((try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "md" }.sorted { $0.lastPathComponent > $1.lastPathComponent }
        for file in files.dropFirst(20) { try? fm.removeItem(at: file) }
    }
    private func moveSnapshots(_ from: String, _ to: String) throws {
        if from == to { return }; let target = snapshotFolder(to)
        for folder in [snapshotFolder(from), legacySnapshotFolder(from)] {
            for file in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where file.pathExtension == "md" {
                try fm.createDirectory(at: target, withIntermediateDirectories: true)
                let destination = target.appendingPathComponent(file.lastPathComponent)
                if !fm.fileExists(atPath: destination.path) { try fm.copyItem(at: file, to: destination) }
            }
        }
    }
    func handle(_ channel: String, _ p: JSON, tab: String) throws -> Any {
        var p = p
        p["_tab"] = tab
        if p["docPath"] == nil, let path = paths[tab] { p["docPath"] = path }
        switch channel {
        case "doc.read":
            let file = try url(p), info = try stat(file)
            authorize?(file.deletingLastPathComponent()); watch(file.deletingLastPathComponent())
            authorizeImages(file)
            let size = info["size"] as? Int ?? 0
            var result = info; result["text"] = size > 2000000 ? "" : try String(contentsOf: file, encoding: .utf8); return result
        case "doc.markOpen":
            if let path = p["path"] as? String { paths[tab] = path; versions[path] = version(path); authorize?(fileURL(path).deletingLastPathComponent()); watch(fileURL(path).deletingLastPathComponent()) }
            else { paths.removeValue(forKey: tab) }
            aliases[tab] = []; detachedPaths.removeValue(forKey: tab); return ["ok": true]
        case "doc.write":
            var path = try required(p, "path")
            if p["followRenames"] as? Bool == true {
                guard paths[tab] != nil else { throw NativeError("This file was deleted. Use Save As or undo the file operation before saving.") }
                for (from, to) in aliases[tab] ?? [] where under(path, from) {
                    guard let to = to else { throw NativeError("This file was deleted. Use Save As or undo the file operation before saving.") }
                    path = to + path.dropFirst(from.count)
                }
            } else { aliases[tab] = [] }
            let file = fileURL(path), text = p["text"] as? String ?? ""
            try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: file, options: .atomic)
            paths[tab] = path; versions[path] = version(path); indexes.removeAll(); try? snapshot(path, text)
            authorize?(file.deletingLastPathComponent()); return ["ok": true, "path": path]
        case "native.closed":
            paths.removeValue(forKey: tab); aliases.removeValue(forKey: tab); detachedPaths.removeValue(forKey: tab)
            searches.cancel(tab); closeLibrary(tab); return ["ok": true]
        case "path.stat", "library.statFile": return try stat(url(p))
        case "path.isDirectory": return try stat(url(p))["isDirectory"] ?? false
        case "path.reference":
            let path = try required(p, "path"), doc = p["docPath"] as? String ?? paths[tab]
            return ["reference": doc.map { relativePath(path, from: fileURL($0).deletingLastPathComponent().path) } ?? path]
        case "library.listDocsUnder":
            let folder = try url(p)
            if p["setRoot"] as? Bool == true { roots[tab] = folder.path }
            return list(folder)
        case "library.closeFolder": closeLibrary(tab); return ["ok": true]
        case "library.newFile", "library.newFolder":
            let target = try url(p), isDirectory = channel == "library.newFolder"
            try vacant(target)
            if isDirectory { try fm.createDirectory(at: target, withIntermediateDirectories: false) }
            else { try Data().write(to: target, options: .withoutOverwriting) }
            record(FileAction(kind: "create", after: target.path, label: "New “\(target.lastPathComponent)”"))
            try apply([["added": target.path]]); return ["path": target.path]
        case "library.renameFile":
            let from = try url(p, "from"), name = try required(p, "name")
            if name.contains("/") || name == "." || name == ".." { throw NativeError("Enter a file name without a folder path") }
            return try move(from.path, from.deletingLastPathComponent().appendingPathComponent(name).path, kind: "rename")
        case "path.moveTo": return try move(required(p, "from"), required(p, "to"))
        case "path.copyTo": return try copy(required(p, "from"), required(p, "to"))
        case "library.duplicate":
            let source = try url(p), ext = source.pathExtension, stem = source.deletingPathExtension().lastPathComponent
            var name = stem + " copy" + (ext.isEmpty ? "" : "." + ext), n = 2
            while fm.fileExists(atPath: source.deletingLastPathComponent().appendingPathComponent(name).path) { name = stem + " \(n)" + (ext.isEmpty ? "" : "." + ext); n += 1 }
            return try copy(source.path, source.deletingLastPathComponent().appendingPathComponent(name).path)
        case "library.trashItem": return try trash(required(p, "path"))
        case "path.removeFiles":
            for path in p["paths"] as? [String] ?? [] { _ = try trash(path) }; return ["ok": true]
        case "fileOperation.state": return historyState()
        case "fileOperation.history": return try history(p["redo"] as? Bool == true)
        case "quickOpen.query":
            let scope = p["scope"] as? String ?? roots[tab] ?? "", query = p["text"] as? String ?? ""
            let canonicalRoot = scope.isEmpty ? "" : fileURL(scope).resolvingSymlinksInPath().path
            let candidates = recent("recent-files").map { ["name": fileURL($0).lastPathComponent, "path": $0, "_identity": fileURL($0).resolvingSymlinksInPath().path] as JSON } + (scope.isEmpty ? [] : indexed(scope))
            var seen = Set<String>()
            return candidates.compactMap { file -> JSON? in
                guard let path = file["path"] as? String else { return nil }
                // Indexed trees skip symlinks, so resolving the root once is
                // sufficient. Recent paths may use a Finder-resolved alias.
                let identity = file["_identity"] as? String ?? (canonicalRoot + path.dropFirst(scope.count))
                guard seen.insert(identity).inserted else { return nil }
                let name = file["name"] as? String ?? ""
                guard let score = fuzzyScore(query, name) ?? fuzzyScore(query, scope.isEmpty ? path : relativePath(path, from: scope)).map({ $0 - 10 }) else { return nil }
                var result = file; result.removeValue(forKey: "_identity"); result["score"] = score; return result
            }.sorted { ($0["score"] as? Int ?? 0) > ($1["score"] as? Int ?? 0) }.prefix(100).map { $0 }
        case "quickOpen.recentFiles": return recent("recent-files").map { ["name": fileURL($0).lastPathComponent, "path": $0] }
        case "quickOpen.cacheRecentFiles":
            let incoming = p["paths"] as? [String] ?? (p["path"] as? String).map { [$0] } ?? []
            if incoming.isEmpty { try writeJSON([], to: directory.appendingPathComponent("recent-files.json")) }
            else { try cacheRecent(incoming) }; return ["ok": true]
        case "library.recentFolders": return recent("recent-folders")
        case "native.recentFolder": try cacheRecent([required(p, "path")], name: "recent-folders", limit: 12); return ["ok": true]
        case "setting.get": return (p["key"] as? String == "__patch" || p["key"] == nil) ? settings : settings[p["key"] as? String ?? ""] ?? NSNull()
        case "setting.put":
            let key = p["key"] as? String ?? "__patch"
            return try patchSettings(key == "__patch" ? p["value"] as? JSON ?? [:] : [key: p["value"] ?? NSNull()])
        case "word.getTextReplacement": return settings["textReplacements"] as? JSON ?? [:]
        case "snapshots.list": return snapshots(try required(p, "path"))
        case "snapshots.restore":
            let file = try url(p), root = directory.appendingPathComponent("snapshots").resolvingSymlinksInPath().path
            guard under(file.resolvingSymlinksInPath().path, root), file.pathExtension == "md" else { throw NativeError("Choose a document snapshot") }
            return ["text": try String(contentsOf: file, encoding: .utf8)]
        case "native.resource":
            let file = try url(p); return ["data": try Data(contentsOf: file).base64EncodedString(), "path": file.path]
        default:
            if let result = try assetOperation(channel, p) { return result }
            throw NativeError("Unknown filesystem operation: " + channel)
        }
    }
}
