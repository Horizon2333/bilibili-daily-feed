const assert = require("node:assert/strict");
const { formatDay, hasCrossedTargetDay, parseDynamicTime, shiftDay } = require("../date-parser.js");

const now = new Date(2026, 6, 22, 15, 30);
assert.equal(formatDay(parseDynamicTime("44分钟前", now)), "2026-07-22");
assert.equal(formatDay(parseDynamicTime("昨天 19:40", now)), "2026-07-21");
assert.equal(formatDay(parseDynamicTime("前天", now)), "2026-07-20");
assert.equal(formatDay(parseDynamicTime("07月13日 · 投稿了视频", now)), "2026-07-13");
assert.equal(formatDay(parseDynamicTime("2025年12月31日", now)), "2025-12-31");
assert.equal(formatDay(parseDynamicTime("12月31日", now)), "2025-12-31");
assert.equal(parseDynamicTime("没有日期", now), null);
assert.equal(hasCrossedTargetDay(new Date(2026, 5, 18), new Date(2026, 5, 18)), false);
assert.equal(hasCrossedTargetDay(new Date(2026, 5, 17), new Date(2026, 5, 18)), true);
assert.equal(hasCrossedTargetDay(new Date(2026, 5, 16), new Date(2026, 5, 18)), true);
assert.equal(shiftDay("2026-07-21", 1), "2026-07-22");
assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
assert.equal(shiftDay("2024-02-28", 1), "2024-02-29");
assert.equal(shiftDay("2026-02-30", 1), "");

console.log("date parser tests passed");
