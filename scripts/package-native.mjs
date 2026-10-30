import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const run = (program, args) => { const result = spawnSync(program, args, { cwd: root, stdio: "inherit" }); if (result.status !== 0) process.exit(result.status || 1); };
// Zips a development build for this Mac. Releases have their own script.
if (process.argv.includes("--release")) { console.error("Package releases with npm run release; see the Releases section in CONTRIBUTING.md."); process.exit(1); }
run(process.execPath, [path.join(root, "scripts/build-native.mjs")]);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const zip = path.join(root, "dist", `lettrine-${version}-mac-${process.arch}.zip`);
const app = process.env.LETTRINE_BUILD_OUTPUT ? path.resolve(process.env.LETTRINE_BUILD_OUTPUT) : path.join(root, "dist/development/Lettrine.app");
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
console.log("Native macOS distribution:", zip);
