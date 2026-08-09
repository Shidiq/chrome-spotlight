// Tab group data layer, shared by the toolbar popup (groups.js) and the new
// tab widget (widgets.js). Rendering and keyboard handling stay with each
// caller; everything here is queries, colors, and activation.
(() => {
  "use strict";

  const GROUP_COLORS = {
    grey: { dark: "#9aa0a6", light: "#5f6368" },
    blue: { dark: "#8ab4f8", light: "#1a73e8" },
    red: { dark: "#f28b82", light: "#d93025" },
    yellow: { dark: "#fdd663", light: "#f9ab00" },
    green: { dark: "#81c995", light: "#188038" },
    pink: { dark: "#ff8bcb", light: "#d01884" },
    purple: { dark: "#c58af9", light: "#a142f4" },
    cyan: { dark: "#78d9ec", light: "#007b83" },
    orange: { dark: "#fcad70", light: "#fa903e" },
  };

  // Read the scheme per call, not once at load: the new tab is long-lived and
  // can be open across an OS theme switch.
  function dotColor(name) {
    const pair = GROUP_COLORS[name] || GROUP_COLORS.grey;
    return window.matchMedia("(prefers-color-scheme: light)").matches ? pair.light : pair.dark;
  }

  function supported() {
    return !!chrome.tabGroups;
  }

  // Resolves to open groups ({kind:"open"}) followed by recently closed ones
  // ({kind:"closed"}), the order both callers render in.
  function load() {
    return new Promise((resolve) => {
      if (!supported()) {
        resolve([]);
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
            const open = (gs || []).map((g) => {
              const extra = info.get(g.id) || { tabCount: 0, firstTabId: null };
              return {
                kind: "open",
                id: g.id,
                title: g.title || "",
                color: g.color,
                windowId: g.windowId,
                tabCount: extra.tabCount,
                firstTabId: extra.firstTabId,
              };
            });
            open.sort((a, b) => a.windowId - b.windowId);

            resolve(
              open.concat(
                closed.map((e) => ({
                  kind: "closed",
                  title: e.title || "",
                  color: e.color,
                  urls: e.urls || [],
                  tabCount: (e.urls || []).length,
                  closedAt: e.closedAt,
                }))
              )
            );
          });
        });
      });
    });
  }

  // `onDone` runs once the group is focused. The popup passes window.close;
  // the new tab passes a no-op. `onGone` fires when the group vanished between
  // render and click, so the caller can refresh its list.
  function focusGroup(g, onDone, onGone) {
    // Uncollapse first so activating the tab doesn't race the collapse state.
    chrome.tabGroups.update(g.id, { collapsed: false }, () => {
      if (chrome.runtime.lastError) {
        void chrome.runtime.lastError;
        if (onGone) onGone();
        return;
      }
      const focusWindow = () => {
        chrome.windows.update(g.windowId, { focused: true }, () => {
          void chrome.runtime.lastError;
          if (onDone) onDone();
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

  function restoreGroup(entry, onDone) {
    if (!entry.urls || !entry.urls.length) return;
    // Restore runs in the background worker: the popup document dies the
    // moment focus shifts, which would abort mid-restore. The worker also owns
    // reusing an existing group and pruning the archive entry.
    chrome.runtime.sendMessage(
      {
        type: "RESTORE_GROUP",
        entry: {
          title: entry.title,
          color: entry.color,
          urls: entry.urls,
          closedAt: entry.closedAt,
        },
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
    if (onDone) onDone();
  }

  function activate(item, onDone, onGone) {
    if (item.kind === "open") focusGroup(item, onDone, onGone);
    else restoreGroup(item, onDone);
  }

  self.SpTabGroups = { COLORS: GROUP_COLORS, dotColor, supported, load, focusGroup, restoreGroup, activate };
})();
