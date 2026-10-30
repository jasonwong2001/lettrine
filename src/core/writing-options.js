export const defaultExtension = (settings = {}) => /^[a-z0-9]{1,16}$/i.test(settings.defaultExtension || "") ? settings.defaultExtension.toLowerCase() : "md";
export const saveLineEnding = (settings, detected, override) => (override === "preserve" ? detected : override || settings.lineEndings || detected) || "LF";

// Remember generated heading/quote spacing so repeated markers and the user's
// explicit separator do not add unwanted spaces.
export function markdownPairEdit(source, selection, character, previous = null, language = "") {
  const { start, end } = selection, selected = source.slice(start, end);
  const lineStart = start ? source.lastIndexOf("\n", start - 1) + 1 : 0;
  const before = source.slice(lineStart, start), after = source.slice(end);
  if ((source.slice(0, start).match(/\\+$/)?.[0].length || 0) % 2) return null;
  const result = (from, to, text, anchor, head = anchor, pair = null) => ({
    from, to, text, selection: { start: anchor, end: head },
    pair: pair && { ...pair, source: source.slice(0, from) + text + source.slice(to), caret: anchor },
  });
  const active = previous?.source === source && previous.caret === start && start === end ? previous : null;
  if (active?.kind === "prefix" && character === " ") return result(start, end, "", start);
  if (active && character === active.marker && active.kind === "prefix" && (character !== "#" || active.count < 6)) {
    const count = active.count + 1, text = character.repeat(count) + " ";
    return result(active.from, start, text, active.from + text.length, undefined, { ...active, count });
  }
  if (!selected && character === "`" && /^ {0,3}``$/.test(before) && !after.split("\n")[0]) return result(start, end, "`" + language, start + 1 + language.length);
  if (!selected && ["#", ">"].includes(character) && /^ {0,3}$/.test(before) && !after.split("\n")[0].trim()) {
    return result(start, end, character + " ", start + 2, undefined, { kind: "prefix", marker: character, from: start, count: 1 });
  }
  if (!["*", "_", "`", "~"].includes(character)) return null;
  if (!selected && after.startsWith(character) && !(character === "_" && /[\p{L}\p{N}_]/u.test(source[start - 1] || "") && /[\p{L}\p{N}_]/u.test(after[1] || ""))) return result(start, end, "", start + 1);
  if (!selected && character === "~") {
    if (before.endsWith("~") && before.trim() !== "~" && !/[\p{L}\p{N}_~]/u.test(source[start - 2] || "") && (!after || /^\s|^[.,;:!?)]/.test(after))) return result(start - 1, end, "~~~~", start + 1);
    return null;
  }
  if (!selected && (source[start - 1] === character || character === "~" && !before.trim())) return null;
  if (!selected && /[\p{L}\p{N}_]/u.test(source[start - 1] || "")) return null;
  if (!selected && after && !/^[\s.,;:!?，。！？；：)\]}]/u.test(after)) return null;
  const marker = character === "~" ? "~~" : character;
  return result(start, end, marker + selected + marker, start + marker.length, start + marker.length + selected.length,
    selected ? null : { kind: "pair", marker: character, from: start, count: marker.length });
}
