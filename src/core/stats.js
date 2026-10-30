import { readableBlocks, readableMarkdown } from "./readable.js";
import { blockSeparator } from "./blocks.js";
const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
const cache = new WeakMap();
const sourceCache = new Map();
let cachedCharacters = 0;
function blockCounts(block, settings) {
  const scripts = !!settings.subscriptSuperscript, key = scripts + "\0" + block.type + "\0" + block.src;
  let entry = sourceCache.get(key);
  if (entry) {
    sourceCache.delete(key); sourceCache.set(key, entry);
    return entry;
  }
  entry = { source: block.src, type: block.type, scripts, words: countText(readableBlocks([block], settings)).words, chars: characterCount(block.src) };
  // Source mode reparses blocks on each edit. Bound the shared text cache so
  // unchanged source keeps its counts without retaining old documents forever.
  if (key.length <= 2e6) {
    sourceCache.set(key, entry); cachedCharacters += key.length;
    while (sourceCache.size > 10000 || cachedCharacters > 2e6) {
      const oldest = sourceCache.keys().next().value;
      cachedCharacters -= oldest.length; sourceCache.delete(oldest);
    }
  }
  return entry;
}
export function countText(text) {
  let words = 0, chars = 0;
  if (segmenter) { for (const part of segmenter.segment(text)) if (part.isWordLike) words++; }
  else words = (text.match(/[\p{L}\p{N}_]+/gu) || []).length;
  for (const char of text) chars++;
  return { words, chars };
}
function characterCount(text) {
  let chars = 0;
  for (const character of text) chars++;
  return chars;
}

export function documentStats(blocks, markdown, settings = {}) {
  let words = 0, chars = 0;
  const valid = blocks.every((block) => block && block.src != null) ? blocks : blocks.filter((block) => block && block.src != null);
  for (let i = 0; i < valid.length; i++) {
    const block = valid[i];
    let entry = cache.get(block);
    if (!entry || entry.source !== block.src || entry.type !== block.type || entry.scripts !== !!settings.subscriptSuperscript) {
      entry = blockCounts(block, settings);
      cache.set(block, entry);
    }
    words += entry.words;
    // Separators hold only blank lines, so UTF-16 length is the code-point count.
    chars += entry.chars + (i === 0 ? block._leading || "" : blockSeparator(valid, i)).length;
  }
  chars += (valid.at(-1)?._after || "").length;
  // An explicit string remains supported for callers counting another view.
  // The normal document path reuses character counts of unchanged blocks.
  if (markdown !== undefined) chars = characterCount(markdown);
  return { words, chars };
}
export const selectionStats = (markdown, settings = {}) => countText(readableMarkdown(markdown, settings));
