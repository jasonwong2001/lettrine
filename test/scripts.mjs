import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-scripts-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, openAfterExport: false, background: "light", locale: "en" }));
const source = '# Subscript and superscript\n\nH~2~O and **X^2^**, ~~strike~~ and $x^2$.\n\nA <sub>~~small~~</sub> mark and ^two\\ words^.\n\n`H~2~O X^2^`\n\n| Water | Power |\n| --- | --- |\n| H~2~O | X^2^ |';
const doc = path.join(dir, "scripts.md");
await writeFile(doc, source);
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { open: doc }, { focusWindow: true },
  { assertMenu: { id: "command.inline.subscript", property: "label", eq: "Subscript", name: "Format menu exposes Subscript" } },
  { assertMenu: { id: "command.inline.superscript", property: "label", eq: "Superscript", name: "Format menu exposes Superscript" } },
  check("subscript and superscript are disabled by default", `!${A}.settings.subscriptSuperscript&&!${E}.root.querySelector('sub,sup')&&${E}.getMarkdown()===${q(source)}`),
  check("disabled HTML export retains literal markers", `${A}.doExport('html',${q(path.join(dir, "disabled.html"))})`),
  check("disabled Word export retains literal markers", `${A}.doExport('docx',${q(path.join(dir, "disabled.docx"))})`),
  { eval: `${E}.setText('H2O');${E}.root.focus();${E}.selectOffsets(1,2)` },
  { cmd: "inline.subscript" },
  { waitFor: `${A}.settings.subscriptSuperscript===true` },
  check("choosing the format enables the setting and wraps the selected text", `${E}.getMarkdown()==='H~2~O'&&${E}.root.querySelector('sub')?.innerText==='2'`),
  { type: "3" },
  check("native typing replaces a selected script without changing its markers", `${E}.getMarkdown()`, "H~3~O"),
  { key: "Meta+Z" },
  check("undo restores the selected script text", `${E}.getMarkdown()`, "H~2~O"),
  { cmd: "inline.subscript" },
  check("the command toggles the enclosing script", `${E}.getMarkdown()`, "H2O"),
  { eval: `${E}.setText('X2');${E}.root.focus();${E}.selectOffsets(1,2)` },
  { cmd: "inline.superscript" },
  check("Superscript wraps the selection", `${E}.getMarkdown()`, "X^2^"),
  { eval: `${E}.setText('two words');${E}.root.focus();${E}.selectOffsets(0,9)` },
  { cmd: "inline.superscript" },
  check("formatting a phrase escapes spaces and preserves its visible text", `${E}.getMarkdown()===${q(String.raw`^two\ words^`)}&&${E}.root.querySelector('sup').innerText==='two words'`),
  { eval: `${E}.setText('');${E}.root.focus();${E}.selectOffsets(0)` },
  { type: "H~2~O X^2^" },
  { waitFor: `!!${E}.root.querySelector('sub')&&!!${E}.root.querySelector('sup')` },
  check("newly typed delimiters render while source stays exact", `${E}.getMarkdown()`, "H~2~O X^2^"),
  { eval: `${E}.setText('');${E}.root.focus();${E}.selectOffsets(0);window.bridge.clipboard.write({text:'H2O',html:'<p>H<sub>2</sub>O</p>'})` },
  { cmd: "edit.paste" },
  check("rich paste keeps a subscript as a supported source spelling", `${E}.getMarkdown()==='H<sub>2</sub>O'&&${E}.root.querySelector('sub')?.innerText==='2'`),
  { eval: `${E}.setText(${q(source)});${E}.root.focus();${E}.selectOffsets(0);${A}._dirty=false` },
  check("nested styling, tables, math and literal code stay distinct", `!!${E}.root.querySelector('strong sup')&&!!${E}.root.querySelector('sub s')&&!!${E}.root.querySelector('td sub')&&${E}.root.querySelector('code').innerText==='H~2~O X^2^'&&!${E}.root.querySelector('.katex-error')`),
  { capture: "scripts-light" },
  check("enabled HTML export preserves scripts", `${A}.doExport('html',${q(path.join(dir, "enabled.html"))})`),
  check("enabled PDF export preserves scripts", `${A}.doExport('pdf',${q(path.join(dir, "enabled.pdf"))})`),
  check("enabled Word export preserves scripts and nested strikes", `${A}.doExport('docx',${q(path.join(dir, "enabled.docx"))})`),
  { eval: `${A}.setTheme('lettrine-dark')` },
  { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "scripts-dark" },
  { cmd: "file.preferences" },
  { eval: "document.querySelector('[data-pane=editor]').click();document.getElementById('pref-extra-subscriptSuperscript').checked=false;document.getElementById('preferences-done').click()" },
  { waitFor: `${A}.settings.subscriptSuperscript===false` },
  check("disabling the setting restores literal source without editing it", `!${E}.root.querySelector('sub,sup')&&${E}.getMarkdown()===${q(source)}`),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  check("source mode preserves the entire Markdown spelling", `${A}._sourceCM.getValue()`, source),
  { eval: `${A}._sourceCM.setValue('X2');${A}._sourceCM.setSelection({line:0,ch:1},{line:0,ch:2});${A}._sourceCM.focus()` },
  { cmd: "inline.superscript" },
  check("source-mode formatting enables scripts and keeps source mode active", `document.body.classList.contains('sourceview-on')&&${A}._sourceCM.getValue()==='X^2^'&&${A}.settings.subscriptSuperscript`),
  { cmd: "view.source" },
  { eval: `${E}.setText(${q(source)});${A}._dirty=false;window.bridge.i18n.setLocale({locale:'zh-Hans'})` },
  { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  { assertMenu: { id: "command.inline.subscript", property: "label", eq: "下标", name: "Subscript is localized" } },
  { assertMenu: { id: "command.inline.superscript", property: "label", eq: "上标", name: "Superscript is localized" } },
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
console.log("Scripts report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Scripts native scenario failed");
assert.equal(await readFile(doc, "utf8"), source);
const html = new JSDOM(await readFile(path.join(dir, "enabled.html"), "utf8")).window.document;
assert.equal(html.querySelector("sub").textContent, "2"); assert.ok(html.querySelector("strong sup")); assert.ok(html.querySelector("sub s"));
assert.equal(new JSDOM(await readFile(path.join(dir, "disabled.html"), "utf8")).window.document.querySelector("sub,sup"), null);
for (const mode of ["disabled", "enabled"]) {
  const docx = spawnSync("unzip", ["-p", path.join(dir, mode + ".docx"), "word/document.xml"], { encoding: "utf8" });
  assert.equal(docx.status, 0);
  const xml = new JSDOM(docx.stdout, { contentType: "text/xml" }).window.document;
  const alignments = Array.from(xml.getElementsByTagName("w:vertAlign"), node => node.getAttribute("w:val"));
  if (mode === "disabled") {
    assert.equal(alignments.length, 0); assert.ok(xml.documentElement.textContent.includes("H~2~O"));
  } else {
    assert.ok(alignments.includes("subscript")); assert.ok(alignments.includes("superscript"));
    assert.ok(Array.from(xml.getElementsByTagName("w:r")).some(node => node.textContent === "small" && node.getElementsByTagName("w:strike").length && node.getElementsByTagName("w:vertAlign")[0]?.getAttribute("w:val") === "subscript"));
  }
}
assert.equal(JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8")).subscriptSuperscript, true);
console.log("PASS optional scripts, native typing, format toggles, rich paste, source mode and exports");
