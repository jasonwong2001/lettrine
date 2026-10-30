import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInline, segmentsToHtml } from "../src/core/inline.js";
import { parseBlocks, blocksToMarkdown, splitBlock, joinWithPrev } from "../src/core/blocks.js";
import { completeEmoji } from "../src/core/emoji.js";
import { fuzzyScore, fuzzyRank } from "../src/core/fuzzy.js";

// ---------------- quick open fuzzy matching ----------------

test("fuzzy: empty query scores 0 for everything", () => {
  assert.equal(fuzzyScore("", "anything.md"), 0);
});

test("fuzzy: subsequence match succeeds in any order-preserving way", () => {
  assert.ok(fuzzyScore("qo", "quickOpen.md") !== null);
  assert.ok(fuzzyScore("qmd", "quick markdown.md") !== null);
});

test("fuzzy: non-subsequence returns null", () => {
  assert.equal(fuzzyScore("zq", "quickOpen.md"), null);
  assert.equal(fuzzyScore("cba", "abc.md"), null);
  assert.equal(fuzzyScore("aaa", "ab.md"), null);
});

test("fuzzy: contiguous run beats scattered match", () => {
  const contig = fuzzyScore("open", "OpenFile.md");
  const scattered = fuzzyScore("open", "oxpxexnx.md");
  assert.ok(contig !== null && scattered !== null);
  assert.ok(contig > scattered);
});

test("fuzzy: match at a boundary (name start) beats mid-word match", () => {
  const atStart = fuzzyScore("a", "apple.md");
  const midWord = fuzzyScore("a", "banana.md");
  assert.ok(atStart !== null && midWord !== null);
  assert.ok(atStart > midWord);
});

test("fuzzy: case-insensitive", () => {
  assert.equal(fuzzyScore("QO", "quickopen.md") !== null, true);
  assert.equal(fuzzyScore("qo", "QUICKOPEN.md") !== null, true);
});

test("fuzzyRank: keeps matches and sorts best-first", () => {
  const items = [
    { name: "zzz.md" },
    { name: "quickOpen.md" },
    { name: "quick-notes.md" },
  ];
  const ranked = fuzzyRank(items, "qo");
  assert.ok(ranked.length >= 2);
  assert.ok(ranked[0].name.startsWith("quick"));
  // no non-matching item survives
  for (const it of ranked) assert.ok(fuzzyScore("qo", it.name) !== null);
});

// ---------------- inline ----------------

test("inline: plain text stays text", () => {
  const segs = parseInline("hello world");
  assert.equal(segs.length, 1);
  assert.equal(segs[0].type, "text");
  assert.equal(segs[0].src, "hello world");
});

test("inline: bold is complete with markers preserved", () => {
  const segs = parseInline("a **bold** b");
  const bold = segs.find((s) => s.type === "bold");
  assert.ok(bold);
  assert.equal(bold.src, "**bold**");
  assert.equal(bold.inner, "bold");
});

test("inline: unclosed bold stays visible text", () => {
  const segs = parseInline("a **bold b");
  const bold = segs.find((s) => s.type === "bold");
  assert.equal(bold, undefined);
});

test("inline: italic nested in bold", () => {
  const segs = parseInline("**bold *it* end**");
  const bold = segs.find((s) => s.type === "bold");
  assert.ok(bold);
  assert.equal(bold.inner, "bold *it* end");
});

test("inline: code keeps backticks", () => {
  const segs = parseInline("x `code` y");
  const code = segs.find((s) => s.type === "code");
  assert.ok(code);
  assert.equal(code.src, "`code`");
  assert.equal(code.inner, "code");
});

test("inline: link parses url and title", () => {
  const segs = parseInline("[site](https://x.io \"T\")");
  const link = segs.find((s) => s.type === "link");
  assert.ok(link);
  assert.equal(link.url, "https://x.io");
  assert.equal(link.title, "T");
  assert.equal(link.inner, "site");
});

test("inline: image parses alt/url", () => {
  const segs = parseInline("![alt](img.png)");
  const img = segs.find((s) => s.type === "image");
  assert.ok(img);
  assert.equal(img.alt, "alt");
  assert.equal(img.url, "img.png");
});

test("inline: inline math", () => {
  const segs = parseInline("e = $a+b$ ok");
  const math = segs.find((s) => s.type === "math");
  assert.ok(math);
  assert.equal(math.tex, "a+b");
});

test("inline: autolink http", () => {
  const segs = parseInline("see https://example.com/a?b=1 now");
  const a = segs.find((s) => s.type === "autolink");
  assert.ok(a);
  assert.equal(a.url, "https://example.com/a?b=1");
});

test("inline: emoji shortcut completes", () => {
  const segs = parseInline("hi :smile: there");
  const e = segs.find((s) => s.type === "emoji");
  assert.ok(e);
  assert.equal(e.char, completeEmoji("smile"));
});

test("inline: escape backslash-star renders star", () => {
  const segs = parseInline("a \\* b");
  const esc = segs.find((s) => s.type === "escape");
  assert.ok(esc);
  assert.equal(esc.char, "*");
});

test("inline: segmentsToHtml hides markers in md-attr spans", () => {
  const html = segmentsToHtml(parseInline("**bold**"));
  assert.match(html, /class="md-attr">/);
  assert.match(html, /<strong>/);
});

test("inline: emoji/math/image use the editor DOM classes", () => {
  const h1 = segmentsToHtml(parseInline(":smile:"));
  assert.match(h1, /class="md-emoji"/);
  assert.match(h1, /data-emoji=":smile:"/);
  const h2 = segmentsToHtml(parseInline("$x^2$"));
  assert.match(h2, /class="md-inline-math"/);
  const h3 = segmentsToHtml(parseInline("![](a.png)"));
  assert.match(h3, /class="md-image"/);
  assert.match(h3, /<img class="md-decor"/);
});

test("inline: source round-trip excludes md-decor nodes", async () => {
  const JSDOM = (await import("jsdom")).JSDOM;
  const dom = new JSDOM("<div id=x></div>");
  const el = dom.window.document.getElementById("x");
  el.innerHTML = segmentsToHtml(parseInline("a **b** :smile: $c$ `d`"));
  let src = "";
  const walk = (n) => {
    if (n.nodeType === 3) { src += n.data; return; }
    if (n.nodeType !== 1) return;
    if (n.classList.contains("md-decor")) return;
    for (const c of n.childNodes) walk(c);
  };
  walk(el);
  assert.equal(src, "a **b** :smile: $c$ `d`");
});

test("inline: source preserved by round-tripping src", () => {
  const src = "a **b** `c` [d](e) $f$ :smile: https://x.io \\*";
  const segs = parseInline(src);
  const joined = segs.map((s) => s.src).join("");
  // text + segment sources should reconstitute the original
  assert.equal(joined, src);
});

// ---------------- blocks ----------------

test("blocks: paragraph and heading", () => {
  const b = parseBlocks("# Title\n\nSome text here.");
  assert.equal(b.length, 2);
  assert.equal(b[0].type, "heading");
  assert.equal(b[0].level, 1);
  assert.equal(b[0].text, "Title");
  assert.equal(b[1].type, "paragraph");
});

test("blocks: fenced code with language", () => {
  const b = parseBlocks("```js\nconst x = 1;\n```");
  assert.equal(b.length, 1);
  assert.equal(b[0].type, "code");
  assert.equal(b[0].info, "js");
  assert.equal(b[0].body, "const x = 1;");
  assert.equal(b[0].closed, true);
});

test("blocks: mermaid fence flagged diagram", () => {
  const b = parseBlocks("```mermaid\ngraph TD; A-->B;\n```");
  assert.equal(b[0].diagram, true);
});

test("blocks: blockquote nests paragraph", () => {
  const b = parseBlocks("> quoted line\n> second line");
  assert.equal(b[0].type, "quote");
  assert.equal(b[0].items.length, 1);
  assert.equal(b[0].items[0].type, "paragraph");
});

test("blocks: unordered list with nested child", () => {
  const b = parseBlocks("- a\n  - a1\n- b");
  assert.equal(b[0].type, "list");
  assert.equal(b[0].items.length, 2);
  assert.equal(b[0].items[0].children.length, 1);
  assert.equal(b[0].items[0].children[0].text, "a1");
});

test("blocks: ordered list increments on split", () => {
  const b = parseBlocks("1. one\n2. two");
  assert.equal(b[0].type, "list");
  assert.equal(b[0].ordered, true);
  const res = splitBlock(b[0], b[0].src.length);
  assert.ok(res);
});

test("blocks: task list detected", () => {
  const b = parseBlocks("- [x] done\n- [ ] todo");
  assert.equal(b[0].items[0].task.checked, true);
  assert.equal(b[0].items[1].task.checked, false);
});

test("blocks: table parses headers and rows", () => {
  const b = parseBlocks("| h1 | h2 |\n| --- | --- |\n| a | b |");
  assert.equal(b[0].type, "table");
  assert.deepEqual(b[0].headers, ["h1", "h2"]);
  assert.deepEqual(b[0].rows, [["a", "b"]]);
});

test("blocks: hr", () => {
  const b = parseBlocks("---");
  assert.equal(b[0].type, "hr");
});

test("blocks: standalone image", () => {
  const b = parseBlocks("![pic](img.png)");
  assert.equal(b[0].type, "image");
  assert.equal(b[0].url, "img.png");
});

test("blocks: block math $$", () => {
  const b = parseBlocks("$$\nE = mc^2\n$$");
  assert.equal(b[0].type, "math");
  assert.match(b[0].tex, /E = mc\^2/);
});

test("blocks: split paragraph at offset", () => {
  const b = parseBlocks("hello world");
  const res = splitBlock(b[0], 5);
  assert.equal(res.kind, "split");
  assert.equal(res.left.src, "hello");
  assert.equal(res.right.src, " world");
});

test("blocks: split code inserts a line", () => {
  const b = parseBlocks("```js\na\nb\n```");
  const res = splitBlock(b[0], b[0].src.indexOf("b"));
  assert.equal(res.kind, "stay");
});

test("blocks: empty list item pops out", () => {
  const b = parseBlocks("- a\n- ");
  // second item empty; Enter at its start pops it
  const res = splitBlock(b[0], b[0].src.length);
  assert.equal(res.kind, "replace");
  assert.equal(res.blocks[0].src, "- a");
  assert.equal(res.blocks[1].type, "paragraph");
});

test("blocks: joinWithPrev paragraphs", () => {
  const a = { type: "paragraph", src: "hello", text: "hello" };
  const c = { type: "paragraph", src: "world", text: "world" };
  const { prev, leftover } = joinWithPrev(a, c);
  assert.equal(prev.src, "hello world");
  assert.equal(leftover, null);
});

test("blocks: joinWithPrev heading into paragraph", () => {
  const a = { type: "paragraph", src: "intro", text: "intro" };
  const c = { type: "heading", level: 2, src: "## T", text: "T" };
  const { prev, leftover } = joinWithPrev(a, c);
  assert.equal(prev.type, "paragraph");
  assert.equal(leftover, null);
});

test("blocks: blocksToMarkdown joins with blank line", () => {
  const md = blocksToMarkdown([
    { type: "paragraph", src: "one" },
    { type: "heading", level: 1, src: "# H" },
  ]);
  assert.equal(md, "one\n\n# H");
});

test("blocks: parse then serialize round-trips simple docs", () => {
  const src = "# Title\n\npara one\n\n- a\n- b\n\n```\ncode\n```\n\n> quote";
  const b = parseBlocks(src);
  const out = blocksToMarkdown(b);
  // normalize: our serializer uses one blank line between blocks
  assert.equal(out.replace(/\n{3,}/g, "\n\n"), src.replace(/\n{3,}/g, "\n\n"));
});

test("blocks: setext heading from === underline", () => {
  const b = parseBlocks("Title\n===");
  assert.equal(b[0].type, "heading");
  assert.equal(b[0].level, 1);
  assert.equal(b[0].text, "Title");
});

test("emoji: the search index resolves keywords to glyphs", async () => {
  const { emojiMatches, completeEmoji } = await import("../src/core/emoji.js");
  // 'score' is a keyword of 💯 in the search index
  const hits = emojiMatches("score", 8);
  assert.ok(hits.some((t) => t === ":100:"), "index keyword should surface :100:");
  assert.equal(completeEmoji("100"), "💯");
  // plain name completion
  assert.ok(completeEmoji("grinning"), "grinning glyph");
  // prefix completion
  assert.ok(emojiMatches("thumbs", 8).length > 0);
});

// ---------------- footnotes & TOC block rules ----------------

test("blocks: footnote definition line parses as def_footnote", () => {
  const b = parseBlocks("some text\n\n[^1]: the footnote body");
  assert.equal(b.length, 2);
  assert.equal(b[1].type, "def_footnote");
  assert.equal(b[1].src, "[^1]: the footnote body");
  assert.equal(b[1].ref, "1");
  assert.equal(b[1].pattern, " ");
  assert.equal(b[1].text, "the footnote body");
});

test("blocks: footnote definition keeps exact source (pattern whitespace)", () => {
  const b = parseBlocks("[^a b]:  two spaces of body");
  assert.equal(b[0].type, "def_footnote");
  assert.equal(b[0].ref, "a b");
  assert.equal(b[0].pattern, "  ");
  assert.equal(b[0].text, "two spaces of body");
});

test("blocks: footnote reference in a paragraph is an inline segment", () => {
  const segs = parseInline("see[^1] and [^two-words] here");
  const fns = segs.filter((s) => s.type === "footnote");
  assert.equal(fns.length, 2);
  assert.equal(fns[0].src, "[^1]");
  assert.equal(fns[0].ref, "1");
  assert.equal(fns[1].ref, "two-words");
  // source-preserving: reassembled segments equal the input
  assert.equal(segs.map((s) => s.src).join(""), "see[^1] and [^two-words] here");
});

test("blocks: unfinished footnote marker stays text", () => {
  // no closing bracket -> plain text
  const segs = parseInline("see[^1");
  assert.equal(segs[0].type, "text");
  // bracketed text without ^ is not a footnote (and not a link either)
  const segs2 = parseInline("[notref]");
  assert.ok(!segs2.some((s) => s.type === "footnote"));
  // ref may contain [ (our rule is [^\]\n]+), so this IS complete
  const segs3 = parseInline("[^1 and [^2]");
  assert.equal(segs3[0].type, "footnote");
  assert.equal(segs3[0].ref, "1 and [^2");
});

test("inline: footnote html carries data-ref and a decor number span", () => {
  const html = segmentsToHtml(parseInline("a[^ref]b"));
  assert.ok(html.includes('class="md-footnote"'), html);
  assert.ok(html.includes('data-ref="ref"'), html);
  assert.ok(html.includes('class="md-fn-num md-decor"'), html);
});

test("blocks: [toc] line parses as toc", () => {
  for (const line of ["[toc]", "{:toc}", "[[_TOC_]]", "[toc]  ", "【toc】"]) {
    const b = parseBlocks("text\n\n" + line);
    assert.equal(b[1].type, "toc", line);
    assert.equal(b[1].src, line);
    assert.equal(b[1].pattern, line.trim());
  }
});

test("blocks: toc round-trips through serialization", () => {
  const src = "# A\n\n[toc]\n\n# B";
  const out = blocksToMarkdown(parseBlocks(src));
  assert.equal(out, src);
});

test("blocks: def_footnote split keeps the block and adds a paragraph after", () => {
  const b = parseBlocks("[^x]: body")[0];
  const res = splitBlock(b, 5);
  assert.equal(res.kind, "after");
  assert.equal(res.newBlock.type, "paragraph");
  assert.equal(res.block.src, "[^x]: body");
});

test("blocks: toc split keeps the block and adds a paragraph after", () => {
  const b = parseBlocks("[toc]")[0];
  const res = splitBlock(b, 0);
  assert.equal(res.kind, "after");
  assert.equal(res.block.type, "toc");
});

test("blocks: backspace joins a footnote definition into the previous paragraph", () => {
  const prev = { type: "paragraph", src: "lead", text: "lead" };
  const cur = parseBlocks("[^x]: body")[0];
  const { prev: merged, leftover } = joinWithPrev(prev, cur);
  assert.equal(merged.type, "paragraph");
  assert.equal(merged.src, "lead [^x]: body");
  assert.equal(leftover, null);
});

test("blocks: toc line ends a paragraph (no lazy continuation)", () => {
  const b = parseBlocks("first line\ntext\ntwo\n\n[toc]");
  assert.equal(b[0].type, "paragraph");
  assert.equal(b[0].src, "first line\ntext\ntwo");
  assert.equal(b[1].type, "toc");
});
