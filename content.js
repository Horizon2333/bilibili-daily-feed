(function () {
  "use strict";

  const isMainDynamicPage = location.hostname === "t.bilibili.com" && location.pathname === "/";
  if (window.top !== window || !isMainDynamicPage || document.getElementById("bdf-panel")) return;

  const { formatDay, hasCrossedTargetDay, parseDynamicTime, shiftDay, startOfDay } = globalThis.BiliDailyDate;
  const { createStore, normalizeStore, accountKey, ensureAccount, estimateBytes, normalizeDay } = globalThis.BiliDailyCache;
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
    watchLater: {
      accountKey: "",
      aids: new Set(),
      bvids: new Set(),
      aidByBvid: new Map(),
      loaded: false,
      checking: false,
      error: "",
      checkedAt: 0
    },
    seen: new Set(),
    diagnostics: new Map(),
    lastOldestDay: null,
    unchangedRounds: 0
  };
  let mutationTimer = null;
  let resizeSaveTimer = null;
  let statusHideTimer = null;
  let watchLaterRefreshPromise = null;
  let watchLaterRefreshId = 0;
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

  const currentVersion = chrome.runtime.getManifest().version;
  const panel = el("aside", { id: "bdf-panel" });
  panel.innerHTML = `
    <div class="bdf-head">
      <div class="bdf-head-title">
        <strong>B站动态按天看 <span class="bdf-version">v${currentVersion}</span></strong>
        <small class="bdf-head-meta">
          <a href="https://github.com/Horizon2333" target="_blank" rel="noopener">作者：Horizon2333</a><span>·</span>
          <button id="bdf-check-update" class="bdf-update-check" type="button" title="当前版本 v${currentVersion}；点击检查更新">检查更新</button>
          <a id="bdf-download-update" class="bdf-update-download" href="https://github.com/Horizon2333/bilibili-daily-feed/releases/latest" target="_blank" rel="noopener" hidden>下载更新</a>
        </small>
      </div>
      <button id="bdf-collapse" title="收起">−</button>
    </div>
    <div class="bdf-body">
      <div class="bdf-query-row">
        <div class="bdf-date-nav" role="group" aria-label="日期导航">
          <button id="bdf-prev-day" class="bdf-date-step" type="button" title="前一天（Alt + ←）" aria-label="查看前一天">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"></path></svg>
          </button>
          <input id="bdf-date" type="date" aria-label="选择日期">
          <button id="bdf-next-day" class="bdf-date-step" type="button" title="后一天（Alt + →）" aria-label="查看后一天">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 5 7 7-7 7"></path></svg>
          </button>
        </div>
        <div class="bdf-view-tools" role="group" aria-label="内容显示选项">
          <div class="bdf-tool-wrap">
            <button id="bdf-filter" class="bdf-tool-button" type="button" data-tooltip="内容过滤" aria-label="内容过滤：全部动态" aria-haspopup="menu" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6.3 7.2v5.1L10.3 19v-6.8L4 5Z"></path></svg>
            </button>
            <div id="bdf-filter-menu" class="bdf-tool-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" data-kind="all">全部动态</button>
              <button type="button" role="menuitemradio" data-kind="video">视频</button>
              <button type="button" role="menuitemradio" data-kind="graphic">图文</button>
              <button type="button" role="menuitemradio" data-kind="other">其他</button>
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
      <div class="bdf-actions">
        <button id="bdf-load" class="bdf-primary">加载这一天</button>
        <button id="bdf-stop" disabled>停止</button>
      </div>
      <p id="bdf-status" hidden></p>
      <button id="bdf-copy-diagnostics" class="bdf-diagnostics" type="button" hidden>复制异常信息</button>
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
    </div>
    <div id="bdf-resize-handle" role="separator" aria-label="调整工具大小" title="拖动调整大小"></div>`;
  document.documentElement.append(panel);

  const dateInput = panel.querySelector("#bdf-date");
  const previousDayButton = panel.querySelector("#bdf-prev-day");
  const nextDayButton = panel.querySelector("#bdf-next-day");
  const filterButton = panel.querySelector("#bdf-filter");
  const sortButton = panel.querySelector("#bdf-sort");
  const filterMenu = panel.querySelector("#bdf-filter-menu");
  const sortMenu = panel.querySelector("#bdf-sort-menu");
  const loadButton = panel.querySelector("#bdf-load");
  const stopButton = panel.querySelector("#bdf-stop");
  const status = panel.querySelector("#bdf-status");
  const copyDiagnosticsButton = panel.querySelector("#bdf-copy-diagnostics");
  const retryButton = panel.querySelector("#bdf-retry");
  const cacheStats = panel.querySelector("#bdf-cache-stats");
  const results = panel.querySelector("#bdf-results");
  const updateCheckButton = panel.querySelector("#bdf-check-update");
  const updateDownloadLink = panel.querySelector("#bdf-download-update");
  const panelBody = panel.querySelector(".bdf-body");
  const panelHead = panel.querySelector(".bdf-head");
  const resizeHandle = panel.querySelector("#bdf-resize-handle");
  let kindFilter = "all";
  let sortOrder = "oldest";
  dateInput.value = formatDay(Date.now());
  dateInput.max = formatDay(Date.now());
  loadButton.disabled = true;

  function syncDateNavigation() {
    const day = normalizeDay(dateInput.value);
    const today = formatDay(Date.now());
    dateInput.max = today;
    dateInput.disabled = state.running || !state.ready;
    previousDayButton.disabled = state.running || !state.ready || !day;
    nextDayButton.disabled = state.running || !state.ready || !day || day >= today;
    loadButton.disabled = state.running || !state.ready || !day;
  }
  syncDateNavigation();

  function contentCategory(item) {
    if (item?.isVideo) return "video";
    if (item?.formatWarning) return "other";
    const rawType = String(item?.rawType || "");
    const majorType = String(item?.majorType || "");
    if (["DYNAMIC_TYPE_WORD", "DYNAMIC_TYPE_DRAW", "DYNAMIC_TYPE_ARTICLE"].includes(rawType)) return "graphic";
    if (["MAJOR_TYPE_NONE", "MAJOR_TYPE_OPUS", "MAJOR_TYPE_DRAW", "MAJOR_TYPE_ARTICLE"].includes(majorType)) return "graphic";
    if (rawType || majorType) return "other";
    return "graphic";
  }

  function selectedDayCounts() {
    const counts = { total: 0, video: 0, graphic: 0, other: 0 };
    (state.cache[dateInput.value] || []).forEach((item) => {
      counts.total += 1;
      counts[contentCategory(item)] += 1;
    });
    return counts;
  }

  function clampPanelPosition(left, top) {
    const rect = panel.getBoundingClientRect();
    return {
      left: Math.max(8, Math.min(left, window.innerWidth - Math.min(rect.width, window.innerWidth - 16) - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8))
    };
  }

  function syncViewControls() {
    const filterNames = { all: "全部动态", video: "视频", graphic: "图文", other: "其他" };
    const counts = selectedDayCounts();
    const selectedFilterName = kindFilter === "all" ? filterNames.all : `仅${filterNames[kindFilter]}`;
    const filterLabel = `内容过滤：${selectedFilterName}；当天共 ${counts.total} 条，视频 ${counts.video}，图文 ${counts.graphic}，其他 ${counts.other}`;
    filterButton.classList.toggle("bdf-tool-active", kindFilter !== "all");
    filterButton.setAttribute("aria-label", filterLabel);
    filterButton.dataset.tooltip = `内容过滤 · 共 ${counts.total} 条`;
    filterMenu.querySelectorAll("[data-kind]").forEach((option) => {
      const selected = option.dataset.kind === kindFilter;
      option.classList.toggle("bdf-menu-selected", selected);
      option.setAttribute("aria-checked", String(selected));
      const countKey = option.dataset.kind === "all" ? "total" : option.dataset.kind;
      option.textContent = `${filterNames[option.dataset.kind]}（${counts[countKey]}）`;
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
    if (["all", "video", "graphic", "other"].includes(prefs.kind)) kindFilter = prefs.kind;
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

  resizeHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || panel.classList.contains("bdf-collapsed")) return;
    event.preventDefault();
    event.stopPropagation();
    const startRect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const pageX = window.scrollX;
    const pageY = window.scrollY;
    const scrollingElement = document.scrollingElement;
    let ended = false;

    const preventScroll = (scrollEvent) => scrollEvent.preventDefault();
    const restorePageScroll = () => {
      if (!scrollingElement || (window.scrollX === pageX && window.scrollY === pageY)) return;
      scrollingElement.scrollLeft = pageX;
      scrollingElement.scrollTop = pageY;
    };
    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      const maxWidth = Math.max(300, window.innerWidth - startRect.left - 8);
      const maxHeight = Math.max(260, window.innerHeight - startRect.top - 8);
      const width = Math.min(maxWidth, Math.max(300, startRect.width + moveEvent.clientX - startX));
      const height = Math.min(maxHeight, Math.max(260, startRect.height + moveEvent.clientY - startY));
      panel.style.width = `${Math.round(width)}px`;
      panel.style.height = `${Math.round(height)}px`;
      restorePageScroll();
    };
    const onEnd = () => {
      if (ended) return;
      ended = true;
      panel.classList.remove("bdf-resizing");
      resizeHandle.removeEventListener("pointermove", onMove);
      resizeHandle.removeEventListener("pointerup", onEnd);
      resizeHandle.removeEventListener("pointercancel", onEnd);
      resizeHandle.removeEventListener("lostpointercapture", onEnd);
      document.removeEventListener("wheel", preventScroll, true);
      document.removeEventListener("touchmove", preventScroll, true);
      window.removeEventListener("scroll", restorePageScroll);
      window.removeEventListener("blur", onEnd);
      restorePageScroll();
      savePanelPrefs();
    };

    resizeHandle.setPointerCapture(event.pointerId);
    panel.classList.add("bdf-resizing");
    document.addEventListener("wheel", preventScroll, { capture: true, passive: false });
    document.addEventListener("touchmove", preventScroll, { capture: true, passive: false });
    window.addEventListener("scroll", restorePageScroll, { passive: true });
    window.addEventListener("blur", onEnd);
    resizeHandle.addEventListener("pointermove", onMove);
    resizeHandle.addEventListener("pointerup", onEnd);
    resizeHandle.addEventListener("pointercancel", onEnd);
    resizeHandle.addEventListener("lostpointercapture", onEnd);
  });

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

  let updateCheckRunning = false;
  async function checkForUpdates(force) {
    if (updateCheckRunning) return;
    updateCheckRunning = true;
    updateCheckButton.disabled = true;
    updateCheckButton.dataset.state = "checking";
    updateCheckButton.textContent = "正在检查…";
    updateCheckButton.title = `当前版本 v${currentVersion}`;
    updateDownloadLink.hidden = true;

    try {
      const response = await new Promise((resolve, reject) => chrome.runtime.sendMessage({
        type: "bdf-check-update",
        force: Boolean(force)
      }, (result) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result);
      }));
      if (!response?.ok || !response.update) throw new Error(response?.error || "更新接口没有返回版本信息");

      const update = response.update;
      if (update.updateAvailable) {
        const targetUrl = update.downloadUrl || update.releaseUrl;
        if (!/^https:\/\/github\.com\/Horizon2333\/bilibili-daily-feed\/releases\//.test(targetUrl || "")) {
          throw new Error("新版下载地址无法确认");
        }
        updateCheckButton.dataset.state = "available";
        updateCheckButton.textContent = `新版 v${update.latestVersion}`;
        updateCheckButton.title = `当前版本 v${update.currentVersion}；最新版本 v${update.latestVersion}；点击重新检查`;
        updateDownloadLink.href = targetUrl;
        updateDownloadLink.hidden = false;
      } else {
        updateCheckButton.dataset.state = "latest";
        updateCheckButton.textContent = "已是最新版";
        updateCheckButton.title = `当前版本 v${update.currentVersion}；点击重新检查`;
      }
    } catch (error) {
      updateCheckButton.dataset.state = "error";
      updateCheckButton.textContent = "检查失败，重试";
      updateCheckButton.title = error.message || "检查更新失败";
    } finally {
      updateCheckButton.disabled = false;
      updateCheckRunning = false;
    }
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
    const accountChanged = state.accountKey !== key;
    if (state.watchLater.accountKey !== key) {
      state.watchLater = {
        accountKey: key,
        aids: new Set(),
        bvids: new Set(),
        aidByBvid: new Map(),
        loaded: false,
        checking: false,
        error: "",
        checkedAt: 0
      };
      watchLaterRefreshId += 1;
      watchLaterRefreshPromise = null;
    }
    const entry = ensureAccount(state.store, account, Date.now());
    state.account = account;
    state.accountKey = key;
    state.cache = entry.days;
    state.seen = new Set(Object.values(state.cache).flat().map((item) => item.key));
    if (accountChanged) {
      const rememberedDay = normalizeDay(entry.lastSelectedDay);
      const today = formatDay(Date.now());
      dateInput.value = rememberedDay && rememberedDay <= today ? rememberedDay : today;
      panelBody.scrollTop = 0;
    }
    syncDateNavigation();
  }

  async function storageSet(replace) {
    if (!state.accountKey) throw new Error("当前账号尚未初始化");
    const entry = ensureAccount(state.store, state.account, Date.now());
    entry.days = state.cache;
    const response = await new Promise((resolve, reject) => chrome.runtime.sendMessage({
      type: "bdf-save-cache",
      account: state.account,
      days: state.cache,
      selectedDay: dateInput.value,
      replace: Boolean(replace)
    }, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    }));
    if (!response?.ok) throw new Error(response?.error || "缓存保存失败");
    state.store = normalizeStore(response.store);
    state.cache = state.store.accounts[state.accountKey]?.days || {};
    renderCacheStats();
  }

  async function persistSelectedDay(day) {
    const selectedDay = normalizeDay(day);
    if (!selectedDay || !state.accountKey || !state.account) return;
    const entry = ensureAccount(state.store, state.account, Date.now());
    entry.lastSelectedDay = selectedDay;
    const response = await new Promise((resolve, reject) => chrome.runtime.sendMessage({
      type: "bdf-save-selected-day",
      account: state.account,
      selectedDay
    }, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    }));
    if (!response?.ok) throw new Error(response?.error || "续看日期保存失败");
  }

  function selectDay(day, persist) {
    const selectedDay = normalizeDay(day);
    const today = formatDay(Date.now());
    if (!selectedDay || selectedDay > today || state.running) {
      const rememberedDay = normalizeDay(state.store.accounts[state.accountKey]?.lastSelectedDay);
      dateInput.value = rememberedDay && rememberedDay <= today ? rememberedDay : today;
      syncDateNavigation();
      return;
    }
    dateInput.value = selectedDay;
    panelBody.scrollTop = 0;
    copyDiagnosticsButton.hidden = true;
    setStatus("");
    render();
    syncDateNavigation();
    void refreshWatchLaterStatus(true);
    if (persist && state.ready) {
      void persistSelectedDay(selectedDay).catch((error) => {
        setStatus(`日期已切换，但续看位置保存失败：${error.message}`, "error");
      });
    }
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
    clearTimeout(statusHideTimer);
    status.textContent = message;
    status.dataset.tone = tone || "normal";
    status.hidden = !message;
    retryButton.hidden = !canRetry;
    if (message && !canRetry && (!tone || ["normal", "success"].includes(tone))) {
      statusHideTimer = setTimeout(() => {
        status.hidden = true;
      }, 4500);
    }
  }

  function resetApiDiagnostics() {
    state.diagnostics.clear();
    copyDiagnosticsButton.hidden = true;
  }

  function recordApiDiagnostic(raw, item, page, index, explicitReason) {
    const dynamicId = String(raw?.id_str || "");
    const dynamicType = String(raw?.type || "未知");
    const majorType = String(raw?.modules?.module_dynamic?.major?.type || "无");
    let reason = explicitReason || item?.formatWarning || "";
    if (!item && !explicitReason) {
      const missing = [];
      if (!dynamicId) missing.push("动态 ID");
      if (!Number(raw?.modules?.module_author?.pub_ts || 0) && !parseDynamicTime(raw?.modules?.module_author?.pub_time)) {
        missing.push("发布时间");
      }
      reason = missing.length ? `缺少${missing.join("和")}` : "动态结构无法解析";
    }
    if (!reason) return;
    const key = dynamicId || `${page}:${index}:${dynamicType}:${majorType}`;
    state.diagnostics.set(key, { dynamicId, dynamicType, majorType, day: item?.day || "", page, index, reason });
  }

  function setFinalLoadStatus(message, tone) {
    const count = state.diagnostics.size;
    copyDiagnosticsButton.hidden = count === 0;
    if (count) {
      setStatus(`${message} 检测到 ${count} 条格式异常，已尽量保留可用入口。`, "warning");
    } else {
      setStatus(message, tone);
    }
  }

  function diagnosticsText() {
    const lines = [
      "B站动态按天看 · 解析异常信息",
      `扩展版本：v${currentVersion}`,
      `目标日期：${dateInput.value || "未知"}`,
      `生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      "说明：以下内容不包含 Cookie、账号信息或动态正文。",
      ""
    ];
    Array.from(state.diagnostics.values()).forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.reason}`,
        `   动态 ID：${item.dynamicId || "缺失"}`,
        `   所属日期：${item.day || "无法判断"}`,
        `   动态类型：${item.dynamicType}`,
        `   主内容类型：${item.majorType}`,
        `   接口页码：${item.page + 1}，页内序号：${item.index + 1}`
      );
    });
    return lines.join("\n");
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const textarea = el("textarea", { "aria-hidden": "true" });
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.documentElement.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("浏览器拒绝了复制操作");
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

  function authorMidFromSpaceHref(value) {
    const href = absoluteUrl(value);
    if (!href) return "";
    try {
      const url = new URL(href);
      if (url.hostname !== "space.bilibili.com") return "";
      const mid = url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || "";
      return mid !== "0" ? mid : "";
    } catch (_) { return ""; }
  }

  function authorSpaceHref(value) {
    const mid = String(value || "");
    return /^\d+$/.test(mid) && mid !== "0" ? `https://space.bilibili.com/${mid}` : "";
  }

  function csrfToken() {
    return document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1] || "";
  }

  function videoIdentity(item) {
    const saved = { aid: String(item.aid || ""), bvid: String(item.bvid || "") };
    if (/^\d+$/.test(saved.aid) || /^BV[0-9A-Za-z]+$/i.test(saved.bvid)) return saved;
    return globalThis.BiliDailyVideoMeta.extractVideoIdentity(firstText(item.contentHref, item.dynamicHref));
  }

  function watchLaterError(payload) {
    const knownErrors = {
      "-101": "账号未登录",
      "-111": "登录校验已失效，请刷新页面",
      "-400": "B 站未接受这个视频",
      "90001": "稍后再看列表已满",
      "90003": "视频已被删除"
    };
    return knownErrors[String(payload?.code)] || payload?.message || `添加失败（${payload?.code || "未知错误"}）`;
  }

  function addWatchLaterFromBackground(identity, csrf) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "bdf-add-watch-later", ...identity, csrf }, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "扩展后台没有响应" });
      });
    });
  }

  function removeWatchLaterFromBackground(aid, csrf) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "bdf-remove-watch-later", aid, csrf }, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "扩展后台没有响应" });
      });
    });
  }

  function getWatchLaterFromBackground() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "bdf-get-watch-later" }, (response) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(response || { ok: false, error: "扩展后台没有响应" });
      });
    });
  }

  function watchLaterIdsFromData(data) {
    const items = Array.isArray(data?.list) ? data.list : [];
    const videos = items.map((item) => ({ aid: String(item.aid || ""), bvid: String(item.bvid || "") }))
      .filter((item) => /^\d+$/.test(item.aid) || /^BV[0-9A-Za-z]+$/i.test(item.bvid));
    return {
      ok: true,
      aids: videos.map((item) => item.aid).filter((aid) => /^\d+$/.test(aid)),
      bvids: videos.map((item) => item.bvid).filter((bvid) => /^BV[0-9A-Za-z]+$/i.test(bvid)),
      videos
    };
  }

  async function requestWatchLaterIds() {
    try {
      const response = await fetch("https://api.bilibili.com/x/v2/history/toview/web?jsonp=jsonp", {
        credentials: "include",
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
      const payload = await response.json();
      if (payload.code !== 0 || !payload.data) throw new Error(watchLaterError(payload));
      return watchLaterIdsFromData(payload.data);
    } catch (_) {
      return getWatchLaterFromBackground();
    }
  }

  function isInWatchLater(identity) {
    return (identity.aid && state.watchLater.aids.has(identity.aid))
      || (identity.bvid && state.watchLater.bvids.has(identity.bvid));
  }

  function setWatchLaterButtonVisual(button, mode, message) {
    const labels = {
      checking: "正在检查稍后再看状态",
      adding: "正在加入稍后再看",
      removing: "正在从稍后再看移除",
      added: "从稍后再看移除",
      error: message || "添加失败，点击重试",
      ready: message ? `${message}；仍可点击加入` : "加入稍后再看",
      invalid: "无法识别视频编号"
    };
    button.dataset.state = mode;
    button.disabled = ["checking", "adding", "removing", "invalid"].includes(mode);
    button.title = labels[mode] || labels.ready;
    button.setAttribute("aria-label", labels[mode] || labels.ready);
  }

  function syncWatchLaterButtons() {
    panel.querySelectorAll(".bdf-watch-later").forEach((button) => {
      if (["adding", "removing"].includes(button.dataset.state)) return;
      const identity = {
        aid: button.dataset.watchLaterAid || "",
        bvid: button.dataset.watchLaterBvid || ""
      };
      if (!identity.aid && !identity.bvid) return setWatchLaterButtonVisual(button, "invalid");
      if (state.watchLater.checking && !state.watchLater.loaded) return setWatchLaterButtonVisual(button, "checking");
      if (isInWatchLater(identity)) return setWatchLaterButtonVisual(button, "added");
      setWatchLaterButtonVisual(button, "ready", state.watchLater.error);
    });
  }

  async function refreshWatchLaterStatus(force) {
    if (!state.ready || !state.accountKey) return;
    const now = Date.now();
    if (watchLaterRefreshPromise) return watchLaterRefreshPromise;
    if (!force && state.watchLater.checkedAt && now - state.watchLater.checkedAt < 30000) {
      syncWatchLaterButtons();
      return;
    }
    if (force && now - state.watchLater.checkedAt < 1500) return;

    state.watchLater.checking = true;
    state.watchLater.error = "";
    syncWatchLaterButtons();
    const refreshId = ++watchLaterRefreshId;
    const refreshPromise = requestWatchLaterIds()
      .then((response) => {
        if (refreshId !== watchLaterRefreshId) return;
        if (!response?.ok) throw new Error(response?.error || "无法读取稍后再看列表");
        state.watchLater.aids = new Set(response.aids || []);
        state.watchLater.bvids = new Set(response.bvids || []);
        state.watchLater.aidByBvid = new Map((response.videos || [])
          .filter((video) => /^\d+$/.test(video.aid) && /^BV[0-9A-Za-z]+$/i.test(video.bvid))
          .map((video) => [video.bvid, video.aid]));
        state.watchLater.loaded = true;
        state.watchLater.checkedAt = Date.now();
      })
      .catch((error) => {
        if (refreshId !== watchLaterRefreshId) return;
        state.watchLater.error = error.message || "无法确认稍后再看状态";
        state.watchLater.checkedAt = Date.now();
      })
      .finally(() => {
        if (refreshId !== watchLaterRefreshId) return;
        state.watchLater.checking = false;
        watchLaterRefreshPromise = null;
        syncWatchLaterButtons();
      });
    watchLaterRefreshPromise = refreshPromise;
    return refreshPromise;
  }

  function createWatchLaterControl(item, overlay) {
    const identity = videoIdentity(item);
    const group = el("span", {
      className: `bdf-watch-later-group${overlay ? " bdf-watch-later-overlay" : ""}`
    });
    const button = el("button", {
      className: `bdf-watch-later${overlay ? " bdf-watch-later-cover-button" : ""}`,
      type: "button",
      "data-watch-later-aid": identity.aid,
      "data-watch-later-bvid": identity.bvid
    });
    button.innerHTML = `
      <svg class="bdf-watch-later-clock" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5"></circle>
        <path d="M12 7.5v5l3.5 2"></path>
      </svg>
      <svg class="bdf-watch-later-check" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6.5 12.5 3.4 3.4 7.7-8"></path>
      </svg>
      <span class="bdf-watch-later-text">稍后再看</span>`;
    const feedback = el("span", { className: "bdf-watch-later-feedback", "aria-live": "polite" });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleWatchLater(item, button, feedback);
    });
    group.append(button, feedback);
    const mode = !identity.aid && !identity.bvid
      ? "invalid"
      : state.watchLater.checking && !state.watchLater.loaded
        ? "checking"
        : isInWatchLater(identity) ? "added" : "ready";
    setWatchLaterButtonVisual(button, mode);
    return group;
  }

  async function requestAddWatchLater(identity, csrf) {
    const body = new URLSearchParams({ csrf });
    if (identity.aid) body.set("aid", identity.aid);
    else body.set("bvid", identity.bvid);
    try {
      const response = await fetch("https://api.bilibili.com/x/v2/history/toview/add", {
        method: "POST",
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        body
      });
      if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
      const payload = await response.json();
      return payload.code === 0 ? { ok: true } : { ok: false, error: watchLaterError(payload) };
    } catch (_) {
      // Content scripts follow the page's CORS policy. Keep the extension
      // service worker as a fallback for browser configurations that block it.
      return addWatchLaterFromBackground(identity, csrf);
    }
  }

  async function requestRemoveWatchLater(aid, csrf) {
    const body = new URLSearchParams({ aid, csrf });
    try {
      const response = await fetch("https://api.bilibili.com/x/v2/history/toview/del", {
        method: "POST",
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
        },
        body
      });
      if (!response.ok) throw new Error(`B 站接口返回 ${response.status}`);
      const payload = await response.json();
      return payload.code === 0 ? { ok: true } : { ok: false, error: watchLaterError(payload) };
    } catch (_) {
      return removeWatchLaterFromBackground(aid, csrf);
    }
  }

  async function removeWatchLater(item, button, feedback) {
    const identity = videoIdentity(item);
    const aid = /^\d+$/.test(identity.aid) ? identity.aid : state.watchLater.aidByBvid.get(identity.bvid) || "";
    const csrf = csrfToken();
    if (!aid) {
      feedback.textContent = "无法识别 AV 号，请返回页面后重试";
      setWatchLaterButtonVisual(button, "error", feedback.textContent);
      return;
    }
    if (!csrf) {
      feedback.textContent = "登录校验不可用";
      setWatchLaterButtonVisual(button, "error", "无法获取登录校验信息，请刷新动态页");
      return;
    }

    setWatchLaterButtonVisual(button, "removing");
    feedback.textContent = "";
    const response = await requestRemoveWatchLater(aid, csrf);
    if (!response?.ok) {
      setWatchLaterButtonVisual(button, "error", response?.error || "移除失败");
      feedback.textContent = response?.error || "移除失败";
      setStatus(response?.error || "从稍后再看移除失败", "error");
      return;
    }

    state.watchLater.aids.delete(aid);
    if (identity.bvid) {
      state.watchLater.bvids.delete(identity.bvid);
      state.watchLater.aidByBvid.delete(identity.bvid);
    }
    for (const [bvid, mappedAid] of state.watchLater.aidByBvid) {
      if (mappedAid !== aid) continue;
      state.watchLater.bvids.delete(bvid);
      state.watchLater.aidByBvid.delete(bvid);
    }
    setWatchLaterButtonVisual(button, "ready");
    syncWatchLaterButtons();
    feedback.textContent = "已移除";
    setTimeout(() => {
      if (feedback.isConnected && button.dataset.state === "ready") feedback.textContent = "";
    }, 1400);
  }

  function toggleWatchLater(item, button, feedback) {
    return isInWatchLater(videoIdentity(item))
      ? removeWatchLater(item, button, feedback)
      : addWatchLater(item, button, feedback);
  }

  async function addWatchLater(item, button, feedback) {
    const identity = videoIdentity(item);
    const csrf = csrfToken();
    if (!identity.aid && !identity.bvid) {
      feedback.textContent = "无法识别视频编号";
      setStatus("无法识别这个视频的 AV/BV 号，请先打开视频页面。", "error");
      return;
    }
    if (!csrf) {
      feedback.textContent = "登录校验不可用";
      setStatus("无法获取登录校验信息，请重新登录或刷新动态页。", "error");
      return;
    }
    setWatchLaterButtonVisual(button, "adding");
    feedback.textContent = "";
    const response = await requestAddWatchLater(identity, csrf);
    if (!response?.ok) {
      setWatchLaterButtonVisual(button, "error", response?.error || "添加稍后再看失败");
      feedback.textContent = response?.error || "添加失败";
      setStatus(response?.error || "添加稍后再看失败", "error");
      return;
    }
    if (identity.aid) state.watchLater.aids.add(identity.aid);
    if (identity.bvid) state.watchLater.bvids.add(identity.bvid);
    if (identity.aid && identity.bvid) state.watchLater.aidByBvid.set(identity.bvid, identity.aid);
    if (!identity.aid && identity.bvid) {
      state.watchLater.checkedAt = 0;
      await refreshWatchLaterStatus(true);
    }
    setWatchLaterButtonVisual(button, "added");
    syncWatchLaterButtons();
    feedback.textContent = "已加入";
    setTimeout(() => {
      if (feedback.isConnected && button.dataset.state === "added") feedback.textContent = "";
    }, 1400);
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

  const SUPPORTED_MAJOR_TYPES = new Set([
    "MAJOR_TYPE_NONE",
    "MAJOR_TYPE_ARCHIVE",
    "MAJOR_TYPE_UGC_SEASON",
    "MAJOR_TYPE_OPUS",
    "MAJOR_TYPE_DRAW",
    "MAJOR_TYPE_ARTICLE",
    "MAJOR_TYPE_COMMON"
  ]);

  function normalizeApiItem(raw) {
    const authorModule = raw?.modules?.module_author || {};
    const dynamicModule = raw?.modules?.module_dynamic || {};
    const major = dynamicModule.major || {};
    const dynamicId = String(raw?.id_str || "");
    const standardTimestamp = Number(authorModule.pub_ts || 0);
    const inferredPublished = standardTimestamp ? null : parseDynamicTime(authorModule.pub_time);
    const pubTimestamp = standardTimestamp * 1000 || inferredPublished?.getTime() || 0;
    if (!dynamicId || !pubTimestamp) return null;

    const archive = major.archive || {};
    const ugcSeason = major.ugc_season || {};
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
      ugcSeason.title,
      article.title,
      opus.title,
      common.title
    );
    const firstParagraph = descText.split(/\n\s*\n|\n/).map((part) => part.trim()).find(Boolean) || "";
    const title = firstText(formalTitle, firstParagraph, "无标题动态").slice(0, 180);
    const preview = contentPreview(descText, 320);
    const image = apiImageUrl(firstText(
      archive.cover,
      ugcSeason.cover,
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
      ugcSeason.jump_url,
      article.jump_url,
      opus.jump_url,
      common.jump_url,
      major.jump_url
    ));
    const videoMeta = globalThis.BiliDailyVideoMeta.extractApiVideoInfo(
      major,
      dynamicModule.additional && dynamicModule.additional.ugc
    );
    const isVideo = raw.type === "DYNAMIC_TYPE_AV"
      || raw.type === "DYNAMIC_TYPE_UGC_SEASON"
      || videoMeta.isVideo;
    const published = new Date(pubTimestamp);
    const rawType = String(raw.type || "");
    const majorType = String(major.type || "");
    const formatWarnings = [];
    if (!standardTimestamp) formatWarnings.push("缺少标准发布时间，日期由显示文本推断");
    if (majorType && !SUPPORTED_MAJOR_TYPES.has(majorType)) formatWarnings.push(`暂未完整适配 ${majorType}`);
    const authorMid = (/^\d+$/.test(String(authorModule.mid || "")) && String(authorModule.mid) !== "0")
      ? String(authorModule.mid)
      : authorMidFromSpaceHref(authorModule.jump_url);

    return {
      key: dynamicId,
      day: formatDay(published),
      timeText: standardTimestamp
        ? published.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : `${formatDay(published)} · 时间未知`,
      author: firstText(authorModule.name, "未知账号"),
      authorMid,
      avatar: apiImageUrl(authorModule.face),
      title,
      preview,
      image,
      imageCount,
      dynamicHref: `https://www.bilibili.com/opus/${dynamicId}`,
      contentHref,
      isVideo,
      durationText: videoMeta.durationText,
      chargeLabel: videoMeta.chargeLabel,
      isCollection: videoMeta.isCollection,
      collectionLabel: videoMeta.collectionLabel,
      rawType,
      majorType,
      formatWarning: formatWarnings.join("；"),
      aid: videoMeta.aid || String(raw.basic?.rid_str || ""),
      bvid: videoMeta.bvid,
      pubTimestamp
    };
  }

  function fallbackApiItem(raw, reason) {
    const authorModule = raw?.modules?.module_author || {};
    const dynamicId = String(raw?.id_str || "");
    const standardTimestamp = Number(authorModule.pub_ts || 0);
    const inferredPublished = standardTimestamp ? null : parseDynamicTime(authorModule.pub_time);
    const pubTimestamp = standardTimestamp * 1000 || inferredPublished?.getTime() || 0;
    if (!dynamicId || !pubTimestamp) return null;
    const published = new Date(pubTimestamp);
    const authorMid = (/^\d+$/.test(String(authorModule.mid || "")) && String(authorModule.mid) !== "0")
      ? String(authorModule.mid)
      : authorMidFromSpaceHref(authorModule.jump_url);
    return {
      key: dynamicId,
      day: formatDay(published),
      timeText: standardTimestamp
        ? published.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        : `${formatDay(published)} · 时间未知`,
      author: firstText(authorModule.name, "未知账号"),
      authorMid,
      avatar: apiImageUrl(authorModule.face),
      title: "暂时无法解析的动态",
      preview: "这条动态的格式暂未适配，请打开原动态查看。",
      image: "",
      imageCount: 0,
      dynamicHref: `https://www.bilibili.com/opus/${dynamicId}`,
      contentHref: "",
      isVideo: raw?.type === "DYNAMIC_TYPE_AV",
      durationText: "",
      chargeLabel: "",
      isCollection: false,
      collectionLabel: "",
      rawType: String(raw?.type || ""),
      majorType: String(raw?.modules?.module_dynamic?.major?.type || ""),
      formatWarning: reason || "动态结构无法解析",
      aid: String(raw?.basic?.rid_str || ""),
      bvid: "",
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
      const rawItems = Array.isArray(data.items) ? data.items : [];
      const items = rawItems.map((raw, index) => {
        try {
          const item = normalizeApiItem(raw);
          recordApiDiagnostic(raw, item, pages, index);
          return item;
        } catch (error) {
          const reason = `解析失败：${error.message || "未知错误"}`;
          const fallback = fallbackApiItem(raw, reason);
          recordApiDiagnostic(raw, fallback, pages, index, reason);
          return fallback;
        }
      }).filter(Boolean);
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
      if (!rawItems.length) break;
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
    const videoLink = contentLinks.find((link) => {
      const identity = globalThis.BiliDailyVideoMeta.extractVideoIdentity(link.getAttribute("href"));
      return Boolean(identity.aid || identity.bvid);
    });
    const { dynamicId, dynamicHref } = findDynamicIdentity(card, cardLinks);
    const authorNode = card.querySelector(".bili-dyn-title__text, .bili-dyn-title, [class*='author']");
    const avatarNode = card.querySelector(".bili-dyn-item__avatar img, .bili-dyn-avatar img, [class*='avatar'] img");
    const authorLink = authorNode?.closest("a[href]")
      || avatarNode?.closest("a[href]")
      || card.querySelector(".bili-dyn-item__header a[href*='space.bilibili.com'], a.bili-dyn-title[href*='space.bilibili.com']")
      || cardLinks.find((link) => /space\.bilibili\.com/.test(link.getAttribute("href") || ""));
    const cardText = (card.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const contentText = (contentRoot.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
    const author = (authorNode && authorNode.textContent || cardText.split("\n")[0] || "未知账号").trim();
    const authorMid = authorMidFromSpaceHref(authorLink?.getAttribute("href"));
    const avatar = avatarNode ? apiImageUrl(avatarNode.currentSrc || avatarNode.src || avatarNode.getAttribute("data-src") || "") : "";
    const title = findTitle(contentRoot, videoLink, author, timeText);
    const preview = contentPreview(contentText, 320);
    const images = findImages(contentRoot);
    const image = images[0] || "";
    const isCollection = /合集|更新了合集/.test(cardText);
    const isVideo = Boolean(videoLink) || isCollection || /投稿了视频|发布了动态视频|联合创作/.test(cardText);
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
    const identity = globalThis.BiliDailyVideoMeta.extractVideoIdentity(contentHref);
    const linkFingerprint = contentLinks.map((link) => absoluteUrl(link.getAttribute("href"))).filter(Boolean).join("|");
    const key = dynamicId || dynamicHref || fingerprint(`${formatDay(parsed)}|${timeText}|${author}|${contentText}|${image}|${linkFingerprint}`);
    return {
      key, day: formatDay(parsed), timeText, author, authorMid, avatar, title, preview, image,
      imageCount: images.length, dynamicHref, contentHref, isVideo, durationText, chargeLabel,
      isCollection, collectionLabel: isCollection ? "合集" : "", aid: identity.aid, bvid: identity.bvid,
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

  function render() {
    const day = dateInput.value;
    const kind = kindFilter;
    const direction = sortOrder === "newest" ? -1 : 1;
    const items = (state.cache[day] || [])
      .filter((item) => kind === "all" || contentCategory(item) === kind)
      .map((item, index) => ({ item, index }))
      .sort((left, right) => {
        const leftTime = Number(left.item.pubTimestamp);
        const rightTime = Number(right.item.pubTimestamp);
        if (leftTime && rightTime && leftTime !== rightTime) return (leftTime - rightTime) * direction;
        return (right.index - left.index) * direction;
      })
      .map(({ item }) => item);
    syncViewControls();
    renderCacheStats();
    results.replaceChildren();
    const summary = el("div", { className: "bdf-summary" });
    const accountName = state.account?.name || (state.accountKey ? `UID ${state.accountKey}` : "未登录");
    const kindLabel = { all: "动态", video: "视频", graphic: "图文", other: "其他" }[kind] || "动态";
    summary.append(el("span", { text: `账号：${accountName} · ${day} · ${items.length} 条${kindLabel}` }));
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
      const dynamicHref = absoluteUrl(item.dynamicHref);
      const contentHref = absoluteUrl(item.contentHref);
      const authorHref = authorSpaceHref(item.authorMid);
      const authorName = item.author || "未知账号";
      if (safeAvatar) {
        const avatar = el("img", { className: "bdf-avatar", src: safeAvatar, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        if (authorHref) {
          const avatarLink = el("a", {
            className: "bdf-avatar-link",
            href: authorHref,
            target: "_blank",
            rel: "noopener",
            title: `打开 ${authorName} 的主页`,
            "aria-label": `打开 ${authorName} 的主页`
          });
          avatarLink.append(avatar);
          authorRow.append(avatarLink);
        } else {
          authorRow.append(avatar);
        }
      }
      const authorInfo = el("div", { className: "bdf-author-info" });
      authorInfo.append(authorHref
        ? el("a", { className: "bdf-author bdf-author-link", href: authorHref, target: "_blank", rel: "noopener", text: authorName, title: `打开 ${authorName} 的主页` })
        : el("div", { className: "bdf-author", text: authorName }));
      const meta = el("div", { className: "bdf-meta" });
      meta.append(document.createTextNode(`${item.timeText}${item.isVideo ? " · 视频" : ""}`));
      if (item.durationText) {
        meta.append(el("span", { className: "bdf-duration", text: `时长 ${item.durationText}` }));
      }
      if (item.isCollection) {
        meta.append(el("span", { className: "bdf-collection-badge", text: item.collectionLabel || "合集" }));
      }
      if (Number(item.imageCount) > 1) {
        meta.append(el("span", { className: "bdf-image-count", text: `共 ${item.imageCount} 张` }));
      }
      if (item.formatWarning) {
        meta.append(el("span", { className: "bdf-format-warning", text: "格式待适配", title: item.formatWarning }));
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
          ? firstText(contentHref, dynamicHref)
          : firstText(dynamicHref, contentHref);
        let coverContent;
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
          coverContent = coverLink;
        } else {
          cover.classList.add("bdf-cover-standalone");
          coverContent = cover;
        }
        if (item.isVideo) {
          const coverWrap = el("div", { className: "bdf-video-cover-wrap" });
          coverWrap.append(coverContent, createWatchLaterControl(item, true));
          card.append(coverWrap);
        } else {
          card.append(coverContent);
        }
      }
      const validTitle = item.title && !/^(?:MAJOR|DYNAMIC|ADDITIONAL|MODULE)_TYPE_[A-Z0-9_]+$/.test(item.title);
      const validPreview = item.preview && !/^(?:MAJOR|DYNAMIC|ADDITIONAL|MODULE)_TYPE_[A-Z0-9_]+$/.test(item.preview);
      const displayTitle = validTitle && item.title !== "无标题动态"
        ? item.title
        : firstText(validPreview ? item.preview.split(/\n\s*\n|\n/)[0] : "", "无标题动态").slice(0, 180);
      const titleRow = el("div", { className: "bdf-title-row" });
      if (item.chargeLabel) titleRow.append(el("span", { className: "bdf-charge-badge", text: item.chargeLabel }));
      titleRow.append(dynamicHref
        ? el("a", { className: "bdf-title bdf-title-link", href: dynamicHref, target: "_blank", rel: "noopener", text: displayTitle, title: "打开原动态" })
        : el("div", { className: "bdf-title", text: displayTitle }));
      card.append(titleRow);
      if (validPreview && item.preview !== displayTitle) card.append(el("div", { className: "bdf-preview", text: item.preview }));
      const links = el("div", { className: "bdf-result-links" });
      if (dynamicHref) links.append(el("a", { href: dynamicHref, target: "_blank", rel: "noopener", text: "打开动态 →" }));
      if (contentHref && contentHref !== dynamicHref) {
        links.append(el("a", { href: contentHref, target: "_blank", rel: "noopener", text: item.isVideo ? "打开视频 →" : "打开内容 →" }));
      }
      if (item.isVideo && !safeImage) links.append(createWatchLaterControl(item, false));
      if (!dynamicHref && liveCards.has(item.key)) {
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
    void refreshWatchLaterStatus(false);
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function loadSelectedDay() {
    if (state.running || !state.ready || !dateInput.value) return;
    resetApiDiagnostics();
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
    syncDateNavigation();
    const target = startOfDay(`${dateInput.value}T00:00:00`).getTime();
    let previousCount = document.querySelectorAll(CARD_SELECTOR).length;
    let rounds = 0;

    setStatus("正在通过 B 站动态接口读取…", "working");

    try {
      try {
        const apiResult = await loadSelectedDayFromApi(target);
        await storageSet();
        const found = (state.cache[dateInput.value] || []).length;
        if (state.stopRequested) setFinalLoadStatus(`已停止，已缓存 ${found} 条当天动态。`, "normal");
        else if (apiResult.crossed) setFinalLoadStatus(`已越过目标日期；当天共缓存 ${found} 条。`, "success");
        else setFinalLoadStatus(`接口已到达末尾；当天共缓存 ${found} 条。`, "normal");
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
      await storageSet();
      render();
      const found = (state.cache[dateInput.value] || []).length;
      if (state.stopRequested) setFinalLoadStatus(`已停止，已缓存 ${found} 条当天动态。`, "normal");
      else if (state.unchangedRounds >= 8) setFinalLoadStatus(`页面不再加载；当天共缓存 ${found} 条。`, "normal");
      else setFinalLoadStatus(`已越过目标日期；当天共缓存 ${found} 条。`, "success");
    } catch (error) {
      try { await storageSet(); } catch (_) { /* Keep the original loading error. */ }
      render();
      copyDiagnosticsButton.hidden = state.diagnostics.size === 0;
      setStatus(`加载中断：${error.message || "页面发生变化"}`, "error");
    } finally {
      state.running = false;
      stopButton.disabled = true;
      syncDateNavigation();
    }
  }

  loadButton.addEventListener("click", loadSelectedDay);
  stopButton.addEventListener("click", () => { state.stopRequested = true; });
  copyDiagnosticsButton.addEventListener("click", async () => {
    try {
      await copyText(diagnosticsText());
      setStatus("异常信息已复制，可直接粘贴到 GitHub Issue。", "success");
    } catch (error) {
      setStatus(`复制失败：${error.message}`, "error");
    }
  });
  dateInput.addEventListener("change", () => {
    selectDay(dateInput.value, true);
  });
  previousDayButton.addEventListener("click", () => selectDay(shiftDay(dateInput.value, -1), true));
  nextDayButton.addEventListener("click", () => selectDay(shiftDay(dateInput.value, 1), true));
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
    if (event.altKey && !event.ctrlKey && !event.metaKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault();
      selectDay(shiftDay(dateInput.value, event.key === "ArrowLeft" ? -1 : 1), true);
      return;
    }
    if (event.key === "Escape") {
      const openButton = panel.querySelector(".bdf-tool-button[aria-expanded='true']");
      closeToolMenus();
      openButton?.focus();
    }
  });
  panel.querySelector("#bdf-collapse").addEventListener("click", () => {
    panel.classList.toggle("bdf-collapsed");
    if (!panel.classList.contains("bdf-collapsed")) void refreshWatchLaterStatus(true);
  });
  panel.querySelector("#bdf-clear").addEventListener("click", async () => {
    try {
      await refreshAccount();
      state.cache = {};
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
      syncDateNavigation();
      render();
      setStatus("");
    } catch (error) {
      state.ready = false;
      syncDateNavigation();
      setStatus(error.message || "初始化失败", "error", true);
    } finally {
      retryButton.disabled = false;
    }
  }

  retryButton.addEventListener("click", initialize);
  updateCheckButton.addEventListener("click", () => void checkForUpdates(true));
  initialize();
  void checkForUpdates(false);

  window.addEventListener("focus", () => void refreshWatchLaterStatus(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refreshWatchLaterStatus(true);
  });

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
