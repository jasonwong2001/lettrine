import AppKit
import Foundation

// Release endpoints come from the bundle, never from document content/settings.
// The harness can substitute a loopback-only configuration for offline tests.
final class NativeMaintenance {
    unowned let app: NativeApplicationDelegate
    private let config: JSON
    private let fixture: Bool
    private var state: JSON
    private var timer: Timer?
    private var reportRequest: MaintenanceRequest?
    private var reporting = false
    private var checking = false
    private var started = false
    private var consent: Bool
    private var consentRevision = 0
    private var stateURL: URL { app.files.directory.appendingPathComponent("maintenance.json") }
    var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }

    init(app: NativeApplicationDelegate) {
        self.app = app
        var value = (readJSON(app.webRoot.appendingPathComponent("native-config.json")) as? JSON)?["maintenance"] as? JSON ?? [:]
        let arguments = CommandLine.arguments
        if arguments.contains("--lettrine-harness"), let index = arguments.firstIndex(of: "--lettrine-maintenance-fixture"), index + 1 < arguments.count {
            value = readJSON(fileURL(arguments[index + 1])) as? JSON ?? [:]; fixture = true
        } else { fixture = false }
        config = value
        state = readJSON(app.files.directory.appendingPathComponent("maintenance.json")) as? JSON ?? [:]
        consent = app.settings["anonymousUsageReports"] as? Bool == true
    }

    private func endpoint(_ key: String) -> URL? {
        guard let text = config[key] as? String, let url = URL(string: text),
              url.user == nil, url.password == nil, url.fragment == nil, url.host != nil else { return nil }
        if fixture { return url.scheme == "http" && url.host == "127.0.0.1" ? url : nil }
        return url.scheme == "https" ? url : nil
    }

    func capabilities() -> JSON {
        ["updates": endpoint("updateFeedURL") != nil,
         "reporting": endpoint("usageReportURL") != nil && endpoint("privacyURL") != nil,
         "reportOrigin": endpoint("usageReportURL").map { "\($0.scheme ?? "https")://\($0.host ?? "")" } ?? "",
         "privacyURL": endpoint("privacyURL")?.absoluteString ?? "",
         // Without an update feed, Check for Updates opens this page instead.
         "releasesURL": endpoint("releasesURL")?.absoluteString ?? ""]
    }

    private func persist() {
        let value = state, file = stateURL
        app.files.queue.async { try? writeJSON(value, to: file) }
    }

    func start() {
        guard !started else { return }; started = true
        if consent && capabilities()["reporting"] as? Bool == true {
            state["launches"] = min(100000, (state["launches"] as? Int ?? 0) + 1); persist()
        }
        guard endpoint("updateFeedURL") != nil || endpoint("usageReportURL") != nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 3600, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.automaticWork() }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            await automaticWork()
        }
    }

    func settingsChanged() {
        let enabled = app.settings["anonymousUsageReports"] as? Bool == true
        if enabled != consent { consentRevision += 1 }
        if consent && !enabled {
            reportRequest?.cancel(); reportRequest = nil
            state["launches"] = 0; persist()
        } else if !consent && enabled && capabilities()["reporting"] as? Bool == true {
            state["launches"] = 1; persist()
        }
        consent = enabled
    }

    @MainActor private func automaticWork() async {
        let now = Date().timeIntervalSince1970
        if app.settings["checkUpdatesAutomatically"] as? Bool == true, now - (state["checkedAt"] as? Double ?? 0) >= 86400 {
            do {
                let result = try await checkUpdates()
                if result["status"] as? String == "update", let release = result["build"] as? String, state["notified"] as? String != release {
                    state["notified"] = release; persist()
                    app.active?.send("app.updateAvailable", result)
                }
            } catch { app.log("Update check: " + error.localizedDescription) }
        }
        if now - (state["reportedAt"] as? Double ?? 0) >= 86400 {
            do { _ = try await reportUsage() } catch { app.log("Usage report: " + error.localizedDescription) }
        }
    }

    @MainActor func checkUpdates() async throws -> JSON {
        guard let url = endpoint("updateFeedURL") else { throw NativeError("Update checks are unavailable in this development build.") }
        guard !checking else { throw NativeError("An update check is already in progress.") }
        checking = true; defer { checking = false }
        var request = URLRequest(url: url); request.setValue("application/rss+xml, application/xml", forHTTPHeaderField: "Accept")
        request.setValue("Lettrine/" + version, forHTTPHeaderField: "User-Agent")
        let data = try await MaintenanceRequest().perform(request)
        let parser = UpdateFeed()
        let releases = try parser.read(data).filter { item in
            let minimum = item["minimum"] ?? "0", maximum = item["maximum"]
            let os = ProcessInfo.processInfo.operatingSystemVersion
            let current = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
            return (item["os"] == nil || item["os"] == "macos") &&
                (item["channel"] == nil || item["channel"] == "stable") && item["build"]?.contains("-") != true &&
                UpdateFeed.compare(minimum, current) != .orderedDescending &&
                (maximum == nil || UpdateFeed.compare(current, maximum!) != .orderedDescending)
        }
        let latest = releases.max { UpdateFeed.compare($0["build"] ?? "0", $1["build"] ?? "0") == .orderedAscending }
        var result: JSON = ["status": "current", "version": version]
        if let latest = latest, let build = latest["build"], UpdateFeed.compare(build, version) == .orderedDescending {
            guard let page = latest["link"] ?? latest["download"], let target = URL(string: page), target.host != nil, target.user == nil, target.password == nil,
                  target.scheme == "https" || fixture && target.scheme == "http" && target.host == "127.0.0.1" else { throw NativeError("The update feed is invalid.") }
            result = ["status": "update", "build": build, "version": String((latest["display"] ?? build).prefix(80)), "url": target.absoluteString]
        }
        state["checkedAt"] = Date().timeIntervalSince1970; persist()
        return result
    }

    @MainActor func reportUsage() async throws -> JSON {
        guard consent, app.settings["anonymousUsageReports"] as? Bool == true, capabilities()["reporting"] as? Bool == true,
              let url = endpoint("usageReportURL"), let launches = state["launches"] as? Int, launches > 0 else { return ["sent": false] }
        guard !reporting else { return ["sent": false] }
        reporting = true; defer { reporting = false; reportRequest = nil }
        let revision = consentRevision
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        let payload: JSON = ["schema": 1, "appVersion": version, "macOSMajor": ProcessInfo.processInfo.operatingSystemVersion.majorVersion, "architecture": architecture, "launches": launches]
        var request = URLRequest(url: url); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Lettrine/" + version, forHTTPHeaderField: "User-Agent")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let client = MaintenanceRequest(); reportRequest = client
        _ = try await client.perform(request)
        if consent && consentRevision == revision {
            state["launches"] = max(0, (state["launches"] as? Int ?? 0) - launches)
            state["reportedAt"] = Date().timeIntervalSince1970; persist()
        }
        return ["sent": true]
    }
}

// Bounded, ephemeral requests with no cookies, cache, credentials or redirects.
private final class MaintenanceRequest: NSObject, URLSessionDataDelegate {
    private let lock = NSLock()
    private var cancelled = false
    private var session: URLSession?
    private var continuation: CheckedContinuation<Data, Error>?
    private var data = Data()
    func perform(_ request: URLRequest) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if cancelled { lock.unlock(); continuation.resume(throwing: URLError(.cancelled)); return }
            self.continuation = continuation
            let config = URLSessionConfiguration.ephemeral
            config.httpShouldSetCookies = false; config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
            config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
            self.session = session
            let task = session.dataTask(with: request)
            lock.unlock(); task.resume()
        }
    }
    func cancel() {
        lock.lock(); cancelled = true; let current = session; lock.unlock()
        current?.invalidateAndCancel()
    }
    private func finish(_ result: Result<Data, Error>) {
        lock.lock()
        let completion = continuation, current = session
        continuation = nil; session = nil
        lock.unlock()
        completion?.resume(with: result); current?.invalidateAndCancel()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust { completionHandler(.performDefaultHandling, nil) }
        else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode), response.expectedContentLength <= 1024 * 1024 else {
            completionHandler(.cancel); finish(.failure(NativeError("The maintenance service returned an invalid response."))); return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
        if data.count + chunk.count > 1024 * 1024 { finish(.failure(NativeError("The maintenance response is too large."))) }
        else { data.append(chunk) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(error.map { .failure($0) } ?? .success(data))
    }
}

private final class UpdateFeed: NSObject, XMLParserDelegate {
    private var items: [[String: String]] = [], current: [String: String]?
    private var capture: String?, text = ""
    static func compare(_ left: String, _ right: String) -> ComparisonResult {
        // Numeric dotted components, with a release sorting after prereleases.
        let a = left.components(separatedBy: "+")[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let b = right.components(separatedBy: "+")[0].split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let av = a[0].split(separator: ".").map { Int($0) ?? 0 }, bv = b[0].split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(av.count, bv.count) {
            let x = index < av.count ? av[index] : 0, y = index < bv.count ? bv[index] : 0
            if x != y { return x < y ? .orderedAscending : .orderedDescending }
        }
        if a.count != b.count { return a.count > b.count ? .orderedAscending : .orderedDescending }
        return a.count == 1 ? .orderedSame : String(a[1]).compare(String(b[1]), options: .numeric)
    }
    func read(_ data: Data) throws -> [[String: String]] {
        guard let source = String(data: data, encoding: .utf8), source.range(of: "<!DOCTYPE", options: .caseInsensitive) == nil else { throw NativeError("The update feed is invalid.") }
        let parser = XMLParser(data: data); parser.delegate = self; parser.shouldResolveExternalEntities = false
        guard parser.parse(), !items.isEmpty else { throw NativeError("The update feed is invalid.") }
        return items
    }
    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String]) {
        if name == "item" { current = [:] }
        guard current != nil else { return }
        if name == "enclosure" {
            current?["os"] = attributes["sparkle:os"] ?? "macos"
            if let build = attributes["sparkle:version"] { current?["build"] = build }
            if let display = attributes["sparkle:shortVersionString"] { current?["display"] = display }
            if let download = attributes["url"] { current?["download"] = download }
        }
        let keys = ["link": "link", "sparkle:version": "build", "sparkle:shortVersionString": "display", "sparkle:minimumSystemVersion": "minimum", "sparkle:maximumSystemVersion": "maximum", "sparkle:channel": "channel"]
        if let key = keys[name] { capture = key; text = "" }
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { if capture != nil { text += string } }
    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName qName: String?) {
        if let key = capture {
            let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { current?[key] = value }
            capture = nil
        }
        if name == "item", let item = current {
            if let build = item["build"], build.range(of: #"^[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil { items.append(item) }
            current = nil
        }
    }
}
