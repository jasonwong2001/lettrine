import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-sidebar-views-"));
const profile = path.join(dir, "profile"), library = path.join(dir, "Library"), nested = path.join(library, "Notes");
await mkdir(profile); await mkdir(nested, { recursive: true });
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", background: "light", welcomeShown: true }));
const source = "# Search\n\nFirst needle paragraph.\n\n## Details\n\nSecond needle paragraph.\n\n### End\n\nLast paragraph.";
const doc = path.join(library, "first.md"), second = path.join(nested, "second.qmd");
await writeFile(doc, source); await writeFile(second, "# Another\n\nA needle in a nested folder.");
const A = "window.__lettrine", E = A + ".editor", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { open: doc }, { eval: `${A}.openFolder(${q(library)})` },
  check("the sidebar offers Files and Outline and starts on the file tree", `${A}.sidebarView==='tree'&&[...document.querySelectorAll('[data-sidebar-view]')].map(tab=>tab.id).join()==='sidebar-view-files,sidebar-view-outline'&&document.getElementById('sidebar-view-files').getAttribute('aria-selected')==='true'&&document.getElementById('file-library-list').getAttribute('role')==='tree'&&document.getElementById('file-library-search-panel').hidden`),
  { capture: "files-light" },
  { cmd: "view.files" },
  check("View as List shows every document with folder and modification metadata", `${A}.sidebarView==='articles'&&document.getElementById('sidebar-view-files').getAttribute('aria-selected')==='true'&&document.querySelectorAll('#file-library-list [data-kind=file]').length===2&&!document.querySelector('#file-library-list [data-kind=folder]')&&[...document.querySelectorAll('.file-sub')].some(el=>el.textContent.includes('Notes')&&el.textContent.includes('Just now'))`),
  { capture: "articles-light" },
  { eval: "document.getElementById('sidebar-view-files').focus()" }, { key: "ArrowRight" },
  check("native keyboard input selects Outline, which replaces the folder row and files", `${A}.sidebarView==='outline'&&document.activeElement.id==='sidebar-view-outline'&&!document.getElementById('sidebar-outline').hidden&&document.querySelector('.library-head').hidden&&document.getElementById('file-library').hidden&&document.querySelectorAll('#sidebar-outline-content .outline-row').length===3&&document.getElementById('tb-outline').getAttribute('aria-pressed')==='true'`),
  { eval: "document.querySelectorAll('#sidebar-outline-content .outline-row')[1].click()" },
  check("sidebar heading clicks navigate without changing source or history", `${E}.caretInfo().blockIndex===2&&${E}.getMarkdown()===${q(source)}&&${E}._history.length===1`),
  { eval: `window.__firstOutlineRow=document.querySelector('#sidebar-outline-content .outline-row');${E}.replaceRange(${source.indexOf("First needle paragraph.")},${source.indexOf("First needle paragraph.")},'Extra paragraph.\\n\\n')` },
  { waitFor: "document.querySelectorAll('#sidebar-outline-content .outline-row')[1].dataset.block==='3'" },
  check("ordinary edits retain outline rows and update their target positions", "document.querySelector('#sidebar-outline-content .outline-row')===window.__firstOutlineRow"),
  { key: "Meta+Z" },
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: "document.querySelectorAll('#sidebar-outline-content .outline-row')[2].click()" },
  check("sidebar headings navigate in Source Code Mode", `${A}._sourceCM.indexFromPos(${A}._sourceCM.getCursor())===${E}.blockStart(4)&&document.querySelectorAll('#sidebar-outline-content .outline-row')[2].classList.contains('current')`),
  { cmd: "view.readonly" },
  { eval: "document.querySelector('#sidebar-outline-content .outline-row').click()" },
  check("readonly preserves navigation and exact Markdown", `${A}._sourceCM.getCursor().line===0&&${A}._sourceCM.getValue()===${q(source)}`),
  { cmd: "view.readonly" }, { cmd: "view.source" },
  { capture: "outline-light" },
  { cmd: "edit.findInFiles" }, { type: "needle" },
  { waitFor: "document.querySelectorAll('#file-library-search-result .search-match-row').length>=2" },
  check("folder search replaces the folder row with its field and shows real content results", `${A}.sidebarView==='search'&&document.getElementById('sidebar-view-files').getAttribute('aria-selected')==='true'&&!document.getElementById('file-library-search-panel').hidden&&document.querySelector('.library-head').hidden&&!document.getElementById('file-library-search').hidden&&document.getElementById('file-library').hidden&&document.getElementById('sidebar-outline').hidden`),
  { capture: "search-light" },
  { key: "Escape" },
  check("Escape ends the search and returns to the outline it started from", `${A}.sidebarView==='outline'&&document.getElementById('file-library-search-input').value===''&&document.getElementById('file-library-search-panel').hidden`),
  { click: "#sidebar-view-files" },
  check("a pointer click on Files returns to the list", `${A}.sidebarView==='articles'&&!document.querySelector('.library-head').hidden&&!document.getElementById('file-library').hidden`),
  { click: "#library-search-btn" }, { type: "needle" },
  { waitFor: "document.querySelectorAll('#file-library-search-result .search-match-row').length>=2" },
  { click: "#file-library-search-close" },
  check("Close Search discards the query and returns to the list", `${A}.sidebarView==='articles'&&document.getElementById('file-library-search-input').value===''&&!document.querySelector('.search-match-row')&&!document.getElementById('file-library').hidden`),
  { cmd: "view.outline" }, { window: "new" },
  check("a new window starts with the last sidebar view chosen and no search", `${A}.sidebarView==='outline'&&!document.getElementById('sidebar-outline').hidden&&document.getElementById('file-library-search-input').value===''`),
  { cmd: "view.tree" },
  { eval: "window.bridge.setting.put({key:'__patch',value:{showWordCount:false}})" },
  { tab: "close" },
  check("settings from another window do not overwrite the original sidebar view", `${A}.file===${q(doc)}&&${A}.sidebarView==='outline'&&!document.getElementById('sidebar-outline').hidden`),
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  check("sidebar tabs and search are localized while user heading text remains literal", "document.getElementById('sidebar-view-files').textContent==='文件'&&document.getElementById('sidebar-view-outline').textContent==='大纲'&&document.getElementById('library-search-btn').title==='在文件夹中搜索（⇧⌘F）'&&document.getElementById('file-library-search-close').title==='关闭搜索'&&document.querySelector('#sidebar-outline-content .outline-row').textContent==='Search'"),
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" }, { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "outline-dark" },
  check("sidebar navigation preserves exact source and clean startup", `${E}.getMarkdown()===${q(source)}&&!${A}._dirty&&window.__lettrineStartupErrors.length===0`),
];
const scenario = path.join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timer);
await writeFile(path.join(dir, "native.log"), log); console.log("Sidebar views report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Native sidebar views failed"); assert.ok(report.every(item => item.ok));
assert.equal(await readFile(doc, "utf8"), source);
console.log("PASS Files and Outline sidebar, native keyboard and pointer navigation, live outline targets, source and readonly navigation, on-demand folder search, per-window memory, localization and themes");
