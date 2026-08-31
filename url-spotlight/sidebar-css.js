// The sidebar stylesheet, as a string rather than a linked file, so the group
// dot colors can be generated from the same table tabgroups.js uses.
(() => {
  "use strict";
  if (self.SpSidebarCSS) return;

  // Group dot colors become CSS variables generated from the same table
  // tabgroups.js uses, so a theme switch repaints them with no JS involved.
  function groupVars(scheme) {
    const colors = (self.SpTabGroups && self.SpTabGroups.COLORS) || {};
    return Object.keys(colors)
      .map((name) => `    --sp-g-${name}: ${colors[name][scheme]};`)
      .join("\n");
  }

  function build() {
    return `
  :root {
    --sp-sb-bg: rgba(28, 30, 38, 0.98);
    --sp-sb-bg-solid: #1c1e26;
    --sp-text: #ffffff;
    --sp-text-secondary: #e0e0e0;
    --sp-muted: rgba(235, 235, 245, 0.6);
    --sp-placeholder: rgba(235, 235, 245, 0.35);
    --sp-border: rgba(255, 255, 255, 0.1);
    --sp-hover: rgba(255, 255, 255, 0.07);
    --sp-active: rgba(255, 255, 255, 0.14);
    --sp-accent: #3b82f6;
    --sp-on-accent: #ffffff;
    --sp-field-bg: rgba(255, 255, 255, 0.07);
    --sp-danger: #f87171;
    --sp-panel-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 0 0 0.5px rgba(255, 255, 255, 0.12);
${groupVars("dark")}
  }
  @media (prefers-color-scheme: light) {
    :root {
      --sp-sb-bg: rgba(246, 246, 248, 0.98);
      --sp-sb-bg-solid: #f6f6f8;
      --sp-text: #1d1d1f;
      --sp-text-secondary: #1d1d1f;
      --sp-muted: #6e6e73;
      --sp-placeholder: #9a9aa0;
      --sp-border: rgba(0, 0, 0, 0.08);
      --sp-hover: rgba(0, 0, 0, 0.05);
      --sp-active: rgba(0, 0, 0, 0.1);
      --sp-accent: #3478f6;
      --sp-field-bg: rgba(0, 0, 0, 0.05);
      --sp-danger: #dc2626;
      --sp-panel-shadow: 0 24px 70px rgba(0, 0, 0, 0.2), 0 0 0 0.5px rgba(0, 0, 0, 0.1);
${groupVars("light")}
    }
  }

  .sp-sb, .sp-sb * { box-sizing: border-box; }

  .sp-sb {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--sp-sb-bg);
    backdrop-filter: blur(24px) saturate(1.4);
    color: var(--sp-text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.35;
    overflow: hidden;
  }
  /* --- top bar --- */
  .sp-sb-top {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 10px 8px;
  }
  .sp-sb-search {
    flex: 1 1 auto;
    min-width: 0;
    height: 30px;
    padding: 0 10px;
    border: none;
    border-radius: 8px;
    background: var(--sp-field-bg);
    color: var(--sp-text);
    font: inherit;
    outline: none;
  }
  .sp-sb-search::placeholder { color: var(--sp-placeholder); }
  .sp-sb-search:focus { box-shadow: 0 0 0 2px var(--sp-accent); }

  .sp-sb-iconbtn {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--sp-muted);
    cursor: pointer;
  }
  .sp-sb-iconbtn:hover { background: var(--sp-hover); color: var(--sp-text); }
  .sp-sb-iconbtn svg { display: block; }

  /* --- scroll area --- */
  .sp-sb-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 0 6px 10px;
    scrollbar-width: thin;
  }
  .sp-sb-scroll::-webkit-scrollbar { width: 8px; }
  .sp-sb-scroll::-webkit-scrollbar-thumb {
    background: var(--sp-border);
    border-radius: 4px;
  }

  /* --- sections --- */
  .sp-sb-sec { margin-top: 8px; }
  .sp-sb-sec-head {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 6px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--sp-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;
  }
  .sp-sb-sec-head:hover { background: var(--sp-hover); color: var(--sp-text); }
  .sp-sb-sec-head .chev {
    flex: 0 0 auto;
    transition: transform 0.12s ease;
  }
  .sp-sb-sec.collapsed .sp-sb-sec-head .chev { transform: rotate(-90deg); }
  .sp-sb-sec-head .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-sb-sec-head .count { flex: 0 0 auto; opacity: 0.75; }
  .sp-sb-sec.collapsed .sp-sb-sec-body { display: none; }

  /* --- group heading inside the groups section --- */
  .sp-sb-group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--sp-text);
    font: inherit;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .sp-sb-group-head:hover { background: var(--sp-hover); }
  .sp-sb-group-head .chev { flex: 0 0 auto; transition: transform 0.12s ease; color: var(--sp-muted); }
  .sp-sb-group.collapsed .sp-sb-group-head .chev { transform: rotate(-90deg); }
  .sp-sb-group.collapsed .sp-sb-group-body { display: none; }
  .sp-sb-group-head .title {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-sb-group-head .title.untitled { color: var(--sp-muted); font-style: italic; }
  .sp-sb-group-head .count {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--sp-muted);
  }
  .sp-sb-group-body { padding-left: 10px; }

  .sp-sb-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--sp-g-grey);
  }
${Object.keys((self.SpTabGroups && self.SpTabGroups.COLORS) || {})
  .map((n) => `  .sp-sb-dot.g-${n} { background: var(--sp-g-${n}); }`)
  .join("\n")}

  /* --- rows --- */
  .sp-sb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--sp-text);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .sp-sb-row:hover { background: var(--sp-hover); }
  .sp-sb-row.selected { background: var(--sp-hover); box-shadow: inset 0 0 0 1px var(--sp-border); }
  .sp-sb-row.active { background: var(--sp-active); font-weight: 500; }
  .sp-sb-row .fav {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    object-fit: contain;
  }
  .sp-sb-row .glyph {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    color: var(--sp-muted);
  }
  .sp-sb-row .label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sp-sb-row.discarded .label { opacity: 0.55; }
  .sp-sb-row .audio { flex: 0 0 auto; color: var(--sp-muted); }

  .sp-sb-acts {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 2px;
    opacity: 0;
  }
  .sp-sb-row:hover .sp-sb-acts,
  .sp-sb-row.selected .sp-sb-acts,
  .sp-sb-row.active .sp-sb-acts { opacity: 1; }
  .sp-sb-act {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--sp-muted);
    cursor: pointer;
  }
  .sp-sb-act:hover { background: var(--sp-active); color: var(--sp-text); }
  .sp-sb-act.pinned { opacity: 1; color: var(--sp-accent); }
  .sp-sb-row:has(.sp-sb-act.pinned) .sp-sb-acts { opacity: 1; }

  .sp-sb-empty {
    padding: 8px 10px;
    color: var(--sp-muted);
    font-size: 12px;
  }

  /* --- footer --- */
  .sp-sb-foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 0.5px solid var(--sp-border);
    color: var(--sp-muted);
    font-size: 11px;
  }
  .sp-sb-foot .spacer { flex: 1 1 auto; }
`;
  }

  self.SpSidebarCSS = { build };
})();
