import { test } from "node:test";
import assert from "node:assert/strict";
import { exportOptions, exportDestination } from "../src/renderer/export-options.js";

test("export destinations retain the document name and prefer explicit then remembered folders", () => {
  assert.equal(exportDestination("/notes/a.b.md", "wiki", {}), "/notes/a.b.wiki");
  assert.equal(exportDestination("/notes/a.md", "png", { lastExportFolder: "/out/" }), "/out/a.png");
  assert.equal(exportDestination("/notes/a.md", "jpg", { exportFolder: "/images", lastExportFolder: "/out" }), "/images/a.jpg");
  assert.equal(exportDestination(null, "pdf", {}), "/tmp/lettrine-export.pdf");
});

test("previous export options preserve PDF, image, theme and typography choices", () => {
  const settings = { fontSize: 18, pageWidth: "wide", pdfPageSize: "Legal", pdfMargin: 0, pdfHeaderFooter: false };
  const saved = JSON.parse(JSON.stringify(exportOptions("pdf", settings, "custom-dark", true)));
  settings.fontSize = 24; settings.pdfMargin = 1;
  const options = exportOptions("pdf", settings, "lettrine", false, saved);
  assert.equal(options.pageSize, "Legal"); assert.equal(options.marginTop, 0);
  assert.equal(options.displayHeaderFooter, false); assert.equal(options.settings.fontSize, 18);
  assert.equal(options.theme, "custom-dark"); assert.equal(options.dark, true);
  assert.deepEqual(exportOptions("image", { imageExportFormat: "jpg", imageExportScale: "3" }, "lettrine", false),
    { theme: "lettrine", dark: false, settings: {}, format: "jpg", scale: 3 });
});
