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
  activeShortcut = {
    alt: e.altKey,
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    meta: e.metaKey,
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
  };
  stopRecording();
  chrome.storage.sync.set({ taskViewShortcut: activeShortcut }, showSaved);
}

function stopRecording() {
  window.removeEventListener("keydown", recordShortcut, true);
  taskViewShortcutBtn.classList.remove("recording");
  renderShortcutLabel(activeShortcut);
}

taskViewShortcutBtn.addEventListener("click", () => {
  taskViewShortcutBtn.classList.add("recording");
  taskViewShortcutBtn.textContent = "Press keys…";
  // Capture on window so this fires before content.js's document-level Task
  // View listener; stopPropagation then keeps the overlay from opening while
  // recording.
  window.addEventListener("keydown", recordShortcut, true);
});

taskViewShortcutReset.addEventListener("click", () => {
  activeShortcut = DEFAULT_TASKVIEW_SHORTCUT;
  renderShortcutLabel(activeShortcut);
  chrome.storage.sync.set({ taskViewShortcut: activeShortcut }, showSaved);
});

// --- Google Calendar picker ---

const calAccountEl = document.getElementById("calAccount");
const calConnectBtn = document.getElementById("calConnect");
const calRefreshBtn = document.getElementById("calRefresh");
const calListEl = document.getElementById("calList");
const calStatus = document.getElementById("calStatus");

let calStatusTimer = null;
function showCalSaved(text) {
  calStatus.textContent = text || "Saved";
  calStatus.classList.add("show");
  clearTimeout(calStatusTimer);
  calStatusTimer = setTimeout(() => calStatus.classList.remove("show"), 1500);
}

let calItems = [];
let calOverrides = {};
let calConnected = false;
let calChecked = false; // has a silent token check finished yet
let calLoginHint = "";

function renderCalList() {
  calListEl.textContent = "";
  if (!calItems.length) {
    const empty = document.createElement("div");
    empty.className = "cal-empty";
    empty.textContent = calConnected
      ? "No calendars on this account."
      : "Connect to pick which calendars appear on the new tab.";
    calListEl.appendChild(empty);
    return;
  }

  const selected = new Set(SpGCal.resolveSelected(calItems, calOverrides).map((c) => c.id));

  for (const cal of calItems) {
    const row = document.createElement("label");
    row.className = "cal-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = selected.has(cal.id);

    const dot = document.createElement("span");
    dot.className = "cal-dot";
    if (cal.backgroundColor) dot.style.background = cal.backgroundColor;

    const name = document.createElement("span");
    name.className = "cal-name";
    name.textContent = cal.summary;
    name.title = cal.id;

    row.append(check, dot, name);
    if (cal.primary) {
      const badge = document.createElement("span");
      badge.className = "cal-badge";
      badge.textContent = "primary";
      row.appendChild(badge);
    }

    check.addEventListener("change", async () => {
      calOverrides[cal.id] = check.checked;
      await SpGCal.setOverride(cal.id, check.checked);
      showCalSaved();
    });

    calListEl.appendChild(row);
  }
}

function renderCalConnection() {
  const primary = calItems.find((c) => c.primary);
  if (!calChecked) {
    calAccountEl.textContent = "Checking…";
  } else if (calConnected) {
    calAccountEl.textContent = primary ? `Connected as ${primary.id}` : "Connected";
  } else {
    calAccountEl.textContent = "Not connected";
  }
  calConnectBtn.textContent = calConnected ? "Reconnect" : "Connect";
  calRefreshBtn.hidden = !calConnected;
}

async function loadCalendars(interactive) {
  calRefreshBtn.disabled = true;
  calConnectBtn.disabled = true;
  try {
    const token = await SpGCal.getGoogleToken(interactive, calLoginHint);
    calConnected = !!token;
    calChecked = true;
    if (!token) {
      if (interactive) showCalSaved("Couldn't connect");
      renderCalConnection();
      renderCalList();
      return;
    }
    calItems = await SpGCal.fetchCalendarList(token, calLoginHint);
    calOverrides = await SpGCal.loadOverrides(); // fetch prunes calendars that are gone
    renderCalConnection();
    renderCalList();
  } catch (e) {
    if (e && e.status === 401) {
      await SpGCal.clearCachedToken();
      calConnected = false;
    }
    showCalSaved("Couldn't load calendars");
    renderCalConnection();
    renderCalList();
  } finally {
    calRefreshBtn.disabled = false;
    calConnectBtn.disabled = false;
  }
}

calConnectBtn.addEventListener("click", () => loadCalendars(true));
calRefreshBtn.addEventListener("click", () => loadCalendars(false));

// Paint the cached list first, then revalidate silently.
(async () => {
  calOverrides = await SpGCal.loadOverrides();
  calItems = await SpGCal.loadCachedList();
  renderCalConnection();
  renderCalList();
  chrome.storage.sync.get({ googleAccountEmail: "" }, (r) => {
    calLoginHint = r.googleAccountEmail;
    loadCalendars(false);
  });
})();

// --- New Tab Widgets ---

const WIDGET_SYNC_DEFAULTS = {
  widgetClock: true,
  widgetCalendar: true,
  widgetTasks: true,
  notionDatabaseId: "77c516e8-c36c-4226-9d1f-0d682c5e97f5",
  notionDataSourceId: "7ae3b9f2-031c-4587-98a1-8feae61eba98",
  googleAccountEmail: "",
};

const widgetStatus = document.getElementById("widgetStatus");
let widgetStatusTimer = null;
function showWidgetSaved() {
  widgetStatus.classList.add("show");
  clearTimeout(widgetStatusTimer);
  widgetStatusTimer = setTimeout(() => widgetStatus.classList.remove("show"), 1500);
}

const widgetToggles = ["widgetClock", "widgetCalendar", "widgetTasks"].map((id) => document.getElementById(id));
const notionTokenInput = document.getElementById("notionToken");
const widgetTextInputs = ["googleAccountEmail", "notionDatabaseId", "notionDataSourceId"].map((id) =>
  document.getElementById(id)
);

chrome.storage.sync.get(WIDGET_SYNC_DEFAULTS, (r) => {
  for (const t of widgetToggles) t.checked = r[t.id];
  for (const i of widgetTextInputs) i.value = r[i.id];
});
// The Notion token is a secret: chrome.storage.local only, never sync-replicated.
chrome.storage.local.get({ notionToken: "" }, (r) => {
  notionTokenInput.value = r.notionToken;
});

for (const t of widgetToggles) {
  t.addEventListener("change", () => {
    chrome.storage.sync.set({ [t.id]: t.checked }, showWidgetSaved);
  });
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

for (const i of widgetTextInputs) {
  i.addEventListener(
    "input",
    debounce(() => chrome.storage.sync.set({ [i.id]: i.value.trim() }, showWidgetSaved), 300)
  );
}

notionTokenInput.addEventListener(
  "input",
  debounce(() => chrome.storage.local.set({ notionToken: notionTokenInput.value.trim() }, showWidgetSaved), 300)
);

// Keep the calendar card's login hint in step with the email field above it.
document.getElementById("googleAccountEmail").addEventListener("input", () => {
  calLoginHint = document.getElementById("googleAccountEmail").value.trim();
});
