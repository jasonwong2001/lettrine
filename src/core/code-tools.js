import { parseBlocks } from "./blocks.js";
import { DIAGRAM_LANGUAGES } from "./diagrams.js";

export const CODE_MODES = {
  js: "javascript", javascript: "javascript", jsx: "jsx",
  py: "python", python: "python",
  c: "text/x-csrc", cpp: "text/x-c++src", "c++": "text/x-c++src", java: "text/x-java", cs: "text/x-csharp", csharp: "text/x-csharp",
  kotlin: "text/x-kotlin", scala: "text/x-scala", swift: "swift",
  html: "htmlmixed", xml: "xml", css: "css", sql: "sql", php: "php",
  json: { name: "javascript", json: true }, ts: { name: "javascript", typescript: true }, typescript: { name: "javascript", typescript: true },
  sh: "shell", bash: "shell", shell: "shell", yml: "yaml", yaml: "yaml", go: "go", rust: "rust", ruby: "ruby", rb: "ruby", diff: "diff", toml: "toml", markdown: "gfm", md: "gfm", math: "stex",
};
export const CODE_LANGUAGES = [...new Set([...Object.keys(CODE_MODES), ...DIAGRAM_LANGUAGES, "text"])].sort();
export const codeModeOf = (info) => CODE_MODES[String(info || "").trim().split(/\s/)[0].toLowerCase()] || null;
export const sanitizeCodeLanguage = (language) => String(language || "").replace(/[\r\n`~]/g, "").trim().slice(0, 80);
export const newCodeLanguage = (settings = {}, previous = "") => sanitizeCodeLanguage(settings.defaultCodeLanguage || previous);
const size = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.max(1, Math.min(16, Math.round(Number(value)))) : fallback;
export function codeOptions(settings = {}) {
  const tabSize = size(settings.tabSize, 4);
  return { tabSize, indentUnit: size(settings.codeIndentSize, tabSize), indentWithTabs: !!settings.indentWithTabs };
}
export function codeLanguageMatches(query) {
  const prefix = String(query).toLowerCase();
  return CODE_LANGUAGES.filter((language) => language.startsWith(prefix)).slice(0, 10);
}

export function codeRanges(source) {
  let offset = 0;
  return parseBlocks(source).flatMap((block, index) => {
    offset += (block._leading || block._before || "").length;
    const start = offset; offset += block.src.length;
    if (block.type !== "code" || !block.src.includes("\n")) return [];
    const bodyStart = start + block.src.indexOf("\n") + 1;
    return [{ index, block, start, end: offset, bodyStart, bodyEnd: bodyStart + block.body.length }];
  });
}

export function selectedCodeLines(text, start, end) {
  const from = Math.max(0, Math.min(text.length, start)), to = Math.max(from, Math.min(text.length, end));
  const first = text.slice(0, from).split("\n").length - 1;
  const last = text.slice(0, Math.max(from, to > from && text[to - 1] === "\n" ? to - 1 : to)).split("\n").length - 1;
  return { first, last };
}

function tokensFor(CM, mode, state, text, tabSize, lines, line) {
  const stream = new CM.StringStream(text, tabSize, { lookAhead: (n) => lines[line + n], baseToken() {} }), tokens = [];
  if (!text && mode.blankLine) mode.blankLine(state);
  while (!stream.eol()) {
    const type = mode.token(stream, state) || "";
    if (stream.pos <= stream.start) stream.pos++;
    tokens.push({ start: stream.start, end: stream.pos, type });
    stream.start = stream.pos;
  }
  return tokens;
}

const literalToken = (token) => /(?:^|\s)(?:string(?:-\d+)?|comment)(?:$|\s)/.test(token?.type || "");
const indentation = (columns, options) => options.indentWithTabs
  ? "\t".repeat(Math.floor(columns / options.tabSize)) + " ".repeat(columns % options.tabSize) : " ".repeat(columns);

// Formatting only changes line-edge whitespace. Tokenized literals and comments
// retain their bytes; Python indentation keeps its original block relationships.
export function formatCodeBody(CM, body, info, settings = {}, { first = 0, last = Infinity, prettify = false } = {}) {
  const language = String(info || "").trim().split(/\s/)[0].toLowerCase(), spec = codeModeOf(language);
  if (!spec || ["html", "xml", "markdown", "md", "diff", "yaml", "yml", "math"].includes(language)) return body;
  const options = codeOptions(settings), mode = CM.getMode(options, spec), lines = body.split("\n");
  const wholeBody = first <= 0 && last >= lines.length - 1;
  let state = CM.startState(mode);
  const original = lines.map((line, index) => {
    const before = CM.copyState(mode, state), tokens = tokensFor(CM, mode, state, line, options.tabSize, lines, index);
    const prefix = /^[ \t]*/.exec(line)[0];
    const continued = !prefix && literalToken(tokens[0]) ? tokensFor(CM, mode, CM.copyState(mode, before), " ", options.tabSize, lines, index)[0] : null;
    const protectedStart = literalToken(tokens[0]) && (prefix.length > 0 || literalToken(continued));
    return { before, tokens, prefix, protectedStart };
  });
  const python = ["python", "py"].includes(language);
  const columns = (prefix) => CM.countColumn(prefix, null, python ? 8 : options.tabSize);
  const levels = [...new Set([0, ...original.flatMap((entry, index) => {
    const scope = entry.before.scopes?.at(-1);
    return python && lines[index].trim() && !entry.protectedStart && (!scope || scope.type === "py") ? [columns(entry.prefix)] : [];
  })])].sort((a, b) => a - b);
  state = CM.startState(mode);
  return lines.map((line, index) => {
    const entry = original[index], { prefix, protectedStart } = entry;
    let next = line;
    if (index >= first && index <= last) {
      const content = line.slice(prefix.length);
      let desired = null;
      if (!protectedStart && content) {
        if (python && wholeBody) {
          const scope = entry.before.scopes?.at(-1);
          if ((!scope || scope.type === "py") && !/\\[ \t]*$/.test(lines[index - 1] || "")) desired = levels.indexOf(columns(prefix)) * options.indentUnit;
        } else if (!python && mode.indent) {
          const value = mode.indent(state, content, line);
          if (typeof value === "number" && value >= 0 && value <= 1000) desired = value;
        }
      }
      if (desired !== null && desired >= 0) next = indentation(desired, options) + content;
      const trailing = /[ \t]+$/.exec(line), trailingStart = trailing?.index;
      if (prettify && trailing && !/\\[ \t]+$/.test(line) && !entry.tokens.some((token) => token.end > trailingStart && literalToken(token))) next = next.replace(/[ \t]+$/, "");
    }
    tokensFor(CM, mode, state, next, options.tabSize, lines, index);
    return next;
  }).join("\n");
}

export function codeFormatEdits(CM, source, selection, settings, action = "prettify", scope = "selection") {
  return codeRanges(source).flatMap((range) => {
    const collapsed = selection.start === selection.end;
    if (collapsed ? selection.start < range.start || selection.start > range.end : selection.end <= range.start || selection.start >= range.end) return [];
    const { block } = range;
    const lines = scope === "whole" || collapsed && action === "prettify" ? {} : selectedCodeLines(block.body, selection.start - range.bodyStart, selection.end - range.bodyStart);
    const after = formatCodeBody(CM, block.body, block.info, settings, { ...lines, prettify: action === "prettify" });
    return after === block.body ? [] : [{ ...range, before: block.body, after }];
  });
}

export function applyCodeEdits(source, edits) {
  let result = source;
  for (const edit of edits.slice().sort((a, b) => b.bodyStart - a.bodyStart)) result = result.slice(0, edit.bodyStart) + edit.after + result.slice(edit.bodyEnd);
  return result;
}

export function codeSelectionAfter(source, edits, selection) {
  const changes = [];
  for (const edit of edits) {
    let offset = edit.bodyStart;
    const before = edit.before.split("\n"), after = edit.after.split("\n");
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        const oldPrefix = /^[ \t]*/.exec(before[i])[0], newPrefix = /^[ \t]*/.exec(after[i])[0];
        if (oldPrefix !== newPrefix) changes.push({ start: offset, removeLength: oldPrefix.length, inserted: newPrefix });
        if (before[i].slice(oldPrefix.length)) {
          const trailing = /[ \t]+$/.exec(before[i]);
          if (trailing && !/[ \t]$/.test(after[i])) changes.push({ start: offset + trailing.index, removeLength: trailing[0].length, inserted: "" });
        }
      }
      offset += before[i].length + 1;
    }
  }
  const map = (position) => {
    let delta = 0;
    for (const change of changes) {
      if (position < change.start) break;
      if (position < change.start + change.removeLength) return change.start + delta + Math.min(position - change.start, change.inserted.length);
      delta += change.inserted.length - change.removeLength;
    }
    return position + delta;
  };
  return { ...selection, start: map(selection.start), end: map(selection.end) };
}
