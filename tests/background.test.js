"use strict";

const assert = require("node:assert/strict");

let messageListener;
let nextPayload = { code: 0, message: "0" };
let lastRequest;

global.importScripts = () => undefined;
global.BiliDailyCache = {};
global.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener(listener) { messageListener = listener; } }
  },
  storage: { local: {} }
};
global.fetch = async (url, options) => {
  lastRequest = { url, options };
  return { ok: true, json: async () => nextPayload };
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

  console.log("background tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
