// Inline markdown parser for the Lettrine live-preview editor.
//
// The parser is source-preserving: every matched segment keeps its full
// source text (`src`), including the delimiters, so the rendered DOM can
// hide the delimiter spans (live preview) while `textContent` of the block
// still reconstructs the exact markdown source.
//
// Segment types:
//   text      {type:'text', src}
//   escape    {type:'escape', src:'\\x', char:'x'}
//   code      {type:'code', src, inner}
//   bold      {type:'bold', src, marker, inner:[segments]}
//   italic    {type:'italic', src, marker, inner:[segments]}
//   strike    {type:'strike', src, inner:[segments]}
//   highlight {type:'highlight', src, inner:[segments]}
//   underline {type:'underline', src, open, close, inner}
//   subscript/superscript {type, src, marker, inner} (opt-in)
//   link      {type:'link', src, inner:[segments], url, title}
//   image     {type:'image', src, alt, url, title}
//   autolink  {type:'autolink', src, url}
//   math      {type:'math', src, tex}
//   emoji     {type:'emoji', src, char}
//   footnote  {type:'footnote', src, ref}
//
// Anything that does not match a complete syntax stays a `text` segment,
// which is how unfinished markers remain visible while typing.

import { completeEmoji } from "./emoji.js";
import { punctuationParts, rendersSmartPunctuation } from "./typography.js";
import { parseImageTag } from "./image-tag.js";

const ESCAPABLE = /[\\`*_{}\[\]()#+\-.!$~><|"']/;

function isWordChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/**
 * Find the closing `]` for a link/image opened at `openIdx` (pointing at `[`).
 * Returns the index of `]` or -1.
 */
function findCloseBracket(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    } else if (ch === "\n") return -1;
  }
  return -1;
}

/**
 * Parse a destination `(url "title")` starting at `i` (pointing at `(`).
 * Returns {end, url, title} or null. `end` is the index just past `)`.
 */
function parseDestination(src, i) {
  if (src[i] !== "(") return null;
  let j = i + 1;
  while (/[ \t]/.test(src[j] || "x")) j++;
  let urlStart = j, urlEnd, urlEncoding = "markdown";
  let url = "";
  if (src[j] === "<") {
    j++; urlStart = j; urlEncoding = "angle";
    while (j < src.length && src[j] !== ">" && src[j] !== "\n") {
      if (src[j] === "\\" && j + 1 < src.length) j++;
      url += src[j++];
    }
    urlEnd = j;
    if (src[j++] !== ">") return null;
  } else {
    let depth = 0;
    while (j < src.length) {
      const char = src[j];
      if (char === "\n" || /[ \t]/.test(char) && depth === 0 || char === ")" && depth === 0) break;
      if (char === "\\" && j + 1 < src.length) { url += src[j + 1]; j += 2; continue; }
      if (char === "(") depth++;
      if (char === ")") depth--;
      url += char;
      j++;
    }
    if (depth) return null;
    urlEnd = j;
  }
  while (/[ \t]/.test(src[j] || "x")) j++;
  let title = null;
  if (src[j] === '"' || src[j] === "'") {
    const quote = src[j++];
    title = "";
    while (j < src.length && src[j] !== quote && src[j] !== "\n") {
      if (src[j] === "\\" && j + 1 < src.length) j++;
      title += src[j++];
    }
    if (src[j++] !== quote) return null;
    while (/[ \t]/.test(src[j] || "x")) j++;
  }
  return src[j] === ")" ? { end: j + 1, url, title, urlStart, urlEnd, urlEncoding } : null;
}

function parseEmojiAt(src, i) {
  if (src[i] !== ":") return null;
  const m = /^:([a-z0-9_+-]+):/i.exec(src.slice(i));
  if (!m) return null;
  const char = completeEmoji(m[1]);
  if (char === null) return null;
  // Require a boundary after the closing colon (not another word char).
  const after = src[i + m[0].length];
  if (after !== undefined && /[a-z0-9_]/i.test(after)) return null;
  return { type: "emoji", src: m[0], char };
}

function parseMathAt(src, i) {
  // \( ... \)
  if (src[i] === "\\" && src[i + 1] === "(") {
    const close = src.indexOf("\\)", i + 2);
    if (close !== -1) {
      return { type: "math", src: src.slice(i, close + 2), tex: src.slice(i + 2, close) };
    }
    return null;
  }
  if (src[i] !== "$") return null;
  // inline $math$: non-empty, no spaces adjacent to $, no newline
  if (src[i + 1] === undefined || src[i + 1] === " " || src[i + 1] === "\n") return null;
  if (src[i + 1] === "$") return null; // block math is handled by block parser
  const close = src.indexOf("$", i + 1);
  if (close === -1) return null;
  const tex = src.slice(i + 1, close);
  if (tex.includes("\n") || tex.length === 0) return null;
  return { type: "math", src: src.slice(i, close + 1), tex };
}

function parseCodeAt(src, i) {
  if (src[i] !== "`") return null;
  let n = 0;
  while (src[i + n] === "`") n++;
  const marker = "`".repeat(n);
  let j = i + n;
  while (j < src.length) {
    const idx = src.indexOf(marker, j);
    if (idx === -1) return null;
    const inner = src.slice(i + n, idx);
    if (n === 1 && inner.includes("`")) { j = idx + 1; continue; }
    if (inner.length === 0) { j = idx + 1; continue; }
    return { type: "code", src: src.slice(i, idx + n), inner };
  }
  return null;
}

function parseDelimitedAt(src, i, open, close, minInner = 1) {
  if (!src.startsWith(open, i)) return null;
  if (open.length === 1 && (src[i - 1] === open || src[i + 1] === open)) return null;
  let j = i + open.length;
  while (j < src.length) {
    let idx = src.indexOf(close, j);
    if (idx === -1) return null;
    if (open.length === 2 && (open === "**" || open === "__") && src[i + open.length] === open[0] && src[idx + close.length] === open[0]) idx++;
    const escaped = (src.slice(0, idx).match(/\\+$/)?.[0].length || 0) % 2;
    if (escaped || ["*", "_", "**", "__"].includes(open) && isWordChar(src[idx + close.length])) { j = idx + 1; continue; }
    const inner = src.slice(i + open.length, idx);
    if (inner.length >= minInner && !inner.startsWith("\n") && !inner.endsWith("\n")) {
      if (!(open === "**" || open === "__") || idx > i + open.length) {
        return {
          type: open === "**" ? "bold" : open === "__" ? "bold"
            : open === "*" ? "italic" : open === "_" ? "italic"
            : open === "~~" ? "strike" : "highlight",
          src: src.slice(i, idx + close.length),
          marker: open,
          inner: inner,
        };
      }
    }
    j = idx + 1;
  }
  return null;
}

function parseScriptAt(src, i, marker) {
  if (src[i - 1] === marker || src[i + 1] === marker) return null;
  for (let j = i + 1; j < src.length; j++) {
    const literal = src[j] === "`" ? parseCodeAt(src, j) : src[j] === "$" || src[j] === "\\" ? parseMathAt(src, j)
      : src[j] === "[" ? parseFootnoteAt(src, j) ?? parseLinkAt(src, j) : src[j] === "<" ? parseUnderlineAt(src, j) ?? parseUnderlineAt(src, j, "sub") ?? parseUnderlineAt(src, j, "sup") : null;
    if (literal) { j += literal.src.length - 1; continue; }
    if (src[j] === "\\") { j++; continue; }
    if (/\s/.test(src[j])) return null;
    if (src[j] !== marker || src[j - 1] === marker || src[j + 1] === marker) continue;
    if (j === i + 1) return null;
    return { type: marker === "~" ? "subscript" : "superscript", src: src.slice(i, j + 1), marker, inner: src.slice(i + 1, j) };
  }
  return null;
}

function parseFootnoteAt(src, i) {
  // footnote reference [^ref] (our inline rule /\[\^([^\]\n]+)\]/)
  if (src[i] !== "[" || src[i + 1] !== "^") return null;
  let j = i + 2;
  while (j < src.length && src[j] !== "]" && src[j] !== "\n") j++;
  if (j <= i + 2 || j >= src.length || src[j] !== "]") return null;
  return { type: "footnote", src: src.slice(i, j + 1), ref: src.slice(i + 2, j) };
}

function parseUnderlineAt(src, i, name = "u") {
  const open = new RegExp("^<" + name + ">", "i").exec(src.slice(i));
  if (!open) return null;
  let depth = 1;
  for (let j = i + open[0].length; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "`") {
      const code = parseCodeAt(src, j);
      if (code) { j += code.src.length - 1; continue; }
    }
    const tag = new RegExp("^</?" + name + ">", "i").exec(src.slice(j));
    if (!tag) continue;
    depth += tag[0][1] === "/" ? -1 : 1;
    if (!depth) {
      const inner = src.slice(i + open[0].length, j);
      return inner ? { type: name === "u" ? "underline" : name === "sub" ? "subscript" : "superscript", src: src.slice(i, j + tag[0].length), open: open[0], close: tag[0], inner } : null;
    }
    j += tag[0].length - 1;
  }
  return null;
}

function parseLinkAt(src, i) {
  if (src[i] !== "[" ) return null;
  const close = findCloseBracket(src, i);
  if (close === -1) return null;
  if (close + 1 >= src.length || src[close + 1] !== "(") return null;
  const dest = parseDestination(src, close + 1);
  if (!dest) return null;
  const inner = src.slice(i + 1, close);
  const seg = { type: "link", src: src.slice(i, dest.end), inner, url: dest.url, title: dest.title,
    urlStart: dest.urlStart - i, urlEnd: dest.urlEnd - i, urlEncoding: dest.urlEncoding };
  return seg;
}

function parseImageAt(src, i) {
  if (src[i] !== "!" || src[i + 1] !== "[") return null;
  const link = parseLinkAt(src, i + 1);
  if (!link) return null;
  return {
    type: "image",
    src: "!" + link.src,
    alt: link.inner,
    url: link.url,
    title: link.title,
    urlStart: link.urlStart + 1, urlEnd: link.urlEnd + 1, urlEncoding: link.urlEncoding,
  };
}

const AUTOLINK_RE = /^(https?:\/\/[^\s<>()]*[^\s<>()\.,;:!?'">\u0000-\u001F])/i;

/**
 * Parse inline markdown into source-preserving segments.
 * @param {string} src
 * @returns {Array<object>}
 */
export function parseInline(src, settings = {}) {
  const out = [];
  let i = 0;
  let buf = "";

  const flush = () => {
    if (buf) { out.push({ type: "text", src: buf }); buf = ""; }
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === "\n") {
      const hard = / {2,}$/.exec(buf)?.[0] || (buf.endsWith("\\") ? "\\" : "");
      if (hard) { buf = buf.slice(0, -hard.length); flush(); out.push({ type: "hardBreak", src: hard + "\n" }); }
      else buf += ch;
      i++; continue;
    }
    if (ch === "\\" && src[i + 1] === "(") {
      const math = parseMathAt(src, i);
      if (math) { flush(); out.push(math); i += math.src.length; continue; }
    }
    if (ch === "\\" && i + 1 < src.length && (ESCAPABLE.test(src[i + 1]) || settings.subscriptSuperscript && src[i + 1] === "^" || settings._script && /[ \t]/.test(src[i + 1]))) {
      flush();
      out.push({ type: "escape", src: "\\" + src[i + 1], char: src[i + 1] });
      i += 2;
      continue;
    }
    let seg = null;
    if (ch === "!") seg = parseImageAt(src, i);
    else if (ch === "[") seg = parseFootnoteAt(src, i) ?? parseLinkAt(src, i);
    else if (ch === "`") seg = parseCodeAt(src, i);
    else if (ch === "$" || ch === "\\") seg = parseMathAt(src, i);
    else if (ch === ":") seg = parseEmojiAt(src, i);
    else if (ch === "<") {
      const br = /^<br\s*\/?>/i.exec(src.slice(i));
      seg = br ? { type: "htmlBreak", src: br[0] } : parseImageTag(src, i) ?? parseUnderlineAt(src, i)
        ?? (settings.subscriptSuperscript ? parseUnderlineAt(src, i, "sub") ?? parseUnderlineAt(src, i, "sup") : null);
    }
    else if (ch === "*") {
      seg = parseDelimitedAt(src, i, "**", "**")
        ?? parseDelimitedAt(src, i, "*", "*", 1);
    } else if (ch === "_") {
      seg = parseDelimitedAt(src, i, "__", "__")
        ?? (isWordChar(src[i - 1]) ? null : parseDelimitedAt(src, i, "_", "_", 1));
    } else if (ch === "~") {
      seg = parseDelimitedAt(src, i, "~~", "~~", 1)
        ?? (settings.subscriptSuperscript ? parseScriptAt(src, i, "~") : null);
    } else if (ch === "^" && settings.subscriptSuperscript) {
      seg = parseScriptAt(src, i, "^");
    } else if (ch === "=") {
      seg = parseDelimitedAt(src, i, "==", "==", 1);
    }
    if (!seg) {
      // autolink attempt (http, https, www)
      if (ch === "w" && /^www\.[^\s<>()]+/i.test(src.slice(i))) {
        const url = src.slice(i).match(/^www\.[^\s<>()]+/i)[0];
        seg = { type: "autolink", src: url, url: "https://" + url };
      } else {
        const m = AUTOLINK_RE.exec(src.slice(i));
        if (m) seg = { type: "autolink", src: m[0], url: m[0] };
      }
    }
    if (seg) {
      flush();
      out.push(seg);
      i += seg.src.length;
    } else {
      buf += ch;
      i++;
    }
  }
  flush();
  return out;
}

/**
 * Recursively render segments to an HTML string, using our DOM
 * vocabulary (in the editor):
 *
 *   - complete syntax markers live in <span class="md-attr">…</span>
 *     (hidden by base.css: `.md-attr { display:none }`)
 *   - non-source decorations (rendered math, <img>, emoji glyph) carry
 *     class "md-decor" and are excluded from source reconstruction
 *   - elements: strong/em/s/mark, code, a, .md-image, .md-inline-math,
 *     .md-emoji (data-emoji), .md-emoji-control-ch
 */
export function segmentsToHtml(segments, htmlEscape = escapeHtml, settings = {}) {
  const M = (t) => `<span class="md-attr">${htmlEscape(t)}</span>`;
  return segments.map((seg, index) => {
    switch (seg.type) {
      case "text":
        if (!rendersSmartPunctuation(settings)) return htmlEscape(seg.src);
        return punctuationParts(seg.src, settings, segments.slice(0, index).map((s) => s.src).join(""), segments.slice(index + 1).map((s) => s.src).join("")).map(({ src, value }) =>
          src === value ? htmlEscape(src) : `<span class="md-smart"><span class="md-attr md-smart-source">${htmlEscape(src)}</span><span class="md-decor">${htmlEscape(value)}</span></span>`).join("");
      case "escape":
        return `<span class="md-escape">${M("\\")}${htmlEscape(seg.char)}</span>`;
      case "code": {
        const b = "`".repeat(backtickWidth(seg));
        return `<code>${M(b)}${htmlEscape(seg.inner)}${M(b)}</code>`;
      }
      case "bold":
        return `<strong>${M(seg.marker)}${inlineInnerHtml(seg.inner, htmlEscape, settings)}${M(seg.marker)}</strong>`;
      case "italic":
        return `<em>${M(seg.marker)}${inlineInnerHtml(seg.inner, htmlEscape, settings)}${M(seg.marker)}</em>`;
      case "strike":
        return `<s>${M(seg.marker)}${inlineInnerHtml(seg.inner, htmlEscape, settings)}${M(seg.marker)}</s>`;
      case "highlight":
        return `<mark>${M(seg.marker)}${inlineInnerHtml(seg.inner, htmlEscape, settings)}${M(seg.marker)}</mark>`;
      case "underline":
        return `<u>${M(seg.open)}${inlineInnerHtml(seg.inner, htmlEscape, settings)}${M(seg.close)}</u>`;
      case "subscript":
      case "superscript": {
        const tag = seg.type === "subscript" ? "sub" : "sup";
        return `<${tag}>${M(seg.open || seg.marker)}${inlineInnerHtml(seg.inner, htmlEscape, { ...settings, _script: !!seg.marker })}${M(seg.close || seg.marker)}</${tag}>`;
      }
      case "link": {
        const t = seg.title != null ? ` "${seg.title}"` : "";
        return `<a href="${htmlEscape(seg.url)}" class="md-link" data-url="${htmlEscape(seg.url)}">${M("[")}${inlineInnerHtml(seg.inner, htmlEscape, settings)}${M(seg.src.slice(1 + seg.inner.length))}</a>`;
      }
      case "image": {
        if (seg.syntax === "html") return `<span class="md-image" data-url="${htmlEscape(seg.url)}" data-alt="${htmlEscape(seg.alt)}" data-zoom="${seg.zoom}"${seg.width ? ` data-width="${seg.width}"` : ""}${seg.height ? ` data-height="${seg.height}"` : ""}>${M(seg.src)}<span class="md-plain md-decor">${htmlEscape(seg.alt)}</span><img class="md-decor" alt="" src=""></span>`;
        const t = seg.title != null ? ` "${seg.title}"` : "";
        return `<span class="md-image" data-url="${htmlEscape(seg.url)}" data-alt="${htmlEscape(seg.alt)}">${M("![")}<span class="md-plain">${inlineInnerHtml(seg.alt, htmlEscape)}</span>${M(seg.src.slice(2 + seg.alt.length))}<img class="md-decor" alt="" src=""></span>`;
      }
      case "autolink":
        return `<a href="${htmlEscape(seg.url)}" target="_blank" rel="noreferrer" class="url">${seg.src.startsWith("<") ? M("<") + htmlEscape(seg.src.slice(1, -1)) + M(">") : htmlEscape(seg.src)}</a>`;
      case "hardBreak":
        return `${M(seg.src)}<br class="md-decor">`;
      case "htmlBreak":
        return `<span class="md-html-br">${htmlEscape(seg.src)}</span><br class="md-decor">`;
      case "footnote": {
        // the marker spans stay in the source walk (they ARE the raw text);
        // the number is .md-decor, shown once the reference is defined
        return `<sup class="md-footnote" data-ref="${htmlEscape(seg.ref.trim().toLowerCase())}">` +
          `<span class="md-fn-marker">[^</span><span class="md-text" spellcheck="false">${htmlEscape(seg.ref)}</span>` +
          `<span class="md-fn-marker">]</span><span class="md-fn-num md-decor"></span></sup>`;
      }
      case "math":
        // raw tex stays in .md-tex-src (source-preserving); CSS hides it once
        // the KaTeX body renders (.md-rendered on .md-inline-math)
        return `<span class="md-inline-math-container"><span class="md-inline-math" data-tex="${htmlEscape(seg.tex)}">${M(seg.src.startsWith("\\(") ? "\\(" : "$")}<span class="md-tex-src">${htmlEscape(seg.tex)}</span>${M(seg.src.startsWith("\\(") ? "\\)" : "$")}<span class="md-math-body md-decor"></span></span></span>`;
      case "emoji":
        return `<span class="md-emoji" data-emoji="${htmlEscape(seg.src)}">${M(seg.src)}<span class="emoji-char md-decor">${htmlEscape(seg.char)}</span></span>`;
      default:
        return htmlEscape(seg.src);
    }
  }).join("");
}

function inlineInnerHtml(src, htmlEscape, settings) {
  // inner may itself contain nested inline syntax (bold/italic etc.)
  return segmentsToHtml(parseInline(src, settings), htmlEscape, settings);
}

function backtickWidth(seg) {
  const m = /^(`+)/.exec(seg.src);
  return m ? m[1].length : 1;
}

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
