(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliDailyVideoMeta = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function normalizeDuration(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      const seconds = Math.floor(value);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      return hours
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
        : `${minutes}:${String(remainder).padStart(2, "0")}`;
    }

    const text = String(value || "").trim();
    const match = text.match(/(?:^|\s)(\d{1,3}:\d{2}(?::\d{2})?)(?:\s|$)/);
    if (!match) return "";
    const parts = match[1].split(":").map(Number);
    if (parts.at(-1) > 59 || (parts.length === 3 && parts[1] > 59)) return "";
    return match[1];
  }

  function normalizeBadgeText(value) {
    const original = String(value || "").trim();
    const compact = original.replace(/\s+/g, "");
    return /充电(?:专属|专享|可见|抢先看)?/.test(compact) ? original : "";
  }

  function extractVideoIdentity(value) {
    const text = String(value || "");
    const bvid = text.match(/(?:\/video\/|[?&]bvid=)(BV[0-9A-Za-z]+)/i)?.[1] || "";
    const aid = text.match(/\/video\/av(\d+)/i)?.[1]
      || text.match(/[?&](?:aid|oid)=(\d+)/i)?.[1]
      || "";
    return { aid, bvid };
  }

  function extractApiVideoMeta(archive, additionalUgc) {
    const source = archive || {};
    const badgeTexts = [
      source.badge && source.badge.text,
      ...(Array.isArray(source.badges) ? source.badges.map((badge) => badge && badge.text) : []),
      source.tag,
    ];
    return {
      durationText:
        normalizeDuration(source.duration_text) ||
        normalizeDuration(source.duration) ||
        normalizeDuration(additionalUgc && additionalUgc.duration),
      chargeLabel: badgeTexts.map(normalizeBadgeText).find(Boolean) || "",
    };
  }

  function extractApiVideoInfo(major, additionalUgc) {
    const sourceMajor = major || {};
    const archive = sourceMajor.archive || {};
    const ugcSeason = sourceMajor.ugc_season || {};
    const isCollection = sourceMajor.type === "MAJOR_TYPE_UGC_SEASON" || Boolean(sourceMajor.ugc_season);
    const source = Object.keys(archive).length ? archive : ugcSeason;
    const linkIdentity = extractVideoIdentity(source.jump_url);
    const meta = extractApiVideoMeta(source, additionalUgc);
    return {
      ...meta,
      isVideo: sourceMajor.type === "MAJOR_TYPE_ARCHIVE" || isCollection || Boolean(source.aid || source.bvid),
      isCollection,
      collectionLabel: isCollection ? String(ugcSeason.badge?.text || "合集").trim().slice(0, 12) : "",
      aid: String(source.aid || linkIdentity.aid || ""),
      bvid: String(source.bvid || linkIdentity.bvid || "")
    };
  }

  return { normalizeDuration, normalizeBadgeText, extractVideoIdentity, extractApiVideoMeta, extractApiVideoInfo };
});
