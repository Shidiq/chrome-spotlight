(() => {
  let hostEl = null;
  let suggestionsEl = null;
  let suggestions = [];
  let selectedIdx = -1;
  let debounceTimer = null;
  let lastQueryId = 0;

  function resolveQuery(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (!/\s/.test(trimmed) && /\./.test(trimmed)) return "https://" + trimmed;
    return "https://www.google.com/search?q=" + encodeURIComponent(trimmed);
  }

  function close() {
    if (!hostEl) return;
    hostEl.remove();
    hostEl = null;
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
    const type = newTab ? "OPEN_NEW_TAB" : "OPEN_CURRENT_TAB";
    chrome.runtime.sendMessage({ type, url }, () => {
      void chrome.runtime.lastError;
    });
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

      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = s.type === "bookmark" ? "★" : "↻";

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
        navigate(s.url, e.shiftKey);
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

  function open() {
    if (hostEl) return;

    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.inset = "0";
    hostEl.style.zIndex = "2147483647";
    hostEl.style.pointerEvents = "none";

    const shadow = hostEl.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
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
        background: #1e1e1e;
        border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
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
        color: #ffffff;
        font: 20px ui-monospace, SFMono-Regular, Menlo, Monaco, "Courier New", monospace;
        padding: 0;
        margin: 0;
        caret-color: #ffffff;
      }
      input.spotlight-input::placeholder {
        color: #666666;
      }
      .suggestions {
        display: none;
        margin-top: 12px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
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
        color: #e0e0e0;
      }
      .row.selected {
        background: rgba(255, 255, 255, 0.08);
      }
      .icon {
        flex: 0 0 auto;
        width: 18px;
        text-align: center;
        font-size: 13px;
        color: #888888;
      }
      .row.selected .icon {
        color: #ffffff;
      }
      .text {
        flex: 1 1 auto;
        min-width: 0;
      }
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
    input.placeholder = "Search or enter URL...";
    input.autocomplete = "off";
    input.spellcheck = false;

    suggestionsEl = document.createElement("div");
    suggestionsEl.className = "suggestions";

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "↵ open  ·  ⇧↵ new tab  ·  ↑↓ pick  ·  esc close";

    panel.appendChild(input);
    panel.appendChild(suggestionsEl);
    panel.appendChild(hint);
    shadow.appendChild(style);
    shadow.appendChild(backdrop);
    shadow.appendChild(panel);
    document.documentElement.appendChild(hostEl);

    requestAnimationFrame(() => panel.classList.add("visible"));
    setTimeout(() => input.focus(), 0);

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
        const newTab = e.shiftKey;
        if (selectedIdx >= 0 && suggestions[selectedIdx]) {
          navigate(suggestions[selectedIdx].url, newTab);
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

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "TOGGLE_SPOTLIGHT") return;
    if (hostEl) close();
    else open();
  });
})();
