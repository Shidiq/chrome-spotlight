(() => {
  // On-demand injection (background retry) can race the manifest's
  // document_idle injection — a second copy would register a duplicate
  // message listener and instantly open+close the overlay.
  if (window.__spotlightContent) return;
  window.__spotlightContent = true;

  const SEARCH_ENGINES = {
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    brave: { name: "Brave", url: "https://search.brave.com/search?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" }
  };
  const DEFAULT_ENGINE = "duckduckgo";
  const DEFAULT_TASKVIEW_SHORTCUT = { alt: true, ctrl: false, shift: false, meta: false, key: "Tab" };

  let hostEl = null;
  let inputEl = null;
  let suggestionsEl = null;
  let suggestions = [];
  let selectedIdx = -1;
  let debounceTimer = null;
  let lastQueryId = 0;
  let searchEngine = DEFAULT_ENGINE;
  let loadingAnimation = true;
  let allTabs = [];
  let tabUrls = new Set();
  let tabMatches = [];
  let bhMatches = [];
  let taskViewShortcut = DEFAULT_TASKVIEW_SHORTCUT;

  chrome.storage.sync.get(
    {
      searchEngine: DEFAULT_ENGINE,
      loadingAnimation: true,
      taskViewShortcut: DEFAULT_TASKVIEW_SHORTCUT,
    },
    (r) => {
      searchEngine = r.searchEngine;
      loadingAnimation = r.loadingAnimation;
      taskViewShortcut = r.taskViewShortcut;
    }
  );
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "sync") return;
    if (c.searchEngine) searchEngine = c.searchEngine.newValue;
    if (c.loadingAnimation) loadingAnimation = c.loadingAnimation.newValue;
    if (c.taskViewShortcut) taskViewShortcut = c.taskViewShortcut.newValue;
  });

  function resolveQuery(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (!/\s/.test(trimmed) && /\./.test(trimmed)) return "https://" + trimmed;
    const engine = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES[DEFAULT_ENGINE];
    return engine.url + encodeURIComponent(trimmed);
  }

  function close() {
    if (!hostEl) return;
    hostEl.remove();
    hostEl = null;
    inputEl = null;
    suggestionsEl = null;
    suggestions = [];
    selectedIdx = -1;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function navigate(url, newTab) {
    close();
    // Same-tab navigation reloads this page — show the loader immediately to
    // bridge the wait before the destination's document_start fires. New-tab
    // navigation leaves the current page untouched, so no loader.
    if (!newTab && loadingAnimation && window.__spotlightLoader) {
      window.__spotlightLoader.show();
      // Safety net: if navigation fails, don't leave a stuck overlay.
      setTimeout(() => {
        if (window.__spotlightLoader) window.__spotlightLoader.hide();
      }, 8000);
    }
    const type = newTab ? "OPEN_NEW_TAB" : "OPEN_CURRENT_TAB";
    chrome.runtime.sendMessage({ type, url }, () => {
      void chrome.runtime.lastError;
    });
  }

  function activateTab(tabId, windowId) {
    close();
    chrome.runtime.sendMessage({ type: "ACTIVATE_TAB", tabId, windowId }, () => {
      void chrome.runtime.lastError;
    });
  }

  function onSelect(s, newTab) {
    if (!s) return;
    if (s.type === "tab") activateTab(s.tabId, s.windowId);
    else navigate(s.url, newTab);
  }

  // Case-insensitive subsequence match. Returns a score (higher is better),
  // or -1 if not every query char is found in order.
  function fuzzyScore(query, text) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = (text || "").toLowerCase();
    let qi = 0;
    let score = 0;
    let prevIdx = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += prevIdx === ti - 1 ? 3 : 1; // contiguous-run bonus
        if (ti === 0) score += 2; // start-of-string boost
        prevIdx = ti;
        qi++;
      }
    }
    return qi === q.length ? score : -1;
  }

  function toTabSuggestion(t) {
    return {
      type: "tab",
      title: t.title || t.url,
      url: t.url,
      tabId: t.tabId,
      windowId: t.windowId,
      favIconUrl: t.favIconUrl,
    };
  }

  function getTabMatches(query) {
    const q = query.trim();
    if (!q) return allTabs.slice(0, 8).map(toTabSuggestion);
    return allTabs
      .map((t) => ({
        t,
        score: Math.max(fuzzyScore(q, t.title), fuzzyScore(q, t.url)),
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => toTabSuggestion(x.t));
  }

  function rebuildSuggestions() {
    suggestions = [...tabMatches, ...bhMatches];
    if (selectedIdx >= suggestions.length) selectedIdx = suggestions.length - 1;
    renderSuggestions();
  }

  const ICON_SVGS = {
    tab: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><ellipse cx="8" cy="8" rx="2.8" ry="6.2"/><path d="M2 8h12"/></svg>',
    bookmark:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 1.7l1.9 3.9 4.3.6-3.1 3 .7 4.2L8 11.4l-3.8 2 .7-4.2-3.1-3 4.3-.6z"/></svg>',
    history:
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.5V8l2.4 1.6"/></svg>',
  };

  const BADGE_LABELS = { tab: "TAB", bookmark: "BOOKMARK", history: "HISTORY" };

  function makeTypeIcon(type) {
    const span = document.createElement("span");
    span.className = "icon";
    span.innerHTML = ICON_SVGS[type] || ICON_SVGS.history;
    return span;
  }

  function appendRow(s, i) {
    const row = document.createElement("div");
    row.className = "row" + (i === selectedIdx ? " selected" : "");

    let icon;
    if (s.type === "tab" && s.favIconUrl) {
      icon = document.createElement("img");
      icon.className = "favicon";
      icon.src = s.favIconUrl;
      icon.addEventListener("error", () => {
        icon.replaceWith(makeTypeIcon(s.type));
      });
    } else {
      icon = makeTypeIcon(s.type);
    }

    const text = document.createElement("div");
    text.className = "text";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.title;

    const url = document.createElement("div");
    url.className = "url";
    url.textContent = s.url;

    text.appendChild(title);
    text.appendChild(url);

    const badge = document.createElement("span");
    badge.className = "badge badge-" + s.type;
    badge.textContent = BADGE_LABELS[s.type] || s.type.toUpperCase();

    const numBadge = document.createElement("span");
    numBadge.className = "num-badge";
    if (i < 9) numBadge.textContent = String(i + 1);
    else numBadge.style.visibility = "hidden";

    row.appendChild(numBadge);
    row.appendChild(icon);
    row.appendChild(text);
    row.appendChild(badge);

    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSelect(s, !e.shiftKey);
    });
    row.addEventListener("mouseenter", () => {
      selectedIdx = i;
      updateSelectionHighlight();
    });

    suggestionsEl.appendChild(row);
  }

  function renderSuggestions() {
    if (!suggestionsEl) return;
    suggestionsEl.innerHTML = "";

    if (suggestions.length === 0) {
      suggestionsEl.style.display = "none";
      return;
    }
    suggestionsEl.style.display = "block";

    const renderSection = (label, items, offset) => {
      if (!items.length) return;
      const header = document.createElement("div");
      header.className = "section-header";
      header.textContent = label;
      suggestionsEl.appendChild(header);
      items.forEach((s, j) => appendRow(s, offset + j));
    };

    renderSection("Open Tabs", tabMatches, 0);
    renderSection("Bookmarks & History", bhMatches, tabMatches.length);
  }

  function updateSelectionHighlight() {
    if (!suggestionsEl) return;
    const rows = suggestionsEl.querySelectorAll(".row");
    rows.forEach((r, i) => {
      r.classList.toggle("selected", i === selectedIdx);
      if (i === selectedIdx) r.scrollIntoView({ block: "nearest" });
    });
  }

  function requestSuggestions(query) {
    const myId = ++lastQueryId;
    chrome.runtime.sendMessage(
      { type: "SEARCH_SUGGESTIONS", query },
      (response) => {
        void chrome.runtime.lastError;
        if (myId !== lastQueryId) return;
        const items = (response && response.suggestions) || [];
        // An already-open tab beats reloading the same URL from history.
        bhMatches = items.filter((s) => !tabUrls.has(s.url));
        rebuildSuggestions();
      }
    );
  }

  function onInputChange(value) {
    if (debounceTimer) clearTimeout(debounceTimer);
    const trimmed = value.trim();
    if (!trimmed) {
      lastQueryId++;
      bhMatches = [];
      tabMatches = getTabMatches("");
      selectedIdx = tabMatches.length ? 0 : -1;
      rebuildSuggestions();
      return;
    }
    tabMatches = getTabMatches(trimmed);
    // No default selection while typing: plain Enter must keep resolving the
    // raw query (URL / search engine) unless the user picks a row.
    selectedIdx = -1;
    rebuildSuggestions();
    debounceTimer = setTimeout(() => requestSuggestions(trimmed), 80);
  }

  function open() {
    if (hostEl) return;
    allTabs = [];
    tabUrls = new Set();
    tabMatches = [];
    bhMatches = [];

    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.inset = "0";
    hostEl.style.zIndex = "2147483647";
    hostEl.style.pointerEvents = "none";

    const shadow = hostEl.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        --sp-bg: rgba(40, 40, 44, 0.96);
        --sp-text: #ffffff;
        --sp-text-secondary: #e0e0e0;
        --sp-muted: rgba(235, 235, 245, 0.6);
        --sp-placeholder: rgba(235, 235, 245, 0.35);
        --sp-border: rgba(255, 255, 255, 0.1);
        --sp-accent: #3b82f6;
        --sp-on-accent: #ffffff;
        --sp-badge-bg: rgba(255, 255, 255, 0.1);
        --sp-badge-tab-bg: rgba(59, 130, 246, 0.28);
        --sp-badge-tab-text: #9cc2ff;
        --sp-panel-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255, 255, 255, 0.12);
      }
      @media (prefers-color-scheme: light) {
        :host {
          --sp-bg: rgba(238, 238, 240, 0.97);
          --sp-text: #1d1d1f;
          --sp-text-secondary: #1d1d1f;
          --sp-muted: #6e6e73;
          --sp-placeholder: #a1a1a6;
          --sp-border: rgba(0, 0, 0, 0.08);
          --sp-accent: #3478f6;
          --sp-on-accent: #ffffff;
          --sp-badge-bg: rgba(0, 0, 0, 0.07);
          --sp-badge-tab-bg: rgba(52, 120, 246, 0.12);
          --sp-badge-tab-text: #3478f6;
          --sp-panel-shadow: 0 24px 70px rgba(0, 0, 0, 0.25), 0 0 0 0.5px rgba(0, 0, 0, 0.1);
        }
      }
      :host, * { box-sizing: border-box; }
      .backdrop {
        position: fixed;
        inset: 0;
        background: transparent;
        pointer-events: auto;
      }
      .panel {
        position: fixed;
        top: 24vh;
        left: 50%;
        transform: translateX(-50%) translateY(-4px);
        width: 600px;
        max-width: calc(100vw - 32px);
        padding: 10px;
        background: var(--sp-bg);
        -webkit-backdrop-filter: blur(24px) saturate(1.4);
        backdrop-filter: blur(24px) saturate(1.4);
        border-radius: 14px;
        box-shadow: var(--sp-panel-shadow);
        opacity: 0;
        transition: opacity 100ms ease-out, transform 100ms ease-out;
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .search-field {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
      }
      .search-icon {
        flex: 0 0 auto;
        display: flex;
        color: var(--sp-muted);
      }
      input.spotlight-input {
        flex: 1 1 auto;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;
        color: var(--sp-text);
        font: 16px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 0;
        margin: 0;
        caret-color: var(--sp-text);
      }
      input.spotlight-input::placeholder {
        color: var(--sp-placeholder);
      }
      .close-btn {
        flex: 0 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: var(--sp-muted);
        cursor: pointer;
        padding: 0;
      }
      .close-btn:hover {
        background: var(--sp-badge-bg);
        color: var(--sp-text);
      }
      .suggestions {
        display: none;
        margin-top: 8px;
        border-top: 1px solid var(--sp-border);
        padding-top: 2px;
        max-height: 380px;
        overflow-y: auto;
      }
      .section-header {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--sp-muted);
        padding: 10px 10px 4px;
        user-select: none;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 7px 10px;
        border-radius: 8px;
        cursor: pointer;
        color: var(--sp-text-secondary);
      }
      .row.selected {
        background: var(--sp-accent);
      }
      .icon {
        flex: 0 0 auto;
        width: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--sp-muted);
      }
      .favicon {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        object-fit: contain;
      }
      .row.selected .icon {
        color: var(--sp-on-accent);
      }
      .text {
        flex: 1 1 auto;
        min-width: 0;
      }
      .title {
        font-size: 13px;
        font-weight: 500;
        color: var(--sp-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .url {
        font-size: 11px;
        color: var(--sp-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
      }
      .row.selected .title {
        color: var(--sp-on-accent);
      }
      .row.selected .url {
        color: rgba(255, 255, 255, 0.75);
      }
      .badge {
        flex: 0 0 auto;
        margin-left: 8px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.03em;
        padding: 2px 7px;
        border-radius: 999px;
        background: var(--sp-badge-bg);
        color: var(--sp-muted);
      }
      .badge-tab {
        background: var(--sp-badge-tab-bg);
        color: var(--sp-badge-tab-text);
      }
      .row.selected .badge {
        background: rgba(255, 255, 255, 0.9);
        color: var(--sp-accent);
      }
      .num-badge {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 600;
        border-radius: 5px;
        background: var(--sp-badge-bg);
        color: var(--sp-muted);
      }
      .row.selected .num-badge {
        background: rgba(255, 255, 255, 0.9);
        color: var(--sp-accent);
      }
      .hint {
        margin-top: 8px;
        padding: 6px 10px 2px;
        border-top: 1px solid var(--sp-border);
        font-size: 11px;
        color: var(--sp-muted);
        user-select: none;
      }
    `;

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";

    const panel = document.createElement("div");
    panel.className = "panel";

    const searchField = document.createElement("div");
    searchField.className = "search-field";

    const searchIcon = document.createElement("span");
    searchIcon.className = "search-icon";
    searchIcon.innerHTML =
      '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>';

    const input = document.createElement("input");
    input.type = "text";
    input.className = "spotlight-input";
    input.placeholder = "Search tabs and bookmarks...";
    input.autocomplete = "off";
    input.spellcheck = false;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "close-btn";
    closeBtn.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    closeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });

    searchField.appendChild(searchIcon);
    searchField.appendChild(input);
    searchField.appendChild(closeBtn);

    suggestionsEl = document.createElement("div");
    suggestionsEl.className = "suggestions";

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      "↵ open/switch  ·  ⇧↵ this page  ·  ↑↓ pick  ·  ⌥1-9 jump  ·  esc close";

    panel.appendChild(searchField);
    panel.appendChild(suggestionsEl);
    panel.appendChild(hint);
    shadow.appendChild(style);
    shadow.appendChild(backdrop);
    shadow.appendChild(panel);
    document.documentElement.appendChild(hostEl);

    requestAnimationFrame(() => panel.classList.add("visible"));
    inputEl = input;
    setTimeout(() => input.focus(), 0);

    chrome.runtime.sendMessage(
      { type: "GET_TABS", excludeSelf: true },
      (response) => {
        void chrome.runtime.lastError;
        if (!hostEl) return;
        allTabs = (response && response.tabs) || [];
        tabUrls = new Set(allTabs.map((t) => t.url));
        const q = inputEl ? inputEl.value : "";
        tabMatches = getTabMatches(q);
        bhMatches = bhMatches.filter((s) => !tabUrls.has(s.url));
        if (!q.trim()) selectedIdx = tabMatches.length ? 0 : -1;
        rebuildSuggestions();
      }
    );

    backdrop.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });

    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    input.addEventListener("input", () => onInputChange(input.value));

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        const s = suggestions[Number(e.code.slice(5)) - 1];
        if (s) onSelect(s, !e.shiftKey);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const newTab = !e.shiftKey;
        if (selectedIdx >= 0 && suggestions[selectedIdx]) {
          onSelect(suggestions[selectedIdx], newTab);
        } else {
          const url = resolveQuery(input.value);
          if (url) navigate(url, newTab);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowDown") {
        if (suggestions.length === 0) return;
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % suggestions.length;
        updateSelectionHighlight();
      } else if (e.key === "ArrowUp") {
        if (suggestions.length === 0) return;
        e.preventDefault();
        selectedIdx =
          selectedIdx <= 0 ? suggestions.length - 1 : selectedIdx - 1;
        updateSelectionHighlight();
      }
    });

    input.addEventListener("keyup", (e) => e.stopPropagation());
    input.addEventListener("keypress", (e) => e.stopPropagation());
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    // Both commands open the same unified overlay; either one toggles it.
    if (msg.type !== "TOGGLE_SPOTLIGHT" && msg.type !== "TOGGLE_TAB_SWITCHER")
      return;

    if (hostEl) close();
    else open();
    // ACK so background knows the overlay handled it and skips popup fallback.
    sendResponse({ ok: true });
  });

  // --- Task View tab switcher (hold modifier, tap key to cycle, release to switch) ---

  let taskViewActive = false;
  let taskViewPending = false; // GET_TABS request in flight
  let taskViewCommitOnArrival = false; // modifier released before tabs arrived
  let taskViewTabs = [];
  let taskViewIndex = -1;
  let taskViewHostEl = null;
  let taskViewCardsEl = null;

  function matchesTaskViewShortcut(e) {
    const cfg = taskViewShortcut;
    if (!cfg || !cfg.key) return false;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key !== cfg.key) return false;
    if (e.altKey !== !!cfg.alt) return false;
    if (e.ctrlKey !== !!cfg.ctrl) return false;
    if (e.shiftKey !== !!cfg.shift) return false;
    if (e.metaKey !== !!cfg.meta) return false;
    return true;
  }

  function isTaskViewModifierKey(key) {
    const cfg = taskViewShortcut;
    return (
      (cfg.alt && key === "Alt") ||
      (cfg.ctrl && key === "Control") ||
      (cfg.shift && key === "Shift") ||
      (cfg.meta && key === "Meta")
    );
  }

  function startTaskView() {
    if (taskViewPending) return;
    taskViewPending = true;
    taskViewCommitOnArrival = false;
    chrome.runtime.sendMessage({ type: "GET_TABS" }, (response) => {
      void chrome.runtime.lastError;
      if (!taskViewPending) return; // cancelled (Escape/blur) before tabs arrived
      taskViewPending = false;
      const tabs = (response && response.tabs) || [];
      if (tabs.length < 2) return;
      taskViewTabs = tabs;
      taskViewIndex = 1;
      taskViewActive = true;
      // Quick tap: modifier already released — switch immediately, no overlay.
      if (taskViewCommitOnArrival) commitTaskView();
      else renderTaskView();
      taskViewCommitOnArrival = false;
    });
  }

  function advanceTaskView(delta) {
    if (!taskViewTabs.length) return;
    taskViewIndex =
      (taskViewIndex + delta + taskViewTabs.length) % taskViewTabs.length;
    renderTaskView();
  }

  function closeTaskView() {
    taskViewActive = false;
    taskViewTabs = [];
    taskViewIndex = -1;
    if (taskViewHostEl) {
      taskViewHostEl.remove();
      taskViewHostEl = null;
      taskViewCardsEl = null;
    }
  }

  function commitTaskView() {
    if (!taskViewActive) return;
    const chosen = taskViewTabs[taskViewIndex];
    closeTaskView();
    if (chosen && !chosen.active) {
      chrome.runtime.sendMessage(
        { type: "ACTIVATE_TAB", tabId: chosen.tabId, windowId: chosen.windowId },
        () => void chrome.runtime.lastError
      );
    }
  }

  function renderTaskView() {
    if (!taskViewHostEl) {
      taskViewHostEl = document.createElement("div");
      taskViewHostEl.style.all = "initial";
      taskViewHostEl.style.position = "fixed";
      taskViewHostEl.style.inset = "0";
      taskViewHostEl.style.zIndex = "2147483647";
      taskViewHostEl.style.pointerEvents = "none";

      const shadow = taskViewHostEl.attachShadow({ mode: "closed" });

      const style = document.createElement("style");
      style.textContent = `
        :host {
          --sp-bg: #1e1e1e;
          --sp-text: #ffffff;
          --sp-muted: #888888;
          --sp-card-bg: rgba(255, 255, 255, 0.06);
          --sp-card-selected-bg: rgba(255, 255, 255, 0.16);
          --sp-panel-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
        }
        @media (prefers-color-scheme: light) {
          :host {
            --sp-bg: #ffffff;
            --sp-text: #1a1a1a;
            --sp-muted: #6b7280;
            --sp-card-bg: rgba(0, 0, 0, 0.04);
            --sp-card-selected-bg: rgba(0, 0, 0, 0.1);
            --sp-panel-shadow: 0 20px 60px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.08);
          }
        }
        :host, * { box-sizing: border-box; }
        .panel {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          display: flex;
          gap: 10px;
          max-width: calc(100vw - 80px);
          overflow-x: auto;
          padding: 20px;
          background: var(--sp-bg);
          border-radius: 16px;
          box-shadow: var(--sp-panel-shadow);
          pointer-events: auto;
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .card {
          flex: 0 0 auto;
          width: 120px;
          padding: 14px 10px;
          border-radius: 10px;
          background: var(--sp-card-bg);
          border: 2px solid transparent;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
        }
        .card.selected {
          background: var(--sp-card-selected-bg);
          border-color: var(--sp-text);
        }
        .favicon {
          width: 32px;
          height: 32px;
          border-radius: 6px;
          object-fit: contain;
        }
        .icon {
          width: 32px;
          height: 32px;
          line-height: 32px;
          text-align: center;
          font-size: 20px;
          color: var(--sp-muted);
        }
        .title {
          width: 100%;
          font-size: 12px;
          color: var(--sp-text);
          text-align: center;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
      `;

      taskViewCardsEl = document.createElement("div");
      taskViewCardsEl.className = "panel";

      shadow.appendChild(style);
      shadow.appendChild(taskViewCardsEl);
      document.documentElement.appendChild(taskViewHostEl);
    }

    taskViewCardsEl.innerHTML = "";
    taskViewTabs.forEach((t, i) => {
      const card = document.createElement("div");
      card.className = "card" + (i === taskViewIndex ? " selected" : "");

      let icon;
      if (t.favIconUrl) {
        icon = document.createElement("img");
        icon.className = "favicon";
        icon.src = t.favIconUrl;
        icon.addEventListener("error", () => {
          const fallback = document.createElement("span");
          fallback.className = "icon";
          fallback.textContent = "▢";
          icon.replaceWith(fallback);
        });
      } else {
        icon = document.createElement("span");
        icon.className = "icon";
        icon.textContent = "▢";
      }

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = t.title || t.url;

      card.appendChild(icon);
      card.appendChild(title);
      taskViewCardsEl.appendChild(card);
    });

    const selected = taskViewCardsEl.children[taskViewIndex];
    if (selected && selected.scrollIntoView) {
      selected.scrollIntoView({ block: "nearest", inline: "center" });
    }
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (hostEl) return; // spotlight/tab-search overlay already open, don't conflict
      if (taskViewActive || taskViewPending) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          taskViewPending = false;
          taskViewCommitOnArrival = false;
          closeTaskView();
          return;
        }
        if (taskViewActive && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          e.preventDefault();
          e.stopPropagation();
          advanceTaskView(e.key === "ArrowLeft" ? -1 : 1);
          return;
        }
      }
      if (!matchesTaskViewShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!taskViewActive) startTaskView();
      else advanceTaskView(1);
    },
    true
  );

  document.addEventListener(
    "keyup",
    (e) => {
      if (!isTaskViewModifierKey(e.key)) return;
      if (taskViewActive) commitTaskView();
      else if (taskViewPending) taskViewCommitOnArrival = true;
    },
    true
  );

  window.addEventListener("blur", () => {
    taskViewPending = false;
    taskViewCommitOnArrival = false;
    if (taskViewActive) commitTaskView();
  });

})();
