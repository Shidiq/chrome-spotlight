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
  let mode = "url";
  let allTabs = [];
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
        icon.textContent =
          s.type === "tab" ? "▢" : s.type === "bookmark" ? "★" : "↻";
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
        e.stopPropagation();
        onSelect(s, !e.shiftKey);
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
    const rows = suggestionsEl.querySelectorAll(".row");
    rows.forEach((r, i) => {
      r.classList.toggle("selected", i === selectedIdx);
    });
  }

  function requestSuggestions(query) {
    const myId = ++lastQueryId;
    console.log("[spotlight content] sending query:", query);
    chrome.runtime.sendMessage(
      { type: "SEARCH_SUGGESTIONS", query },
      (response) => {
        const err = chrome.runtime.lastError;
        console.log("[spotlight content] response:", response, "err:", err);
        if (myId !== lastQueryId) return;
        suggestions = (response && response.suggestions) || [];
        selectedIdx = -1;
        renderSuggestions();
      }
    );
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

  function open(openMode) {
    if (hostEl) return;
    mode = openMode === "tabs" ? "tabs" : "url";
    allTabs = [];

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
        --sp-bg: #1e1e1e;
        --sp-text: #ffffff;
        --sp-text-secondary: #e0e0e0;
        --sp-muted: #888888;
        --sp-placeholder: #666666;
        --sp-selected-bg: rgba(255, 255, 255, 0.08);
        --sp-border: rgba(255, 255, 255, 0.08);
        --sp-panel-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
      }
      @media (prefers-color-scheme: light) {
        :host {
          --sp-bg: #ffffff;
          --sp-text: #1a1a1a;
          --sp-text-secondary: #2c2c2c;
          --sp-muted: #6b7280;
          --sp-placeholder: #9aa0aa;
          --sp-selected-bg: rgba(0, 0, 0, 0.06);
          --sp-border: rgba(0, 0, 0, 0.1);
          --sp-panel-shadow: 0 20px 60px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.08);
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
        top: 28vh;
        left: 50%;
        transform: translateX(-50%) translateY(-4px);
        width: 560px;
        max-width: calc(100vw - 32px);
        padding: 16px 20px;
        background: var(--sp-bg);
        border-radius: 14px;
        box-shadow: var(--sp-panel-shadow);
        opacity: 0;
        transition: opacity 100ms ease-out, transform 100ms ease-out;
        pointer-events: auto;
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .panel.visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      input.spotlight-input {
        width: 100%;
        border: none;
        outline: none;
        background: transparent;
        color: var(--sp-text);
        font: 20px ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
        padding: 0;
        margin: 0;
        caret-color: var(--sp-text);
      }
      input.spotlight-input::placeholder {
        color: var(--sp-placeholder);
      }
      .suggestions {
        display: none;
        margin-top: 12px;
        border-top: 1px solid var(--sp-border);
        padding-top: 8px;
        max-height: 320px;
        overflow-y: auto;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 8px;
        border-radius: 8px;
        cursor: pointer;
        color: var(--sp-text-secondary);
      }
      .row.selected {
        background: var(--sp-selected-bg);
      }
      .icon {
        flex: 0 0 auto;
        width: 18px;
        text-align: center;
        font-size: 13px;
        color: var(--sp-muted);
      }
      .favicon {
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        object-fit: contain;
      }
      .row.selected .icon {
        color: var(--sp-text);
      }
      .text {
        flex: 1 1 auto;
        min-width: 0;
      }
      .title {
        font-size: 13px;
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
      .hint {
        margin-top: 10px;
        font-size: 12px;
        color: var(--sp-muted);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        user-select: none;
      }
    `;

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";

    const panel = document.createElement("div");
    panel.className = "panel";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "spotlight-input";
    input.placeholder =
      mode === "tabs" ? "Switch to tab..." : "Search or enter URL...";
    input.autocomplete = "off";
    input.spellcheck = false;

    suggestionsEl = document.createElement("div");
    suggestionsEl.className = "suggestions";

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent =
      mode === "tabs"
        ? "↵ switch  ·  ↑↓ pick  ·  esc close"
        : "↵ new tab  ·  ⇧↵ this page  ·  ↑↓ pick  ·  esc close";

    panel.appendChild(input);
    panel.appendChild(suggestionsEl);
    panel.appendChild(hint);
    shadow.appendChild(style);
    shadow.appendChild(backdrop);
    shadow.appendChild(panel);
    document.documentElement.appendChild(hostEl);

    requestAnimationFrame(() => panel.classList.add("visible"));
    inputEl = input;
    setTimeout(() => input.focus(), 0);

    if (mode === "tabs") {
      chrome.runtime.sendMessage({ type: "GET_TABS" }, (response) => {
        void chrome.runtime.lastError;
        if (!hostEl || mode !== "tabs") return;
        allTabs = (response && response.tabs) || [];
        filterTabs("");
      });
    }

    backdrop.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });

    panel.addEventListener("mousedown", (e) => e.stopPropagation());

    input.addEventListener("input", () => onInputChange(input.value));

    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        const newTab = !e.shiftKey;
        if (selectedIdx >= 0 && suggestions[selectedIdx]) {
          onSelect(suggestions[selectedIdx], newTab);
        } else if (mode !== "tabs") {
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
    let requestedMode;
    if (msg.type === "TOGGLE_SPOTLIGHT") requestedMode = "url";
    else if (msg.type === "TOGGLE_TAB_SWITCHER") requestedMode = "tabs";
    else return;

    if (hostEl && mode === requestedMode) {
      close();
    } else {
      if (hostEl) close();
      open(requestedMode);
    }
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

  // Reserved browser shortcuts (Cmd/Ctrl+T) never reach extension commands on
  // chrome-extension:// pages — the native "new tab" wins there. Every new tab
  // lands on this page, so auto-open spotlight to keep the shortcut useful:
  // Cmd+T on any restricted page → new tab → spotlight, ready to type.
  if (
    typeof chrome !== "undefined" &&
    chrome.runtime &&
    chrome.runtime.getURL &&
    location.href === chrome.runtime.getURL("newtab.html")
  ) {
    open("url");

    // Chrome (27+) refuses to let an NTP page steal focus from the omnibox,
    // so input.focus() during load is ignored at the browser level. Retry
    // briefly in case the browser does hand focus over, and re-grab the
    // input whenever browser focus enters the page (first Tab press/click).
    const focusOverlayInput = () => {
      if (inputEl) inputEl.focus();
    };
    const started = Date.now();
    (function retryFocus() {
      if (!inputEl) return;
      focusOverlayInput();
      if (!document.hasFocus() && Date.now() - started < 1000) {
        requestAnimationFrame(retryFocus);
      }
    })();
    window.addEventListener("focus", () => setTimeout(focusOverlayInput, 0));
  }
})();
