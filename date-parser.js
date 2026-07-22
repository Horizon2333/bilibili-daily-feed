(function (root) {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;

  function startOfDay(value) {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function formatDay(value) {
    const date = startOfDay(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseDynamicTime(text, nowValue) {
    if (!text) return null;
    const now = new Date(nowValue || Date.now());
    const value = String(text).trim();

    if (/^(刚刚|\d+分钟前|\d+小时前)/.test(value)) return startOfDay(now);
    if (/^昨天/.test(value)) return startOfDay(now.getTime() - DAY_MS);
    if (/^前天/.test(value)) return startOfDay(now.getTime() - 2 * DAY_MS);

    let match = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

    match = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));

    match = value.match(/(\d{1,2})月(\d{1,2})日/);
    if (match) {
      let year = now.getFullYear();
      const candidate = new Date(year, Number(match[1]) - 1, Number(match[2]));
      if (candidate.getTime() > now.getTime() + 31 * DAY_MS) year -= 1;
      return new Date(year, Number(match[1]) - 1, Number(match[2]));
    }

    return null;
  }

  function hasCrossedTargetDay(tailDayValue, targetDayValue) {
    if (!tailDayValue || !targetDayValue) return false;
    return startOfDay(tailDayValue).getTime() < startOfDay(targetDayValue).getTime();
  }

  const api = { DAY_MS, formatDay, hasCrossedTargetDay, parseDynamicTime, startOfDay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.BiliDailyDate = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
