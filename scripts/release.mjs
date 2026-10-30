// Package a release in dist/: Lettrine-<version>.zip, one app for Apple
// silicon and Intel, and SHA256SUMS. The default mode needs a clean checkout
// with the v<version> tag at HEAD; --snapshot packages any clean commit for
// review. See the Releases section in CONTRIBUTING.md.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const snapshot = process.argv.includes("--snapshot");
const fail = (message) => { console.error(message); process.exit(1); };
const git = (...args) => { const result = spawnSync("git", args, { cwd: root, encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : null; };
const run = (command, args, env = process.env) => { const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env }); if (result.status !== 0) process.exit(result.status || 1); };

if (git("rev-parse", "--is-inside-work-tree") !== "true") fail("Releases are packaged from a git checkout.");
const changes = () => git("status", "--porcelain", "--untracked-files=all");
if (changes() !== "") fail("Commit or stash every change before packaging a release:\n" + changes());
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`The package.json version (${version}) must be major.minor.patch for macOS.`);
const head = git("rev-parse", "HEAD");
if (!snapshot && git("rev-parse", "-q", "--verify", `refs/tags/v${version}^{commit}`) !== head) {
  fail(`Tag v${version} must point at HEAD. Use --snapshot to package another commit for review.`);
}

// Check for Updates opens the releases page, found from a GitHub origin unless given.
const env = { ...process.env };
delete env.LETTRINE_BUILD_OUTPUT;
if (!env.LETTRINE_RELEASES_URL) {
  const repository = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin") || "")?.[1];
  if (!repository) fail("Set LETTRINE_RELEASES_URL to the page where releases are published.");
  env.LETTRINE_RELEASES_URL = `https://github.com/${repository}/releases`;
}
run(process.execPath, [path.join(root, "scripts/build-native.mjs"), "--release"], env);

const app = path.join(root, "dist/release/Lettrine.app");
const architectures = spawnSync("lipo", ["-archs", path.join(app, "Contents/MacOS/Lettrine")], { encoding: "utf8" }).stdout.trim().split(/\s+/).sort().join(" ");
if (architectures !== "arm64 x86_64") fail("Expected an app for arm64 and x86_64, not: " + architectures);
if (git("rev-parse", "HEAD") !== head || changes() !== "") fail("The checkout changed while the release was building.");

const name = snapshot ? `Lettrine-${version}-snapshot-${head.slice(0, 7)}.zip` : `Lettrine-${version}.zip`;
const zip = path.join(root, "dist", name);
fs.rmSync(zip, { force: true });
run("ditto", ["-c", "-k", "--keepParent", app, zip]);
const digest = createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
fs.writeFileSync(path.join(root, "dist/SHA256SUMS"), `${digest}  ${name}\n`);
console.log(`Packaged dist/${name} and dist/SHA256SUMS (${env.LETTRINE_RELEASES_URL}).`);
