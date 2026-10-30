import test from "node:test";
import assert from "node:assert/strict";
import { fenceInput } from "../src/core/fences.js";
import { parseBlocks, splitBlock } from "../src/core/blocks.js";

test("code input consumes one matching closer and retains following paragraphs", () => {
  const block = parseBlocks("  ````js\nconst a = 1;")[0];
  assert.deepEqual(fenceInput(block, "const a = 1;\n```\n`````\n\nafter"), {
    source: "  ````js\nconst a = 1;\n```\n`````", tail: "\nafter", closedByInput: true,
  });
  assert.equal(fenceInput(block, "~~~").closedByInput, false);
});

test("editing a closed code block preserves delimiter spelling and never duplicates it", () => {
  const block = parseBlocks(" ~~~ python\nold\n ~~~~ ")[0];
  assert.equal(fenceInput(block, "new").source, " ~~~ python\nnew\n ~~~~ ");
  assert.equal(fenceInput(block, "new\n~~~").source, " ~~~ python\nnew\n~~~");
});

test("Enter on the opening fence creates a real code line without closing the block", () => {
  const block = parseBlocks("```python")[0];
  const result = splitBlock(block, block.src.length);
  assert.equal(result.block.src, "```python\n");
  assert.equal(result.block.closed, false);
  assert.equal(result.offset, "```python\n".length);
});
