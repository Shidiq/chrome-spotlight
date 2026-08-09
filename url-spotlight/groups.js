(() => {
  const tg = self.SpTabGroups;

  const listEl = document.getElementById("list");
  let items = []; // open groups ({kind:"open",...}) then closed ones ({kind:"closed",...})
  let selectedIdx = 0;

  function load() {
    if (!tg.supported()) {
      listEl.textContent = "";
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Tab groups are not supported in this browser.";
      listEl.appendChild(empty);
      return;
    }
    tg.load().then((next) => {
      items = next;
      if (selectedIdx >= items.length) selectedIdx = Math.max(0, items.length - 1);
      render();
    });
  }

  function render() {
    listEl.textContent = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      const msg = document.createElement("div");
      msg.textContent = "No tab groups";
      const hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Right-click a tab → Add tab to new group";
      empty.appendChild(msg);
      empty.appendChild(hint);
      listEl.appendChild(empty);
      return;
    }

    const openItems = items.filter((it) => it.kind === "open");
    const hasClosed = items.some((it) => it.kind === "closed");

    const windowOrder = [];
    for (const g of openItems) {
      if (!windowOrder.includes(g.windowId)) windowOrder.push(g.windowId);
    }
    const multiWindow = windowOrder.length > 1;

    let closedLabelDone = false;
    items.forEach((it, i) => {
      if (hasClosed && i === 0 && it.kind === "open") {
        const label = document.createElement("div");
        label.className = "section-label";
        label.textContent = "Open groups";
        listEl.appendChild(label);
      }
      if (it.kind === "closed" && !closedLabelDone) {
        closedLabelDone = true;
        const label = document.createElement("div");
        label.className = "section-label";
        label.textContent = "Recently closed";
        listEl.appendChild(label);
      }

      const row = document.createElement("div");
      row.className =
        "row" + (it.kind === "closed" ? " closed" : "") + (i === selectedIdx ? " selected" : "");

      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = tg.dotColor(it.color);

      const title = document.createElement("span");
      title.className = "title" + (it.title ? "" : " untitled");
      title.textContent = it.title || "Untitled group";

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = it.tabCount === 1 ? "1 tab" : `${it.tabCount} tabs`;

      row.appendChild(dot);
      row.appendChild(title);
      row.appendChild(count);

      if (it.kind === "open" && multiWindow) {
        const win = document.createElement("span");
        win.className = "win";
        win.textContent = `Window ${windowOrder.indexOf(it.windowId) + 1}`;
        row.appendChild(win);
      }

      row.addEventListener("click", () => activate(it));
      row.addEventListener("mousemove", () => {
        if (selectedIdx !== i) {
          selectedIdx = i;
          updateSelection();
        }
      });
      listEl.appendChild(row);
    });
  }

  function updateSelection() {
    const rows = listEl.querySelectorAll(".row");
    rows.forEach((row, i) => row.classList.toggle("selected", i === selectedIdx));
    const sel = rows[selectedIdx];
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function activate(it) {
    // The popup closes once the group is focused or the restore is queued; if
    // the group vanished since render, refresh instead.
    tg.activate(it, () => window.close(), load);
  }

  document.addEventListener("keydown", (e) => {
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIdx = Math.min(selectedIdx + 1, items.length - 1);
      updateSelection();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIdx = Math.max(selectedIdx - 1, 0);
      updateSelection();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[selectedIdx];
      if (it) activate(it);
    } else if (/^Digit[1-9]$/.test(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const it = items[Number(e.code.slice(5)) - 1];
      if (it) {
        e.preventDefault();
        activate(it);
      }
    }
  });

  load();
})();
