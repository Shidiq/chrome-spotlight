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
- The new-tab page shows the overlay directly

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
