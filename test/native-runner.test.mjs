import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const runner = fileURLToPath(new URL("native.mjs", import.meta.url));
const list = (...flags) => {
  const result = spawnSync(process.execPath, [runner, "--list", ...flags], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n");
};

test("native tests default to editing without the export and full feature suites", () => {
  const scenarios = list();
  assert.ok(scenarios.includes("editor.mjs"));
  assert.ok(scenarios.includes("math-selection.mjs"));
  assert.ok(scenarios.includes("workspace.mjs"));
  assert.ok(!scenarios.some((name) => /export|typography|equations|scripts|diagrams/.test(name)));
  assert.equal(new Set(scenarios).size, scenarios.length);
});

test("export and complete native suites require explicit options", () => {
  const exports = list("--exports"), all = list("--all");
  for (const name of ["external-actions.mjs", "native-export.mjs", "editor-exports.mjs", "export-surface.mjs"]) {
    assert.ok(exports.includes(name));
  }
  assert.ok(!exports.includes("editor.mjs"));
  for (const name of [...list(), ...exports, "typography.mjs", "app-behavior.mjs", "maintenance.mjs"]) assert.ok(all.includes(name));
  assert.equal(new Set(all).size, all.length);
});

test("invalid native suite options fail before starting an app", () => {
  for (const flags of [["--all", "--exports"], ["--unknown"]]) {
    const result = spawnSync(process.execPath, [runner, "--list", ...flags], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Choose either|Unknown native test option/);
  }
});
