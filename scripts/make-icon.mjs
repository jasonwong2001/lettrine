// Regenerate native/Resources/AppIcon.icns from the icon drawings. The
// small drawing serves 16 and 32 px; the full one every larger size.
// Requires rsvg-convert (Homebrew librsvg) and macOS iconutil. The .icns is
// committed, so building the app does not need either.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const resources = path.join(root, "native/Resources");
const set = fs.mkdtempSync(path.join(os.tmpdir(), "lettrine-icon-")) + "/AppIcon.iconset";
fs.mkdirSync(set);
const run = (command, args) => { const result = spawnSync(command, args, { stdio: "inherit" }); if (result.status !== 0) process.exit(result.status || 1); };
const sizes = [[16, 1, "small"], [16, 2, "small"], [32, 1, "small"], [32, 2, "full"], [128, 1, "full"], [128, 2, "full"], [256, 1, "full"], [256, 2, "full"], [512, 1, "full"], [512, 2, "full"]];
for (const [size, scale, drawing] of sizes) {
  const pixels = size * scale, name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
  run("rsvg-convert", ["-w", String(pixels), "-h", String(pixels), path.join(resources, drawing === "small" ? "AppIcon-small.svg" : "AppIcon.svg"), "-o", path.join(set, name)]);
}
run("iconutil", ["-c", "icns", set, "-o", path.join(resources, "AppIcon.icns")]);
console.log("Wrote native/Resources/AppIcon.icns");
