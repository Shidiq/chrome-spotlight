// Query helpers shared by the spotlight overlay (content.js) and the options
// page, which needs the engine list outside the content.js IIFE.
(() => {
  "use strict";
  if (self.SpQuery) return;

  const SEARCH_ENGINES = {
    duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
    google: { name: "Google", url: "https://www.google.com/search?q=" },
    brave: { name: "Brave", url: "https://search.brave.com/search?q=" },
    startpage: { name: "Startpage", url: "https://www.startpage.com/sp/search?query=" },
    bing: { name: "Bing", url: "https://www.bing.com/search?q=" }
  };
  const DEFAULT_ENGINE = "duckduckgo";

  // Returns the URL to navigate to, or null for an empty query. A bare token
  // containing a dot is treated as a host; everything else goes to the engine.
  function resolve(raw, engineKey) {
    const trimmed = (raw || "").trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (!/\s/.test(trimmed) && /\./.test(trimmed)) return "https://" + trimmed;
    const engine = SEARCH_ENGINES[engineKey] || SEARCH_ENGINES[DEFAULT_ENGINE];
    return engine.url + encodeURIComponent(trimmed);
  }

  // Case-insensitive subsequence match. Returns a score (higher is better),
  // or -1 if not every query char is found in order.
  function fuzzyScore(query, text) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = (text || "").toLowerCase();
    let qi = 0;
    let score = 0;
    let prevIdx = -1;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] === q[qi]) {
        score += prevIdx === ti - 1 ? 3 : 1; // contiguous-run bonus
        if (ti === 0) score += 2; // start-of-string boost
        prevIdx = ti;
        qi++;
      }
    }
    return qi === q.length ? score : -1;
  }

  self.SpQuery = { SEARCH_ENGINES, DEFAULT_ENGINE, resolve, fuzzyScore };
})();
