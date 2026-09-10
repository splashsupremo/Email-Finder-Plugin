const COLLECTION_KEY = "emailFinderCollectionV1";

chrome.action.onClicked.addListener(async (tab) => {
  try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (e) { /* already open */ }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "setBadge" && sender.tab) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.count ? String(msg.count) : "" });
    chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: "#f97316" });
  }
  if (msg.action === "collect" && Array.isArray(msg.emails) && msg.emails.length) {
    persistEmails(msg.emails);
  }
});

/* Merge incoming emails into the persistent collection.
   Stored as an object keyed by email -> source URL, so dedupe is O(1)
   and chrome.storage.onChanged notifies the side panel on every update. */
async function persistEmails(emails) {
  try {
    const d = await chrome.storage.local.get(COLLECTION_KEY);
    const coll = d[COLLECTION_KEY] || {};
    let added = false;
    for (const e of emails) {
      if (e && e.email && typeof e.email === "string" && !coll[e.email]) {
        coll[e.email] = (e.source || "").slice(0, 2048);
        added = true;
      }
    }
    if (added) await chrome.storage.local.set({ [COLLECTION_KEY]: coll });
  } catch (err) { /* storage failure must never break the page */ }
}

// clear the badge whenever the tab starts loading a new page
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === "loading") chrome.action.setBadgeText({ tabId, text: "" });
});