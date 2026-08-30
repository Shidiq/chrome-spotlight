// Side panel surface. Same view as the injected overlay, minus the page-push
// and the resize handle — Chrome owns the panel's frame and width. This is the
// surface that still works on chrome:// pages, the Web Store and PDFs, where
// no content script can run.
(() => {
  "use strict";

  let view = null;

  chrome.windows.getCurrent({}, (win) => {
    void chrome.runtime.lastError;
    view = self.SpSidebarView.create({
      root: document.body,
      surface: "panel",
      // Pin the panel to the window it opened in. Without this the model would
      // fall back to the last focused window and show the wrong tabs whenever
      // focus moves elsewhere.
      windowId: win ? win.id : null,
      onActivate: () => {},
    });
  });

  // The toggle shortcut flips one flag for every surface; there is no
  // sidePanel.close(), so the panel closes itself when the flag goes false.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.sidebarOpen && !changes.sidebarOpen.newValue) {
      if (view) view.destroy();
      window.close();
    }
  });
})();
