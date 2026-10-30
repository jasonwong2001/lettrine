import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { htmlToMarkdown } from "../src/renderer/html-to-markdown.js";
import { readableMarkdown } from "../src/core/readable.js";
const document = new JSDOM("<!doctype html>").window.document;

test("rich paste keeps headings, styling, links, tables and code while removing active content", () => {
  const html = '<h2>A title</h2><p><strong>Bold</strong> and <em>italic</em> <a href="notes with space.md">link</a></p><table><tr><th>A</th><th style="text-align:right">B</th></tr><tr><td>x</td><td>y</td></tr></table><pre><code class="language-js">const a = 1;\n</code></pre><script>alert(1)</script><iframe src="https://example.com"></iframe>';
  assert.equal(htmlToMarkdown(html, document), '## A title\n\n**Bold** and *italic* [link](<notes with space.md>)\n\n| A | B |\n| --- | ---: |\n| x | y |\n\n```js\nconst a = 1;\n```');
  assert.equal(htmlToMarkdown('<p>2 * 3 <img src="x.svg"></p>', document), '2 \\* 3 ![](x.svg)');
});

test("readable speech text omits Markdown markers and decorative structure", () => {
  assert.equal(readableMarkdown('# Heading\n\n[toc]\n\n**Bold** with [a link](https://example.com) and `code`[^a].\n\n- one\n- two\n\n| A | B |\n| --- | --- |\n| x | y |'),
    'Heading\n\nBold with a link and code.\n\none\ntwo\n\nA, B\nx, y');
});
