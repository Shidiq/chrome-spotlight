const SEARCH_ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  brave: { name: "Brave", url: "https://search.brave.com/search?q=" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" }
};
const DEFAULT_ENGINE = "duckduckgo";
const DEFAULT_TASKVIEW_SHORTCUT = { alt: true, ctrl: false, shift: false, meta: false, key: "Tab" };

const select = document.getElementById("engine");
const loadingAnim = document.getElementById("loadingAnim");
const status = document.getElementById("status");
const taskViewShortcutBtn = document.getElementById("taskViewShortcutBtn");
const taskViewShortcutReset = document.getElementById("taskViewShortcutReset");

let statusTimer = null;
function showSaved() {
  status.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => status.classList.remove("show"), 1500);
}

for (const [key, { name }] of Object.entries(SEARCH_ENGINES)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = name;
  select.appendChild(opt);
}

let activeShortcut = DEFAULT_TASKVIEW_SHORTCUT;

chrome.storage.sync.get(
  { searchEngine: DEFAULT_ENGINE, loadingAnimation: true, taskViewShortcut: DEFAULT_TASKVIEW_SHORTCUT },
  (r) => {
    select.value = SEARCH_ENGINES[r.searchEngine] ? r.searchEngine : DEFAULT_ENGINE;
    loadingAnim.checked = r.loadingAnimation;
    activeShortcut = r.taskViewShortcut;
    renderShortcutLabel(activeShortcut);
  }
);

select.addEventListener("change", () => {
  chrome.storage.sync.set({ searchEngine: select.value }, showSaved);
});

loadingAnim.addEventListener("change", () => {
  chrome.storage.sync.set({ loadingAnimation: loadingAnim.checked }, showSaved);
});

// --- Task View shortcut recorder ---

const KEY_LABELS = { Tab: "Tab", Escape: "Esc", " ": "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

function keyLabel(key) {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  return key.length === 1 ? key.toUpperCase() : key;
}

function formatShortcut(cfg) {
  let label = "";
  if (cfg.ctrl) label += "⌃";
  if (cfg.alt) label += "⌥";
  if (cfg.shift) label += "⇧";
  if (cfg.meta) label += "⌘";
  return (label ? label + " " : "") + keyLabel(cfg.key);
}

function renderShortcutLabel(cfg) {
  taskViewShortcutBtn.textContent = formatShortcut(cfg);
}

function recordShortcut(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.key === "Escape") {
    stopRecording();
    return;
  }
  if (["Alt", "Control", "Shift", "Meta"].includes(e.key)) return; // wait for a non-modifier key
  if (!e.altKey && !e.ctrlKey && !e.metaKey) {
    taskViewShortcutBtn.textContent = "Need a modifier key…";
    return;
  }
  if (e.shiftKey) {
    taskViewShortcutBtn.textContent = "Shift is reserved for reverse — try without Shift";
    return;
  }
  activeShortcut = {
    alt: e.altKey,
    ctrl: e.ctrlKey,
    shift: false,
    meta: e.metaKey,
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
  };
  stopRecording();
  chrome.storage.sync.set({ taskViewShortcut: activeShortcut }, showSaved);
}

function stopRecording() {
  document.removeEventListener("keydown", recordShortcut, true);
  taskViewShortcutBtn.classList.remove("recording");
  renderShortcutLabel(activeShortcut);
}

taskViewShortcutBtn.addEventListener("click", () => {
  taskViewShortcutBtn.classList.add("recording");
  taskViewShortcutBtn.textContent = "Press keys…";
  document.addEventListener("keydown", recordShortcut, true);
});

taskViewShortcutReset.addEventListener("click", () => {
  activeShortcut = DEFAULT_TASKVIEW_SHORTCUT;
  renderShortcutLabel(activeShortcut);
  chrome.storage.sync.set({ taskViewShortcut: activeShortcut }, showSaved);
});
