import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_SHORTCUTS } from "../src/core/shortcuts.js";
import { MARKDOWN_EXTENSIONS } from "../src/core/documents.js";
import { IMPORT_FORMATS } from "../src/core/imports.js";
import { maintenanceConfig } from "./maintenance-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// A release is one app for Apple silicon and Intel, signed with the hardened
// runtime. A development build covers this Mac only, so it builds faster.
const release = process.argv.includes("--release");
const output = process.env.LETTRINE_BUILD_OUTPUT ? path.resolve(process.env.LETTRINE_BUILD_OUTPUT) : path.join(root, release ? "dist/release/Lettrine.app" : "dist/development/Lettrine.app");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const maintenance = maintenanceConfig(process.env, release);
for (const name of ["mermaid", "markdown-it"]) {
  const hash = createHash("sha256").update(fs.readFileSync(path.join(root, `node_modules/${name}/dist/${name}.min.js`))).digest("hex");
  if (!fs.readFileSync(path.join(root, `licenses/${name}.txt`), "utf8").includes("Bundle SHA-256: " + hash)) {
    throw new Error(`Update licenses/${name}.txt for the installed ${name} bundle before building.`);
  }
}
const zenumlBundle = "node_modules/@mermaid-js/mermaid-zenuml/dist/mermaid-zenuml.min.js";
const zenumlHash = createHash("sha256").update(fs.readFileSync(path.join(root, zenumlBundle))).digest("hex");
if (!fs.readFileSync(path.join(root, "licenses/zenuml.txt"), "utf8").includes("Bundle SHA-256: " + zenumlHash)) throw new Error("Update licenses/zenuml.txt for the installed ZenUML bundle before building.");
const contents = path.join(output, "Contents"), web = path.join(contents, "Resources/web");
fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
fs.mkdirSync(path.join(root, ".build/module-cache"), { recursive: true });
const sources = fs.readdirSync(path.join(root, "native/Sources")).filter((name) => name.endsWith(".swift")).map((name) => path.join(root, "native/Sources", name));
const run = (command, args) => { const result = spawnSync(command, args, { cwd: root, stdio: "inherit" }); if (result.status !== 0) process.exit(result.status || 1); };
const executable = path.join(contents, "MacOS/Lettrine");
const architectures = release ? ["arm64", "x86_64"] : [process.arch === "arm64" ? "arm64" : "x86_64"];
const slices = architectures.map((arch) => {
  const slice = architectures.length > 1 ? path.join(root, ".build/Lettrine-" + arch) : executable;
  run("xcrun", ["swiftc", "-swift-version", "5", "-O", "-module-cache-path", path.join(root, ".build/module-cache"), "-target", arch + "-apple-macos13.0", ...sources, "-o", slice, "-framework", "AppKit", "-framework", "WebKit", "-framework", "PDFKit", "-framework", "CryptoKit"]);
  return slice;
});
if (slices.length > 1) run("lipo", ["-create", ...slices, "-output", executable]);
// Recreate only the managed resource directory; this cannot touch user data.
fs.rmSync(web, { recursive: true, force: true });
const copy = (source, destination = source) => {
  const from = path.join(root, source), to = path.join(web, destination);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: (file) => !file.endsWith(".map") && !file.endsWith(".DS_Store") });
};
for (const source of ["src/core", "src/renderer", "src/locales", "LICENSE", "THIRD_PARTY_NOTICES.md", "licenses"]) copy(source);
fs.copyFileSync(path.join(root, "native/Resources/AppIcon.icns"), path.join(contents, "Resources/AppIcon.icns"));
// Interface languages: one src/locales/<locale>.json each, named here in
// their own language for the language setting.
const languageNames = { en: "English", "zh-Hans": "简体中文", "zh-Hant": "繁體中文" };
const locales = fs.readdirSync(path.join(root, "src/locales")).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort();
fs.writeFileSync(path.join(web, "native-config.json"), JSON.stringify({ shortcuts: DEFAULT_SHORTCUTS, importFormats: IMPORT_FORMATS, maintenance, locales: Object.fromEntries(locales.map((locale) => [locale, languageNames[locale] || locale])) }));
for (const source of ["lib", "mode", "addon", "LICENSE"]) copy("node_modules/codemirror/" + source);
for (const source of ["katex.min.js", "katex.min.css", "fonts"]) copy("node_modules/katex/dist/" + source);
copy("node_modules/katex/LICENSE");
copy("node_modules/mermaid/dist/mermaid.min.js"); copy("node_modules/mermaid/LICENSE");
copy(zenumlBundle); copy("node_modules/@mermaid-js/mermaid-zenuml/LICENSE");
copy("node_modules/markdown-it/dist/markdown-it.min.js"); copy("node_modules/markdown-it/LICENSE");
copy("node_modules/gemoji/license"); // the emoji tables in src/core/vendor come from gemoji
fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Lettrine</string><key>CFBundleIdentifier</key><string>io.github.jasonwong2001.lettrine</string>
<key>CFBundleName</key><string>Lettrine</string><key>CFBundleDisplayName</key><string>Lettrine</string><key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string><key>NSHumanReadableCopyright</key><string>Lettrine contributors — MIT</string>
<key>CFBundleDocumentTypes</key><array>
<dict><key>CFBundleTypeName</key><string>Markdown document</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Default</string>
<key>LSItemContentTypes</key><array><string>io.github.jasonwong2001.lettrine.markdown</string><string>net.daringfireball.markdown</string><string>io.typora.markdown</string></array>
<key>CFBundleTypeExtensions</key><array>${MARKDOWN_EXTENSIONS.map((ext) => `<string>${ext}</string>`).join("")}</array></dict>
<dict><key>CFBundleTypeName</key><string>Plain text document</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Alternate</string>
<key>LSItemContentTypes</key><array><string>public.plain-text</string></array><key>CFBundleTypeExtensions</key><array><string>txt</string><string>text</string></array></dict></array>
<key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>io.github.jasonwong2001.lettrine.markdown</string><key>UTTypeDescription</key><string>Markdown document</string>
<key>UTTypeConformsTo</key><array><string>public.plain-text</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array>${MARKDOWN_EXTENSIONS.map((ext) => `<string>${ext}</string>`).join("")}</array><key>public.mime-type</key><string>text/markdown</string></dict></dict></array>
<key>UTImportedTypeDeclarations</key><array>${["net.daringfireball.markdown", "io.typora.markdown"].map((id) => `<dict><key>UTTypeIdentifier</key><string>${id}</string><key>UTTypeConformsTo</key><array><string>public.plain-text</string></array></dict>`).join("")}</array>
</dict></plist>`);
run("codesign", ["--force", ...(release ? ["--options", "runtime"] : []), "--sign", "-", output]);
if (release) run("codesign", ["--verify", "--strict", output]);
const size = spawnSync("du", ["-sh", output], { encoding: "utf8" });
console.log("Built native WKWebView app:", size.stdout.trim());
if (process.argv.includes("--run")) {
  const args = process.argv.slice(process.argv.indexOf("--run") + 1);
  const result = spawnSync(path.join(contents, "MacOS/Lettrine"), args, { cwd: root, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
