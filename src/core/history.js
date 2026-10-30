// Reversible edits use UTF-16 offsets, matching DOM and CodeMirror selections.
const comparisonSize = 1024;

function copyRange(text, start, end) {
  // Detach stored fragments from the full document's backing string.
  const pieces = [];
  for (let offset = start; offset < end; offset += 4096) {
    pieces.push(text.slice(offset, Math.min(end, offset + 4096)).split("").join(""));
  }
  return pieces.join("");
}

export function textChange(before, after) {
  let start = 0, beforeEnd = before.length, afterEnd = after.length;
  const limit = Math.min(beforeEnd, afterEnd);
  while (start + comparisonSize <= limit && before.slice(start, start + comparisonSize) === after.slice(start, start + comparisonSize)) start += comparisonSize;
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  while (beforeEnd - comparisonSize >= start && afterEnd - comparisonSize >= start && before.slice(beforeEnd - comparisonSize, beforeEnd) === after.slice(afterEnd - comparisonSize, afterEnd)) {
    beforeEnd -= comparisonSize; afterEnd -= comparisonSize;
  }
  while (beforeEnd > start && afterEnd > start && before.charCodeAt(beforeEnd - 1) === after.charCodeAt(afterEnd - 1)) { beforeEnd--; afterEnd--; }
  return { start, removeLength: beforeEnd - start, inserted: copyRange(after, start, afterEnd) };
}

export function applyTextChange(text, change) {
  return text.slice(0, change.start) + change.inserted + text.slice(change.start + change.removeLength);
}

export function invertTextChange(text, change) {
  return { start: change.start, removeLength: change.inserted.length, inserted: copyRange(text, change.start, change.start + change.removeLength) };
}
