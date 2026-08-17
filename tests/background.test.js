"use strict";

const assert = require("node:assert/strict");

let messageListener;
let nextPayload = { code: 0, message: "0" };
let lastRequest;
let fetchCount = 0;
const localStorage = {};

global.importScripts = () => undefined;
global.BiliDailyCache = require("../cache-store.js");
global.BiliDailyUpdate = require("../update-checker.js");
global.chrome = {
  runtime: {
    lastError: null,
    getManifest: () => ({ version: "0.15.0" }),
    onMessage: { addListener(listener) { messageListener = listener; } }
  },
  storage: {
    local: {
      get(keys, callback) {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((key) => { result[key] = localStorage[key]; });
        callback(result);
      },
      set(value, callback) {
        Object.assign(localStorage, value);
        callback();
      }
    }
  }
};
global.fetch = async (url, options) => {
  fetchCount += 1;
  lastRequest = { url, options };
  return { ok: true, status: 200, json: async () => nextPayload };
};

require("../background.js");

function send(message) {
  return new Promise((resolve) => {
    assert.equal(messageListener(message, {}, resolve), true);
  });
}

(async () => {
  const success = await send({
    type: "bdf-add-watch-later",
    bvid: "BV1ht41147kj",
    csrf: "0123456789abcdef0123456789abcdef"
  });
  assert.equal(success.ok, true);
  assert.equal(lastRequest.url, "https://api.bilibili.com/x/v2/history/toview/add");
  assert.equal(lastRequest.options.method, "POST");
  assert.equal(lastRequest.options.body.get("bvid"), "BV1ht41147kj");
  assert.equal(lastRequest.options.body.get("csrf"), "0123456789abcdef0123456789abcdef");

  nextPayload = { code: 90001, message: "Request Error" };
  const full = await send({
    type: "bdf-add-watch-later",
    aid: "41687433",
    csrf: "0123456789abcdef0123456789abcdef"
  });
  assert.equal(full.ok, false);
  assert.match(full.error, /列表已满/);

  const invalid = await send({ type: "bdf-add-watch-later", bvid: "invalid", csrf: "bad" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /AV\/BV/);

  nextPayload = {
    code: 0,
    data: {
      list: [
        { aid: 41687433, bvid: "BV1ht41147kj" },
        { aid: 0, bvid: "" }
      ]
    }
  };
  const list = await send({ type: "bdf-get-watch-later" });
  assert.deepEqual(list, {
    ok: true,
    aids: ["41687433"],
    bvids: ["BV1ht41147kj"],
    videos: [{ aid: "41687433", bvid: "BV1ht41147kj" }]
  });
  assert.equal(lastRequest.url, "https://api.bilibili.com/x/v2/history/toview/web?jsonp=jsonp");

  nextPayload = { code: 0, message: "0" };
  const removed = await send({
    type: "bdf-remove-watch-later",
    aid: "41687433",
    csrf: "0123456789abcdef0123456789abcdef"
  });
  assert.equal(removed.ok, true);
  assert.equal(lastRequest.url, "https://api.bilibili.com/x/v2/history/toview/del");
  assert.equal(lastRequest.options.method, "POST");
  assert.equal(lastRequest.options.body.get("aid"), "41687433");
  assert.equal(lastRequest.options.body.get("csrf"), "0123456789abcdef0123456789abcdef");

  nextPayload = {
    tag_name: "v1.0.0",
    html_url: "https://github.com/Horizon2333/bilibili-daily-feed/releases/tag/v1.0.0",
    assets: [{
      name: "bilibili-daily-feed-v1.0.0.zip",
      state: "uploaded",
      browser_download_url: "https://github.com/Horizon2333/bilibili-daily-feed/releases/download/v1.0.0/bilibili-daily-feed-v1.0.0.zip"
    }]
  };
  const update = await send({ type: "bdf-check-update", force: true });
  assert.equal(update.ok, true);
  assert.equal(update.update.currentVersion, "0.15.0");
  assert.equal(update.update.latestVersion, "1.0.0");
  assert.equal(update.update.updateAvailable, true);
  assert.equal(update.update.downloadUrl, "https://github.com/Horizon2333/bilibili-daily-feed/releases/download/v1.0.0/bilibili-daily-feed-v1.0.0.zip");
  assert.equal(lastRequest.url, "https://api.github.com/repos/Horizon2333/bilibili-daily-feed/releases/latest");
  assert.equal(lastRequest.options.cache, "no-store");
  assert.equal(lastRequest.options.credentials, "omit");

  const fetchesAfterUpdate = fetchCount;
  const cachedUpdate = await send({ type: "bdf-check-update" });
  assert.equal(cachedUpdate.ok, true);
  assert.equal(cachedUpdate.update.updateAvailable, true);
  assert.equal(fetchCount, fetchesAfterUpdate);

  const selectedDay = await send({
    type: "bdf-save-selected-day",
    account: { mid: "100", name: "账号一" },
    selectedDay: "2026-07-21"
  });
  assert.equal(selectedDay.ok, true);
  assert.equal(selectedDay.store.accounts["100"].lastSelectedDay, "2026-07-21");

  const savedCache = await send({
    type: "bdf-save-cache",
    account: { mid: "100", name: "账号一" },
    days: { "2026-07-22": [{ key: "dynamic-1", pubTimestamp: Date.parse("2026-07-22T12:00:00Z") }] },
    selectedDay: "2026-07-22"
  });
  assert.equal(savedCache.ok, true);
  assert.equal(savedCache.store.accounts["100"].lastSelectedDay, "2026-07-22");
  assert.equal(savedCache.store.accounts["100"].days["2026-07-22"][0].key, "dynamic-1");

  const invalidDay = await send({
    type: "bdf-save-selected-day",
    account: { mid: "100", name: "账号一" },
    selectedDay: "2026-02-30"
  });
  assert.equal(invalidDay.ok, false);
  assert.match(invalidDay.error, /日期格式无效/);

  console.log("background tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
