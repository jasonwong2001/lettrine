import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-app-behavior-")), profile = path.join(dir, "profile");
await mkdir(profile);
const settingsPath = path.join(profile, "settings.json"), sessionPath = path.join(profile, "session.json");
const defaults = { autosave: false, locale: "en", welcomeShown: true, background: "light", restoreSession: true, openRecentOnStart: true };
await writeFile(settingsPath, JSON.stringify(defaults));
const first = path.join(dir, "first.md"), second = path.join(dir, "second.md"), recent = path.join(dir, "recent.md"), savedDraft = path.join(dir, "draft.md");
const firstText = "# Session\n\nOriginal first.", secondText = "# Second\n\nOriginal second.", draftText = "# 草稿\n\n尚未保存 **内容**\n";
await writeFile(first, firstText); await writeFile(second, secondText); await writeFile(recent, "# Recent file");
await writeFile(path.join(profile, "recent-files.json"), JSON.stringify([recent]));
const A = "window.__lettrine", E = A + ".editor", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const { executable, args } = await resolveRuntime(root, process.argv[2]);
async function run(steps, suffix, options = {}) {
  const output = path.join(dir, suffix); await mkdir(output);
  const scenario = path.join(output, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
  const child = spawn(executable, [...args, "--user-data-dir=" + (options.profile || profile), "--lettrine-harness", scenario, "--lettrine-out", output, ...(process.env.LETTRINE_TEST_TRACE ? ["--lettrine-trace"] : []), ...(options.args || [])], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const record = data => { log += data; appendFileSync(path.join(output, "native.log"), data); };
  child.stdout.on("data", record); child.stderr.on("data", record);
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timer);
  await writeFile(path.join(output, "native.log"), log);
  const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
  assert.equal(code, 0, "Native app behavior failed: " + suffix); assert.ok(report.every(item => item.ok));
}
console.log("Application behavior report: " + dir);
await run([
  { open: first }, { cmd: "view.files" },
  { eval: `${E}.root.focus();${E}.selectOffsets(${firstText.length})` }, { type: " draft" },
  { tab: "new" }, { open: second }, { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor(${A}._sourceCM.posFromIndex(${secondText.length}));${A}._sourceCM.focus()` }, { type: " draft" },
  { eval: `${A}._sourceCM.setSelection({line:0,ch:2},{line:0,ch:8})` }, { cmd: "view.readonly" },
  { window: "new" },
  { eval: `${E}.setText(${q(draftText)});${A}._lineEndingOverride='CRLF';${E}.root.focus();${E}.selectOffsets(10);${E}.emit()` },
  check("untitled drafts are dirty before quitting", `${A}.file===null&&${A}._dirty&&${E}.getMarkdown()===${q(draftText)}`),
  { quit: true },
], "quit-with-drafts");
assert.equal(await readFile(first, "utf8"), firstText); assert.equal(await readFile(second, "utf8"), secondText);
const backup = await readFile(sessionPath), manifest = JSON.parse(backup);
assert.equal(manifest.version, 1);
assert.deepEqual(manifest.groups.map(group => group.documents.length), [2, 1], "native tabs stay in their window group");
assert.ok(manifest.groups.every(group => group.frame.length === 4));
assert.equal(manifest.groups.filter(group => group.active).length, 1);
assert.equal(manifest.groups[0].documents[0].text, firstText + " draft");
assert.equal(manifest.groups[0].documents[1].source, true);
assert.equal(manifest.groups[0].documents[1].readonly, true);
assert.equal(manifest.groups[1].documents[0].text, draftText);
assert.equal((await stat(sessionPath)).mode & 0o777, 0o600);
console.log("PASS an actual quit saves private local drafts, window frames, native tab groups and the active window without changing document files");

await run([
  check("relaunch restores the active untitled draft instead of the recent file", `${A}.file===null&&${A}._dirty&&${E}.getMarkdown()===${q(draftText)}&&${E}.selectionOffsets().start===10`),
  { switch: -1 },
  check("source mode, readonly and the selected range survive restart", `${A}.file===${q(second)}&&${E}.readOnly&&!!${A}._sourceCM&&${A}._sourceCM.getValue()===${q(secondText + " draft")}&&${A}._sourceCM.getSelection()==='Second'`),
  { switch: -1 },
  check("the first tab restores its file, draft and sidebar view", `${A}.file===${q(first)}&&${A}._dirty&&${A}.sidebarView==='articles'&&${E}.getMarkdown()===${q(firstText + " draft")}`),
  { eval: `${E}.root.focus();${E}.selectOffsets(${(firstText + " draft").length})` }, { type: " after restart" }, { key: "Meta+Z" },
  check("restored drafts support new native typing and undo", `${E}.getMarkdown()`, firstText + " draft"),
  { switch: -1 },
  { saveDialog: { cancel: true }, command: "file.saveAll" },
  check("cancelling an untitled Save As keeps its draft", `${A}.file===null&&${A}._dirty&&${E}.getMarkdown()===${q(draftText)}`),
  { eval: "(()=>{const save=window.bridge.window.save;window.bridge.window.save=async p=>{window.bridge.window.save=save;return save({...p,defaultPath:" + q(savedDraft) + "});};})()" },
  { saveDialog: { path: savedDraft }, command: "file.saveAll" },
  { waitFor: `${A}.file===${q(savedDraft)}&&!${A}._dirty` },
  { switch: -1 },
  check("Save All skips dirty readonly documents", `${A}.file===${q(second)}&&${A}._dirty&&${E}.readOnly`),
  { cmd: "view.readonly" }, { cmd: "file.saveAll" },
  { waitFor: `!${A}._dirty` },
  check("Save All saves Source Code Mode without changing its selection", `${A}._sourceCM.getSelection()`, "Second"),
  { switch: -1 }, check("Save All saved the first document and retained its selection", `${A}.file===${q(first)}&&!${A}._dirty&&${E}.getMarkdown()===${q(firstText + " draft")}`),
  { eval: "window.bridge.setting.put({key:'__patch',value:{restoreSession:false}})" },
  { waitFor: `!${A}.settings.restoreSession` }, { eval: "window.bridge.setting.get({key:'__patch'})" },
  { quit: true },
], "restore-and-save-all");
assert.equal(await readFile(first, "utf8"), firstText + " draft");
assert.equal(await readFile(second, "utf8"), secondText + " draft");
assert.equal(await readFile(savedDraft, "utf8"), draftText.replaceAll("\n", "\r\n"));
await assert.rejects(stat(sessionPath), { code: "ENOENT" });
console.log("PASS sequential Save All, native Save As cancellation/completion, readonly protection and disabling session storage");

await writeFile(sessionPath, backup); await writeFile(settingsPath, JSON.stringify(defaults));
await writeFile(first, "# Changed externally"); await rm(second);
await run([
  check("the untitled draft still restores after other files disappear", `${A}.file===null&&${E}.getMarkdown()===${q(draftText)}`),
  { switch: -1 },
  check("a missing file's dirty source is recovered as an untitled readonly draft", `${A}.file===null&&${A}._dirty&&${E}.readOnly&&${A}._sourceCM.getValue()===${q(secondText + " draft")}`),
  { switch: -1 },
  check("external edits detach the recovered draft instead of replacing disk content", `${A}.file===null&&${A}._dirty&&${E}.getMarkdown()===${q(firstText + " draft")}&&document.body.textContent.includes('Your draft was restored as an untitled document.')`),
  { cmd: "file.preferences" },
  check("session restore is exposed as a persistent startup preference", "document.getElementById('pref-extra-restoreSession').checked"),
  { key: "Escape" },
  check("session restoration leaves no startup errors", "window.__lettrineStartupErrors", []),
], "changed-and-missing-files");
assert.equal(await readFile(first, "utf8"), "# Changed externally");
await writeFile(settingsPath, JSON.stringify({ ...defaults, restoreSession: false }));
await writeFile(path.join(profile, "recent-files.json"), JSON.stringify([recent]));
await run([
  check("the simple recent-file option still opens only the recent file", `${A}.file===${q(recent)}&&${E}.getMarkdown()==='# Recent file'`),
  { cmd: "file.newWindow" }, check("a menu-created new window starts empty instead of reopening the recent file", `${A}.file===null&&${E}.getMarkdown()===''`),
  { switch: -1 }, check("the previous window retains its recent document", `${A}.file===${q(recent)}&&${E}.getMarkdown()==='# Recent file'`),
], "simple-recent");
await run([
  check("a command-line document takes priority over automatic recent-file opening", `${A}.file===${q(first)}&&${E}.getMarkdown()==='# Changed externally'`),
], "requested-file", { args: [first] });

const firstUseProfile = path.join(dir, "first-use-profile"); await mkdir(firstUseProfile);
await writeFile(path.join(firstUseProfile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", background: "light" }));
await run([
  check("an explicitly opened first-use file takes priority over the welcome guide", `${A}.file===${q(recent)}&&${E}.getMarkdown()==='# Recent file'`),
  { cmd: "file.newWindow" },
  check("new windows stay empty even when the welcome guide has never been shown", `${A}.file===null&&${E}.getMarkdown()===''`),
], "first-use-requested", { profile: firstUseProfile, args: [recent] });

await writeFile(sessionPath, backup); await writeFile(settingsPath, JSON.stringify(defaults));
await run([
  check("a requested document stays foreground alongside a restored session", `${A}.file===${q(recent)}&&${E}.getMarkdown()==='# Recent file'`),
  { switch: -1 },
  check("the previous session's active draft also remains open", `${A}.file===null&&${E}.getMarkdown()===${q(draftText)}`),
  { eval: "window.bridge.session.checkpoint()" },
], "requested-with-session", { args: [recent] });
assert.equal(JSON.parse(await readFile(sessionPath, "utf8")).groups.reduce((sum, group) => sum + group.documents.length, 0), 4);

async function sessionProfile(name, documents, extra = {}) {
  const location = path.join(dir, name); await mkdir(location);
  await writeFile(path.join(location, "settings.json"), JSON.stringify({ ...defaults, ...extra }));
  await writeFile(path.join(location, "session.json"), JSON.stringify({ version: 1, groups: [{ documents, selected: 0, active: true }] }));
  return location;
}
const clean = path.join(dir, "clean.md"), cleanText = "# Current\r\n\r\nOn disk.\r\n";
await writeFile(clean, cleanText);
const cleanProfile = await sessionProfile("clean-profile", [{ path: clean, lineEnding: "LF", source: false }], { sourceByDefault: true });
await run([
  check("clean restoration reads current CRLF disk contents and keeps the saved preview choice", `${A}.file===${q(clean)}&&!${A}._dirty&&${A}._lineEnding==='CRLF'&&!document.body.classList.contains('sourceview-on')&&${E}.getMarkdown()===${q(cleanText.replaceAll("\r\n", "\n"))}`),
  { eval: `${E}.root.focus();${E}.selectOffsets(${cleanText.replaceAll("\r\n", "\n").length})` }, { type: "tail" }, { save: true },
  check("saving a restored clean file uses its current detected line endings", `!${A}._dirty&&${A}._lineEnding==='CRLF'`),
], "clean-line-endings", { profile: cleanProfile });
assert.equal(await readFile(clean, "utf8"), cleanText + "tail");

const largeProfile = await sessionProfile("large-profile", [{ path: first }]);
await run([
  { sleep: 150 }, { eval: "window.bridge.session.checkpoint()" },
  { eval: `${E}.setText('文'.repeat(700000));${E}.emit()` },
  check("an oversized current draft cannot replace its recoverable session checkpoint", `(async()=>{try{await window.bridge.session.checkpoint();return false}catch(error){return error.message.includes('too large')&&${A}._dirty&&${E}.getMarkdown().length===700000}})()`),
], "oversized-checkpoint", { profile: largeProfile });
const largeManifest = JSON.parse(await readFile(path.join(largeProfile, "session.json"), "utf8"));
assert.equal(largeManifest.groups[0].documents[0].path, first);
assert.equal(largeManifest.groups[0].documents[0].text, undefined);
const oversizedText = "文".repeat(700000);
const recoveredProfile = await sessionProfile("recovered-profile", [{ path: first, text: oversizedText, savedText: "original", dirty: true }]);
await run([
  check("an oversized cached draft opens a recovered Markdown file through the large-file banner", `${A}.file.startsWith(${q(recoveredProfile + "/session-recovery/")})&&document.body.classList.contains('oversize')&&!${A}._dirty&&document.body.textContent.includes('was recovered to a Markdown file')`),
  { sleep: 150 }, { eval: "window.bridge.session.checkpoint()" },
], "oversized-recovery", { profile: recoveredProfile });
const recoveredManifest = JSON.parse(await readFile(path.join(recoveredProfile, "session.json"), "utf8"));
const recoveredFile = recoveredManifest.groups[0].documents[0].path;
assert.equal(await readFile(recoveredFile, "utf8"), oversizedText);
assert.equal((await stat(recoveredFile)).mode & 0o777, 0o600);
assert.equal(await readFile(first, "utf8"), "# Changed externally");
console.log("PASS explicit startup files coexist with sessions, clean CRLF files retain current disk metadata, and oversized drafts remain recoverable");

const failureProfile = path.join(dir, "failure-profile"); await mkdir(failureProfile);
await writeFile(path.join(failureProfile, "settings.json"), JSON.stringify(defaults)); await mkdir(path.join(failureProfile, "session.json"));
await run([
  { open: first }, { eval: `${E}.root.focus();${E}.selectOffsets(${("# Changed externally").length})` }, { type: " safe draft" },
  check("checkpoint failure is reported while preserving the current unsaved document", `(async()=>{try{await window.bridge.session.checkpoint();return false}catch{return ${A}._dirty&&${E}.getMarkdown()==='# Changed externally safe draft'}})()`),
], "checkpoint-failure", { profile: failureProfile });
console.log("PASS session restore and Save All across actual quits/restarts, native tabs/windows, drafts, source selections, new undo, missing/external files, startup precedence and write failure");
