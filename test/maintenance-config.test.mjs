import { test } from "node:test";
import assert from "node:assert/strict";
import { maintenanceConfig } from "../scripts/maintenance-config.mjs";

test("maintenance builds have no endpoints unless explicitly configured", () => {
  assert.deepEqual(maintenanceConfig({}), {});
  assert.throws(() => maintenanceConfig({}, true), /Release builds require/);
});

test("a release needs only a releases page, without update or usage services", () => {
  const env = { LETTRINE_RELEASES_URL: "https://github.com/example/lettrine/releases" };
  assert.deepEqual(maintenanceConfig(env, true), { releasesURL: env.LETTRINE_RELEASES_URL });
  assert.throws(() => maintenanceConfig({ LETTRINE_RELEASES_URL: "http://github.com/example/lettrine/releases" }, true), /HTTPS URL/);
  assert.throws(() => maintenanceConfig({ LETTRINE_PRIVACY_URL: "https://example.com/privacy" }, true), /Release builds require/);
});

test("release maintenance requires secure endpoints and a privacy policy", () => {
  const env = { LETTRINE_UPDATE_FEED_URL: "https://updates.example.com/appcast.xml", LETTRINE_USAGE_REPORT_URL: "https://usage.example.com/count", LETTRINE_PRIVACY_URL: "https://example.com/privacy" };
  assert.deepEqual(maintenanceConfig(env, true), {
    updateFeedURL: env.LETTRINE_UPDATE_FEED_URL, usageReportURL: env.LETTRINE_USAGE_REPORT_URL, privacyURL: env.LETTRINE_PRIVACY_URL,
  });
  assert.throws(() => maintenanceConfig({ LETTRINE_USAGE_REPORT_URL: env.LETTRINE_USAGE_REPORT_URL }), /PRIVACY_URL/);
  for (const url of ["http://updates.example.com/feed", "https://user:secret@example.com/feed", "https://example.com/feed#token", "file:///tmp/feed", "invalid"]) {
    assert.throws(() => maintenanceConfig({ LETTRINE_UPDATE_FEED_URL: url }), /HTTPS URL/);
  }
});
