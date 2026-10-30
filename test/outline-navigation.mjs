import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-outline-navigation-")), profile = path.join(dir, "profile");
await mkdir(profile); await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", welcomeShown: true, background: "light" }));
const source = "# First\n\nParagraph one.\n\n## Second\n\nParagraph two.\n\n### Third\n\nParagraph three.", doc = path.join(dir, "outline.md");
await writeFile(doc, source);
const A = "window.__lettrine", E = A + ".editor", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const { executable, args } = await resolveRuntime(root, process.argv[2]);
async function run(steps, suffix) {
  const output = path.join(dir, suffix); await mkdir(output);
  const scenario = path.join(output, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
  const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", output], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timer);
  await writeFile(path.join(output, "native.log"), log);
  const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
  assert.equal(code, 0, "Native outline navigation failed: " + suffix); assert.ok(report.every(item => item.ok));
}
console.log("Outline navigation report: " + dir);
await run([
  { open: doc }, { cmd: "view.toggleSidebar" },
  check("the check starts with the sidebar hidden", "document.body.classList.contains('sidebar-hidden')"),
  { eval: `${E}.root.focus();${E}.selectOffsets(${source.indexOf("Paragraph two.")})` },
  { cmd: "view.outline" },
  check("the outline command opens the hidden sidebar on the outline and marks the caret's section", `({open:!document.body.classList.contains('sidebar-hidden'),view:${A}.sidebarView,pressed:document.getElementById('tb-outline').getAttribute('aria-pressed'),current:document.querySelector('#sidebar-outline-content .outline-row.current')?.textContent})`, { open: true, view: "outline", pressed: "true", current: "Second" }),
  { capture: "outline-light" },
  { eval: "document.querySelector('#sidebar-outline-content .outline-row.current').focus()" }, { key: "ArrowUp" }, { key: "Enter" },
  check("native keyboard heading jumps preserve the document and its history", `${E}.caretInfo().blockIndex===0&&${E}.getMarkdown()===${q(source)}&&${E}._history.length===1`),
  { cmd: "view.outline" },
  check("the outline command hides the sidebar it opened", "document.body.classList.contains('sidebar-hidden')&&document.getElementById('tb-outline').getAttribute('aria-pressed')==='false'"),
  { cmd: "view.toggleSidebar" }, { cmd: "view.tree" }, { cmd: "view.outline" },
  check("from the files, the outline command shows the outline", `${A}.sidebarView==='outline'&&!document.getElementById('sidebar-outline').hidden&&document.getElementById('file-library').hidden`),
  { cmd: "view.outline" },
  check("and then returns to the files", `${A}.sidebarView==='tree'&&!document.body.classList.contains('sidebar-hidden')&&!document.getElementById('file-library').hidden`),
  { cmd: "view.outline" }, { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor(${A}._sourceCM.posFromIndex(${source.indexOf("Paragraph three.")}));${A}._sourceCM.focus()` },
  { waitFor: "document.querySelector('#sidebar-outline-content .outline-row.current')?.textContent==='Third'" },
  check("the outline tracks Source Code Mode's current section", "document.querySelector('#sidebar-outline-content .outline-row.current').textContent", "Third"),
  { eval: "document.querySelectorAll('#sidebar-outline-content .outline-row')[1].click()" },
  check("outline links jump to exact source offsets", `${A}._sourceCM.indexFromPos(${A}._sourceCM.getCursor())===${E}.blockStart(2)`),
  { cmd: "view.readonly" },
  { eval: "document.querySelector('#sidebar-outline-content .outline-row').click()" },
  check("readonly keeps outline navigation available", `${A}._sourceCM.getCursor().line===0&&${A}._sourceCM.getValue()===${q(source)}`),
  { cmd: "view.readonly" }, { cmd: "view.source" },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hant'})" }, { waitFor: `${A}.i18n.locale==='zh-Hant'` },
  check("outline controls are localized", "document.getElementById('sidebar-view-outline').textContent==='大綱'&&document.getElementById('tb-outline').title==='大綱（⌃⌘O）'"),
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" }, { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "outline-dark" },
  { eval: `${E}.setText('No headings here.');${E}.emit();${A}._savedText=${E}.getMarkdown()` },
  { waitFor: "!!document.querySelector('#sidebar-outline-content .empty-state')" },
  check("documents without headings have a localized empty state", "document.querySelector('#sidebar-outline-content .empty-state strong').textContent", "沒有標題"),
  check("outline navigation leaves no startup errors", "window.__lettrineStartupErrors", []),
], "editing");
await run([
  { open: doc }, { waitFor: "document.querySelectorAll('#sidebar-outline-content .outline-row').length===3" },
  check("the sidebar's outline view survives an actual application restart", `${A}.settings.sidebarOutline&&${A}.sidebarView==='outline'&&!document.body.classList.contains('sidebar-hidden')`),
], "relaunch");
assert.equal(await readFile(doc, "utf8"), source);
console.log("PASS sidebar outline, an outline toggle that restores the sidebar, current section, native keyboard jumps, source mode, readonly, localization, themes and restart");
