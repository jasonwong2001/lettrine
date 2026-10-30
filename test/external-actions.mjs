// Exercise real native external-action routing without launching other apps.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-external-actions-"));
const profile = path.join(dir, "profile"), doc = path.join(dir, "source.md");
const exported = path.join(dir, "document.html"), image = path.join(dir, "image.svg"), local = path.join(dir, "local.rtf");
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const application = path.dirname(path.dirname(path.dirname(executable)));
await mkdir(profile); await mkdir(path.join(profile, "themes"));
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, restoreSession: false, locale: "en", openAfterExport: true, revealAfterExport: true, otherEditor: application }));
await writeFile(doc, "# External action fixture");
await writeFile(image, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>');
await writeFile(local, "{\\rtf1 Local external application fixture}");
const q = JSON.stringify, A = "window.__lettrine";
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { open: doc },
  check("export succeeds with both open and reveal enabled", `${A}.doExport('html',${q(exported)})`),
  check("system file open is intercepted", `(async()=> (await window.bridge.path.openFile({path:${q(local)},useSystem:true})).ok)()`),
  check("configured editor open is intercepted", `(async()=> (await window.bridge.path.openFile({path:${q(local)}})).ok)()`),
  check("browser open is intercepted", "(async()=> (await window.bridge.shell.openExternal({url:'https://example.com/browser'})).ok)()"),
  check("mail application open is intercepted", "(async()=> (await window.bridge.path.openURL({url:'mailto:fixture@example.com'})).ok)()"),
  check("local non-Markdown links are intercepted", `(async()=> (await window.bridge.path.openURL({url:${q(pathToFileURL(local).href)}})).ok)()`),
  check("image previews are intercepted", `(async()=> (await window.bridge.images.open({url:${q(image)}})).ok)()`),
  { eval: "window.bridge.native.invoke('theme.openFolder')" },
  { eval: "window.bridge.native.invoke('word.openDictionarySettings')" },
  check("internal document links still return their Markdown destination", `(async()=> (await window.bridge.path.openURL({url:${q(pathToFileURL(doc).href)}})).path)()`, doc),
  check("unsupported URL schemes still fail", "(async()=>{try{await window.bridge.shell.openExternal({url:'javascript:alert(1)'});return false;}catch(error){return error.message.includes('Unsupported URL scheme');}})()"),
  check("the source document remains unchanged", `${A}.editor.getMarkdown()`, "# External action fixture"),
  check("no renderer errors", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 45000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log("External action report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Native external action isolation failed");
assert.match(await readFile(exported, "utf8"), /External action fixture/);
const actions = JSON.parse(await readFile(path.join(dir, "external-actions.json"), "utf8"));
assert.equal(actions.length, 10, "all external requests are recorded");
assert.ok(actions.every((action) => action.intercepted === true), "no external request reaches the system");
const matches = (operation, url) => actions.filter((action) => action.operation === operation && action.url === url);
assert.equal(matches("open", pathToFileURL(exported).href).length, 1);
assert.equal(matches("reveal", pathToFileURL(exported).href).length, 1);
assert.equal(matches("open", pathToFileURL(local).href).length, 3);
assert.ok(actions.some((action) => action.application === application));
for (const url of [pathToFileURL(image).href, "https://example.com/browser", "mailto:fixture@example.com", "x-apple.systempreferences:com.apple.Keyboard-Settings.extension"]) assert.equal(matches("open", url).length, 1);
assert.ok(actions.some((action) => action.operation === "open" && action.url.startsWith("file:") && path.resolve(fileURLToPath(action.url)) === path.join(profile, "themes")));
console.log("PASS exports and external actions are recorded without opening other apps");
