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

const calAccountsEl = document.getElementById("calAccounts");
const calAddBtn = document.getElementById("calAdd");
const calClientIdInput = document.getElementById("calClientId");
const calStatus = document.getElementById("calStatus");

let calStatusTimer = null;
function showCalSaved(text) {
  calStatus.textContent = text || "Saved";
  calStatus.classList.add("show");
  clearTimeout(calStatusTimer);
  calStatusTimer = setTimeout(() => calStatus.classList.remove("show"), 1500);
}

// One entry per connected account: { id, items, overrides, connected, checked, busy }.
// Nothing is shared between accounts — each has its own list and its own picks.
let accounts = [];

function calListFor(acct) {
  const listEl = document.createElement("div");
  listEl.className = "cal-list";

  if (!acct.items.length) {
    const empty = document.createElement("div");
    empty.className = "cal-empty";
    empty.textContent = acct.connected ? "No calendars on this account." : "Reconnect to load calendars.";
    listEl.appendChild(empty);
    return listEl;
  }

  const selected = new Set(SpGCal.resolveSelected(acct.items, acct.overrides).map((c) => c.id));

  for (const cal of acct.items) {
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
      acct.overrides[cal.id] = check.checked;
      await SpGCal.setOverride(acct.id, cal.id, check.checked);
      showCalSaved();
    });

    listEl.appendChild(row);
  }
  return listEl;
}

function accountBlock(acct) {
  const wrap = document.createElement("div");
  wrap.className = "cal-account";

  const row = document.createElement("div");
  row.className = "conn-row";

  const name = document.createElement("span");
  name.className = "conn-account";
  name.textContent = acct.id;
  if (!acct.checked) name.textContent += " · checking…";
  else if (!acct.connected) name.textContent += " · reconnect needed";

  const actions = document.createElement("span");
  actions.className = "conn-actions";

  if (acct.clientId) {
    const badge = document.createElement("span");
    badge.className = "cal-client";
    badge.textContent = "own client ID";
    badge.title = acct.clientId;
    actions.appendChild(badge);
  }

  const reload = document.createElement("button");
  reload.type = "button";
  reload.className = "btn";
  reload.textContent = acct.connected ? "Refresh" : "Reconnect";
  reload.disabled = acct.busy;
  reload.addEventListener("click", () => loadAccount(acct, !acct.connected));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn";
  remove.textContent = "Remove";
  remove.disabled = acct.busy;
  remove.addEventListener("click", async () => {
    if (!confirm(`Remove ${acct.id}? Its calendar choices are discarded.`)) return;
    await SpGCal.removeAccount(acct.id);
    accounts = accounts.filter((a) => a.id !== acct.id);
    renderAccounts();
    showCalSaved("Removed");
  });

  actions.append(reload, remove);
  row.append(name, actions);
  wrap.append(row, calListFor(acct));
  return wrap;
}

function renderAccounts() {
  calAccountsEl.textContent = "";
  if (!accounts.length) {
    const empty = document.createElement("div");
    empty.className = "cal-empty";
    empty.textContent = "No account connected. Add one to pick which calendars appear on the new tab.";
    calAccountsEl.appendChild(empty);
    return;
  }
  for (const acct of accounts) calAccountsEl.appendChild(accountBlock(acct));
}

async function loadAccount(acct, interactive) {
  acct.busy = true;
  renderAccounts();
  try {
    const token = await SpGCal.getGoogleToken(acct.id, interactive);
    acct.connected = !!token;
    if (!token) {
      if (interactive) showCalSaved("Couldn't connect");
      return;
    }
    acct.items = await SpGCal.fetchCalendarList(acct.id, token);
    acct.overrides = await SpGCal.loadOverrides(acct.id); // fetch prunes calendars that are gone
  } catch (e) {
    if (e && e.status === 401) {
      await SpGCal.clearToken(acct.id);
      acct.connected = false;
    }
    showCalSaved("Couldn't load calendars");
  } finally {
    acct.busy = false;
    acct.checked = true;
    renderAccounts();
  }
}

calAddBtn.addEventListener("click", async () => {
  calAddBtn.disabled = true;
  const clientId = calClientIdInput.value.trim();
  try {
    const added = await SpGCal.addAccount(clientId);
    if (!added) {
      showCalSaved("Couldn't connect");
      return;
    }
    let acct = accounts.find((a) => a.id === added.id);
    if (!acct) {
      acct = { id: added.id, items: [], overrides: {}, connected: false, checked: false, busy: false };
      accounts.push(acct);
    }
    acct.clientId = clientId;
    acct.items = added.items;
    calClientIdInput.value = "";
    acct.overrides = await SpGCal.loadOverrides(added.id);
    acct.connected = true;
    acct.checked = true;
    renderAccounts();
    showCalSaved(added.alreadyAdded ? "Already connected" : "Added");
  } catch (e) {
    showCalSaved(e && e.reason === "no-primary" ? "Couldn't identify that account" : "Couldn't connect");
  } finally {
    calAddBtn.disabled = false;
  }
});

// Paint every account's cached list first, then revalidate them all silently.
(async () => {
  const stored = await SpGCal.listAccounts();
  accounts = await Promise.all(
    stored.map(async (a) => ({
      id: a.id,
      clientId: a.clientId || "",
      items: await SpGCal.loadCachedList(a.id),
      overrides: await SpGCal.loadOverrides(a.id),
      connected: false,
      checked: false,
      busy: false,
    }))
  );
  renderAccounts();
  await Promise.all(accounts.map((a) => loadAccount(a, false)));
})();

// --- New Tab Widgets ---

const WIDGET_SYNC_DEFAULTS = {
  widgetClock: true,
  widgetCalendar: true,
  widgetTasks: true,
  widgetTabGroups: true,
  notionDatabaseId: "77c516e8-c36c-4226-9d1f-0d682c5e97f5",
  notionDataSourceId: "7ae3b9f2-031c-4587-98a1-8feae61eba98",
};

const widgetStatus = document.getElementById("widgetStatus");
let widgetStatusTimer = null;
function showWidgetSaved() {
  widgetStatus.classList.add("show");
  clearTimeout(widgetStatusTimer);
  widgetStatusTimer = setTimeout(() => widgetStatus.classList.remove("show"), 1500);
}

const widgetToggles = ["widgetClock", "widgetCalendar", "widgetTasks", "widgetTabGroups"].map((id) =>
  document.getElementById(id)
);
const notionTokenInput = document.getElementById("notionToken");
const widgetTextInputs = ["notionDatabaseId", "notionDataSourceId"].map((id) => document.getElementById(id));

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
