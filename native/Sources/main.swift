import AppKit

let args = CommandLine.arguments
let userData: URL
if let argument = args.first(where: { $0.hasPrefix("--user-data-dir=") }) { userData = fileURL(String(argument.dropFirst("--user-data-dir=".count))) }
else {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    userData = support.appendingPathComponent("Lettrine")
    adoptEarlierData(from: support.appendingPathComponent("mdlive"), to: userData)
}
let webRoot = Bundle.main.resourceURL!.appendingPathComponent("web")
let application = NSApplication.shared
let delegate = NativeApplicationDelegate(webRoot: webRoot, userData: userData)
application.setActivationPolicy(.regular)
application.delegate = delegate
application.run()
