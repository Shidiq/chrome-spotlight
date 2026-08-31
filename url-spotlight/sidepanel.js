// The sidebar's only surface. Chrome owns the panel's frame, side and width,
// and it works everywhere a content script cannot — chrome:// pages, the Web
// Store, PDFs.
(() => {
  "use strict";

  let view = null;

  chrome.windows.getCurrent({}, (win) => {
    void chrome.runtime.lastError;
    view = self.SpSidebarView.create({
      root: document.body,
      // Pin the panel to the window it opened in. Without this the model would
      // fall back to the last focused window and show the wrong tabs whenever
      // focus moves elsewhere.
      windowId: win ? win.id : null,
      onActivate: () => {},
    });
  });

  // There is no sidePanel.close(), so the toggle closes the panel by flipping
  // this flag and letting the panel close itself.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.sidebarOpen && !changes.sidebarOpen.newValue) {
      if (view) view.destroy();
      window.close();
    }
  });
})();
