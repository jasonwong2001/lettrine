// Numbered formulas, native navigation/editing and standalone exports.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-equations-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, openAfterExport: false, background: "light", locale: "en" }));
const formulas = String.raw`$$ {#eq:energy}
E=mc^2
$$

$$ {A}
x=1\label{eq:manual}
$$

$$ {-}
y=2
$$

$$
z=3\label{eq:last}
$$`;
const source = "# Equations\n\n" + String.raw`See $\eqref{eq:energy}$, $\eqref{eq:manual}$, $\eqref{eq:last}$ and $\eqref{eq:changed}$.`
  + "\n\n" + Array.from({ length: 18 }, (_, i) => "Paragraph " + (i + 1) + ". Reading a long document should retain equation numbering and navigation.").join("\n\n") + "\n\n" + formulas;
const doc = path.join(dir, "equations.md");
await writeFile(doc, source);
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const tags = `Array.from(${E}.root.querySelectorAll('.katex-html .tag'),n=>n.textContent.replace(/\\u200b/g,''))`;
const steps = [
  { open: doc }, { focusWindow: true },
  check("formulas have automatic tags, a manual tag and per-equation opt-out", tags, ["(1)", "(A)", "(2)"]),
  check("forward references resolve to their targets and missing references stay visible", `${E}.root.querySelector('a[href="#md-equation-1"]').textContent==='(1)'&&${E}.root.querySelector('a[href="#md-equation-2"]').textContent==='(A)'&&${E}.root.querySelector('p').innerText.includes('(??)')`),
  check("numbering leaves the original source and saved state untouched", `${E}.getMarkdown()===${q(source)}&&!${A}._dirty`),
  { capture: "equations-light" },
  { click: 'a[href="#md-equation-1"]' },
  check("a native reference click scrolls to the formula without opening its TeX editor", `document.getElementById('md-content').scrollTop>300&&!${E}.root.querySelector('#md-equation-1').__cm&&${E}.getMarkdown()===${q(source)}`),
  { click: "#md-equation-4 .md-math-body" },
  { waitFor: `!!${E}.root.querySelector('#md-equation-4').__cm` },
  { eval: `window.__math=${E}.root.querySelector('#md-equation-4').__cm;const text=__math.getValue();__math.setSelection(__math.posFromIndex(text.indexOf('eq:last')),__math.posFromIndex(text.indexOf('eq:last')+7));__math.focus()` },
  { type: "eq:changed" },
  { waitFor: `!!${E}.root.querySelector('a[href="#md-equation-4"]')&&${E}.root.querySelector('#md-equation-4 .md-mathjax-preview .tag')?.textContent.includes('(2)')` },
  check("live TeX edits refresh labels and the mounted preview without rewriting the delimiters", `${E}.getMarkdown()===${q(source.replace("label{eq:last}", "label{eq:changed}"))}&&${E}.root.querySelector('a[href="#md-equation-4"]').textContent==='(2)'`),
  { capture: "equations-editing" },
  { key: "Meta+Z" },
  check("undo restores the exact formula and its reference", `${E}.getMarkdown()`, source),
  { eval: `${E}.setText(${q(source)});${E}.root.focus();${E}.selectOffsets(0)` },
  { eval: `${E}.replaceRange(0,0,${q("$$\na=0\n$$\n\n")})` },
  check("inserting a formula updates all automatic numbers", tags, ["(1)", "(2)", "(A)", "(3)"]),
  { key: "Meta+Z" },
  check("undoing insertion restores numbers and source", `${tags}.join(',')==='(1),(A),(2)'&&${E}.getMarkdown()===${q(source)}`),
  { cmd: "view.readonly" },
  { eval: "document.getElementById('md-content').scrollTop=0" },
  { click: 'a[href="#md-equation-1"]' },
  check("readonly references remain clickable without changing source or history", `${E}.readOnly&&document.getElementById('md-content').scrollTop>300&&${E}.getMarkdown()===${q(source)}`),
  check("HTML export retains numbers and internal links", `${A}.doExport('html',${q(path.join(dir, "equations.html"))})`),
  check("PDF export retains equation numbers", `${A}.doExport('pdf',${q(path.join(dir, "equations.pdf"))})`),
  check("Word export retains resolved numbers", `${A}.doExport('docx',${q(path.join(dir, "equations.docx"))})`),
  { eval: `${A}.setTheme('lettrine-dark')` },
  { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "equations-dark" },
  check("dark theme retains equation numbering and readable tags", tags, ["(1)", "(A)", "(2)"]),
  { cmd: "view.readonly" },
  { cmd: "file.preferences" },
  { eval: "document.querySelector('[data-pane=editor]').click();document.getElementById('pref-extra-numberEquations').checked=false;document.getElementById('preferences-done').click()" },
  { waitFor: `${A}.settings.numberEquations===false` },
  check("disabling numbering retains explicit tags and the original source", `${tags}.join(',')==='(A)'&&${E}.getMarkdown()===${q(source)}`),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  check("source mode keeps all labels, tags and opt-out syntax verbatim", `${A}._sourceCM.getValue()`, source),
  { cmd: "view.source" },
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
console.log("Equations report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Equations native scenario failed");
assert.equal(await readFile(doc, "utf8"), source);
const html = new JSDOM(await readFile(path.join(dir, "equations.html"), "utf8")).window.document;
assert.deepEqual(Array.from(html.querySelectorAll(".katex-html .tag"), node => node.textContent.replace(/\u200b/g, "")), ["(1)", "(A)", "(2)"]);
assert.equal(html.querySelector('a[href="#md-equation-1"]').textContent, "(1)");
const pdf = spawnSync("pdftotext", [path.join(dir, "equations.pdf"), "-"], { encoding: "utf8" });
assert.equal(pdf.status, 0); for (const tag of ["(1)", "(A)", "(2)"]) assert.ok(pdf.stdout.includes(tag));
const docx = spawnSync("unzip", ["-p", path.join(dir, "equations.docx"), "word/document.xml"], { encoding: "utf8" });
assert.equal(docx.status, 0);
const text = new JSDOM(docx.stdout, { contentType: "text/xml" }).window.document.documentElement.textContent;
for (const tag of ["(1)", "(A)", "(2)"]) assert.ok(text.includes(tag), tag);
assert.equal(JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8")).numberEquations, false);
console.log("PASS source preservation, navigation, live editing, undo, settings and HTML/PDF/Word exports");
