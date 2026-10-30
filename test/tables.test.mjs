import test from "node:test";
import assert from "node:assert/strict";
import { parseBlocks } from "../src/core/blocks.js";
import { editTableColumn, joinTableRow } from "../src/core/table.js";

test("column insertion and deletion preserve cell source and alignment", () => {
  const source = "| A | B |\n| :---- | ----: |\n| a \\| b | `x|y` |";
  const added = editTableColumn(parseBlocks(source)[0], 0, "after");
  assert.equal(added.source, "| A |  | B |\n| :---- | --- | ----: |\n| a \\| b |  | `x|y` |");
  assert.equal(editTableColumn(parseBlocks(added.source)[0], 1, "delete").source, source);
  assert.equal(editTableColumn(parseBlocks("| One |\n| --- |")[0], 0, "delete"), null);
});

test("column alignment changes only its separator marker", () => {
  const source = "A | B\n  :-----  | ----: \nx | y";
  assert.equal(editTableColumn(parseBlocks(source)[0], 0, "align", "center").source,
    "A | B\n  :-----:  | ----: \nx | y");
});

test("Backspace at the first cell merges columns into the previous row", () => {
  const source = "| A | B |\n| --- | --- |\n| first | x |\n| second | y |\n| third | z |";
  const result = joinTableRow(parseBlocks(source)[0], source.indexOf("second"));
  assert.equal(result.source, "| A | B |\n| --- | --- |\n| first second | x y |\n| third | z |");
  assert.equal(result.offset, source.indexOf("first") + "first".length);
  assert.equal(joinTableRow(parseBlocks(source)[0], source.indexOf("second") + 1), null);
  assert.equal(joinTableRow(parseBlocks(source)[0], source.indexOf("first")).source,
    "| A first | B x |\n| --- | --- |\n| second | y |\n| third | z |");
});
