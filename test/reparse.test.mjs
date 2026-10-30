import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlocks, blocksToMarkdown, blockSeparator, reparseBlocks } from "../src/core/blocks.js";

function startsOf(blocks) {
  const starts = [];
  let offset = (blocks[0]?._leading || "").length;
  blocks.forEach((block, i) => {
    if (i) offset += blockSeparator(blocks, i).length;
    starts.push(offset);
    offset += block.src.length;
  });
  return starts;
}
const shape = (blocks) => blocks.map((block) => [block.type, block.src, block.pending, block.closed, block.body]);
function check(before, after, label) {
  const blocks = parseBlocks(before);
  const result = reparseBlocks(blocks, startsOf(blocks), before, after);
  const full = parseBlocks(after);
  if (result === null) return { reused: 0 };
  assert.equal(blocksToMarkdown(result), blocksToMarkdown(full), label + ": text");
  assert.deepEqual(shape(result), shape(full), label + ": blocks");
  for (const block of result) for (const key of ["_before", "_leading", "_after"]) assert.equal(block[key], full[result.indexOf(block)][key], `${label}: ${key}`);
  return { reused: result.filter((block) => blocks.includes(block)).length };
}

test("an edit inside one paragraph keeps every other block object", () => {
  const before = Array.from({ length: 30 }, (_, i) => "Paragraph " + i).join("\n\n");
  const after = before.replace("Paragraph 15", "Paragraph fifteen");
  const blocks = parseBlocks(before);
  const result = reparseBlocks(blocks, startsOf(blocks), before, after);
  assert.equal(blocksToMarkdown(result), after);
  assert.equal(result.filter((block) => blocks.includes(block)).length, 29 - 1, "only the edited block and the one before it parse again");
  assert.equal(result[20], blocks[20]);
});

test("edits that join, split or swallow blocks match a full parse", () => {
  const before = "# Title\n\nfirst\n\nsecond\n\n- a\n- b\n\n> quote\n\n```js\ncode\n```\n\nlast";
  const cases = [
    ["join paragraphs", before.replace("first\n\nsecond", "first\nsecond")],
    ["split a paragraph", before.replace("second", "sec\n\nond")],
    ["open a fence that swallows the rest", before.replace("first", "```\nfirst")],
    ["close the document's fence early", before.replace("code\n```", "code")],
    ["continue a list", before.replace("> quote", "- c")],
    ["continue a quote", before.replace("```js", "> more\n\n```js")],
    ["setext heading", before.replace("second", "second\n===")],
    ["edit the leading lines", "\n\n" + before],
    ["edit the trailing lines", before + "\n\n\n"],
    ["delete everything after the title", "# Title"],
    ["delete the title", before.replace("# Title\n\n", "")],
    ["replace all", "something else entirely"],
    ["table appears", before.replace("first", "| a | b |\n| - | - |\n| 1 | 2 |")],
    ["footnote definitions", before.replace("first\n\nsecond", "[^a]: one\n[^b]: two")],
  ];
  for (const [label, after] of cases) check(before, after, label);
});

test("randomized edits match a full parse", () => {
  const pieces = ["word", " ", "\n", "\n\n", "# ", "- ", "1. ", "* ", "2) ", "\n  - ", "\n1. ", "> ", "```", "$$", "| a | b |\n| - | - |", "[^n]: ", "[^n]", "---", "===", "  ", "text"];
  let seed = 3;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  let text = "# Notes\n\nA paragraph.\n\n- one\n- two\n1. three\n\n* four\n\n> quoted\n\n```js\nlet x = 1;\n```\n\n$$\nx^2\n$$\n\nThe end.";
  let reused = 0;
  for (let step = 0; step < 2000; step++) {
    const start = random(text.length + 1), end = Math.min(text.length, start + random(8));
    const next = text.slice(0, start) + pieces[random(pieces.length)] + text.slice(end);
    reused += check(text, next, "step " + step).reused;
    text = next.length > 4000 ? next.slice(0, 2000) : next;
  }
  assert.ok(reused > 0, "incremental parses keep blocks");
});

test("front matter edits and body rules keep their document-start context", () => {
  const before = "---\ntitle: Notes\n---\n\n# Title\n\nfirst\n\n---\n\nlast";
  for (const after of [
    before.replace("Notes", "Updated"),
    before.replace("\n---\n\n#", "\n--\n\n#"),
    before.replace("---\n", "--\n"),
    before.replace("first", "first changed"),
    before.replace("last", "last changed"),
    "\n" + before,
    before.slice(before.indexOf("# Title")),
  ]) check(before, after, "front matter boundary");
});
