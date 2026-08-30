// Pushes page content aside so the sidebar sits beside it instead of on top.
// Runs at document_start — documentElement exists by then — so the shift and a
// placeholder strip land before first paint and the page doesn't visibly jump
// when sidebar.js mounts the real thing at document_idle.
(() => {
  "use strict";
  if (window.__spSidebarShift) return;

  const STYLE_ID = "__sp-sb-shift";
  const PLACEHOLDER_ID = "__sp-sb-placeholder";
  const VAR = "--sp-sb-w";

  // Original inline left/width of page elements we nudged, for an exact revert.
  const nudged = new WeakMap();
  let applied = false;
  let currentSide = "left";
  let currentWidth = 0;
  let nudgeTimer = null;

  function styleEl() {
    let node = document.getElementById(STYLE_ID);
    if (node) return node;
    node = document.createElement("style");
    node.id = STYLE_ID;
    // A transform on <html> would be simpler, but it makes the root the
    // containing block for position:fixed descendants — and since the root box
    // scrolls, every fixed element would scroll away with the page. Margin
    // avoids that entirely.
    node.textContent = `
      html {
        margin-inline-start: var(${VAR}-start, 0px) !important;
        margin-inline-end: var(${VAR}-end, 0px) !important;
        width: calc(100% - var(${VAR}-start, 0px) - var(${VAR}-end, 0px)) !important;
        /* clip, not hidden: hidden turns <html> into a scroll container and
           breaks every position:sticky on the page. */
        overflow-x: clip;
      }
    `;
    (document.documentElement || document).appendChild(node);
    return node;
  }

  // Best-effort only. position:fixed elements resolve against the viewport, so
  // the html margin never moves them: a full-width fixed header would sit under
  // the sidebar. Nudge the obvious page-chrome cases and leave the rest — a
  // document-wide MutationObserver isn't worth what it costs on SPAs.
  function nudgeFixed() {
    if (!applied || !document.body) return;
    const offset = currentWidth;
    const vw = window.innerWidth;
    const scan = [];
    for (const child of document.body.children) {
      scan.push(child);
      for (const grandchild of child.children) scan.push(grandchild);
    }
    for (const node of scan) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.id === PLACEHOLDER_ID) continue;
      const cs = getComputedStyle(node);
      if (cs.position !== "fixed") continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < vw * 0.7) continue;
      if (currentSide === "left" ? rect.left > 4 : rect.right < vw - 4) continue;
      if (!nudged.has(node)) {
        nudged.set(node, { left: node.style.left, right: node.style.right, width: node.style.width });
      }
      if (currentSide === "left") node.style.setProperty("left", offset + "px", "important");
      else node.style.setProperty("right", offset + "px", "important");
      node.style.setProperty("width", "calc(100% - " + offset + "px)", "important");
    }
  }

  function scheduleNudge() {
    nudgeFixed();
    // Page chrome often mounts after document_idle, so take one late pass.
    if (nudgeTimer) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      nudgeTimer = null;
      nudgeFixed();
    }, 400);
  }

  function unnudge() {
    if (!document.body) return;
    const scan = [];
    for (const child of document.body.children) {
      scan.push(child);
      for (const grandchild of child.children) scan.push(grandchild);
    }
    for (const node of scan) {
      if (!(node instanceof HTMLElement)) continue;
      const prev = nudged.get(node);
      if (!prev) continue;
      node.style.left = prev.left;
      node.style.right = prev.right;
      node.style.width = prev.width;
      nudged.delete(node);
    }
  }

  // Extension pages (the new tab) lay themselves out with a fixed full-viewport
  // grid, which the html margin can't move — they read --sp-sb-w as padding
  // instead. So there we publish the variable and skip the layout rule.
  const varOnly = location.protocol === "chrome-extension:";

  function apply(px, side) {
    currentSide = side === "right" ? "right" : "left";
    currentWidth = px;
    const root = document.documentElement;
    if (!varOnly) styleEl();
    root.style.setProperty(VAR, px + "px");
    root.style.setProperty(VAR + "-start", currentSide === "left" ? px + "px" : "0px");
    root.style.setProperty(VAR + "-end", currentSide === "right" ? px + "px" : "0px");
    applied = true;
    if (!varOnly) scheduleNudge();
  }

  function clear() {
    const root = document.documentElement;
    const node = document.getElementById(STYLE_ID);
    if (node) node.remove();
    root.style.removeProperty(VAR);
    root.style.removeProperty(VAR + "-start");
    root.style.removeProperty(VAR + "-end");
    removePlaceholder();
    unnudge();
    applied = false;
    currentWidth = 0;
  }

  // A flat colored strip painted before the real sidebar exists, so the gap
  // opened by the margin isn't a flash of page background.
  function showPlaceholder(px, side) {
    if (document.getElementById(PLACEHOLDER_ID)) return;
    const strip = document.createElement("div");
    strip.id = PLACEHOLDER_ID;
    strip.style.cssText =
      "position:fixed;top:0;bottom:0;width:" +
      px +
      "px;" +
      (side === "right" ? "right:0;" : "left:0;") +
      "z-index:2147483646;background:#1c1e26;";
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
      strip.style.background = "#f6f6f8";
    }
    (document.documentElement || document).appendChild(strip);
  }

  function removePlaceholder() {
    const strip = document.getElementById(PLACEHOLDER_ID);
    if (strip) strip.remove();
  }

  // Fullscreen video with a sidebar over it, on a shifted layout, is wrong on
  // both counts — stand down until it exits.
  let suspendedWidth = null;
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) {
      if (applied) {
        suspendedWidth = currentWidth;
        document.documentElement.style.setProperty(VAR + "-start", "0px");
        document.documentElement.style.setProperty(VAR + "-end", "0px");
      }
    } else if (suspendedWidth != null) {
      apply(suspendedWidth, currentSide);
      suspendedWidth = null;
    }
  });

  window.addEventListener("resize", () => {
    if (applied) nudgeFixed();
  });

  window.__spSidebarShift = {
    apply,
    clear,
    showPlaceholder,
    removePlaceholder,
    renudge: scheduleNudge,
    applied: () => applied,
  };

  // Paint the shift immediately when the sidebar was left open, so navigating
  // with it pinned doesn't flash an unshifted page.
  chrome.storage.local.get({ sidebarOpen: false, sidebarWidth: 260 }, (local) => {
    void chrome.runtime.lastError;
    if (!local || !local.sidebarOpen) return;
    chrome.storage.sync.get(
      {
        sidebarPushPage: true,
        sidebarSide: "left",
        sidebarEnabled: true,
        sidebarExcludedHosts: ["docs.google.com", "www.google.com/maps", "meet.google.com"],
      },
      (sync) => {
      void chrome.runtime.lastError;
      if (!sync || !sync.sidebarEnabled) return;
      // Same matching as sidebar.js: bare host, or host+path prefix for the
      // canvas-heavy Google apps that live under one domain.
      const here = (location.host + location.pathname).toLowerCase();
      const excluded = (sync.sidebarExcludedHosts || []).some((raw) => {
        const entry = String(raw || "").trim().toLowerCase();
        return !!entry && (here.startsWith(entry) || location.host.toLowerCase() === entry);
      });
      if (excluded) return;
      const side = sync.sidebarSide === "right" ? "right" : "left";
      if (!varOnly) showPlaceholder(local.sidebarWidth, side);
      if (sync.sidebarPushPage || varOnly) apply(local.sidebarWidth, side);
      }
    );
  });
})();
