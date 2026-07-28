(function () {
  "use strict";

  const isMainDynamicPage = location.hostname === "t.bilibili.com" && location.pathname === "/";
  if (window.top !== window || !isMainDynamicPage || document.getElementById("bdf-panel")) return;

  const { formatDay, hasCrossedTargetDay, parseDynamicTime, startOfDay } = globalThis.BiliDailyDate;
  const { createStore, normalizeStore, accountKey, ensureAccount, estimateBytes } = globalThis.BiliDailyCache;
  const STORAGE_KEY = "biliDailyFeedStoreV1";
  const LEGACY_CACHE_KEYS = Array.from({ length: 10 }, (_, index) => `biliDailyFeedCacheV${index + 1}`);
  const PANEL_PREFS_KEY = "biliDailyFeedPanelPrefsV1";
  const CARD_SELECTOR = ".bili-dyn-list__item";
  const TIME_SELECTOR = ".bili-dyn-time, .bili-dyn-item__desc";
  const state = {
    running: false,
    ready: false,
    stopRequested: false,
    store: createStore(),
    account: null,
    accountKey: "",
    cache: {},
    coverage: {},
    seen: new Set(),
    lastOldestDay: null,
    unchangedRounds: 0
  };
  let mutationTimer = null;
  let resizeSaveTimer = null;
  let panelPrefsReady = false;
  const pendingAddedNodes = new Set();
  const liveCards = new Map();

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "className") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, value);
    });
    (children || []).forEach((child) => node.append(child));
    return node;
  }

  const panel = el("aside", { id: "bdf-panel" });
  panel.innerHTML = `
    <div class="bdf-head">
      <div class="bdf-head-title">
        <strong>B站动态按天看 <span class="bdf-version">v${chrome.runtime.getManifest().version}</span></strong>
        <small><a href="https://github.com/Horizon2333" target="_blank" rel="noopener">作者：Horizon2333</a><span>·</span><a href="https://github.com/Horizon2333/bilibili-daily-feed/releases/latest" target="_blank" rel="noopener">检查更新</a></small>
      </div>
      <button id="bdf-collapse" title="收起">−</button>
    </div>
    <div class="bdf-body">
      <div class="bdf-query-row">
        <label class="bdf-date-control">日期<input id="bdf-date" type="date"></label>
        <div class="bdf-view-tools" role="group" aria-label="内容显示选项">
          <div class="bdf-tool-wrap">
            <button id="bdf-filter" class="bdf-tool-button" type="button" data-tooltip="内容过滤" aria-label="内容过滤：全部动态" aria-haspopup="menu" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.3 7.2v5.1L10.3 19v-6.8L4 5Z"></path></svg>
            </button>
            <div id="bdf-filter-menu" class="bdf-tool-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" data-kind="all">全部动态</button>
              <button type="button" role="menuitemradio" data-kind="video">仅视频</button>
            </div>
          </div>
          <div class="bdf-tool-wrap">
            <button id="bdf-sort" class="bdf-tool-button" type="button" data-tooltip="排列顺序" aria-label="排列顺序：从早到晚" aria-haspopup="menu" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7 3v18M4 18l3 3 3-3M17 21V3M14 6l3-3 3 3"></path>
              </svg>
            </button>
            <div id="bdf-sort-menu" class="bdf-tool-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" data-sort="oldest">从早到晚</button>
              <button type="button" role="menuitemradio" data-sort="newest">从晚到早</button>
            </div>
          </div>
        </div>
      </div>
      <small id="bdf-account-note" class="bdf-account-note">账号：确认中…</small>
      <div class="bdf-actions">
        <button id="bdf-load" class="bdf-primary">加载这一天</button>
        <button id="bdf-stop" disabled>停止</button>
      </div>
      <p id="bdf-status">选择日期后开始加载。</p>
      <button id="bdf-retry" class="bdf-secondary" hidden>重新确认账号</button>
      <div id="bdf-results"></div>
      <details id="bdf-cache-manager">
        <summary>缓存管理</summary>
        <div id="bdf-cache-stats">尚未读取缓存信息。</div>
        <div class="bdf-cache-actions">
          <button id="bdf-clear-day" class="bdf-link">清除所选日期</button>
          <button id="bdf-clear" class="bdf-link">清除当前账号全部缓存</button>
        </div>
      </details>
    </div>`;
  document.documentElement.append(panel);

  const dateInput = panel.querySelector("#bdf-date");
  const filterButton = panel.querySelector("#bdf-filter");
  const sortButton = panel.querySelector("#bdf-sort");
  const filterMenu = panel.querySelector("#bdf-filter-menu");
  const sortMenu = panel.querySelector("#bdf-sort-menu");
  const loadButton = panel.querySelector("#bdf-load");
  const stopButton = panel.querySelector("#bdf-stop");
  const status = panel.querySelector("#bdf-status");
  const retryButton = panel.querySelector("#bdf-retry");
  const cacheStats = panel.querySelector("#bdf-cache-stats");
  const accountNote = panel.querySelector("#bdf-account-note");
  const results = panel.querySelector("#bdf-results");
  const panelHead = panel.querySelector(".bdf-head");
  let kindFilter = "all";
  let sortOrder = "oldest";
  dateInput.value = formatDay(Date.now());
  loadButton.disabled = true;

  function clampPanelPosition(left, top) {
    const rect = panel.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8))
    };
  }

  function syncViewControls() {
    const videoOnly = kindFilter === "video";
    const filterLabel = videoOnly ? "内容过滤：仅视频" : "内容过滤：全部动态";
    filterButton.classList.toggle("bdf-tool-active", videoOnly);
    filterButton.setAttribute("aria-label", filterLabel);
    filterMenu.querySelectorAll("[data-kind]").forEach((option) => {
      const selected = option.dataset.kind === kindFilter;
      option.classList.toggle("bdf-menu-selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });

    const sortLabel = sortOrder === "oldest" ? "排列顺序：从早到晚" : "排列顺序：从晚到早";
    sortButton.setAttribute("aria-label", sortLabel);
    sortButton.classList.toggle("bdf-tool-active", sortOrder === "newest");
    sortMenu.querySelectorAll("[data-sort]").forEach((option) => {
      const selected = option.dataset.sort === sortOrder;
      option.classList.toggle("bdf-menu-selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });
  }

  function closeToolMenus(except) {
    [[filterButton, filterMenu], [sortButton, sortMenu]].forEach(([button, menu]) => {
      if (menu === except) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
      button.closest(".bdf-tool-wrap").classList.remove("bdf-menu-open");
    });
  }

  function toggleToolMenu(button, menu) {
    const willOpen = menu.hidden;
    closeToolMenus(menu);
    menu.hidden = !willOpen;
    button.setAttribute("aria-expanded", String(willOpen));
    button.closest(".bdf-tool-wrap").classList.toggle("bdf-menu-open", willOpen);
    if (willOpen) menu.querySelector(".bdf-menu-selected")?.focus();
  }

  function savePanelPrefs() {
    if (!panelPrefsReady || panel.classList.contains("bdf-collapsed")) return;
    const rect = panel.getBoundingClientRect();
    chrome.storage.local.set({
      [PANEL_PREFS_KEY]: {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        sort: sortOrder,
        kind: kindFilter
      }
    });
  }

  chrome.storage.local.get([PANEL_PREFS_KEY], (data) => {
    const prefs = data[PANEL_PREFS_KEY] || {};
    if (Number.isFinite(prefs.width)) panel.style.width = `${Math.max(300, prefs.width)}px`;
    if (Number.isFinite(prefs.height)) panel.style.height = `${Math.max(260, prefs.height)}px`;
    if (["oldest", "newest"].includes(prefs.sort)) sortOrder = prefs.sort;
    if (["all", "video"].includes(prefs.kind)) kindFilter = prefs.kind;
    syncViewControls();
    const initialLeft = Number.isFinite(prefs.left) ? prefs.left : window.innerWidth - panel.getBoundingClientRect().width - 18;
    const initialTop = Number.isFinite(prefs.top) ? prefs.top : 88;
    const position = clampPanelPosition(initialLeft, initialTop);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    panelPrefsReady = true;
  });

  const panelResizeObserver = new ResizeObserver(() => {
    if (!panelPrefsReady || panel.classList.contains("bdf-collapsed")) return;
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(savePanelPrefs, 250);
  });
  panelResizeObserver.observe(panel);

  panelHead.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button, a")) return;
    const startRect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    panelHead.setPointerCapture(event.pointerId);
    panel.classList.add("bdf-dragging");

    const onMove = (moveEvent) => {
      const position = clampPanelPosition(
        startRect.left + moveEvent.clientX - startX,
        startRect.top + moveEvent.clientY - startY
      );
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
    };
    const onEnd = () => {
      panel.classList.remove("bdf-dragging");
      panelHead.removeEventListener("pointermove", onMove);
      panelHead.removeEventListener("pointerup", onEnd);
      panelHead.removeEventListener("pointercancel", onEnd);
      savePanelPrefs();
    };
    panelHead.addEventListener("pointermove", onMove);
    panelHead.addEventListener("pointerup", onEnd);
    panelHead.addEventListener("pointercancel", onEnd);
  });

  window.addEventListener("resize", () => {
    if (!panelPrefsReady) return;
    const rect = panel.getBoundingClientRect();
    const position = clampPanelPosition(rect.left, rect.top);
    panel.style.left = `${position.left}px`;
    panel.style.top = `${position.top}px`;
    savePanelPrefs();
  });

  function chromeStorageGet(keys) {
    return new Promise((resolve, reject) => chrome.storage.local.get(keys, (data) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(data);
    }));
  }

  function chromeStorageRemove(keys) {
    return new Promise((resolve, reject) => chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    }));
  }

  function getCurrentAccount() {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: "bdf-get-account" }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(`扩展后台暂时不可用：${chrome.runtime.lastError.message}`));
      else if (!response?.ok) reject(new Error(`无法连接 B 站账号接口：${response?.error || "请求失败"}`));
      else if (!response.account?.isLogin || !accountKey(response.account)) reject(new Error("尚未登录 B 站。登录后请点击“重新确认账号”。"));
      else resolve(response.account);
    }));
  }

  function activateAccount(account) {
    const key = accountKey(account);
    const entry = ensureAccount(state.store, account, Date.now());
    state.account = account;
    state.accountKey = key;
    state.cache = entry.days;
    state.coverage = entry.coverage;
    state.seen = new Set(Object.values(state.cache).flat().map((item) => item.key));
    accountNote.textContent = `账号：${account.name || `UID ${key}`}`;
  }

  async function storageSet(replace) {
    if (!state.accountKey) throw new Error("当前账号尚未初始化");
    const entry = ensureAccount(state.store, state.account, Date.now());
    entry.days = state.cache;
    entry.coverage = state.coverage;
    const response = await new Promise((resolve, reject) => chrome.runtime.sendMessage({
      type: "bdf-save-cache",
      account: state.account,
      days: state.cache,
      coverage: state.coverage,
      replace: Boolean(replace)
    }, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    }));
    if (!response?.ok) throw new Error(response?.error || "缓存保存失败");
    state.store = normalizeStore(response.store);
    state.cache = state.store.accounts[state.accountKey]?.days || {};
    state.coverage = state.store.accounts[state.accountKey]?.coverage || {};
    renderCacheStats();
  }

  async function refreshAccount() {
    const account = await getCurrentAccount();
    const nextKey = accountKey(account);
    if (state.accountKey && nextKey !== state.accountKey) {
      state.store = normalizeStore((await chromeStorageGet([STORAGE_KEY]))[STORAGE_KEY]);
    }
    activateAccount(account);
  }

  async function reloadCurrentAccount() {
    const account = await getCurrentAccount();
    state.store = normalizeStore((await chromeStorageGet([STORAGE_KEY]))[STORAGE_KEY]);
    activateAccount(account);
  }

  function setStatus(message, tone, canRetry) {
    status.textContent = message;
    status.dataset.tone = tone || "normal";
    retryButton.hidden = !canRetry;
  }

  const ALLOWED_HOST_SUFFIXES = ["bilibili.com", "hdslb.com", "biliimg.com"];
  function isAllowedHost(hostname) {
    return ALLOWED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  }

  function absoluteUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return url.protocol === "https:" && isAllowedHost(url.hostname) ? url.href : "";
    } catch (_) { return ""; }
  }

  function fingerprint(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fp-${(hash >>> 0).toString(36)}`;
  }

  function firstText(...values) {
    for (const value of values.flat(Infinity)) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function apiImageUrl(value) {
    if (!value) return "";
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value, location.href);
      if (!isAllowedHost(url.hostname) || !["http:", "https:"].includes(url.protocol)) return "";
      url.protocol = "https:";
      return url.href;
    } catch (_) { return ""; }
  }

  function apiJumpUrl(value) {
    if (!value || /^bilibili:\/\//i.test(value)) return "";
    return apiImageUrl(value);
  }

  function renderCacheStats() {
    const account = state.store.accounts[state.accountKey];
    if (!account) {
      cacheStats.textContent = "尚未读取缓存信息。";
      return;
    }
    const days = Object.keys(account.days).sort();
    const itemCount = Object.values(account.days).reduce((sum, items) => sum + items.length, 0);
    const size = estimateBytes(account);
    const sizeLabel = size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
    const range = days.length ? `${days[0]} 至 ${days[days.length - 1]}` : "暂无日期";
    const cleaned = account.lastCleanedAt ? new Date(account.lastCleanedAt).toLocaleString("zh-CN", { hour12: false }) : "尚未清理";
    cacheStats.textContent = `${itemCount} 条 · ${days.length} 天 · 约 ${sizeLabel}\n范围：${range}\n最近治理：${cleaned}`;
  }

  function richTextValue(block) {
    if (!block) return "";
    if (typeof block === "string") return block.trim();
    if (typeof block.text === "string" && block.text.trim()) return block.text.trim();
    const nodes = block.rich_text_nodes || block.richTextNodes || [];
    return nodes.map((node) => firstText(node.orig_text, node.text, node.emoji?.text)).join("").trim();
  }

  function contentPreview(value, maxLength) {
    return String(value || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxLength || 280);
  }

  function deepDynamicText(value, depth) {
    if (depth > 8 || value == null) return [];
    if (typeof value === "string") {
      const text = value.trim();
      if (
        !text
        || /^https?:\/\//i.test(text)
        || /^\/\//.test(text)
        || /^\d+$/.test(text)
        || /^(?:MAJOR|DYNAMIC|ADDITIONAL|MODULE)_TYPE_[A-Z0-9_]+$/.test(text)
      ) return [];
      return text.length >= 4 ? [text] : [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => deepDynamicText(item, depth + 1));
    if (typeof value !== "object") return [];

    const ignoredKeys = /^(type|jump_url|cover|src|url|uri|id|id_str|bvid|aid|face|icon|badge|label)$/i;
    return Object.entries(value).flatMap(([key, child]) => {
      if (ignoredKeys.test(key)) return [];
      return deepDynamicText(child, depth + 1);
    });
  }

  function normalizeApiItem(raw) {
    const authorModule = raw?.modules?.module_author || {};
    const dynamicModule = raw?.modules?.module_dynamic || {};
    const major = dynamicModule.major || {};
    const pubTimestamp = Number(authorModule.pub_ts || 0) * 1000;
    if (!raw?.id_str || !pubTimestamp) return null;

    const archive = major.archive || {};
    const opus = major.opus || {};
    const draw = major.draw || {};
    const article = major.article || {};
    const common = major.common || {};
    const knownDescText = firstText(
      richTextValue(dynamicModule.desc),
      richTextValue(opus.summary),
      richTextValue(opus),
      opus.title
    );
    const deepTextCandidates = deepDynamicText(dynamicModule, 0)
      .filter((value) => value !== authorModule.name)
      .sort((left, right) => right.length - left.length);
    const descText = firstText(knownDescText, deepTextCandidates);
    const formalTitle = firstText(
      archive.title,
      article.title,
      opus.title,
      common.title
    );
    const firstParagraph = descText.split(/\n\s*\n|\n/).map((part) => part.trim()).find(Boolean) || "";
    const title = firstText(formalTitle, firstParagraph, "无标题动态").slice(0, 180);
    const preview = contentPreview(descText, 320);
    const image = apiImageUrl(firstText(
      archive.cover,
      opus.pics?.[0]?.url,
      draw.items?.[0]?.src,
      article.covers?.[0],
      common.cover
    ));
    const imageCount = Math.max(
      Array.isArray(opus.pics) ? opus.pics.length : 0,
      Array.isArray(draw.items) ? draw.items.length : 0,
      Array.isArray(article.covers) ? article.covers.length : 0
    );
    const contentHref = apiJumpUrl(firstText(
      archive.jump_url,
      article.jump_url,
      opus.jump_url,
      common.jump_url,
      major.jump_url
    ));
    const isVideo = raw.type === "DYNAMIC_TYPE_AV" || major.type === "MAJOR_TYPE_ARCHIVE" || Boolean(archive.bvid);
    const videoMeta = globalThis.BiliDailyVideoMeta.extractApiVideoMeta(
      archive,
      dynamicModule.additional && dynamicModule.additional.ugc
    );
    const published = new Date(pubTimestamp);

    return {
      key: raw.id_str,
      day: formatDay(published),
      timeText: published.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
      author: firstText(authorModule.name, "未知账号"),
      avatar: apiImageUrl(authorModule.face),
      title,
      preview,
      image,
      imageCount,
      dynamicHref: `https://www.bilibili.com/opus/${raw.id_str}`,
      contentHref,
      isVideo,
      durationText: videoMeta.durationText,
      chargeLabel: videoMeta.chargeLabel,
      pubTimestamp
    };
  }

  function upsertItem(item) {
    state.cache[item.day] ||= [];
    const index = state.cache[item.day].findIndex((saved) => saved.key === item.key);
    if (index >= 0) state.cache[item.day][index] = { ...state.cache[item.day][index], ...item };
    else state.cache[item.day].push(item);
    state.seen.add(item.key);
    return index < 0;
  }

  async function fetchDynamicPage(offset) {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "bdf-fetch-dynamics", offset }, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      });
    });
    if (!response?.ok) throw new Error(response?.error || "动态接口不可用");
    return response.data;
  }

  async function loadSelectedDayFromApi(target) {
    let offset = "";
    let scanned = 0;
    let pages = 0;
    let crossed = false;
    let exhausted = false;
    const knownOffsets = new Set();

    while (!state.stopRequested && pages < 500) {
      if (knownOffsets.has(offset)) throw new Error("动态接口分页游标重复");
      knownOffsets.add(offset);
      const data = await fetchDynamicPage(offset);
      const items = (data.items || []).map(normalizeApiItem).filter(Boolean);
      items.forEach(upsertItem);
      scanned += items.length;
      pages += 1;
      render();

      const tail = items.length ? items[items.length - 1] : null;
      if (tail && hasCrossedTargetDay(tail.pubTimestamp, target)) {
        crossed = true;
        break;
      }
      setStatus(`接口已读取 ${scanned} 条，列表末尾 ${tail ? tail.day : "未知"}…`, "working");
      if (!data.has_more || !data.offset) {
        exhausted = true;
        break;
      }
      if (!items.length) break;
      offset = data.offset;
    }

    return { crossed, exhausted, scanned };
  }

  function findTime(card) {
    const candidates = Array.from(card.querySelectorAll(TIME_SELECTOR));
    for (const candidate of candidates) {
      const text = (candidate.textContent || "").trim();
      if (parseDynamicTime(text)) return text;
    }
    return "";
  }

  function findTitle(contentRoot, videoLink, author, timeText) {
    const opusSummary = contentRoot.querySelector(".dyn-card-opus__summary");
    if (opusSummary) {
      const firstParagraph = (opusSummary.innerText || opusSummary.textContent || "")
        .split(/\n\s*\n/).map((part) => part.trim()).find(Boolean);
      if (firstParagraph) return firstParagraph.slice(0, 180);
    }

    const selectors = [
      ".bili-dyn-card-video__title",
      ".bili-video-card__info--tit",
      ".bili-rich-text__content",
      ".bili-dyn-content__orig__desc",
      "h1",
      "h2",
      "h3",
      "[class*='major'] [title]"
    ];
    for (const selector of selectors) {
      const node = contentRoot.querySelector(selector);
      const value = (node && (node.getAttribute("title") || node.textContent) || "").trim();
      if (value && value !== author && value !== timeText) return value.slice(0, 180);
    }

    if (videoLink) {
      const value = (videoLink.getAttribute("title") || videoLink.textContent || "").trim();
      if (value) return value.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "").slice(0, 180);
    }

    const ignored = /^(转发|评论|点赞|展开|收起|进入|相关游戏|投稿了视频|发布了动态视频|\d+(?:\.\d+)?万?)$/;
    const fallback = (contentRoot.innerText || "").split("\n").map((line) => line.trim()).find((line) => {
      return line && line !== author && line !== timeText && !ignored.test(line) && !parseDynamicTime(line);
    });
    return (fallback || "无标题动态").slice(0, 180);
  }

  function findImages(contentRoot) {
    const preferred = Array.from(contentRoot.querySelectorAll([
      ".bili-album__preview__picture__img",
      ".bili-dyn-card-video img",
      ".bili-video-card img",
      ".bili-dyn-content__orig img",
      ".bili-dyn-pic__img",
      "[class*='major'] img"
    ].join(",")));
    const candidates = preferred.length ? preferred : Array.from(contentRoot.querySelectorAll("img"));
    const urls = candidates.filter((node) => {
      const marker = `${node.className || ""} ${node.alt || ""}`.toLowerCase();
      return !/avatar|face|emoji|ornament|pendant/.test(marker);
    }).map((image) => {
      const value = image.currentSrc || image.src || image.getAttribute("data-src") || image.getAttribute("data-lazy-src") || "";
      return apiImageUrl(value);
    }).filter(Boolean);
    return Array.from(new Set(urls));
  }

  function findDynamicIdentity(card, links) {
    const idNode = card.matches("[data-did],[data-dynamic-id]")
      ? card
      : card.querySelector("[data-did],[data-dynamic-id]");
    const dynamicId = idNode && (idNode.getAttribute("data-did") || idNode.getAttribute("data-dynamic-id"));
    const timeLink = card.querySelector("a.bili-dyn-time[href], .bili-dyn-item__desc a[href]");
    const permalink = [timeLink, ...links].find((link) => {
      const value = absoluteUrl(link && link.getAttribute("href"));
      return /(?:t\.bilibili\.com\/\d+|bilibili\.com\/opus\/\d+)/.test(value);
    });
    const dynamicHref = dynamicId
      ? `https://www.bilibili.com/opus/${dynamicId}`
      : absoluteUrl(permalink && permalink.getAttribute("href"));
    return { dynamicId: dynamicId || "", dynamicHref };
  }

  function extractCard(card) {
    const timeText = findTime(card);
    const parsed = parseDynamicTime(timeText);
    if (!parsed) return null;

    // Footer areas may contain highlighted comments. Only the body is allowed to
    // supply titles, images and attached-content links.
    const contentRoot = card.querySelector(".bili-dyn-item__body .bili-dyn-content")
      || card.querySelector(".bili-dyn-item__body")
      || card.querySelector(".bili-dyn-item__main")
      || card;
    const cardLinks = Array.from(card.querySelectorAll("a[href]"));
    const contentLinks = Array.from(contentRoot.querySelectorAll("a[href]"));
    const videoLink = contentLinks.find((link) => /\/video\/BV/i.test(link.getAttribute("href") || ""));
    const { dynamicId, dynamicHref } = findDynamicIdentity(card, cardLinks);
    const authorNode = card.querySelector(".bili-dyn-title__text, .bili-dyn-title, [class*='author']");
    const avatarNode = card.querySelector(".bili-dyn-item__avatar img, .bili-dyn-avatar img, [class*='avatar'] img");
    const cardText = (card.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const contentText = (contentRoot.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const author = (authorNode && authorNode.textContent || cardText.split("\n")[0] || "未知账号").trim();
    const avatar = avatarNode ? apiImageUrl(avatarNode.currentSrc || avatarNode.src || avatarNode.getAttribute("data-src") || "") : "";
    const title = findTitle(contentRoot, videoLink, author, timeText);
    const preview = contentPreview(contentText, 320);
    const images = findImages(contentRoot);
    const image = images[0] || "";
    const isVideo = Boolean(videoLink) || /投稿了视频|发布了动态视频|联合创作/.test(cardText);
    const videoRoot = videoLink?.closest(".bili-dyn-card-video, .bili-video-card, [class*='video']") || contentRoot;
    const durationText = Array.from(videoRoot.querySelectorAll(
      ".bili-dyn-card-video__duration, .bili-video-card__stats__duration, .duration-time, [class*='duration']"
    )).map((node) => globalThis.BiliDailyVideoMeta.normalizeDuration(node.textContent)).find(Boolean) || "";
    const chargeLabel = Array.from(videoRoot.querySelectorAll(
      ".bili-dyn-card-video__badge, .bili-dyn-card-video__tag, [class*='badge'], [class*='tag']"
    )).map((node) => globalThis.BiliDailyVideoMeta.normalizeBadgeText(node.textContent)).find(Boolean) || "";
    const contentHref = absoluteUrl((videoLink || contentLinks.find((link) => {
      const href = absoluteUrl(link.getAttribute("href"));
      return href && href !== dynamicHref && !/space\.bilibili\.com/.test(href);
    }))?.getAttribute("href"));
    const linkFingerprint = contentLinks.map((link) => absoluteUrl(link.getAttribute("href"))).filter(Boolean).join("|");
    const key = dynamicId || dynamicHref || fingerprint(`${formatDay(parsed)}|${timeText}|${author}|${contentText}|${image}|${linkFingerprint}`);
    return {
      key, day: formatDay(parsed), timeText, author, avatar, title, preview, image,
      imageCount: images.length, dynamicHref, contentHref, isVideo, durationText, chargeLabel,
      pubTimestamp: parsed.getTime()
    };
  }

  function collectVisibleCards(root) {
    const items = [];
    const scope = root || document;
    const cards = [];
    if (scope.nodeType === Node.ELEMENT_NODE) {
      if (scope.matches(CARD_SELECTOR)) cards.push(scope);
      const parentCard = scope.closest(CARD_SELECTOR);
      if (parentCard) cards.push(parentCard);
    }
    if (scope.querySelectorAll) cards.push(...scope.querySelectorAll(CARD_SELECTOR));
    new Set(cards).forEach((card) => {
      const item = extractCard(card);
      if (!item) return;
      liveCards.set(item.key, card);
      state.seen.add(item.key);
      if (upsertItem(item)) items.push(item);
    });
    return items;
  }

  function setCoverage(day, complete, source, reason, scanned) {
    state.coverage[day] = {
      complete: Boolean(complete),
      source,
      reason,
      scanned: Number(scanned) || 0,
      updatedAt: Date.now()
    };
  }

  function coverageText(record) {
    if (!record) return "完整度：尚未确认";
    const source = record.source === "api" ? "接口读取" : "页面扫描";
    if (record.complete) return `完整度：已完整读取 · ${source}`;
    if (record.reason === "stopped") return `完整度：已停止，可能不完整 · ${source}`;
    if (record.reason === "error") return `完整度：加载中断，可能不完整 · ${source}`;
    return `完整度：未越过目标日期，可能不完整 · ${source}`;
  }

  function render() {
    const day = dateInput.value;
    const kind = kindFilter;
    const direction = sortOrder === "newest" ? -1 : 1;
    const items = (state.cache[day] || [])
      .filter((item) => kind === "all" || item.isVideo)
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const leftTime = Number(left.item.pubTimestamp);
        const rightTime = Number(right.item.pubTimestamp);
        if (leftTime && rightTime && leftTime !== rightTime) return (leftTime - rightTime) * direction;
        return (right.index - left.index) * direction;
      })
      .map(({ item }) => item);
    renderCacheStats();
    results.replaceChildren();
    const summary = el("div", { className: "bdf-summary" });
    summary.append(el("span", { text: `${day} · ${items.length} 条${kind === "video" ? "视频" : "动态"}` }));
    const coverage = state.coverage[day];
    summary.append(el("span", {
      className: `bdf-coverage ${coverage?.complete ? "bdf-coverage-complete" : "bdf-coverage-partial"}`,
      text: coverageText(coverage)
    }));
    results.append(summary);
    if (!items.length) {
      results.append(el("div", { className: "bdf-empty", text: "尚未收集到这一天的内容。" }));
      return;
    }
    items.forEach((item) => {
      const card = el("article", { className: "bdf-result" });
      const authorRow = el("div", { className: "bdf-author-row" });
      const safeAvatar = apiImageUrl(item.avatar);
      const safeImage = apiImageUrl(item.image);
      if (safeAvatar) authorRow.append(el("img", { className: "bdf-avatar", src: safeAvatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }));
      const authorInfo = el("div", { className: "bdf-author-info" });
      authorInfo.append(el("div", { className: "bdf-author", text: item.author || "未知账号" }));
      const meta = el("div", { className: "bdf-meta" });
      meta.append(document.createTextNode(`${item.timeText}${item.isVideo ? " · 视频" : ""}`));
      if (item.durationText) {
        meta.append(el("span", { className: "bdf-duration", text: `时长 ${item.durationText}` }));
      }
      if (Number(item.imageCount) > 1) {
        meta.append(el("span", { className: "bdf-image-count", text: `共 ${item.imageCount} 张` }));
      }
      authorInfo.append(meta);
      authorRow.append(authorInfo);
      card.append(authorRow);
      if (safeImage) {
        const cover = el("img", {
          className: item.isVideo ? "bdf-cover bdf-video-cover" : "bdf-cover",
          src: safeImage,
          alt: "",
          loading: "lazy",
          referrerpolicy: "no-referrer"
        });
        const imageHref = item.isVideo
          ? firstText(item.contentHref, item.dynamicHref)
          : firstText(item.dynamicHref, item.contentHref);
        if (imageHref) {
          const coverLink = el("a", {
            className: item.isVideo ? "bdf-cover-link bdf-video-cover-link" : "bdf-cover-link",
            href: imageHref,
            target: "_blank",
            rel: "noopener",
            title: item.isVideo ? "打开视频" : "打开动态",
            "aria-label": item.isVideo ? "打开视频" : "打开动态"
          });
          coverLink.append(cover);
          card.append(coverLink);
        } else {
          cover.classList.add("bdf-cover-standalone");
          card.append(cover);
        }
      }
      const validTitle = item.title && !/^(?:MAJOR|DYNAMIC|ADDITIONAL|MODULE)_TYPE_[A-Z0-9_]+$/.test(item.title);
      const validPreview = item.preview && !/^(?:MAJOR|DYNAMIC|ADDITIONAL|MODULE)_TYPE_[A-Z0-9_]+$/.test(item.preview);
      const displayTitle = validTitle && item.title !== "无标题动态"
        ? item.title
        : firstText(validPreview ? item.preview.split(/\n\s*\n|\n/)[0] : "", "无标题动态").slice(0, 180);
      const titleRow = el("div", { className: "bdf-title-row" });
      if (item.chargeLabel) titleRow.append(el("span", { className: "bdf-charge-badge", text: item.chargeLabel }));
      titleRow.append(el("div", { className: "bdf-title", text: displayTitle }));
      card.append(titleRow);
      if (validPreview && item.preview !== displayTitle) card.append(el("div", { className: "bdf-preview", text: item.preview }));
      const links = el("div", { className: "bdf-result-links" });
      if (item.dynamicHref) links.append(el("a", { href: item.dynamicHref, target: "_blank", rel: "noopener", text: "打开动态 →" }));
      if (item.contentHref && item.contentHref !== item.dynamicHref) {
        links.append(el("a", { href: item.contentHref, target: "_blank", rel: "noopener", text: item.isVideo ? "打开视频 →" : "打开内容 →" }));
      }
      if (!item.dynamicHref && liveCards.has(item.key)) {
        const locateButton = el("button", { className: "bdf-locate", type: "button", text: "定位原动态 →" });
        locateButton.addEventListener("click", () => {
          const sourceCard = liveCards.get(item.key);
          if (!sourceCard?.isConnected) return setStatus("原卡片已被页面回收，请重新加载该日期。", "normal");
          sourceCard.scrollIntoView({ behavior: "smooth", block: "center" });
          sourceCard.classList.add("bdf-source-highlight");
          setTimeout(() => sourceCard.classList.remove("bdf-source-highlight"), 2200);
        });
        links.append(locateButton);
      }
      if (links.childElementCount) card.append(links);
      results.append(card);
    });
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function loadSelectedDay() {
    if (state.running || !state.ready || !dateInput.value) return;
    try {
      await refreshAccount();
      render();
    } catch (error) {
      setStatus(error.message || "无法确认当前账号", "error", true);
      return;
    }
    state.running = true;
    state.stopRequested = false;
    state.unchangedRounds = 0;
    loadButton.disabled = true;
    stopButton.disabled = false;
    const target = startOfDay(`${dateInput.value}T00:00:00`).getTime();
    let previousCount = document.querySelectorAll(CARD_SELECTOR).length;
    let rounds = 0;
    let pageCrossed = false;

    setStatus("正在通过 B 站动态接口读取…", "working");

    try {
      try {
        const apiResult = await loadSelectedDayFromApi(target);
        const apiComplete = !state.stopRequested && (apiResult.crossed || apiResult.exhausted);
        setCoverage(
          dateInput.value,
          apiComplete,
          "api",
          state.stopRequested ? "stopped" : apiComplete ? (apiResult.crossed ? "crossed" : "exhausted") : "boundary",
          apiResult.scanned
        );
        await storageSet();
        const found = (state.cache[dateInput.value] || []).length;
        if (state.stopRequested) setStatus(`已停止，已缓存 ${found} 条当天动态。`, "normal");
        else if (apiResult.crossed) setStatus(`已越过目标日期；当天共缓存 ${found} 条。`, "success");
        else setStatus(`接口已到达末尾；当天共缓存 ${found} 条。`, "normal");
        return;
      } catch (apiError) {
        console.warn("B站动态接口读取失败，改用页面扫描", apiError);
        setStatus("接口读取失败，正在改用页面扫描…", "working");
        collectVisibleCards();
        render();
      }

      while (!state.stopRequested && rounds < 600) {
        const orderedItems = Array.from(document.querySelectorAll(CARD_SELECTOR)).map(extractCard).filter(Boolean);
        const tailItem = orderedItems.length ? orderedItems[orderedItems.length - 1] : null;
        const tailDay = tailItem ? startOfDay(`${tailItem.day}T00:00:00`).getTime() : null;
        state.lastOldestDay = tailDay;

        // Only the chronological tail is a safe boundary. Taking the minimum date
        // from the whole page can stop early when B站 inserts an older pinned or
        // forwarded card near the top. Selecting 06-18 therefore keeps loading
        // until the bottom of the feed has crossed into 06-17 (or earlier).
        if (tailDay !== null && hasCrossedTargetDay(tailDay, target)) {
          pageCrossed = true;
          break;
        }

        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        await sleep(750);
        collectVisibleCards();
        render();
        const count = document.querySelectorAll(CARD_SELECTOR).length;
        state.unchangedRounds = count === previousCount ? state.unchangedRounds + 1 : 0;
        previousCount = count;
        rounds += 1;
        const oldestLabel = tailDay === null ? "未知" : formatDay(tailDay);
        setStatus(`已扫描 ${count} 条，列表末尾 ${oldestLabel}…`, "working");
        if (state.unchangedRounds >= 8) break;
      }
      const pageComplete = !state.stopRequested && pageCrossed;
      setCoverage(
        dateInput.value,
        pageComplete,
        "page",
        state.stopRequested ? "stopped" : pageComplete ? "crossed" : "boundary",
        previousCount
      );
      await storageSet();
      render();
      const found = (state.cache[dateInput.value] || []).length;
      if (state.stopRequested) setStatus(`已停止，已缓存 ${found} 条当天动态。`, "normal");
      else if (state.unchangedRounds >= 8) setStatus(`页面不再加载；当天共缓存 ${found} 条。`, "normal");
      else setStatus(`已越过目标日期；当天共缓存 ${found} 条。`, "success");
    } catch (error) {
      setCoverage(dateInput.value, false, "page", "error", previousCount);
      try { await storageSet(); } catch (_) { /* Keep the original loading error. */ }
      render();
      setStatus(`加载中断：${error.message || "页面发生变化"}`, "error");
    } finally {
      state.running = false;
      loadButton.disabled = !state.ready;
      stopButton.disabled = true;
    }
  }

  loadButton.addEventListener("click", loadSelectedDay);
  stopButton.addEventListener("click", () => { state.stopRequested = true; });
  dateInput.addEventListener("change", render);
  filterButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleToolMenu(filterButton, filterMenu);
  });
  sortButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleToolMenu(sortButton, sortMenu);
  });
  filterMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-kind]");
    if (!option) return;
    kindFilter = option.dataset.kind;
    syncViewControls();
    closeToolMenus();
    render();
    savePanelPrefs();
  });
  sortMenu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-sort]");
    if (!option) return;
    sortOrder = option.dataset.sort;
    syncViewControls();
    closeToolMenus();
    render();
    savePanelPrefs();
  });
  panel.addEventListener("click", (event) => {
    if (!event.target.closest(".bdf-tool-wrap")) closeToolMenus();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!panel.contains(event.target)) closeToolMenus();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const openButton = panel.querySelector(".bdf-tool-button[aria-expanded='true']");
      closeToolMenus();
      openButton?.focus();
    }
  });
  panel.querySelector("#bdf-collapse").addEventListener("click", () => panel.classList.toggle("bdf-collapsed"));
  panel.querySelector("#bdf-clear").addEventListener("click", async () => {
    try {
      await refreshAccount();
      state.cache = {};
      state.coverage = {};
      state.seen.clear();
      await storageSet(true);
      render();
      setStatus(`已清除 ${state.account.name || `UID ${state.accountKey}`} 的本地缓存。`, "normal");
    } catch (error) {
      setStatus(`清除失败：${error.message}`, "error");
    }
  });

  panel.querySelector("#bdf-clear-day").addEventListener("click", async () => {
    try {
      await reloadCurrentAccount();
      const day = dateInput.value;
      const removed = (state.cache[day] || []).length;
      delete state.cache[day];
      delete state.coverage[day];
      await storageSet(true);
      render();
      setStatus(removed ? `已清除 ${day} 的 ${removed} 条缓存。` : `${day} 没有缓存。`, "normal");
    } catch (error) {
      setStatus(`清除失败：${error.message}`, "error");
    }
  });

  async function initialize() {
    retryButton.disabled = true;
    try {
      const data = await chromeStorageGet([STORAGE_KEY, ...LEGACY_CACHE_KEYS]);
      state.store = normalizeStore(data[STORAGE_KEY]);
      await refreshAccount();
      await storageSet(false);
      if (LEGACY_CACHE_KEYS.some((key) => data[key] !== undefined)) await chromeStorageRemove(LEGACY_CACHE_KEYS);
      state.ready = true;
      loadButton.disabled = false;
      render();
      setStatus("选择日期后开始加载。", "normal");
    } catch (error) {
      state.ready = false;
      loadButton.disabled = true;
      accountNote.textContent = "账号：未登录";
      setStatus(error.message || "初始化失败", "error", true);
    } finally {
      retryButton.disabled = false;
    }
  }

  retryButton.addEventListener("click", initialize);
  initialize();

  // B站会成批插入动态卡片。监听新增节点可以在下一批渲染或虚拟列表
  // 回收节点之前完成采集，避免连续“动态 + 视频”时漏掉中间卡片。
  const feedObserver = new MutationObserver((mutations) => {
    if (!state.running) return;
    mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) pendingAddedNodes.add(node);
    }));
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      pendingAddedNodes.forEach((node) => collectVisibleCards(node));
      pendingAddedNodes.clear();
      render();
    }, 80);
  });
  feedObserver.observe(document.body, { childList: true, subtree: true });
})();
