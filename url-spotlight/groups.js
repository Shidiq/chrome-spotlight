(() => {
  const GROUP_COLORS = {
    grey: { dark: "#9aa0a6", light: "#5f6368" },
    blue: { dark: "#8ab4f8", light: "#1a73e8" },
    red: { dark: "#f28b82", light: "#d93025" },
    yellow: { dark: "#fdd663", light: "#f9ab00" },
    green: { dark: "#81c995", light: "#188038" },
    pink: { dark: "#ff8bcb", light: "#d01884" },
    purple: { dark: "#c58af9", light: "#a142f4" },
    cyan: { dark: "#78d9ec", light: "#007b83" },
    orange: { dark: "#fcad70", light: "#fa903e" }
  };
  const isLight = window.matchMedia("(prefers-color-scheme: light)").matches;

  const listEl = document.getElementById("list");
  let items = []; // open groups ({kind:"open",...}) then closed ones ({kind:"closed",...})
  let selectedIdx = 0;

  function dotColor(name) {
    const pair = GROUP_COLORS[name] || GROUP_COLORS.grey;
    return isLight ? pair.light : pair.dark;
  }

  function load() {
    if (!chrome.tabGroups) {
      listEl.textContent = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Tab groups are not supported in this browser.";
      listEl.appendChild(empty);
      return;
    }
    chrome.tabGroups.query({}, (gs) => {
      if (chrome.runtime.lastError) {
        void chrome.runtime.lastError;
        gs = [];
      }
      chrome.tabs.query({}, (ts) => {
        if (chrome.runtime.lastError) {
          void chrome.runtime.lastError;
          ts = [];
        }
        chrome.storage.local.get("closedGroups", (store) => {
          void chrome.runtime.lastError;
          const closed = (store && store.closedGroups) || [];

          // tabs.query returns tabs in tab-strip order, so the first tab seen
          // per group is the group's leftmost tab.
          const info = new Map();
          for (const t of ts) {
            if (t.groupId == null || t.groupId === -1) continue;
            const entry = info.get(t.groupId);
            if (entry) entry.tabCount += 1;
            else info.set(t.groupId, { tabCount: 1, firstTabId: t.id });
          }
          const open = gs.map((g) => {
            const extra = info.get(g.id) || { tabCount: 0, firstTabId: null };
            return {
              kind: "open",
              id: g.id,
              title: g.title || "",
              color: g.color,
              windowId: g.windowId,
              tabCount: extra.tabCount,
              firstTabId: extra.firstTabId
            };
          });
          open.sort((a, b) => a.windowId - b.windowId);

          items = open.concat(
            closed.map((e) => ({
              kind: "closed",
              title: e.title || "",
              color: e.color,
              urls: e.urls || [],
              tabCount: (e.urls || []).length,
              closedAt: e.closedAt
            }))
          );
          if (selectedIdx >= items.length) selectedIdx = Math.max(0, items.length - 1);
          render();
        });
      });
    });
  }

  function render() {
    listEl.textContent = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      const msg = document.createElement("div");
      msg.textContent = "No tab groups";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Right-click a tab → Add tab to new group";
      empty.appendChild(msg);
      empty.appendChild(hint);
      listEl.appendChild(empty);
      return;
    }

    const openItems = items.filter((it) => it.kind === "open");
    const hasClosed = items.some((it) => it.kind === "closed");

    const windowOrder = [];
    for (const g of openItems) {
      if (!windowOrder.includes(g.windowId)) windowOrder.push(g.windowId);
    }
    const multiWindow = windowOrder.length > 1;

    let closedLabelDone = false;
    items.forEach((it, i) => {
      if (hasClosed && i === 0 && it.kind === "open") {
        const label = document.createElement("div");
        label.className = "section-label";
        label.textContent = "Open groups";
        listEl.appendChild(label);
      }
      if (it.kind === "closed" && !closedLabelDone) {
        closedLabelDone = true;
        const label = document.createElement("div");
        label.className = "section-label";
        label.textContent = "Recently closed";
        listEl.appendChild(label);
      }

      const row = document.createElement("div");
      row.className =
        "row" + (it.kind === "closed" ? " closed" : "") + (i === selectedIdx ? " selected" : "");

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = dotColor(it.color);

      const title = document.createElement("span");
      title.className = "title" + (it.title ? "" : " untitled");
      title.textContent = it.title || "Untitled group";

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = it.tabCount === 1 ? "1 tab" : `${it.tabCount} tabs`;

      row.appendChild(dot);
      row.appendChild(title);
      row.appendChild(count);

      if (it.kind === "open" && multiWindow) {
        const win = document.createElement("span");
        win.className = "win";
        win.textContent = `Window ${windowOrder.indexOf(it.windowId) + 1}`;
        row.appendChild(win);
      }

      row.addEventListener("click", () => activate(it));
      row.addEventListener("mousemove", () => {
        if (selectedIdx !== i) {
          selectedIdx = i;
          updateSelection();
        }
      });
      listEl.appendChild(row);
    });
  }

  function updateSelection() {
    const rows = listEl.querySelectorAll(".row");
    rows.forEach((row, i) => row.classList.toggle("selected", i === selectedIdx));
    const sel = rows[selectedIdx];
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function activate(it) {
    if (it.kind === "open") focusGroup(it);
    else restoreGroup(it);
  }

  function focusGroup(g) {
    // Uncollapse first so activating the tab doesn't race the collapse state.
    chrome.tabGroups.update(g.id, { collapsed: false }, () => {
      if (chrome.runtime.lastError) {
        void chrome.runtime.lastError;
        load(); // group vanished since render — refresh the list
        return;
      }
      const focusWindow = () => {
        chrome.windows.update(g.windowId, { focused: true }, () => {
          void chrome.runtime.lastError;
          window.close();
        });
      };
      if (g.firstTabId != null) {
        chrome.tabs.update(g.firstTabId, { active: true }, () => {
          void chrome.runtime.lastError;
          focusWindow();
        });
      } else {
        focusWindow();
      }
    });
  }

  function restoreGroup(entry) {
    if (!entry.urls.length) return;
    // Restore runs in the background worker: this popup document dies the
    // moment focus shifts, which would abort mid-restore.
    chrome.runtime.sendMessage(
      {
        type: "RESTORE_GROUP",
        entry: {
          title: entry.title,
          color: entry.color,
          urls: entry.urls,
          closedAt: entry.closedAt
        }
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
    window.close();
  }

  document.addEventListener("keydown", (e) => {
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[selectedIdx];
      if (it) activate(it);
    } else if (/^Digit[1-9]$/.test(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const it = items[Number(e.code.slice(5)) - 1];
      if (it) {
        e.preventDefault();
        activate(it);
      }
    }
  });

  load();
})();
