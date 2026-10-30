export function maintenanceConfig(env, release = false) {
  const config = {};
  for (const [key, variable] of Object.entries({
    updateFeedURL: "LETTRINE_UPDATE_FEED_URL",
    usageReportURL: "LETTRINE_USAGE_REPORT_URL",
    privacyURL: "LETTRINE_PRIVACY_URL",
    releasesURL: "LETTRINE_RELEASES_URL",
  })) {
    const value = env[variable]?.trim();
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw Error(variable + " must be an HTTPS URL."); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw Error(variable + " must be an HTTPS URL without credentials or a fragment.");
    config[key] = url.href;
  }
  if (config.usageReportURL && !config.privacyURL) throw Error("LETTRINE_PRIVACY_URL is required when anonymous usage reporting is configured.");
  // A release has to tell people where new versions come from.
  if (release && !config.updateFeedURL && !config.releasesURL) throw Error("Release builds require LETTRINE_RELEASES_URL or LETTRINE_UPDATE_FEED_URL.");
  return config;
}
