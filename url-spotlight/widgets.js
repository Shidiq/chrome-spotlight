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

  // ------------------------------------------------------ clock and up next

  const fmtClockTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtClockDate = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // One timer drives both the clock and the "in 2h 15m" countdown, so the
  // countdown stays live between the 5-minute calendar refreshes.
  let clockTimer = null;
  const tickers = [];

  function runTickers() {
    const now = new Date();
    for (const fn of tickers) fn(now);
  }

  function startTicker() {
    clearInterval(clockTimer);
    runTickers();
    clockTimer = setInterval(runTickers, 1000);
  }

  function buildClock(head) {
    const wrap = el("div", "sp-clock");
    const time = el("div", "sp-clock-time");
    const date = el("div", "sp-clock-date");
    wrap.append(time, date);
    head.appendChild(wrap);
    tickers.push((now) => {
      time.textContent = fmtClockTime.format(now);
      date.textContent = fmtClockDate.format(now);
    });
  }

  const fmtNextTime = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const fmtNextDay = new Intl.DateTimeFormat(undefined, { weekday: "long" });

  function dayOffset(from, to) {
    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
    return Math.round((b - a) / 86400000);
  }

  // "Tomorrow 08:00 · in 19h" — the day part is absolute so it stays readable
  // for far-off events, the countdown is relative so near ones feel urgent.
  function describeWhen(ev, now) {
    const start = new Date(ev.start);
    const days = dayOffset(now, start);
    const when = days === 0 ? "Today" : days === 1 ? "Tomorrow" : fmtNextDay.format(start);
    const at = ev.allDay ? "all day" : fmtNextTime.format(start);
    if (ev.allDay) return `${when}, ${at}`;

    const mins = Math.round((start - now) / 60000);
    if (mins <= 0) return `${when} ${at} · now`;
    let left;
    if (mins < 60) left = `in ${mins}m`;
    else if (mins < 24 * 60) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      left = m ? `in ${h}h ${m}m` : `in ${h}h`;
    } else left = `in ${Math.round(mins / (24 * 60))}d`;
    return `${when} ${at} · ${left}`;
  }

  function buildNext(head) {
    const wrap = el("div", "sp-next");
    wrap.appendChild(el("div", "sp-next-label", "Up next"));
    const title = el("div", "sp-next-title");
    const when = el("div", "sp-next-when");
    wrap.append(title, when);
    wrap.style.display = "none";
    head.appendChild(wrap);
    tickers.push((now) => {
      const ev = nextEvent;
      if (!ev) {
        wrap.style.display = "none";
        return;
      }
      wrap.style.display = "";
      title.textContent = ev.title;
      when.textContent = describeWhen(ev, now);
    });
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
      // A real Error, so a failed fetch (TypeError, no .status) and an API
      // error stay distinguishable to callers and readable in the console.
      const e = new Error(err.message || `Notion ${res.status}`);
      e.status = res.status;
      e.code = err.code;
      throw e;
    }
    return res.json();
  }

  // Notion's API can't filter by status *group*, so exclude the two options in
  // the Complete group instead of listing the active ones. That survives
  // renames of the to-do/in-progress options and picks up "Waiting for".
  const DONE_STATUSES = ["Done", "Decluter"];
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
          and: DONE_STATUSES.map((name) => ({ property: "Status", status: { does_not_equal: name } })),
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

  function dayHeader(d, todayKey) {
    const isToday = dayKey(d) === todayKey;
    return el("div", "sp-day-header" + (isToday ? " sp-today" : ""), isToday ? "Today" : fmtWeekday.format(d));
  }

  // One list, grouped by day. Today always gets a header even with no events
  // so the agenda keeps its "you are here" anchor.
  function renderAgenda(body, events, todayCount) {
    body.textContent = "";
    const now = new Date();
    const todayKey = dayKey(now);

    if (!events.length) {
      body.appendChild(dayHeader(now, todayKey));
      body.appendChild(el("div", "sp-empty", "Nothing scheduled this week"));
      return;
    }
    // No events today: emit the header up front and pre-seed lastKey so the
    // loop doesn't emit a second one.
    let lastKey = "";
    if (!todayCount) {
      body.appendChild(dayHeader(now, todayKey));
      body.appendChild(el("div", "sp-empty", "No events"));
      lastKey = todayKey;
    }
    for (const ev of events) {
      const d = new Date(ev.start);
      const key = dayKey(d);
      if (key !== lastKey) {
        lastKey = key;
        body.appendChild(dayHeader(d, todayKey));
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
      } catch (e) {
        console.error("[widgets] Notion completeTask failed", e);
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
  let agendaCard = null;
  let tasksCard = null;
  let nextEvent = null;
  let lastFetch = { calendar: 0, tasks: 0 };

  function renderShell() {
    root.textContent = "";
    tickers.length = 0;
    agendaCard = tasksCard = null;
    nextEvent = null;

    const head = el("div", "sp-head");
    if (cfg.widgetClock) buildClock(head);
    if (cfg.widgetCalendar) buildNext(head);
    if (head.childNodes.length) {
      root.appendChild(head);
      startTicker();
    } else {
      clearInterval(clockTimer);
    }
    // Without a header row the columns would land in the auto-sized first
    // track and grow past the viewport instead of scrolling internally.
    root.dataset.head = head.childNodes.length ? "1" : "0";

    const cols = [];
    if (cfg.widgetCalendar) {
      agendaCard = card("Agenda", true);
      agendaCard.body.appendChild(el("div", "sp-empty", "Loading…"));
      cols.push(["sp-col-agenda", agendaCard.root]);
    }
    if (cfg.widgetTasks) {
      tasksCard = card("Tasks", true);
      tasksCard.body.appendChild(el("div", "sp-empty", "Loading…"));
      cols.push(["sp-col-tasks", tasksCard.root]);
    }
    for (const [cls, node] of cols) {
      const col = el("div", "sp-col " + cls);
      col.appendChild(node);
      root.appendChild(col);
    }
    // Columns are auto-placed; the CSS needs the count to size the tracks.
    root.dataset.cols = String(cols.length);
  }

  function renderCalendarData(events) {
    if (!agendaCard) return;
    const { today, week } = splitEvents(events);
    const all = today.concat(week);
    nextEvent = all.find((ev) => !ev.allDay && new Date(ev.start) > new Date()) || all[0] || null;
    renderAgenda(agendaCard.body, all, today.length);
    setNote(agendaCard, `${today.length} today · ${week.length} this week`);
    runTickers(); // paint "Up next" now instead of waiting for the next second
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
    if (!agendaCard) return;
    // Connecting needs Google's account picker, which belongs on the settings
    // page next to the per-account calendar lists.
    const openSettings = () => chrome.runtime.openOptionsPage();

    const accounts = await gcal.listAccounts();
    if (!accounts.length) {
      renderConnectButton(agendaCard.body, openSettings);
      return;
    }

    // One account failing must not cost the others their events.
    const results = await Promise.all(accounts.map((a) => fetchAccountEvents(a.id)));
    const failed = results.filter((r) => r.failed);

    if (failed.length === results.length) {
      const note = failed.every((r) => r.auth) ? "Reconnect needed" : "Couldn't refresh";
      const cached = cache.calendar && cache.calendar.events;
      if (cached && cached.length) {
        // after renderCalendarData, which sets its own count note
        renderCalendarData(cached);
        setNote(agendaCard, note);
      } else if (failed.every((r) => r.auth)) {
        renderConnectButton(agendaCard.body, openSettings);
      } else {
        agendaCard.body.textContent = "";
        agendaCard.body.appendChild(el("div", "sp-empty", "Couldn't load events"));
      }
      return;
    }

    const events = mergeEvents(results);
    lastFetch.calendar = Date.now();
    saveCache({ calendar: { fetchedAt: lastFetch.calendar, events } });
    renderCalendarData(events);
    if (failed.length) setNote(agendaCard, `Reconnect ${failed.map((r) => r.accountId).join(", ")}`);
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
      console.error("[widgets] Notion tasks failed", e);
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
      } else if (status === 429) {
        tasksCard.body.textContent = "";
        tasksCard.body.appendChild(el("div", "sp-hint", "Notion is rate-limiting — retrying shortly."));
      } else if (cache.tasks && cache.tasks.items) {
        setNote(tasksCard, "Couldn't refresh");
        renderTasks(tasksCard, cache.tasks.items, cfg);
      } else if (!status) {
        // fetch() itself rejected: offline, or host_permissions withheld
        // ("Site access: on click"), which kills the extension CORS bypass.
        tasksCard.body.textContent = "";
        tasksCard.body.appendChild(
          el("div", "sp-hint", "Can't reach Notion — check your connection and the extension's site access.")
        );
      } else {
        tasksCard.body.textContent = "";
        const why = `${status} ${(e && e.message) || ""}`.trim();
        tasksCard.body.appendChild(el("div", "sp-empty", `Couldn't load tasks — ${why}`));
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
    if (agendaCard && cache.calendar && cache.calendar.events) renderCalendarData(cache.calendar.events);
    if (tasksCard && cache.tasks && cache.tasks.items && cfg.notionToken) renderTasks(tasksCard, cache.tasks.items, cfg);

    refreshAll();
    setInterval(refreshAll, REFRESH_MS);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      const stale = Math.min(lastFetch.calendar, lastFetch.tasks) < Date.now() - REFRESH_MS;
      if (stale) {
        refreshCalendar();
        refreshTasks();
      }
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
