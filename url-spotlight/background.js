const COMMAND_MESSAGES = {
  "toggle-spotlight": "TOGGLE_SPOTLIGHT",
  "switch-tabs": "TOGGLE_TAB_SWITCHER",
};

function sendToggle(tabId, msgType) {
  chrome.tabs.sendMessage(tabId, { type: msgType }, () => {
    const err = chrome.runtime.lastError;
    if (err) console.log("[spotlight bg] toggle err:", err.message);
  });
}

chrome.commands.onCommand.addListener((command, tab) => {
  console.log("[spotlight bg] command:", command, "tab:", tab?.id);
  const msgType = COMMAND_MESSAGES[command];
  if (!msgType) return;
  if (tab && tab.id) {
    sendToggle(tab.id, msgType);
    return;
  }
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) sendToggle(tabs[0].id, msgType);
    else console.log("[spotlight bg] no active tab found");
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
    chrome.tabs.query({}, (tabs) => {
      const list = (tabs || [])
        .filter((t) => t.id != null)
        .map((t) => ({
          tabId: t.id,
          windowId: t.windowId,
          title: t.title || t.url || "",
          url: t.url || "",
          favIconUrl: t.favIconUrl || "",
          active: !!t.active,
          lastAccessed: t.lastAccessed || 0,
        }))
        .sort((a, b) => b.lastAccessed - a.lastAccessed);
      sendResponse({ tabs: list });
    });
    return true;
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
    sendResponse({ suggestions: items.slice(0, 5) });
  });

  return true;
});
