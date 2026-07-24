const assert = require("node:assert/strict");
const {
  normalizeDuration,
  normalizeBadgeText,
  extractApiVideoMeta,
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
assert.deepEqual(
  extractApiVideoMeta({}, { duration: 3723 }),
  { durationText: "1:02:03", chargeLabel: "" }
);

console.log("video-meta tests passed");
