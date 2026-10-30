import test from "node:test";
import assert from "node:assert/strict";
import { textChange, applyTextChange, invertTextChange } from "../src/core/history.js";

function roundTrip(before, after) {
  const change = textChange(before, after);
  assert.equal(applyTextChange(before, change), after);
  assert.equal(applyTextChange(after, invertTextChange(before, change)), before);
  return change;
}

test("history edits round-trip exact source, including empty text and UTF-16 boundaries", () => {
  for (const [before, after] of [
    ["", ""], ["", "new text"], ["old text", ""],
    ["unchanged", "unchanged"], ["abc", "xabcy"], ["prefix old suffix", "prefix new suffix"],
    ["😀 e\u0301\r\n\ud800", "😁 e\u0301\n\udc00"],
    ["a".repeat(10000), "a".repeat(10001)],
    ["start " + "middle ".repeat(2000) + " end", "START " + "middle ".repeat(2000) + " END"],
  ]) roundTrip(before, after);
});

test("history edits preserve arbitrary replacements across comparison and copy boundaries", () => {
  let seed = 71;
  const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  const fragments = ["", "\n\n", "😀", "\ud800", "changed", "long ".repeat(1000)];
  let text = "# Title\n\n" + "Some text 😀 with `code`.\n".repeat(300);
  const changes = [], inverse = [], versions = [text];
  for (let i = 0; i < 200; i++) {
    const start = random(text.length + 1), end = start + random(text.length - start + 1);
    const next = text.slice(0, start) + fragments[random(fragments.length)] + text.slice(end);
    const change = roundTrip(text, next);
    changes.push(change); inverse.push(invertTextChange(text, change)); versions.push(next); text = next;
  }
  for (let i = changes.length - 1; i >= 0; i--) {
    text = applyTextChange(text, inverse[i]); assert.equal(text, versions[i]);
  }
  for (let i = 0; i < changes.length; i++) {
    text = applyTextChange(text, changes[i]); assert.equal(text, versions[i + 1]);
  }
});

test("local changes to a large document retain only the inserted and deleted text", () => {
  const source = "A paragraph with Unicode 😀.\n\n".repeat(25000);
  const start = Math.floor(source.length / 2);
  const change = roundTrip(source, source.slice(0, start) + "new" + source.slice(start + 3));
  assert.ok(change.removeLength + change.inserted.length <= 6);
});
