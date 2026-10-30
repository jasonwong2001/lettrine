import { parseBlocks } from "./blocks.js";
import { parseInline } from "./inline.js";
import { alertMarker } from "./alerts.js";

function inline(source, settings) {
  return parseInline(source, settings).map((part) => {
    if (part.type === "htmlBreak") return "\n";
    if (Array.isArray(part.inner)) return inlineParts(part.inner, settings);
    if (["bold", "italic", "strike", "highlight", "underline", "link", "subscript", "superscript"].includes(part.type) && typeof part.inner === "string") return inline(part.inner, { ...settings, _script: !!part.marker && ["subscript", "superscript"].includes(part.type) || settings?._script });
    return part.inner ?? part.char ?? part.tex ?? part.alt ?? (part.type === "footnote" ? "" : part.type === "autolink" ? part.url : part.src);
  }).join("");
}
function inlineParts(parts, settings) { return parts.map((part) => part.type === "htmlBreak" ? "\n" : Array.isArray(part.inner) ? inlineParts(part.inner, settings) : ["bold", "italic", "strike", "highlight", "underline", "link", "subscript", "superscript"].includes(part.type) && typeof part.inner === "string" ? inline(part.inner, settings) : part.inner ?? part.char ?? part.tex ?? part.alt ?? (part.type === "footnote" ? "" : part.src)).join(""); }
export function readableBlocks(blocks, settings = {}) {
  const read = (blocks) => blocks.map((block) => {
    if (["toc", "hr", "frontmatter"].includes(block.type)) return "";
    if (block.type === "quote") return read(block.alert ? block.items.map((item, index) => index ? item : { ...item, text: item.src.slice(alertMarker(item.src).prefix.length) }) : block.items);
    if (block.type === "list") {
      const items = (list) => list.map((item) => inline(item.text || "", settings) + (item.children?.length ? "\n" + items(item.children) : "")).join("\n");
      return items(block.items);
    }
    if (block.type === "table") return [block.headers, ...block.rows].map((row) => row.map((cell) => inline(cell, settings)).join(", ")).join("\n");
    if (block.type === "code") return block.body;
    if (block.type === "math") return block.tex;
    if (block.type === "html") return block.src.replace(/<[^>]*>/g, " ");
    return inline(block.text ?? block.src, settings);
  }).filter(Boolean).join("\n\n");
  return read(blocks).trim();
}
export function readableMarkdown(markdown, settings = {}) { return readableBlocks(parseBlocks(markdown), settings); }
