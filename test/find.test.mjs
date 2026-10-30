import test from "node:test";
import assert from "node:assert/strict";
import { compileFind, findAll, replaceFind } from "../src/core/find.js";
test("find distinguishes literal/regex, Unicode word boundaries and case", () => {
  assert.equal(findAll("a.b aXb", compileFind({ query: "a.b" })).length, 1);
  assert.equal(findAll("CAFÉ café cafétéria", compileFind({ query: "café", wholeWord: true })).length, 2);
  assert.equal(findAll("A a", compileFind({ query: "a", caseSensitive: true })).length, 1);
  assert.throws(() => compileFind({ query: "[", regex: true }));
  assert.equal(findAll("😀", compileFind({ query: "(?=.)", regex: true })).length, 1);
});
test("regex replace supports numbered/named groups, whole matches and literal dollars", () => {
  const re = compileFind({ query: "(?<name>[a-z]+)=(\\d+)", regex: true });
  assert.equal(replaceFind("a=12 b=34", re, "$2:$<name>:$0:$$").text, "12:a:a=12:$ 34:b:b=34:$");
  assert.equal(replaceFind("a=12 b=34", re, "$2-$1", 1).text, "a=12 34-b");
  const many = replaceFind("a ".repeat(6000), compileFind({ query: "a" }), "b");
  assert.equal(many.count, 6000); assert.equal(many.text.includes("a"), false);
});
