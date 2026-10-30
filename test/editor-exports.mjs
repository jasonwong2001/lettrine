// Export coverage lives separately from the everyday native editing scenario.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-editor-exports-"));
const profile = path.join(dir, "profile"), doc = path.join(dir, "source.md");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, restoreSession: false, openAfterExport: false, revealAfterExport: false, locale: "en" }));
await writeFile(doc, "# Saved source\n\nOriginal content");
const text = "# Immediate source save\n\nSave 中文 immediately after editing.\n\n| A | B |\n| :--- | ---: |\n| x | y |\n";
const formats = ["pdf", "html", "docx", "epub", "rtf", "odt", "latex"];
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const out = (format) => path.join(dir, "document." + format);
const steps = [
  { open: doc },
  { eval: `window.bridge.export.screenshotHTML({path:${q(out("view.html"))},title:'Current editor view'})` },
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setValue(${q(text)});${A}.settings.pdfAuthor='Test author';window.__history=${E}._history.length;true` },
  ...formats.flatMap((format) => [
    check(format + " export succeeds from an unsaved source view", `${A}.doExport(${q(format)},${q(out(format))})`),
    check(format + " export preserves the mounted source editor and unsaved content", `document.body.classList.contains('sourceview-on')&&${A}._sourceCM?.getValue()===${q(text)}&&${A}._dirty&&${E}._history.length===__history`),
  ]),
  { cmd: "edit.undo" },
  check("exporting preserves source undo history", `${A}._sourceCM.getValue()`, "# Saved source\n\nOriginal content"),
  check("no renderer errors", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 120000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log("Editor export report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Source view export scenario failed");
assert.equal(await readFile(doc, "utf8"), "# Saved source\n\nOriginal content");
assert.match(await readFile(out("view.html"), "utf8"), /src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
const pdf = await PDFDocument.load(await readFile(out("pdf")));
assert.equal(pdf.getAuthor(), "Test author"); assert.equal(pdf.getCreator(), "Lettrine"); assert.ok(pdf.getPageCount() >= 1);
assert.match(await readFile(out("html"), "utf8"), /Immediate source save/);
for (const format of ["docx", "epub", "rtf", "odt", "latex"]) {
  const data = await readFile(out(format));
  assert.ok(data.length > 30, format + " export has content");
  if (["docx", "epub", "odt"].includes(format)) assert.equal(data.subarray(0, 2).toString(), "PK");
  if (format === "rtf") assert.match(data.toString(), /^\{\\rtf/);
  if (format === "latex") assert.match(data.toString(), /\\(?:section|subsection)/);
}
assert.deepEqual(JSON.parse(await readFile(path.join(dir, "external-actions.json"), "utf8")), []);
