import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { PDFDocument } from "pdf-lib";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-diagrams-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", background: "light" }));
const zen = "Alice -> Bob: Hello\nBob -> Alice: Reply", math = "\\int_0^1 x^2\\,dx = \\frac{1}{3}\\tag{A}";
const fences = [
  ["zenuml", zen], ["math", math],
  ["mermaid", "graph LR\n A[Markdown] --> B[Static SVG]"],
  ["mermaid", "sequenceDiagram\n Alice->>Bob: Request\n Bob-->>Alice: Response"],
  ["mermaid", "gantt\n title Work\n dateFormat YYYY-MM-DD\n section Review\n Draft :a, 2026-10-29, 2d"],
  ["mermaid", "mindmap\n root((Writing))\n  Source\n  Preview"],
  ["mermaid", 'pie title Choices\n "Markdown" : 70\n "Other" : 30'],
  ["flow", "A[Alias] --> B[Flow]"], ["sequence", "Alice->>Bob: Alias"],
];
const source = "# Diagram review\n\nBefore stays  \n\n" + fences.map(([lang, body]) => "````" + lang + "\n" + body + "\n``````  ").join("\n\n") + "\n\n> ```zenuml\n> Alice -> Bob: Quoted\n> ```\n\nAfter stays.\n";
const doc = path.join(dir, "diagrams.md"), html = path.join(dir, "diagrams.html"), darkHTML = path.join(dir, "diagrams-dark.html"), pdf = path.join(dir, "diagrams.pdf"), failureHTML = path.join(dir, "failed.html");
await writeFile(doc, source);
const A = "window.__lettrine", E = `${A}.editor`, C = `${E}.root.querySelector('pre').__cm`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const setPreview = (text) => ({ eval: `${E}.root.focus();${E}.setText(${q(text)},{docBase:${q(doc)}});${E}.selectOffsets(0)` });
const exportHTML = (file, dark = false) => ({ eval: `window.bridge.export.html({path:${q(file)},text:${E}.getMarkdown(),docPath:${q(doc)},theme:${q(dark ? "lettrine-dark" : "lettrine")},dark:${dark}})` });
const count = fences.length + 1;
const invalid = "# Invalid diagrams\n\n```zenuml\n<<<\n```\n\n```math\n\\notARealCommand\n```\n\n```mermaid\nnot a diagram at all\n```";
const steps = [
  { open: doc }, { focusWindow: true },
  { waitFor: `${E}.root.querySelectorAll('.md-diagram-ready').length===${count}`, timeout: 30000, diagnostic: `[...${E}.root.querySelectorAll('.md-diagram')].map(n=>({language:n.dataset.diagram,error:n.classList.contains('md-diagram-error'),text:n.textContent.slice(0,400),html:n.innerHTML.slice(0,200)}))` },
  check("ZenUML, math, aliases and common Mermaid types all render with exact source", `${E}.getMarkdown()===${q(source)}&&${E}.root.querySelectorAll('.md-diagram > svg').length===${count - 1}&&${E}.root.querySelectorAll('.md-diagram .katex').length===1&&!${A}._dirty`),
  check("the ZenUML plugin does not inject its standalone UI resets into the app", "![...document.head.querySelectorAll('style')].some(style=>style.textContent.includes('.zenuml .sequence-diagram'))"),
  check("math fences retain manual tags without joining automatic equation numbering", `${E}.root.querySelector('[data-diagram=math] .tag').textContent.replace(/\\u200b/g,'')`, "(A)"),
  { capture: "diagrams-light" },
  { eval: `${A}.copyAsImage(${E}.root.querySelector('[data-diagram=zenuml]'))` },
  check("ZenUML context image copy uses the ZenUML fence rather than assuming Mermaid syntax", "(async()=>{const image=await window.bridge.clipboard.readImage();return image.ok&&image.width>100&&image.height>100&&image.png.length>5000;})()"),
  { eval: `${A}.copySpecial('mathml',${E}.root.querySelector('[data-diagram=math]'))` },
  check("math-fence context copy supplies standalone MathML with its tag", "(async()=>{const c=await window.bridge.clipboard.readContent();const x=new DOMParser().parseFromString(c.text,'application/xml');return c.text===c.html&&!x.querySelector('parsererror')&&x.documentElement.localName==='math'&&c.text.includes('<mfrac>')&&x.documentElement.textContent.includes('(A)');})()"),
  exportHTML(html),
  check("PDF export renders all the same diagrams", `(async()=>{const result=await window.bridge.export.pdf({path:${q(pdf)},text:${E}.getMarkdown(),docPath:${q(doc)},theme:'lettrine',dark:false,title:'Diagram review'});return result.ok;})()`),
  { eval: `${E}.root.querySelector('pre').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${C}` },
  { eval: `${C}.setCursor({line:0,ch:${zen.split("\n")[0].length}});${C}.focus();window.__zenCM=${C};window.__tail=${E}.root.lastElementChild` },
  { type: " revised" },
  { waitFor: `${E}.root.querySelector('[data-diagram=zenuml] svg')?.textContent.includes('revised')`, diagnostic: `({body:${E}.blocks.find(b=>b.info==='zenuml')?.body,preview:${E}.root.querySelector('[data-diagram=zenuml]').textContent,errors:window.__lettrineStartupErrors})` },
  check("ZenUML editing updates its preview without remounting its editor or rebuilding other blocks", `${C}===__zenCM&&${E}.root.lastElementChild===__tail&&${E}.getMarkdown()===${q(source.replace("Hello", "Hello revised"))}`),
  { key: "Meta+Z" },
  check("ZenUML edits participate in document undo", `${E}.getMarkdown()`, source),
  { waitFor: `!!${C}` },
  { eval: `${E}.root.focus();${E}.root.querySelectorAll(':scope > pre.md-fences')[1].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${E}.root.querySelectorAll(':scope > pre.md-fences')[1].__cm`, diagnostic: `({active:document.activeElement.outerHTML,codes:[...${E}.root.querySelectorAll('pre.md-fences')].map(pre=>({language:pre.dataset.info,classes:pre.className,mounted:!!pre.__cm,connected:pre.isConnected})),errors:window.__lettrineStartupErrors})` },
  { eval: `window.__mathCM=${E}.root.querySelectorAll(':scope > pre.md-fences')[1].__cm;__mathCM.setSelection(__mathCM.posFromIndex(${math.indexOf("{3}") + 1}),__mathCM.posFromIndex(${math.indexOf("{3}") + 2}));__mathCM.focus()` },
  { type: "4" },
  { waitFor: `${E}.root.querySelector('[data-diagram=math] math')?.textContent.includes('4')` },
  check("math fences keep exact delimiters while their live TeX changes", `${E}.getMarkdown()`, source.replace("\\frac{1}{3}", "\\frac{1}{4}")),
  { key: "Meta+Z" },
  check("math-fence typing has normal undo", `${E}.getMarkdown()`, source),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor(${A}._sourceCM.posFromIndex(${source.indexOf("Alice")}));${A}._sourceCM.focus()` },
  { cmd: "edit.copyCode" },
  check("diagram source remains available to exact code-body copy", "(async()=>{const c=await window.bridge.clipboard.readContent();return c.text===" + q(zen) + ";})()"),
  { cmd: "view.readonly" }, { type: "blocked" },
  check("readonly Source Code Mode protects diagram Markdown", `${A}._sourceCM.getValue()`, source),
  { cmd: "view.source" },
  { eval: `${A}.setTheme('lettrine-dark')` }, { waitFor: "document.body.classList.contains('ui-dark')" },
  { waitFor: `${E}.root.querySelector('[data-diagram=zenuml] svg style')?.textContent.includes('#202226')&&${E}.root.querySelectorAll('.md-diagram-ready').length===${count}` },
  check("ZenUML dark SVG uses a scoped palette, visible arrowheads and the document typeface", `(()=>{const s=${E}.root.querySelector('[data-diagram=zenuml] svg');return s.querySelector('style').textContent.includes('#'+s.id+' .frame-border-inner')&&!!s.querySelector('text').style.fontFamily&&s.querySelector('path[stroke="#e2e4e8"]')!==null&&!s.querySelector('path[stroke="#000"]');})()`),
  { eval: "document.getElementById('md-content').scrollTop=0" }, { capture: "diagrams-dark" },
  exportHTML(darkHTML, true),
  { eval: `${A}.copyAsImage(${E}.root.querySelector('[data-diagram=math]'))` },
  check("fenced math is copyable as an image in readonly dark mode", "(async()=>{const image=await window.bridge.clipboard.readImage();return image.ok&&image.width>100&&image.height>50;})()"),
  { cmd: "view.readonly" },
  { eval: "window.bridge.setting.put({key:'__patch',value:{renderDiagrams:false}})" },
  { waitFor: `${E}.root.querySelectorAll('.md-diagram').length===1` },
  check("disabling diagrams preserves math and never rewrites their source", `${E}.getMarkdown()===${q(source)}&&${E}.root.querySelector('.md-diagram').dataset.diagram==='math'`),
  { eval: "window.bridge.setting.put({key:'__patch',value:{renderMath:false}})" },
  { waitFor: `!${E}.root.querySelector('.md-diagram')` },
  check("disabling math restores its raw code body without changing the document", `${E}.getMarkdown()`, source),
  { eval: "window.bridge.setting.put({key:'__patch',value:{renderDiagrams:true,renderMath:true}})" },
  { waitFor: `${E}.root.querySelectorAll('.md-diagram-ready').length===${count}` },
  setPreview(invalid),
  { waitFor: `${E}.root.querySelectorAll('.md-diagram-error').length===3`, diagnostic: `[...${E}.root.querySelectorAll('.md-diagram')].map(n=>({language:n.dataset.diagram,error:n.classList.contains('md-diagram-error'),html:n.innerHTML.slice(0,400)}))` },
  check("invalid ZenUML, math and Mermaid keep their source visible beside a local error", `${E}.getMarkdown()===${q(invalid)}&&![...${E}.root.querySelectorAll('pre')].some(n=>n.classList.contains('md-diagram-ready'))`),
  exportHTML(failureHTML, true),
  { eval: `${E}.root.querySelector('pre').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${C}` },
  { eval: `${C}.setValue(${q(zen)});${C}.focus()` },
  { waitFor: `!!${E}.root.querySelector('[data-diagram=zenuml] svg')` },
  check("a failed diagram can be clicked, edited and rendered successfully again", `${E}.root.querySelector('pre').classList.contains('md-diagram-ready')`),
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  setPreview("```math\n\\notARealCommand\n```"),
  { waitFor: `${E}.root.querySelector('.md-diagram-error')?.textContent.includes('无法渲染图表')` },
  { capture: "diagram-error" },
  { eval: "window.__renderer=window.mermaid;delete window.mermaid;window.__appendHead=document.head.appendChild;document.head.appendChild=function(node){if(node.tagName==='SCRIPT'&&node.src.includes('/mermaid/')){queueMicrotask(()=>node.dispatchEvent(new Event('error')));return node;}return __appendHead.call(this,node);};true" },
  setPreview("```mermaid\ngraph LR\n A-->B\n```"),
  { waitFor: `${E}.root.querySelector('.md-diagram-error')?.textContent.includes('图表渲染器不可用')` },
  check("an unavailable renderer falls back to editable source without crashing", `${E}.getMarkdown()=== '\\u0060\\u0060\\u0060mermaid\\ngraph LR\\n A-->B\\n\\u0060\\u0060\\u0060'&&!${E}.root.querySelector('.md-diagram-ready')`),
  { eval: "document.head.appendChild=__appendHead;window.mermaid=__renderer;window.bridge.i18n.setLocale({locale:'zh-Hant'})" },
  { waitFor: `${A}.i18n.locale==='zh-Hant'` }, setPreview("```math\n\\notARealCommand\n```"),
  { waitFor: `${E}.root.querySelector('.md-diagram-error')?.textContent.includes('無法繪製圖表')` },
  check("no renderer exceptions escape into the app", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; });
const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
let code;
try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
finally { clearTimeout(timer); }
await writeFile(path.join(dir, "native.log"), log); console.log("Diagrams report: " + dir);
const report = JSON.parse(await readFile(scenario.replace("scenario.json", "report.json"), "utf8"));
for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Diagrams native scenario failed");
for (const file of [html, darkHTML]) {
  const text = await readFile(file, "utf8"), document = new JSDOM(text).window.document;
  assert.equal(document.querySelectorAll("figure > svg").length, count - 1);
  assert.equal(document.querySelectorAll("figure math").length, 1);
  assert.equal(document.querySelectorAll("script").length, 0);
  assert.equal(document.querySelector(".md-diagram-error"), null);
  assert.ok(document.querySelector('[data-diagram="zenuml"] svg').textContent.includes("Hello"));
  if (file === darkHTML) assert.match(document.querySelector('[data-diagram="zenuml"] svg style').textContent, /#202226/);
}
const failed = new JSDOM(await readFile(failureHTML, "utf8")).window.document;
assert.equal(failed.querySelectorAll(".md-diagram-error").length, 3); assert.equal(failed.querySelectorAll("figure pre").length, 3);
const bytes = await readFile(pdf), document = await PDFDocument.load(bytes);
assert.ok(document.getPageCount() > 1 && document.getPageCount() < 12);
const extracted = spawnSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
assert.equal(extracted.status, 0); assert.match(extracted.stdout, /Hello/); assert.match(extracted.stdout, /Static SVG/); assert.match(extracted.stdout, /After stays/); assert.match(extracted.stdout, /\(A\)/);
const image = spawnSync("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1400", "-png", pdf, path.join(dir, "pdf-first-page")], { encoding: "utf8" });
assert.equal(image.status, 0);
assert.equal(await readFile(doc, "utf8"), source);
console.log("PASS offline ZenUML/math/Mermaid rendering, source and undo, static SVG HTML, PDF, clipboard images, readonly, themes, settings, localized errors and failure recovery");
