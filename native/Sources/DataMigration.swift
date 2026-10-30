import Foundation

// Lettrine was called mdlive. On the first launch its data folder does not
// exist yet: copy what the earlier folder kept (settings, recent files and
// folders, dictionary, themes, snapshots) and leave that folder alone.
func adoptEarlierData(from earlier: URL, to userData: URL) {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: userData.path), fm.fileExists(atPath: earlier.path) else { return }
    try? fm.createDirectory(at: userData, withIntermediateDirectories: true)
    for name in ["settings.json", "recent-files.json", "recent-folders.json", "user-dictionary.json", "window-appearance.json", "themes", "snapshots"] where fm.fileExists(atPath: earlier.appendingPathComponent(name).path) {
        try? fm.copyItem(at: earlier.appendingPathComponent(name), to: userData.appendingPathComponent(name))
    }
}
