/* ---------- shared email extraction ---------- */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|css|js|ico)$/i;
const ROLE_RE = /^(info|support|contact|sales|hello|hi|admin|noreply|no-reply|office|team|mail|helpdesk|enquiries|service)@/i;
const CONTACT_RE = /contact|kontakt|about|impressum|imprint|support|reach|feedback|team|customer[-_ ]?service|get[-_ ]?in[-_ ]?touch|write[-_ ]?us/i;
const BAD_LINK_RE = /privacy|policy|terms|login|signin|register|cart|checkout|shop|store|blog|news|article|category|tag|archive|#|javascript:|\.(png|jpe?g|gif|pdf|zip)$/i;

function deobfuscate(t) {
  return t.replace(/\[(at|@)\]|\((at)\)/gi, "@").replace(/\[(dot|\.)\]|\((dot)\)/gi, ".");
}
function pushEmail(map, email, source) {
  email = email.toLowerCase().trim().replace(/[.,;:!?)"'\]>]+$/, "");
  if (email.length < 5 || email.length > 254 || IMG_EXT.test(email)) return;
  if (!map.has(email)) map.set(email, source);
}
function emailsFromHtml(html, pageUrl, skipRole) {
  const found = new Map();
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll('a[href^="mailto:"]').forEach((a) =>
    pushEmail(found, a.getAttribute("href").slice(7).split("?")[0], pageUrl));
  (deobfuscate(doc.body ? doc.body.textContent : "").match(EMAIL_RE) || [])
    .forEach((e) => pushEmail(found, e, pageUrl));
  (html.match(EMAIL_RE) || []).forEach((e) => pushEmail(found, e, pageUrl));
  let out = [...found].map(([email, source]) => ({ email, source }));
  if (skipRole) out = out.filter((e) => !ROLE_RE.test(e.email));
  return out;
}
function findContactLinks(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const baseHost = new URL(pageUrl).hostname.replace(/^www\./, "");
  const links = new Map();
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    const label = ((a.textContent || "") + " " + href).trim();
    if (!CONTACT_RE.test(label) || BAD_LINK_RE.test(label)) return;
    try {
      const u = new URL(href, pageUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (u.hostname.replace(/^www\./, "") !== baseHost) return;
      if (!links.has(u.href)) links.set(u.href, label);
    } catch (e) {}
  });
  return [...links.keys()];
}
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs * 1000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (!/text\/html|application\/xhtml/.test(res.headers.get("content-type") || "")) throw new Error("not HTML");
    return await res.text();
  } finally { clearTimeout(t); }
}
function normalizeUrl(input) {
  input = (input || "").trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = "https://" + input;
  try { return new URL(input).origin; } catch (e) { return null; }
}
function domainKey(url) { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }

async function scanSite(url, opts) {
  const visited = [], all = new Map();
  let notes = "";
  try {
    const home = await fetchText(url, opts.timeout);
    visited.push(url);
    emailsFromHtml(home, url, opts.skipRole).forEach((e) => all.set(e.email, e.source));
    const links = findContactLinks(home, url).slice(0, opts.pagesPerSite);
    for (const link of links) {
      await sleep(opts.delay);
      try {
        const html = await fetchText(link, opts.timeout);
        visited.push(link);
        emailsFromHtml(html, link, opts.skipRole).forEach((e) => all.set(e.email, e.source));
      } catch (e) {}
    }
    if (!all.size) notes = links.length ? "No emails published" : "No contact pages found";
  } catch (e) {
    notes = e.name === "AbortError" ? "Timed out" : String(e.message || e);
  }
  return { emails: [...all].map(([email, source]) => ({ email, source })), visited, notes };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- filters (shared by page + bulk) ---------- */
const FILTER_KEY = "emailFinderFiltersV1";
let filters = { text: "", hideRole: false, ownDomain: false, block: "" };
function blockedHosts() {
  return filters.block.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function isBlockedUrl(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return blockedHosts().some((b) => h === b || h.endsWith("." + b));
  } catch (e) { return false; }
}
function saveFilters() { chrome.storage.local.set({ [FILTER_KEY]: filters }); }

/* ---------- CSV helpers ---------- */
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}
const csvCell = (v) => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : v;

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);

/* ---------- COLLECTION pane (auto-scanned, persistent) ---------- */
const COLLECTION_KEY = "emailFinderCollectionV1";
let collection = {};             // email -> source URL

function collEntries() {
  return Object.entries(collection).map(([email, source]) => ({ email, source }));
}
function renderCollection() {
  const entries = collEntries();
  $("collCount").textContent = entries.length;
  $("collPages").textContent = new Set(entries.map((e) => e.source).filter(Boolean)).size;
  $("collTable").style.display = entries.length ? "" : "none";
  $("collEmpty").style.display = entries.length ? "none" : "";
  const tb = $("collTable").querySelector("tbody");
  tb.innerHTML = "";
  entries.forEach((r) => {
    const tr = tb.insertRow();
    tr.innerHTML = `<td class="email"></td><td><button class="copy">copy</button></td>`;
    tr.cells[0].textContent = r.email;
    tr.querySelector(".copy").onclick = () => navigator.clipboard.writeText(r.email);
  });
}
function setCollectStatus(msg) {
  if (msg.status === "scanning") {
    let host = "";
    try { host = new URL(msg.url).hostname; } catch (e) {}
    $("collectStatus").textContent = "🔍 Scanning " + (host || "page") + "…";
  } else {
    $("collectStatus").textContent =
      "✓ Scan complete — " + msg.count + " found on this page · " +
      collEntries().length + " in collection";
  }
}

// live updates: background writes to storage, panel re-renders on change
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[COLLECTION_KEY]) {
    collection = changes[COLLECTION_KEY].newValue || {};
    renderCollection();
  }
});
// live status from content scripts (works even when no new emails were added)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "scanStatus") setCollectStatus(msg);
});

$("btnExportColl").onclick = () => {
  const entries = collEntries();
  if (!entries.length) return ($("collectStatus").textContent = "Collection is empty — nothing to export.");
  const lines = ["Email"];
  entries.forEach((r) => lines.push(csvCell(r.email)));
  downloadBlob(lines.join("\n"), "collected-emails.csv");
};
$("btnCopyColl").onclick = () => {
  const entries = collEntries();
  if (!entries.length) return;
  navigator.clipboard.writeText(entries.map((r) => r.email).join("\n"));
};
$("btnClearColl").onclick = async () => {
  if (!collEntries().length) return;
  if (!confirm("Clear all " + collEntries().length + " collected emails? This cannot be undone.")) return;
  collection = {};
  await chrome.storage.local.remove(COLLECTION_KEY);
  renderCollection();
  $("collectStatus").textContent = "Collection cleared.";
};

$("tabCollect").onclick = () => switchTab("Collect");
$("tabPage").onclick = () => switchTab("Page");
$("tabBulk").onclick = () => switchTab("Bulk");
function switchTab(n) {
  $("tabCollect").classList.toggle("active", n === "Collect");
  $("tabPage").classList.toggle("active", n === "Page");
  $("tabBulk").classList.toggle("active", n === "Bulk");
  $("paneCollect").classList.toggle("active", n === "Collect");
  $("panePage").classList.toggle("active", n === "Page");
  $("paneBulk").classList.toggle("active", n === "Bulk");
}

/* ---------- THIS PAGE pane ---------- */
let pageResults = [];
let currentSiteDomain = "";

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && /^https?:/.test(tab.url) ? tab : null;
}
function filteredPageResults() {
  const text = filters.text.toLowerCase();
  return pageResults.filter((r) => {
    if (filters.hideRole && ROLE_RE.test(r.email)) return false;
    if (filters.ownDomain && currentSiteDomain &&
        !r.email.toLowerCase().endsWith("@" + currentSiteDomain)) return false;
    if (blockedHosts().length && isBlockedUrl(r.source)) return false;
    if (text && !r.email.toLowerCase().includes(text)) return false;
    return true;
  });
}
function renderPageResults() {
  const shown = filteredPageResults();
  const tb = $("pageTable").querySelector("tbody");
  tb.innerHTML = "";
  $("pageTable").style.display = shown.length ? "" : "none";
  $("pageFilters").style.display = pageResults.length ? "" : "none";
  $("pageStatus").textContent = pageResults.length
    ? (shown.length === pageResults.length ? pageResults.length + " found" : shown.length + " of " + pageResults.length + " shown")
    : "No email addresses found on this page.";
  shown.forEach((r) => {
    const tr = tb.insertRow();
    tr.innerHTML = `<td class="email"></td><td class="muted"></td><td><button class="copy">copy</button></td>`;
    tr.cells[0].textContent = r.email;
    tr.cells[1].textContent = r.source;
    tr.querySelector(".copy").onclick = () => navigator.clipboard.writeText(r.email);
  });
}
["fltText", "fltRole", "fltOwn", "fltBlock"].forEach((id) => {
  $(id).addEventListener("input", () => {
    filters.text = $("fltText").value;
    filters.hideRole = $("fltRole").checked;
    filters.ownDomain = $("fltOwn").checked;
    filters.block = $("fltBlock").value;
    saveFilters(); renderPageResults();
  });
});
$("btnScanPage").onclick = async () => {
  const tab = await getActiveTab();
  if (!tab) return ($("pageStatus").textContent = "Open a website tab first.");
  currentSiteDomain = domainKey(tab.url);
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "scanPage" });
    pageResults = res.emails || [];
  } catch (e) {
    $("pageStatus").textContent = "Could not scan this page.";
    return;
  }
  renderPageResults();
};
$("btnScanAll").onclick = async () => {
  const tab = await getActiveTab();
  if (!tab) return ($("pageStatus").textContent = "Open a website tab first.");
  currentSiteDomain = domainKey(tab.url);
  $("pageStatus").textContent = "Scanning page + contact pages…";
  const all = new Map();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: "scanPage" });
    (res.emails || []).forEach((e) => all.set(e.email, e.source));
  } catch (e) {}
  const origin = new URL(tab.url).origin;
  try {
    const home = await fetchText(origin, 15);
    emailsFromHtml(home, origin, false).forEach((e) => all.set(e.email, e.source));
    const links = findContactLinks(home, origin).slice(0, 5);
    for (const link of links) {
      $("pageStatus").textContent = "Checking " + link + "…";
      try {
        emailsFromHtml(await fetchText(link, 10), link, false).forEach((e) => all.set(e.email, e.source));
      } catch (e) {}
    }
  } catch (e) {}
  pageResults = [...all].map(([email, source]) => ({ email, source }));
  renderPageResults();
};

/* ---------- BULK CSV pane ---------- */
let state = null;
const STORE_KEY = "emailFinderBulkV1";
let ticker = null;

function currentOptions() {
  return {
    pagesPerSite: +$("optPages").value || 3,
    concurrency: Math.min(+$("optConc").value || 3, 6),
    timeout: +$("optTimeout").value || 10,
    delay: +$("optDelay").value || 0,
    skipRole: $("optSkipRole").checked,
    ownDomain: $("optOwnDomain").checked,
  };
}
function saveState() { chrome.storage.local.set({ [STORE_KEY]: state }); }
async function loadState() {
  const d = await chrome.storage.local.get(STORE_KEY);
  if (d[STORE_KEY] && d[STORE_KEY].rows) { state = d[STORE_KEY]; state.running = false; renderBulk(); }
}

$("fileInput").onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const rows = parseCSV(await file.text());
  if (rows.length < 2) return alert("CSV needs a header row and at least one data row.");
  const headers = rows[0].map((h) => h.trim());
  const col = headers.findIndex((h) => /website|web\s?site|url|domain|site|link|homepage/i.test(h));
  if (col === -1) return alert("Couldn't find a website/domain column.");
  state = { headers, col, rows: [], nextIndex: 0, running: false, startedAt: null, elapsedBase: 0 };
  const seen = new Set();
  rows.slice(1).forEach((cells) => {
    const raw = (cells[col] || "").trim();
    const url = normalizeUrl(raw);
    const key = url ? domainKey(url) : null;
    const dup = url && seen.has(key);
    if (url) seen.add(key);
    state.rows.push({
      cells, url, key,
      status: !url ? "invalid" : dup ? "duplicate" : "queued",
      emails: [], notes: url ? "" : "No valid URL", skip: dup,
    });
  });
  saveState(); renderBulk();
};

$("lnkSample").onclick = (e) => {
  e.preventDefault();
  downloadBlob("website,name\nstripe.com,Stripe\nsupabase.com,Supabase\n", "sample.csv");
};
function downloadBlob(content, filename) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  chrome.downloads.download({ url, filename, saveAs: true });
}

/* ----- bulk runner ----- */
$("btnStart").onclick = async () => {
  if (!state) return;
  if (state.nextIndex >= state.rows.length) {
    state.rows.forEach((r) => { if (r.status === "done" || r.status === "error") { r.status = "queued"; r.emails = []; r.notes = ""; } });
    state.nextIndex = 0;
  }
  state.running = true;
  state.opts = currentOptions();
  state.startedAt = Date.now();
  updateRunUI(); saveState();
  ticker = setInterval(updateStats, 1000);
  await Promise.all(Array.from({ length: state.opts.concurrency }, bulkWorker));
  state.running = false;
  clearInterval(ticker);
  state.elapsedBase += Date.now() - state.startedAt;
  state.startedAt = null;
  saveState(); updateRunUI(); updateStats();
};
$("btnPause").onclick = () => { state.running = false; updateRunUI(); };

async function bulkWorker() {
  while (state.running) {
    const i = state.nextIndex++;
    if (i >= state.rows.length) return;
    const row = state.rows[i];
    if (row.skip || (row.status !== "queued" && row.status !== "error")) continue;
    if (blockedHosts().length && isBlockedUrl(row.url)) {
      row.status = "done"; row.notes = "Blocked by filter";
      saveState(); renderRow(i); updateStats();
      continue;
    }
    row.status = "scanning"; renderRow(i); updateStats();
    const r = await scanSite(row.url, state.opts);
    row.emails = r.emails;
    if (state.opts.ownDomain && row.key)   // keep only emails on the site's own domain
      row.emails = row.emails.filter((e) => {
        const d = e.email.split("@")[1];
        return d === row.key || d.endsWith("." + row.key);
      });
    row.notes = r.notes; row.status = "done";
    saveState(); renderRow(i); updateStats();
    await sleep(state.opts.delay);
  }
}

/* ----- rendering ----- */
function statusLabel(s) {
  return { queued: "queued", scanning: "scanning…", done: "✓", error: "error", duplicate: "duplicate", invalid: "invalid" }[s] || s;
}
function renderBulk() {
  const ready = !!state;
  $("bulkIdle").style.display = ready ? "none" : "";
  $("bulkReady").style.display = ready ? "" : "none";
  if (!ready) return;
  const tb = $("bulkTable").querySelector("tbody");
  tb.innerHTML = "";
  state.rows.forEach((_, i) => renderRow(i));
  updateStats(); updateRunUI();
}
function renderRow(i) {
  const tb = $("bulkTable").querySelector("tbody");
  let tr = tb.rows[i];
  const row = state.rows[i];
  if (!tr) { tr = tb.insertRow(); tr.insertCell(); tr.insertCell(); tr.insertCell(); tr.insertCell(); }
  tr.cells[0].textContent = i + 1;
  tr.cells[1].textContent = (row.cells[state.col] || "").trim() || "—";
  tr.cells[2].innerHTML = row.emails.length
    ? row.emails.map(() => `<div class="email"></div>`).join("")
    : `<span class="muted">${statusLabel(row.status)}</span>`;
  [...tr.cells[2].querySelectorAll(".email")].forEach((d, j) => (d.textContent = row.emails[j].email));
  tr.cells[3].textContent = row.notes || "";
  tr.cells[3].className = "muted";
}
function updateRunUI() {
  const running = state && state.running;
  $("btnStart").style.display = running ? "none" : "";
  $("btnPause").style.display = running ? "" : "none";
  $("btnStart").textContent = state && state.nextIndex > 0 && state.nextIndex < state.rows.length ? "▶ Resume" : "▶ Start scan";
}
function updateStats() {
  if (!state) return;
  const processed = state.rows.filter((r) => r.status === "done" || r.status === "error").length;
  const found = state.rows.reduce((n, r) => n + r.emails.length, 0);
  $("stProcessed").textContent = processed;
  $("stRemaining").textContent = state.rows.length - processed;
  $("stFound").textContent = found;
  const elapsed = state.elapsedBase + (state.startedAt ? Date.now() - state.startedAt : 0);
  $("stTime").textContent = Math.floor(elapsed / 60000) + ":" + String(Math.floor((elapsed % 60000) / 1000)).padStart(2, "0");
  $("progressBar").firstElementChild.style.width = state.rows.length ? (processed / state.rows.length * 100) + "%" : "0%";
}

/* ----- export / copy / clear ----- */
$("btnExport").onclick = () => {
  if (!state) return;
  const only = $("optExportOnly").checked;
  const lines = [state.headers.concat(["emails", "notes"]).map(csvCell).join(",")];
  state.rows.forEach((r) => {
    if (only && !r.emails.length) return;
    lines.push(r.cells.map((c) => csvCell(c ?? "")).concat([
      csvCell(r.emails.map((e) => e.email).join("; ")),
      csvCell(r.notes || ""),
    ]).join(","));
  });
  downloadBlob(lines.join("\n"), "email-finder-results.csv");
};
$("btnCopy").onclick = () => {
  if (!state) return;
  navigator.clipboard.writeText(
    state.headers.concat(["emails", "notes"]).join("\t") + "\n" +
    state.rows.map((r) => r.cells.join("\t") + "\t" + r.emails.map((e) => e.email).join("; ") + "\t" + (r.notes || "")).join("\n")
  );
};
$("btnClear").onclick = async () => {
  state = null;
  await chrome.storage.local.remove(STORE_KEY);
  renderBulk();
};

/* ---------- init ---------- */
(async () => {
  const d = await chrome.storage.local.get(FILTER_KEY);
  if (d[FILTER_KEY]) filters = d[FILTER_KEY];
  $("fltText").value = filters.text;
  $("fltRole").checked = filters.hideRole;
  $("fltOwn").checked = filters.ownDomain;
  $("fltBlock").value = filters.block;
  loadState();
  const cd = await chrome.storage.local.get(COLLECTION_KEY);
  collection = cd[COLLECTION_KEY] || {};
  renderCollection();
})();