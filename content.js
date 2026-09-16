// content.js — injected into twitch.tv pages
// 1. On every page load: check if there's pending localStorage to restore (after account switch)
// 2. Handles clearLocalStorage command from background during switching

(function () {

  // ── On page load: restore localStorage if a switch just happened ──────────
  // Run ASAP (before Twitch JS reads localStorage) using document_start would be ideal,
  // but we're at document_idle. We restore immediately and the page re-reads state.
  restorePendingLocalStorage();

  function restorePendingLocalStorage() {
    try {
      chrome.storage.local.get('pendingLocalStorage', ({ pendingLocalStorage }) => {
        if (!pendingLocalStorage || Object.keys(pendingLocalStorage).length === 0) return;
        // Write all saved localStorage keys for this account
        for (const [key, value] of Object.entries(pendingLocalStorage)) {
          try { localStorage.setItem(key, value); } catch(_) {}
        }
        // Clear the pending flag so we don't restore again on next navigation
        chrome.storage.local.remove('pendingLocalStorage');
      });
    } catch (_) {}
  }

  // ── Message handler ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'clearLocalStorage') {
      clearTwitchClientState();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.action === 'pageReady') {
      sendResponse({ ok: true });
      return true;
    }
  });

  function clearTwitchClientState() {
    try {
      // Patterns of keys Twitch uses for auth/session state
      const sensitivePatterns = ['auth', 'token', 'session', 'user', 'login', 'persist', 'twilight'];

      // Clear localStorage
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && sensitivePatterns.some(p => key.toLowerCase().includes(p))) {
          try { localStorage.removeItem(key); } catch(_) {}
        }
      }

      // Clear sessionStorage
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && sensitivePatterns.some(p => key.toLowerCase().includes(p))) {
          try { sessionStorage.removeItem(key); } catch(_) {}
        }
      }

      // Delete Twitch IndexedDB databases (auth cache)
      ['TwitchEmbeddedPlayerDB', 'twilight', 'TwitchVideoPreloadDB', 'localforage'].forEach(dbName => {
        try { indexedDB.deleteDatabase(dbName); } catch(_) {}
      });

    } catch (_) {}
  }

  // Notify background page is ready
  try {
    chrome.runtime.sendMessage({ action: 'pageReady', url: location.href });
  } catch (_) {}

})();
