(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.BiliDailyUpdate = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const REPOSITORY_RELEASE_PATH = "/Horizon2333/bilibili-daily-feed/releases/";
  const FALLBACK_RELEASE_URL = "https://github.com/Horizon2333/bilibili-daily-feed/releases/latest";

  function parseVersion(value) {
    const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
    if (!match) return null;
    return match.slice(1, 4).map(Number);
  }

  function versionText(value) {
    const parts = parseVersion(value);
    return parts ? parts.join(".") : "";
  }

  function compareVersions(left, right) {
    const leftParts = parseVersion(left);
    const rightParts = parseVersion(right);
    if (!leftParts || !rightParts) return null;
    for (let index = 0; index < 3; index += 1) {
      if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
    }
    return 0;
  }

  function safeReleaseUrl(value) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol !== "https:" || url.hostname !== "github.com") return "";
      return url.pathname.startsWith(REPOSITORY_RELEASE_PATH) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function safeDownloadUrl(value) {
    const url = safeReleaseUrl(value);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return parsed.pathname.startsWith(`${REPOSITORY_RELEASE_PATH}download/`) && parsed.pathname.toLowerCase().endsWith(".zip")
        ? parsed.href
        : "";
    } catch (_) {
      return "";
    }
  }

  function normalizeRelease(payload) {
    const latestVersion = versionText(payload?.tag_name);
    if (!latestVersion) throw new Error("最新 Release 的版本号格式无法识别");
    const releaseUrl = safeReleaseUrl(payload?.html_url) || FALLBACK_RELEASE_URL;
    const asset = (Array.isArray(payload?.assets) ? payload.assets : []).find((item) => {
      const expectedName = new RegExp(`^bilibili-daily-feed-v${latestVersion.replace(/\./g, "\\.")}\\.zip$`, "i");
      return item?.state === "uploaded" && expectedName.test(String(item.name || "")) && safeDownloadUrl(item.browser_download_url);
    });
    return {
      latestVersion,
      releaseUrl,
      downloadUrl: asset ? safeDownloadUrl(asset.browser_download_url) : ""
    };
  }

  function normalizeStoredRelease(value) {
    const latestVersion = versionText(value?.latestVersion);
    const releaseUrl = safeReleaseUrl(value?.releaseUrl);
    const downloadUrl = value?.downloadUrl ? safeDownloadUrl(value.downloadUrl) : "";
    if (!latestVersion || !releaseUrl || (value?.downloadUrl && !downloadUrl)) return null;
    return { latestVersion, releaseUrl, downloadUrl };
  }

  function createUpdateResult(release, currentVersion, checkedAt) {
    const normalizedRelease = normalizeStoredRelease(release);
    const normalizedCurrentVersion = versionText(currentVersion);
    const comparison = normalizedRelease && compareVersions(normalizedCurrentVersion, normalizedRelease.latestVersion);
    if (!normalizedRelease || !normalizedCurrentVersion || comparison === null) throw new Error("无法比较当前版本和最新版本");
    return {
      ...normalizedRelease,
      currentVersion: normalizedCurrentVersion,
      updateAvailable: comparison < 0,
      checkedAt: Number(checkedAt) || Date.now()
    };
  }

  return {
    compareVersions,
    createUpdateResult,
    normalizeRelease,
    normalizeStoredRelease,
    parseVersion,
    safeDownloadUrl,
    safeReleaseUrl
  };
});
