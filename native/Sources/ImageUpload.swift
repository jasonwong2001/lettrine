import Foundation
import AppKit

extension NativeApplicationDelegate {
    func importImage(_ payload: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        if payload["sourcePath"] == nil && payload["data"] == nil {
            choose(["title": translate("Insert Image")], document: document, image: true) { result, error in
                guard let path = (result as? JSON)?["path"] as? String else { reply(result, error); return }
                var next = payload; next["sourcePath"] = path
                self.handle("images.import", next, document: document, reply: reply)
            }
            return
        }
        files.queue.async {
            do {
                let settings = self.files.settings
                let uploading = payload["upload"] as? Bool == true && settings["imageUploadOnPaste"] as? Bool == true
                var local = payload; local["_prepareUpload"] = uploading
                guard let imported = try self.files.handle("images.import", local, tab: document.id) as? JSON else { throw NativeError("Invalid image data") }
                guard uploading, let path = imported["path"] as? String else { DispatchQueue.main.async { reply(imported, nil) }; return }
                // Uploads can take time. The file queue remains available for
                // autosave and other documents while the service responds.
                DispatchQueue.global(qos: .userInitiated).async {
                    var result = imported
                    do { result["reference"] = try self.files.uploadImage(fileURL(path), settings: settings); result["uploaded"] = true }
                    catch { result["uploadError"] = error.localizedDescription }
                    DispatchQueue.main.async { reply(result, nil) }
                }
            } catch { DispatchQueue.main.async { reply(nil, self.translate(error.localizedDescription)) } }
        }
    }
}

extension FileService {
    func uploadImage(_ file: URL, settings: JSON) throws -> String {
        let type = settings["imageUploader"] as? String ?? "command"
        let config = settings["imageUploadOptions"] as? JSON ?? [:]
        if type == "command" || type == "upic" {
            let program: URL, arguments: [String]
            if type == "upic" {
                let configured = (config["path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "/Applications/uPic.app"
                let executable = configured.hasSuffix(".app") ? configured + "/Contents/MacOS/uPic" : configured
                program = fileURL(executable); arguments = ["-o", "url", "-u", file.path]
            } else {
                guard let template = config["command"] as? String, template.contains("{file}") else { throw NativeError("The upload command must contain {file}.") }
                let quoted = "'" + file.path.replacingOccurrences(of: "'", with: "'\\''") + "'"
                program = fileURL("/bin/sh"); arguments = ["-c", template.replacingOccurrences(of: "{file}", with: quoted)]
            }
            let response = try runImageCommand(program, arguments: arguments)
            return try uploadedURL(response, config: config)
        }
        if type == "picgo" {
            let application = (config["path"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "/Applications/PicGo.app"
            guard FileManager.default.fileExists(atPath: fileURL(application).path) else { throw NativeError("Choose an installed uploader application in Settings.") }
            if application.hasSuffix(".app") { _ = try runImageCommand(fileURL("/usr/bin/open"), arguments: ["-g", application]) }
            else { _ = try runImageCommand(fileURL(application), arguments: []) }
            guard let url = URL(string: config["url"] as? String ?? "http://127.0.0.1:36677/upload"), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false else { throw NativeError("Enter an HTTP or HTTPS upload URL.") }
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["list": [file.path]])
            var last: Error?
            for attempt in 0..<8 {
                do { return try uploadedURL(uploadRequest(request), config: config) }
                catch { last = error; if (error as NSError).code != NSURLErrorCannotConnectToHost { throw error }; if attempt < 7 { Thread.sleep(forTimeInterval: 0.25) } }
            }
            throw last ?? NativeError("The image uploader could not be reached.")
        }
        guard type == "http", let raw = config["url"] as? String, let url = URL(string: raw), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false else { throw NativeError("Enter an HTTP or HTTPS upload URL.") }
        let boundary = "Lettrine-" + UUID().uuidString
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        let safe = { (text: String) in text.replacingOccurrences(of: "\"", with: "%22").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "") }
        for (name, value) in (config["fields"] as? [String: String] ?? [:]).sorted(by: { $0.key < $1.key }) {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(safe(name))\"\r\n\r\n\(value)\r\n")
        }
        let field = config["fileField"] as? String ?? "file"
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(safe(field))\"; filename=\"\(safe(file.lastPathComponent))\"\r\nContent-Type: \(Resources.mime(file))\r\n\r\n")
        body.append(try Data(contentsOf: file)); append("\r\n--\(boundary)--\r\n")
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = body
        for (name, value) in config["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("multipart/form-data; boundary=" + boundary, forHTTPHeaderField: "Content-Type")
        return try uploadedURL(uploadRequest(request), config: config)
    }

    private func runImageCommand(_ program: URL, arguments: [String]) throws -> Data {
        guard FileManager.default.isExecutableFile(atPath: program.path) else { throw NativeError("Choose an installed uploader application in Settings.") }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("lettrine-upload-" + UUID().uuidString)
        FileManager.default.createFile(atPath: temporary.path, contents: nil)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let log = try FileHandle(forWritingTo: temporary); defer { try? log.close() }
        let process = Process(); process.executableURL = program; process.arguments = arguments
        process.standardInput = FileHandle.nullDevice; process.standardOutput = log; process.standardError = log
        try process.run()
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate(); DispatchQueue.global().asyncAfter(deadline: .now() + 1) { if process.isRunning { kill(process.processIdentifier, SIGKILL) } } } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
        process.waitUntilExit(); timeout.cancel()
        let output = try Data(contentsOf: temporary)
        guard process.terminationStatus == 0 else { throw NativeError("The image upload command failed.") }
        return output
    }
    private func uploadRequest(_ input: URLRequest) throws -> Data {
        var request = input; request.timeoutInterval = 30
        let semaphore = DispatchSemaphore(value: 0), box = ImageUploadResult()
        let task = URLSession.shared.dataTask(with: request) { data, response, error in
            if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) { box.error = NativeError("The image upload server returned an error.") }
            else { box.data = data; box.error = error }
            semaphore.signal()
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + 31) == .success else { task.cancel(); throw NativeError("The image upload timed out.") }
        if let error = box.error { throw error }
        return box.data ?? Data()
    }
    private func uploadedURL(_ response: Data, config: JSON) throws -> String {
        func valid(_ value: Any?) -> String? {
            guard let text = value as? String, !text.contains(where: { $0.isWhitespace || $0.isNewline }), let url = URL(string: text), ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false else { return nil }
            return text
        }
        if let object = try? JSONSerialization.jsonObject(with: response) {
            if let result = object as? JSON, result["success"] as? Bool == false { throw NativeError("The image uploader reported a failure.") }
            let paths = (config["urlPath"] as? String).map { [$0] } ?? ["url", "data.url", "data.link", "result.0", "0"]
            for path in paths {
                var value: Any? = object
                for key in path.split(separator: ".").map(String.init) {
                    if let array = value as? [Any], let index = Int(key), array.indices.contains(index) { value = array[index] }
                    else { value = (value as? JSON)?[key] }
                }
                if let text = valid(value) { return text }
            }
        } else if config["urlPath"] == nil, let text = String(data: response, encoding: .utf8) {
            for line in text.components(separatedBy: .newlines).reversed() { if let url = valid(line.trimmingCharacters(in: .whitespaces)) { return url } }
        }
        throw NativeError("The uploader did not return an HTTP or HTTPS image URL.")
    }
}
private final class ImageUploadResult: @unchecked Sendable { var data: Data?; var error: Error? }
