const assert = require("node:assert/strict");
const {
  normalizeDuration,
  normalizeBadgeText,
  extractVideoIdentity,
  extractApiVideoMeta,
  extractApiVideoInfo,
} = require("../video-meta");

assert.equal(normalizeDuration("12:34"), "12:34");
assert.equal(normalizeDuration("时长 1:02:03 "), "1:02:03");
assert.equal(normalizeDuration(65), "1:05");
assert.equal(normalizeDuration("12:78"), "");
assert.equal(normalizeDuration("今天 11:30 发布"), "11:30");

assert.equal(normalizeBadgeText("充电专属"), "充电专属");
assert.equal(normalizeBadgeText(" 充电 专享 "), "充电 专享");
assert.equal(normalizeBadgeText("独家"), "");

assert.deepEqual(
  extractApiVideoMeta({ duration_text: "08:21", badge: { text: "充电专属" } }),
  { durationText: "08:21", chargeLabel: "充电专属" }
);

assert.deepEqual(extractVideoIdentity("https://www.bilibili.com/video/BV1ht41147kj"), { aid: "", bvid: "BV1ht41147kj" });
assert.deepEqual(extractVideoIdentity("//www.bilibili.com/video/av41687433"), { aid: "41687433", bvid: "" });
assert.deepEqual(extractVideoIdentity("https://www.bilibili.com/list/1?oid=219580392&bvid=BV1xx411c7mD"), { aid: "219580392", bvid: "BV1xx411c7mD" });

assert.deepEqual(
  extractApiVideoInfo({
    type: "MAJOR_TYPE_UGC_SEASON",
    ugc_season: {
      aid: 219580392,
      badge: { text: "合集" },
      cover: "https://i0.hdslb.com/cover.jpg",
      duration_text: "24:08",
      jump_url: "//www.bilibili.com/video/av219580392",
      title: "合集中的新一期"
    }
  }),
  {
    durationText: "24:08",
    chargeLabel: "",
    isVideo: true,
    isCollection: true,
    collectionLabel: "合集",
    aid: "219580392",
    bvid: ""
  }
);
assert.deepEqual(
  extractApiVideoMeta({}, { duration: 3723 }),
  { durationText: "1:02:03", chargeLabel: "" }
);

console.log("video-meta tests passed");
