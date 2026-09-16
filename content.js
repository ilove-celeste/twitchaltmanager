// content.js — injected into twitch.tv pages

(function () {

  // FIX #16: pendingLocalStorage теперь хранит { accountId, data, createdAt }.
  // Восстанавливаем данные, только если они действительно относятся к текущему
  // активному аккаунту (activeAccountId), чтобы не записать чужие данные,
  // если между установкой pending и загрузкой страницы произошло ещё одно переключение.
  restorePendingLocalStorage();

  // FIX #11 (было: chrome.storage.local.get не проверял chrome.runtime.lastError)
  function restorePendingLocalStorage() {
    chrome.storage.local.get(['pendingLocalStorage', 'activeAccountId'], (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[Twitch Alt Manager] Ошибка чтения storage:', chrome.runtime.lastError.message);
        return;
      }

      const { pendingLocalStorage, activeAccountId } = result;
      if (!pendingLocalStorage || !pendingLocalStorage.data) return;

      // FIX #16: проверяем принадлежность аккаунту перед восстановлением
      if (pendingLocalStorage.accountId !== activeAccountId) {
        console.warn('[Twitch Alt Manager] pendingLocalStorage принадлежит другому аккаунту — пропускаем восстановление.');
        return;
      }

      try {
        for (const [key, value] of Object.entries(pendingLocalStorage.data)) {
          try { localStorage.setItem(key, value); } catch (e) {
            console.warn(`[Twitch Alt Manager] Не удалось восстановить localStorage ключ "${key}":`, e.message);
          }
        }
      } finally {
        // Очищаем pending в любом случае, чтобы не пытаться восстановить повторно
        chrome.storage.local.remove('pendingLocalStorage', () => {
          if (chrome.runtime.lastError) {
            console.warn('[Twitch Alt Manager] Ошибка удаления pendingLocalStorage:', chrome.runtime.lastError.message);
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

  // FIX #4 (было: indexedDB.deleteDatabase могла молча зависнуть/провалиться, если
  // база "занята" другой открытой вкладкой/соединением — не было обработки onblocked/onerror)
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
      // onblocked срабатывает, если база используется другим открытым соединением —
      // не считаем это фатальной ошибкой, просто логируем и продолжаем работу.
      req.onblocked = () => finish('blocked', 'database is in use by another connection');

      // Подстраховка на случай, если ни один из колбэков не сработает
      setTimeout(() => finish('timeout'), timeoutMs);
    });
  }

  async function clearTwitchClientState() {
    const sensitivePatterns = ['auth', 'token', 'session', 'user', 'login', 'persist', 'twilight'];

    // Очистка localStorage
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

    // Очистка sessionStorage
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

    // FIX #4: безопасное удаление IndexedDB баз с обработкой blocked/error и таймаутом
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
