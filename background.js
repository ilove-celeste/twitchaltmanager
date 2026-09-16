// background.js — Service Worker for Twitch Alt Manager

// ─── Encryption helpers (AES-GCM via Web Crypto) ─────────────────────────────

async function getEncryptionKey() {
  const stored = await chrome.storage.local.get('_enc_key');
  if (stored._enc_key) {
    return await crypto.subtle.importKey(
      'raw',
      new Uint8Array(stored._enc_key),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    );
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const exported = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.local.set({ _enc_key: Array.from(new Uint8Array(exported)) });
  return key;
}

async function encrypt(text) {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    iv: Array.from(iv),
    data: Array.from(new Uint8Array(ciphertext))
  };
}

async function decrypt(encObj) {
  const key = await getEncryptionKey();
  const iv = new Uint8Array(encObj.iv);
  const data = new Uint8Array(encObj.data);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

// FIX #1 (было: domain: 'twitch.tv' — не захватывал cookies с доменом .twitch.tv)
// Делаем несколько запросов по разным доменам и объединяем результат, убирая дубликаты
// по паре (name, domain, path), чтобы гарантированно получить все cookies Twitch.
async function getAllTwitchCookies() {
  const domainsToQuery = [
    '.twitch.tv',
    'twitch.tv',
    'www.twitch.tv',
    'id.twitch.tv',
    'passport.twitch.tv',
    'gql.twitch.tv'
  ];

  const results = await Promise.allSettled(
    domainsToQuery.map(domain => chrome.cookies.getAll({ domain }))
  );

  const merged = new Map();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const c of r.value) {
      const key = `${c.name}|${c.domain}|${c.path}`;
      merged.set(key, c);
    }
  }
  return Array.from(merged.values());
}

function cookieUrl(c) {
  const domain = c.domain.startsWith('.') ? c.domain.substring(1) : c.domain;
  const host = c.domain.startsWith('.') ? `www.${domain}` : domain;
  return `https://${host}${c.path || '/'}`;
}

async function clearTwitchCookies() {
  const cookies = await getAllTwitchCookies();
  const removals = cookies.map(c =>
    chrome.cookies.remove({ url: cookieUrl(c), name: c.name })
  );
  const results = await Promise.allSettled(removals);
  const failed = results.filter(r => r.status === 'rejected' || r.value === null);
  return { removed: cookies.length - failed.length, failed: failed.length };
}

// FIX #2 (было: ошибки установки cookies молча игнорировались)
// Теперь собираем результат каждой установки (успех/причина ошибки) и логируем,
// чтобы можно было понять, какие именно cookies не установились.
async function setCookies(cookieList) {
  const report = { succeeded: [], failed: [] };

  for (const c of cookieList) {
    try {
      const domain = c.domain || '.twitch.tv';
      const host = domain.startsWith('.') ? `www${domain}` : domain;
      const url = `https://${host}${c.path || '/'}`;
      const details = {
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure !== false,
        httpOnly: c.httpOnly || false,
        sameSite: c.sameSite || 'no_restriction'
      };
      if (c.expirationDate) {
        // Продлеваем срок действия до 30 дней от текущего момента, если он раньше
        details.expirationDate = Math.max(c.expirationDate, Date.now() / 1000 + 60 * 60 * 24 * 30);
      }

      const result = await chrome.cookies.set(details);

      if (result === null) {
        // chrome.cookies.set возвращает null при неудаче (например, домен заблокирован)
        const reason = chrome.runtime.lastError ? chrome.runtime.lastError.message : 'unknown reason (cookies.set returned null)';
        console.warn(`[Twitch Alt Manager] Не удалось установить cookie "${c.name}" для ${url}: ${reason}`);
        report.failed.push({ name: c.name, domain: c.domain, reason });
      } else {
        report.succeeded.push(c.name);
      }
    } catch (e) {
      console.error(`[Twitch Alt Manager] Ошибка установки cookie "${c.name}":`, e);
      report.failed.push({ name: c.name, domain: c.domain, reason: e.message });
    }
  }

  if (report.failed.length > 0) {
    console.warn('[Twitch Alt Manager] Cookies, которые не удалось установить:', report.failed);
  }

  return report;
}

// ─── Account storage ──────────────────────────────────────────────────────────

async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get('accounts');
  return accounts || [];
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

// FIX #12 (было: не проверялось наличие активной вкладки Twitch)
// Теперь явно ищем вкладку Twitch, и если её нет — возвращаем понятную ошибку
// вместо тихого null.
async function captureLocalStorageFromTab() {
  const activeInWindow = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'], active: true, currentWindow: true });
  const anyTwitchTab = activeInWindow.length ? activeInWindow : await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });

  if (!anyTwitchTab.length) {
    throw new Error('Не найдена открытая вкладка Twitch. Открой twitch.tv в браузере и повтори.');
  }

  const tab = anyTwitchTab[0];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const data = {};
        const sensitiveKeys = ['twilight-user', 'login', 'auth-token', 'persistent', 'api_token', 'server_session_id'];
        for (const key of sensitiveKeys) {
          const val = localStorage.getItem(key);
          if (val) data[key] = val;
        }
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && ['auth', 'token', 'session', 'login', 'persist'].some(p => key.toLowerCase().includes(p))) {
            data[key] = localStorage.getItem(key);
          }
        }
        return data;
      }
    });
    return results?.[0]?.result || {};
  } catch (e) {
    throw new Error(`Не удалось прочитать localStorage вкладки Twitch: ${e.message}`);
  }
}

// FIX #3 (было: 'twilight-user' не парсился как JSON, извлекалось сырое значение)
// 'twilight-user' cookie/localStorage значение — это URL-encoded JSON вида
// {"authToken":"...","displayName":"...","id":"...","login":"..."}.
// Теперь пытаемся распарсить JSON и достать displayName, а если не получилось — login.
function extractUsernameFromTwilightUser(rawValue) {
  if (!rawValue) return null;
  let decoded = rawValue;
  try { decoded = decodeURIComponent(rawValue); } catch (_) { /* уже decoded или не нужно */ }

  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') {
      return parsed.displayName || parsed.login || null;
    }
  } catch (_) {
    // Не JSON — возможно это просто логин строкой (старый формат cookie 'login')
    return decoded;
  }
  return null;
}

async function captureCurrentAccount(label) {
  const cookies = await getAllTwitchCookies();
  if (!cookies.length) throw new Error('No Twitch cookies found. Are you logged in?');

  const authToken = cookies.find(c => c.name === 'auth-token');
  if (!authToken) throw new Error('auth-token not found. Make sure you are fully logged in to Twitch.');

  // Определяем имя пользователя: приоритет — явный label, затем twilight-user (JSON), затем login cookie
  let username = label && label.trim() ? label.trim() : null;

  if (!username) {
    const twilightUserCookie = cookies.find(c => c.name === 'twilight-user');
    if (twilightUserCookie) {
      username = extractUsernameFromTwilightUser(twilightUserCookie.value);
    }
  }
  if (!username) {
    const loginCookie = cookies.find(c => c.name === 'login');
    if (loginCookie) {
      try { username = decodeURIComponent(loginCookie.value); } catch (_) { username = loginCookie.value; }
    }
  }
  if (!username) username = `Account ${Date.now()}`;

  // Захватываем localStorage (может бросить исключение — пробрасываем понятную ошибку выше)
  let localStorageData = null;
  try {
    localStorageData = await captureLocalStorageFromTab();
  } catch (e) {
    // Не фатально для самого сохранения cookies, но сообщаем пользователю через console
    console.warn('[Twitch Alt Manager]', e.message);
  }

  // FIX #15 (было: decrypt/JSON.parse без отдельной обработки ошибок — актуально для switchToAccount,
  // здесь аналогично оборачиваем encrypt в try/catch с информативным сообщением)
  let encrypted;
  try {
    const payload = JSON.stringify({ cookies, localStorageData });
    encrypted = await encrypt(payload);
  } catch (e) {
    throw new Error(`Не удалось зашифровать данные аккаунта: ${e.message}`);
  }

  const accounts = await loadAccounts();
  const existingIdx = accounts.findIndex(a => a.username.toLowerCase() === username.toLowerCase());
  const account = {
    id: existingIdx >= 0 ? accounts[existingIdx].id : `acc_${Date.now()}`,
    username,
    capturedAt: Date.now(),
    cookieCount: cookies.length,
    hasLocalStorage: !!localStorageData && Object.keys(localStorageData).length > 0,
    encryptedCookies: encrypted
  };

  if (existingIdx >= 0) {
    accounts[existingIdx] = account;
  } else {
    accounts.push(account);
  }

  await saveAccounts(accounts);
  return account;
}

// FIX #13 (было: фиксированная задержка 150мс не гарантировала завершение очистки)
// Теперь ждём подтверждения (ok:true) от каждой вкладки через sendMessage с таймаутом,
// вместо угадывания задержки.
async function sendToAllTwitchTabsAndWait(msg, timeoutMs = 2000) {
  const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
  if (!tabs.length) return { tabs: [], acked: 0 };

  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
    ]);

  const results = await Promise.allSettled(
    tabs.map(tab => withTimeout(chrome.tabs.sendMessage(tab.id, msg), timeoutMs))
  );

  const acked = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;
  return { tabs, acked, results };
}

// FIX #7 (было: не проверялась успешность установки критичных cookies перед перезагрузкой)
// FIX #13 (синхронизация через sendMessage вместо фиксированной задержки)
// FIX #15 (отдельная обработка ошибок decrypt/JSON.parse с информативным сообщением)
// FIX #16 (pendingLocalStorage теперь привязан к id аккаунта, а не безусловный)
async function switchToAccount(accountId) {
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');

  // FIX #15: отдельная обработка ошибок расшифровки и парсинга
  let payload;
  try {
    const payloadJson = await decrypt(account.encryptedCookies);
    try {
      payload = JSON.parse(payloadJson);
    } catch (parseErr) {
      throw new Error(`Повреждённые данные аккаунта (JSON.parse не удался): ${parseErr.message}. Попробуй пересохранить аккаунт.`);
    }
  } catch (decryptErr) {
    if (decryptErr.message.includes('Повреждённые данные')) throw decryptErr;
    throw new Error(`Не удалось расшифровать данные аккаунта: ${decryptErr.message}. Возможно ключ шифрования был сброшен — пересохрани аккаунт.`);
  }

  const cookies = Array.isArray(payload) ? payload : payload.cookies;
  const localStorageData = Array.isArray(payload) ? null : payload.localStorageData;

  if (!cookies || !cookies.length) {
    throw new Error('В сохранённом аккаунте нет cookies. Пересохрани аккаунт.');
  }

  // Шаг 1: очистка localStorage/sessionStorage/IndexedDB во всех вкладках Twitch,
  // с ожиданием подтверждения от content script (вместо фиксированной задержки)
  await sendToAllTwitchTabsAndWait({ action: 'clearLocalStorage' }, 2000);

  // Шаг 2: удаляем текущие cookies
  await clearTwitchCookies();

  // Шаг 3: устанавливаем cookies целевого аккаунта
  const setReport = await setCookies(cookies);

  // FIX #7: проверяем, что критичный auth-token реально установился
  const authTokenSet = setReport.succeeded.includes('auth-token');
  if (!authTokenSet) {
    const failedAuth = setReport.failed.find(f => f.name === 'auth-token');
    throw new Error(
      `Не удалось установить ключевой cookie auth-token` +
      (failedAuth ? `: ${failedAuth.reason}` : '') +
      '. Переключение отменено, вкладки НЕ будут перезагружены.'
    );
  }

  // Шаг 4: помечаем аккаунт активным
  await chrome.storage.local.set({ activeAccountId: accountId });

  // FIX #16: pendingLocalStorage теперь хранит accountId, чтобы content script
  // не восстановил данные чужого аккаунта, если переключение произошло повторно
  // до того, как предыдущий pending был применён.
  if (localStorageData && Object.keys(localStorageData).length > 0) {
    await chrome.storage.local.set({
      pendingLocalStorage: {
        accountId,
        data: localStorageData,
        createdAt: Date.now()
      }
    });
  } else {
    await chrome.storage.local.remove('pendingLocalStorage');
  }

  return { account, setReport };
}

// FIX #8 (было: pendingLocalStorage не очищался при удалении аккаунта)
async function deleteAccount(accountId) {
  const accounts = await loadAccounts();
  const filtered = accounts.filter(a => a.id !== accountId);
  await saveAccounts(filtered);

  const { activeAccountId, pendingLocalStorage } = await chrome.storage.local.get(['activeAccountId', 'pendingLocalStorage']);

  if (activeAccountId === accountId) {
    await chrome.storage.local.remove('activeAccountId');
  }
  // Если pendingLocalStorage принадлежит удаляемому аккаунту — тоже чистим,
  // иначе может "прилипнуть" к следующему совпавшему аккаунту.
  if (pendingLocalStorage && pendingLocalStorage.accountId === accountId) {
    await chrome.storage.local.remove('pendingLocalStorage');
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.action) {
        case 'captureAccount': {
          const account = await captureCurrentAccount(msg.label);
          sendResponse({ ok: true, account });
          break;
        }
        case 'switchAccount': {
          const { account, setReport } = await switchToAccount(msg.accountId);
          // Перезагружаем вкладки ТОЛЬКО если auth-token успешно установлен
          // (проверка уже выполнена внутри switchToAccount — если дошли сюда, всё ок)
          const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
          for (const tab of tabs) {
            try { await chrome.tabs.reload(tab.id, { bypassCache: true }); } catch (_) {}
          }
          sendResponse({ ok: true, account, warnings: setReport.failed });
          break;
        }
        case 'deleteAccount': {
          await deleteAccount(msg.accountId);
          sendResponse({ ok: true });
          break;
        }
        case 'loadAccounts': {
          const accounts = await loadAccounts();
          const { activeAccountId } = await chrome.storage.local.get('activeAccountId');
          const safe = accounts.map(({ encryptedCookies, ...rest }) => rest);
          sendResponse({ ok: true, accounts: safe, activeAccountId });
          break;
        }
        case 'getCurrentCookieUser': {
          const cookies = await getAllTwitchCookies();
          const authToken = cookies.find(c => c.name === 'auth-token');
          const twilightUserCookie = cookies.find(c => c.name === 'twilight-user');
          const loginCookie = cookies.find(c => c.name === 'login');

          let username = null;
          if (twilightUserCookie) username = extractUsernameFromTwilightUser(twilightUserCookie.value);
          if (!username && loginCookie) {
            try { username = decodeURIComponent(loginCookie.value); } catch (_) { username = loginCookie.value; }
          }

          sendResponse({ ok: true, username, loggedIn: !!authToken });
          break;
        }
        case 'refreshAccount': {
          const accs = await loadAccounts();
          const existing = accs.find(a => a.id === msg.accountId);
          if (!existing) { sendResponse({ ok: false, error: 'Not found' }); break; }
          const account = await captureCurrentAccount(existing.username);
          sendResponse({ ok: true, account });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown action' });
      }
    } catch (e) {
      console.error('[Twitch Alt Manager] Ошибка обработки сообщения:', msg.action, e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

// FIX #6 (было: periodInMinutes: 0.4 — Chrome требует минимум 1 минуту, меньшие
// значения либо игнорируются, либо округляются, что делает alarm ненадёжным)
chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {
  // no-op: само создание alarm поддерживает service worker активным между тиками
});
