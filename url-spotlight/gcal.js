// Shared Google Calendar auth + API client.
// Loaded by both newtab.html (widgets.js) and options.html (options.js), which
// are extension pages, so chrome.identity is available and host_permissions
// bypass CORS on googleapis.com.
//
// Everything is keyed by account id so several Google accounts can be connected
// at once. The id is the account's verified email address, read from the
// userinfo endpoint: deriving it from the calendar list instead made accounts
// whose list has no primary entry — some delegated Workspace accounts —
// impossible to add, and gave login_hint an address it could not rely on.
(() => {
  "use strict";

  // chrome.identity.getAuthToken is deliberately NOT used: it authorizes
  // whatever account the browser profile is signed into, which offers no
  // account picker and does not work in Brave. launchWebAuthFlow opens a
  // normal OAuth window instead, so it behaves the same in every browser.

  const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/calendar.readonly";
  const ACCOUNTS_KEY = "googleAccounts"; // sync:  [{ id, addedAt, clientId?, name? }]
  const TOKENS_KEY = "googleTokens"; // local: { [accountId]: { token, expiresAt } }
  const LIST_CACHE_KEY = "calendarListCache"; // local: { [accountId]: { fetchedAt, items } }
  const OVERRIDES_KEY = "calendarOverrides"; // sync:  { [accountId]: { [calendarId]: bool } }
  const LEGACY_TOKEN_KEY = "googleToken";
  const LEGACY_EMAIL_KEY = "googleAccountEmail";
  const API = "https://www.googleapis.com/calendar/v3";
  const USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo";
  const REVOKE = "https://oauth2.googleapis.com/revoke";

  // ------------------------------------------------------------------ storage

  const syncGet = (defaults) => new Promise((r) => chrome.storage.sync.get(defaults, r));
  const localGet = (defaults) => new Promise((r) => chrome.storage.local.get(defaults, r));
  const localSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
  const syncRemove = (keys) => new Promise((r) => chrome.storage.sync.remove(keys, r));
  const localRemove = (keys) => new Promise((r) => chrome.storage.local.remove(keys, r));

  // sync caps each item at ~8 KB, and many accounts × many calendars can reach
  // it. Failing silently would drop the user's picks with nothing to show why.
  function syncSet(obj) {
    return new Promise((resolve, reject) =>
      chrome.storage.sync.set(obj, () => {
        const err = chrome.runtime.lastError;
        if (err) reject({ status: 0, reason: "storage", message: err.message || "Couldn't save to Chrome sync." });
        else resolve();
      })
    );
  }

  // Every shared map lives under a single storage key, so changing one
  // account's entry is a read-modify-write. Both the new tab and the options
  // page fan out over accounts with Promise.all, so without serializing per key
  // two accounts refreshing at once would each write back a snapshot taken
  // before the other's change — silently losing a token or a calendar list.
  const writeChains = new Map();
  function withKey(key, fn) {
    const prev = writeChains.get(key) || Promise.resolve();
    const run = prev.then(fn);
    writeChains.set(
      key,
      run.catch(() => {})
    );
    return run;
  }

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

  function getRedirectUrl() {
    return chrome.identity.getRedirectURL();
  }

  function buildAuthUrl(interactive, { loginHint, prompt, clientId } = {}) {
    const params = new URLSearchParams({
      client_id: googleClientId(clientId),
      response_type: "token",
      redirect_uri: getRedirectUrl(),
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

  // Chrome runs one auth window at a time. The account fan-out would otherwise
  // start N silent flows at once, and the overlapping ones fail in a way
  // indistinguishable from a lapsed session — a spurious "Reconnect needed".
  let authTail = Promise.resolve();
  function serializeAuth(fn) {
    const run = authTail.then(fn);
    authTail = run.catch(() => {});
    return run;
  }

  // The implicit flow puts its result in the fragment, but some Google errors
  // come back as query params instead, so check both before calling it a win.
  function readAuthError(redirectUrl) {
    const u = new URL(redirectUrl);
    const frag = new URLSearchParams(u.hash.slice(1));
    const code = frag.get("error") || u.searchParams.get("error") || "";
    const description = frag.get("error_description") || u.searchParams.get("error_description") || "";
    return code ? { code, description } : null;
  }

  // Resolves { ok: true, token, expiresAt } or { ok: false, code, description }.
  // Never throws, and never discards the reason: every failure mode here —
  // a wrong client id, an org policy, a closed window — used to arrive at the
  // UI as the same bare "Couldn't connect".
  function launchAuth(interactive, opts) {
    return serializeAuth(
      () =>
        new Promise((resolve) => {
          const fail = (code, description) => resolve({ ok: false, code, description: description || "" });
          try {
            chrome.identity.launchWebAuthFlow({ url: buildAuthUrl(interactive, opts), interactive }, (redirectUrl) => {
              const lastError = chrome.runtime.lastError;
              if (!redirectUrl) {
                fail("", lastError && lastError.message);
                return;
              }
              const failed = readAuthError(redirectUrl);
              if (failed) {
                fail(failed.code, failed.description);
                return;
              }
              const frag = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
              const token = frag.get("access_token");
              if (!token) {
                fail("no_token", "");
                return;
              }
              const expiresIn = Number(frag.get("expires_in")) || 3600;
              resolve({ ok: true, token, expiresAt: Date.now() + (expiresIn - 60) * 1000 });
            });
          } catch (e) {
            fail("internal", (e && e.message) || String(e));
          }
        })
    );
  }

  // prompt=none is *expected* to fail this way once the browser's Google
  // session for the account lapses. That is not an error to show anyone — it
  // only means the next attempt has to be interactive.
  const SILENT_CODES = new Set(["interaction_required", "login_required", "consent_required", "account_selection_required"]);

  function describeAuthError(res) {
    const redirect = getRedirectUrl();
    const code = (res && res.code) || "";
    const desc = (res && res.description) || "";
    switch (code) {
      case "access_denied":
        return (
          "Access denied. Either you declined, or this account is not a test user on that client ID's " +
          "Google Cloud project — add it as a test user there, or give this account its own client ID."
        );
      case "admin_policy_enforced":
        return "Your Google Workspace admin blocks this app. Use a client ID from a Google Cloud project inside your own organization.";
      case "org_internal":
        return "That client ID only allows accounts in its own organization. Use one from this account's organization.";
      case "invalid_client":
      case "unauthorized_client":
        return "That client ID is wrong, or is not a “Web application” client. Recreate it as a Web application client.";
      case "redirect_uri_mismatch":
        return `Register ${redirect} as an authorized redirect URI on that client ID.`;
      case "no_token":
        return "Google returned no access token. Check the client ID.";
    }
    if (/did not approve/i.test(desc)) return "The sign-in window closed before you approved access.";
    // How redirect_uri_mismatch usually presents: Google renders its own error
    // page, so the flow never reaches the redirect and there is no error code.
    if (/page could not be loaded/i.test(desc)) {
      return `Google refused the request. Check the client ID is a “Web application” client with ${redirect} registered as an authorized redirect URI.`;
    }
    if (code && desc) return `${code}: ${desc}`;
    return code || desc || "Couldn't connect to Google.";
  }

  function authError(res) {
    return { status: 0, reason: "auth", code: (res && res.code) || "", message: describeAuthError(res) };
  }

  async function readTokens() {
    const r = await localGet({ [TOKENS_KEY]: {} });
    return r[TOKENS_KEY] || {};
  }

  function writeToken(accountId, entry) {
    return withKey(TOKENS_KEY, async () => {
      const tokens = await readTokens();
      tokens[accountId] = entry;
      await localSet({ [TOKENS_KEY]: tokens });
    });
  }

  async function clearToken(accountId) {
    await ready();
    await withKey(TOKENS_KEY, async () => {
      const tokens = await readTokens();
      delete tokens[accountId];
      await localSet({ [TOKENS_KEY]: tokens });
    });
  }

  // Two callers wanting the same account's token must share one flow, or the
  // second launchWebAuthFlow overlaps the first and both come back empty.
  const inFlight = new Map();

  function getGoogleToken(accountId, interactive) {
    const key = `${accountId}|${interactive ? "i" : "s"}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const run = acquireToken(accountId, interactive).finally(() => inFlight.delete(key));
    inFlight.set(key, run);
    return run;
  }

  async function acquireToken(accountId, interactive) {
    await ready();
    const tokens = await readTokens();
    const cached = tokens[accountId];
    if (cached && cached.token && cached.expiresAt > Date.now()) return cached.token;

    const account = (await listAccounts()).find((a) => a.id === accountId);
    const clientId = account && account.clientId;
    // The login hint is what makes prompt=none resolve to *this* account when
    // several are signed into the browser.
    let res = await launchAuth(false, { loginHint: accountId, clientId });
    if (!res.ok && interactive) res = await launchAuth(true, { loginHint: accountId, clientId });
    if (!res.ok) {
      // The background pass returns null and lets the caller render
      // "Reconnect": a lapsed session is normal there. Only a failed
      // interactive attempt — the user watching a window — has news to report.
      if (!interactive || SILENT_CODES.has(res.code)) return null;
      throw authError(res);
    }
    await writeToken(accountId, { token: res.token, expiresAt: res.expiresAt });
    return res.token;
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

  // Identity straight from the token, so it does not depend on what the
  // calendar list happens to contain.
  async function fetchUserInfo(tokenValue) {
    const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${tokenValue}` } });
    if (!res.ok) throw { status: res.status, reason: "userinfo" };
    const info = await res.json();
    return { email: info.email || "", sub: info.sub || "", name: info.name || "" };
  }

  // ----------------------------------------------------------------- accounts

  // Raw read, without awaiting the migration: callers inside withKey have
  // already awaited ready(), and re-entering it there would be circular.
  async function readAccounts() {
    const r = await syncGet({ [ACCOUNTS_KEY]: [] });
    return r[ACCOUNTS_KEY] || [];
  }

  async function listAccounts() {
    await ready();
    return readAccounts();
  }

  // Returns true if the account was already connected.
  function upsertAccount(id, { clientId, name }) {
    return withKey(ACCOUNTS_KEY, async () => {
      const accounts = await readAccounts();
      const existing = accounts.find((a) => a.id === id);
      const entry = existing || { id, addedAt: Date.now() };
      // Re-adding is also how you clear a client id you no longer need.
      if (clientId) entry.clientId = clientId;
      else delete entry.clientId;
      if (name) entry.name = name;
      if (!existing) accounts.push(entry);
      await syncSet({ [ACCOUNTS_KEY]: accounts });
      return !!existing;
    });
  }

  async function setAccountClientId(accountId, clientId) {
    await ready();
    await withKey(ACCOUNTS_KEY, async () => {
      const accounts = await readAccounts();
      const acct = accounts.find((a) => a.id === accountId);
      if (!acct) return;
      if (clientId) acct.clientId = clientId;
      else delete acct.clientId;
      await syncSet({ [ACCOUNTS_KEY]: accounts });
    });
    // A token minted by the old client is worthless against the new one.
    await clearToken(accountId);
  }

  // Always interactive with an account picker — this is the only path that can
  // introduce an account we don't have a token for yet.
  async function addAccount(clientId) {
    await ready();
    const res = await launchAuth(true, { prompt: "select_account", clientId });
    if (!res.ok) throw authError(res);

    const info = await fetchUserInfo(res.token);
    if (!info.email) throw { status: 0, reason: "no-email" };
    const id = info.email;

    // Keyed from the start, so a 401 here can still refresh itself.
    const items = await fetchCalendarItems(res.token, id);

    await writeToken(id, { token: res.token, expiresAt: res.expiresAt });
    await cacheList(id, items);
    const alreadyAdded = await upsertAccount(id, { clientId, name: info.name });
    return { id, name: info.name, items, alreadyAdded };
  }

  async function removeAccount(accountId) {
    await ready();

    // Best effort. Without this the grant survives at Google, so "Remove" only
    // forgets the account here — and re-adding it never shows a consent screen,
    // which hides whether a client id change actually took effect.
    const tokens = await readTokens();
    const entry = tokens[accountId];
    if (entry && entry.token) {
      try {
        await fetch(`${REVOKE}?token=${encodeURIComponent(entry.token)}`, { method: "POST" });
      } catch {}
    }

    await withKey(ACCOUNTS_KEY, async () => {
      const accounts = await readAccounts();
      await syncSet({ [ACCOUNTS_KEY]: accounts.filter((a) => a.id !== accountId) });
    });
    await withKey(TOKENS_KEY, async () => {
      const all = await readTokens();
      delete all[accountId];
      await localSet({ [TOKENS_KEY]: all });
    });
    await withKey(LIST_CACHE_KEY, async () => {
      const caches = await readListCaches();
      delete caches[accountId];
      await localSet({ [LIST_CACHE_KEY]: caches });
    });
    await withKey(OVERRIDES_KEY, async () => {
      const all = await loadAllOverrides();
      if (!(accountId in all)) return;
      delete all[accountId];
      await syncSet({ [OVERRIDES_KEY]: all });
    });
  }

  // ------------------------------------------------------------ calendar list

  async function loadAllOverrides() {
    const r = await syncGet({ [OVERRIDES_KEY]: {} });
    return r[OVERRIDES_KEY] || {};
  }

  async function loadOverrides(accountId) {
    await ready();
    const all = await loadAllOverrides();
    return all[accountId] || {};
  }

  async function setOverride(accountId, calendarId, selected) {
    await ready();
    await withKey(OVERRIDES_KEY, async () => {
      const all = await loadAllOverrides();
      if (!all[accountId]) all[accountId] = {};
      all[accountId][calendarId] = !!selected;
      await syncSet({ [OVERRIDES_KEY]: all });
    });
  }

  async function readListCaches() {
    const r = await localGet({ [LIST_CACHE_KEY]: {} });
    return r[LIST_CACHE_KEY] || {};
  }

  function cacheList(accountId, items) {
    return withKey(LIST_CACHE_KEY, async () => {
      const caches = await readListCaches();
      caches[accountId] = { fetchedAt: Date.now(), items };
      await localSet({ [LIST_CACHE_KEY]: caches });
    });
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
    // Housekeeping, so a failure here must not lose the caller the list it
    // just fetched successfully.
    await withKey(OVERRIDES_KEY, async () => {
      const all = await loadAllOverrides();
      const mine = all[accountId] || {};
      const live = new Set(items.map((c) => c.id));
      const stale = Object.keys(mine).filter((id) => !live.has(id));
      if (!stale.length) return;
      for (const id of stale) delete mine[id];
      all[accountId] = mine;
      await syncSet({ [OVERRIDES_KEY]: all });
    }).catch(() => {});

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
    getRedirectUrl,
    listAccounts,
    addAccount,
    removeAccount,
    setAccountClientId,
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
