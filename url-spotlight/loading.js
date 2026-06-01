(() => {
  // Page-load trigger for the shared radial-pulse loader. Runs at
  // document_start on every full navigation/reload. Shows the overlay
  // immediately (default-on) and hides it on window load.
  const L = window.__spotlightLoader;
  if (!L) return;

  let safetyTimer = null;
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    L.hide();
  }

  // Show immediately (avoids flash-of-nothing for the default-on majority),
  // remove right away if the user disabled the feature.
  L.show();
  try {
    chrome.storage.sync.get({ loadingAnimation: true }, (r) => {
      if (!r.loadingAnimation) finish();
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === "sync" && c.loadingAnimation && !c.loadingAnimation.newValue) {
        finish();
      }
    });
  } catch (e) {
    // Extension context invalidated — safety timeout still cleans up.
  }

  if (document.readyState === "complete") {
    finish();
  } else {
    window.addEventListener("load", finish, { once: true });
  }
  window.addEventListener("pageshow", finish, { once: true });
  safetyTimer = setTimeout(finish, 8000);
})();
