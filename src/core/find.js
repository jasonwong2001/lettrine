export function compileFind({ query, regex = false, caseSensitive = false, wholeWord = false }) {
  if (!query) return null;
  let pattern = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (wholeWord) pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
  return new RegExp(pattern, caseSensitive ? "gu" : "giu");
}
export function findAll(text, expression, limit = 5000) {
  if (!expression) return [];
  const re = new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : expression.flags + "g"), results = [];
  for (let match; (match = re.exec(text)) !== null && results.length < limit;) {
    results.push({ start: match.index, end: match.index + match[0].length, match });
    if (!match[0]) re.lastIndex += text.codePointAt(re.lastIndex) > 0xFFFF ? 2 : 1;
  }
  return results;
}
function replacementText(template, match, text) {
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, code) => {
    if (code === "$") return "$";
    if (code === "&" || code === "0") return match[0];
    if (code === "`") return text.slice(0, match.index);
    if (code === "'") return text.slice(match.index + match[0].length);
    if (code.startsWith("<")) return match.groups ? match.groups[code.slice(1, -1)] || "" : token;
    const index = Number(code);
    if (index < match.length) return match[index] || "";
    const first = Number(code[0]);
    return code.length === 2 && first < match.length ? (match[first] || "") + code[1] : token;
  });
}
export function replaceFind(text, expression, template, index = null) {
  if (!expression) return { text, count: 0, caret: null };
  if (index === null) {
    let count = 0, caret = null, shift = 0;
    const value = text.replace(expression, (...args) => {
      const groups = typeof args.at(-1) === "object" ? args.pop() : undefined;
      args.pop(); const offset = args.pop();
      const match = Object.assign(args, { index: offset, groups });
      const replacement = replacementText(template, match, text);
      caret = offset + shift + replacement.length;
      shift += replacement.length - match[0].length; count++;
      return replacement;
    });
    return { text: value, count, caret };
  }
  const matches = findAll(text, expression);
  const selected = index === null ? matches : matches.slice(Math.max(0, index), Math.max(0, index) + 1);
  let value = text, caret = null;
  for (const item of selected.slice().reverse()) {
    const replacement = replacementText(template, item.match, text);
    value = value.slice(0, item.start) + replacement + value.slice(item.end);
    caret = item.start + replacement.length;
  }
  return { text: value, count: selected.length, caret };
}
