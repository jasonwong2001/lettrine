import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHORTCUTS, normalizeAccelerator, shortcutMatches, acceleratorFromEvent } from "../src/core/shortcuts.js";

test("documented shortcut defaults are usable and leave duplicate/reopen bindings distinct", () => {
  assert.equal(DEFAULT_SHORTCUTS["inline.code"], "CmdOrCtrl+E");
  assert.equal(DEFAULT_SHORTCUTS["inline.image"], "CmdOrCtrl+Shift+K");
  assert.equal(DEFAULT_SHORTCUTS["library.duplicate"], "CmdOrCtrl+D");
  assert.equal(DEFAULT_SHORTCUTS["paragraph.h6"], "CmdOrCtrl+Alt+6");
  for (const value of Object.values(DEFAULT_SHORTCUTS)) assert.equal(normalizeAccelerator(value), value);
  assert.throws(() => normalizeAccelerator("A"), /modifier/);
  assert.throws(() => normalizeAccelerator("Cmd+NotAKey"), /Unknown/);
});
test("shortcuts normalize aliases and match physical keys across platforms and Option input", () => {
  assert.equal(normalizeAccelerator("shift+command+e"), "Cmd+Shift+E");
  assert.equal(shortcutMatches({ key: "e", meta: true }, "CmdOrCtrl+E", "darwin"), true);
  assert.equal(shortcutMatches({ key: "e", control: true }, "CmdOrCtrl+E", "linux"), true);
  assert.equal(shortcutMatches({ key: "e", meta: true, shift: true }, "CmdOrCtrl+E"), false);
  assert.equal(shortcutMatches({ key: "∆", code: "KeyJ", meta: true, alt: true }, "CmdOrCtrl+Alt+J"), true);
  assert.equal(acceleratorFromEvent({ key: "?", code: "Slash", metaKey: true, shiftKey: true }), "CmdOrCtrl+Shift+/");
});
