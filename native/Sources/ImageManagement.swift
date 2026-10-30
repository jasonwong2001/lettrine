import AppKit
import CryptoKit

struct ImageStep {
    let kind: String
    let from: String?
    let to: String?
    let backup: String?
    let digest: String
}
struct ImageDocumentEdit { let path: String; let before: String; let after: String }
struct ImageTransaction {
    let steps: [ImageStep]
    let documents: [ImageDocumentEdit]
    let moves: [JSON]
}

extension NativeApplicationDelegate {
    func manageImages(_ payload: JSON, document: NativeDocument, reply: @escaping (Any?, String?) -> Void) {
        if payload["operation"] as? String != "delete" && payload["destination"] == nil && payload["dir"] == nil {
            let batch = payload["batch"] as? Bool == true, move = payload["operation"] as? String == "move"
            let title = batch ? (move ? "Move All Images To" : "Copy All Images To") : (move ? "Move Image File" : "Copy Image File")
            var options: JSON = ["title": translate(title)]
            if !batch, let source = payload["reference"] as? String, let file = files.imagePath(source, doc: document.path) { options["defaultPath"] = file.path }
            choose(options, document: document, directory: batch, save: !batch) { result, error in
                guard let path = (result as? JSON)?["path"] as? String else { reply(result, error); return }
                var next = payload; next[batch ? "dir" : "destination"] = path
                if document.viewState["readonly"] as? Bool == true { reply(nil, self.translate("Readonly mode is on. Turn it off to edit.")); return }
                self.manageImages(next, document: document, reply: reply)
            }
            return
        }
        Task { @MainActor in
            var next = payload, snapshots: [JSON] = []
            for open in documents {
                if let snapshot = try? await open.evaluate("window.__lettrine?.imageSnapshot?.()"), var value = snapshot as? JSON {
                    value["tab"] = open.id; snapshots.append(value)
                }
            }
            next["openDocuments"] = snapshots
            if payload["scope"] as? String == "folder", let root = payload["folderPath"] as? String {
                var targets = payload["targets"] as? [JSON] ?? []
                for snapshot in snapshots {
                    guard let path = snapshot["path"] as? String, under(path, root) else { continue }
                    for reference in snapshot["references"] as? [JSON] ?? [] {
                        if let url = reference["url"] as? String { targets.append(["url": url, "docPath": path]) }
                    }
                }
                next["targets"] = targets
            }
            performFile("images.manage", next, document: document, reply: reply)
        }
    }
}

extension FileService {
    private func imageDigest(_ file: URL) throws -> String { SHA256.hash(data: try Data(contentsOf: file)).map { String(format: "%02x", $0) }.joined() }

    func manageImageFiles(_ payload: JSON) throws -> JSON {
        let fm = FileManager.default, operation = try required(payload, "operation"), doc = payload["docPath"] as? String
        guard ["copy", "move", "delete"].contains(operation) else { throw NativeError("Unknown image operation") }
        if operation == "delete" && payload["confirmed"] as? Bool != true { throw NativeError("Confirm before deleting the image file.") }
        var documents = payload["documents"] as? [JSON] ?? []
        let open = payload["openDocuments"] as? [JSON] ?? []
        let openPaths = Set(open.compactMap { $0["path"] as? String })
        documents.removeAll { ($0["path"] as? String).map(openPaths.contains) ?? false }
        documents += open
        let references = (payload["images"] as? [String]) ?? (payload["reference"] as? String).map { [$0] } ?? []
        let selected = payload["targets"] as? [JSON] ?? references.map { ["url": $0, "docPath": doc as Any? ?? NSNull()] }
        var seen = Set<String>(), planned = Set<String>(), steps: [ImageStep] = [], moves: [JSON] = []
        let destinationFolder = (payload["dir"] as? String).map(fileURL)
        if let folder = destinationFolder { try fm.createDirectory(at: folder, withIntermediateDirectories: true) }
        for target in selected {
            guard let reference = target["url"] as? String else { continue }
            let base = target["docPath"] as? String ?? doc
            let source = imagePath(reference, doc: base)
            let identity = source?.path ?? reference
            guard seen.insert(identity).inserted else { continue }
            if operation != "copy" && source == nil { throw NativeError("Only local image files can be moved or deleted.") }
            if let source = source {
                let values = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard values.isRegularFile == true, values.isSymbolicLink != true else { throw NativeError("Choose a regular image file.") }
            }
            if operation == "delete" {
                steps.append(ImageStep(kind: operation, from: source!.path, to: nil, backup: try backup(source!.path), digest: try imageDigest(source!)))
                continue
            }
            let destination: URL
            if let explicit = payload["destination"] as? String {
                destination = fileURL(explicit)
                guard selected.count == 1 else { throw NativeError("Choose a folder for multiple images.") }
            } else {
                guard let folder = destinationFolder else { throw NativeError("Choose a destination for the image files.") }
                let name = source?.lastPathComponent ?? (reference.hasPrefix("data:image/svg") ? "image.svg" : "image.png")
                let original = fileURL(name), stem = original.deletingPathExtension().lastPathComponent, ext = original.pathExtension
                var candidate = folder.appendingPathComponent(name), number = 2
                if source?.standardizedFileURL == candidate.standardizedFileURL { continue }
                while fm.fileExists(atPath: candidate.path) || planned.contains(candidate.path) {
                    candidate = folder.appendingPathComponent(stem + "-\(number)" + (ext.isEmpty ? "" : "." + ext)); number += 1
                }
                destination = candidate
            }
            guard source?.resolvingSymlinksInPath() != destination.resolvingSymlinksInPath() else { throw NativeError("Choose a destination different from the image file.") }
            try vacant(destination); planned.insert(destination.path)
            if let source = source, operation == "move" { moves.append(["from": source.path, "to": destination.path]) }
            // Downloaded/data images use a recovery copy as the source for redo.
            let recovery: String?
            if source == nil {
                let cache = directory.appendingPathComponent("file-recovery/" + UUID().uuidString + "/" + destination.lastPathComponent)
                try fm.createDirectory(at: cache.deletingLastPathComponent(), withIntermediateDirectories: true)
                try imageData(reference, doc: base).write(to: cache, options: .atomic); recovery = cache.path
            } else { recovery = operation == "copy" ? try backup(source!.path) : nil }
            steps.append(ImageStep(kind: operation, from: source?.path, to: destination.path, backup: recovery, digest: try imageDigest(source ?? fileURL(recovery!))))
        }
        for snapshot in open where snapshot["readonly"] as? Bool == true {
            if (snapshot["references"] as? [JSON] ?? []).contains(where: { ref in
                guard let url = ref["url"] as? String, let file = imagePath(url, doc: snapshot["path"] as? String) else { return false }
                return steps.contains { $0.from == file.path && $0.kind != "copy" }
            }) { throw NativeError("An open readonly document references this image.") }
        }
        var edits: [ImageDocumentEdit] = []
        for snapshot in documents {
            guard snapshot["tab"] == nil, let path = snapshot["path"] as? String, let before = snapshot["text"] as? String else { continue }
            let after = repairImageDocument(before, references: snapshot["references"] as? [JSON] ?? [], path: path, moves: moves)
            if before != after { edits.append(ImageDocumentEdit(path: path, before: before, after: after)) }
        }
        let transaction = ImageTransaction(steps: steps, documents: edits, moves: moves)
        let changes = try replayImages(transaction, redo: true)
        if !steps.isEmpty { record(FileAction(kind: "images", label: operation == "move" ? "Move Images" : operation == "delete" ? "Delete Image" : "Copy Images", images: transaction)) }
        try apply(changes)
        return ["ok": true, "canceled": false, "count": steps.count, "changes": changes, "moves": moves]
    }

    private func repairImageDocument(_ source: String, references: [JSON], path: String, moves: [JSON]) -> String {
        var text = source
        for reference in references.sorted(by: { ($0["urlStart"] as? Int ?? 0) > ($1["urlStart"] as? Int ?? 0) }) {
            guard let value = reference["url"] as? String, let file = imagePath(value, doc: path),
                  let destination = moves.first(where: { $0["from"] as? String == file.path })?["to"] as? String,
                  let start = reference["urlStart"] as? Int, let end = reference["urlEnd"] as? Int,
                  let range = Range(NSRange(location: start, length: end - start), in: text) else { continue }
            var replacement = imageReference(fileURL(destination), doc: path)
            if reference["urlEncoding"] as? String == "html" {
                replacement = replacement.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "'", with: "&#39;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
            } else if reference["urlEncoding"] as? String == "angle" { replacement = replacement.replacingOccurrences(of: ">", with: "%3E") }
            else {
                replacement = replacement.replacingOccurrences(of: " ", with: "%20").replacingOccurrences(of: "\t", with: "%09").replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "(", with: "\\(").replacingOccurrences(of: ")", with: "\\)")
            }
            text.replaceSubrange(range, with: replacement)
        }
        return text
    }

    func replayImages(_ transaction: ImageTransaction, redo: Bool) throws -> [JSON] {
        let fm = FileManager.default
        for edit in transaction.documents {
            guard (try? String(contentsOf: fileURL(edit.path), encoding: .utf8)) == (redo ? edit.before : edit.after) else { throw NativeError("A document changed after the image operation. Save a copy before retrying.") }
        }
        for step in transaction.steps {
            let source = step.kind == "move" ? (redo ? step.from : step.to) : step.kind == "delete" ? (redo ? step.from : step.backup) : (redo ? step.backup ?? step.from : step.to)
            let destination = step.kind == "move" ? (redo ? step.to : step.from) : step.kind == "delete" && !redo ? step.from : step.kind == "copy" && redo ? step.to : nil
            if let source = source { guard fm.fileExists(atPath: source), try imageDigest(fileURL(source)) == step.digest else { throw NativeError("An image file changed after the operation.") } }
            if let destination = destination { try vacant(fileURL(destination)) }
        }
        var completed: [ImageStep] = [], written: [ImageDocumentEdit] = []
        func perform(_ step: ImageStep, forward: Bool) throws {
            if step.kind == "move" {
                let from = (forward ? step.from : step.to)!, to = (forward ? step.to : step.from)!
                try fm.createDirectory(at: fileURL(to).deletingLastPathComponent(), withIntermediateDirectories: true)
                try fm.moveItem(atPath: from, toPath: to)
            } else if step.kind == "copy" {
                if forward {
                    try fm.createDirectory(at: fileURL(step.to!).deletingLastPathComponent(), withIntermediateDirectories: true)
                    try fm.copyItem(atPath: step.backup ?? step.from!, toPath: step.to!)
                } else { try fm.removeItem(atPath: step.to!) }
            } else if forward { try fm.trashItem(at: fileURL(step.from!), resultingItemURL: nil) }
            else { try fm.copyItem(atPath: step.backup!, toPath: step.from!) }
        }
        do {
            for step in redo ? transaction.steps : transaction.steps.reversed() { try perform(step, forward: redo); completed.append(step) }
            for edit in transaction.documents {
                try Data((redo ? edit.after : edit.before).utf8).write(to: fileURL(edit.path), options: .atomic); written.append(edit)
            }
        } catch {
            for edit in written.reversed() { try? Data((redo ? edit.before : edit.after).utf8).write(to: fileURL(edit.path), options: .atomic) }
            for step in completed.reversed() { try? perform(step, forward: !redo) }
            throw error
        }
        let moves = transaction.moves.map { move -> JSON in redo ? move : ["from": move["to"]!, "to": move["from"]!] }
        for move in moves { if let to = move["to"] as? String { authorize?(fileURL(to).deletingLastPathComponent()) } }
        event("images.changed", ["moves": moves])
        return transaction.steps.map { step in
            if step.kind == "move" { return redo ? ["from": step.from!, "to": step.to!] : ["from": step.to!, "to": step.from!] }
            return [step.kind == "delete" ? (redo ? "removed" : "restored") : (redo ? "added" : "removed"): step.kind == "delete" ? step.from! : step.to!]
        }
    }
}
