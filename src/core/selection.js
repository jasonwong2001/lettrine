import { parseBlocks, quoteLineContent, tableCellRanges } from "./blocks.js";
import { parseInline } from "./inline.js";

const STYLES = new Set(["bold", "italic", "strike", "highlight", "underline", "subscript", "superscript", "link", "code", "math"]);

// Nested quote text has its own parser offsets. Keep a map back to the
// original Markdown so commands never mistake a quote prefix for content.
export function markdownSpans(source, settings = {}) {
  const blocks = [], nested = [], inline = [], cells = [], tree = parseBlocks(source);
  const scanInline = (text, map) => {
    let offset = 0;
    for (const part of parseInline(text, settings)) {
      const start = offset, end = start + part.src.length;
      if (STYLES.has(part.type)) {
        const prefix = part.open?.length || part.marker?.length || (part.type === "code" ? /^`+/.exec(part.src)[0].length : part.type === "math" && part.src.startsWith("\\(") ? 2 : 1);
        const inner = part.tex ?? part.inner;
        inline.push({ kind: part.type, part, start: map(start), end: map(end - 1) + 1,
          contentStart: map(start + prefix), contentEnd: inner.length ? map(start + prefix + inner.length - 1) + 1 : map(start + prefix) });
        if (typeof part.inner === "string" && !["code", "math"].includes(part.type)) scanInline(part.inner, (index) => map(start + prefix + index));
      }
      offset = end;
    }
  };
  const scan = (items, map, depth = 0) => {
    let offset = 0;
    for (const block of items) {
      offset += (block._leading || block._before || "").length;
      const base = offset, local = (index) => map(base + index);
      const span = { block, start: local(0), end: block.src.length ? local(block.src.length - 1) + 1 : local(0), depth };
      if (!depth) { span.index = blocks.length; blocks.push(span); }
      nested.push(span);
      if (block.type === "quote") {
        const positions = []; let cursor = 0;
        for (const line of block.src.split("\n")) {
          const prefix = line.length - quoteLineContent(line).length;
          for (let i = prefix; i < line.length; i++) positions.push(local(cursor + i));
          cursor += line.length;
          if (cursor < block.src.length) positions.push(local(cursor++));
        }
        positions.push(span.end);
        scan(block.items || [], (index) => positions[index] ?? span.end, depth + 1);
      } else if (!["code", "math", "html", "frontmatter", "toc", "hr"].includes(block.type)) {
        if (block.type === "table") {
          let cursor = 0;
          for (const [row, line] of block.src.split("\n").entries()) {
            if (row !== 1) for (const cell of tableCellRanges(line)) {
              cells.push({ start: local(cursor + cell.start), end: local(cursor + cell.end) });
              scanInline(cell.text, (index) => local(cursor + cell.start + index));
            }
            cursor += line.length + 1;
          }
        } else scanInline(block.src, local);
      }
      offset += block.src.length;
    }
  };
  scan(tree, (offset) => offset);
  return { tree, blocks, nested, inline, cells };
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const contains = (span, point) => point >= span.start && point <= span.end;
export function blockAt(spans, position) {
  return spans.blocks.find((span) => position <= span.end) || spans.blocks.at(-1) || { start: 0, end: 0, index: 0, block: { type: "paragraph", src: "" } };
}
function blockSelection(source, selection, spans) {
  const first = blockAt(spans, selection.start);
  // A selected block includes its separator; that separator does not select
  // the following block, even though a caret there resolves to that block.
  const last = selection.end > selection.start
    ? spans.blocks.findLast((span) => span.index >= first.index && span.start < selection.end) || first
    : first;
  return { start: first.index ? first.start : 0, end: spans.blocks[last.index + 1]?.start ?? source.length, first: first.index, last: last.index, wholeBlocks: true };
}
function contentBounds(source, position, spans) {
  const span = blockAt(spans, position), { block } = span;
  if (position < span.start) return { start: spans.blocks[span.index - 1]?.end ?? 0, end: span.start };
  if (position > span.end) return { start: span.end, end: source.length };
  if (["code", "math"].includes(block.type) && block.src.includes("\n")) {
    const start = span.start + block.src.indexOf("\n") + 1, end = start + (block.body ?? block.tex ?? "").length;
    if (position >= start && position <= end) return { start, end };
  }
  if (block.type === "heading") {
    const start = span.start + (/^ {0,3}#{1,6}[ \t]*/.exec(block.src)?.[0].length || 0);
    if (position >= start) return { start, end: span.end };
  }
  return { start: span.start, end: span.end };
}
function segments(text, granularity, locale) {
  try { return [...new Intl.Segmenter(locale || undefined, { granularity }).segment(text)]; }
  catch {
    const expression = granularity === "sentence" ? /[^.!?。！？]+[.!?。！？]*\s*|[.!?。！？]+\s*/gu : /[\p{L}\p{N}\p{M}_]+|\s+|./gu;
    return [...text.matchAll(expression)].map((match) => ({ segment: match[0], index: match.index, isWordLike: /[\p{L}\p{N}\p{M}_]/u.test(match[0]) }));
  }
}
function wordAt(source, position, bounds, locale) {
  const text = source.slice(bounds.start, bounds.end), point = clamp(position - bounds.start, 0, text.length);
  const words = segments(text, "word", locale);
  let word = words.find((item) => point >= item.index && point < item.index + item.segment.length && item.isWordLike);
  word ||= words.findLast((item) => item.isWordLike && item.index + item.segment.length === point);
  const current = words.find((item) => point >= item.index && point < item.index + item.segment.length);
  if (!current?.segment.trim()) word ||= words.find((item) => item.isWordLike && item.index >= point);
  if (word) return { start: bounds.start + word.index, end: bounds.start + word.index + word.segment.length };
  const graphemes = segments(text, "grapheme", locale), item = graphemes.find((item) => point >= item.index && point < item.index + item.segment.length) || graphemes.at(-1);
  return item ? { start: bounds.start + item.index, end: bounds.start + item.index + item.segment.length } : { start: position, end: position };
}
function lineAt(source, position, bounds) {
  const point = clamp(position, bounds.start, bounds.end);
  const before = point > bounds.start ? source.lastIndexOf("\n", point - 1) : bounds.start - 1, after = source.indexOf("\n", point);
  return { start: Math.max(bounds.start, before + 1), end: after < 0 ? bounds.end : Math.min(bounds.end, after) };
}

export function structuralRange(source, selection, kind, settings = {}, spans = markdownSpans(source, settings)) {
  const point = clamp(selection.backward ? selection.start : selection.end, 0, source.length);
  if (kind === "block") return blockSelection(source, selection, spans);
  if (kind === "scope") {
    const scopes = spans.inline.filter((span) => contains(span, point) && selection.start >= span.start && selection.end <= span.end);
    const scope = scopes.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (scope) return { start: scope.contentStart, end: scope.contentEnd };
    const cell = spans.cells.find((span) => contains(span, point));
    if (cell) return cell;
    const block = blockAt(spans, point), bounds = contentBounds(source, point, spans);
    if (["heading", "code", "math"].includes(block.block.type) && (bounds.start !== block.start || bounds.end !== block.end)) return bounds;
    return blockSelection(source, selection, spans);
  }
  let bounds = contentBounds(source, point, spans);
  if (kind === "word") {
    const wordBounds = (point) => {
      const literal = spans.inline.filter((span) => ["code", "math"].includes(span.kind) && point >= span.contentStart && point <= span.contentEnd).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      return literal ? { start: literal.contentStart, end: literal.contentEnd } : contentBounds(source, point, spans);
    };
    const end = Math.max(selection.start, selection.end - 1);
    const first = wordAt(source, selection.start, wordBounds(selection.start), settings.locale), last = wordAt(source, end, wordBounds(end), settings.locale);
    return { start: Math.min(first.start, last.start), end: Math.max(first.end, last.end) };
  }
  if (kind === "line") {
    const end = Math.max(selection.start, selection.end - 1);
    const first = lineAt(source, selection.start, contentBounds(source, selection.start, spans)), last = lineAt(source, end, contentBounds(source, end, spans));
    return { start: first.start, end: last.end };
  }
  if (kind === "sentence") {
    const text = source.slice(bounds.start, bounds.end), local = clamp(point - bounds.start, 0, text.length);
    const items = segments(text, "sentence", settings.locale), item = items.find((item) => local < item.index + item.segment.length) || items.at(-1);
    return item ? { start: bounds.start + item.index, end: bounds.start + item.index + item.segment.length } : { start: point, end: point };
  }
  const line = lineAt(source, point, bounds);
  const edge = kind === "lineStart" ? line.start : line.end;
  return { start: edge, end: edge };
}

export function structuralDeletion(source, selection, kind, settings = {}) {
  const spans = markdownSpans(source, settings);
  if (kind === "block") {
    const range = blockSelection(source, selection, spans);
    if (range.last === spans.blocks.length - 1 && range.first > 0) range.start = spans.blocks[range.first - 1].end;
    return range;
  }
  if (selection.start !== selection.end) return { start: selection.start, end: selection.end };
  const range = structuralRange(source, selection, kind, settings, spans);
  if (kind === "line") {
    const bounds = contentBounds(source, selection.start, spans);
    if (range.end < bounds.end && source[range.end] === "\n") range.end++;
    else if (range.start > bounds.start && source[range.start - 1] === "\n") range.start--;
  }
  return range;
}
