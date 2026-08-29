(() => {
  // Shared radial-pulse loading overlay. Exposed on the isolated-world global
  // so loading.js (auto-show on page load and outgoing navigation) and
  // content.js (show on spotlight navigation) reuse one implementation.
  // Guarded so re-injection across content-script entries doesn't redefine it.
  if (window.__spotlightLoader) return;

  // At document_start the parser may not have created <html>/<body> yet, and a
  // node parented directly to <html> is a fragile place to live once the real
  // tree is built. Mount into <body> when we can, fall back to <html>, and
  // keep retrying until <body> exists.
  // setTimeout, not requestAnimationFrame: rAF never fires in a hidden tab, so
  // a page loading in the background would never get mounted.
  const MOUNT_RETRY_MS = 16;
  const MOUNT_MAX_TRIES = 300; // ~5s, then stop chasing <body>

  let hostEl = null;
  let mountScheduled = false;
  let mountTries = 0;

  function scheduleMount() {
    if (mountScheduled) return;
    if (mountTries++ >= MOUNT_MAX_TRIES) return;
    mountScheduled = true;
    setTimeout(() => {
      mountScheduled = false;
      mount();
    }, MOUNT_RETRY_MS);
  }

  function mount() {
    if (!hostEl) return; // hidden while we were waiting — stop the chain
    const parent = document.body || document.documentElement;
    if (!parent) {
      scheduleMount();
      return;
    }
    try {
      if (hostEl.parentNode !== parent) parent.appendChild(hostEl);
    } catch (e) {
      // Never let a failed mount kill the caller.
      return;
    }
    if (parent !== document.body) scheduleMount();
  }

  function show() {
    if (hostEl) return;
    mountTries = 0;
    hostEl = document.createElement("div");
    hostEl.style.all = "initial";
    hostEl.style.position = "fixed";
    hostEl.style.inset = "0";
    hostEl.style.zIndex = "2147483647";
    hostEl.style.pointerEvents = "none";
    hostEl.style.transition = "opacity 250ms ease";
    hostEl.style.opacity = "1";

    const shadow = hostEl.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host {
        --sp-backdrop: rgba(15, 17, 23, 0.55);
        --sp-accent: #3b82f6;
        --sp-accent-soft: rgba(59, 130, 246, 0.35);
        --sp-accent-fade: rgba(59, 130, 246, 0);
        --sp-accent-glow: rgba(59, 130, 246, 0.8);
      }
      @media (prefers-color-scheme: light) {
        :host {
          --sp-backdrop: rgba(255, 255, 255, 0.55);
          --sp-accent: #3478f6;
          --sp-accent-soft: rgba(52, 120, 246, 0.35);
          --sp-accent-fade: rgba(52, 120, 246, 0);
          --sp-accent-glow: rgba(52, 120, 246, 0.8);
        }
      }
      .backdrop {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--sp-backdrop);
        -webkit-backdrop-filter: blur(2px);
        backdrop-filter: blur(2px);
      }
      .loader {
        position: relative;
        width: 64px;
        height: 64px;
      }
      .ring {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 64px;
        height: 64px;
        border-radius: 50%;
        background: radial-gradient(circle, var(--sp-accent-soft) 0%, var(--sp-accent-fade) 70%);
        transform: scale(0.4);
        opacity: 0;
        animation: pulse 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
      }
      .ring:nth-child(2) { animation-delay: 0.4s; }
      .ring:nth-child(3) { animation-delay: 0.8s; }
      .dot {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: var(--sp-accent);
        box-shadow: 0 0 12px var(--sp-accent-glow);
        animation: breathe 1.6s ease-in-out infinite;
      }
      @keyframes pulse {
        0%   { transform: scale(0.4); opacity: 0.8; }
        100% { transform: scale(1.6); opacity: 0; }
      }
      @keyframes breathe {
        0%, 100% { transform: scale(0.85); opacity: 0.85; }
        50%      { transform: scale(1.1);  opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .ring, .dot { animation-duration: 3s; }
      }
    `;

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    const loader = document.createElement("div");
    loader.className = "loader";
    loader.innerHTML =
      '<div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="dot"></div>';
    backdrop.appendChild(loader);
    shadow.appendChild(style);
    shadow.appendChild(backdrop);

    mount();
  }

  function hide() {
    if (!hostEl) return;
    const el = hostEl;
    hostEl = null;
    try {
      el.style.opacity = "0";
    } catch (e) {
      // Detached or already torn down — the removal below still runs.
    }
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 280);
  }

  // BFCache restore can revive a page frozen with the overlay still in the
  // DOM (e.g. spotlight same-tab navigation, then Back) — clear it.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) hide();
  });

  window.__spotlightLoader = { show, hide, isShown: () => !!hostEl };
})();
