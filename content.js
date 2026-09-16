// content.js — injected into twitch.tv pages

(function () {

  // FIX #2/#16: восстанавливаем и localStorage, и sessionStorage, привязанные
  // к accountId, чтобы не применить данные не того аккаунта (например, при
  // гонке между двумя быстрыми переключениями подряд).
  restorePendingStorageData();

  function restorePendingStorageData() {
    // FIX #11: проверка chrome.runtime.lastError в колбэке chrome.storage.local.get
    chrome.storage.local.get(['pendingStorageData', 'activeAccountId'], (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Twitch Alt Manager] Ошибка чтения storage:', chrome.runtime.lastError.message);
        return;
      }

      const { pendingStorageData, activeAccountId } = result;
      if (!pendingStorageData) return;

      if (pendingStorageData.accountId !== activeAccountId) {
        console.warn('[Twitch Alt Manager] pendingStorageData принадлежит другому аккаунту — пропускаем восстановление.');
        return;
      }

      try {
        const localData = pendingStorageData.localStorageData || {};
        for (const [key, value] of Object.entries(localData)) {
          try { localStorage.setItem(key, value); } catch (e) {
            console.warn(`[Twitch Alt Manager] Не удалось восстановить localStorage ключ "${key}":`, e.message);
          }
        }

        const sessionData = pendingStorageData.sessionStorageData || {};
        for (const [key, value] of Object.entries(sessionData)) {
          try { sessionStorage.setItem(key, value); } catch (e) {
            console.warn(`[Twitch Alt Manager] Не удалось восстановить sessionStorage ключ "${key}":`, e.message);
          }
        }
      } finally {
        chrome.storage.local.remove('pendingStorageData', () => {
          if (chrome.runtime.lastError) {
            console.warn('[Twitch Alt Manager] Ошибка удаления pendingStorageData:', chrome.runtime.lastError.message);
          }
        });
      }
    });
  }

  // ── Message handler ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'clearLocalStorage') {
      clearTwitchClientState()
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true; // async response
    }
    if (msg.action === 'pageReady') {
      sendResponse({ ok: true });
      return true;
    }
  });

  // Безопасное удаление IndexedDB баз с обработкой blocked/error и таймаутом
  function deleteDatabaseSafe(dbName, timeoutMs = 1500) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (status, detail) => {
        if (settled) return;
        settled = true;
        if (status !== 'success') {
          console.warn(`[Twitch Alt Manager] IndexedDB "${dbName}": ${status}${detail ? ' — ' + detail : ''}`);
        }
        resolve({ dbName, status });
      };

      let req;
      try {
        req = indexedDB.deleteDatabase(dbName);
      } catch (e) {
        finish('error', e.message);
        return;
      }

      req.onsuccess = () => finish('success');
      req.onerror = () => finish('error', req.error ? req.error.message : 'unknown error');
      req.onblocked = () => finish('blocked', 'database is in use by another connection');

      setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  async function clearTwitchClientState() {
    // FIX #2: очищаем sessionStorage вместе с localStorage (было пропущено ранее)
    const sensitivePatterns = ['auth', 'token', 'session', 'user', 'login', 'persist', 'twilight'];

    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && sensitivePatterns.some(p => key.toLowerCase().includes(p))) {
          try { localStorage.removeItem(key); } catch (e) {
            console.warn(`[Twitch Alt Manager] Не удалось удалить localStorage["${key}"]:`, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[Twitch Alt Manager] Ошибка очистки localStorage:', e.message);
    }

    try {
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const key = sessionStorage.key(i);
        if (key && sensitivePatterns.some(p => key.toLowerCase().includes(p))) {
          try { sessionStorage.removeItem(key); } catch (e) {
            console.warn(`[Twitch Alt Manager] Не удалось удалить sessionStorage["${key}"]:`, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[Twitch Alt Manager] Ошибка очистки sessionStorage:', e.message);
    }

    const dbNames = ['TwitchEmbeddedPlayerDB', 'twilight', 'TwitchVideoPreloadDB', 'localforage'];
    const results = await Promise.all(dbNames.map(name => deleteDatabaseSafe(name)));

    const blocked = results.filter(r => r.status === 'blocked');
    if (blocked.length) {
      console.warn('[Twitch Alt Manager] Некоторые IndexedDB базы заблокированы (используются другой вкладкой):',
        blocked.map(b => b.dbName));
    }

    return results;
  }

  try {
    chrome.runtime.sendMessage({ action: 'pageReady', url: location.href });
  } catch (_) {}

})();
