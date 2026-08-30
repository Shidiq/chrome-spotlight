// Overlay surface: hosts the shared sidebar view in a closed shadow root on
// every ordinary page, and keeps it in step with storage.local.sidebarOpen so
// one toggle pins it across every tab and every navigation.
(() => {
  "use strict";
  if (window.__spSidebar) return;

  const MIN_WIDTH = 200;
  const MAX_WIDTH = 480;

  const SYNC_DEFAULTS = {
    sidebarEnabled: true,
    sidebarSide: "left",
    sidebarPushPage: true,
    sidebarExcludedHosts: ["docs.google.com", "www.google.com/maps", "meet.google.com"],
  };
  const LOCAL_DEFAULTS = { sidebarOpen: false, sidebarWidth: 260 };

  let cfg = Object.assign({}, SYNC_DEFAULTS);
  let width = LOCAL_DEFAULTS.sidebarWidth;
  let open = false;
  let hostEl = null;
  let view = null;
  let handleEl = null;

  function clampWidth(px) {
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(px) || LOCAL_DEFAULTS.sidebarWidth));
  }

  // Entries match either a bare host ("docs.google.com") or host+path prefix
  // ("www.google.com/maps"), which is how the canvas-heavy Google apps split.
  function isExcluded() {
    const here = location.host + location.pathname;
    return (cfg.sidebarExcludedHosts || []).some((raw) => {
      const entry = String(raw || "").trim().toLowerCase();
      if (!entry) return false;
      return here.toLowerCase().startsWith(entry) || location.host.toLowerCase() === entry;
    });
  }

  function shift() {
    return window.__spSidebarShift;
  }

  function applyShift() {
    if (!shift()) return;
    // The new tab page always needs --sp-sb-w published (its fixed grid pads
    // itself with it) even when page-pushing is switched off for real sites.
    if (cfg.sidebarPushPage || location.protocol === "chrome-extension:") {
      shift().apply(width, cfg.sidebarSide);
    } else {
      shift().clear();
    }
  }

  function mount() {
    if (hostEl || !cfg.sidebarEnabled || isExcluded()) return;

    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.top = "0";
    hostEl.style.bottom = "0";
    hostEl.style[cfg.sidebarSide === "right" ? "right" : "left"] = "0";
    hostEl.style.width = width + "px";
    // One below the spotlight overlay: when both are up, the spotlight wins.
    hostEl.style.zIndex = "2147483646";

    const shadow = hostEl.attachShadow({ mode: "closed" });

    view = self.SpSidebarView.create({
      root: shadow,
      surface: "overlay",
      // Activating a tab or opening a URL navigates away from this document;
      // the sidebar in the destination tab takes over from storage state.
      onActivate: () => {},
    });

    handleEl = document.createElement("div");
    handleEl.className = "sp-sb-resize " + (cfg.sidebarSide === "right" ? "right" : "left");
    handleEl.addEventListener("mousedown", startResize);
    shadow.appendChild(handleEl);

    document.documentElement.appendChild(hostEl);
    applyShift();
    if (shift()) shift().removePlaceholder();
  }

  function unmount() {
    if (view) {
      view.destroy();
      view = null;
    }
    if (hostEl) {
      hostEl.remove();
      hostEl = null;
    }
    handleEl = null;
    if (shift()) shift().clear();
  }

  function sync() {
    if (open) mount();
    else unmount();
  }

  // --- resize --------------------------------------------------------------
  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width;
    const dir = cfg.sidebarSide === "right" ? -1 : 1;

    function onMove(ev) {
      width = clampWidth(startWidth + (ev.clientX - startX) * dir);
      if (hostEl) hostEl.style.width = width + "px";
      applyShift();
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      chrome.storage.local.set({ sidebarWidth: width }, () => void chrome.runtime.lastError);
    }
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
  }

  // --- storage wiring ------------------------------------------------------
  Promise.all([
    new Promise((res) => chrome.storage.sync.get(SYNC_DEFAULTS, res)),
    new Promise((res) => chrome.storage.local.get(LOCAL_DEFAULTS, res)),
  ]).then(([syncCfg, local]) => {
    void chrome.runtime.lastError;
    cfg = Object.assign({}, SYNC_DEFAULTS, syncCfg);
    width = clampWidth(local.sidebarWidth);
    open = !!local.sidebarOpen;
    // The document_start pass may have painted a placeholder for a page we
    // turn out to be excluded from, or with settings it couldn't see.
    if (!open || !cfg.sidebarEnabled || isExcluded()) {
      if (shift()) shift().clear();
    }
    sync();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.sidebarWidth) {
        width = clampWidth(changes.sidebarWidth.newValue);
        if (hostEl) hostEl.style.width = width + "px";
        if (open) applyShift();
      }
      if (changes.sidebarOpen) {
        open = !!changes.sidebarOpen.newValue;
        sync();
      }
      return;
    }
    if (area !== "sync") return;
    let remount = false;
    for (const key of ["sidebarEnabled", "sidebarSide", "sidebarPushPage", "sidebarExcludedHosts"]) {
      if (changes[key]) {
        cfg[key] = changes[key].newValue;
        remount = true;
      }
    }
    if (remount) {
      unmount();
      sync();
    }
  });

  // Typing in the sidebar must not reach the page. The view stops propagation
  // on its own container, but that is bubble phase — a page (or content.js)
  // listening in capture on document would still see every keystroke. Capture
  // on window runs before document does, and a closed shadow root retargets
  // the event to the host, so this is an exact test for "came from the
  // sidebar".
  for (const type of ["keydown", "keyup", "keypress"]) {
    window.addEventListener(
      type,
      (e) => {
        if (hostEl && e.target === hostEl) e.stopPropagation();
      },
      true
    );
  }

  // Lets the worker learn this tab can host the overlay, so the toggle doesn't
  // fall back to the side panel here.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "SIDEBAR_PING") return;
    sendResponse({ ok: true });
  });

  window.__spSidebar = {
    mount,
    unmount,
    isOpen: () => !!hostEl,
    focusSearch: () => view && view.focusSearch(),
  };
})();
