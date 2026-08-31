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

// --- Sidebar -------------------------------------------------------------
// Each open side panel holds a long-lived port so the worker can tell it the
// model went stale.
const sidebarPorts = new Set();
// windowId -> port. Lets the toggle know whether a panel is already up in this
// window without an async lookup, which the user-gesture rule forbids.
const panelWindows = new Map();
// Mirror of storage.local.sidebarOpen: sidePanel.open() has to be called
// before anything async, so the toggle cannot await a storage read.
let sidebarOpenCache = false;
let broadcastTimer = null;

chrome.storage.local.get({ sidebarOpen: false }, (r) => {
  void chrome.runtime.lastError;
  sidebarOpenCache = !!(r && r.sidebarOpen);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sidebarOpen) {
    sidebarOpenCache = !!changes.sidebarOpen.newValue;
  }
});

function scheduleBroadcast() {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    for (const port of sidebarPorts) {
      try {
        port.postMessage({ type: "SIDEBAR_DIRTY" });
      } catch (err) {
        void err; // port died between disconnect and this tick
      }
    }
  }, 40);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sp-sidebar") return;
  sidebarPorts.add(port);
  port.onMessage.addListener((msg) => {
    if (msg && msg.type === "SIDEBAR_HELLO" && msg.windowId != null) {
      panelWindows.set(msg.windowId, port);
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    sidebarPorts.delete(port);
    for (const [windowId, p] of panelWindows) {
      if (p === port) panelWindows.delete(windowId);
    }
  });
});

function handleSidebarCommand(tab) {
  const windowId = tab && tab.windowId != null ? tab.windowId : null;
  // Follow whether this window's panel is actually up rather than the stored
  // flag: the user can dismiss a panel with Chrome's own close button, which
  // leaves the flag set and would otherwise cost a wasted press to get back.
  const panelUp = windowId != null && panelWindows.has(windowId);
  const next = !panelUp;

  // MUST be the first statement on the opening path. sidePanel.open() only
  // works while the command's user gesture is live, and any await before it
  // (a storage read, a tabs query) drops that gesture.
  if (next && windowId != null && chrome.sidePanel && chrome.sidePanel.open) {
    try {
      const p = chrome.sidePanel.open({ windowId });
      if (p && p.catch) {
        p.catch((err) => console.log("[spotlight bg] sidePanel.open failed:", err && err.message));
      }
    } catch (err) {
      console.log("[spotlight bg] sidePanel.open threw:", err && err.message);
    }
  }

  // There is no sidePanel.close(), so closing goes through the flag: the panel
  // watches it and closes itself when it turns false.
  sidebarOpenCache = next;
  chrome.storage.local.set({ sidebarOpen: next }, () => void chrome.runtime.lastError);
}

// Builds the one-window model the sidebar renders: groups in tab-strip order,
// then ungrouped tabs, plus the recently-closed archive.
function buildSidebarModel(windowId, sendResponse) {
  chrome.tabs.query({}, (allTabs) => {
    void chrome.runtime.lastError;
    const tabs = (allTabs || []).filter((t) => t.windowId === windowId && t.id != null);
    // tabs.query returns tab-strip order (pinned tabs first), which is exactly
    // the order a sidebar wants — unlike GET_TABS, which sorts by recency.
    tabs.sort((a, b) => a.index - b.index);

    const otherCounts = new Map();
    for (const t of allTabs || []) {
      if (t.windowId === windowId) continue;
      otherCounts.set(t.windowId, (otherCounts.get(t.windowId) || 0) + 1);
    }

    const openUrls = {};
    for (const t of tabs) if (t.url && openUrls[t.url] == null) openUrls[t.url] = t.id;

    const groupOrder = [];
    const byGroup = new Map();
    const ungrouped = [];
    for (const t of tabs) {
      const item = mapTab(t);
      if (t.groupId == null || t.groupId === -1) {
        ungrouped.push(item);
        continue;
      }
      if (!byGroup.has(t.groupId)) {
        byGroup.set(t.groupId, []);
        groupOrder.push(t.groupId);
      }
      byGroup.get(t.groupId).push(item);
    }

    const finish = (groupMeta) => {
      chrome.storage.local.get(CLOSED_GROUPS_KEY, (store) => {
        void chrome.runtime.lastError;
        sendResponse({
          model: {
            windowId,
            groups: groupOrder.map((id) => {
              const meta = groupMeta.get(id) || {};
              return {
                id,
                title: meta.title || "",
                color: meta.color || "grey",
                chromeCollapsed: !!meta.collapsed,
                tabs: byGroup.get(id) || [],
              };
            }),
            ungrouped,
            closedGroups: (store && store[CLOSED_GROUPS_KEY]) || [],
            openUrls,
            otherWindows: [...otherCounts].map(([id, tabCount]) => ({ windowId: id, tabCount })),
          },
        });
      });
    };

    if (!chrome.tabGroups) {
      finish(new Map());
      return;
    }
    chrome.tabGroups.query({ windowId }, (groups) => {
      void chrome.runtime.lastError;
      const meta = new Map();
      for (const g of groups || []) meta.set(g.id, g);
      finish(meta);
    });
  });
}

// The two cadences are deliberately different: the archive above needs its
// 250ms quiet window to read the pre-close snapshot, while the sidebar wants to
// repaint promptly. Both hang off one funnel so there is a single listener set.
function onTabsChanged() {
  scheduleSnapshot();
  scheduleBroadcast();
}

chrome.tabGroups.onCreated.addListener(onTabsChanged);
chrome.tabGroups.onUpdated.addListener(onTabsChanged);
chrome.tabGroups.onMoved.addListener(onTabsChanged);
chrome.tabGroups.onRemoved.addListener((group) => {
  archiveClosedGroup(group);
  onTabsChanged();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // The sidebar renders title, favicon, audio and pin state, so it needs more
  // than the url/groupId the group snapshot cares about.
  if (
    changeInfo.url ||
    changeInfo.groupId != null ||
    changeInfo.title != null ||
    changeInfo.favIconUrl != null ||
    changeInfo.status != null ||
    changeInfo.pinned != null ||
    changeInfo.audible != null ||
    changeInfo.mutedInfo != null
  ) {
    onTabsChanged();
  }
});
chrome.tabs.onCreated.addListener(onTabsChanged);
chrome.tabs.onMoved.addListener(onTabsChanged);
chrome.tabs.onActivated.addListener(scheduleBroadcast);
chrome.tabs.onDetached.addListener(onTabsChanged);
chrome.tabs.onReplaced.addListener(onTabsChanged);
chrome.tabs.onRemoved.addListener(onTabsChanged);
chrome.tabs.onAttached.addListener(onTabsChanged);
chrome.windows.onFocusChanged.addListener(scheduleBroadcast);

snapshotGroups();
// --------------------------------------------------------------------------

// Serve favicons from Chrome's local cache (_favicon API) instead of the raw
// favIconUrl: loading e.g. http://127.0.0.1 images from an HTTPS page triggers
// mixed-content blocks and macOS local-network permission prompts.
function faviconUrl(url) {
  return url
    ? chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(url) + "&size=32")
    : "";
}

function mapTab(t) {
  return {
    tabId: t.id,
    windowId: t.windowId,
    index: t.index,
    title: t.title || t.url || "",
    url: t.url || "",
    favIconUrl: faviconUrl(t.url),
    active: !!t.active,
    pinned: !!t.pinned,
    audible: !!t.audible,
    muted: !!(t.mutedInfo && t.mutedInfo.muted),
    discarded: !!t.discarded,
    groupId: t.groupId,
    lastAccessed: t.lastAccessed || 0,
  };
}

function isRestrictedUrl(url) {
  if (!url) return true;
  if (url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("about:") ||
    url.startsWith("data:") ||
    url.startsWith("view-source:") ||
    url.startsWith("chrome-extension://") ||
    // The Web Store blocks extension scripts, so the overlay can never run
    // there — decide for the side panel on the first press, not the second.
    url.startsWith("https://chromewebstore.google.com/") ||
    url.startsWith("https://chrome.google.com/webstore")
  );
}

// The fallback popup is an extension page with no content script and no
// message listener, so isRestrictedUrl() deliberately doesn't cover it (own
// pages take the content-script path, which is what the new tab page needs).
// Match it precisely instead.
function isFallbackPopup(url) {
  return !!url && url.startsWith(chrome.runtime.getURL("popup.html"));
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
      {
        target: { tabId },
        // Same order as the manifest content_scripts entry: query.js defines
        // the helpers content.js reads at load.
        files: ["loader.js", "loading.js", "query.js", "content.js"],
      },
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

// Toolbar icon toggles the panel. Deliberately not
// sidePanel.setPanelBehavior({openPanelOnActionClick:true}): that only opens,
// never closes, so the icon would stop being a toggle. onClicked also fires
// only with no default_popup set, which is why the tab groups popup is gone —
// the sidebar lists groups itself.
chrome.action.onClicked.addListener((tab) => {
  handleSidebarCommand(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  console.log("[spotlight bg] command:", command, "tab:", tab?.id);
  if (command === "toggle-sidebar") {
    // Handled inline, not via processTab: sidePanel.open() must run inside
    // this synchronous turn or the user gesture is gone.
    if (tab && tab.id) {
      handleSidebarCommand(tab);
    } else {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        handleSidebarCommand(tabs && tabs[0]);
      });
    }
    return;
  }
  const msgType = COMMAND_MESSAGES[command];
  if (!msgType) return;

  const processTab = (t) => {
    if (!t || !t.id) return;
    // Pressing the shortcut again while the fallback popup is focused would
    // find no listener there and open a *second* popup window. Toggle it shut
    // instead, matching how the inline overlay behaves.
    if (isFallbackPopup(t.url)) {
      chrome.windows.remove(t.windowId);
      return;
    }
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
        .map(mapTab)
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

  if (msg && msg.type === "SIDEBAR_MODEL") {
    // The panel passes its own windowId: falling back to the last focused
    // window shows the wrong tabs when a panel sits in an unfocused window.
    const known = msg.windowId != null ? msg.windowId : sender.tab && sender.tab.windowId;
    if (known != null) {
      buildSidebarModel(known, sendResponse);
    } else {
      chrome.windows.getLastFocused({}, (win) => {
        void chrome.runtime.lastError;
        if (!win) {
          sendResponse({ model: null });
          return;
        }
        buildSidebarModel(win.id, sendResponse);
      });
    }
    return true;
  }

  if (msg && msg.type === "SIDEBAR_CLOSE_TAB" && msg.tabId != null) {
    chrome.tabs.remove(msg.tabId, () => {
      void chrome.runtime.lastError;
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg && msg.type === "SIDEBAR_NEW_TAB") {
    const create = { active: true };
    if (msg.url) create.url = msg.url;
    if (msg.windowId != null) create.windowId = msg.windowId;
    chrome.tabs.create(create, (tab) => {
      void chrome.runtime.lastError;
      if (!tab || tab.id == null) {
        sendResponse({ ok: false });
        return;
      }
      if (msg.groupId == null || msg.groupId === -1 || !chrome.tabGroups) {
        sendResponse({ ok: true, tabId: tab.id });
        return;
      }
      chrome.tabs.group({ tabIds: [tab.id], groupId: msg.groupId }, () => {
        void chrome.runtime.lastError;
        sendResponse({ ok: true, tabId: tab.id });
      });
    });
    return true;
  }

  if (msg && msg.type === "SIDEBAR_CLOSE_GROUP" && msg.groupId != null) {
    // Closing every tab removes the group, and the existing tabGroups.onRemoved
    // archiver then files it under Recently Closed for free.
    chrome.tabs.query({ groupId: msg.groupId }, (tabs) => {
      void chrome.runtime.lastError;
      const ids = (tabs || []).map((t) => t.id).filter((id) => id != null);
      if (!ids.length) {
        sendResponse({ ok: true });
        return;
      }
      chrome.tabs.remove(ids, () => {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  if (msg && msg.type === "SIDEBAR_MOVE_TAB" && msg.tabId != null) {
    // Wired up ahead of the drag UI, which is a follow-up.
    chrome.tabs.move(msg.tabId, { index: msg.index != null ? msg.index : -1 }, () => {
      void chrome.runtime.lastError;
      if (msg.groupId === undefined || !chrome.tabGroups) {
        sendResponse({ ok: true });
        return;
      }
      if (msg.groupId == null || msg.groupId === -1) {
        chrome.tabs.ungroup(msg.tabId, () => {
          void chrome.runtime.lastError;
          sendResponse({ ok: true });
        });
        return;
      }
      chrome.tabs.group({ tabIds: [msg.tabId], groupId: msg.groupId }, () => {
        void chrome.runtime.lastError;
        sendResponse({ ok: true });
      });
    });
    return true;
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
