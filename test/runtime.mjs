import fs from "node:fs";
import path from "node:path";

// Resolve the native application used by GUI scenarios.
export async function resolveRuntime(root, suppliedApp) {
  const app = suppliedApp ? path.resolve(suppliedApp) : path.join(root, "dist/development/Lettrine.app");
  const executable = path.join(app, "Contents/MacOS/Lettrine");
  if (!fs.existsSync(executable)) throw new Error("Build the native app first: npm run dist:dir");
  return { executable, args: [] };
}
