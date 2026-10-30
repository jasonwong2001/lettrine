import AppKit

final class NativeImports {
    unowned let app: NativeApplicationDelegate
    init(app: NativeApplicationDelegate) { self.app = app }
    func handle(_ payload: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        var payload = payload
        let formats = (readJSON(app.webRoot.appendingPathComponent("native-config.json")) as? JSON)?["importFormats"] as? [String: String] ?? [:]
        guard let source = payload["sourcePath"] as? String else {
            app.choose(["title": app.translate("Import Document"), "filters": [["extensions": Array(formats.keys).sorted()]]], document: document) { result, error in
                guard let selected = (result as? JSON)?["path"] as? String else { reply(result, error); return }
                var next = payload; next["sourcePath"] = selected; self.handle(next, document: document, reply: reply)
            }; return
        }
        let input = fileURL(source)
        guard let format = formats[input.pathExtension.lowercased()] else { reply(nil, app.translate("This file format cannot be imported.")); return }
        guard let destination = payload["destination"] as? String else {
            let folder = (payload["directory"] as? String).map(fileURL) ?? input.deletingLastPathComponent()
            let suggested = (payload["defaultPath"] as? String).map(fileURL) ?? folder.appendingPathComponent(input.deletingPathExtension().lastPathComponent).appendingPathExtension("md")
            app.choose(["title": app.translate("Save Imported Markdown"), "defaultPath": suggested.path, "filters": [["extensions": ["md"]]]], document: document, save: true) { result, error in
                guard let selected = (result as? JSON)?["path"] as? String else { reply(result, error); return }
                var next = payload; next["destination"] = selected; next["replace"] = true
                self.handle(next, document: document, reply: reply)
            }; return
        }
        payload["pandocPath"] = payload["pandocPath"] ?? app.settings["pandocPath"]
        app.files.queue.async {
            do {
                let result = try self.convert(input, to: fileURL(destination), format: format, payload: payload)
                DispatchQueue.main.async { reply(result, nil) }
            } catch {
                DispatchQueue.main.async { reply(nil, self.app.translate(error.localizedDescription)) }
            }
        }
    }
    func convert(_ source: URL, to destination: URL, format: String, payload: JSON) throws -> JSON {
        let fm = FileManager.default
        guard source.resolvingSymlinksInPath() != destination.resolvingSymlinksInPath() else { throw NativeError("Choose an import destination different from the source file.") }
        guard ["md", "markdown", "mdown", "mkdn"].contains(destination.pathExtension.lowercased()) else { throw NativeError("Choose a Markdown file for the import destination.") }
        guard !fm.fileExists(atPath: destination.path) || payload["replace"] as? Bool == true else { throw NativeError("The import destination already exists. Choose another file.") }
        let configured = payload["pandocPath"] as? String ?? ""
        let candidates = configured.isEmpty ? [ProcessInfo.processInfo.environment["PANDOC"], "/opt/homebrew/bin/pandoc", "/usr/local/bin/pandoc", "/usr/bin/pandoc"].compactMap { $0 }.filter { !$0.isEmpty } : [configured]
        guard let program = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) else { throw NativeError("Install Pandoc or choose its executable in Settings to import this format.") }
        let folder = destination.deletingLastPathComponent()
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let stage = folder.appendingPathComponent(".lettrine-import-" + UUID().uuidString, isDirectory: true)
        try fm.createDirectory(at: stage, withIntermediateDirectories: false)
        defer { try? fm.removeItem(at: stage) }
        let stem = destination.deletingPathExtension().lastPathComponent + ".assets"
        var assetName = stem, suffix = 2
        while fm.fileExists(atPath: folder.appendingPathComponent(assetName).path) { assetName = stem + "-\(suffix)"; suffix += 1 }
        let output = stage.appendingPathComponent("document.md"), errors = Pipe(), process = Process()
        process.executableURL = fileURL(program)
        process.currentDirectoryURL = stage
        process.arguments = ["--from=" + format, "--to=gfm", "--wrap=none", "--markdown-headings=atx",
                             "--lua-filter", app.webRoot.appendingPathComponent("src/renderer/pandoc-import.lua").path,
                             "--extract-media=" + assetName, "--resource-path=" + source.deletingLastPathComponent().path,
                             "--output", output.path, source.path]
        process.standardInput = FileHandle.nullDevice; process.standardOutput = FileHandle.nullDevice; process.standardError = errors
        try process.run()
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: timeout)
        defer { timeout.cancel() }
        let diagnostics = errors.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let warning = String(data: diagnostics, encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else { throw NativeError(warning.isEmpty ? "The file could not be imported." : warning) }
        let data = try Data(contentsOf: output)
        guard String(data: data, encoding: .utf8) != nil else { throw NativeError("The imported document is not valid UTF-8.") }
        let assets = stage.appendingPathComponent(assetName), finalAssets = folder.appendingPathComponent(assetName)
        var moved = false
        do {
            if fm.fileExists(atPath: assets.path) {
                try fm.moveItem(at: assets, to: finalAssets); moved = true
            }
            try data.write(to: destination, options: .atomic)
        } catch {
            if moved { try? fm.removeItem(at: finalAssets) }
            throw error
        }
        app.resources.authorize(folder)
        return ["ok": true, "canceled": false, "path": destination.path, "assets": moved ? finalAssets.path as Any : NSNull(),
                "warnings": warning]
    }
}
