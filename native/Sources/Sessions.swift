import AppKit

// Like the AppKit document registry, session state is confined to the main
// thread; filesystem writes use FileService's serial queue.
final class NativeSessions {
    unowned let app: NativeApplicationDelegate
    private var checkpoint: Task<Void, Never>?
    private var revision = 0
    private var writing = false
    var restoring = false
    var terminating = false
    var recoveryFailed = false
    weak var restoredActiveDocument: NativeDocument?
    var enabled: Bool { app.settings["restoreSession"] as? Bool == true }
    var url: URL { app.files.directory.appendingPathComponent("session.json") }

    init(app: NativeApplicationDelegate) { self.app = app }

    func changed() {
        revision += 1
        guard enabled, !restoring, !terminating, checkpoint == nil, !writing else { return }
        // A fixed deadline also checkpoints continuous typing.
        checkpoint = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard let self = self, !Task.isCancelled else { return }
            self.checkpoint = nil
            guard self.app.documents.allSatisfy(\.ready) else { return }
            do { try await self.store() }
            catch { self.app.log("Session checkpoint: " + error.localizedDescription) }
        }
    }

    func settingsChanged(wasEnabled: Bool) {
        if enabled { if !wasEnabled { changed() }; return }
        checkpoint?.cancel(); checkpoint = nil
        recoveryFailed = false
        guard wasEnabled else { return }
        let file = url
        app.files.queue.async { try? FileManager.default.removeItem(at: file) }
    }

    func storedGroups() -> [JSON] {
        guard enabled, let data = try? Data(contentsOf: url), data.count <= 64 * 1024 * 1024,
              let manifest = (try? JSONSerialization.jsonObject(with: data)) as? JSON,
              manifest["version"] as? Int == 1, let groups = manifest["groups"] as? [JSON] else { return [] }
        return groups.filter { ($0["documents"] as? [JSON])?.isEmpty == false }
    }

    func restore() -> Bool {
        let groups = storedGroups()
        guard !groups.isEmpty else { return false }
        restoring = true
        var foreground: NativeDocument?
        for group in groups {
            guard let entries = group["documents"] as? [JSON] else { continue }
            var first: NativeDocument?, selected: NativeDocument?
            for (index, state) in entries.enumerated() {
                guard state["path"] is String || state["text"] is String else { continue }
                let document = app.newDocument(tab: first, restoredState: state)
                if first == nil { first = document }
                if index == group["selected"] as? Int { selected = document }
            }
            if let first = first, let frame = group["frame"] as? [Double], frame.count == 4, frame.allSatisfy(\.isFinite) {
                var rect = NSRect(x: frame[0], y: frame[1], width: max(640, min(4096, frame[2])), height: max(440, min(4096, frame[3])))
                if !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(rect) }), let screen = NSScreen.main {
                    rect.origin = NSPoint(x: screen.visibleFrame.midX - rect.width / 2, y: screen.visibleFrame.midY - rect.height / 2)
                }
                first.window.setFrame(rect, display: true)
            }
            if let selected = selected ?? first {
                selected.window.makeKeyAndOrderFront(nil)
                if group["active"] as? Bool == true { foreground = selected }
            }
        }
        restoredActiveDocument = foreground
        foreground?.window.makeKeyAndOrderFront(nil)
        if app.documents.isEmpty { restoring = false; return false }
        Task { @MainActor in
            for _ in 0..<400 {
                if self.app.documents.allSatisfy(\.ready) { break }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            self.restoring = false; self.changed()
        }
        return true
    }

    @MainActor func prepareRestore(_ state: JSON) async throws -> JSON {
        guard let text = state["text"] as? String, text.utf8.count > 2_000_000 else { return state }
        // Older or malformed snapshots must not silently drop a cached draft.
        let folder = app.files.directory.appendingPathComponent("session-recovery")
        let file = folder.appendingPathComponent(UUID().uuidString + ".md")
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            app.files.queue.async {
                do {
                    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    try Data(text.utf8).write(to: file, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
        var recovered = state
        recovered.removeValue(forKey: "text"); recovered.removeValue(forKey: "savedText")
        recovered["path"] = file.path; recovered["dirty"] = false; recovered["recoveredDraft"] = true
        return recovered
    }

    @MainActor func manifest() async throws -> JSON {
        let documents = app.documents
        guard !recoveryFailed else { throw NativeError("The session could not be restored. Its saved data has been kept.") }
        guard documents.allSatisfy(\.ready) else { throw NativeError("Wait for documents to finish opening before saving the session.") }
        var visited = Set<String>(), groups: [JSON] = []
        let active = app.active
        for document in documents where !visited.contains(document.id) {
            let windows = document.window.tabbedWindows ?? [document.window]
            let members = windows.compactMap { window in documents.first { $0.window === window } }
            var states: [JSON] = []
            let selectedWindow = document.window.tabGroup?.selectedWindow ?? document.window
            var selected = 0
            for member in members {
                visited.insert(member.id)
                guard let state = try await member.evaluate("window.__lettrine.captureSession()") as? JSON else { throw NativeError("The session could not be saved.") }
                if let text = state["text"] as? String, text.utf8.count > 2_000_000 { throw NativeError("The session document is too large to restore.") }
                if member.window === selectedWindow { selected = states.count }
                states.append(state)
            }
            let frame = document.window.frame
            groups.append(["documents": states, "selected": selected, "active": members.contains { $0 === active },
                           "frame": [frame.origin.x, frame.origin.y, frame.width, frame.height]])
        }
        return ["version": 1, "groups": groups]
    }

    @MainActor func store() async throws {
        guard enabled else { return }
        guard !restoring else { throw NativeError("Wait for documents to finish opening before saving the session.") }
        if writing { throw NativeError("The session is still being saved. Try again.") }
        writing = true
        let start = revision
        defer { writing = false; if revision != start && !terminating { changed() } }
        let value = try await manifest()
        guard enabled else { return }
        let file = url
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            app.files.queue.async {
                do {
                    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
                    guard data.count <= 64 * 1024 * 1024 else { throw NativeError("The session is too large to restore.") }
                    try data.write(to: file, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    @MainActor func prepareToQuit() async throws {
        terminating = true; checkpoint?.cancel(); checkpoint = nil
        for _ in 0..<400 {
            if !writing && !restoring && app.documents.allSatisfy(\.ready) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard enabled else { throw NativeError("The session could not be saved.") }
        try await store()
        guard enabled else { throw NativeError("The session could not be saved.") }
    }
}

extension NativeApplicationDelegate {
    @MainActor func saveAll() async -> Bool {
        if savingAll { return false }
        savingAll = true; buildMenu()
        let previous = active
        defer { savingAll = false; previous?.window.makeKeyAndOrderFront(nil); buildMenu() }
        // Sequential requests keep Save As panels attached to the right window.
        for document in documents where document.dirty {
            if document.viewState["readonly"] as? Bool == true { continue }
            document.window.makeKeyAndOrderFront(nil)
            if !(await document.requestSave()) { return false }
        }
        return true
    }
}
