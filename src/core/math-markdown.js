import { parseBlocks, blocksToMarkdown } from "./blocks.js";
import { parseInline } from "./inline.js";
import { equationIndex, equationTex } from "./math.js";

// Pandoc drops \tag, so put the resolved tag beside the formula in its math
// body. The native HTML/PDF path uses KaTeX's right-margin tags instead.
export function equationMarkdown(source, settings = {}) {
  const blocks = parseBlocks(source), index = equationIndex(blocks, settings);
  const inline = (text) => parseInline(text, settings).map((part) => {
    if (part.type === "math") return "$" + equationTex(part.tex, index, null, { links: false }) + "$";
    if (["bold", "italic", "strike", "highlight", "underline", "subscript", "superscript", "link"].includes(part.type)) {
      const start = part.open?.length || part.marker?.length || 1;
      return part.src.slice(0, start) + inline(part.inner) + part.src.slice(start + part.inner.length);
    }
    return part.src;
  }).join("");
  const convert = (block) => {
    let src = block.src;
    if (block.type === "math") src = "$$\n" + equationTex(block.tex, index, index.byBlock.get(block), { links: false, pandoc: true }) + "\n$$";
    else if (block.type === "quote") {
      const transformed = blocksToMarkdown(block.items.map(convert));
      if (transformed !== blocksToMarkdown(block.items)) src = transformed.split("\n").map((line) => "> " + line).join("\n");
    } else if (!["code", "html", "frontmatter", "hr", "toc", "image"].includes(block.type)) src = inline(src);
    return src === block.src ? block : { ...block, src };
  };
  return blocksToMarkdown(blocks.map(convert));
}
