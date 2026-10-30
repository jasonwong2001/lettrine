import test from "node:test";
import assert from "node:assert/strict";
import { fileTreeRows } from "../src/core/file-tree.js";
test("file trees preserve hierarchy and only expand selected folders", () => {
  const files = [
    { path: "/notes/z.md", name: "z.md" }, { path: "/notes/a/b.md", name: "b.md" },
    { path: "/notes/a/sub/c.md", name: "c.md" }, { path: "/other/x.md", name: "x.md" },
  ];
  assert.deepEqual(fileTreeRows(files, "/notes").map((row) => row.path), ["/notes/a", "/notes/z.md"]);
  const expanded = fileTreeRows(files, "/notes", new Set(["/notes/a"]));
  assert.deepEqual(expanded.map((row) => [row.path, row.depth]), [["/notes/a", 0], ["/notes/a/sub", 1], ["/notes/a/b.md", 1], ["/notes/z.md", 0]]);
  assert.equal(expanded[0].expanded, true);
  assert.equal(fileTreeRows(files, "/notes", new Set(["/notes/a", "/notes/a/sub"])).some((row) => row.path === "/notes/a/sub/c.md"), true);
});
