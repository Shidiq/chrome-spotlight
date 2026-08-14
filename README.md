# URL Spotlight

Chrome/Helium extension. One macOS-style Spotlight overlay for URL navigation, search-engine queries, open tabs, bookmarks, and history — all fuzzy-searchable and keyboard-driven.

## Install

1. Open `chrome://extensions/` (or `helium://extensions/`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select `url-spotlight/`
4. Set shortcut at `chrome://extensions/shortcuts` (default `Cmd+T`/`Ctrl+T` usually blocked by browser — pick e.g. `Cmd+Shift+P`)

## Use

- Press shortcut on any page (or `Cmd+Shift+O` / `Ctrl+Shift+O`, same overlay) → appears centered, listing open tabs first
- Type URL, domain, or search query — open tabs, bookmarks, and history are fuzzy-matched live
- `↑` / `↓` pick a result
- **`1`-`9`** jump straight to the numbered result (badges shown on each row) — no need to arrow down first
- **`Shift`+digit** types the literal number into the query instead of jumping (e.g. `web3`, `404`) — hold Shift while typing any digit
- `Alt`+digit (`⌥`+digit) also jumps to a numbered result, as a secondary binding
- `Enter` open/switch to selection; `Shift+Enter` open in the current tab instead of a new one
- Click a row to open/switch, `Shift+Click` to open in the current tab
- `Esc` or click outside to close

![URL Spotlight overlay](image.png)

## Restricted pages & new tab

- On pages content scripts can't reach (`chrome://`, Web Store, etc.) the shortcut opens the same overlay in a small popup window instead — same keys, same behavior
- The new-tab page shows the overlay directly, over the widgets below

## New tab widgets

Three columns over an animated aurora background, capped at 1440px and centered so rows don't stretch on a wide display. Each card sizes to its content and scrolls internally once it outgrows the column. Every widget can be switched off individually in the extension's options page.

- **Clock and Up next** — time and date top-left; the next upcoming calendar event with a live countdown top-right
- **Agenda** — one grouped list from Google Calendar covering today through the next 8 days, with `Today` always shown as the anchor even when it's empty. Connect one or more Google accounts and pick which calendars appear, per account, in the options page
- **Tasks** — open items from a Notion database, sorted by priority then due date, with overdue dates flagged. Click the checkbox to mark one Done in Notion. Needs a Notion integration token, pasted in the options page and stored on this device only
- **Tab groups** — open groups and recently closed ones, same data as the toolbar popup below; click to jump to a group or restore a closed one

Calendar and task data are cached, so the page paints immediately and refreshes in the background every 5 minutes. Tab groups re-read every time the tab becomes visible.

At narrower widths the layout drops to two columns (tab groups spans the bottom), then to one.

### Connecting Google accounts

The options page connects any number of Google accounts, each with its own calendar picks. Signing in uses `chrome.identity.launchWebAuthFlow`, so the account picker looks the same in every Chromium browser, and the account is identified by the verified email address on its token.

A personal account works with the built-in OAuth client. A work or school account usually does not: the built-in client's consent screen admits only its own test users, and a Workspace admin can block unverified apps outright. Give such an account its own client ID instead, from a Google Cloud project it can reach:

1. Enable the **Google Calendar API** on the project.
2. Create an OAuth client of type **Web application** — a Chrome Extension client will refuse the redirect URI.
3. Register the redirect URI shown at the top of the Google Calendar card as an authorized redirect URI.
4. Paste the client ID next to **Add account**.

The client ID is remembered per account and stays editable on the account's row, so a wrong one is fixed in place rather than by removing the account. **Remove** revokes the token at Google as well as deleting the local state, so re-adding shows the consent screen again.

When a connection fails, the message names the cause — `access_denied` (not a test user on that project), `admin_policy_enforced` (your Workspace admin blocks the app), `org_internal` (that client only admits its own organization), or a redirect URI that isn't registered.

## Tab groups popup

- Click the toolbar icon → popup lists every open tab group (color dot, name, tab count, window number when groups span multiple windows)
- Click or `Enter` on a group → un-collapses it, activates its first tab, focuses its window
- `↑` / `↓` move the selection, `1`-`9` jump straight to a group, `Esc` closes
- **Recently closed** section lists groups you closed while the extension was running (up to 10) — clicking one reopens its tabs back inside a group with the original name and color
- If a group with the same name and color is already open, restored tabs join it instead of creating a second group
- Chrome exposes no API for its own saved tab groups, so groups saved to the bookmarks bar are only reopenable from that chip — the list here covers groups the extension saw close

## Task View tab switcher

- Hold `Alt`/`Option` and tap `Tab` to cycle open tabs card-style; release the modifier to switch — configurable at `chrome://extensions` → extension options
- Distinct from the Spotlight overlay above; number shortcuts don't apply here

## Search engine

- Query text that isn't a URL or domain goes to a configurable search engine (DuckDuckGo by default) — change it in the extension's options page

## Navigation logic

- Starts with `http://` or `https://` → direct
- Looks like a domain (has a dot, no spaces) → prepend `https://`
- Otherwise → search engine query

## Notes

- Content scripts don't inject into browser-internal pages (`chrome://`, new-tab, etc.) — the popup fallback handles those
- Reload any tab opened before install for the content script to take effect
