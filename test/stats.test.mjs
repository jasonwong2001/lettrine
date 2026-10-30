import test from "node:test";
import assert from "node:assert/strict";
import { countText, documentStats, selectionStats } from "../src/core/stats.js";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
test("word counts handle Chinese and Unicode without counting URLs or syntax", () => {
  assert.ok(countText("这是中文编辑体验").words > 1);
  assert.equal(countText("😀a").chars, 2);
  const source = "# **Hello**\n\n[world](https://example.com/a/long/path)";
  assert.deepEqual(documentStats(parseBlocks(source), source), { words: 2, chars: source.length });
  assert.equal(selectionStats("**Hello** [world](https://example.com)").words, 2);
});

test("cached document counts retain Unicode and exact block layout after edits", () => {
  for (const source of ["", "\n\n# 😀 Title\n\n\nHello 🌏\n\n", "[^a]: first\n[^b]: second\n", "one\n\ntwo\n"]) {
    const blocks = parseBlocks(source);
    const expected = () => [...blocksToMarkdown(blocks)].length;
    assert.equal(documentStats(blocks).chars, expected());
    assert.equal(documentStats(blocks).chars, expected());
    if (!blocks.length) continue;
    blocks[0]._leading = "\n\n";
    blocks.at(-1)._after = "\n\n\n";
    assert.equal(documentStats(blocks).chars, expected(), "layout changes invalidate character totals");
    blocks[0].src += " 🌱";
    assert.equal(documentStats(blocks).chars, expected(), "in-place source edits update the block cache");
    blocks.splice(0, 1, ...parseBlocks("new words 😀"));
    assert.equal(documentStats(blocks).chars, expected(), "replaced blocks update totals");
  }
});

test("counts stay correct when source editing reparses unchanged and modified blocks", () => {
  const blocks = ["# **Heading**", "[a link](https://example.com)", "中文 😀 text", "```js\nconst answer = 42;\n```"];
  const original = blocks.join("\n\n");
  const expected = documentStats(parseBlocks(original));
  assert.deepEqual(documentStats(parseBlocks(original)), expected);
  blocks[1] = "one extra word";
  const edited = blocks.join("\n\n");
  assert.equal(documentStats(parseBlocks(edited)).chars, [...edited].length);
  assert.equal(documentStats(parseBlocks(edited)).words, expected.words + 1);
  assert.deepEqual(documentStats(parseBlocks(original)), expected);
});
