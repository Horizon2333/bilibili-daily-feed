"use strict";

const assert = require("node:assert/strict");
const {
  createStore, ensureAccount, mergeDays, mergeCoverage, normalizeStore, pruneStore
} = require("../cache-store.js");

const DAY = 86400000;
const now = Date.parse("2026-07-22T12:00:00Z");
const store = createStore();
const first = ensureAccount(store, { mid: "100", name: "账号一" }, now);
first.days["2026-07-21"] = [{ key: "a", pubTimestamp: now - DAY }];
const second = ensureAccount(store, { mid: "200", name: "账号二" }, now + 1);
second.days["2026-07-21"] = [{ key: "b", pubTimestamp: now - DAY }];

assert.notEqual(first.days, second.days, "不同 UID 必须使用不同缓存对象");
assert.equal(store.accounts["100"].days["2026-07-21"][0].key, "a");
assert.equal(store.accounts["200"].days["2026-07-21"][0].key, "b");

first.days["2026-01-01"] = [{ key: "expired", pubTimestamp: Date.parse("2026-01-01T12:00:00Z") }];
first.coverage["2026-01-01"] = { complete: true, updatedAt: now };
first.days["2026-07-20"] = Array.from({ length: 4 }, (_, index) => ({ key: `new-${index}`, pubTimestamp: now - index }));
pruneStore(store, { retentionDays: 90, maxItemsPerAccount: 3, maxAccounts: 5, maxBytes: 1024 * 1024 }, now);
assert.equal(store.accounts["100"].days["2026-01-01"], undefined, "超期日期应被清理");
assert.equal(store.accounts["100"].coverage["2026-01-01"], undefined, "超期完整度记录应同步清理");
assert.equal(Object.values(store.accounts["100"].days).flat().length, 3, "单账号条目数应受限");

for (let index = 300; index < 306; index += 1) ensureAccount(store, { mid: String(index), name: String(index) }, now + index);
pruneStore(store, { retentionDays: 90, maxItemsPerAccount: 3, maxAccounts: 5, maxBytes: 1024 * 1024 }, now + 1000);
assert.equal(Object.keys(store.accounts).length, 5, "仅保留最近使用的账号缓存");

assert.deepEqual(normalizeStore({ version: 999, accounts: { unsafe: {} } }), createStore(), "未知结构版本不得沿用");
assert.throws(() => ensureAccount(createStore(), { mid: "" }, now), /无法确认/);

const merged = mergeDays(
  { "2026-07-21": [{ key: "same", title: "旧" }, { key: "tab-a" }] },
  { "2026-07-21": [{ key: "same", title: "新" }, { key: "tab-b" }] }
);
assert.deepEqual(merged["2026-07-21"].map((item) => item.key), ["same", "tab-a", "tab-b"], "并发标签页数据应合并去重");
assert.equal(merged["2026-07-21"][0].title, "新", "较新字段应补全同一动态");

const coverage = mergeCoverage(
  { "2026-07-21": { complete: true, updatedAt: 20 } },
  {
    "2026-07-21": { complete: false, updatedAt: 10 },
    "2026-07-22": { complete: true, updatedAt: 30 }
  }
);
assert.equal(coverage["2026-07-21"].complete, true, "旧标签页不得覆盖较新的完整度记录");
assert.equal(coverage["2026-07-22"].complete, true, "应合并其他日期的完整度记录");

const legacyStore = { version: 1, accounts: { "900": { days: {}, lastAccessedAt: now } } };
assert.doesNotThrow(() => pruneStore(legacyStore, {}, now), "旧账号缓存缺少完整度字段时应平滑升级");
assert.deepEqual(legacyStore.accounts["900"].coverage, {});

console.log("cache-store tests passed");
