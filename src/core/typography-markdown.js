import { parseBlocks, blocksToMarkdown } from "./blocks.js";
import { parseInline } from "./inline.js";
import { smartPunctuation, rendersSmartPunctuation } from "./typography.js";

function inlineTypography(source, settings) {
  const parts = parseInline(source, settings);
  let before = "";
  return parts.map((part, index) => {
    const after = parts.slice(index + 1).map((item) => item.src).join("");
    let result = part.src;
    if (part.type === "text") result = smartPunctuation(part.src, settings, before, after);
    else if (["bold", "italic", "strike", "highlight", "underline", "subscript", "superscript", "link"].includes(part.type)) {
      const start = part.open?.length || part.marker?.length || 1;
      result = part.src.slice(0, start) + inlineTypography(part.inner, settings) + part.src.slice(start + part.inner.length);
    }
    before += result;
    return result;
  }).join("");
}

export function typographicMarkdown(source, settings = {}) {
  if (!rendersSmartPunctuation(settings)) return source;
  const blocks = parseBlocks(source).map((block) => {
    if (["code", "math", "html", "hr", "frontmatter", "toc"].includes(block.type)) return block;
    let src;
    if (block.type === "quote") {
      const lines = block.src.split("\n"), prefixes = lines.map((line) => /^ {0,3}>[ \t]?/.exec(line)?.[0] || "");
      const content = lines.map((line, i) => line.slice(prefixes[i].length)).join("\n");
      src = typographicMarkdown(content, settings).split("\n").map((line, i) => prefixes[i] + line).join("\n");
    } else if (block.type === "def_footnote") {
      const start = block.src.length - block.text.length;
      src = block.src.slice(0, start) + inlineTypography(block.text, settings);
    } else if (block.type === "table" || block.setext) {
      const lines = block.src.split("\n");
      src = lines.map((line, i) => i === 1 ? line : inlineTypography(line, settings)).join("\n");
    } else src = inlineTypography(block.src, settings);
    return { ...block, src };
  });
  return blocksToMarkdown(blocks);
}
