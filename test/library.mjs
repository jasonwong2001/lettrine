import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-library-"));
const library = path.join(dir, "Library"), profile = path.join(dir, "profile");
await mkdir(library); await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, restoreSession: false, welcomeShown: true, locale: "en", background: "light" }));
// More than the old 5,000-entry cap, with enough text to exercise cancellation.
for (let group = 0; group < 26; group++) {
  const folder = path.join(library, `Group ${group}`);
  await mkdir(folder);
  await Promise.all(Array.from({ length: 200 }, (_, index) => writeFile(path.join(folder, `Paper ${group * 200 + index}.md`), "# Paper\n\n" + "Ordinary document text.\n".repeat(80))));
}
const anchor = path.join(dir, "anchor.md"), removed = path.join(library, "removed.md"), external = path.join(library, "external.md");
const cases = path.join(library, "Cases.md"), signal = path.join(dir, "external-delete.signal");
await writeFile(anchor, "# Keep this tab\n");
await writeFile(removed, "# Remove this tab\n");
await writeFile(external, "# Deleted outside the app\n");
await writeFile(cases, "\r\nAlpha needle.\r\n\r\nNEEDLE in uppercase.\r\nneedles must not match whole words.\r\n中文检索。\r\n");
const A = "window.__lettrine", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const search = (text, options = {}) => `window.bridge.search.query(${q({ folder: library, text, ...options })})`;
const steps = [
  { open: anchor },
  { eval: `${A}.openFolder(${q(library)})` },
  check("large libraries include documents beyond the old entry cap", `${A}.files.filter(file=>!file.isDirectory).length`, 5203),
  { eval: `window.__libraryTimes={};let start=performance.now();${A}.handleCommand('view.files');__libraryTimes.articlesMs=performance.now()-start` },
  check("Articles mounts a bounded window of rows", "document.querySelectorAll('#file-library-list [data-path]').length<80&&document.querySelector('#file-library-list [data-path]').getAttribute('aria-setsize')==='5203'"),
  { eval: "document.querySelector('#file-library-list [data-path]').focus()" },
  { key: "End" },
  check("native End reaches the final unmounted article", "document.activeElement.getAttribute('aria-posinset')==='5203'"),
  { key: "Home" },
  check("native Home returns to the first article", "document.activeElement.getAttribute('aria-posinset')==='1'"),
  { eval: "document.getElementById('sidebar-content').scrollTop=100000" },
  { waitFor: "Number(document.querySelector('#file-library-list [data-path]').dataset.index)>1000" },
  check("scrolling stays bounded and never truncates the collection", "document.querySelectorAll('#file-library-list [data-path]').length<80"),
  { cmd: "edit.findInFiles" }, { type: "needle", wait: 0 },
  { waitFor: "document.querySelectorAll('.search-match-row').length===2" },
  check("content search preserves exact CRLF line numbers", "[...document.querySelectorAll('.search-match-line')].map(el=>el.textContent)", ["2", "4"]),
  check("Close Search sits after the options at the right edge of its field", `(()=>{
    const field=document.getElementById('file-library-search-panel').getBoundingClientRect(),button=document.getElementById('file-library-search-close'),r=button.getBoundingClientRect(),options=document.querySelector('#file-library-search-panel .search-options').getBoundingClientRect();
    return !button.hidden&&r.left>=options.right&&field.right-r.right<10&&r.width>=20;
  })()`),
  { capture: "search-close-light" },
  { click: "#file-library-search-close" },
  check("Close Search cancels the search and returns to the files", "document.getElementById('file-library-search-input').value===''&&document.getElementById('file-library-search-panel').hidden&&!document.querySelector('.library-head').hidden&&!document.getElementById('file-library').hidden&&!document.querySelector('.search-match-row')"),
  { eval: `(async()=>{window.__streamed=[];window.bridge.on('search.results',result=>__streamed.push(result));window.__start=performance.now();const pending=${search("__no_match_lettrine__", { requestId: 801 })};await window.bridge.path.stat({path:${q(anchor)}});__libraryTimes.controlMs=performance.now()-__start;await window.bridge.search.stop();window.__cancelled=await pending;})()` },
  check("search cancellation releases obsolete work without blocking file requests", "__cancelled.cancelled===true&&__libraryTimes.controlMs<500"),
  check("case-sensitive whole-word search rejects substring and uppercase matches", `(async()=>{const result=await ${search("needle", { wholeWord: true, caseSensitive: true })};return result.contentMatches[0][1].map(hit=>hit.line);})()`, [2]),
  check("regular expressions retain line-based anchors", `(async()=>{const result=await ${search("^NEEDLE", { useRegexp: true, caseSensitive: true })};return result.contentMatches[0][1].map(hit=>hit.line);})()`, [4]),
  check("Unicode content search remains exact", `(async()=>{const result=await ${search("中文检索")};return result.contentMatches[0][1][0].line;})()`, 6),
  check("invalid patterns return a useful error", `(async()=>!!(await ${search("[", { useRegexp: true })}).error)()`),
  { eval: `(async()=>{const old=${search("__old_no_match__", { requestId: 802 })};const next=${search("Cases.md", { requestId: 803 })};const results=await Promise.all([old,next]);window.__replaced=results[0].cancelled===true&&results[1].nameMatches.includes('Cases.md');})()` },
  check("new queries replace previous scans and stream file names", "__replaced&&__streamed.some(result=>result.requestId===803&&result.nameMatches.includes('Cases.md'))"),
  { eval: `(async()=>{const opening=${A}.openFolder(${q(library)});${A}.closeFolder();await opening;})()` },
  check("Close Folder cannot be undone by a pending load", `${A}._libraryRoot===null&&${A}.files.length===0&&!!document.querySelector('.library-empty')`),
  check("closing a library clears its native search scope", "(async()=>{const result=await window.bridge.search.query({text:'needle'});return result.nameMatches.length===0&&result.contentMatches.length===0;})()"),
  { eval: `${A}.openFolder(${q(library)})` },
  { tab: "new" }, { open: removed },
  { eval: `window.bridge.library.renameFile({from:${q(removed)},name:'renamed.md'})` },
  { waitFor: `${A}.file===${q(path.join(library, "renamed.md"))}` },
  check("queued saves still follow a rename while their tab is open", `(async()=>{const result=await window.bridge.document.write({path:${q(removed)},text:'# Remove this tab\\n',followRenames:true});return result.path;})()`, path.join(library, "renamed.md")),
  { cmd: "file.undo" }, { waitFor: `${A}.file===${q(removed)}` },
  { eval: `void window.bridge.library.trashItem({path:${q(removed)}});true` },
  { assertDocuments: { name: "deleting the active Markdown closes its tab without an Untitled replacement", paths: [anchor] } },
  { cmd: "file.undo" },
  check("file undo restores the deleted document on disk", `(async()=>{const doc=await window.bridge.document.read({path:${q(removed)}});return doc.text;})()`, "# Remove this tab\n"),
  { tab: "new" }, { open: external }, { switch: -1 },
  { eval: `window.bridge.library.newFile({path:${q(signal)}})` },
  { assertDocuments: { name: "external deletion also removes the corresponding tab", paths: [anchor] } },
  check("the surviving document stays clean with its original content", `${A}.file===${q(anchor)}&&!${A}._dirty&&${A}.editor.getMarkdown()==='# Keep this tab\\n'`),
  { eval: "__libraryTimes" },
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
let externalChange, mutationError;
const watcher = watch(dir, (_, name) => {
  if (name === path.basename(signal) && !externalChange) externalChange = rm(external).catch(error => { mutationError = error; });
});
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout); watcher.close(); await externalChange; if (mutationError) throw mutationError;
await writeFile(path.join(dir, "native.log"), log);
console.log("Library report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Native library checks failed");
assert.deepEqual(JSON.parse(await readFile(path.join(dir, "external-actions.json"), "utf8")), []);
assert.equal(await readFile(anchor, "utf8"), "# Keep this tab\n");
