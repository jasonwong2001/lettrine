import AppKit

// Only the harness supplies a report directory; normal launches use the system.
final class NativeExternalActions {
    private let output: URL?
    private let allowExternalApps: Bool
    private var requests: [JSON] = []
    init(output: URL? = nil, allowExternalApps: Bool = false) {
        self.output = output; self.allowExternalApps = allowExternalApps
    }
    func writeReport() throws {
        if let output = output { try writeJSON(requests, to: output.appendingPathComponent("external-actions.json")) }
    }
    private func intercept(_ operation: String, url: URL, application: URL? = nil) -> Bool {
        guard output != nil else { return false }
        var request: JSON = ["operation": operation, "url": url.absoluteString, "intercepted": !allowExternalApps]
        if let application = application { request["application"] = application.path }
        requests.append(request)
        do { try writeReport() }
        catch { FileHandle.standardError.write(Data(("Could not record external action: " + error.localizedDescription + "\n").utf8)) }
        return !allowExternalApps
    }
    @discardableResult func open(_ url: URL) -> Bool {
        if intercept("open", url: url) { return true }
        return NSWorkspace.shared.open(url)
    }
    func open(_ url: URL, with application: URL, reply: @escaping (Any?, String?) -> Void) {
        if intercept("open", url: url, application: application) { reply(["ok": true], nil); return }
        NSWorkspace.shared.open([url], withApplicationAt: application, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            DispatchQueue.main.async { reply(error == nil ? ["ok": true] : nil, error?.localizedDescription) }
        }
    }
    func reveal(_ url: URL) {
        if intercept("reveal", url: url) { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}
