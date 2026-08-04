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
  account.coverage = message.replace
    ? (message.coverage || {})
    : BiliDailyCache.mergeCoverage(account.coverage, message.coverage);
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

async function addToWatchLater(message) {
  const aid = String(message.aid || "");
  const bvid = String(message.bvid || "");
  const csrf = String(message.csrf || "");
  if (!/^\d+$/.test(aid) && !/^BV[0-9A-Za-z]+$/i.test(bvid)) throw new Error("无法识别这个视频的 AV/BV 号");
  if (!/^[0-9a-f]{32}$/i.test(csrf)) throw new Error("无法获取登录校验信息，请重新登录或刷新动态页");

  const body = new URLSearchParams({ csrf });
  if (/^\d+$/.test(aid)) body.set("aid", aid);
  else body.set("bvid", bvid);
  const response = await fetch("https://api.bilibili.com/x/v2/history/toview/add", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
  const payload = await response.json();
  if (payload.code === 0) return { aid, bvid };
  const knownErrors = {
    "-101": "当前 B 站账号未登录",
    "-111": "登录校验已失效，请刷新页面后重试",
    "-400": "B 站未接受这个视频，请打开视频页后重试",
    "90001": "稍后再看列表已满",
    "90003": "该视频已被删除"
  };
  throw new Error(knownErrors[String(payload.code)] || payload.message || `添加失败（${payload.code}）`);
}

async function removeFromWatchLater(message) {
  const aid = String(message.aid || "");
  const csrf = String(message.csrf || "");
  if (!/^\d+$/.test(aid)) throw new Error("无法识别这个视频的 AV 号，请刷新稍后再看状态后重试");
  if (!/^[0-9a-f]{32}$/i.test(csrf)) throw new Error("无法获取登录校验信息，请重新登录或刷新动态页");

  const body = new URLSearchParams({ aid, csrf });
  const response = await fetch("https://api.bilibili.com/x/v2/history/toview/del", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body
  });
  if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
  const payload = await response.json();
  if (payload.code === 0) return { aid };
  const knownErrors = {
    "-101": "当前 B 站账号未登录",
    "-111": "登录校验已失效，请刷新页面后重试",
    "-400": "B 站未接受删除请求，请刷新状态后重试"
  };
  throw new Error(knownErrors[String(payload.code)] || payload.message || `移除失败（${payload.code}）`);
}

async function getWatchLaterIds() {
  const data = await getJson("https://api.bilibili.com/x/v2/history/toview/web?jsonp=jsonp");
  const items = Array.isArray(data.list) ? data.list : [];
  const videos = items.map((item) => ({ aid: String(item.aid || ""), bvid: String(item.bvid || "") }))
    .filter((item) => /^\d+$/.test(item.aid) || /^BV[0-9A-Za-z]+$/i.test(item.bvid));
  return {
    aids: videos.map((item) => item.aid).filter((aid) => /^\d+$/.test(aid)),
    bvids: videos.map((item) => item.bvid).filter((bvid) => /^BV[0-9A-Za-z]+$/i.test(bvid)),
    videos
  };
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
  if (message?.type === "bdf-add-watch-later") {
    addToWatchLater(message)
      .then((video) => sendResponse({ ok: true, video }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "添加稍后再看失败" }));
    return true;
  }
  if (message?.type === "bdf-get-watch-later") {
    getWatchLaterIds()
      .then((ids) => sendResponse({ ok: true, ...ids }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "无法读取稍后再看列表" }));
    return true;
  }
  if (message?.type === "bdf-remove-watch-later") {
    removeFromWatchLater(message)
      .then((video) => sendResponse({ ok: true, video }))
      .catch((error) => sendResponse({ ok: false, error: error.message || "从稍后再看移除失败" }));
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
