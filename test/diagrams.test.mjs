import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { diagramLanguage, diagramSource, DIAGRAM_LANGUAGES } from "../src/core/diagrams.js";
import { codeLanguageMatches, codeModeOf, formatCodeBody } from "../src/core/code-tools.js";
import { renderFenceDiagram } from "../src/renderer/diagrams.js";
import { buildNativeExport } from "../src/renderer/native-export.js";

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.katex = katex; window.markdownit = MarkdownIt;
window.bridge = { theme: { resolve: async () => ({}) }, native: { invoke: async () => ({ text: "", data: "", mime: "text/css" }) } };
window.__lettrine = { settings: {}, i18nT: (text) => text };
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { specialCopyPayload } = await import("../src/renderer/clipboard-tools.js");
const editor = new Editor({ root: document.getElementById("write") });
const app = window.__lettrine; app.editor = editor;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (condition) => { for (let i = 0; i < 100 && !condition(); i++) await tick(); assert.ok(condition(), "rendering settled"); };
const fakeMermaid = (render = async (id, source) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 30"><text>${source.split("\n")[0]}</text></svg>` })) => ({
  configs: [], plugins: [], initialize(config) { this.configs.push(config); },
  registerExternalDiagrams(plugins) { this.plugins.push(...plugins); }, render,
});

test("diagrams: every supported fence retains exact source, including math, mixed case and nested quotes", () => {
  for (const language of DIAGRAM_LANGUAGES) {
    const source = "Before  \n\n~~~~" + language.toUpperCase() + "  \n  one\n\ttwo  \n~~~~~~ \n\nAfter\n";
    const blocks = parseBlocks(source);
    assert.equal(blocks[1].type, "code"); assert.equal(blocks[1].diagram, true);
    assert.equal(blocksToMarkdown(blocks), source);
    assert.equal(blocksToMarkdown(parseBlocks("> " + source.replace(/\n/g, "\n> "))), "> " + source.replace(/\n/g, "\n> "));
  }
  assert.equal(diagramLanguage("not-a-diagram"), "");
  assert.equal(diagramSource("zenuml", "Alice->Bob: hello"), "zenuml\nAlice->Bob: hello");
  assert.equal(diagramSource("zenuml", "  ZenUML\nA->B"), "  zenuml\nA->B");
  assert.equal(diagramSource("sequence", "A->>B: hello"), "sequenceDiagram\nA->>B: hello");
  assert.equal(diagramSource("flow", "A-->B"), "flowchart TD\nA-->B");
  assert.equal(diagramSource("mermaid", "graph LR\n A-->B"), "graph LR\n A-->B");
});

test("diagrams: code completion includes math and ZenUML while math formatting keeps literal whitespace", () => {
  assert.deepEqual(codeLanguageMatches("zen"), ["zenuml"]);
  assert.ok(codeLanguageMatches("ma").includes("math")); assert.equal(codeModeOf("math"), "stex");
  const body = "\\begin{array}{cc}\n  A & B  \\\\\n C & D\n\\end{array}";
  assert.equal(formatCodeBody(null, body, "math", {}, { prettify: true }), body);
});

test("diagrams: ZenUML registers once and diagram themes are applied in render order", async () => {
  const mermaid = window.mermaid = fakeMermaid(); window["mermaid-zenuml"] = { id: "zenuml" };
  const values = await Promise.all([
    renderFenceDiagram("zenuml", "Alice->Bob: first", { dark: false, fontFamily: "First" }),
    renderFenceDiagram("mermaid", "graph LR\n A-->B", { dark: true, fontFamily: "Second" }),
    renderFenceDiagram("zenuml", "zenuml\nAlice->Bob: third", { dark: false, fontFamily: "First" }),
  ]);
  assert.equal(values.length, 3); assert.equal(mermaid.plugins.length, 1);
  assert.deepEqual(mermaid.configs.map((config) => [config.theme, config.fontFamily]), [["neutral", "First"], ["dark", "Second"], ["neutral", "First"]]);
  for (const config of mermaid.configs) assert.equal(config.securityLevel, "strict");
});

test("diagrams: math fences use real KaTeX and preserve their source and other blocks", async () => {
  const source = "Before\n\n````math\n\\frac{1}{2} + x^2\n``````  \n\nAfter";
  app.settings = {}; editor.setText(source);
  await settle(() => !!editor.root.querySelector(".md-diagram .katex"));
  assert.equal(editor.getMarkdown(), source);
  const pre = editor.root.querySelector("pre"), after = editor.root.lastElementChild;
  assert.equal(blockSourceFromEl(pre), parseBlocks(source)[1].src);
  assert.equal(pre.classList.contains("md-diagram-ready"), true);
  assert.equal(editor.root.lastElementChild, after);
  await assert.rejects(renderFenceDiagram("math", "\\notARealCommand"), /Undefined control sequence/);
  const payload = await renderFenceDiagram("math", "x^2", { mathOutput: "mathml" });
  assert.match(payload.html, /<math /); assert.doesNotMatch(payload.html, /katex-html/);
  const tagged = new window.DOMParser().parseFromString((await renderFenceDiagram("math", "x^2\\tag{A}\\label{fence}")).html, "text/html");
  assert.equal(tagged.querySelector(".tag").textContent.replace(/\u200b/g, ""), "(A)");
  editor.root.focus(); editor.selectOffsets(source.indexOf("\\frac") + 2);
  assert.equal((await specialCopyPayload(app, "tex")).text, "\\frac{1}{2} + x^2");
  assert.match((await specialCopyPayload(app, "mathml")).text, /<mfrac>/);
  editor.selectAll();
  const clean = await specialCopyPayload(app, "clean");
  assert.match(clean.html, /<math /); assert.doesNotMatch(clean.html, /katex-html|class=|style=/);
});

test("diagrams: lazy ZenUML UI styles stay isolated and dark SVG styles remain scoped", async () => {
  const retained = document.createElement("style"); retained.textContent = ".app { color: red; }"; document.head.appendChild(retained);
  window.mermaid = fakeMermaid(async (id) => {
    const injected = document.createElement("style"); injected.textContent = "* { box-sizing: border-box } .zenuml .sequence-diagram { color: black }"; document.head.appendChild(injected);
    return { svg: `<svg id="${id}" viewBox="0 0 100 30"><style>.frame-border-inner { fill: #ffffff } .frame-border-inner text { fill: #222 }</style><path stroke="#000" fill="none"/><text>diagram</text></svg>` };
  });
  const result = await renderFenceDiagram("zenuml", "Alice->Bob: hello", { dark: true, fontFamily: "Document Serif" });
  assert.equal(retained.isConnected, true);
  assert.equal([...document.head.querySelectorAll("style")].some((style) => style.textContent.includes(".zenuml .sequence-diagram")), false);
  const parsed = new window.DOMParser().parseFromString(result.html, "text/html"), svg = parsed.querySelector("svg");
  assert.match(svg.querySelector("style").textContent, /fill: #202226/);
  assert.ok(svg.querySelector("style").textContent.includes("#" + svg.id + " .frame-border-inner"));
  assert.equal(svg.querySelector("path").getAttribute("stroke"), "#e2e4e8");
  assert.equal(svg.querySelector("text").style.fontFamily, "Document Serif");
  retained.remove();
});

test("diagrams: ZenUML parser recovery placeholders fall back to source, while literal labels remain valid", async () => {
  window.mermaid = fakeMermaid(async (id) => ({ svg: `<svg id="${id}" viewBox="0 0 100 30"><text class="participant-label">Missing \`Participant\`</text></svg>` }));
  await assert.rejects(renderFenceDiagram("zenuml", "<<<"), /Invalid diagram syntax/);
  await assert.doesNotReject(renderFenceDiagram("zenuml", 'A as "Missing `Participant`"'));
});

test("diagrams: an older error cannot replace a new preview when a fence changes language", async () => {
  let rejectOld;
  window.mermaid = fakeMermaid(() => new Promise((_, reject) => { rejectOld = reject; }));
  const source = "```mermaid\nold diagram\n```";
  editor.setText(source);
  await settle(() => !!rejectOld);
  const panel = editor.root.querySelector(".md-diagram"), field = editor.root.querySelector(".md-lang-input");
  field.value = "math"; field.dispatchEvent(new window.Event("change", { bubbles: true }));
  await settle(() => !!panel.querySelector(".katex"));
  rejectOld(Error("stale failure")); await tick(); await tick();
  assert.equal(editor.root.querySelector(".md-diagram"), panel);
  assert.equal(panel.classList.contains("md-diagram-error"), false);
  assert.equal(editor.getMarkdown(), source.replace("mermaid", "math"));
});

test("diagrams: disabled rendering leaves raw fences, and failed loaders retain readable source", async () => {
  app.settings = { renderMath: false, renderDiagrams: false };
  const source = "```math\nx^2\n```\n\n```zenuml\nA->B\n```";
  editor.setText(source); assert.equal(editor.root.querySelector(".md-diagram"), null); assert.equal(editor.getMarkdown(), source);
  app.settings = {}; delete window.mermaid;
  editor.setText("```mermaid\ngraph LR\n A-->B\n```");
  await settle(() => !!document.head.querySelector('script[src*="mermaid.min.js"]'));
  document.head.querySelector('script[src*="mermaid.min.js"]').dispatchEvent(new window.Event("error"));
  await settle(() => !!editor.root.querySelector(".md-diagram-error"));
  assert.match(editor.root.querySelector(".md-diagram-error").textContent, /renderer is unavailable/);
  assert.equal(editor.root.querySelector("pre").classList.contains("md-diagram-ready"), false);
  assert.equal(editor.getMarkdown(), "```mermaid\ngraph LR\n A-->B\n```");
});

test("diagrams: standalone HTML contains static SVG and MathML, including nested fences and error source", async () => {
  window.mermaid = fakeMermaid(async (id, source) => {
    if (source.includes("INVALID")) throw Error("Invalid test syntax");
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 30"><text>Static diagram</text></svg>` };
  });
  app.settings = {};
  const source = "```zenuml\nA->B: hello\n```\n\n> ```mermaid\n> graph LR\n>  A-->B\n> ```\n\n```math\n\\frac{1}{2}\n```\n\n```mermaid\nINVALID\n```";
  const html = await buildNativeExport({ text: source, style: false });
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  assert.equal(parsed.querySelectorAll("figure svg").length, 2);
  assert.equal(parsed.querySelectorAll("figure math").length, 1);
  assert.equal(parsed.querySelectorAll("script").length, 0);
  assert.equal(parsed.querySelectorAll(".md-diagram-error").length, 1);
  assert.equal(parsed.querySelector(".md-diagram-error").previousElementSibling.textContent.trim(), "INVALID");
  assert.doesNotMatch(html, /data-export-fence|katex-html/);
  const disabled = new window.DOMParser().parseFromString(await buildNativeExport({ text: source, style: false, settings: { renderMath: false, renderDiagrams: false } }), "text/html");
  assert.equal(disabled.querySelector("svg, math, figure"), null);
  assert.equal(disabled.querySelectorAll("pre").length, 4);
});
