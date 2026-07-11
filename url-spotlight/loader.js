(() => {
  // Shared radial-pulse loading overlay. Exposed on the isolated-world global
  // so both loading.js (auto-show on page load) and content.js (show on
  // spotlight navigation) reuse one implementation. Guarded so re-injection
  // across content-script entries doesn't redefine it.
  if (window.__spotlightLoader) return;

  let hostEl = null;

  function show() {
    if (hostEl) return;
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
      :host { --sp-backdrop: rgba(15, 17, 23, 0.55); }
      @media (prefers-color-scheme: light) {
        :host { --sp-backdrop: rgba(255, 255, 255, 0.55); }
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
        background: radial-gradient(circle, rgba(91,140,255,0.35) 0%, rgba(91,140,255,0) 70%);
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
        background: #5b8cff;
        box-shadow: 0 0 12px rgba(91, 140, 255, 0.8);
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

    (document.documentElement || document.body).appendChild(hostEl);
  }

  function hide() {
    if (!hostEl) return;
    const el = hostEl;
    hostEl = null;
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 280);
  }

  // BFCache restore can revive a page frozen with the overlay still in the
  // DOM (e.g. spotlight same-tab navigation, then Back) — clear it.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) hide();
  });

  window.__spotlightLoader = { show, hide, isShown: () => !!hostEl };
})();
