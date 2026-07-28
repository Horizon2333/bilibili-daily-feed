(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.BiliDailyCache = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_POLICY = {
    retentionDays: 90,
    maxItemsPerAccount: 5000,
    maxAccounts: 5,
    maxBytes: 8 * 1024 * 1024
  };

  function createStore() {
    return { version: SCHEMA_VERSION, accounts: {} };
  }

  function normalizeStore(value) {
    if (!value || value.version !== SCHEMA_VERSION || !value.accounts || typeof value.accounts !== "object") {
      return createStore();
    }
    return value;
  }

  function accountKey(profile) {
    const mid = String(profile?.mid || "");
    return /^\d+$/.test(mid) && mid !== "0" ? mid : "";
  }

  function ensureAccount(store, profile, now) {
    const key = accountKey(profile);
    if (!key) throw new Error("无法确认当前 B 站账号");
    const timestamp = Number(now) || Date.now();
    const current = store.accounts[key] || { profile: {}, days: {}, createdAt: timestamp };
    current.profile = {
      mid: key,
      name: String(profile.name || profile.uname || current.profile?.name || ""),
      face: String(profile.face || current.profile?.face || "")
    };
    current.days = current.days && typeof current.days === "object" ? current.days : {};
    current.coverage = current.coverage && typeof current.coverage === "object" ? current.coverage : {};
    current.lastAccessedAt = timestamp;
    store.accounts[key] = current;
    return current;
  }

  function estimateBytes(value) {
    const json = JSON.stringify(value);
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).length;
    return json.length * 2;
  }

  function mergeDays(savedDays, incomingDays) {
    const merged = { ...(savedDays || {}) };
    Object.entries(incomingDays || {}).forEach(([day, items]) => {
      if (!Array.isArray(items)) return;
      const byKey = new Map((merged[day] || []).map((item) => [item.key, item]));
      items.forEach((item) => {
        if (item?.key) byKey.set(item.key, { ...(byKey.get(item.key) || {}), ...item });
      });
      merged[day] = Array.from(byKey.values());
    });
    return merged;
  }

  function mergeCoverage(savedCoverage, incomingCoverage) {
    const merged = { ...(savedCoverage || {}) };
    Object.entries(incomingCoverage || {}).forEach(([day, record]) => {
      if (!record || typeof record !== "object") return;
      const saved = merged[day];
      if (!saved || Number(record.updatedAt || 0) >= Number(saved.updatedAt || 0)) merged[day] = record;
    });
    return merged;
  }

  function dayTimestamp(day) {
    const value = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(value) ? value : 0;
  }

  function pruneAccount(account, policy, now) {
    account.days = account.days && typeof account.days === "object" ? account.days : {};
    account.coverage = account.coverage && typeof account.coverage === "object" ? account.coverage : {};
    const cutoff = Number(now) - policy.retentionDays * 86400000;
    Object.keys(account.coverage).forEach((day) => {
      if (dayTimestamp(day) < cutoff) delete account.coverage[day];
    });
    Object.keys(account.days).forEach((day) => {
      if (!Array.isArray(account.days[day]) || dayTimestamp(day) < cutoff) {
        delete account.days[day];
        delete account.coverage[day];
      }
    });

    const newest = Object.entries(account.days)
      .flatMap(([day, items]) => items.map((item, index) => ({ day, item, index })))
      .sort((left, right) => {
        const leftTime = Number(left.item.pubTimestamp) || dayTimestamp(left.day);
        const rightTime = Number(right.item.pubTimestamp) || dayTimestamp(right.day);
        return rightTime - leftTime || left.index - right.index;
      })
      .slice(0, policy.maxItemsPerAccount);
    const days = {};
    newest.forEach(({ day, item }) => {
      (days[day] ||= []).push(item);
    });
    account.days = days;
  }

  function pruneStore(input, options, now) {
    const store = normalizeStore(input);
    const policy = { ...DEFAULT_POLICY, ...(options || {}) };
    const timestamp = Number(now) || Date.now();
    Object.values(store.accounts).forEach((account) => pruneAccount(account, policy, timestamp));

    Object.entries(store.accounts)
      .sort((left, right) => Number(right[1].lastAccessedAt || 0) - Number(left[1].lastAccessedAt || 0))
      .slice(policy.maxAccounts)
      .forEach(([key]) => delete store.accounts[key]);

    while (estimateBytes(store) > policy.maxBytes) {
      const oldest = Object.entries(store.accounts).flatMap(([key, account]) =>
        Object.keys(account.days).map((day) => ({ key, day, time: dayTimestamp(day) }))
      ).sort((left, right) => left.time - right.time)[0];
      if (!oldest) break;
      delete store.accounts[oldest.key].days[oldest.day];
      delete store.accounts[oldest.key].coverage[oldest.day];
    }
    return store;
  }

  return {
    SCHEMA_VERSION, DEFAULT_POLICY, createStore, normalizeStore, accountKey,
    ensureAccount, estimateBytes, mergeDays, mergeCoverage, pruneStore
  };
});
