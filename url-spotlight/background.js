const COMMAND_MESSAGES = {
  "toggle-spotlight": "TOGGLE_SPOTLIGHT",
  "switch-tabs": "TOGGLE_TAB_SWITCHER",
};

// --- Closed tab group tracking -------------------------------------------
// Chrome exposes no API for saved/closed tab groups, so we keep our own
// snapshots of live groups (storage.session survives worker restarts) and
// archive a group to storage.local the moment it is removed.
const CLOSED_GROUPS_KEY = "closedGroups";
const CLOSED_GROUPS_MAX = 10;
let snapshotTimer = null;

function snapshotGroups() {
  chrome.tabGroups.query({}, (groups) => {
    if (chrome.runtime.lastError || !groups) return;
    chrome.tabs.query({}, (tabs) => {
      if (chrome.runtime.lastError || !tabs) return;
      const snap = {};
      for (const g of groups) {
        snap[g.id] = { title: g.title || "", color: g.color, urls: [] };
      }
      for (const t of tabs) {
        if (t.groupId != null && t.groupId !== -1 && snap[t.groupId] && t.url) {
          snap[t.groupId].urls.push(t.url);
        }
      }
      chrome.storage.session.set({ liveGroupSnapshots: snap }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

function scheduleSnapshot() {
  // Debounced so tab-close storms settle before we rebuild; a group removal
  // lands within the quiet window and still reads the pre-close snapshot.
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    snapshotGroups();
  }, 250);
}

function archiveClosedGroup(group) {
  chrome.storage.session.get("liveGroupSnapshots", (data) => {
    void chrome.runtime.lastError;
    const snap = (data && data.liveGroupSnapshots && data.liveGroupSnapshots[group.id]) || null;
    const urls = snap ? snap.urls : [];
    if (!urls.length) return;
    const entry = {
      title: (snap && snap.title) || group.title || "",
      color: (snap && snap.color) || group.color || "grey",
      urls,
      closedAt: Date.now(),
    };
    chrome.storage.local.get(CLOSED_GROUPS_KEY, (store) => {
      void chrome.runtime.lastError;
      let list = (store && store[CLOSED_GROUPS_KEY]) || [];
      const key = entry.title + "\n" + urls.join("\n");
      list = list.filter((e) => e.title + "\n" + (e.urls || []).join("\n") !== key);
      list.unshift(entry);
      chrome.storage.local.set({ [CLOSED_GROUPS_KEY]: list.slice(0, CLOSED_GROUPS_MAX) }, () => {
        void chrome.runtime.lastError;
      });
    });
  });
}

chrome.tabGroups.onCreated.addListener(scheduleSnapshot);
chrome.tabGroups.onUpdated.addListener(scheduleSnapshot);
chrome.tabGroups.onMoved.addListener(scheduleSnapshot);
chrome.tabGroups.onRemoved.addListener((group) => {
  archiveClosedGroup(group);
  scheduleSnapshot();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.groupId != null) scheduleSnapshot();
});
chrome.tabs.onRemoved.addListener(scheduleSnapshot);
chrome.tabs.onAttached.addListener(scheduleSnapshot);

snapshotGroups();
// --------------------------------------------------------------------------

function isRestrictedUrl(url) {
  if (!url) return true;
  if (url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("about:") ||
    url.startsWith("data:") ||
    url.startsWith("chrome-extension://")
  );
}

function sendToggle(tabId, msgType, command, isRetry) {
  chrome.tabs.sendMessage(tabId, { type: msgType }, (res) => {
    const err = chrome.runtime.lastError;
    // Content script ACKs with {ok:true}. Without the ACK check, a listener
    // that handles the message but sends no response still sets lastError
    // ("message port closed") and would wrongly trigger the fallback.
    if (!err && res && res.ok) return;
    if (isRetry) {
      console.log(
        "[spotlight bg] toggle failed after inject, using popup fallback:",
        err ? err.message : "no ack"
      );
      openPopupFallback(command, tabId);
      return;
    }
    // No content script in this tab (tab loaded before install, file://,
    // page still loading…) — inject on demand, then retry once.
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["loader.js", "content.js"] },
      () => {
        if (chrome.runtime.lastError) {
          // Page Chrome refuses to inject into (chrome://, Web Store…)
          console.log(
            "[spotlight bg] inject failed, using popup fallback:",
            chrome.runtime.lastError.message
          );
          openPopupFallback(command, tabId);
          return;
        }
        sendToggle(tabId, msgType, command, true);
      }
    );
  });
}

function openPopupFallback(command, originTabId) {
  const params = new URLSearchParams({
    cmd: command,
    originTabId: String(originTabId || ""),
  });
  const popupUrl = chrome.runtime.getURL("popup.html") + "?" + params.toString();
  const popupWidth = 600;
  const popupContentHeight = 373;
  // Push window up by titlebar height so only content is visible (frameless look)
  const titlebarHeight = 28;
  const popupHeight = popupContentHeight + titlebarHeight;

  chrome.windows.getCurrent({ populate: false }, (win) => {
    const left = Math.round(win.left + (win.width - popupWidth) / 2);
    const top = Math.round(win.top + (win.height - popupContentHeight) / 2) - titlebarHeight;
    chrome.windows.create({
      url: popupUrl,
      type: "popup",
      width: popupWidth,
      height: popupHeight,
      left,
      top,
      focused: true,
    });
  });
}

chrome.commands.onCommand.addListener((command, tab) => {
  console.log("[spotlight bg] command:", command, "tab:", tab?.id);
  const msgType = COMMAND_MESSAGES[command];
  if (!msgType) return;

  const processTab = (t) => {
    if (!t || !t.id) return;
    if (isRestrictedUrl(t.url)) {
      openPopupFallback(command, t.id);
    } else {
      sendToggle(t.id, msgType, command);
    }
  };

  if (tab && tab.id) {
    processTab(tab);
    return;
  }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs[0]) processTab(tabs[0]);
    else console.log("[spotlight bg] no active tab found");
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "POPUP_NAVIGATE" && msg.url) {
    if (msg.newTab) {
      chrome.tabs.create({ url: msg.url, active: true }, () => {
        void chrome.runtime.lastError;
      });
    } else if (msg.originTabId) {
      chrome.tabs.update(msg.originTabId, { url: msg.url }, () => {
        void chrome.runtime.lastError;
      });
      chrome.tabs.update(msg.originTabId, { active: true }, () => {
        void chrome.runtime.lastError;
      });
    } else {
      chrome.tabs.create({ url: msg.url, active: true }, () => {
        void chrome.runtime.lastError;
      });
    }
    if (sender.tab && sender.tab.windowId) {
      chrome.windows.remove(sender.tab.windowId, () => {
        void chrome.runtime.lastError;
      });
    }
    return false;
  }

  if (msg && msg.type === "POPUP_ACTIVATE_TAB" && msg.tabId != null) {
    chrome.tabs.update(msg.tabId, { active: true }, () => {
      void chrome.runtime.lastError;
      if (msg.windowId != null) {
        chrome.windows.update(msg.windowId, { focused: true }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
    if (sender.tab && sender.tab.windowId) {
      chrome.windows.remove(sender.tab.windowId, () => {
        void chrome.runtime.lastError;
      });
    }
    return false;
  }

  if (msg && msg.type === "OPEN_NEW_TAB" && msg.url) {
    chrome.tabs.create({ url: msg.url, active: true }, () => {
      void chrome.runtime.lastError;
    });
    return false;
  }

  if (msg && msg.type === "OPEN_CURRENT_TAB" && msg.url) {
    const tabId = sender.tab && sender.tab.id;
    if (tabId) {
      chrome.tabs.update(tabId, { url: msg.url }, () => {
        void chrome.runtime.lastError;
      });
    } else {
      chrome.tabs.update({ url: msg.url }, () => {
        void chrome.runtime.lastError;
      });
    }
    return false;
  }

  if (msg && msg.type === "GET_TABS") {
    const popupUrl = chrome.runtime.getURL("popup.html");
    const selfTabId = msg.excludeSelf ? sender.tab && sender.tab.id : null;
    chrome.tabs.query({}, (tabs) => {
      const list = (tabs || [])
        .filter(
          (t) =>
            t.id != null &&
            t.id !== selfTabId &&
            !(t.url || "").startsWith(popupUrl)
        )
        .map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          title: t.title || t.url || "",
          url: t.url || "",
          // Serve favicons from Chrome's local cache (_favicon API) instead of
          // the raw favIconUrl: loading e.g. http://127.0.0.1 images from an
          // HTTPS page triggers mixed-content blocks and macOS local-network
          // permission prompts.
          favIconUrl: t.url
            ? chrome.runtime.getURL(
                "/_favicon/?pageUrl=" + encodeURIComponent(t.url) + "&size=32"
              )
            : "",
          active: !!t.active,
          lastAccessed: t.lastAccessed || 0,
        }))
        .sort((a, b) => b.lastAccessed - a.lastAccessed);
      sendResponse({ tabs: list });
    });
    return true;
  }

  if (msg && msg.type === "RESTORE_GROUP" && msg.entry && Array.isArray(msg.entry.urls)) {
    // Runs here, not in the popup: the popup document dies as soon as it
    // loses focus, which would abort mid-restore and leave ungrouped tabs.
    const entry = msg.entry;
    if (!entry.urls.length) return false;
    const tabIds = [];
    let remaining = entry.urls.length;
    entry.urls.forEach((url, idx) => {
      chrome.tabs.create({ url, active: false }, (tab) => {
        void chrome.runtime.lastError;
        if (tab && tab.id != null) tabIds[idx] = tab.id;
        remaining -= 1;
        if (remaining > 0) return;
        const ids = tabIds.filter((id) => id != null);
        if (!ids.length) return;
        const finish = () => {
          chrome.tabs.update(ids[0], { active: true }, () => {
            void chrome.runtime.lastError;
          });
          chrome.storage.local.get(CLOSED_GROUPS_KEY, (store) => {
            void chrome.runtime.lastError;
            const list = ((store && store[CLOSED_GROUPS_KEY]) || []).filter(
              (e) =>
                !(
                  e.closedAt === entry.closedAt &&
                  e.title === entry.title &&
                  (e.urls || []).join("\n") === entry.urls.join("\n")
                )
            );
            chrome.storage.local.set({ [CLOSED_GROUPS_KEY]: list }, () => {
              void chrome.runtime.lastError;
            });
          });
        };
        // Reuse an already-open group with the same title+color instead of
        // creating a new one (a fresh group would get its own auto-saved chip
        // in the bookmarks bar — Chrome exposes no API to reuse saved groups).
        chrome.tabGroups.query({ title: entry.title || undefined, color: entry.color }, (existing) => {
          void chrome.runtime.lastError;
          const match = (existing || []).find(
            (g) => (g.title || "") === (entry.title || "") && g.color === entry.color
          );
          if (match) {
            chrome.tabs.group({ tabIds: ids, groupId: match.id }, () => {
              if (chrome.runtime.lastError) {
                void chrome.runtime.lastError;
                return;
              }
              chrome.tabGroups.update(match.id, { collapsed: false }, () => {
                void chrome.runtime.lastError;
                finish();
              });
            });
            return;
          }
          chrome.tabs.group({ tabIds: ids }, (groupId) => {
            if (chrome.runtime.lastError) {
              void chrome.runtime.lastError;
              return;
            }
            chrome.tabGroups.update(groupId, { title: entry.title, color: entry.color }, () => {
              void chrome.runtime.lastError;
              finish();
            });
          });
        });
      });
    });
    return false;
  }

  if (msg && msg.type === "ACTIVATE_TAB" && msg.tabId != null) {
    chrome.tabs.update(msg.tabId, { active: true }, () => {
      void chrome.runtime.lastError;
      if (msg.windowId != null) {
        chrome.windows.update(msg.windowId, { focused: true }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
    return false;
  }

  if (!msg || msg.type !== "SEARCH_SUGGESTIONS") return false;

  const query = (msg.query || "").trim();
  console.log("[spotlight] search:", query, "bookmarks API:", typeof chrome.bookmarks, "history API:", typeof chrome.history);
  if (!query) {
    sendResponse({ suggestions: [] });
    return false;
  }

  if (!chrome.bookmarks || !chrome.history) {
    console.error("[spotlight] missing permissions — bookmarks/history API undefined");
    sendResponse({ suggestions: [] });
    return false;
  }

  Promise.all([
    new Promise((resolve) => {
      chrome.bookmarks.search(query, (results) => {
        console.log("[spotlight] bookmarks result:", results?.length, chrome.runtime.lastError);
        resolve(results || []);
      });
    }),
    new Promise((resolve) => {
      chrome.history.search(
        { text: query, maxResults: 20, startTime: 0 },
        (results) => {
          console.log("[spotlight] history result:", results?.length, chrome.runtime.lastError);
          resolve(results || []);
        }
      );
    }),
  ]).then(([bookmarks, history]) => {
    const seen = new Set();
    const items = [];

    for (const b of bookmarks) {
      if (!b.url || seen.has(b.url)) continue;
      seen.add(b.url);
      items.push({
        type: "bookmark",
        title: b.title || b.url,
        url: b.url,
        score: 1000,
      });
    }

    for (const h of history) {
      if (!h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      items.push({
        type: "history",
        title: h.title || h.url,
        url: h.url,
        score: (h.visitCount || 0) + (h.typedCount || 0) * 3,
      });
    }

    items.sort((a, b) => b.score - a.score);
    sendResponse({ suggestions: items.slice(0, 6) });
  });

  return true;
});
