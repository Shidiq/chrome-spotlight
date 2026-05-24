# URL Spotlight

Chrome/Helium extension. Spotlight-style overlay for URL navigation and search, with bookmark + history suggestions.

## Install

1. Open `chrome://extensions/` (or `helium://extensions/`)
2. Enable **Developer mode**
3. Click **Load unpacked** → select `url-spotlight/`
4. Set shortcut at `chrome://extensions/shortcuts` (default `Ctrl+T` usually blocked by browser — pick e.g. `Cmd+Shift+P`)

## Use

- Press shortcut on any http(s) page → overlay appears
- Type URL, domain, or search query
- `↑` / `↓` pick suggestion from bookmarks/history
- `Enter` open in current tab
- `Shift+Enter` open in new tab
- Click suggestion to open in current tab, `Shift+Click` to open in new tab
- `Esc` or click outside to close

![URL Spotlight overlay](image.png)

## Navigation logic

- Starts with `http://` or `https://` → direct
- Looks like domain (has dot, no spaces) → prepend `https://`
- Otherwise → Google search

## Notes

- Content scripts don't inject into browser-internal pages (`chrome://`, new-tab, etc.)
- Reload any tab opened before install for content script to take effect
