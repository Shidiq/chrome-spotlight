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
  const cmd = params.get("cmd") || "toggle-spotlight";
  const mode = cmd === "switch-tabs" ? "tabs" : "url";

  let suggestionsEl = null;
  let suggestions = [];
  let selectedIdx = -1;
  let debounceTimer = null;
  let lastQueryId = 0;
  let searchEngine = DEFAULT_ENGINE;
  let allTabs = [];

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

  function filterTabs(query) {
    const q = query.trim();
    if (!q) {
      suggestions = allTabs.map(toTabSuggestion);
    } else {
      suggestions = allTabs
        .map((t) => ({
          t,
          score: Math.max(fuzzyScore(q, t.title), fuzzyScore(q, t.url)),
        }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => toTabSuggestion(x.t));
    }
    selectedIdx = suggestions.length ? 0 : -1;
    renderSuggestions();
  }

  function renderSuggestions() {
    if (!suggestionsEl) return;
    suggestionsEl.innerHTML = "";
    if (suggestions.length === 0) {
      suggestionsEl.style.display = "none";
      return;
    }
    suggestionsEl.style.display = "block";
    suggestions.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "row" + (i === selectedIdx ? " selected" : "");

      let icon;
      if (s.type === "tab" && s.favIconUrl) {
        icon = document.createElement("img");
        icon.className = "favicon";
        icon.src = s.favIconUrl;
        icon.addEventListener("error", () => {
          const fallback = document.createElement("span");
          fallback.className = "icon";
          fallback.textContent = "▢";
          icon.replaceWith(fallback);
        });
      } else {
        icon = document.createElement("span");
        icon.className = "icon";
        icon.textContent = s.type === "tab" ? "▢" : s.type === "bookmark" ? "★" : "↻";
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
      row.appendChild(icon);
      row.appendChild(text);

      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        onSelect(s, e.shiftKey);
      });
      row.addEventListener("mouseenter", () => {
        selectedIdx = i;
        updateSelectionHighlight();
      });
      suggestionsEl.appendChild(row);
    });
  }

  function updateSelectionHighlight() {
    if (!suggestionsEl) return;
    suggestionsEl.querySelectorAll(".row").forEach((r, i) => {
      r.classList.toggle("selected", i === selectedIdx);
    });
  }

  function requestSuggestions(query) {
    const myId = ++lastQueryId;
    chrome.runtime.sendMessage({ type: "SEARCH_SUGGESTIONS", query }, (response) => {
      void chrome.runtime.lastError;
      if (myId !== lastQueryId) return;
      suggestions = (response && response.suggestions) || [];
      selectedIdx = -1;
      renderSuggestions();
    });
  }

  function onInputChange(value) {
    if (mode === "tabs") {
      filterTabs(value);
      return;
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    const trimmed = value.trim();
    if (!trimmed) {
      lastQueryId++;
      suggestions = [];
      selectedIdx = -1;
      renderSuggestions();
      return;
    }
    debounceTimer = setTimeout(() => requestSuggestions(trimmed), 80);
  }

  function mount() {
    const style = document.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; }
      body {
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #1e1e1e;
        color: #ffffff;
        overflow: hidden;
      }
      .panel {
        padding: 16px 20px;
      }
      input.spotlight-input {
        width: 100%;
        border: none;
        outline: none;
        background: transparent;
        color: #ffffff;
        font: 20px ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
        padding: 0;
        margin: 0;
        caret-color: #ffffff;
      }
      input.spotlight-input::placeholder { color: #666666; }
      .suggestions {
        display: none;
        margin-top: 12px;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 8px;
        max-height: 320px;
        overflow-y: auto;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px;
        border-radius: 8px;
        cursor: pointer;
        color: #e0e0e0;
      }
      .row.selected { background: rgba(255,255,255,0.08); }
      .icon {
        flex: 0 0 auto;
        width: 18px;
        text-align: center;
        font-size: 13px;
        color: #888888;
      }
      .row.selected .icon { color: #ffffff; }
      .favicon {
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        object-fit: contain;
      }
      .text { flex: 1 1 auto; min-width: 0; }
      .title {
        font-size: 13px;
        color: #ffffff;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .url {
        font-size: 11px;
        color: #888888;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
      }
      .hint {
        margin-top: 10px;
        font-size: 12px;
        color: #888888;
        user-select: none;
      }
    `;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "panel";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "spotlight-input";
    input.placeholder = mode === "tabs" ? "Switch to tab..." : "Search or enter URL...";
    input.autocomplete = "off";
    input.spellcheck = false;

    suggestionsEl = document.createElement("div");
    suggestionsEl.className = "suggestions";

    panel.appendChild(input);
    panel.appendChild(suggestionsEl);
    document.body.appendChild(panel);

    input.focus();

    if (mode === "tabs") {
      chrome.runtime.sendMessage({ type: "GET_TABS" }, (response) => {
        void chrome.runtime.lastError;
        allTabs = (response && response.tabs) || [];
        filterTabs("");
      });
    }

    input.addEventListener("input", () => onInputChange(input.value));

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const newTab = e.shiftKey;
        if (selectedIdx >= 0 && suggestions[selectedIdx]) {
          onSelect(suggestions[selectedIdx], newTab);
        } else if (mode !== "tabs") {
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
