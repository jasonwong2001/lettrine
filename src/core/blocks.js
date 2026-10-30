// Block model for the Lettrine live-preview editor.
//
// A document is an ordered list of blocks. Every block carries:
//   type  – "paragraph" | "heading" | "hr" | "code" | "quote" | "list"
//           | "table" | "math" | "image" | "html" | "def_footnote" | "toc" | "frontmatter"
//   src   – the exact markdown source of this block (serialization unit)
//   ...   – type-specific structure for rendering
//
// Parsed blocks retain their original source and surrounding whitespace.
// Newly inserted blocks default to one blank line of separation.

import { parseInline } from "./inline.js";
import { alertMarker } from "./alerts.js";
import { diagramLanguage } from "./diagrams.js";

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})([ \t]*([^\n]*?)[ \t]*)$/;
const HEADING_RE = /^(\s{0,3})(#{1,6})(\s+(.*))?$/;
const HR_RE = /^(\s{0,3})(-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^(\s{0,3})>(\s?(.*))?$/;
export function quoteLineContent(line) {
  const match = QUOTE_RE.exec(line);
  return match ? (match[3] || "").replace(/^\s/, "") : line;
}
const LIST_ITEM_RE = /^(\s*)([*+-]|\d{1,9}[.)])(\s+(.*)|)$/;
const TABLE_SEP_RE = /^\s*\|?(\s*:?-{1,}:?\s*\|)+\s*:?-{1,}:?\s*\|?\s*$/;
// A footnote definition is a line that is
// exactly "[^ref]: text" (surrounding whitespace ok, text on the same line)
const DEF_FOOTNOTE_RE = /^\s*\[\^([^\]\n]+)\]:(\s*)([^\n]*)$/;
// Standalone TOC forms: [toc] / {:toc} / [[_TOC_]] / {: toc ...} and the
// full-width 【toc】
const TOC_LINE_RES = [
  /^\[toc\]$/i,
  /^\{:\s*toc(\s*|\s+.*\S)\s*\}$/i,
  /^\[\[\s*_TOC_\s*\]\]$/i,
  /^[\u3010]toc[\u3011]$/i,
];

function isTocLine(line) {
  return TOC_LINE_RES.some((re) => re.test(line.trim()));
}

const HTML_BLOCK_RE = /^\s{0,3}<(?![uU]>|[sS][uU][bBpP]>|[iI][mM][gG]\b)([a-zA-Z][a-zA-Z0-9-]*|!--|!DOCTYPE|#)([\s/>].*)?$/;
// A math block opens on a line that is exactly $$ (surrounding whitespace
// and an optional {align} attribute allowed); "$$x" is text
const MATH_OPEN_RE = /^\s*\$\$\s*(?:\{(.+)\})?\s*$/;
const MATH_OPEN_LEGACY_RE = /^\s*\\\(\s*$/;
const MATH_CLOSE_RE = /(\$\$|\\\))\s*$/;
const CODE_LANGS = new Set(["js", "javascript", "ts", "typescript", "python", "py", "rb", "ruby", "go", "rs", "rust", "java", "c", "cpp", "csharp", "cs", "swift", "kt", "kotlin", "sh", "bash", "zsh", "shell", "fish", "json", "yaml", "yml", "toml", "xml", "html", "css", "scss", "less", "sql", "r", "m", "matlab", "lua", "perl", "php", "dart", "diff", "git", "docker", "makefile", "ini", "env", "text", "txt", "plaintext", "cmake", "proto", "graphql", "vue", "svelte", "jsx", "tsx", "asm", "nasm", "asm64", "powershell", "ps1", "bat", "cmd", "elisp", "haskell", "hs", "clojure", "clj", "erlang", "elixir", "ex", "fsharp", "fs", "scala", "groovy", "julia", "nim", "zig", "v", "solidity", "sol", "wasm", "wat"]);

function indentOf(line) {
  const m = /^\s*/.exec(line)[0];
  return m.replace(/\t/g, "  ").length;
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

export function tableCellRanges(line) {
  const pipes = [];
  let ticks = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "`") {
      let count = 1;
      while (line[i + count] === "`") count++;
      if (!ticks) ticks = count;
      else if (ticks === count) ticks = 0;
      i += count - 1;
      continue;
    }
    if (line[i] === "|" && !ticks) pipes.push(i);
  }
  const first = pipes[0];
  const last = pipes.at(-1);
  const leading = first !== undefined && !line.slice(0, first).trim();
  const trailing = last !== undefined && !line.slice(last + 1).trim();
  const edges = [leading ? first : -1, ...pipes.filter((p) => !(leading && p === first) && !(trailing && p === last)), trailing ? last : line.length];
  const ranges = [];
  for (let i = 1; i < edges.length; i++) {
    const rawStart = edges[i - 1] + 1;
    const rawEnd = edges[i];
    const cell = line.slice(rawStart, rawEnd);
    const start = rawStart + (cell.match(/^[ \t]*/)?.[0].length || 0);
    const end = Math.max(start, rawEnd - (cell.match(/[ \t]*$/)?.[0].length || 0));
    ranges.push({ start, end, text: line.slice(start, end) });
  }
  return ranges;
}

function splitTableRow(line) {
  return tableCellRanges(line).map((cell) => cell.text);
}

function isDiagramLang(lang) {
  return !!diagramLanguage(lang);
}

/**
 * Parse markdown source into blocks.
 * @param {string} src
 * @param {{documentStart?: boolean}} options
 * @returns {Array<object>}
 */
export function parseBlocks(src, { documentStart = true } = {}) {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  let startLine = 0;
  let previousEnd = 0;
  const push = (block) => {
    block.src = lines.slice(startLine, i).join("\n");
    if (blocks.length) block._before = "\n" + lines.slice(previousEnd, startLine).join("\n") + (startLine > previousEnd ? "\n" : "");
    else block._leading = lines.slice(0, startLine).join("\n") + (startLine ? "\n" : "");
    previousEnd = i;
    blocks.push(block);
  };

  const take = (n) => {
    const out = lines.slice(i, i + n);
    i += n;
    return out;
  };

  while (i < lines.length) {
    startLine = i;
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    // YAML metadata belongs only at the document's first line. A bare
    // delimiter remains editable until Enter supplies the opening newline.
    if (documentStart && i === 0 && /^\uFEFF?---[ \t]*$/.test(line) && lines.length > 1) {
      let end = i + 1;
      while (end < lines.length && !/^(---|\.\.\.)[ \t]*$/.test(lines[end])) end++;
      const closed = end < lines.length;
      const body = lines.slice(i + 1, end).join("\n");
      i = closed ? end + 1 : end;
      push({ type: "frontmatter", body, closed });
      continue;
    }

    // --- fenced code ---
    let m = FENCE_RE.exec(line);
    if (m) {
      const fence = m[2];
      const info = (m[4] || "").trim();
      const bodyLines = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines[i]) && lines[i].trim().startsWith(fence[0]) && lines[i].trim().length >= fence.length) {
          closed = true;
          i++;
          break;
        }
        bodyLines.push(lines[i]);
        i++;
      }
      const body = bodyLines.join("\n");
      const fenceSrc = line.trim();
      push({
        type: "code",
        src: fenceSrc + "\n" + body + (closed ? "\n" + fence : ""),
        fence,
        fenceSrc,
        info,
        body,
        closed,
        diagram: isDiagramLang(info),
      });
      continue;
    }

    // --- block math ($$ ... $$ or \( ... \)) ---
    if (MATH_OPEN_RE.test(line) || MATH_OPEN_LEGACY_RE.test(line)) {
      const am = MATH_OPEN_RE.exec(line);
      const opener = am ? "$$" : "\\(";
      const alignAttr = am && am[1] ? am[1] : null;
      const closer = opener === "$$" ? "$$" : "\\)";
      const first = line.replace(/^\s{0,3}/, "").replace(opener, "").trim();
      const texLines = [];
      if (first && !am) texLines.push(first);
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const l = lines[j];
        // block math closes only when the line IS the closer
        // ("$$" alone); "$$2" mid-line is still TeX content
        const cm = l.trim() === closer;
        if (cm) {
          const before = l.trim().slice(0, l.trim().length - closer.length);
          if (before) texLines.push(before);
          closed = true;
          j++;
          break;
        }
        texLines.push(l);
        j++;
      }
      const tex = texLines.join("\n");
      i = j;
      push({
        type: "math",
        src: "$$\n" + tex + (closed ? "\n$$" : ""),
        tex,
        closed,
        align: alignAttr || undefined,
      });
      continue;
    }

    // --- ATX heading ---
    m = HEADING_RE.exec(line);
    if (m) {
      const level = m[2].length;
      const text = (m[4] || "").trim();
      i++;
      push({ type: "heading", src: "#".repeat(level) + (text ? " " + text : ""), level, text });
      continue;
    }

    // --- hr (or setext underline handled below in paragraph branch) ---
    if (HR_RE.test(line) && !isTableSepLine(line)) {
      i++;
      push({ type: "hr", src: line.trim(), pending: i === lines.length });
      continue;
    }

    // --- footnote definition ([^ref]: text) — single-line terminal block ---
    const dfm = DEF_FOOTNOTE_RE.exec(line);
    if (dfm) {
      i++;
      push({
        type: "def_footnote",
        src: line.trim(),
        ref: (dfm[1] || "").trim(),
        pattern: dfm[2] !== undefined ? dfm[2] : " ",
        text: dfm[3] || "",
      });
      continue;
    }

    // --- table of contents block (terminal, source = the trigger line) ---
    if (isTocLine(line)) {
      i++;
      push({ type: "toc", src: line.trim(), pattern: line.trim() });
      continue;
    }

    // --- blockquote ---
    if (QUOTE_RE.test(line)) {
      const quoteLines = [];
      let j = i;
      while (j < lines.length) {
        const qm = QUOTE_RE.exec(lines[j]);
        if (qm) {
          quoteLines.push(quoteLineContent(lines[j]));
          j++;
        } else if (isBlank(lines[j])) {
          break;
        } else if (!isBlank(lines[j]) && !FENCE_RE.test(lines[j]) && !HEADING_RE.test(lines[j]) && !DEF_FOOTNOTE_RE.test(lines[j]) && !isTocLine(lines[j])) {
          // lazy continuation
          quoteLines.push(lines[j]);
          j++;
        } else {
          break;
        }
      }
      const innerSrc = quoteLines.join("\n");
      const inner = parseBlocks(innerSrc, { documentStart: false });
      const alert = inner[0]?.type === "paragraph" ? alertMarker(inner[0].src)?.type || null : null;
      if (alert && inner.length === 1 && !inner[0].src.includes("\n") && quoteLines.at(-1) === "") {
        inner.push({ type: "paragraph", src: "", text: "", _before: inner[0]._after || "\n" });
        delete inner[0]._after;
      }
      i = j;
      push({
        type: "quote",
        src: quoteLines.map((l) => (l === "" ? ">" : "> " + l)).join("\n"),
        items: inner,
        alert,
      });
      continue;
    }

    // --- list ---
    const lm = LIST_ITEM_RE.exec(line);
    if (lm && !(line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1] ?? ""))) {
      const listBlock = parseListBlock(lines, i);
      i = listBlock.next;
      push(listBlock.block);
      continue;
    }

    // --- table ---
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headerLine = line;
      const sepLine = lines[i + 1];
      const headers = splitTableRow(headerLine);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && !isBlank(lines[j])) {
        rows.push({ line: lines[j], cells: splitTableRow(lines[j]) });
        j++;
      }
      const lead = headerLine.trim().startsWith("|") ? "|" : "";
      const trail = headerLine.trim().endsWith("|") ? "|" : "";
      const rowSrc = (cells) => `${lead} ${cells.join(" | ")} ${trail}`.trim();
      i = j;
      push({
        type: "table",
        src: [headerLine, sepLine, ...rows.map((r) => r.line)].join("\n"),
        headers,
        headerLine,
        sepLine,
        rows: rows.map((r) => r.cells),
        lead,
        trail,
        rowSrc,
      });
      continue;
    }

    // --- standalone image ---
    const image = /^(?:!\[|<img\b)/i.test(line.trimStart()) ? parseInline(line.trim()) : [];
    if (image.length === 1 && image[0].type === "image") {
      i++;
      push({
        type: "image",
        src: line.trim(),
        alt: image[0].alt,
        url: image[0].url,
        title: image[0].title,
        syntax: image[0].syntax, width: image[0].width, height: image[0].height, zoom: image[0].zoom,
      });
      continue;
    }

    // --- raw html block ---
    if (HTML_BLOCK_RE.test(line)) {
      const htmlLines = [line];
      let j = i + 1;
      while (j < lines.length && !isBlank(lines[j])) { htmlLines.push(lines[j]); j++; }
      i = j;
      push({ type: "html", src: htmlLines.join("\n") });
      continue;
    }

    // --- paragraph (with setext heading detection) ---
    const paraLines = [line];
    let j = i + 1;
    while (j < lines.length && !isBlank(lines[j])) {
      const l = lines[j];
      if (FENCE_RE.test(l) || HEADING_RE.test(l) || QUOTE_RE.test(l) || LIST_ITEM_RE.test(l) || HTML_BLOCK_RE.test(l) || DEF_FOOTNOTE_RE.test(l) || isTocLine(l) || (l.includes("|") && j + 1 < lines.length && TABLE_SEP_RE.test(lines[j + 1] ?? ""))) break;
      const isSetext = /^(={3,}|-{3,})\s*$/.test(l);
      if (isSetext && paraLines.length >= 1) break;
      paraLines.push(l);
      j++;
    }
    if (j < lines.length && /^(={3,}|-{3,})\s*$/.test(lines[j]) && paraLines.length > 0) {
      const level = lines[j].trim().startsWith("=") ? 1 : 2;
      const text = level === 1 ? paraLines[paraLines.length - 1] : paraLines.join(" ");
      i = j + 1;
      push({ type: "heading", src: "#".repeat(level) + " " + text.trim(), level, text: paraLines.join("\n"), setext: true });
      continue;
    }
    i = j;
    const paraSrc = paraLines.join("\n");
    push({ type: "paragraph", src: paraSrc, text: paraSrc });
  }

  if (blocks.length && previousEnd < lines.length) blocks[blocks.length - 1]._after = "\n" + lines.slice(previousEnd).join("\n");
  if (!blocks.length && src) blocks.push({ type: "paragraph", src: "", text: "", _leading: src.replace(/\r\n/g, "\n") });
  return blocks;
}

function isTableSepLine(line) {
  return TABLE_SEP_RE.test(line) && line.includes("-");
}

// List items are of one type when their markers are: the same bullet
// character, or ordered numbers with the same delimiter. As in CommonMark,
// an item of another type starts a new list.
export function listKind(marker) {
  return /^\d/.test(marker) ? marker.slice(-1) : marker;
}

/**
 * Parse a list starting at `lines[i]`.
 * Returns {block, next}.
 */
function parseListBlock(lines, i) {
  const first = lines[i];
  const firstM = LIST_ITEM_RE.exec(first);
  const baseIndent = indentOf(first);
  const kind = listKind(firstM[2]);
  const items = [];
  let j = i;
  let previousLine = i - 1;
  // a list item on `line` belongs to this list: nested under an item, or a
  // sibling of the same type
  const continues = (line) => {
    const m = LIST_ITEM_RE.exec(line);
    if (!m) return false;
    const indent = indentOf(line);
    return indent > baseIndent ? items.length > 0 : indent === baseIndent && listKind(m[2]) === kind;
  };

  const makeItem = (line) => {
    const m = LIST_ITEM_RE.exec(line);
    const marker = m[2];
    const ordered = /^\d/.test(marker);
    const after = m[4] || "";
    // exact raw prefix: indent + marker + spacing + task syntax + spacing
    const leadWs = m[3].slice(0, Math.max(0, m[3].length - after.length));
    let task = null;
    let taskRaw = "";
    let body = after;
    const tm = /^\[([ xX])\][ \t]+/.exec(after);
    if (tm) {
      task = { checked: tm[1].toLowerCase() === "x" };
      taskRaw = tm[0];
      body = after.slice(tm[0].length);
    }
    const leadWs2 = body.slice(0, body.length - body.replace(/^[ \t]+/, "").length);
    const prefix = m[1] + marker + leadWs + taskRaw + leadWs2;
    // keep body complete after the leading whitespace: interior/trailing
    // spaces are typed source and must survive parse → src round-trips
    const text = body.slice(leadWs2.length);
    return {
      indent: indentOf(line),
      marker,
      ordered,
      text,
      task,
      prefix,
      src: line.trim(),
      line,
      children: [],
    };
  };

  while (j < lines.length) {
    const line = lines[j];
    if (isBlank(line)) {
      // a blank line between items stays inside the list; one before
      // anything else separates the list from the next block
      let k = j + 1;
      while (k < lines.length && isBlank(lines[k])) k++;
      if (k < lines.length && continues(lines[k])) j = k;
      else break;
      continue;
    }
    if (!continues(line)) break;
    const item = makeItem(line);
    if (previousLine >= i) item._before = "\n" + lines.slice(previousLine + 1, j).map((line) => line + "\n").join("");
    previousLine = j;
    if (item.indent > baseIndent) {
      // attach as nested child of the deepest matching ancestor
      let parent = items[items.length - 1];
      while (parent.children.length > 0) {
        const child = parent.children[parent.children.length - 1];
        if (child.indent < item.indent) parent = child;
        else break;
      }
      parent.children.push(item);
    } else {
      items.push(item);
    }
    j++;
  }

  const ordered = items[0]?.ordered ?? false;
  const marker = items[0]?.marker ?? "-";
  // source is the exact raw lines, in document order — normalization would
  // drop typed characters (e.g. the space in "- " while a list is forming)
  return {
    block: {
      type: "list",
      src: listSrcFromItems(items),
      ordered,
      marker,
      items,
    },
    next: j,
  };
}

/**
 * Serialize original source/layout, using a blank line for new boundaries.
 * @param {Array<object>} blocks
 */
export function blocksToMarkdown(blocks) {
  const valid = blocks.filter((b) => b && b.src != null);
  return valid.map((b, i) => (i === 0 ? b._leading || "" : blockSeparator(valid, i)) + b.src).join("") + (valid.at(-1)?._after || "");
}

// A copy of text.slice(start, end) with its own storage. Engines share a
// slice's storage with the whole text, and blocks parsed from a shared
// slice would keep that version of the document alive while they live.
function detachedSlice(text, start, end) {
  const pieces = [];
  for (let offset = start; offset < end; offset += 4096) pieces.push(text.slice(offset, Math.min(end, offset + 4096)).split("").join(""));
  return pieces.join("");
}

// Offsets of the first and last differing UTF-16 units of two texts.
function changedRange(before, after) {
  const limit = Math.min(before.length, after.length);
  let start = 0, beforeEnd = before.length, afterEnd = after.length;
  while (start + 1024 <= limit && before.slice(start, start + 1024) === after.slice(start, start + 1024)) start += 1024;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  while (beforeEnd - 1024 >= start && afterEnd - 1024 >= start && before.slice(beforeEnd - 1024, beforeEnd) === after.slice(afterEnd - 1024, afterEnd)) { beforeEnd -= 1024; afterEnd -= 1024; }
  while (beforeEnd > start && afterEnd > start && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) { beforeEnd--; afterEnd--; }
  return { start, end: beforeEnd, delta: afterEnd - beforeEnd };
}

/**
 * Parse an edited document reusing the blocks the edit did not touch.
 *
 * Each body block parses from its first line with no state from earlier blocks,
 * and looks at most a line past its end. An old block that starts after the
 * edit therefore parses the same when the new parse reaches a boundary at
 * its new offset, and so do the blocks after it. Parsing starts one block
 * before the edit, which an edit at a block's start can join, and grows the
 * window until such a boundary appears.
 *
 * `blocks` must serialize to `before`, with `starts` their source offsets.
 * Returns the new block list, or null to parse the whole document.
 */
export function reparseBlocks(blocks, starts, before, after) {
  const count = blocks.length;
  if (!count || starts.length !== count || after.includes("\r")) return null;
  if (before === after) return blocks.slice();
  const { start, end, delta } = changedRange(before, after);
  let first = 0;
  while (first < count - 1 && starts[first] + blocks[first].src.length < start) first++;
  first = Math.max(0, first - 1);
  const from = first ? starts[first] : 0;
  let next = first + 1;
  while (next < count && starts[next] <= end) next++;
  for (let attempt = 0; attempt < 6; attempt++) {
    const last = next >= count;
    const stop = last ? after.length : next + 1 < count ? starts[next + 1] + delta : after.length;
    const parsed = parseBlocks(detachedSlice(after, from, stop), { documentStart: from === 0 });
    if (!parsed.length) return null;
    let found = -1;
    if (last) found = parsed.length;
    else {
      // the new offset of each parsed block, as blocksToMarkdown lays them out
      let offset = from + (parsed[0]._leading || "").length;
      const target = starts[next] + delta;
      for (let i = 0; i < parsed.length && offset <= target; i++) {
        if (i) offset += blockSeparator(parsed, i).length;
        if (offset === target) { found = i; break; }
        offset += parsed[i].src.length;
      }
      if (found < 0 || found !== parsed.length - 1 || parsed[found].src !== blocks[next].src || parsed[found].type !== blocks[next].type) {
        if (++next >= count) next = count;
        continue;
      }
    }
    const head = parsed.slice(0, found);
    // Block `first` starts the window and still has text, so it parses again;
    // its leading lines are the separator before it.
    if (first && !head.length) return null;
    if (first) { delete head[0]._leading; head[0]._before = blocks[first]._before; }
    if (last) return [...blocks.slice(0, first), ...head];
    let kept = blocks[next];
    if (parsed[found]._before !== kept._before) {
      // the separator before it changed: the block is equal, its spacing is not
      kept = parsed[found];
      delete kept._after;
      if (blocks[next]._after !== undefined) kept._after = blocks[next]._after;
    }
    return [...blocks.slice(0, first), ...head, kept, ...blocks.slice(next + 1)];
  }
  return null;
}

export function blockSeparator(blocks, index) {
  return blocks[index]?._before ?? (blocks[index - 1]?.type === "def_footnote" && blocks[index]?.type === "def_footnote" ? "\n" : "\n\n");
}

// The block of `blocks`, parsed from one text, that holds `offset` of that
// text, and the offset within it.
export function locateOffset(blocks, offset) {
  let index = 0, start = (blocks[0]?._leading || "").length;
  while (index + 1 < blocks.length && offset > start + blocks[index].src.length) {
    start += blocks[index].src.length + blockSeparator(blocks, index + 1).length;
    index++;
  }
  return { index, offset: Math.max(0, Math.min(offset - start, blocks[index]?.src.length ?? 0)) };
}

export function inheritBlockLayout(original, replacements) {
  if (!replacements.length) return replacements;
  for (const key of ["_before", "_leading", "_cid"]) {
    if (original[key] !== undefined) replacements[0][key] = original[key];
  }
  if (original._after !== undefined) replacements[replacements.length - 1]._after = (replacements.at(-1)._after || "") + original._after;
  return replacements;
}

/**
 * Split a block at a source offset into [left, right].
 *
 * Returns:
 *  {kind:'split', left, right}        – two blocks
 *  {kind:'stay', block, offset}       – one block (Enter inserts a line inside)
 *  {kind:'after', block, newBlock}    – block plus a new block after it
 *  {kind:'none'}                      – cannot split (empty block)
 */
export function splitBlock(block, offset) {
  const src = block.src ?? "";
  if (block.type === "paragraph") {
    if (offset <= 0 && src) return { kind: "split", left: { type: "paragraph", src: "", text: "" }, right: block };
    if (offset >= src.length) return { kind: "none" };
    const left = { type: "paragraph", src: src.slice(0, offset), text: src.slice(0, offset) };
    const right = { type: "paragraph", src: src.slice(offset), text: src.slice(offset) };
    return { kind: "split", left, right };
  }
  if (block.type === "heading") {
    const prefix = /^(\s{0,3}#{1,6}\s*)/.exec(src)?.[0] || "";
    if (offset <= prefix.length) return { kind: "split", left: { type: "paragraph", src: "", text: "" }, right: block };
    const textEnd = block.setext ? src.lastIndexOf("\n") : src.length;
    if (offset < textEnd) {
      const text = src.slice(prefix.length, offset);
      const right = src.slice(offset, textEnd);
      const leftSource = prefix + text + (block.setext ? src.slice(textEnd) : "");
      return { kind: "split", left: { ...block, src: leftSource, text }, right: { type: "paragraph", src: right, text: right } };
    }
    return {
      kind: "after",
      block,
      newBlock: { type: "paragraph", src: "", text: "" },
      offset: 0,
    };
  }
  if (block.type === "code") {
    // find offset relative to body (skip fence prefix)
    const firstBreak = src.indexOf("\n");
    if (firstBreak < 0) return { kind: "stay", block: { ...block, src: src + "\n", body: "", closed: false }, offset: src.length + 1 };
    const prefixLen = firstBreak + 1;
    if (offset < prefixLen) return { kind: "none" };
    const rel = offset - prefixLen;
    const body = block.body;
    // Enter on an EMPTY line inside a closed fence pops the caret OUT of
    // the block (our fence exit): trim the trailing empty line and
    // spawn a paragraph after the fence
    const lineStart = body.lastIndexOf("\n", Math.max(0, rel - 1)) + 1;
    const lineEnd = body.indexOf("\n", rel);
    const curLine = body.slice(lineStart, lineEnd === -1 ? body.length : lineEnd);
    if (block.closed && curLine.trim() === "" && body.trim() !== "") {
      const trimmed = body.replace(/\n+$/, "");
      return {
        kind: "after",
        block: codeBlock(block, trimmed, true),
        newBlock: { type: "paragraph", src: "", text: "" },
        offset: 0,
      };
    }
    if (rel >= body.length) {
      const nb = body + "\n";
      return { kind: "stay", block: codeBlock(block, nb, true), offset: offset + 1 };
    }
    const nb = body.slice(0, rel) + "\n" + body.slice(rel);
    return { kind: "stay", block: codeBlock(block, nb, block.closed), offset: offset + 1 };
  }
  if (block.type === "math") {
    // a caret at/after the "$$" (offset >= 2, i.e. anywhere a caret can
    // realistically be after typing it) is inside the math block — Enter
    // breaks the formula line; only an earlier caret pops out
    if (offset >= 2) {
      const tex = block.tex || "";
      const rel = offset - 3;
      // Enter right after $$ (empty TeX): put a line break INTO the formula
      // (the caret must land on a real, visible second line, so you keep
      // editing inside the block)
      if (!tex) {
        const opening = src.split("\n")[0];
        const updated = opening + "\n" + (block.closed ? "\n" + src.split("\n").at(-1) : "");
        return { kind: "stay", block: { ...block, tex: "", src: updated }, offset: opening.length + 1 };
      }
      const nb = tex.slice(0, rel) + "\n" + tex.slice(rel);
      const updatedSrc = block.closed ? "$$\n" + nb + "\n$$" : "$$\n" + nb;
      return { kind: "stay", block: { ...block, tex: nb, src: updatedSrc }, offset: offset + 1 };
    }
    return {
      kind: "after",
      block,
      newBlock: { type: "paragraph", src: "", text: "" },
      offset: 0,
    };
  }
  if (block.type === "frontmatter") {
    if (!block.closed || offset < src.length) {
      const updated = src.slice(0, offset) + "\n" + src.slice(offset);
      const blocks = parseBlocks(updated);
      const caret = locateOffset(blocks, offset + 1);
      return { kind: "replace", blocks, caretBlock: caret.index, offset: caret.offset };
    }
    return { kind: "after", block, newBlock: { type: "paragraph", src: "", text: "" }, offset: 0 };
  }
  if (block.type === "hr" || block.type === "image" || block.type === "html" || block.type === "toc") {
    return {
      kind: "after",
      block: block.type === "hr" ? { ...block, pending: false } : block,
      newBlock: { type: "paragraph", src: "", text: "" },
      offset: 0,
    };
  }
  if (block.type === "def_footnote") {
    // a footnote definition is a single line (noChangeLine): Enter keeps the
    // definition whole and starts a new block after it
    return {
      kind: "after",
      block,
      newBlock: { type: "paragraph", src: "", text: "" },
      offset: 0,
    };
  }
  if (block.type === "table") {
    // Enter in a table inserts a new row after the current row.
    const { rows, headers, rowSrc } = block;
    const newRows = [...rows];
    newRows.push(headers.map(() => ""));
    const src = [block.headerLine, block.sepLine, ...newRows.map((r) => rowSrc(r))].join("\n");
    return {
      kind: "after-row",
      block: { ...block, rows: newRows, src },
      offset: 0,
    };
  }
  if (block.type === "list") {
    return splitList(block, offset);
  }
  if (block.type === "quote") {
    return splitQuote(block, offset);
  }
  return { kind: "none" };
}

function codeBlock(orig, body, closed) {
  const fence = (orig.fence || "```").replace(/[^`~]+$/, "");
  const info = orig.info ?? "";
  const fenceSrc = fence + info;
  return {
    type: "code",
    src: fenceSrc + "\n" + body + (closed ? "\n" + fence : ""),
    fence: fenceSrc,
    info,
    body,
    closed,
    diagram: isDiagramLang(info),
  };
}

/**
 * Split a list block at offset: find the item whose source range contains
 * the offset; split its text; duplicate the marker (increment ordered).
 * If the item is empty, pop the item out of the list.
 */
function splitList(block, offset) {
  // Build flat item ranges in document order with their line lengths.
  const flat = [];
  let pos = 0;
  const walk = (items) => {
    items.forEach((it, idx) => {
      if (flat.length) pos += (it._before ?? "\n").length;
      const lineLen = itemLineLen(it);
      flat.push({ it, start: pos, end: pos + lineLen, idx });
      pos += lineLen;
      if (it.children.length) walk(it.children);
    });
  };
  walk(block.items);

  const target = flat.find((f) => offset >= f.start && offset <= f.end);
  if (!target) {
    // offset at the very end → new empty item
    const last = flat[flat.length - 1];
    if (last) return appendItem(block, last.it);
    return { kind: "none" };
  }
  const item = target.it;
  const prefixLen = listItemSrc(item).length - (item.text || "").length;
  const rel = Math.max(0, offset - target.start - prefixLen);
  const text = item.text ?? "";
  const taskPart = item.task ? (item.task.checked ? "[x] " : "[ ] ") : "";

  // Empty item (or only task marker) → pop out: remove the item.
  if (text.trim() === "") {
    if (item.indent > (block.items[0]?.indent || 0)) {
      const lines = block.src.split("\n");
      const lineIndex = block.src.slice(0, target.start).split("\n").length - 1;
      const outdented = lines[lineIndex].replace(/^(?: {1,2}|\t)/, "");
      const removed = lines[lineIndex].length - outdented.length;
      lines[lineIndex] = outdented;
      // an outdented item of another marker type starts a list of its own
      const updated = parseBlocks(lines.join("\n"));
      const caret = locateOffset(updated, Math.max(target.start, offset - removed));
      inheritBlockLayout(block, updated);
      if (updated.length === 1) return { kind: "stay", block: updated[0], offset: caret.offset };
      return { kind: "replace", blocks: updated, caretBlock: caret.index, offset: caret.offset };
    }
    const before = parseBlocks(block.src.slice(0, target.start).replace(/\n$/, ""));
    const after = parseBlocks(block.src.slice(target.end + 1));
    return { kind: "replace", blocks: [...before, { type: "paragraph", src: "", text: "" }, ...after], caretBlock: before.length, offset: 0 };
  }
  const leftText = text.slice(0, rel);
  const rightText = text.slice(rel);
  const newMarker = item.ordered ? nextOrderedMarker(item.marker) : item.marker;
  const copy = block.items.map(cloneItem);
  const cloned = walkCopy(block.items, item, copy);
  cloned.text = leftText;
  cloned.line = undefined;
  const next = {
      indent: item.indent,
      marker: newMarker,
      ordered: item.ordered,
      text: rightText,
      task: item.task ? { checked: false } : null,
      prefix: " ".repeat(Math.max(0, item.indent || 0)) + newMarker + " " +
        (item.task ? "[ ] " : ""),
      src: "",
      line: undefined,
      children: [],
  };
  const parent = findInList(copy, cloned);
  parent.list.splice(parent.idx + 1, 0, next);
  const src = listSrcFromItems(copy);
  let caret = 0;
  let first = true;
  const locate = (items) => {
    for (const it of items) {
      if (!first) caret += (it._before ?? "\n").length;
      first = false;
      if (it === next) return true;
      caret += listItemSrc(it).length;
      if (locate(it.children)) return true;
    }
    return false;
  };
  locate(copy);
  return { kind: "stay", block: { ...block, items: copy, src }, offset: caret + next.prefix.length };
}

function nextOrderedMarker(marker) {
  const m = /^(\d+)([.)])$/.exec(marker);
  if (!m) return marker;
  return String(Number(m[1]) + 1) + m[2];
}

function itemLineLen(it) {
  return listItemSrc(it).length;
}

// exact source line of an item (prefix + text); prefix kept exact when the
// item came from parsing, reconstructed otherwise
export function listItemSrc(it) {
  if (it.prefix != null) return it.prefix + (it.text ?? "");
  const indent = " ".repeat(Math.max(0, it.indent || 0));
  const taskPart = it.task ? (it.task.checked ? "[x] " : "[ ] ") : "";
  return indent + it.marker + " " + taskPart + (it.text ?? "");
}

function appendItem(block, refItem, keepTask, text = "") {
  const newMarker = refItem.ordered ? nextOrderedMarker(refItem.marker) : refItem.marker;
  return rebuildList(block, (list) => insertItemAfter(list, refItem, {
    indent: refItem.indent,
    marker: newMarker,
    ordered: refItem.ordered,
    text,
    task: keepTask ? (refItem.task ? { checked: refItem.task.checked } : null) : null,
    prefix: " ".repeat(Math.max(0, refItem.indent || 0)) + newMarker + " " +
      (keepTask && refItem.task ? (refItem.task.checked ? "[x] " : "[ ] ") : ""),
    src: "",
    line: "",
    children: [],
  }), 0, /*caretAt*/ -1);
}

function removeItem(block, item) {
  const remaining = countItems(block.items) - 1;
  if (remaining <= 0) {
    // list becomes empty → plain empty paragraph
    return { kind: "split", left: { type: "paragraph", src: "", text: "" }, right: null, popped: true };
  }
  const newItems = removeItemFromList(block.items, item);
  const src = listSrcFromItems(newItems);
  return { kind: "split", left: { ...block, items: newItems, src }, right: null, popped: true };
}

function countItems(items) {
  let n = 0;
  for (const it of items) { n += 1 + (it.children.length ? countItems(it.children) : 0); }
  return n;
}

function splitQuote(block, offset) {
  // Map offset over the inner blocks (each line gets a "> " prefix in src).
  let pos = 0;
  for (let bi = 0; bi < block.items.length; bi++) {
    const b = block.items[bi];
    const lines = b.src.split("\n");
    const lineLens = lines.map((l) => l.length + 2); // "> " prefix
    if (offset <= pos + lineLens.reduce((a, c) => a + c, 0) + (bi > 0 ? 0 : 0)) {
      const rel = offset - pos;
      // split within this inner block at the first line containing rel
      let acc = 0;
      for (let li = 0; li < lines.length; li++) {
        if (rel <= acc + lineLens[li]) {
          const lineRel = rel - acc - 2; // strip "> "
          const res = splitBlock(b, lineRel);
          if (res.kind === "split") {
            const newItems = [...block.items];
            newItems.splice(bi, 1, res.left, res.right);
            return { kind: "split", left: { ...block, items: newItems.slice(0, bi + 1), src: quoteSrc(newItems.slice(0, bi + 1)) }, right: { type: "quote", items: newItems.slice(bi + 1), src: quoteSrc(newItems.slice(bi + 1)) } };
          }
          if (res.kind === "stay") {
            const newItems = [...block.items];
            newItems[bi] = res.block;
            return { kind: "stay", block: { ...block, items: newItems, src: quoteSrc(newItems) }, offset: res.offset };
          }
          if (res.kind === "after") {
            const newItems = [...block.items];
            newItems.splice(bi + 1, 0, res.newBlock);
            return { kind: "after", block: { ...block, items: newItems, src: quoteSrc(newItems) }, offset: 2 };
          }
          return { kind: "none" };
        }
        acc += lineLens[li] + 1; // "\n"
      }
    }
    pos += lineLens.reduce((a, c) => a + c, 0) + 1; // +1 for "\n"
  }
  return { kind: "none" };
}

// Inner blocks keep their parsed separators; new ones get a blank line.
function quoteSrc(items) {
  return items.map((b, i) => (i ? (b._before === "\n" ? "\n" : "\n\n") : "") + b.src.split("\n").map((l) => (l === "" ? ">" : "> " + l)).join("\n")).join("");
}

// ---- list tree mutation helpers (immutable) ----

function cloneItem(it) {
  return { ...it, task: it.task ? { ...it.task } : null, children: it.children.map(cloneItem) };
}

function findInList(items, target) {
  for (const it of items) {
    if (it === target) return { list: items, idx: items.indexOf(it), item: it };
    if (it.children.length) {
      const r = findInList(it.children, target);
      if (r) return r;
    }
  }
  return null;
}

function mutateItem(rootItems, target, fn) {
  const r = findInList(rootItems, target);
  if (!r) return rootItems;
  const list = r.list;
  const copy = list.map((it) => cloneItem(it));
  const cloned = walkCopy(list, target, copy);
  if (!cloned) return rootItems;
  fn(cloned);
  return copy;
}

function walkCopy(orig, target, copy) {
  for (let i = 0; i < orig.length; i++) {
    if (orig[i] === target) return copy[i];
    if (orig[i].children.length) {
      const r = walkCopy(orig[i].children, target, copy[i].children);
      if (r) return r;
    }
  }
  return null;
}

function insertItemAfter(rootItems, target, newItem) {
  const r = findInList(rootItems, target);
  if (!r) return rootItems;
  const copy = rootItems.map(cloneItem);
  const cloned = walkCopy(rootItems, target, copy);
  const parent = findInList(copy, cloned);
  parent.list.splice(parent.idx + 1, 0, cloneItem(newItem));
  return copy;
}

function removeItemFromList(rootItems, target) {
  const r = findInList(rootItems, target);
  if (!r) return rootItems;
  const copy = rootItems.map(cloneItem);
  const cloned = walkCopy(rootItems, target, copy);
  const parent = findInList(copy, cloned);
  parent.list.splice(parent.idx, 1);
  return copy;
}

function rebuildList(block, mutate, offset, caretAt) {
  const newItems = mutate(block.items);
  const src = listSrcFromItems(newItems);
  return { kind: "split", left: { ...block, items: newItems, src }, right: null, offset: caretAt === -1 ? src.length : offset, popped: false };
}

export function listSrcFromItems(items) { // (exported for renderer walks)
  const lines = [];
  const walk = (list) => {
    for (const it of list) {
      lines.push((lines.length ? it._before ?? "\n" : "") + listItemSrc(it));
      if (it.children.length) walk(it.children);
    }
  };
  walk(items);
  return lines.join("");
}

/**
 * Join a block with the previous one (Backspace at offset 0).
 * Returns {prev, keep: true} where `prev` is the merged block, or
 * {prev, keep: false} when the current block is absorbed differently.
 */
// Join `cur` into `prev` (Backspace at offset 0).
// Returns {prev, leftover}: the merged block and an optional extra block
// to insert after it (usually null).
export function joinWithPrev(prev, cur) {
  const none = { prev: cur, leftover: null };
  const joinText = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    if (a.endsWith("\n")) return a + b;
    return a + " " + b;
  };
  if (!prev) return none;
  if (prev.type === "paragraph" && cur.type === "paragraph") {
    const src = joinText(prev.src, cur.src);
    return { prev: { ...prev, type: "paragraph", src, text: src }, leftover: null };
  }
  if (prev.type === "paragraph" && cur.type === "heading") {
    const src = joinText(prev.src, cur.src);
    return { prev: { type: "paragraph", src, text: src }, leftover: null };
  }
  if (prev.type === "paragraph" && (cur.type === "def_footnote" || cur.type === "toc")) {
    // the definition/TOC line merges into the paragraph as a plain line
    const src = joinText(prev.src, cur.src);
    return { prev: { type: "paragraph", src, text: src }, leftover: null };
  }
  if (prev.type === "paragraph" && cur.type === "list") {
    // absorb the first item into the paragraph; siblings remain a list
    const items = cur.items.map((it) => cloneItem(it));
    const first = items.shift();
    const text = (first.task ? (first.task.checked ? "[x] " : "[ ] ") : "") + (first.text || "");
    const para = { type: "paragraph", src: prev.src + " " + text, text: prev.src + " " + text };
    if (items.length === 0) return { prev: para, leftover: null };
    return { prev: para, leftover: { ...cur, items, src: listSrcFromItems(items) } };
  }
  if (prev.type === "code" && cur.type === "code") {
    return { prev: codeBlock(prev, prev.body + "\n" + cur.body, prev.closed), leftover: null };
  }
  if (prev.type === "code" && cur.type !== "code") {
    return { prev: codeBlock(prev, prev.body + "\n" + cur.src, prev.closed), leftover: null };
  }
  if (prev.type === "heading" && cur.type === "paragraph") {
    return { prev: { type: "heading", level: prev.level, src: "#".repeat(prev.level) + " " + prev.text + " " + cur.src, text: prev.text + " " + cur.src }, leftover: null };
  }
  if (prev.type === "quote" && cur.type === "paragraph") {
    const items = [...prev.items, { type: "paragraph", src: cur.src, text: cur.src }];
    return { prev: { type: "quote", items, src: quoteSrc(items) }, leftover: null };
  }
  if (prev.type === "list" && cur.type === "paragraph") {
    const items = blockItems(prev);
    const last = lastItem(items);
    if (last) {
      const newItems = mutateItem(items, last, (it) => { it.text = (it.text ? it.text + " " : "") + cur.src; });
      return { prev: { ...prev, items: newItems, src: listSrcFromItems(newItems) }, leftover: null };
    }
    return none;
  }
  if (prev.type === "list" && cur.type === "list") {
    // one list holds one marker type: the joined items take the first's
    let last = prev.items.at(-1);
    const moved = cur.items.map((it) => {
      const item = cloneItem(it);
      if (listKind(item.marker) !== listKind(last.marker)) {
        const marker = last.ordered ? nextOrderedMarker(last.marker) : last.marker;
        item.prefix = item.prefix?.replace(/^(\s*)([*+-]|\d{1,9}[.)])/, (_, indent) => indent + marker);
        Object.assign(item, { marker, ordered: last.ordered, line: undefined });
      }
      return last = item;
    });
    const all = [...prev.items.map((it) => cloneItem(it)), ...moved];
    return { prev: { ...prev, items: all, src: listSrcFromItems(all) }, leftover: null };
  }
  // Generic fallback: append current source to previous paragraph text.
  if (prev.type === "paragraph") {
    const src = joinText(prev.src, cur.src);
    return { prev: { type: "paragraph", src, text: src }, leftover: null };
  }
  return none;
}

function blockItems(block) {
  return block.items.map((it) => cloneItem(it));
}

function lastItem(items) {
  if (!items.length) return null;
  let it = items[items.length - 1];
  while (it.children.length) it = it.children[it.children.length - 1];
  return it;
}
