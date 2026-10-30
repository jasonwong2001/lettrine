import Foundation

func webFileURL(_ file: URL) -> String {
    var components = URLComponents(); components.scheme = "lettrine"; components.host = "file"; components.path = file.path
    return components.url!.absoluteString
}

extension FileService {
    func assetOperation(_ channel: String, _ p: JSON) throws -> Any? {
        let fm = FileManager.default, themes = directory.appendingPathComponent("themes")
        let doc = p["docPath"] as? String
        switch channel {
        case "theme.list":
            let builtins = ["lettrine", "lettrine-dark"]
            let custom = ((try? fm.contentsOfDirectory(atPath: themes.path)) ?? []).filter { $0.hasSuffix(".css") && !$0.hasSuffix(".user.css") }.map { String($0.dropLast(4)) }
            return Array(Set(builtins + custom)).sorted().map { ["name": $0] }
        case "theme.resolve":
            let name = (p["name"] as? String ?? "lettrine").replacingOccurrences(of: "/", with: "")
            let custom = themes.appendingPathComponent(name + ".css"), builtin = resources.appendingPathComponent("src/renderer/styles/themes/" + name + ".css")
            func existing(_ file: URL) -> Any {
                guard let info = try? stat(file), let modified = info["mtimeMs"] as? Double else { return NSNull() }
                return webFileURL(file) + "?v=" + String(modified)
            }
            authorize?(themes)
            watch(themes)
            return ["theme": existing(fm.fileExists(atPath: custom.path) ? custom : builtin), "baseOverride": existing(themes.appendingPathComponent("base.user.css")), "override": existing(themes.appendingPathComponent(name + ".user.css"))]
        case "native.asset":
            let value = try required(p, "url")
            let file: URL
            if let url = URL(string: value), url.scheme == "lettrine" {
                if url.host == "app" { file = resources.appendingPathComponent(url.path).standardizedFileURL; guard under(file.path, resources.path) else { throw NativeError("Invalid resource path") } }
                else if url.host == "file" { file = fileURL(url.path) }
                else { throw NativeError("Invalid resource origin") }
            } else if let local = imagePath(value, doc: doc) { file = local }
            else { throw NativeError("This resource is not a local file") }
            let data = try Data(contentsOf: file)
            return ["data": data.base64EncodedString(), "text": String(data: data, encoding: .utf8) as Any? ?? NSNull(), "mime": Resources.mime(file), "url": webFileURL(file)]
        case "images.import":
            let source = p["sourcePath"] as? String
            let uploading = p["_prepareUpload"] as? Bool == true
            if let source = source, settings["imageCopyToFolder"] as? Bool == false && !uploading {
                authorize?(fileURL(source).deletingLastPathComponent()); return ["path": source, "reference": imageReference(fileURL(source), doc: doc)]
            }
            let data = try source.map { try Data(contentsOf: fileURL($0)) } ?? Data(base64Encoded: p["data"] as? String ?? "") ?? Data()
            let name = fileURL(p["name"] as? String ?? source ?? "image-\(Int(Date().timeIntervalSince1970 * 1000)).png").lastPathComponent
            let imageDir = p["dir"] as? String ?? settings["imageInsertDir"] as? String ?? "./assets"
            if !uploading && (imageDir == "inline" || doc == nil && !imageDir.hasPrefix("/")) {
                return ["reference": "data:\(Resources.mime(fileURL(name)));base64," + data.base64EncodedString()]
            }
            let base = doc.map { fileURL($0).deletingLastPathComponent() } ?? fm.homeDirectoryForCurrentUser
            let folder = uploading && (imageDir == "inline" || doc == nil && !imageDir.hasPrefix("/")) ? directory.appendingPathComponent("pasted-images") : imageDir.hasPrefix("/") ? fileURL(imageDir) : base.appendingPathComponent(imageDir).standardizedFileURL
            let target = try uniqueImage(data, name: name, folder: folder)
            authorize?(folder)
            return ["path": target.path, "reference": imageReference(target, doc: doc)]
        case "images.manage": return try manageImageFiles(p)
        case "images.save":
            let folder = try url(p, "dir"), name = p["name"] as? String ?? "image-\(UUID().uuidString).png"
            guard let data = Data(base64Encoded: p["data"] as? String ?? "") else { throw NativeError("Invalid image data") }
            let target = try uniqueImage(data, name: fileURL(name).lastPathComponent, folder: folder); authorize?(folder); return ["path": target.path]
        case "images.saveAs", "image.saveSVG":
            let data: Data
            if let reference = p["url"] as? String ?? p["path"] as? String { data = try imageData(reference, doc: doc) }
            else { data = Data(base64Encoded: p["data"] as? String ?? "") ?? Data() }
            if channel == "image.saveSVG", String(data: data, encoding: .utf8)?.range(of: "<svg[\\s>]", options: [.regularExpression, .caseInsensitive]) == nil { throw NativeError("This image does not contain SVG source") }
            let destination = try url(p, "destination")
            try data.write(to: destination, options: .atomic); return ["path": destination.path, "canceled": false]
        case "images.copyAll":
            let folder = try url(p, "dir"); var copied: [String] = [], failed: [JSON] = []
            for reference in Set(p["images"] as? [String] ?? []) {
                do {
                    let data = try imageData(reference, doc: doc)
                    let ext = reference.hasPrefix("data:image/svg") ? ".svg" : ".png"
                    let name = imagePath(reference, doc: doc)?.lastPathComponent ?? "image" + ext
                    copied.append(try uniqueImage(data, name: name, folder: folder).path)
                } catch { failed.append(["reference": reference, "error": error.localizedDescription]) }
            }
            return ["canceled": false, "dir": folder.path, "count": copied.count, "failed": failed]
        default: return nil
        }
    }
    func imagePath(_ reference: String, doc: String?) -> URL? {
        let base = doc.map { fileURL($0).deletingLastPathComponent() } ?? FileManager.default.homeDirectoryForCurrentUser
        if let url = URL(string: reference), url.scheme == "file" { return url }
        if let url = URL(string: reference), url.scheme == "lettrine", url.host == "file" { return fileURL(url.path) }
        if let root = settings["imageRootPath"] as? String, let published = settings["imageRootURL"] as? String,
           reference.hasPrefix(published.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/") {
            let relative = String(reference.dropFirst(published.trimmingCharacters(in: CharacterSet(charactersIn: "/")).count + 1)).removingPercentEncoding ?? ""
            let folder = root.hasPrefix("/") ? fileURL(root) : base.appendingPathComponent(root)
            return folder.appendingPathComponent(relative).standardizedFileURL
        }
        if URLComponents(string: reference)?.scheme != nil { return nil }
        let decoded = reference.removingPercentEncoding ?? reference
        return decoded.hasPrefix("/") ? fileURL(decoded) : base.appendingPathComponent(decoded).standardizedFileURL
    }
    func imageReference(_ file: URL, doc: String?) -> String {
        let base = doc.map { fileURL($0).deletingLastPathComponent() } ?? FileManager.default.homeDirectoryForCurrentUser
        if let root = settings["imageRootPath"] as? String, let published = settings["imageRootURL"] as? String, !published.isEmpty {
            let folder = root.hasPrefix("/") ? fileURL(root) : base.appendingPathComponent(root).standardizedFileURL
            if under(file.path, folder.path) { return published.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + relativePath(file.path, from: folder.path).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! }
        }
        guard doc != nil else { return file.path }
        var relative = relativePath(file.path, from: base.path)
        relative = relative.replacingOccurrences(of: "%", with: "%25").replacingOccurrences(of: "#", with: "%23").replacingOccurrences(of: "?", with: "%3F")
        if settings["imageRelativePath"] as? Bool != false && !relative.hasPrefix(".") { relative = "./" + relative }
        return relative
    }
    private func uniqueImage(_ data: Data, name: String, folder: URL) throws -> URL {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let original = fileURL(name), ext = original.pathExtension, stem = original.deletingPathExtension().lastPathComponent
        var target = folder.appendingPathComponent(name), n = 1
        while true {
            do { try data.write(to: target, options: .withoutOverwriting); return target }
            catch { if !FileManager.default.fileExists(atPath: target.path) { throw error }; target = folder.appendingPathComponent("\(stem)-\(n)" + (ext.isEmpty ? "" : "." + ext)); n += 1 }
        }
    }
    func imageData(_ reference: String, doc: String?) throws -> Data {
        if reference.hasPrefix("data:"), let comma = reference.firstIndex(of: ",") {
            let metadata = reference[..<comma], contents = String(reference[reference.index(after: comma)...])
            if metadata.contains(";base64"), let data = Data(base64Encoded: contents) { return data }
            return Data((contents.removingPercentEncoding ?? contents).utf8)
        }
        if let file = imagePath(reference, doc: doc) { return try Data(contentsOf: file) }
        guard let url = URL(string: reference), ["https", "http"].contains(url.scheme ?? "") else { throw NativeError("Unsupported image URL") }
        var request = URLRequest(url: url); request.timeoutInterval = 15
        let semaphore = DispatchSemaphore(value: 0), box = DownloadResult()
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) { box.error = NativeError("Image download failed (\(response.statusCode))") }
            else { box.data = data; box.error = error }; semaphore.signal()
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + 16) == .success else { task.cancel(); throw NativeError("Image download timed out") }
        if let error = box.error { throw error }; return box.data ?? Data()
    }
}
private final class DownloadResult: @unchecked Sendable { var data: Data?; var error: Error? }
