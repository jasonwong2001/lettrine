const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const WORD = /[\p{L}\p{N}]/u;
export const hasSmartPunctuation = (settings = {}) => !!(settings.smartQuotes || settings.smartDashes || settings.smartEllipses);
export const rendersSmartPunctuation = (settings = {}) => hasSmartPunctuation(settings) && settings.smartPunctuationMode !== "input";

function quoteGlyph(quote, before, after) {
  const previous = before.at(-1) || "", next = after[0] || "";
  const opening = quote === '"' ? "\u201c" : "\u2018", closing = quote === '"' ? "\u201d" : "\u2019";
  if (quote === "'" && (WORD.test(previous) && WORD.test(next) || /^(?:\d{2}s\b|tis\b|twas\b|em\b|cause\b)/i.test(after))) return closing;
  const raw = before.replace(/\\./g, "").replace(/(\p{L})'(?=\p{L})/gu, "$1");
  let depth = 0;
  for (const ch of raw) {
    if (ch === opening) depth++;
    else if (ch === closing) depth = Math.max(0, depth - 1);
    else if (ch === quote) depth = depth ? depth - 1 : depth + 1;
  }
  const unclosed = depth > 0;
  if (unclosed && previous && !/\s/.test(previous)) return closing;
  return !previous || /[\s([{<\u2014\u2013\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f]/.test(previous) || CJK.test(previous) ? opening : closing;
}

// Changed parts retain both spellings, allowing a display-only replacement
// to keep the original Markdown in a hidden source span.
export function punctuationParts(text, settings = {}, before = "", after = "") {
  if (!hasSmartPunctuation(settings)) return [{ src: text, value: text }];
  const parts = [];
  let rendered = "";
  for (let i = 0; i < text.length;) {
    let length = 1, value = text[i];
    if (text[i] === "\\" && i + 1 < text.length) {
      length = 2; value = text.slice(i, i + 2);
    } else if (settings.smartDashes && text.startsWith("---", i)) { length = 3; value = "\u2014"; }
    else if (settings.smartDashes && text.startsWith("--", i)) { length = 2; value = "\u2013"; }
    else if (settings.smartEllipses && text.startsWith("...", i)) { length = 3; value = "\u2026"; }
    else if (settings.smartQuotes && /["']/.test(text[i])) value = quoteGlyph(text[i], before + rendered, text.slice(i + 1) + after);
    const src = text.slice(i, i + length), previous = parts.at(-1);
    if (src === value && previous && previous.src === previous.value) { previous.src += src; previous.value += value; }
    else parts.push({ src, value });
    rendered += value; i += length;
  }
  return parts;
}

export const smartPunctuation = (text, settings, before = "", after = "") => punctuationParts(text, settings, before, after).map((part) => part.value).join("");

// Restrict input conversion to the just-entered punctuation. Existing source
// elsewhere in the document is never reformatted by enabling the setting.
export function punctuationInputEdit(text, caret, settings = {}) {
  if (!hasSmartPunctuation(settings) || settings.smartPunctuationMode !== "input" || caret <= 0) return null;
  const prefix = text.slice(0, caret), last = prefix.at(-1);
  if (/\]\([^)\n]*$|<(?:!|\/?[A-Za-z])[^>\n]*$/.test(prefix)) return null;
  const syntax = prefix.replace(/\\./g, "");
  if ((syntax.match(/\$/g)?.length || 0) % 2) return null;
  let code = "";
  for (const marker of syntax.match(/`+/g) || []) {
    if (!code) code = marker;
    else if (marker === code) code = "";
  }
  if (code) return null;
  let length = 1, value = last;
  if (last === "-" && settings.smartDashes && !/^-{1,3}$/.test(prefix.trim())) {
    if (prefix.endsWith("\u2013-") || prefix.endsWith("---")) { length = prefix.endsWith("\u2013-") ? 2 : 3; value = "\u2014"; }
    else if (prefix.endsWith("--")) { length = 2; value = "\u2013"; }
  } else if (last === "." && settings.smartEllipses && prefix.endsWith("...")) { length = 3; value = "\u2026"; }
  else if (settings.smartQuotes && /["']/.test(last) && (prefix.slice(0, -1).match(/\\+$/)?.[0].length || 0) % 2 === 0) value = quoteGlyph(last, prefix.slice(0, -1), text.slice(caret));
  if ((prefix.slice(0, -length).match(/\\+$/)?.[0].length || 0) % 2) return null;
  return value === prefix.slice(-length) ? null : { start: caret - length, end: caret, text: value };
}
