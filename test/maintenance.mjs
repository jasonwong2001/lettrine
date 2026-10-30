import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import http from "node:http";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-maintenance-"));
const A = "window.__lettrine", E = A + ".editor", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const requests = [];
let origin;
const item = (build, extra = "") => `<item><link>${origin}/download</link><enclosure sparkle:version="${build}" sparkle:shortVersionString="${build}" sparkle:os="macos" url="${origin}/archive.zip"/>${extra}</item>`;
const feed = items => `<?xml version="1.0"?><rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>${items}</channel></rss>`;
const server = http.createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  requests.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() });
  response.setHeader("Set-Cookie", "tracking=must-not-return; Path=/");
  if (request.url === "/feed-latest") response.end(feed(
    item("99.9.0") + item("99.10.0") +
    item("200.0.0", "<sparkle:minimumSystemVersion>999.0</sparkle:minimumSystemVersion>") +
    item("300.0.0", "<sparkle:channel>beta</sparkle:channel>") +
    item("400.0.0", "<sparkle:maximumSystemVersion>12.0</sparkle:maximumSystemVersion>") +
    item("500.0.0-beta") +
    '<item><link>' + origin + '/download</link><sparkle:version>600.0.0</sparkle:version><enclosure sparkle:os="windows" url="' + origin + '/windows.zip"/></item>'
  ));
  else if (request.url === "/feed-current") response.end(feed(item("0.1.0")));
  else if (request.url === "/feed-invalid") response.end('<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///etc/passwd">]><rss>&external;</rss>');
  else if (request.url === "/feed-url") response.end(feed('<item><link>javascript:alert(1)</link><sparkle:version>100.0.0</sparkle:version></item>'));
  else if (request.url === "/feed-redirect" || request.url === "/report-redirect") { response.writeHead(302, { Location: origin + "/must-not-follow" }); response.end(); }
  else if (request.url === "/feed-large") response.end("x".repeat(1024 * 1024 + 1));
  else if (request.url === "/feed-error") { response.writeHead(503); response.end("temporarily unavailable"); }
  else if (request.url === "/report") { response.writeHead(204); response.end(); }
  else response.end("fixture");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
origin = "http://127.0.0.1:" + server.address().port;
const count = target => requests.filter(request => request.url === target).length;
async function profile(name, extra = {}) {
  const location = path.join(dir, name); await mkdir(location);
  await writeFile(path.join(location, "settings.json"), JSON.stringify({ autosave: false, locale: "en", welcomeShown: true, background: "light", ...extra }));
  return location;
}
async function run(steps, suffix, options = {}) {
  const output = path.join(dir, suffix); await mkdir(output);
  const scenario = path.join(output, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
  const fixtureArgs = [];
  if (options.feed || options.services) {
    const config = path.join(output, "services.json");
    await writeFile(config, JSON.stringify(options.services || { updateFeedURL: origin + options.feed, usageReportURL: origin + (options.report || "/report"), privacyURL: origin + "/privacy" }));
    fixtureArgs.push("--lettrine-maintenance-fixture", config);
  }
  const child = spawn(executable, [...args, "--user-data-dir=" + options.profile, "--lettrine-harness", scenario, "--lettrine-out", output, ...fixtureArgs], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 90000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timer);
  await writeFile(path.join(output, "native.log"), log);
  const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  for (const result of report.filter(result => result.op === "assert" || result.ok === false)) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name || result.error}`);
  assert.equal(code, 0, "Native maintenance failed: " + suffix); assert.ok(report.every(result => result.ok));
}
console.log("Maintenance report (loopback fixtures only): " + dir);
try {
  await run([
    check("an unconfigured build has no maintenance endpoints", `${A}.maintenance.updates===false&&${A}.maintenance.reporting===false`),
    { cmd: "file.preferences" },
    check("automatic checks and reporting are off and unavailable services are disabled", "!document.getElementById('pref-extra-checkUpdatesAutomatically').checked&&!document.getElementById('pref-extra-anonymousUsageReports').checked&&document.getElementById('pref-extra-anonymousUsageReports').disabled&&document.getElementById('pref-check-updates').disabled"),
    { key: "Escape" },
    check("an unconfigured build cannot send a usage report", "(async()=>!(await window.bridge.app.reportUsage()).sent)()"),
  ], "development", { profile: await profile("development-profile"), services: {} });
  assert.equal(requests.length, 0);

  await run([
    check("a release without services exposes only its releases page", `!${A}.maintenance.updates&&!${A}.maintenance.reporting&&${A}.maintenance.releasesURL===${q(origin + "/releases")}`),
    { cmd: "app.checkUpdates" },
    { cmd: "file.preferences" },
    check("Settings explains the releases page instead of showing unavailable services", "!document.getElementById('pref-maintenance-releases').hidden&&document.getElementById('pref-maintenance-unavailable').hidden&&document.querySelector('#preferences-dialog [data-pref-group=\"general-maintenance\"]').hidden&&document.getElementById('pref-privacy').hidden&&!document.getElementById('pref-check-updates').disabled"),
    { key: "Escape" },
  ], "releases", { profile: await profile("releases-profile"), services: { releasesURL: origin + "/releases" } });
  const opened = JSON.parse(await readFile(path.join(dir, "releases", "external-actions.json"), "utf8"));
  assert.ok(opened.some(action => action.operation === "open" && action.url === origin + "/releases" && action.intercepted), "Check for Updates opens the releases page");
  assert.equal(requests.length, 0);
  console.log("PASS Check for Updates opens the releases page without Lettrine contacting it");

  const configured = await profile("configured-profile");
  await run([
    check("configured release services are exposed without enabling them", `${A}.maintenance.updates&&${A}.maintenance.reporting&&!${A}.settings.anonymousUsageReports&&!${A}.settings.checkUpdatesAutomatically`),
    check("reporting requires explicit opt-in", "(async()=>!(await window.bridge.app.reportUsage()).sent)()"),
    check("appcast checks select the highest compatible stable build numerically", "(async()=>{const result=await window.bridge.app.checkUpdates();return result.status==='update'&&result.version==='99.10.0'&&result.url===" + q(origin + "/download") + "})()"),
    { cmd: "app.checkUpdates" }, { waitFor: "!!document.querySelector('#confirm-choice-btns button[data-choice=\"Later\"]')" },
    check("manual update checks show the actual available version", "document.querySelector('.modal.open.alert .alert-message').textContent.includes('99.10.0')"),
    { eval: "document.querySelector('#confirm-choice-btns button[data-choice=\"Later\"]').click()" },
    { eval: "window.bridge.shell.openExternal=async p=>{window.__updateURL=p.url;return {ok:true}}" },
    { cmd: "app.checkUpdates" }, { waitFor: "!!document.querySelector('#confirm-choice-btns button[data-choice=\"Open Download Page\"]')" },
    { eval: "document.querySelector('#confirm-choice-btns button[data-choice=\"Open Download Page\"]').click()" },
    { waitFor: "window.__updateURL===" + q(origin + "/download") },
    { cmd: "file.preferences" },
    check("configured services enable their settings and privacy control", "!document.getElementById('pref-extra-anonymousUsageReports').disabled&&!document.getElementById('pref-privacy').disabled"),
    { eval: "document.getElementById('pref-extra-anonymousUsageReports').checked=true" }, { key: "Escape" },
    { waitFor: `${A}.settings.anonymousUsageReports===true` },
    check("explicit consent enables one bounded anonymous report", "(async()=>(await window.bridge.app.reportUsage()).sent)()"),
    check("a launch report is not duplicated", "(async()=>!(await window.bridge.app.reportUsage()).sent)()"),
  ], "configured", { profile: configured, feed: "/feed-latest" });
  assert.equal(count("/report"), 1);
  const report = requests.find(request => request.url === "/report");
  const payload = JSON.parse(report.body);
  assert.deepEqual(Object.keys(payload).sort(), ["appVersion", "architecture", "launches", "macOSMajor", "schema"]);
  assert.equal(payload.launches, 1); assert.equal(payload.schema, 1);
  assert.match(payload.architecture, /^(arm64|x86_64)$/);
  assert.equal(report.headers.cookie, undefined); assert.equal(report.headers.authorization, undefined);
  assert.match(report.headers["user-agent"], /^Lettrine\/[\d.]+$/);
  console.log("PASS report payload has no content, paths, identifiers, cookies or credentials");

  await run([
    check("reporting consent persists after restarting", `${A}.settings.anonymousUsageReports===true`),
    check("a new launch contributes exactly one new report", "(async()=>(await window.bridge.app.reportUsage()).sent)()"),
    { cmd: "file.preferences" },
    { eval: "document.getElementById('pref-extra-anonymousUsageReports').checked=false" }, { key: "Escape" },
    { waitFor: `${A}.settings.anonymousUsageReports===false` },
    check("opting out stops future reports", "(async()=>!(await window.bridge.app.reportUsage()).sent)()"),
    { eval: "window.bridge.i18n.setLocale({locale:'zh-Hant'})" }, { waitFor: `${A}.i18n.locale==='zh-Hant'` },
    { cmd: "file.preferences" },
    check("maintenance and session settings are localized", "document.querySelector('label:has(#pref-extra-anonymousUsageReports)').textContent.includes('傳送匿名使用統計')&&document.querySelector('label:has(#pref-extra-restoreSession)').textContent.includes('未儲存草稿')"),
    { eval: "document.getElementById('pref-extra-anonymousUsageReports').scrollIntoView({block:'center'});document.getAnimations().forEach(animation=>animation.finish())" },
    { capture: "privacy-light" }, { key: "Escape" },
    { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" }, { waitFor: "document.body.classList.contains('ui-dark')" },
    { cmd: "file.preferences" },
    { eval: "document.getElementById('pref-extra-anonymousUsageReports').scrollIntoView({block:'center'});document.getAnimations().forEach(animation=>animation.finish())" },
    { capture: "privacy-dark" }, { key: "Escape" },
  ], "consent-restart", { profile: configured, feed: "/feed-latest" });
  assert.equal(count("/report"), 2);
  assert.equal(JSON.parse(await readFile(path.join(configured, "maintenance.json"), "utf8")).launches, 0);

  for (const kind of ["invalid", "url", "redirect", "large", "error"]) {
    const failureProfile = await profile("failure-profile-" + kind);
    await run([
      { eval: `${E}.setText('Document stays safe');${E}.emit()` },
      check("invalid update service (" + kind + ") fails without changing the document", `(async()=>{try{await window.bridge.app.checkUpdates();return false}catch{return ${E}.getMarkdown()==='Document stays safe'}})()`),
    ], "failure-" + kind, { profile: failureProfile, feed: "/feed-" + kind });
    const state = JSON.parse(await readFile(path.join(failureProfile, "maintenance.json"), "utf8").catch(() => "{}"));
    assert.equal(state.checkedAt, undefined, "failed checks must remain eligible for retry");
  }
  assert.equal(count("/must-not-follow"), 0);
  await run([
    check("an older stable feed reports the installed version as current", "(async()=>(await window.bridge.app.checkUpdates()).status==='current')()"),
    { cmd: "app.checkUpdates" }, check("manual current-version checks show localized feedback", "document.body.textContent.includes('Lettrine is up to date.')"),
  ], "current", { profile: await profile("current-profile"), feed: "/feed-current" });

  const automatic = await profile("automatic-profile", { checkUpdatesAutomatically: true });
  const before = count("/feed-latest");
  await run([
    { waitFor: "document.body.textContent.includes('99.10.0')", timeout: 12000 },
    check("opt-in automatic checks surface an available update", "document.body.textContent.includes('View Update')"),
  ], "automatic", { profile: automatic, feed: "/feed-latest" });
  assert.equal(count("/feed-latest"), before + 1);
  await run([{ sleep: 5300 }, check("automatic checks retain their preference", `${A}.settings.checkUpdatesAutomatically`)],
    "automatic-restart", { profile: automatic, feed: "/feed-latest" });
  assert.equal(count("/feed-latest"), before + 1, "automatic checks are limited to once per day");
  assert.equal(count("/report"), 2, "automatic checking does not opt users into reporting");
  console.log("PASS configured appcast checks, stable/OS/version filtering, manual/automatic feedback, daily limits, anonymous opt-in/opt-out and restart, failures, no redirects, locales and themes");
} finally { await new Promise(resolve => server.close(resolve)); }
