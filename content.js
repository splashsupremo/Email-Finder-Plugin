const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|css|js|ico)$/i;

let found = new Map();      // email -> source (this page only)
let lastUrl = location.href;
let pendingNodes = [];
let flushTimer = null;

/* ---------- persistent collection reporting ---------- */
let pendingReport = new Map();  // email -> source, flushed to background
let reportTimer = null;

function reportStatus(status) {
  try {
    chrome.runtime.sendMessage({
      action: "scanStatus",
      status,                 // "scanning" | "complete"
      count: found.size,
      url: location.href,
    }, () => void chrome.runtime.lastError);
  } catch (e) {}
}

function scheduleReport() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => {
    reportTimer = null;
    if (!pendingReport.size) return;
    const emails = [...pendingReport].map(([email, source]) => ({ email, source }));
    pendingReport.clear();
    try {
      chrome.runtime.sendMessage({ action: "collect", emails }, () => void chrome.runtime.lastError);
    } catch (e) {}
    reportStatus("complete");
  }, 600);
}

function deobfuscate(t) {
  return t.replace(/\[(at|@)\]|\((at)\)/gi, "@").replace(/\[(dot|\.)\]|\((dot)\)/gi, ".");
}

function plausible(email) {
  if (email.length < 5 || email.length > 254 || IMG_EXT.test(email)) return false;
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (!local || !domain || local.length > 40) return false;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain)) return false;
  if ((email.match(/\./g) || []).length > 6) return false;
  return true;
}

function push(email, source) {
  email = email.toLowerCase().trim().replace(/[.,;:!?)"'\]>]+$/, "");
  if (!plausible(email) || found.has(email)) return;
  found.set(email, source);
  pendingReport.set(email, source);   // queue for persistent collection
  updateBadge();
  scheduleReport();
}

function updateBadge() {
  try { chrome.runtime.sendMessage({ action: "setBadge", count: found.size }); } catch (e) {}
}

function scanNode(node) {
  if (node.nodeType === 3) {
    const raw = node.nodeValue;
    if (raw.includes("@") || /\[(at|dot)\]/i.test(raw))
      (deobfuscate(raw).match(EMAIL_RE) || []).forEach((e) => push(e, location.href));
    return;
  }
  if (node.nodeType !== 1) return;
  if (node.matches && node.matches('a[href^="mailto:"]'))
    push(node.getAttribute("href").slice(7).split("?")[0], location.href);
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const raw = n.nodeValue;
    if (raw.includes("@") || /\[(at|dot)\]/i.test(raw))
      (deobfuscate(raw).match(EMAIL_RE) || []).forEach((e) => push(e, location.href));
  }
}

function scanMailtoAnchors(root) {
  root.querySelectorAll('a[href^="mailto:"]').forEach((a) =>
    push(a.getAttribute("href").slice(7).split("?")[0], location.href));
}

// initial full scan — runs at document_idle, i.e. after the page finished loading
function initialScan() {
  reportStatus("scanning");
  scanMailtoAnchors(document);
  scanNode(document.body);
  (document.documentElement.innerHTML.match(EMAIL_RE) || [])
    .forEach((e) => push(e, location.href));
  updateBadge();
  scheduleReport();       // -> "complete" once the batch flushes (even if 0 emails)
}
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initialScan, { once: true });
} else {
  initialScan();
}

// ---- live scanning for dynamically loaded content ----
const observer = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "attributes") { pendingNodes.push(m.target); continue; }
    m.addedNodes.forEach((n) => pendingNodes.push(n));
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 400);
});
function flush() {
  flushTimer = null;
  const nodes = pendingNodes; pendingNodes = [];
  nodes.forEach(scanNode);       // new emails auto-reported via push()
}
observer.observe(document.body, {
  childList: true, subtree: true,
  attributes: true, attributeFilter: ["href"],
});

// SPA navigation: URL changed without reload -> reset per-page state,
// keep reporting new finds under the new URL (collection is unaffected)
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    found.clear();
    updateBadge();
    reportStatus("scanning");
    scanMailtoAnchors(document);
    scanNode(document.body);
    scheduleReport();
  }
}, 1000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "scanPage") {
    scanMailtoAnchors(document);
    scanNode(document.body);
    sendResponse({ emails: [...found].map(([email, source]) => ({ email, source })) });
  }
  return true;
});