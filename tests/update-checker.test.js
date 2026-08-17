"use strict";

const assert = require("node:assert/strict");
const update = require("../update-checker.js");

assert.equal(update.compareVersions("0.15.0", "0.16.0"), -1);
assert.equal(update.compareVersions("0.16.0", "1.0.0"), -1);
assert.equal(update.compareVersions("v1.2.3", "1.2.3"), 0);
assert.equal(update.compareVersions("1.10.0", "1.9.9"), 1);
assert.equal(update.compareVersions("invalid", "1.0.0"), null);

const release = update.normalizeRelease({
  tag_name: "v1.0.0",
  html_url: "https://github.com/Horizon2333/bilibili-daily-feed/releases/tag/v1.0.0",
  assets: [{
    name: "bilibili-daily-feed-v1.0.0.zip",
    state: "uploaded",
    browser_download_url: "https://github.com/Horizon2333/bilibili-daily-feed/releases/download/v1.0.0/bilibili-daily-feed-v1.0.0.zip"
  }]
});
assert.deepEqual(release, {
  latestVersion: "1.0.0",
  releaseUrl: "https://github.com/Horizon2333/bilibili-daily-feed/releases/tag/v1.0.0",
  downloadUrl: "https://github.com/Horizon2333/bilibili-daily-feed/releases/download/v1.0.0/bilibili-daily-feed-v1.0.0.zip"
});
assert.equal(update.createUpdateResult(release, "0.15.0", 123).updateAvailable, true);
assert.equal(update.createUpdateResult(release, "1.0.0", 123).updateAvailable, false);

assert.equal(update.safeDownloadUrl("https://example.com/payload.zip"), "");
assert.equal(update.safeDownloadUrl("javascript:alert(1)"), "");
assert.throws(() => update.normalizeRelease({ tag_name: "nightly", assets: [] }), /版本号/);

console.log("update checker tests passed");
