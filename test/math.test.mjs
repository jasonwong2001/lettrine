import { test } from "node:test";
import assert from "node:assert/strict";
import { mathInput } from "../src/core/math.js";
import { parseBlocks, splitBlock } from "../src/core/blocks.js";

test("math: Enter after a fresh opener starts empty TeX without an extra line", () => {
  const result = splitBlock(parseBlocks("$$")[0], 2);
  assert.equal(result.block.src, "$$\n");
  assert.equal(result.block.tex, "");
  assert.equal(result.offset, 3);
});

test("math: a typed closing line is consumed once and following content stays outside", () => {
  const block = parseBlocks("$$\nx")[0];
  assert.deepEqual(mathInput(block, "x^2\n$$\n\nafter"), {
    source: "$$\nx^2\n$$", tail: "\nafter", closedByInput: true,
  });
  assert.equal(mathInput(block, "x$$ + y").closedByInput, false);
});

test("math: editing a closed formula and exiting retain exactly one closer", () => {
  const block = parseBlocks("$$ {align}\nx\n$$")[0];
  assert.equal(mathInput(block, "y").source, "$$ {align}\ny\n$$");
  assert.equal(mathInput(block, "y\n$$").source, "$$ {align}\ny\n$$");
  assert.equal(mathInput(parseBlocks("$$\nx")[0], "x", true).source, "$$\nx\n$$");
});

test("math: legacy delimiters and whitespace are preserved", () => {
  const block = parseBlocks("\\(\nx\n\\)")[0];
  assert.deepEqual(mathInput(block, "y\n  \\)  "), {
    source: "\\(\ny\n  \\)  ", tail: "", closedByInput: true,
  });
});
