// Shared Google Calendar auth + API client.
// Loaded by both newtab.html (widgets.js) and options.html (options.js), which
// are extension pages, so chrome.identity is available and host_permissions
// bypass CORS on googleapis.com.
//
// Everything is keyed by account id so several Google accounts can be connected
// at once. The id is the account's primary calendar id, which for Google is the
// address itself — reading it costs one calendarList call we already make, and
// avoids widening the scope to `openid email` just to learn who signed in.
(() => {
  "use strict";

  // chrome.identity.getAuthToken is deliberately NOT used: it authorizes
  // whatever account the browser profile is signed into, which offers no
  // account picker and does not work in Brave. launchWebAuthFlow opens a
  // normal OAuth window instead, so it behaves the same in every browser.

  const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
  const ACCOUNTS_KEY = "googleAccounts"; // sync:  [{ id, addedAt }]
  const TOKENS_KEY = "googleTokens"; // local: { [accountId]: { token, expiresAt } }
  const LIST_CACHE_KEY = "calendarListCache"; // local: { [accountId]: { fetchedAt, items } }
  const OVERRIDES_KEY = "calendarOverrides"; // sync:  { [accountId]: { [calendarId]: bool } }
  const LEGACY_TOKEN_KEY = "googleToken";
  const LEGACY_EMAIL_KEY = "googleAccountEmail";
  const API = "https://www.googleapis.com/calendar/v3";

  // ------------------------------------------------------------------ storage

  const syncGet = (defaults) => new Promise((r) => chrome.storage.sync.get(defaults, r));
  const syncSet = (obj) => new Promise((r) => chrome.storage.sync.set(obj, r));
  const syncRemove = (keys) => new Promise((r) => chrome.storage.sync.remove(keys, r));
  const localGet = (defaults) => new Promise((r) => chrome.storage.local.get(defaults, r));
  const localSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
  const localRemove = (keys) => new Promise((r) => chrome.storage.local.remove(keys, r));

  // ---------------------------------------------------------------- migration

  // v1.3 and earlier stored one token, one flat override map and one cached
  // list. Rekey all three under the account they belonged to, so upgrading
  // keeps the connection and the ticked calendars instead of asking for both
  // again. Runs at most once; every exported call awaits it first.
  let migration = null;
  function ready() {
    if (!migration) migration = migrateLegacy().catch(() => {});
    return migration;
  }

  // Nested maps hold objects, the old flat one held booleans.
  function isFlatOverrides(overrides) {
    return !!overrides && Object.values(overrides).some((v) => typeof v === "boolean");
  }

  async function migrateLegacy() {
    const sync = await syncGet({
      [ACCOUNTS_KEY]: [],
      [OVERRIDES_KEY]: {},
      [LEGACY_EMAIL_KEY]: "",
    });
    if ((sync[ACCOUNTS_KEY] || []).length) return;

    const local = await localGet({ [LEGACY_TOKEN_KEY]: null, [LIST_CACHE_KEY]: null });
    const legacyToken = local[LEGACY_TOKEN_KEY];
    const legacyCache = local[LIST_CACHE_KEY];
    const legacyItems = legacyCache && Array.isArray(legacyCache.items) ? legacyCache.items : null;
    const flatOverrides = isFlatOverrides(sync[OVERRIDES_KEY]) ? sync[OVERRIDES_KEY] : null;
    if (!legacyToken && !legacyItems && !flatOverrides) return;

    const primary = legacyItems && legacyItems.find((c) => c.primary);
    const id = (primary && primary.id) || sync[LEGACY_EMAIL_KEY] || "";

    if (!id) {
      // Nothing identifies the old account, so there is no key to file it
      // under. Drop the leftovers rather than guess; the user reconnects once.
      await localRemove([LEGACY_TOKEN_KEY, LIST_CACHE_KEY]);
      await syncRemove([LEGACY_EMAIL_KEY]);
      if (flatOverrides) await syncSet({ [OVERRIDES_KEY]: {} });
      return;
    }

    const localPatch = {};
    if (legacyToken) localPatch[TOKENS_KEY] = { [id]: legacyToken };
    if (legacyItems) localPatch[LIST_CACHE_KEY] = { [id]: { fetchedAt: legacyCache.fetchedAt || 0, items: legacyItems } };
    if (Object.keys(localPatch).length) await localSet(localPatch);

    const syncPatch = { [ACCOUNTS_KEY]: [{ id, addedAt: Date.now() }] };
    if (flatOverrides) syncPatch[OVERRIDES_KEY] = { [id]: flatOverrides };
    await syncSet(syncPatch);

    await localRemove([LEGACY_TOKEN_KEY]);
    await syncRemove([LEGACY_EMAIL_KEY]);
  }

  // --------------------------------------------------------------------- auth

  // Accounts may carry their own client id: a Workspace project with an
  // Internal consent screen only authorizes its own domain, so a work account
  // can't share the personal account's client and vice versa. Absent means the
  // manifest's default client.
  function googleClientId(clientId) {
    if (clientId) return clientId;
    const m = chrome.runtime.getManifest();
    return (m.oauth2 && m.oauth2.client_id) || "";
  }

  function buildAuthUrl(interactive, { loginHint, prompt, clientId } = {}) {
    const params = new URLSearchParams({
      client_id: googleClientId(clientId),
      response_type: "token",
      redirect_uri: chrome.identity.getRedirectURL(),
      scope: GOOGLE_SCOPE,
      include_granted_scopes: "true",
    });
    // prompt=none makes the silent pass fail fast instead of hanging on a
    // hidden consent screen the user can never see. Interactively, the caller
    // passes prompt=select_account to add an account: without it Google reuses
    // the live session and the picker never appears.
    if (!interactive) params.set("prompt", "none");
    else if (prompt) params.set("prompt", prompt);
    if (loginHint) params.set("login_hint", loginHint);
    return "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
  }

  function launchAuth(interactive, opts) {
    return new Promise((resolve) => {
      try {
        chrome.identity.launchWebAuthFlow(
          { url: buildAuthUrl(interactive, opts), interactive },
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

  async function readTokens() {
    const r = await localGet({ [TOKENS_KEY]: {} });
    return r[TOKENS_KEY] || {};
  }

  async function writeToken(accountId, entry) {
    const tokens = await readTokens();
    tokens[accountId] = entry;
    await localSet({ [TOKENS_KEY]: tokens });
  }

  async function clearToken(accountId) {
    await ready();
    const tokens = await readTokens();
    delete tokens[accountId];
    await localSet({ [TOKENS_KEY]: tokens });
  }

  async function getGoogleToken(accountId, interactive) {
    await ready();
    const tokens = await readTokens();
    const cached = tokens[accountId];
    if (cached && cached.token && cached.expiresAt > Date.now()) return cached.token;

    const account = (await listAccounts()).find((a) => a.id === accountId);
    const clientId = account && account.clientId;
    // The login hint is what makes prompt=none resolve to *this* account when
    // several are signed into the browser.
    let entry = await launchAuth(false, { loginHint: accountId, clientId });
    if (!entry && interactive) entry = await launchAuth(true, { loginHint: accountId, clientId });
    if (!entry) return null;
    await writeToken(accountId, entry);
    return entry.token;
  }

  async function gFetch(url, token) {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token.value}` } });
    if (res.status === 401) {
      // No account id yet during addAccount(): there is nothing to refresh.
      if (!token.accountId) throw { status: 401 };
      await clearToken(token.accountId);
      const fresh = await getGoogleToken(token.accountId, false);
      if (!fresh) throw { status: 401 };
      token.value = fresh;
      res = await fetch(url, { headers: { Authorization: `Bearer ${fresh}` } });
    }
    if (!res.ok) throw { status: res.status };
    return res.json();
  }

  // ----------------------------------------------------------------- accounts

  async function listAccounts() {
    await ready();
    const r = await syncGet({ [ACCOUNTS_KEY]: [] });
    return r[ACCOUNTS_KEY] || [];
  }

  function saveAccounts(accounts) {
    return syncSet({ [ACCOUNTS_KEY]: accounts });
  }

  // Always interactive with an account picker — this is the only path that can
  // introduce an account we don't have a token for yet.
  async function addAccount(clientId) {
    await ready();
    const entry = await launchAuth(true, { prompt: "select_account", clientId });
    if (!entry) return null;

    // The id isn't known until the list comes back, so this first call runs
    // unkeyed and cannot self-refresh on 401.
    const items = await fetchCalendarItems(entry.token, null);
    const primary = items.find((c) => c.primary);
    if (!primary) throw { status: 0, reason: "no-primary" };
    const id = primary.id;

    await writeToken(id, entry);
    await cacheList(id, items);

    const accounts = await listAccounts();
    const existing = accounts.find((a) => a.id === id);
    if (existing) {
      // Re-adding is how you correct a wrong client id.
      if (clientId) existing.clientId = clientId;
      else delete existing.clientId;
    } else {
      accounts.push(clientId ? { id, addedAt: Date.now(), clientId } : { id, addedAt: Date.now() });
    }
    await saveAccounts(accounts);
    return { id, items, alreadyAdded: !!existing };
  }

  async function removeAccount(accountId) {
    await ready();
    const accounts = await listAccounts();
    await saveAccounts(accounts.filter((a) => a.id !== accountId));

    const tokens = await readTokens();
    delete tokens[accountId];
    const caches = await readListCaches();
    delete caches[accountId];
    await localSet({ [TOKENS_KEY]: tokens, [LIST_CACHE_KEY]: caches });

    const all = await loadAllOverrides();
    if (accountId in all) {
      delete all[accountId];
      await saveAllOverrides(all);
    }
  }

  // ------------------------------------------------------------ calendar list

  async function loadAllOverrides() {
    const r = await syncGet({ [OVERRIDES_KEY]: {} });
    return r[OVERRIDES_KEY] || {};
  }

  function saveAllOverrides(all) {
    return syncSet({ [OVERRIDES_KEY]: all });
  }

  async function loadOverrides(accountId) {
    await ready();
    const all = await loadAllOverrides();
    return all[accountId] || {};
  }

  async function setOverride(accountId, calendarId, selected) {
    await ready();
    const all = await loadAllOverrides();
    if (!all[accountId]) all[accountId] = {};
    all[accountId][calendarId] = !!selected;
    await saveAllOverrides(all);
  }

  async function readListCaches() {
    const r = await localGet({ [LIST_CACHE_KEY]: {} });
    return r[LIST_CACHE_KEY] || {};
  }

  async function cacheList(accountId, items) {
    const caches = await readListCaches();
    caches[accountId] = { fetchedAt: Date.now(), items };
    await localSet({ [LIST_CACHE_KEY]: caches });
  }

  async function loadCachedList(accountId) {
    await ready();
    const caches = await readListCaches();
    return (caches[accountId] || {}).items || [];
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

  async function fetchCalendarItems(tokenValue, accountId) {
    const token = { value: tokenValue, accountId }; // boxed so gFetch can refresh it once
    const list = await gFetch(`${API}/users/me/calendarList`, token);
    return (list.items || []).map((c) => ({
      id: c.id,
      summary: c.summaryOverride || c.summary || c.id,
      backgroundColor: c.backgroundColor || "",
      primary: !!c.primary,
      selected: !!c.selected,
      accessRole: c.accessRole || "",
    }));
  }

  async function fetchCalendarList(accountId, tokenValue) {
    await ready();
    const items = await fetchCalendarItems(tokenValue, accountId);
    await cacheList(accountId, items);

    // Prune choices for calendars that are gone, within this account only —
    // another account's ids are not "stale" just because they're absent here.
    // Only ever runs after a successful fetch, so a network blip can't wipe
    // the user's selection.
    const all = await loadAllOverrides();
    const mine = all[accountId] || {};
    const live = new Set(items.map((c) => c.id));
    const stale = Object.keys(mine).filter((id) => !live.has(id));
    if (stale.length) {
      for (const id of stale) delete mine[id];
      all[accountId] = mine;
      await saveAllOverrides(all);
    }

    return items;
  }

  async function fetchCalendarEvents(accountId, tokenValue, calendars) {
    await ready();
    const token = { value: tokenValue, accountId };

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
          accountId,
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
    ACCOUNTS_KEY,
    OVERRIDES_KEY,
    LIST_CACHE_KEY,
    listAccounts,
    addAccount,
    removeAccount,
    getGoogleToken,
    clearToken,
    loadOverrides,
    setOverride,
    loadCachedList,
    resolveSelected,
    fetchCalendarList,
    fetchCalendarEvents,
  };
})();
