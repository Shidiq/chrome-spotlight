(() => {
  // Page-load + outgoing-navigation trigger for the shared radial-pulse
  // loader. Runs at document_start on every full navigation/reload. Shows the
  // overlay immediately (default-on), hides it on window load, and re-shows it
  // when the user starts leaving the page so the network wait isn't bare.
  const L = window.__spotlightLoader;
  if (!L) return;
  // On-demand injection (background retry) can race the manifest's
  // document_start injection — a second copy would double-register listeners.
  if (window.__spotlightLoading) return;
  window.__spotlightLoading = true;

  const SAFETY_MS = 8000;
  // A click can show the overlay without ever navigating (download link, a JS
  // handler that cancels, blocked popup). If no beforeunload follows, back out.
  const CANCEL_MS = 2500;

  let enabled = true;
  let safetyTimer = null;
  let cancelTimer = null;
  let done = false;

  function clearCancel() {
    if (cancelTimer) {
      clearTimeout(cancelTimer);
      cancelTimer = null;
    }
  }

  function finish() {
    if (done) return;
    done = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    clearCancel();
    L.hide();
  }

  // Show immediately (avoids flash-of-nothing for the default-on majority),
  // remove right away if the user disabled the feature.
  L.show();
  try {
    chrome.storage.sync.get({ loadingAnimation: true }, (r) => {
      enabled = !!r.loadingAnimation;
      if (!enabled) finish();
    });
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== "sync" || !c.loadingAnimation) return;
      enabled = !!c.loadingAnimation.newValue;
      if (!enabled) finish();
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
  safetyTimer = setTimeout(finish, SAFETY_MS);

  // --- Outgoing navigation ---
  // The destination document can only show the overlay once it reaches
  // document_start, which leaves the whole "waiting for server" gap bare.
  // These triggers bridge it from the page being left behind.

  function showForNav(withCancelGuard) {
    if (!enabled) return;
    // Re-arm the lifecycle: this page's own load already called finish().
    done = false;
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(finish, SAFETY_MS);
    L.show();
    clearCancel();
    if (withCancelGuard) cancelTimer = setTimeout(finish, CANCEL_MS);
  }

  function navigatesThisFrame(target) {
    if (!target) return true;
    const t = target.toLowerCase();
    // all_frames is false, so we only ever run in the top frame — _top and
    // _parent resolve to this frame too.
    return t === "_self" || t === "_top" || t === "_parent" || t === window.name.toLowerCase();
  }

  function isSameDocument(url) {
    try {
      const dest = new URL(url, document.baseURI);
      const here = new URL(location.href);
      dest.hash = "";
      here.hash = "";
      return dest.href === here.href;
    } catch (e) {
      return false;
    }
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!enabled || e.defaultPrevented) return;
      if (e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      let a = null;
      for (const node of path) {
        if (node && node.nodeType === 1 && node.tagName === "A" && node.hasAttribute("href")) {
          a = node;
          break;
        }
      }
      if (!a && e.target && e.target.closest) a = e.target.closest("a[href]");
      if (!a) return;

      if (a.hasAttribute("download")) return;
      if (!navigatesThisFrame(a.getAttribute("target"))) return;

      const href = a.getAttribute("href");
      if (!href || href.startsWith("#")) return;
      let url;
      try {
        url = new URL(href, document.baseURI);
      } catch (err) {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (isSameDocument(url.href)) return;

      showForNav(true);
    },
    true
  );

  document.addEventListener(
    "submit",
    (e) => {
      if (!enabled || e.defaultPrevented) return;
      const form = e.target;
      if (!form || form.nodeType !== 1) return;
      if (!navigatesThisFrame(form.getAttribute("target"))) return;
      showForNav(true);
    },
    true
  );

  // Catch-all for reload, address-bar navigation, and anything the handlers
  // above miss. Reaching here means the navigation is really committing, so
  // drop the click cancel guard and let the safety timeout own cleanup.
  window.addEventListener("beforeunload", () => {
    showForNav(false);
  });
})();
