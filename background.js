"use strict";

importScripts("cache-store.js");

const CACHE_STORAGE_KEY = "biliDailyFeedStoreV1";
let cacheWriteQueue = Promise.resolve();

function storageGet(key) {
  return new Promise((resolve, reject) => chrome.storage.local.get([key], (data) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(data[key]);
  }));
}

function storageSet(value) {
  return new Promise((resolve, reject) => chrome.storage.local.set(value, () => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve();
  }));
}

async function saveAccountCache(message) {
  const store = BiliDailyCache.normalizeStore(await storageGet(CACHE_STORAGE_KEY));
  const account = BiliDailyCache.ensureAccount(store, message.account, Date.now());
  account.days = message.replace ? (message.days || {}) : BiliDailyCache.mergeDays(account.days, message.days);
  account.lastCleanedAt = Date.now();
  BiliDailyCache.pruneStore(store);
  await storageSet({ [CACHE_STORAGE_KEY]: store });
  return store;
}

async function getJson(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) throw new Error(payload.message || "B 站接口不可用");
  return payload.data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "bdf-save-cache") {
    const operation = cacheWriteQueue.then(() => saveAccountCache(message));
    cacheWriteQueue = operation.catch(() => undefined);
    operation
      .then((store) => sendResponse({ ok: true, store }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "缓存保存失败" }));
    return true;
  }
  if (message?.type === "bdf-get-account") {
    getJson("https://api.bilibili.com/x/web-interface/nav")
      .then((data) => sendResponse({
        ok: true,
        account: { isLogin: Boolean(data.isLogin), mid: String(data.mid || ""), name: data.uname || "", face: data.face || "" }
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "无法确认登录账号" }));
    return true;
  }
  if (message?.type !== "bdf-fetch-dynamics") return false;

  const url = new URL("https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all");
  url.searchParams.set("type", "all");
  url.searchParams.set("timezone_offset", "-480");
  url.searchParams.set("features", "itemOpusStyle,listOnlyfans,opusBigCover,onlyfansVote,decorationCard,forwardListHidden,ugcDelete,onlyfansAssetsV2,ugcSeason,onlyfansQaCard");
  url.searchParams.set("web_location", "333.1365");
  if (message.offset) url.searchParams.set("offset", message.offset);

  getJson(url)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "动态接口请求失败" }));

  return true;
});
