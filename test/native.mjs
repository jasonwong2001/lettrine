// Checks the built app bundle (native WebKit, no bundled browser or Node
// runtime, no source maps, under 40 MiB) and runs selected scenarios in order.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const options = process.argv.slice(2);
const flags = options.filter((argument) => argument.startsWith("--"));
const suppliedApps = options.filter((argument) => !argument.startsWith("--"));
assert.ok(flags.every((flag) => ["--all", "--exports", "--list"].includes(flag)), "Unknown native test option");
assert.ok(!(flags.includes("--all") && flags.includes("--exports")), "Choose either --all or --exports");
assert.ok(suppliedApps.length <= 1, "Supply at most one application bundle");
const editing = ["native-host.mjs", "editor.mjs", "heading-input.mjs", "features.mjs", "math-selection.mjs", "workspace.mjs", "library.mjs"];
const exports = ["external-actions.mjs", "native-export.mjs", "editor-exports.mjs", "export-surface.mjs"];
const all = ["native-host.mjs", ...exports, "alerts-readonly.mjs", "copy-image.mjs", "typography.mjs", "equations.mjs", "scripts.mjs", "imports.mjs", "image-management.mjs", "code-tools.mjs", "clipboard-selection.mjs", "diagrams.mjs", "settings-breadth.mjs", "sidebar-views.mjs", "outline-navigation.mjs", "document-toolbar.mjs", "zoom-ux.mjs", "app-behavior.mjs", "maintenance.mjs", "editor.mjs", "heading-input.mjs", "features.mjs", "math-selection.mjs", "workspace.mjs", "library.mjs"];
const scenarios = flags.includes("--all") ? all : flags.includes("--exports") ? exports : editing;
if (flags.includes("--list")) {
  console.log(scenarios.join("\n"));
  process.exit(0);
}
const app = suppliedApps[0] ? path.resolve(suppliedApps[0]) : path.join(root, "dist/development/Lettrine.app");
const executable = path.join(app, "Contents/MacOS/Lettrine");
assert.ok(fs.existsSync(executable), "Build the native app first with npm run dist:dir");
const linkage = spawnSync("otool", ["-L", executable], { encoding: "utf8" });
assert.equal(linkage.status, 0);
assert.match(linkage.stdout, /\/System\/Library\/Frameworks\/WebKit\.framework\//);
assert.doesNotMatch(linkage.stdout, /Electron|Chromium|node\.dylib/);
assert.equal(fs.existsSync(path.join(app, "Contents/Resources/app.asar")), false);
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const bundleFiles = files(app);
assert.equal(bundleFiles.some((file) => file.endsWith(".map")), false, "Source maps do not belong in the distribution");
assert.equal(bundleFiles.some((file) => /Electron Framework|\/node$|\.gif$/.test(file)), false, "No bundled browser, Node runtime or dependency demo assets");
const bytes = bundleFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
assert.ok(bytes < 40 * 1024 * 1024, "Native application stays below the 40 MiB size regression limit");
console.log(`PASS native WebKit linkage and lean bundle (${(bytes / 1048576).toFixed(1)} MiB of files)`);

for (const scenario of scenarios) {
  console.log(`Running native scenario: ${scenario}`);
  const child = spawn(process.execPath, [path.join(root, "test", scenario), app], { cwd: root, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, scenario + " failed");
}
console.log("PASS selected native WKWebView scenarios");
