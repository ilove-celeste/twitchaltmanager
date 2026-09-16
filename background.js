// background.js — Service Worker for Twitch Alt Manager
//
// ВАЖНО О БЕЗОПАСНОСТИ (см. README "Модель угроз"):
// Ключ шифрования хранится как non-extractable CryptoKey в IndexedDB.
// Это значит, что сами байты ключа НЕЛЬЗЯ прочитать даже кодом расширения —
// только использовать через crypto.subtle.encrypt/decrypt. Это существенно
// надёжнее, чем хранить сырые байты ключа в chrome.storage.local (как было
// раньше), но НЕ является полной защитой: код, выполняющийся в контексте
// самого расширения (например, при компрометации браузера в целом или через
// remote debugging), всё ещё может вызвать decrypt(). Абсолютной защиты без
// участия внешнего секрета (например, мастер-пароля) не существует —
// это фундаментальное ограничение любого локального хранилища расширений.

// ─── Хранилище ключа шифрования (IndexedDB, non-extractable CryptoKey) ───────

const KEY_DB_NAME     = 'TwitchAltManagerKeyDB';
const KEY_DB_VERSION  = 1;
const KEY_STORE_NAME  = 'keys';
const KEY_RECORD_ID   = 'main';

function openKeyDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(KEY_DB_NAME, KEY_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetKey() {
  return openKeyDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readonly');
    const store = tx.objectStore(KEY_STORE_NAME);
    const req = store.get(KEY_RECORD_ID);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  }));
}

function idbSetKey(cryptoKey) {
  return openKeyDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE_NAME, 'readwrite');
    const store = tx.objectStore(KEY_STORE_NAME);
    const req = store.put(cryptoKey, KEY_RECORD_ID);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

// FIX #1: миграция со старой схемы (сырые байты ключа в chrome.storage.local)
// на новую (non-extractable CryptoKey в IndexedDB). Импортируем старые байты
// как non-extractable ключ — это НЕ теряет доступ к уже сохранённым аккаунтам
// (ключ математически тот же), но после этого сырые байты удаляются из
// chrome.storage.local и больше нигде не хранятся в читаемом виде.
async function migrateLegacyKeyIfNeeded() {
  const stored = await chrome.storage.local.get('_enc_key');
  if (!stored._enc_key) return null;

  const nonExtractableKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(stored._enc_key),
    { name: 'AES-GCM' },
    false, // non-extractable — с этого момента байты ключа нельзя достать обратно
    ['encrypt', 'decrypt']
  );

  await idbSetKey(nonExtractableKey);
  await chrome.storage.local.remove('_enc_key');
  console.info('[Twitch Alt Manager] Ключ шифрования мигрирован в защищённое хранилище (non-extractable, IndexedDB). Старые аккаунты остаются доступны.');
  return nonExtractableKey;
}

// Кэш промиса ключа в памяти service worker (сбрасывается при рестарте SW —
// это нормально, следующий вызов просто заново прочитает ключ из IndexedDB).
let cachedKeyPromise = null;

async function getEncryptionKey() {
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    let key = await idbGetKey();
    if (key) return key;

    key = await migrateLegacyKeyIfNeeded();
    if (key) return key;

    // Ключа нигде нет — создаём новый non-extractable ключ
    const newKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt']
    );
    await idbSetKey(newKey);
    return newKey;
  })();

  // Если инициализация ключа провалилась — не кэшируем провалившийся промис,
  // иначе все последующие вызовы будут падать даже после устранения причины.
  cachedKeyPromise.catch(() => { cachedKeyPromise = null; });

  return cachedKeyPromise;
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

// Запрашиваем cookies по нескольким доменам Twitch и объединяем без дублей.
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

// Разобрано и подтверждено корректным (пункт "5" из списка проблем не является
// багом): если домен начинается с точки — используем www.<домен без точки>
// (Twitch редиректит apex-домен на www); для остальных доменов (id., passport.,
// gql. и т.д.) используем домен как есть, без модификаций.
function cookieUrl(c) {
  if (c.domain.startsWith('.')) {
    const domainWithoutDot = c.domain.substring(1);
    return `https://www.${domainWithoutDot}${c.path || '/'}`;
  }
  return `https://${c.domain}${c.path || '/'}`;
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

// FIX #4: продление срока действия cookies было некорректным — раньше ЛЮБОЙ
// cookie (даже уже истёкший) продлевался минимум на 30 дней вперёд. Теперь:
//   - сессионные cookies (без expirationDate) остаются сессионными;
//   - уже истёкшие (expirationDate <= now) НЕ продлеваются — оставляем как есть
//     (такой cookie не имеет смысла "оживлять" локально: сервер Twitch всё
//     равно будет ориентироваться на собственную валидность сессии, а
//     искусственное продление создаёт ложное ощущение рабочей сессии);
//   - валидные cookies с оставшимся сроком МЕНЬШЕ 30 дней — продлеваем до 30 дней;
//   - валидные cookies с оставшимся сроком БОЛЬШЕ 30 дней — оставляем как есть.
function computeExpirationDate(originalExpirationDate) {
  if (!originalExpirationDate) return undefined; // сессионный cookie — не трогаем

  const now = Date.now() / 1000;
  const thirtyDaysFromNow = now + 60 * 60 * 24 * 30;

  if (originalExpirationDate <= now) {
    // Уже истёк — не продлеваем искусственно
    return originalExpirationDate;
  }
  if (originalExpirationDate < thirtyDaysFromNow) {
    // Валиден, но срок короче 30 дней — продлеваем
    return thirtyDaysFromNow;
  }
  // Валиден и уже дольше 30 дней — оставляем оригинальный срок
  return originalExpirationDate;
}

async function setCookies(cookieList) {
  const report = { succeeded: [], failed: [] };

  for (const c of cookieList) {
    try {
      const url = cookieUrl(c);
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

      const expirationDate = computeExpirationDate(c.expirationDate);
      if (expirationDate !== undefined) {
        details.expirationDate = expirationDate;
      }
      // Если expirationDate === undefined — намеренно НЕ добавляем поле,
      // cookie останется сессионным (как и был изначально).

      const result = await chrome.cookies.set(details);

      if (result === null) {
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

// FIX #6: раньше при отсутствии активной вкладки Twitch расширение молча
// брало "любую" открытую вкладку Twitch (даже фоновую/неактивную), что могло
// привести к сохранению данных не того контекста, который пользователь имел
// в виду. Теперь требуем строго активную вкладку в текущем окне.
//
// FIX #2: теперь захватываем не только localStorage, но и sessionStorage.
async function captureStorageFromActiveTab() {
  const activeTabs = await chrome.tabs.query({
    url: ['*://*.twitch.tv/*'],
    active: true,
    currentWindow: true
  });

  if (!activeTabs.length) {
    throw new Error(
      'Открой Twitch (twitch.tv) в АКТИВНОЙ вкладке текущего окна и повтори сохранение. ' +
      'Фоновые/неактивные вкладки Twitch не используются намеренно, чтобы не захватить не тот контекст.'
    );
  }

  const tab = activeTabs[0];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const collect = (storage) => {
          const data = {};
          const sensitiveKeys = ['twilight-user', 'login', 'auth-token', 'persistent', 'api_token', 'server_session_id'];
          for (const key of sensitiveKeys) {
            const val = storage.getItem(key);
            if (val) data[key] = val;
          }
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key && ['auth', 'token', 'session', 'login', 'persist'].some(p => key.toLowerCase().includes(p))) {
              data[key] = storage.getItem(key);
            }
          }
          return data;
        };
        return {
          localStorageData: collect(localStorage),
          sessionStorageData: collect(sessionStorage)
        };
      }
    });
    return results?.[0]?.result || { localStorageData: {}, sessionStorageData: {} };
  } catch (e) {
    throw new Error(`Не удалось прочитать localStorage/sessionStorage вкладки Twitch: ${e.message}`);
  }
}

// FIX #7: раньше при неудачном JSON.parse возвращалось "декодированное" сырое
// значение вместо null — это могло привести к сохранению мусорной строки как
// имени пользователя. Теперь при неудаче парсинга JSON возвращаем null.
function extractUsernameFromTwilightUser(rawValue) {
  if (!rawValue) return null;
  let decoded = rawValue;
  try { decoded = decodeURIComponent(rawValue); } catch (_) { /* уже decoded */ }

  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') {
      return parsed.displayName || parsed.login || null;
    }
    return null;
  } catch (_) {
    // Не валидный JSON — раньше здесь возвращалось "decoded" (сырая строка),
    // теперь явно null, т.к. современный формат 'twilight-user' — это JSON,
    // и невозможность его распарсить означает, что доверять значению нельзя.
    return null;
  }
}

// FIX #7/#8: раньше при неудаче автоопределения имени подставлялся
// `Account ${Date.now()}` — это создавало бессмысленные, неотличимые друг от
// друга записи. Теперь в таком случае бросаем понятную ошибку с просьбой
// указать имя вручную (поле label в попапе).
async function captureCurrentAccount(label) {
  const cookies = await getAllTwitchCookies();
  if (!cookies.length) throw new Error('No Twitch cookies found. Are you logged in?');

  const authToken = cookies.find(c => c.name === 'auth-token');
  if (!authToken) throw new Error('auth-token not found. Make sure you are fully logged in to Twitch.');

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
  if (!username) {
    throw new Error(
      'Не удалось автоматически определить имя пользователя из cookies. ' +
      'Укажи имя аккаунта вручную в поле «Имя аккаунта» и повтори сохранение.'
    );
  }

  // FIX #6/#2: строго активная вкладка, localStorage + sessionStorage
  const { localStorageData, sessionStorageData } = await captureStorageFromActiveTab();

  let encrypted;
  try {
    const payload = JSON.stringify({ cookies, localStorageData, sessionStorageData });
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
    hasSessionStorage: !!sessionStorageData && Object.keys(sessionStorageData).length > 0,
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

// FIX #3: список "критичных" cookies, БЕЗ которых сессия точно не будет
// работать. Проверяем динамически: только те критичные имена, которые
// реально присутствовали в исходном сохранённом наборе (некоторые аккаунты
// могут не иметь, например, api_token — тогда его отсутствие не считается
// ошибкой).
const CRITICAL_COOKIE_NAMES = ['auth-token', 'twilight-user', 'login', 'persistent', 'api_token', 'server_session_id'];

async function switchToAccount(accountId) {
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');

  // FIX: отдельная обработка ошибок decrypt и JSON.parse с информативными сообщениями
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
  const sessionStorageData = Array.isArray(payload) ? null : payload.sessionStorageData;

  if (!cookies || !cookies.length) {
    throw new Error('В сохранённом аккаунте нет cookies. Пересохрани аккаунт.');
  }

  // Шаг 1: очистка localStorage/sessionStorage/IndexedDB во всех вкладках Twitch
  await sendToAllTwitchTabsAndWait({ action: 'clearLocalStorage' }, 2000);

  // Шаг 2: удаляем текущие cookies
  await clearTwitchCookies();

  // Шаг 3: устанавливаем cookies целевого аккаунта
  const setReport = await setCookies(cookies);

  // FIX #3: проверяем ВСЕ критичные cookies, которые реально были в наборе,
  // а не только auth-token
  const relevantCritical = CRITICAL_COOKIE_NAMES.filter(name => cookies.some(c => c.name === name));
  const missingCritical = relevantCritical.filter(name => !setReport.succeeded.includes(name));

  if (missingCritical.length > 0) {
    const details = missingCritical
      .map(name => {
        const f = setReport.failed.find(x => x.name === name);
        return f ? `${name} (${f.reason})` : name;
      })
      .join(', ');
    throw new Error(
      `Не удалось установить критичные cookies: ${details}. ` +
      'Переключение отменено, вкладки НЕ будут перезагружены.'
    );
  }

  // Шаг 4: помечаем аккаунт активным
  await chrome.storage.local.set({ activeAccountId: accountId });

  // FIX #2/#16: pendingStorageData содержит и localStorage, и sessionStorage,
  // привязанные к accountId (чтобы content script не восстановил данные не
  // того аккаунта при гонке между несколькими быстрыми переключениями).
  const hasLocal = localStorageData && Object.keys(localStorageData).length > 0;
  const hasSession = sessionStorageData && Object.keys(sessionStorageData).length > 0;

  if (hasLocal || hasSession) {
    await chrome.storage.local.set({
      pendingStorageData: {
        accountId,
        localStorageData: hasLocal ? localStorageData : {},
        sessionStorageData: hasSession ? sessionStorageData : {},
        createdAt: Date.now()
      }
    });
  } else {
    await chrome.storage.local.remove('pendingStorageData');
  }

  return { account, setReport };
}

async function deleteAccount(accountId) {
  const accounts = await loadAccounts();
  const filtered = accounts.filter(a => a.id !== accountId);
  await saveAccounts(filtered);

  const { activeAccountId, pendingStorageData } = await chrome.storage.local.get(['activeAccountId', 'pendingStorageData']);

  if (activeAccountId === accountId) {
    await chrome.storage.local.remove('activeAccountId');
  }
  if (pendingStorageData && pendingStorageData.accountId === accountId) {
    await chrome.storage.local.remove('pendingStorageData');
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

// FIX #13: разрешение "alarms" и периодический keep-alive удалены.
// В Manifest V3 service worker автоматически просыпается на события
// (chrome.runtime.onMessage, клик по иконке popup и т.д.), а вызовы chrome.*
// API (cookies.set, tabs.reload и т.д.) сами по себе продлевают жизнь SW на
// время выполнения. Наша самая долгая операция (switchToAccount) занимает
// секунды, а не десятки секунд простоя — искусственный keep-alive через
// alarms здесь не даёт практической пользы, только лишнее разрешение в
// manifest.json и лишний тик каждую минуту.
