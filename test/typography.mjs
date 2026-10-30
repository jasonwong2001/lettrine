// Smart punctuation through real macOS input, source mode and export.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-typography-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, openAfterExport: false, background: "light", locale: "en", smartQuotes: true, smartDashes: true, smartEllipses: true, smartPunctuationMode: "render" }));
const source = '# "Title"\n\nHe said **"hello"** -- wait... 他说"你好"。\n\n`"--..."` and $x--y$.\n\n```js\nconst value = "--...";\n```\n\n> "Quoted"...';
const doc = path.join(dir, "typography.md");
await writeFile(doc, source);
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { open: doc }, { focusWindow: true },
  check("rendering uses curly quotes, CJK pairs, a dash and an ellipsis", `${E}.root.innerText.includes('“Title”')&&${E}.root.innerText.includes('“hello” – wait… 他说“你好”。')`),
  check("rendering preserves ASCII source and the saved state", `${E}.getMarkdown()===${q(source)}&&!${A}._dirty`),
  check("code and math source remain literal", `${E}.root.querySelector('code').innerText==='"--..."'&&${E}.blocks.find(b=>b.type==='code').body.includes('"--..."')&&${E}.root.querySelector('.md-inline-math').dataset.tex==='x--y'`),
  { capture: "typography-render" },
  { eval: `${E}.setText('Render ');${E}.root.focus();${E}.selectOffsets(7)` },
  { type: '"source" -- ...' },
  check("typing in rendering mode preserves ASCII punctuation in source", `${E}.getMarkdown().replace(/\\u00a0/g,' ')`, 'Render "source" -- ...'),
  { eval: `${E}.setText(${q(source)});${A}._dirty=false` },
  { eval: `${E}.root.focus();${E}.selectOffsets(${source.indexOf("--") + 1})` },
  { type: "x" },
  check("a caret inside a rendered dash edits the original ASCII range", `${E}.getMarkdown().includes('-x- wait...')`),
  { key: "Meta+Z" },
  check("Undo restores the exact original spelling", `${E}.getMarkdown()`, source),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  check("source mode displays ASCII punctuation", `${A}._sourceCM.getValue()`, source),
  { cmd: "view.source" },
  check("HTML export typesets the same punctuation", `${A}.doExport('html',${q(path.join(dir, "render.html"))})`),
  check("PDF export typesets the same punctuation", `${A}.doExport('pdf',${q(path.join(dir, "render.pdf"))})`),
  check("Pandoc export typesets the same punctuation", `${A}.doExport('docx',${q(path.join(dir, "render.docx"))})`),
  { cmd: "file.preferences" },
  { eval: "document.querySelector('[data-pane=editor]').click();document.getElementById('pref-extra-smartPunctuationMode').value='input';document.getElementById('preferences-done').click()" },
  { waitFor: `${A}.settings.smartPunctuationMode==='input'` },
  check("switching to input conversion restores the existing ASCII display", `${E}.root.querySelectorAll('.md-smart').length===0&&${E}.getMarkdown()===${q(source)}`),
  { eval: `${E}.setText('Start ');${E}.root.focus();${E}.selectOffsets(6);${A}._dirty=false` },
  { type: '"hello" -- --- ... ' },
  check("native input saves typographic quotes, en/em dashes and ellipses", `${E}.getMarkdown().replace(/\\u00a0/g,' ')`, "Start “hello” – — … "),
  { type: '他说"你好"。' },
  check("CJK input has correctly paired curly quotes", `${E}.getMarkdown().endsWith('他说“你好”。')`),
  { eval: `${E}.setText('word--');${E}.root.focus();${E}.selectOffsets(6);${E}.applySmartPunctuation()` },
  { key: "Meta+Z" },
  check("input conversion can be undone independently", `${E}.getMarkdown()`, "word--"),
  { key: "Meta+Shift+Z" },
  check("redo restores the converted punctuation", `${E}.getMarkdown()`, "word–"),
  { eval: `${E}.setText('Base ');${E}.root.focus();${E}.selectOffsets(5)` },
  { compose: { marked: ["中文"], text: "中文" } },
  { type: '"引号"' },
  check("IME composition and subsequent punctuation retain all text", `${E}.getMarkdown()`, "Base 中文“引号”"),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setValue('');${A}._sourceCM.focus()` },
  { type: '"source" -- ...' },
  check("source mode skips conversion even when input conversion is enabled", `${A}._sourceCM.getValue()`, '"source" -- ...'),
  { cmd: "view.source" },
  check("input mode does not transform existing ASCII during HTML export", `${A}.doExport('html',${q(path.join(dir, "input.html"))})`),
  check("input mode does not let Pandoc transform existing ASCII", `${A}.doExport('docx',${q(path.join(dir, "input.docx"))})`),
  { eval: `${E}.setText(${q('`"--..."`')});${E}.root.focus();${E}.selectOffsets(4)` },
  { type: "-" },
  check("inline code ignores input conversion", `${E}.getMarkdown()`, '`"---..."`'),
  { eval: `${E}.setText('Literal ');${E}.root.focus();${E}.selectOffsets(8)` },
  { type: '`"code--..."` and $x--y$' },
  check("new inline code and math stay literal while their delimiters are being typed", `${E}.getMarkdown()`, 'Literal `"code--..."` and $x--y$'),
  { eval: `${E}.setText(${q("```js\nconst value = 1;\n```")});${E}.root.focus();${E}.root.querySelector('pre').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${E}.root.querySelector('pre').__cm` },
  { eval: `window.__code=${E}.root.querySelector('pre').__cm;__code.setCursor({line:0,ch:0});__code.focus()` },
  { type: '"code" -- ...' },
  check("mounted code ignores input conversion", "__code.getValue().startsWith('\"code\" -- ...')"),
  check("no renderer errors", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log("Typography report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Typography native scenario failed");
assert.equal(await readFile(doc, "utf8"), source);
const html = new JSDOM(await readFile(path.join(dir, "render.html"), "utf8")).window.document;
assert.match(html.querySelector("p").textContent, /“hello” – wait… 他说“你好”。/);
const input = new JSDOM(await readFile(path.join(dir, "input.html"), "utf8")).window.document;
assert.equal(input.querySelector("p").textContent, '"source" -- ...');
for (const mode of ["render", "input"]) {
  const unzip = spawnSync("unzip", ["-p", path.join(dir, mode + ".docx"), "word/document.xml"], { encoding: "utf8" });
  assert.equal(unzip.status, 0);
  const xml = new JSDOM(unzip.stdout, { contentType: "text/xml" }).window.document;
  assert.ok(xml.documentElement.textContent.includes(mode === "render" ? "“Title”" : '"source" -- ...'));
}
const pdfText = spawnSync("pdftotext", [path.join(dir, "render.pdf"), "-"], { encoding: "utf8" });
assert.equal(pdfText.status, 0); assert.match(pdfText.stdout, /“Title”/);
const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
assert.equal(settings.smartPunctuationMode, "input");
console.log("PASS rendering, undoable input, IME, source mode and HTML/PDF/Pandoc consistency");
