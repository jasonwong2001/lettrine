// Real files from all export targets, long document images, and saved settings.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-export-surface-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, openAfterExport: false, background: "light", locale: "en" }));
const tour = await readFile(path.join(root, "examples/hello.md"), "utf8");
const text = [tour, ...Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: whole-document exports keep every paragraph beyond the first screen. 全文导出保留每一段内容。`), "![Last image](bottom.svg)"].join("\n\n");
await writeFile(path.join(dir, "bottom.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="70"><rect width="180" height="70" fill="#e63224"/></svg>');
const doc = path.join(dir, "tour.md");
await writeFile(doc, text);
const A = "window.__lettrine", E = `${A}.editor`, quoted = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const out = (ext) => path.join(dir, "document." + ext);
const formats = ["md", "html", "pdf", "docx", "odt", "rtf", "epub", "latex", "mediawiki", "rst", "textile", "opml"];
const steps = [
  { open: doc }, { focusWindow: true },
  { eval: `window.__original=${E}.getMarkdown();window.__history=${E}._history.length;window.__shots={};window.__imageExport=window.bridge.export.image;window.bridge.export.image=async p=>(window.__imageResult=await __imageExport(p));window.__inspect=async(file,type)=>{const resource=await window.bridge.native.invoke('native.resource',{path:file});const image=new Image();image.src='data:image/'+type+';base64,'+resource.data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;let bottomRed=0;for(let y=canvas.height-240;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(pixels[i]>180&&pixels[i+1]<90&&pixels[i+2]<90)bottomRed++;}return {width:canvas.width,height:canvas.height,bg:Array.from(pixels.slice(0,4)),bottomRed};};true` },
  ...Object.entries({ image: "Image…", mediawiki: "MediaWiki", rst: "reStructuredText", textile: "Textile", opml: "OPML", previous: "Export with Previous Settings" }).map(([name, label]) => ({ assertMenu: { id: "command.file.export." + name, property: "label", eq: label, name: "Export menu exposes " + name } })),
  ...formats.map((format) => check("tour exports as " + format, `${A}.doExport(${quoted(format)},${quoted(out(({ latex: "tex", mediawiki: "wiki" })[format] || format))})`)),
  { eval: "window.bridge.clipboard.write({text:'Preserve clipboard while exporting'})" },
  check("the whole document exports as a 1x PNG", `${A}.doExport('png',${quoted(out("png"))},{scale:1})`),
  { eval: `(async()=>{__shots.png=await __inspect(${quoted(out("png"))},'png');return __shots.png;})()` },
  check("the PNG includes content and the image at the bottom of a long document", "__shots.png.height>innerHeight*3&&__shots.png.bottomRed>10000&&__shots.png.width===__imageResult.pixelWidth&&__shots.png.height===__imageResult.pixelHeight"),
  check("the whole document exports as a 2x dark JPEG", `${A}.doExport('jpg',${quoted(out("jpg"))},{scale:2,theme:'lettrine-dark',dark:true})`),
  { eval: `(async()=>{__shots.jpg=await __inspect(${quoted(out("jpg"))},'jpeg');return __shots.jpg;})()` },
  check("JPEG has double dimensions, an opaque dark background and the final image", "__shots.jpg.width===__shots.png.width*2&&__shots.jpg.height===__shots.png.height*2&&__shots.jpg.bg[0]<40&&__shots.jpg.bg[3]===255&&__shots.jpg.bottomRed>40000"),
  check("image exports leave clipboard contents unchanged", "(async()=>{const content=await window.bridge.native.invoke('clipboard.readContent');return content.text==='Preserve clipboard while exporting'&&!content.hasImage;})()"),
  check("unsuitable image dimensions fail without overwriting an existing file", `(async()=>{try{await window.bridge.native.invoke('export.image',{path:${quoted(out("png"))},html:'<article id="write" style="height:40000px">Too tall</article>',scale:2,format:'png'});return false;}catch(error){return error.message.includes('too large');}})()`),
  check("export cannot overwrite the source document", `(async()=>{try{await window.bridge.export.md({path:${quoted(doc)},text:'Wrong file'});return false;}catch(error){return error.message.includes('source document');}})()`),
  check("HTML without styles saves its exact options", `${A}.doExport('html',${quoted(out("unstyled.html"))},{style:false})`),
  { eval: `${A}.settings.fontSize=24;window.__repeatResult=null;void ${A}.exportPrevious().then(value=>window.__repeatResult=value);true` },
  { waitFor: "!!document.querySelector('#confirm-choice-btns [data-choice=Cancel]')" },
  { eval: "document.querySelector('#confirm-choice-btns [data-choice=Cancel]').click()" },
  { waitFor: "__repeatResult===false" },
  { cmd: "file.export.previous" },
  { waitFor: "!!document.querySelector('#confirm-choice-btns [data-choice=Replace]')" },
  { eval: "document.querySelector('#confirm-choice-btns [data-choice=Replace]').click()" },
  { waitFor: `!document.querySelector('#confirm-choice-btns')&&${A}.settings.lastExport.format==='html'` },
  { sleep: 300 },
  check("export remembers its folder, destination, original typography and style", `${A}.settings.lastExportFolder===${quoted(dir)}&&${A}.settings.lastExport.path===${quoted(out("unstyled.html"))}&&${A}.settings.lastExport.options.style===false&&${A}.settings.lastExport.options.settings.fontSize!==24`),
  check("export leaves source, undo history and dirty state intact", `${E}.getMarkdown()===__original&&${E}._history.length===__history&&!${A}._dirty`),
  check("no renderer errors", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log("Export surface report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Export surface native scenario failed");
assert.equal(await readFile(doc, "utf8"), text);
assert.equal(await readFile(out("md"), "utf8"), text);
for (const format of ["docx", "odt", "epub"]) {
  const file = out(format), bytes = await readFile(file);
  assert.equal(bytes.subarray(0, 2).toString(), "PK");
  assert.equal(spawnSync("unzip", ["-t", file]).status, 0);
}
assert.match(await readFile(out("wiki"), "utf8"), /= Welcome to Lettrine =/);
assert.match(await readFile(out("rst"), "utf8"), /Welcome to Lettrine\n=+/);
assert.match(await readFile(out("textile"), "utf8"), /^h1(?:\([^)]+\))?\. Welcome to Lettrine/m);
assert.match(await readFile(out("opml"), "utf8"), /<opml version="2.0">/);
assert.match(await readFile(out("tex"), "utf8"), /\\documentclass/);
assert.match(await readFile(out("rtf"), "utf8"), /\\rtf1/);
assert.equal((await readFile(out("png"))).readUInt32BE(16), 892);
const unstyled = new JSDOM(await readFile(out("unstyled.html"), "utf8"));
const document = unstyled.window.document;
assert.equal(document.querySelectorAll('head style, link[rel~="stylesheet"]').length, 0, "unstyled HTML omits document and theme styles");
assert.ok(document.querySelector(".md-diagram svg style")?.textContent.trim(), "unstyled HTML retains Mermaid's SVG styles");
for (const style of document.querySelectorAll("style")) assert.ok(style.closest("svg")?.closest(".md-diagram"), "only diagram SVGs contain styles");
unstyled.window.close();
const settings = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
assert.equal(settings.lastExport.path, out("unstyled.html"));
assert.equal(settings.lastExport.options.style, false);
console.log("PASS all tour formats, whole-document images and persistent export settings");
