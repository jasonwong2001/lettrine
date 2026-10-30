import { tableCellRanges } from "./blocks.js";

function rawCells(line) {
  const cells = tableCellRanges(line);
  return cells.map((cell, i) => {
    const start = i ? line.indexOf("|", cells[i - 1].end) + 1 : line.slice(0, cell.start).includes("|") ? line.indexOf("|") + 1 : 0;
    const end = i + 1 < cells.length ? line.indexOf("|", cell.end) : line.slice(cell.end).includes("|") ? line.indexOf("|", cell.end) : line.length;
    return line.slice(start, end);
  });
}

export function editTableColumn(block, column, action, alignment = "left") {
  if (block.type !== "table" || column < 0 || column >= block.headers.length) return null;
  if (action === "delete" && block.headers.length === 1) return null;
  const lines = block.src.split("\n");
  if (action === "align") {
    if (!["left", "center", "right"].includes(alignment)) return null;
    const cell = tableCellRanges(lines[1])[column];
    const dashes = cell.text.replace(/:/g, "");
    const value = (alignment !== "right" ? ":" : "") + dashes + (alignment !== "left" ? ":" : "");
    lines[1] = lines[1].slice(0, cell.start) + value + lines[1].slice(cell.end);
  } else {
    for (let row = 0; row < lines.length; row++) {
      const cells = rawCells(lines[row]);
      while (cells.length < block.headers.length) cells.push("  ");
      if (action === "delete") cells.splice(column, 1);
      else if (action === "before" || action === "after") cells.splice(column + (action === "after" ? 1 : 0), 0, row === 1 ? " --- " : "  ");
      else return null;
      lines[row] = "|" + cells.join("|") + "|";
    }
  }
  const target = action === "after" ? column + 1 : Math.min(column, tableCellRanges(lines[0]).length - 1);
  return { source: lines.join("\n"), offset: tableCellRanges(lines[0])[target].start };
}

export function joinTableRow(block, offset) {
  if (block.type !== "table") return null;
  const lines = block.src.split("\n");
  let start = 0, row = 0;
  while (row < lines.length && offset > start + lines[row].length) start += lines[row++].length + 1;
  const cells = tableCellRanges(lines[row] || "");
  if (row < 2 || offset !== start + cells[0]?.start) return null;
  const previous = row === 2 ? 0 : row - 1;
  const before = tableCellRanges(lines[previous]);
  let merged = lines[previous];
  for (let i = before.length - 1; i >= 0; i--) {
    const value = before[i].text + (before[i].text && cells[i]?.text ? " " : "") + (cells[i]?.text || "");
    merged = merged.slice(0, before[i].start) + value + merged.slice(before[i].end);
  }
  const caret = lines.slice(0, previous).reduce((n, line) => n + line.length + 1, 0) + (before[0]?.end || 0);
  lines[previous] = merged; lines.splice(row, 1);
  return { source: lines.join("\n"), offset: caret };
}

export function editTableRow(block, offset, action) {
  if (block.type !== "table") return null;
  const lines = block.src.split("\n");
  let start = 0;
  let row = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (offset <= start + lines[i].length) { row = i; break; }
    start += lines[i].length + 1;
  }
  let target = row;
  const column = Math.max(0, offset - start);
  if (action === "above" || action === "below") {
    target = row < 2 ? 2 : row + (action === "below" ? 1 : 0);
    const empty = block.rowSrc ? block.rowSrc(block.headers.map(() => "")) : `| ${block.headers.map(() => "").join(" | ")} |`;
    lines.splice(target, 0, empty);
  } else if (action === "delete") {
    if (row < 2) return null;
    lines.splice(row, 1);
    target = Math.max(0, Math.min(row, lines.length - 1));
    if (target === 1) target = 0;
  } else {
    target = row + (action === "up" ? -1 : 1);
    if (row < 2 || target < 2 || target >= lines.length) return null;
    [lines[row], lines[target]] = [lines[target], lines[row]];
  }
  const rowStart = lines.slice(0, target).reduce((sum, line) => sum + line.length + 1, 0);
  const cellStart = tableCellRanges(lines[target])[0]?.start || 0;
  return { source: lines.join("\n"), offset: rowStart + (action === "up" || action === "down" ? Math.min(column, lines[target].length) : cellStart) };
}
