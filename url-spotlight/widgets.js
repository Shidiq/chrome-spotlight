// New-tab widgets: clock, Google Calendar (today + week), Notion tasks.
// Runs only on newtab.html (extension page), so cross-origin fetches bypass
// CORS via host_permissions and chrome.identity is available.
(() => {
  "use strict";

  // ---------------------------------------------------------------- config

  const SYNC_DEFAULTS = {
    widgetClock: true,
    widgetCalendar: true,
    widgetTasks: true,
    notionDatabaseId: "77c516e8-c36c-4226-9d1f-0d682c5e97f5",
    notionDataSourceId: "7ae3b9f2-031c-4587-98a1-8feae61eba98",
  };
  // Connected accounts and their calendar picks live in gcal.js, which reads
  // them per account; they are watched here only to re-render on change.
  const GCAL_SYNC_KEYS = ["googleAccounts", "calendarOverrides"];
  const CACHE_KEY = "widgetsCache";
  const TOKEN_KEY = "notionToken";
  const REFRESH_MS = 5 * 60 * 1000;

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(SYNC_DEFAULTS, (sync) => {
        chrome.storage.local.get({ [TOKEN_KEY]: "" }, (local) => {
          resolve({ ...sync, notionToken: local[TOKEN_KEY] });
        });
      });
    });
  }

  function loadCache() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [CACHE_KEY]: null }, (r) => resolve(r[CACHE_KEY] || {}));
    });
  }

  let cache = {};
  function saveCache(patch) {
    cache = { ...cache, ...patch };
    chrome.storage.local.set({ [CACHE_KEY]: cache });
  }

  // ----------------------------------------------------------------- clock

  let clockTimer = null;
  function startClock(root) {
    clearInterval(clockTimer);
    const wrap = el("div", "sp-clock");
    const time = el("div", "sp-clock-time");
    const date = el("div", "sp-clock-date");
    wrap.append(time, date);
    root.appendChild(wrap);

    const fmtTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    const fmtDate = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const tick = () => {
      const now = new Date();
      time.textContent = fmtTime.format(now);
      date.textContent = fmtDate.format(now);
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  // ------------------------------------------------------- calendar client

  // Auth and the Calendar API live in gcal.js, shared with the options page.
  const gcal = self.SpGCal;

  function dayKey(d) {
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function splitEvents(events) {
    const now = new Date();
    const todayKey = dayKey(now);
    const today = [];
    const week = [];
    for (const ev of events) {
      const start = new Date(ev.start);
      const end = new Date(ev.end);
      if (dayKey(start) === todayKey || (start < now && end > now)) {
        // today's card: hide timed events that already ended
        if (ev.allDay || end > now) today.push(ev);
      } else if (start > now) {
        week.push(ev);
      }
    }
    return { today, week };
  }

  // --------------------------------------------------------- notion client

  const NOTION = "https://api.notion.com/v1";

  async function nFetch(path, { method = "GET", body, token }) {
    const res = await fetch(NOTION + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2025-09-03",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let err = {};
      try { err = await res.json(); } catch {}
      throw { status: res.status, code: err.code, message: err.message };
    }
    return res.json();
  }

  const ACTIVE_STATUSES = ["Not started", "On Scheduled", "In progress"];
  const PRIO_ORDER = { Tinggi: 0, Sedang: 1, Rendah: 2 };

  function plain(richArr) {
    return (richArr || []).map((t) => t.plain_text || "").join("");
  }

  async function fetchTasks(cfg) {
    const data = await nFetch(`/data_sources/${cfg.notionDataSourceId}/query`, {
      method: "POST",
      token: cfg.notionToken,
      body: {
        filter: {
          or: ACTIVE_STATUSES.map((name) => ({ property: "Status", status: { equals: name } })),
        },
        sorts: [{ property: "Due Date", direction: "ascending" }],
        page_size: 50,
      },
    });
    const tasks = (data.results || []).map((page) => {
      const p = page.properties || {};
      return {
        id: page.id,
        url: page.url || "",
        title: plain(p["Nama Task"] && p["Nama Task"].title) || "(untitled)",
        status: (p["Status"] && p["Status"].status && p["Status"].status.name) || "",
        due: (p["Due Date"] && p["Due Date"].date && p["Due Date"].date.start) || null,
        priority: (p["Prioritas"] && p["Prioritas"].select && p["Prioritas"].select.name) || null,
        tags: ((p["Tags"] && p["Tags"].multi_select) || []).map((t) => t.name),
        note: plain(p["Catatan"] && p["Catatan"].rich_text),
      };
    });
    // Notion API can't sort a select by option order — do priority here
    tasks.sort((a, b) => {
      const pa = a.priority in PRIO_ORDER ? PRIO_ORDER[a.priority] : 3;
      const pb = b.priority in PRIO_ORDER ? PRIO_ORDER[b.priority] : 3;
      if (pa !== pb) return pa - pb;
      if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
      return a.due ? -1 : b.due ? 1 : 0;
    });
    return tasks;
  }

  function completeTask(pageId, token) {
    return nFetch(`/pages/${pageId}`, {
      method: "PATCH",
      token,
      body: { properties: { Status: { status: { name: "Done" } } } },
    });
  }

  // ------------------------------------------------------------- renderers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function card(title, grow) {
    const c = el("section", "sp-card" + (grow ? " sp-grow" : ""));
    const head = el("div", "sp-card-title");
    head.appendChild(el("span", "", title));
    const note = el("span", "sp-card-note");
    head.appendChild(note);
    const body = el("div", "sp-card-body");
    c.append(head, body);
    return { root: c, body, note };
  }

  function setNote(cardRef, text) {
    cardRef.note.textContent = text || "";
  }

  const fmtEventTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

  function eventRow(ev) {
    const row = el("a", "sp-row");
    row.href = ev.htmlLink || "#";
    row.target = "_blank";
    row.rel = "noopener";
    const time = el("span", "sp-event-time", ev.allDay ? "All day" : fmtEventTime.format(new Date(ev.start)));
    const dot = el("span", "sp-event-dot");
    if (ev.color) dot.style.background = ev.color;
    const title = el("span", "sp-event-title", ev.title);
    row.append(time, dot, title);
    return row;
  }

  function renderEventList(body, events, { grouped, emptyText }) {
    body.textContent = "";
    if (!events.length) {
      body.appendChild(el("div", "sp-empty", emptyText));
      return;
    }
    if (!grouped) {
      for (const ev of events) body.appendChild(eventRow(ev));
      return;
    }
    let lastKey = "";
    for (const ev of events) {
      const d = new Date(ev.start);
      const key = dayKey(d);
      if (key !== lastKey) {
        lastKey = key;
        body.appendChild(el("div", "sp-day-header", fmtWeekday.format(d)));
      }
      body.appendChild(eventRow(ev));
    }
  }

  function renderConnectButton(body, onConnect) {
    body.textContent = "";
    body.appendChild(el("div", "sp-hint", "See your Google Calendar events here."));
    const btn = el("button", "sp-btn", "Connect Google Calendar");
    btn.addEventListener("click", onConnect);
    body.appendChild(btn);
  }

  const fmtDue = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

  function taskRow(task, cfg, onRemoved) {
    const row = el("div", "sp-row sp-task");

    const check = el("button", "sp-check");
    check.setAttribute("role", "checkbox");
    check.setAttribute("aria-checked", "false");
    check.title = "Mark done";

    const main = el("div", "sp-task-main");
    const title = el("a", "sp-task-title", task.title);
    title.href = task.url || "#";
    title.target = "_blank";
    title.rel = "noopener";
    main.appendChild(title);
    if (task.note) main.appendChild(el("div", "sp-task-note", task.note));

    const meta = el("div", "sp-task-meta");
    if (task.priority) {
      const dot = el("span", "sp-prio-dot " + task.priority.toLowerCase());
      dot.title = task.priority;
      meta.appendChild(dot);
    }
    if (task.due) {
      const dueDate = new Date(task.due);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const chip = el("span", "sp-chip", fmtDue.format(dueDate));
      if (dueDate < today) chip.classList.add("overdue");
      meta.appendChild(chip);
    }
    if (task.status === "In progress") meta.appendChild(el("span", "sp-chip", "In progress"));
    for (const tag of task.tags) meta.appendChild(el("span", "sp-chip", tag));
    if (meta.childNodes.length) main.appendChild(meta);

    row.append(check, main);

    check.addEventListener("click", async () => {
      if (row.classList.contains("done")) return;
      row.classList.add("done");
      check.setAttribute("aria-checked", "true");
      try {
        await completeTask(task.id, cfg.notionToken);
        setTimeout(() => {
          row.remove();
          onRemoved(task);
        }, 400);
      } catch {
        row.classList.remove("done");
        check.setAttribute("aria-checked", "false");
        const fail = el("span", "sp-fail", "Failed — try again");
        meta.appendChild(fail);
        setTimeout(() => fail.remove(), 3000);
      }
    });

    return row;
  }

  function renderTasks(cardRef, tasks, cfg) {
    const body = cardRef.body;
    body.textContent = "";
    if (!tasks.length) {
      body.appendChild(el("div", "sp-empty", "No open tasks — nice."));
      return;
    }
    const removeFromState = (task) => {
      const items = (cache.tasks && cache.tasks.items) || [];
      saveCache({ tasks: { ...cache.tasks, items: items.filter((t) => t.id !== task.id) } });
      if (!body.querySelector(".sp-task")) renderTasks(cardRef, [], cfg);
    };
    for (const t of tasks) body.appendChild(taskRow(t, cfg, removeFromState));
  }

  function renderTasksUnconfigured(body) {
    body.textContent = "";
    body.appendChild(
      el("div", "sp-hint", "Connect Notion to see your Task Tracker here. Paste your integration token in settings.")
    );
    const btn = el("button", "sp-btn", "Open settings");
    btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
    body.appendChild(btn);
  }

  // -------------------------------------------------------------- scheduler

  let cfg = null;
  let root = null;
  let todayCard = null;
  let weekCard = null;
  let tasksCard = null;
  let lastFetch = { calendar: 0, tasks: 0 };

  function renderShell() {
    root.textContent = "";
    if (cfg.widgetClock) startClock(root);

    const left = el("div", "sp-col");
    const right = el("div", "sp-col");
    todayCard = weekCard = tasksCard = null;

    if (cfg.widgetCalendar) {
      todayCard = card("Today");
      weekCard = card("This week", true);
      left.append(todayCard.root, weekCard.root);
      todayCard.body.appendChild(el("div", "sp-empty", "Loading…"));
    }
    if (cfg.widgetTasks) {
      tasksCard = card("Tasks", true);
      right.appendChild(tasksCard.root);
      tasksCard.body.appendChild(el("div", "sp-empty", "Loading…"));
    }
    if (left.childNodes.length) root.appendChild(left);
    if (right.childNodes.length) root.appendChild(right);
  }

  function renderCalendarData(events) {
    if (!todayCard) return;
    const { today, week } = splitEvents(events);
    renderEventList(todayCard.body, today, { grouped: false, emptyText: "No events today" });
    renderEventList(weekCard.body, week, { grouped: true, emptyText: "Nothing coming up this week" });
  }

  // Re-listing the calendars on every refresh is the whole sync mechanism: a
  // calendar created or subscribed to in Google turns up within one cycle.
  async function resolveCalendars(accountId, token) {
    let items;
    try {
      items = await gcal.fetchCalendarList(accountId, token);
    } catch (e) {
      if (e && e.status === 401) throw e;
      items = await gcal.loadCachedList(accountId);
      if (!items.length) throw e;
    }
    return gcal.resolveSelected(items, await gcal.loadOverrides(accountId));
  }

  // `auth` separates "this account needs reconnecting" from "the network is
  // down", which want different notes.
  async function fetchAccountEvents(accountId) {
    try {
      const token = await gcal.getGoogleToken(accountId, false);
      if (!token) return { accountId, failed: true, auth: true };
      const calendars = await resolveCalendars(accountId, token);
      return { accountId, events: await gcal.fetchCalendarEvents(accountId, token, calendars) };
    } catch (e) {
      return { accountId, failed: true, auth: !!(e && e.status === 401) };
    }
  }

  // A calendar shared with two connected accounts returns the same event once
  // per account; keep the first copy so it shows up as a single row.
  function mergeEvents(perAccount) {
    const seen = new Set();
    const events = [];
    for (const r of perAccount) {
      for (const ev of r.events || []) {
        const key = `${ev.id}|${ev.start}`;
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(ev);
      }
    }
    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    return events;
  }

  async function refreshCalendar() {
    if (!todayCard) return;
    // Connecting needs Google's account picker, which belongs on the settings
    // page next to the per-account calendar lists.
    const openSettings = () => chrome.runtime.openOptionsPage();

    const accounts = await gcal.listAccounts();
    if (!accounts.length) {
      renderConnectButton(todayCard.body, openSettings);
      renderConnectButton(weekCard.body, openSettings);
      return;
    }

    // One account failing must not cost the others their events.
    const results = await Promise.all(accounts.map((a) => fetchAccountEvents(a.id)));
    const failed = results.filter((r) => r.failed);

    if (failed.length === results.length) {
      const note = failed.every((r) => r.auth) ? "Reconnect needed" : "Couldn't refresh";
      const cached = cache.calendar && cache.calendar.events;
      if (cached && cached.length) {
        setNote(todayCard, note);
        renderCalendarData(cached);
      } else if (failed.every((r) => r.auth)) {
        renderConnectButton(todayCard.body, openSettings);
        renderConnectButton(weekCard.body, openSettings);
      } else {
        todayCard.body.textContent = "";
        todayCard.body.appendChild(el("div", "sp-empty", "Couldn't load events"));
        weekCard.body.textContent = "";
      }
      return;
    }

    const events = mergeEvents(results);
    lastFetch.calendar = Date.now();
    saveCache({ calendar: { fetchedAt: lastFetch.calendar, events } });
    setNote(todayCard, failed.length ? `Reconnect ${failed.map((r) => r.accountId).join(", ")}` : "");
    setNote(weekCard, "");
    renderCalendarData(events);
  }

  async function refreshTasks() {
    if (!tasksCard) return;
    if (!cfg.notionToken) {
      renderTasksUnconfigured(tasksCard.body);
      return;
    }
    try {
      const items = await fetchTasks(cfg);
      lastFetch.tasks = Date.now();
      saveCache({ tasks: { fetchedAt: lastFetch.tasks, items } });
      setNote(tasksCard, "");
      renderTasks(tasksCard, items, cfg);
    } catch (e) {
      const status = e && e.status;
      if (status === 401) {
        tasksCard.body.textContent = "";
        tasksCard.body.appendChild(el("div", "sp-hint", "Notion token invalid — check settings."));
        const btn = el("button", "sp-btn", "Open settings");
        btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
        tasksCard.body.appendChild(btn);
      } else if (status === 404) {
        tasksCard.body.textContent = "";
        tasksCard.body.appendChild(
          el("div", "sp-hint", "Notion can't find the database. In Notion, open Task Tracker → ••• → Connections → add your integration.")
        );
      } else if (cache.tasks && cache.tasks.items) {
        setNote(tasksCard, "Couldn't refresh");
        renderTasks(tasksCard, cache.tasks.items, cfg);
      } else {
        tasksCard.body.textContent = "";
        tasksCard.body.appendChild(el("div", "sp-empty", "Couldn't load tasks"));
      }
    }
  }

  function refreshAll() {
    refreshCalendar();
    refreshTasks();
  }

  async function init() {
    root = document.getElementById("sp-widgets");
    if (!root) return;
    cfg = await loadConfig();
    cache = await loadCache();
    renderShell();

    // stale-while-revalidate: paint cached data immediately
    if (todayCard && cache.calendar && cache.calendar.events) renderCalendarData(cache.calendar.events);
    if (tasksCard && cache.tasks && cache.tasks.items && cfg.notionToken) renderTasks(tasksCard, cache.tasks.items, cfg);

    refreshAll();
    setInterval(refreshAll, REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const stale = Math.min(lastFetch.calendar, lastFetch.tasks) < Date.now() - REFRESH_MS;
      if (stale) refreshAll();
    });

    chrome.storage.onChanged.addListener(async (changes, area) => {
      const keys = Object.keys(changes);
      const relevant =
        (area === "sync" && keys.some((k) => k in SYNC_DEFAULTS || GCAL_SYNC_KEYS.includes(k))) ||
        (area === "local" && keys.includes(TOKEN_KEY));
      if (!relevant) return;
      cfg = await loadConfig();
      renderShell();
      refreshAll();
    });
  }

  init();
})();
