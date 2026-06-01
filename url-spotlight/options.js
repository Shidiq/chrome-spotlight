const SEARCH_ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  brave: { name: "Brave", url: "https://search.brave.com/search?q=" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" }
};
const DEFAULT_ENGINE = "duckduckgo";

const select = document.getElementById("engine");
const loadingAnim = document.getElementById("loadingAnim");
const status = document.getElementById("status");

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

chrome.storage.sync.get(
  { searchEngine: DEFAULT_ENGINE, loadingAnimation: true },
  (r) => {
    select.value = SEARCH_ENGINES[r.searchEngine] ? r.searchEngine : DEFAULT_ENGINE;
    loadingAnim.checked = r.loadingAnimation;
  }
);

select.addEventListener("change", () => {
  chrome.storage.sync.set({ searchEngine: select.value }, showSaved);
});

loadingAnim.addEventListener("change", () => {
  chrome.storage.sync.set({ loadingAnimation: loadingAnim.checked }, showSaved);
});
