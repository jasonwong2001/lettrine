import { test } from "node:test";
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import { JSDOM } from "jsdom";
import { buildNativeExport } from "../src/renderer/native-export.js";

const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
window.markdownit = MarkdownIt;
window.__lettrine = { settings: {} };

test("CSS imports retain media, supports and layer conditions in standalone exports", async () => {
  const files = {
    "theme.css": '@import "print.css" print;\n@import url("screen.css") screen and (min-width: 1px);\n@import "layer.css" layer(theme) supports(display: grid) screen;\n@import "anonymous.css" layer supports((display: grid) and (not (display: invalid)));',
    "print.css": "#write p{letter-spacing:9px}",
    "screen.css": '@import "nested.css" (min-width: 2px);\n#write p{color:red}',
    "nested.css": "#write p{font-weight:600}",
    "layer.css": "#write p{word-spacing:3px}",
    "anonymous.css": "#write p{line-height:2}",
  };
  const calls = [];
  window.bridge = {
    theme: { resolve: async () => ({ theme: "lettrine://theme/theme.css" }) },
    native: { invoke: async (name, { url }) => {
      calls.push(url);
      return { url, text: files[url.split("/").at(-1)] || "", mime: "text/css", data: "" };
    } },
  };
  const html = await buildNativeExport({ text: "---\ntitle: Metadata\n---\n\nVisible body" });
  assert.match(html, /@media print\{\n#write p\{letter-spacing:9px\}\n\}/);
  assert.match(html, /@media screen and \(min-width: 1px\)\{\n@media \(min-width: 2px\)/);
  assert.match(html, /@layer theme\{\n@supports \(display: grid\)\{\n@media screen\{\n#write p\{word-spacing:3px\}/);
  assert.match(html, /@layer\{\n@supports \(display: grid\) and \(not \(display: invalid\)\)\{/);
  assert.doesNotMatch(html, /@import|Metadata/);
  assert.match(html, /<p>Visible body<\/p>/);
  assert.ok(calls.includes("lettrine://theme/nested.css"));
});
