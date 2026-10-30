import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";
import { IMPORT_FORMATS } from "../src/core/imports.js";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-imports-")), profile = path.join(dir, "profile"), output = path.join(dir, "output");
await mkdir(profile); await mkdir(output);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, openAfterExport: false, background: "light", locale: "en" }));
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]), result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length); body.copy(result, 4);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
};
const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
const pixels = Buffer.concat(Array.from({ length: 32 }, () => Buffer.from([0, ...Array.from({ length: 32 }, () => [220, 40, 30]).flat()])));
await writeFile(path.join(dir, "image.png"), Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]));
const fixture = "# Imported title\n\n**Bold** text with a [link](https://example.com).\n\n![red square](image.png)\n\n| Name | Value |\n| --- | --- |\n| One | Two |\n";
const originals = new Map();
for (const [extension, format] of Object.entries(IMPORT_FORMATS)) {
  const file = path.join(dir, "source." + extension);
  if (extension === "mdx") await writeFile(file, '# Imported title\n\n<Component name="demo" />\n\nMDX body.\n');
  else {
    const result = spawnSync("pandoc", ["--from=markdown", "--to=" + format, "--resource-path=" + dir, "--output", file], { input: fixture, encoding: "utf8", cwd: dir });
    assert.equal(result.status, 0, "Create " + extension + ": " + result.stderr);
  }
  originals.set(file, await readFile(file));
}
const broken = path.join(dir, "broken.docx"); await writeFile(broken, "not a Word archive"); originals.set(broken, await readFile(broken));
const failing = path.join(dir, "failing-pandoc");
await writeFile(failing, "#!/bin/sh\nout=''\nmedia=''\nprevious=''\nfor argument do\n  if [ \"$previous\" = '--output' ]; then out=\"$argument\"; fi\n  case \"$argument\" in --extract-media=*) media=\"${argument#--extract-media=}\" ;; esac\n  previous=\"$argument\"\ndone\nmkdir -p \"$media\"\nprintf 'partial image' > \"$media/partial.png\"\nprintf 'partial Markdown' > \"$out\"\nprintf 'conversion failed' >&2\nexit 4\n", { mode: 0o755 });
const protectedFile = path.join(output, "protected.md"); await writeFile(protectedFile, "Existing content");
await mkdir(path.join(output, "protected.assets")); await writeFile(path.join(output, "protected.assets", "keep.txt"), "Keep existing assets");
const review = path.join(dir, "review.md"); await writeFile(review, "Saved review");
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { open: review }, { focusWindow: true },
  { assertMenu: { id: "command.file.import", property: "label", eq: "Import…", name: "File menu offers Import" } },
  { eval: `${E}.setText('Unsaved review draft');${E}.root.focus();${E}.selectOffsets(3,8);${A}._dirty=true;window.__history=${E}._history.length;window.__selection=${E}.selectionOffsets();window.__imports={}` },
];
for (const [extension] of Object.entries(IMPORT_FORMATS)) {
  steps.push(check(extension + " converts to source-preserving Markdown", `(async()=>{const result=await window.bridge.document.import({sourcePath:${q(path.join(dir, "source." + extension))},destination:${q(path.join(output, extension + ".md"))}});window.__imports[${q(extension)}]=result;const saved=await window.bridge.document.read({path:result.path});const model=await import(new URL('../core/blocks.js',document.baseURI));return result.ok&&saved.text.includes('Imported title')&&model.blocksToMarkdown(model.parseBlocks(saved.text))===saved.text;})()`));
}
steps.push(
  check("conversions preserve the current dirty draft, selection and history", `${E}.getMarkdown()==='Unsaved review draft'&&${A}._dirty&&${E}._history.length===__history&&JSON.stringify(${E}.selectionOffsets())===JSON.stringify(__selection)`),
  check("Word import extracts its images beside the Markdown file", "!!__imports.docx.assets&&__imports.docx.assets.endsWith('/docx.assets')"),
  check("failed conversion preserves an existing destination and its assets", `(async()=>{try{await window.bridge.document.import({sourcePath:${q(path.join(dir, "source.docx"))},destination:${q(protectedFile)},replace:true,pandocPath:${q(failing)}});return false}catch{return (await window.bridge.document.read({path:${q(protectedFile)}})).text==='Existing content'}})()`),
  check("a malformed document leaves no partial output", `(async()=>{try{await window.bridge.document.import({sourcePath:${q(broken)},destination:${q(path.join(output, "broken.md"))}});return false}catch{return true}})()`),
  check("the native bridge rejects overwriting the import source", `(async()=>{try{await window.bridge.document.import({sourcePath:${q(path.join(dir, "source.mdx"))},destination:${q(path.join(dir, "source.mdx"))},replace:true});return false}catch(e){return e.message.includes('different from the source')}})()`),
  check("an existing destination requires an explicit replacement choice", `(async()=>{try{await window.bridge.document.import({sourcePath:${q(path.join(dir, "source.docx"))},destination:${q(protectedFile)}});return false}catch(e){return e.message.includes('already exists')}})()`),
  { eval: `window.__missingImport=null;void ${A}.importDocument(${q(path.join(dir, "source.docx"))},{destination:${q(path.join(output, "missing.md"))},pandocPath:'/nonexistent/pandoc',open:false}).then(result=>window.__missingImport=result)` },
  { waitFor: "!!document.querySelector('#confirm-choice-btns')" },
  check("missing Pandoc shows settings guidance", "document.querySelector('.alert-message').textContent.includes('Pandoc')&&!!document.querySelector('#confirm-choice-btns [data-choice=\"Settings…\"]')"),
  { click: '#confirm-choice-btns [data-choice="Cancel"]' },
  { waitFor: "window.__missingImport===false" },
  { cmd: "view.readonly" },
  check("readonly mode blocks import in the native host", `(async()=>{try{await window.bridge.document.import({sourcePath:${q(path.join(dir, "source.docx"))},destination:${q(path.join(output, "readonly.md"))}});return false}catch(e){return e.message.includes('Readonly')}})()`),
  { cmd: "view.readonly" },
  { eval: `window.__realImport=${A}.importDocument;window.__drops=[];${A}.importDocument=async(source,options={})=>{const destination=${q(output)}+'/drop-'+(__drops.length+1)+'.md';__drops.push({source,options,destination});return __realImport(source,{...options,destination,open:false})};${E}.root.focus();${E}.selectOffsets(0)` },
  { dropFiles: { paths: [path.join(dir, "source.docx")] } },
  check("the default editor drop inserts a link with undo", `${E}.getMarkdown().includes('[source.docx]')&&__drops.length===0`),
  { key: "Meta+Z" },
  check("undoing the dropped link restores the draft", `${E}.getMarkdown()`, "Unsaved review draft"),
  { cmd: "file.preferences" },
  { eval: "document.querySelector('[data-pane=general]').click();document.getElementById('pref-extra-editorFileDrop').value='import';document.getElementById('pref-extra-sidebarFileDrop').value='import';document.getElementById('preferences-done').click()" },
  { waitFor: `${A}.settings.editorFileDrop==='import'` },
  { dropFiles: { paths: [path.join(dir, "source.docx")] } },
  check("the opt-in editor drop converts without inserting into the draft", `__drops.length===1&&${E}.getMarkdown()==='Unsaved review draft'`),
  { dropFiles: { paths: [path.join(dir, "source.html")], x: 120, y: 300 } },
  check("a sidebar drop follows its independent import policy", "__drops.length===2"),
  { eval: `${A}.settings.sidebarFileDrop='ignore'` },
  { dropFiles: { paths: [path.join(dir, "source.org")], x: 120, y: 300 } },
  check("the sidebar ignore policy performs no conversion", "__drops.length===2"),
  { eval: `${A}.settings.sidebarFileDrop='import'` },
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { dropFiles: { paths: [path.join(dir, "source.org")] } },
  check("source-mode drops use the conversion policy without changing source", `__drops.length===3&&${A}._sourceCM.getValue()==='Unsaved review draft'`),
  { eval: `${A}.settings.editorFileDrop='link';${A}._sourceCM.setCursor({line:0,ch:0})` },
  { dropFiles: { paths: [path.join(dir, "source.org")] } },
  check("source-mode link drops insert source text", `${A}._sourceCM.getValue().includes('[source.org]')&&__drops.length===3`),
  { key: "Meta+Z" },
  check("source-mode link insertion participates in undo", `${A}._sourceCM.getValue()`, "Unsaved review draft"),
  { cmd: "view.source" },
  { eval: `${A}.settings.editorFileDrop='import';${A}.importDocument=__realImport;window.__nativeImport=window.bridge.document.import;window.bridge.document.import=payload=>__nativeImport({...payload,sourcePath:${q(path.join(dir, "source.docx"))},destination:${q(path.join(output, "opened.md"))}})` },
  { cmd: "file.import" },
  { waitFor: `${A}?._booted&&${A}.file===${q(path.join(output, "opened.md"))}` },
  check("the File menu opens the converted document in a new tab", `${E}.getMarkdown().includes('Imported title')&&!${A}._dirty`),
  { waitFor: `!!${E}.root.querySelector('.md-img-loaded')` },
  check("Word images and tables use supported Markdown syntax", `!!${E}.root.querySelector('.md-table')&&!${E}.getMarkdown().includes('{width=')&&!${E}.getMarkdown().includes('<figure>')`),
  { capture: "imported-word" },
  { switch: -1 },
  check("the previous tab keeps its unsaved draft", `${A}.file===${q(review)}&&${E}.getMarkdown()==='Unsaved review draft'&&${A}._dirty`),
  check("no renderer errors", "window.__lettrineStartupErrors", []),
);
const scenario = path.join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 150000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log); console.log("Imports report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Imports native scenario failed");
for (const [file, original] of originals) assert.deepEqual(await readFile(file), original, file + " remains untouched");
for (const extension of Object.keys(IMPORT_FORMATS)) {
  const text = await readFile(path.join(output, extension + ".md"), "utf8");
  assert.equal(blocksToMarkdown(parseBlocks(text)), text);
}
const word = await readFile(path.join(output, "docx.md"), "utf8");
assert.match(word, /!\[/); assert.ok((await readdir(path.join(output, "docx.assets", "media"))).some(file => file.endsWith(".png")));
assert.match(await readFile(path.join(output, "mdx.md"), "utf8"), /Component/);
assert.equal(await readFile(protectedFile, "utf8"), "Existing content");
assert.equal(await readFile(path.join(output, "protected.assets", "keep.txt"), "utf8"), "Keep existing assets");
for (const name of await readdir(output)) assert.ok(!name.startsWith(".lettrine-import-") && !["broken.md", "missing.md", "readonly.md", "protected.assets-2"].includes(name), name);
const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
assert.equal(settings.editorFileDrop, "import"); assert.equal(settings.sidebarFileDrop, "import");
console.log("PASS every import format, extracted images, atomic failures, drop policies, new tabs and source preservation");
