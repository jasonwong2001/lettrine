import Foundation
import WebKit

// Local resources use a public WKURLSchemeHandler. No localhost server,
// private WebKit preferences, broad file:// access, or remote app code.
final class Resources: NSObject, WKURLSchemeHandler {
    let root: URL
    private let lock = NSLock()
    private var allowed = Set<String>()
    init(root: URL) { self.root = root.resolvingSymlinksInPath(); super.init(); authorize(root) }
    func authorize(_ directory: URL) { lock.lock(); allowed.insert(directory.resolvingSymlinksInPath().path); lock.unlock() }
    func localURL(_ file: URL) -> String {
        var components = URLComponents(); components.scheme = "lettrine"; components.host = "file"; components.path = file.path
        return components.url!.absoluteString
    }
    func resolve(_ url: URL) throws -> URL {
        let file: URL
        if url.host == "app" { file = root.appendingPathComponent(url.path).standardizedFileURL.resolvingSymlinksInPath() }
        else if url.host == "file" { file = fileURL(url.path).resolvingSymlinksInPath() }
        else { throw NativeError("Unknown local resource origin") }
        lock.lock(); let permitted = allowed.contains { under(file.path, $0) }; lock.unlock()
        guard permitted, url.host != "app" || under(file.path, root.path) else { throw NativeError("This local resource is outside the opened document or library") }
        return file
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        do {
            guard let url = urlSchemeTask.request.url else { throw NativeError("Missing resource URL") }
            let file = try resolve(url), data = try Data(contentsOf: file, options: .mappedIfSafe)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": Self.mime(file), "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache", "Content-Length": String(data.count)])!
            urlSchemeTask.didReceive(response); urlSchemeTask.didReceive(data); urlSchemeTask.didFinish()
        } catch { urlSchemeTask.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
    static func mime(_ file: URL) -> String {
        ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8", "json": "application/json", "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp", "avif": "image/avif", "woff": "font/woff", "woff2": "font/woff2", "ttf": "font/ttf"] [file.pathExtension.lowercased()] ?? "application/octet-stream"
    }
}
