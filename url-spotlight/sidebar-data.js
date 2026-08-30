// Every piece of sidebar data access, in one place. Content scripts only get
// chrome.storage / chrome.runtime / chrome.i18n — no chrome.tabs, no
// chrome.tabGroups — so all of it goes through the background worker. The side
// panel could call those APIs directly, but routing it the same way keeps one
// code path for both surfaces.
(() => {
  "use strict";
  if (self.SpSidebarData) return;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // extension reloading, tab dying, …
          resolve(res || null);
        });
      } catch (err) {
        void err;
        resolve(null);
      }
    });
  }

  function fetchModel(windowId) {
    return send({ type: "SIDEBAR_MODEL", windowId }).then((r) => (r && r.model) || null);
  }

  const activateTab = (tabId, windowId) => send({ type: "ACTIVATE_TAB", tabId, windowId });
  const closeTab = (tabId) => send({ type: "SIDEBAR_CLOSE_TAB", tabId });
  const closeGroup = (groupId) => send({ type: "SIDEBAR_CLOSE_GROUP", groupId });
  const newTab = (opts) => send(Object.assign({ type: "SIDEBAR_NEW_TAB" }, opts || {}));
  const navigate = (url, newWindowTab) =>
    send({ type: newWindowTab === false ? "OPEN_CURRENT_TAB" : "OPEN_NEW_TAB", url });
  // Built ahead of the drag UI, which is a follow-up.
  const moveTab = (tabId, index, groupId) =>
    send({ type: "SIDEBAR_MOVE_TAB", tabId, index, groupId });

  // Restoring a closed group runs in the worker (SpTabGroups.restoreGroup is
  // already just a sendMessage), so it works unchanged from a content script.
  function restoreGroup(entry) {
    if (self.SpTabGroups) self.SpTabGroups.restoreGroup(entry);
  }

  // Long-lived port so the worker can say "your model is stale". Reconnects on
  // its own: an MV3 worker teardown disconnects every port, and without this
  // the sidebar would silently stop updating until the next page load.
  function subscribe(onDirty) {
    let port = null;
    let stopped = false;
    let backoff = 250;

    function connect() {
      if (stopped) return;
      try {
        port = chrome.runtime.connect({ name: "sp-sidebar" });
      } catch (err) {
        void err;
        schedule();
        return;
      }
      backoff = 250;
      port.onMessage.addListener((msg) => {
        if (msg && msg.type === "SIDEBAR_DIRTY") onDirty();
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        port = null;
        schedule();
      });
      // The worker may have missed changes while it was down.
      onDirty();
    }

    function schedule() {
      if (stopped) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 5000);
    }

    connect();
    return {
      // Panels identify their window so the worker knows a panel is up there.
      hello(windowId) {
        if (port) {
          try {
            port.postMessage({ type: "SIDEBAR_HELLO", windowId });
          } catch (err) {
            void err;
          }
        }
      },
      stop() {
        stopped = true;
        if (port) {
          try {
            port.disconnect();
          } catch (err) {
            void err;
          }
          port = null;
        }
      },
    };
  }

  self.SpSidebarData = {
    fetchModel,
    activateTab,
    closeTab,
    closeGroup,
    newTab,
    navigate,
    moveTab,
    restoreGroup,
    subscribe,
  };
})();
