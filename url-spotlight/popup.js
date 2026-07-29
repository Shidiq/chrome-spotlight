(() => {
  const SEARCH_ENGINES = {
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    brave: { name: "Brave", url: "https://search.brave.com/search?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  };
  const DEFAULT_ENGINE = "duckduckgo";

  const params = new URLSearchParams(location.search);
  const originTabId = parseInt(params.get("originTabId")) || null;
  // cmd param kept in the URL for compat; both commands open the unified UI.

  let suggestionsEl = null;
  let suggestions = [];
  let selectedIdx = -1;
  let debounceTimer = null;
  let lastQueryId = 0;
  let searchEngine = DEFAULT_ENGINE;
  let allTabs = [];
  let tabUrls = new Set();
  let tabMatches = [];
  let bhMatches = [];

  chrome.storage.sync.get({ searchEngine: DEFAULT_ENGINE }, (r) => {
    searchEngine = r.searchEngine;
  });

  function resolveQuery(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (!/\s/.test(trimmed) && /\./.test(trimmed)) return "https://" + trimmed;
    const engine = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES[DEFAULT_ENGINE];
    return engine.url + encodeURIComponent(trimmed);
  }

  function navigate(url, newTab) {
    chrome.runtime.sendMessage(
      { type: "POPUP_NAVIGATE", url, newTab: !!newTab, originTabId },
      () => { void chrome.runtime.lastError; }
    );
    // background closes the window after updating the tab
  }

  function activateTab(tabId, windowId) {
    chrome.runtime.sendMessage(
      { type: "POPUP_ACTIVATE_TAB", tabId, windowId },
      () => { void chrome.runtime.lastError; }
    );
    // background closes the window after activating the tab
  }

  function onSelect(s, newTab) {
    if (!s) return;
    if (s.type === "tab") activateTab(s.tabId, s.windowId);
    else navigate(s.url, newTab);
  }

  function fuzzyScore(query, text) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = (text || "").toLowerCase();
    let qi = 0, score = 0, prevIdx = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += prevIdx === ti - 1 ? 3 : 1;
        if (ti === 0) score += 2;
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
    suggestionsEl.querySelectorAll(".row").forEach((r, i) => {
      r.classList.toggle("selected", i === selectedIdx);
      if (i === selectedIdx) r.scrollIntoView({ block: "nearest" });
    });
  }

  function requestSuggestions(query) {
    const myId = ++lastQueryId;
    chrome.runtime.sendMessage({ type: "SEARCH_SUGGESTIONS", query }, (response) => {
      void chrome.runtime.lastError;
      if (myId !== lastQueryId) return;
      const items = (response && response.suggestions) || [];
      // An already-open tab beats reloading the same URL from history.
      bhMatches = items.filter((s) => !tabUrls.has(s.url));
      rebuildSuggestions();
    });
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

  function mount() {
    const style = document.createElement("style");
    style.textContent = `
      :root {
        --sp-bg: rgba(40, 40, 44, 1);
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
      }
      @media (prefers-color-scheme: light) {
        :root {
          --sp-bg: rgb(238, 238, 240);
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
        }
      }
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--sp-bg);
        color: var(--sp-text);
        overflow: hidden;
        margin: 0;
      }
      .panel {
        padding: 10px;
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
      input.spotlight-input::placeholder { color: var(--sp-placeholder); }
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
        max-height: calc(100vh - 88px);
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
      .row.selected { background: var(--sp-accent); }
      .icon {
        flex: 0 0 auto;
        width: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--sp-muted);
      }
      .row.selected .icon { color: var(--sp-on-accent); }
      .favicon {
        flex: 0 0 auto;
        width: 18px;
        height: 18px;
        border-radius: 4px;
        object-fit: contain;
      }
      .text { flex: 1 1 auto; min-width: 0; }
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
      .row.selected .title { color: var(--sp-on-accent); }
      .row.selected .url { color: rgba(255, 255, 255, 0.75); }
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
    document.head.appendChild(style);

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
      window.close();
    });

    searchField.appendChild(searchIcon);
    searchField.appendChild(input);
    searchField.appendChild(closeBtn);

    suggestionsEl = document.createElement("div");
    suggestionsEl.className = "suggestions";

    panel.appendChild(searchField);
    panel.appendChild(suggestionsEl);
    document.body.appendChild(panel);

    // Center on the screen (golden-ratio 600x373 content). The service
    // worker can't see screen dimensions, so the popup repositions itself.
    const CONTENT_W = 600;
    const CONTENT_H = 373;
    const TITLEBAR = 28;
    const left = Math.round(screen.availLeft + (screen.availWidth - CONTENT_W) / 2);
    const top =
      Math.round(screen.availTop + (screen.availHeight - CONTENT_H) / 2) - TITLEBAR;
    chrome.windows.update(
      chrome.windows.WINDOW_ID_CURRENT,
      { left, top, width: CONTENT_W, height: CONTENT_H + TITLEBAR, focused: true },
      () => { void chrome.runtime.lastError; }
    );

    input.focus();

    chrome.runtime.sendMessage({ type: "GET_TABS" }, (response) => {
      void chrome.runtime.lastError;
      allTabs = ((response && response.tabs) || []).filter(
        (t) => t.tabId !== originTabId
      );
      tabUrls = new Set(allTabs.map((t) => t.url));
      const q = input.value;
      tabMatches = getTabMatches(q);
      bhMatches = bhMatches.filter((s) => !tabUrls.has(s.url));
      if (!q.trim()) selectedIdx = tabMatches.length ? 0 : -1;
      rebuildSuggestions();
    });

    input.addEventListener("input", () => onInputChange(input.value));

    input.addEventListener("keydown", (e) => {
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
        window.close();
      } else if (e.key === "ArrowDown") {
        if (!suggestions.length) return;
        e.preventDefault();
        selectedIdx = (selectedIdx + 1) % suggestions.length;
        updateSelectionHighlight();
      } else if (e.key === "ArrowUp") {
        if (!suggestions.length) return;
        e.preventDefault();
        selectedIdx = selectedIdx <= 0 ? suggestions.length - 1 : selectedIdx - 1;
        updateSelectionHighlight();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", mount);
})();
