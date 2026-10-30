import { parseBlocks } from "./blocks.js";
import { parseInline } from "./inline.js";
import { imageAttribute, imageHTML } from "./image-tag.js";
import { linkMarkdown } from "./links.js";
import { textChange, applyTextChange } from "./history.js";

export { imageHTML };
export function imageReferences(source) {
  const result = [], normalized = source.replace(/\r\n/g, "\n"), offsets = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\r" && source[i + 1] === "\n") continue;
    offsets.push(i);
  }
  offsets.push(source.length);
  const inline = (text, map) => {
    let offset = 0;
    for (const part of parseInline(text, { subscriptSuperscript: true })) {
      if (part.type === "image") result.push({ ...part, start: map[offset], end: map[offset + part.src.length - 1] + 1,
        urlStart: map[offset + part.urlStart], urlEnd: part.urlEnd > part.urlStart ? map[offset + part.urlEnd - 1] + 1 : map[offset + part.urlStart] });
      else if (typeof part.inner === "string" && ["bold", "italic", "strike", "highlight", "underline", "subscript", "superscript", "link"].includes(part.type)) {
        const prefix = part.open?.length || part.marker?.length || 1;
        inline(part.inner, map.slice(offset + prefix, offset + prefix + part.inner.length + 1));
      }
      offset += part.src.length;
    }
  };
  const scan = (text, map, documentStart = true) => {
    let offset = 0;
    for (const block of parseBlocks(text, { documentStart })) {
      offset += (block._leading || block._before || "").length;
      const range = map.slice(offset, offset + block.src.length + 1);
      if (block.type === "quote") {
        const chars = [], positions = []; let cursor = 0;
        for (const line of block.src.split("\n")) {
          const prefix = /^ {0,3}>[ \t]?/.exec(line)?.[0].length || 0;
          for (let i = prefix; i < line.length; i++) { chars.push(line[i]); positions.push(range[cursor + i]); }
          cursor += line.length;
          if (cursor < block.src.length) { chars.push("\n"); positions.push(range[cursor]); cursor++; }
        }
        positions.push(range.at(-1)); scan(chars.join(""), positions, false);
      } else if (!["code", "math", "html", "frontmatter", "hr", "toc"].includes(block.type)) inline(block.src, range);
      offset += block.src.length;
    }
  };
  scan(normalized, offsets);
  return result.sort((a, b) => a.start - b.start);
}

const decodePath = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
const cleanPath = (text) => {
  const parts = [];
  for (const part of text.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return "/" + parts.join("/");
};
export function localImagePath(reference, documentPath, settings = {}) {
  const base = documentPath?.replace(/\/[^/]*$/, "") || "";
  if (/^(?:file:|lettrine:\/\/file)/i.test(reference)) {
    try { return cleanPath(decodePath(new URL(reference).pathname)); } catch { return null; }
  }
  const published = settings.imageRootURL?.replace(/\/+$/, "");
  if (settings.imageRootPath && published && reference.startsWith(published + "/")) {
    return cleanPath((settings.imageRootPath.startsWith("/") ? "" : base + "/") + settings.imageRootPath + "/" + decodePath(reference.slice(published.length + 1)));
  }
  if (/^[a-z][\w+.-]*:/i.test(reference)) return null;
  if (!base && !reference.startsWith("/")) return null;
  return cleanPath((reference.startsWith("/") ? "" : base + "/") + decodePath(reference));
}
export function imageReference(file, documentPath, settings = {}) {
  const encode = (value) => value.replace(/%/g, "%25").replace(/#/g, "%23").replace(/\?/g, "%3F");
  const base = documentPath?.replace(/\/[^/]*$/, "") || "";
  if (!base) return encode(file);
  const published = settings.imageRootURL?.replace(/\/+$/, "");
  if (settings.imageRootPath && published) {
    const root = cleanPath((settings.imageRootPath.startsWith("/") ? "" : base + "/") + settings.imageRootPath);
    if (file.startsWith(root + "/")) return published + "/" + encode(file.slice(root.length + 1)).replace(/ /g, "%20");
  }
  const from = base.split("/"), to = cleanPath(file).split("/");
  let common = 0;
  while (common < Math.min(from.length, to.length) && from[common] === to[common]) common++;
  let relative = "../".repeat(from.length - common) + to.slice(common).join("/");
  if (settings.imageRelativePath !== false && !relative.startsWith(".")) relative = "./" + relative;
  return encode(relative);
}
export function imageDestination(url, encoding = "markdown") {
  if (encoding === "html") return imageAttribute(url);
  if (encoding === "angle") return url.replace(/>/g, "%3E");
  return url.replace(/\s/g, (char) => encodeURIComponent(char)).replace(/[\\()]/g, "\\$&");
}
export function replaceImageDestinations(source, replacements) {
  let result = source;
  for (const change of replacements.slice().sort((a, b) => b.urlStart - a.urlStart)) result = result.slice(0, change.urlStart) + imageDestination(change.to, change.urlEncoding) + result.slice(change.urlEnd);
  return result;
}
export function repairImageReferences(source, documentPath, moves, settings = {}) {
  const paths = new Map(moves.map(({ from, to }) => [cleanPath(from), to]));
  const changes = imageReferences(source).flatMap((image) => {
    const destination = paths.get(localImagePath(image.url, documentPath, settings));
    return destination ? [{ ...image, to: imageReference(destination, documentPath, settings) }] : [];
  });
  return replaceImageDestinations(source, changes);
}
export function convertImageSyntax(source, start, end, syntax, zoom) {
  const images = imageReferences(source).filter((image) => start === end ? image.start <= start && image.end >= start : image.end > start && image.start < end);
  let result = source;
  for (const image of images.reverse()) {
    const replacement = syntax === "html" ? imageHTML(image, zoom ?? image.zoom) : "!" + linkMarkdown(image.alt, image.url, image.title).source;
    result = result.slice(0, image.start) + replacement + result.slice(image.end);
  }
  return result;
}

export function imageSelectionAfter(before, after, selection) {
  const from = imageReferences(before), to = imageReferences(after);
  const offset = (position) => {
    let delta = 0;
    for (let i = 0; i < Math.min(from.length, to.length); i++) {
      if (position <= from[i].urlStart) break;
      if (position <= from[i].urlEnd) return to[i].urlStart + Math.min(position - from[i].urlStart, to[i].urlEnd - to[i].urlStart);
      delta += to[i].urlEnd - to[i].urlStart - (from[i].urlEnd - from[i].urlStart);
    }
    return Math.max(0, Math.min(after.length, position + delta));
  };
  return { ...selection, start: offset(selection.start), end: offset(selection.end) };
}

// Rebase text history as part of a file operation, so text undo cannot restore
// links to a path that has just moved. File undo applies the inverse mapping.
export function rebaseImageHistory(editor, transform) {
  const history = editor._history, future = editor._future, current = editor.getMarkdown();
  let original = editor._historyText, previous = transform(original);
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    entry.textLength = previous.length;
    entry.selection = imageSelectionAfter(original, previous, entry.selection);
    if (entry.change) {
      const before = applyTextChange(original, entry.change), transformed = transform(before);
      entry.change = textChange(previous, transformed);
      original = before; previous = transformed;
    }
  }
  original = editor._historyText; previous = transform(original);
  for (let i = future.length - 1; i >= 0; i--) {
    const entry = future[i], after = applyTextChange(original, entry.change), transformed = transform(after);
    entry.change = textChange(previous, transformed); entry.textLength = transformed.length;
    entry.selection = imageSelectionAfter(after, transformed, entry.selection);
    original = after; previous = transformed;
  }
  editor._historyText = transform(editor._historyText);
  const after = transform(current), range = editor.selectionOffsets(), selection = range && imageSelectionAfter(current, after, range);
  if (after !== current) {
    editor.setText(after, { docBase: editor.docBase, resetHistory: false });
    if (selection) editor.selectOffsets(selection.start, selection.end, selection.backward);
    editor.emit();
  }
  editor._historyGroup = null; editor._lastPush = 0;
}

export function parseUploadConfig(source) {
  if (!source.trim()) return {};
  let result;
  if (source.trim().startsWith("{")) {
    try { result = JSON.parse(source); } catch { throw Error("Enter a valid JSON object or YAML upload configuration."); }
  } else {
    result = {}; let group = null;
    const lines = source.split(/\r?\n/);
    const scalar = (value) => {
      if (/^".*"$/.test(value)) { try { return JSON.parse(value); } catch { throw Error("Enter a valid JSON object or YAML upload configuration."); } }
      if (/^'.*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'");
      return value.replace(/\s+#.*$/, "").trim();
    };
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue;
      const match = /^( {0,2})([\w-]+):(?:\s+(.*))?$/.exec(lines[i]);
      if (!match || match[1].length === 1) throw Error("Enter a valid JSON object or YAML upload configuration.");
      const [, indent, key, raw = ""] = match;
      if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("Enter a valid JSON object or YAML upload configuration.");
      if (indent) {
        if (!group || typeof result[group] !== "object") throw Error("Enter a valid JSON object or YAML upload configuration.");
        result[group][key] = scalar(raw);
      } else if (raw === "|" || raw === "|-" || raw === ">") {
        const body = [];
        while (i + 1 < lines.length && /^(?:  |\s*$)/.test(lines[i + 1])) body.push(lines[++i].replace(/^  /, ""));
        result[key] = body.join(raw === ">" ? " " : "\n"); group = null;
      } else { result[key] = raw ? scalar(raw) : {}; group = raw ? null : key; }
    }
  }
  if (!result || Array.isArray(result) || typeof result !== "object") throw Error("Enter a valid JSON object or YAML upload configuration.");
  const allowed = ["url", "fileField", "urlPath", "path", "command", "headers", "fields"];
  for (const [key, value] of Object.entries(result)) {
    if (!allowed.includes(key) || (["headers", "fields"].includes(key) ? !value || Array.isArray(value) || typeof value !== "object" || Object.values(value).some((item) => typeof item !== "string") : typeof value !== "string")) throw Error("Enter a valid JSON object or YAML upload configuration.");
  }
  return result;
}
