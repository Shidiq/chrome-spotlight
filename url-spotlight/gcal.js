// Shared Google Calendar auth + API client.
// Loaded by both newtab.html (widgets.js) and options.html (options.js), which
// are extension pages, so chrome.identity is available and host_permissions
// bypass CORS on googleapis.com.
(() => {
  "use strict";

  // chrome.identity.getAuthToken is deliberately NOT used: it authorizes
  // whatever account the browser profile is signed into, which offers no
  // account picker and does not work in Brave. launchWebAuthFlow opens a
  // normal OAuth window instead, so it behaves the same in every browser.

  const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
  const GTOKEN_KEY = "googleToken";
  const LIST_CACHE_KEY = "calendarListCache";
  const OVERRIDES_KEY = "calendarOverrides";
  const API = "https://www.googleapis.com/calendar/v3";

  function googleClientId() {
    const m = chrome.runtime.getManifest();
    return (m.oauth2 && m.oauth2.client_id) || "";
  }

  function buildAuthUrl(interactive, loginHint) {
    const params = new URLSearchParams({
      client_id: googleClientId(),
      response_type: "token",
      redirect_uri: chrome.identity.getRedirectURL(),
      scope: GOOGLE_SCOPE,
      include_granted_scopes: "true",
    });
    // prompt=none makes the silent pass fail fast instead of hanging on a
    // hidden consent screen the user can never see.
    if (!interactive) params.set("prompt", "none");
    if (loginHint) params.set("login_hint", loginHint);
    return "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
  }

  function launchAuth(interactive, loginHint) {
    return new Promise((resolve) => {
      try {
        chrome.identity.launchWebAuthFlow(
          { url: buildAuthUrl(interactive, loginHint), interactive },
          (redirectUrl) => {
            void chrome.runtime.lastError;
            if (!redirectUrl) {
              resolve(null);
              return;
            }
            // Implicit flow returns the token in the URL fragment.
            const frag = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
            const token = frag.get("access_token");
            const expiresIn = Number(frag.get("expires_in")) || 3600;
            resolve(token ? { token, expiresAt: Date.now() + (expiresIn - 60) * 1000 } : null);
          }
        );
      } catch {
        resolve(null);
      }
    });
  }

  function readCachedToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [GTOKEN_KEY]: null }, (r) => resolve(r[GTOKEN_KEY]));
    });
  }

  function writeCachedToken(entry) {
    chrome.storage.local.set({ [GTOKEN_KEY]: entry });
  }

  function clearCachedToken() {
    return new Promise((resolve) => chrome.storage.local.remove(GTOKEN_KEY, resolve));
  }

  async function getGoogleToken(interactive, loginHint) {
    const cached = await readCachedToken();
    if (cached && cached.token && cached.expiresAt > Date.now()) return cached.token;

    let entry = await launchAuth(false, loginHint);
    if (!entry && interactive) entry = await launchAuth(true, loginHint);
    if (!entry) return null;
    writeCachedToken(entry);
    return entry.token;
  }

  async function gFetch(url, token) {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` } });
    if (res.status === 401) {
      await clearCachedToken();
      const fresh = await getGoogleToken(false, token.loginHint);
      if (!fresh) throw { status: 401 };
      token.value = fresh;
      res = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }
    if (!res.ok) throw { status: res.status };
    return res.json();
  }

  // ------------------------------------------------------------ calendar list

  function loadOverrides() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ [OVERRIDES_KEY]: {} }, (r) => resolve(r[OVERRIDES_KEY] || {}));
    });
  }

  function saveOverrides(overrides) {
    return new Promise((resolve) => chrome.storage.sync.set({ [OVERRIDES_KEY]: overrides }, resolve));
  }

  async function setOverride(id, selected) {
    const overrides = await loadOverrides();
    overrides[id] = !!selected;
    await saveOverrides(overrides);
  }

  function loadCachedList() {
    return new Promise((resolve) => {
      chrome.storage.local.get({ [LIST_CACHE_KEY]: null }, (r) => resolve((r[LIST_CACHE_KEY] || {}).items || []));
    });
  }

  // Overrides are stored sparsely on purpose: an id that is absent means "ask
  // Google", so a calendar the user creates or subscribes to shows up on its
  // own, matching its visibility there — until they tick or untick it here.
  function resolveSelected(items, overrides) {
    const picked = (items || []).filter((c) => (c.id in overrides ? overrides[c.id] : !!c.selected));
    // Fall back to the primary calendar only before the user has made any
    // choice — once they have, "nothing ticked" means nothing.
    if (picked.length || Object.keys(overrides || {}).length) return picked;
    return (items || []).filter((c) => c.primary);
  }

  async function fetchCalendarList(tokenValue, loginHint) {
    const token = { value: tokenValue, loginHint }; // boxed so gFetch can refresh it once
    const list = await gFetch(`${API}/users/me/calendarList`, token);
    const items = (list.items || []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      backgroundColor: c.backgroundColor || "",
      primary: !!c.primary,
      selected: !!c.selected,
      accessRole: c.accessRole || "",
    }));

    chrome.storage.local.set({ [LIST_CACHE_KEY]: { fetchedAt: Date.now(), items } });

    // Prune choices for calendars that are gone. Only ever runs after a
    // successful fetch, so a network blip can't wipe the user's selection.
    const overrides = await loadOverrides();
    const live = new Set(items.map((c) => c.id));
    const stale = Object.keys(overrides).filter((id) => !live.has(id));
    if (stale.length) {
      for (const id of stale) delete overrides[id];
      await saveOverrides(overrides);
    }

    return items;
  }

  async function fetchCalendarEvents(tokenValue, loginHint, calendars) {
    const token = { value: tokenValue, loginHint };

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 8 * 24 * 60 * 60 * 1000);
    const params =
      `timeMin=${encodeURIComponent(start.toISOString())}` +
      `&timeMax=${encodeURIComponent(end.toISOString())}` +
      `&singleEvents=true&orderBy=startTime&maxResults=50`;

    const results = await Promise.all(
      calendars.map((cal) =>
        gFetch(`${API}/calendars/${encodeURIComponent(cal.id)}/events?${params}`, token)
          .then((r) => ({ cal, items: r.items || [] }))
          .catch(() => null) // one broken calendar must not sink the rest
      )
    );

    const events = [];
    for (const r of results) {
      if (!r) continue;
      for (const ev of r.items) {
        if (ev.status === "cancelled" || !ev.start) continue;
        const allDay = !!ev.start.date;
        events.push({
          id: ev.id,
          title: ev.summary || "(untitled)",
          htmlLink: ev.htmlLink || "",
          allDay,
          // all-day dates parsed as local midnight, not UTC
          start: allDay ? `${ev.start.date}T00:00:00` : ev.start.dateTime,
          end: allDay ? `${ev.end && ev.end.date ? ev.end.date : ev.start.date}T00:00:00` : (ev.end && ev.end.dateTime) || ev.start.dateTime,
          color: r.cal.backgroundColor || "",
        });
      }
    }
    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    return events;
  }

  self.SpGCal = {
    OVERRIDES_KEY,
    LIST_CACHE_KEY,
    getGoogleToken,
    clearCachedToken,
    loadOverrides,
    setOverride,
    loadCachedList,
    resolveSelected,
    fetchCalendarList,
    fetchCalendarEvents,
  };
})();
