// background.js — Service Worker for Twitch Alt Manager
//
// ВАЖНО О БЕЗОПАСНОСТИ (см. README "Модель угроз"):
// Ключ шифрования хранится как non-extractable CryptoKey в IndexedDB.
// Это значит, что сами байты ключа НЕЛЬЗЯ прочитать даже кодом расширения —
// только использовать через crypto.subtle.encrypt/decrypt. Это существенно
// надёжнее, чем хранить сырые байты ключа в chrome.storage.local (как было
// раньше), но НЕ является полной защитой: код, выполняющийся в контексте
// самого расширения, всё ещё может вызвать decrypt(). Абсолютной защиты без
// участия внешнего секрета (например, мастер-пароля) не существует.

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

async function migrateLegacyKeyIfNeeded() {
  const stored = await chrome.storage.local.get('_enc_key');
  if (!stored._enc_key) return null;

  const nonExtractableKey = await crypto.subtle.importKey(
    'raw',
    new Uint8Array(stored._enc_key),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  await idbSetKey(nonExtractableKey);
  await chrome.storage.local.remove('_enc_key');
  console.info('[Twitch Alt Manager] Ключ шифрования мигрирован в IndexedDB (non-extractable).');
  return nonExtractableKey;
}

// НОВЫЙ FIX (проблема #3 из ревью, уточнённая версия): если в прошлый раз
// idbSetKey() успел записать новый ключ, но chrome.storage.local.remove('_enc_key')
// после этого упал (например, из-за временной ошибки storage), сырые байты
// старого ключа могли НАВСЕГДА остаться в открытом виде — потому что при
// следующем запуске idbGetKey() сразу найдёт уже готовый ключ и код никогда
// больше не дойдёт до миграции/очистки. Это не потеря данных (как описано в
// ревью), а обратная и более серьёзная проблема — утечка ключа. Подчищаем
// такой хвост при каждом "быстром" пути, когда ключ уже есть в IndexedDB.
function cleanupLegacyKeyBytesIfPresent() {
  chrome.storage.local.get('_enc_key').then(stored => {
    if (stored._enc_key) {
      chrome.storage.local.remove('_enc_key')
        .then(() => console.info('[Twitch Alt Manager] Удалены остаточные незашифрованные байты старого ключа.'))
        .catch(() => {});
    }
  }).catch(() => {});
}

let cachedKeyPromise = null;

async function getEncryptionKey() {
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    let key = await idbGetKey();
    if (key) {
      cleanupLegacyKeyBytesIfPresent(); // не блокирующий best-effort вызов
      return key;
    }

    key = await migrateLegacyKeyIfNeeded();
    if (key) return key;

    const newKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    await idbSetKey(newKey);
    return newKey;
  })();

  cachedKeyPromise.catch(() => { cachedKeyPromise = null; });
  return cachedKeyPromise;
}

async function encrypt(text) {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(text);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(ciphertext)) };
}

async function decrypt(encObj) {
  const key = await getEncryptionKey();
  const iv = new Uint8Array(encObj.iv);
  const data = new Uint8Array(encObj.data);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ─── Cookie helpers ───────────────────────────────────────────────────────────

// FIX (проблема #14): ошибки отдельных доменных запросов теперь логируются,
// а не молча пропускаются.
async function getAllTwitchCookies() {
  const domainsToQuery = [
    '.twitch.tv', 'twitch.tv', 'www.twitch.tv',
    'id.twitch.tv', 'passport.twitch.tv', 'gql.twitch.tv'
  ];

  const results = await Promise.allSettled(
    domainsToQuery.map(domain => chrome.cookies.getAll({ domain }))
  );

  const merged = new Map();
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.warn(`[Twitch Alt Manager] Не удалось получить cookies для домена "${domainsToQuery[i]}":`, r.reason?.message || r.reason);
      return;
    }
    for (const c of r.value) {
      merged.set(`${c.name}|${c.domain}|${c.path}`, c);
    }
  });
  return Array.from(merged.values());
}

// Проверено: если домен начинается с точки — www.<домен без точки>
// (Twitch редиректит apex-домен на www); для остальных доменов — как есть.
function cookieUrl(c) {
  if (c.domain.startsWith('.')) {
    return `https://www.${c.domain.substring(1)}${c.path || '/'}`;
  }
  return `https://${c.domain}${c.path || '/'}`;
}

// FIX (проблемы #1/#11): теперь возвращаем и логируем ПРИЧИНЫ неудач.
// Уточнение: chrome.cookies.remove() возвращает null и когда cookie уже
// отсутствовал — это НЕ ошибка (желаемое состояние и так достигнуто), поэтому
// неудачей считаем только реальный reject промиса, а не null.
async function clearTwitchCookies() {
  const cookies = await getAllTwitchCookies();
  const results = await Promise.allSettled(
    cookies.map(c => chrome.cookies.remove({ url: cookieUrl(c), name: c.name }))
  );

  const failedDetails = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const c = cookies[i];
      failedDetails.push({ name: c.name, domain: c.domain, reason: r.reason?.message || String(r.reason) });
    }
  });

  if (failedDetails.length > 0) {
    console.warn('[Twitch Alt Manager] Не удалось удалить некоторые cookies:', failedDetails);
  }

  return { removed: cookies.length - failedDetails.length, failed: failedDetails.length, failedDetails };
}

function computeExpirationDate(originalExpirationDate) {
  if (!originalExpirationDate) return undefined; // сессионный cookie — не трогаем

  const now = Date.now() / 1000;
  const thirtyDaysFromNow = now + 60 * 60 * 24 * 30;

  // Инвариант: setCookies() уже отфильтровал истёкшие cookies ДО вызова этой
  // функции (см. ниже), так что originalExpirationDate здесь обычно в будущем.
  // Ветка ниже — защитный фолбэк на случай прямого вызова функции откуда-то ещё.
  if (originalExpirationDate <= now) return originalExpirationDate;
  if (originalExpirationDate < thirtyDaysFromNow) return thirtyDaysFromNow;
  return originalExpirationDate;
}

// FIX (свежий разбор проблемы #2): раньше уже истёкший на момент сохранения
// cookie всё равно передавался в chrome.cookies.set(). Вызов при этом мог
// формально "успешно" вернуть объект (result !== null), хотя браузер тут же
// удаляет cookie с истёкшим expirationDate — из-за чего наша проверка
// критичных cookies могла посчитать его установленным, хотя по факту его нет.
// Теперь такие cookies пропускаются ДО вызова set() и явно помечаются как
// failed с понятной причиной.
async function setCookies(cookieList) {
  const report = { succeeded: [], failed: [] };
  const now = Date.now() / 1000;

  for (const c of cookieList) {
    try {
      if (c.expirationDate && c.expirationDate <= now) {
        report.failed.push({ name: c.name, domain: c.domain, reason: 'cookie истёк на момент сохранения аккаунта — установка пропущена' });
        continue;
      }

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
      if (expirationDate !== undefined) details.expirationDate = expirationDate;

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

// FIX (проблема #19): более понятное сообщение при переполнении хранилища,
// вместо сырого технического текста ошибки Chrome.
async function saveAccounts(accounts) {
  try {
    await chrome.storage.local.set({ accounts });
  } catch (e) {
    if (/quota/i.test(e.message || '')) {
      throw new Error('Не хватает места в локальном хранилище расширения. Удали несколько старых аккаунтов и попробуй снова.');
    }
    throw e;
  }
}

// FIX (проблема #7): раньше собирались ВСЕ ключи localStorage/sessionStorage,
// содержащие подстроки auth/token/session/login/persist, без ограничения
// размера — это могло утащить мегабайты стороннего кэша (например,
// redux-persist кладёт под ключи с "persist" гигантские блобы). Теперь:
//   - каждое значение проверяется на размер (MAX_KEY_VALUE_BYTES), слишком
//     большие значения пропускаются (легитимные auth-токены/JWT — это обычно
//     от сотен байт до нескольких КБ, не сотни КБ);
//   - лимит передаётся в изолированный контекст страницы через args, а не
//     через замыкание — chrome.scripting.executeScript сериализует функцию
//     отдельно и НЕ имеет доступа к переменным background.js.
const MAX_KEY_VALUE_BYTES = 20 * 1024; // 20 КБ на одно значение
const MAX_ACCOUNT_PAYLOAD_BYTES = 500 * 1024; // 500 КБ на аккаунт целиком

async function captureStorageFromActiveTab() {
  const activeTabs = await chrome.tabs.query({
    url: ['*://*.twitch.tv/*'],
    active: true,
    currentWindow: true
  });

  if (!activeTabs.length) {
    throw new Error(
      'Открой Twitch (twitch.tv) в АКТИВНОЙ вкладке текущего окна и повтори сохранение.'
    );
  }

  const tab = activeTabs[0];

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [MAX_KEY_VALUE_BYTES],
      func: (maxBytes) => {
        const collect = (storage) => {
          const data = {};
          const consider = (key, val) => {
            if (val == null || key in data) return;
            const bytes = new TextEncoder().encode(val).length;
            if (bytes > maxBytes) {
              console.warn(`[Twitch Alt Manager] Пропущен ключ "${key}" — слишком большой (${bytes} байт), не похоже на сессионные данные`);
              return;
            }
            data[key] = val;
          };
          const sensitiveKeys = ['twilight-user', 'login', 'auth-token', 'persistent', 'api_token', 'server_session_id'];
          for (const key of sensitiveKeys) consider(key, storage.getItem(key));
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key && ['auth', 'token', 'session', 'login', 'persist'].some(p => key.toLowerCase().includes(p))) {
              consider(key, storage.getItem(key));
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

function extractUsernameFromTwilightUser(rawValue) {
  if (!rawValue) return null;
  let decoded = rawValue;
  try { decoded = decodeURIComponent(rawValue); } catch (_) {}

  try {
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === 'object') {
      return parsed.displayName || parsed.login || null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// FIX (проблема #13): раньше пользовательский label (если указан) становился
// ЕДИНСТВЕННЫМ username аккаунта — и именно с ним потом сравнивался реальный
// логин из cookies в refreshAccount. Если пользователь называл аккаунт не так,
// как его реальный Twitch-логин ("Основной", "Alt2"), сравнение НИКОГДА не
// совпадало, и кнопка обновления сессии переставала работать для этого
// аккаунта навсегда. Теперь реальный логин (twitchLogin) определяется ВСЕГДА
// из cookies независимо от label, и используется для дедупликации/сравнения;
// label становится только отображаемым именем (username/displayName).
async function captureCurrentAccount(label) {
  const cookies = await getAllTwitchCookies();
  if (!cookies.length) throw new Error('No Twitch cookies found. Are you logged in?');

  const authToken = cookies.find(c => c.name === 'auth-token');
  if (!authToken) throw new Error('auth-token not found. Make sure you are fully logged in to Twitch.');

  let twitchLogin = null;
  const twilightUserCookie = cookies.find(c => c.name === 'twilight-user');
  if (twilightUserCookie) twitchLogin = extractUsernameFromTwilightUser(twilightUserCookie.value);
  if (!twitchLogin) {
    const loginCookie = cookies.find(c => c.name === 'login');
    if (loginCookie) {
      try { twitchLogin = decodeURIComponent(loginCookie.value); } catch (_) { twitchLogin = loginCookie.value; }
    }
  }

  const customLabel = label && label.trim() ? label.trim() : null;

  if (!twitchLogin && !customLabel) {
    throw new Error(
      'Не удалось автоматически определить логин Twitch из cookies. ' +
      'Укажи имя аккаунта вручную в поле «Имя аккаунта» и повтори сохранение.'
    );
  }

  const displayName = customLabel || twitchLogin;
  const identityKey = (twitchLogin || customLabel).toLowerCase();

  const { localStorageData, sessionStorageData } = await captureStorageFromActiveTab();

  const payload = JSON.stringify({ cookies, localStorageData, sessionStorageData });
  const payloadSizeBytes = new TextEncoder().encode(payload).length;
  if (payloadSizeBytes > MAX_ACCOUNT_PAYLOAD_BYTES) {
    throw new Error(
      `Данные аккаунта слишком велики (${Math.round(payloadSizeBytes / 1024)} КБ, лимит ${Math.round(MAX_ACCOUNT_PAYLOAD_BYTES / 1024)} КБ). ` +
      'Похоже, страница Twitch накопила лишние данные в localStorage/sessionStorage.'
    );
  }

  let encrypted;
  try {
    encrypted = await encrypt(payload);
  } catch (e) {
    throw new Error(`Не удалось зашифровать данные аккаунта: ${e.message}`);
  }

  const accounts = await loadAccounts();
  const existingIdx = accounts.findIndex(a => (a.twitchLogin || a.username || '').toLowerCase() === identityKey);
  const account = {
    id: existingIdx >= 0 ? accounts[existingIdx].id : `acc_${Date.now()}`,
    username: displayName,
    twitchLogin: twitchLogin || null,
    capturedAt: Date.now(),
    cookieCount: cookies.length,
    hasLocalStorage: !!localStorageData && Object.keys(localStorageData).length > 0,
    hasSessionStorage: !!sessionStorageData && Object.keys(sessionStorageData).length > 0,
    encryptedCookies: encrypted
  };

  if (existingIdx >= 0) accounts[existingIdx] = account;
  else accounts.push(account);

  await saveAccounts(accounts);
  return account;
}

// FIX (проблема #15): таймаут поднят до 3000мс (внутренний таймаут очистки
// IndexedDB в content.js — 1500мс на 4 базы параллельно, т.е. ~1500мс худший
// случай; старые 2000мс снаружи оставляли только ~500мс запаса на само
// сообщение и цикл по localStorage — маловато). Плюс теперь логируем, какие
// именно вкладки не подтвердили очистку вовремя.
async function sendToAllTwitchTabsAndWait(msg, timeoutMs = 3000) {
  const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
  if (!tabs.length) return { tabs: [], acked: 0 };

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);

  const results = await Promise.allSettled(
    tabs.map(tab => withTimeout(chrome.tabs.sendMessage(tab.id, msg), timeoutMs))
  );

  const acked = results.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;

  if (acked < tabs.length) {
    const failedTabIds = tabs.filter((_, i) => !(results[i].status === 'fulfilled' && results[i].value?.ok)).map(t => t.id);
    console.warn(`[Twitch Alt Manager] ${tabs.length - acked} из ${tabs.length} вкладок не подтвердили очистку вовремя:`, failedTabIds);
  }

  return { tabs, acked, results };
}

// FIX (проблема #4, обобщено): вместо того чтобы гадать наперёд все возможные
// будущие критичные cookies Twitch, дополнительно проверяем ЛЮБОЙ cookie, чьё
// имя выглядит "авторизационным" по паттерну — это ловит и гипотетический
// будущий client_id, и вообще любое новое auth-related имя, которого нет
// в жёстком списке.
const CRITICAL_COOKIE_NAMES = ['auth-token', 'twilight-user', 'login', 'persistent', 'api_token', 'server_session_id'];
const AUTH_LIKE_PATTERN = /(auth|token|session|login|persist)/i;

async function switchToAccount(accountId) {
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');

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

  // FIX (проблема #12): снимок ТЕКУЩИХ cookies до их удаления — чтобы можно
  // было откатиться, если установка нового набора провалится по критичным
  // cookies. Раньше в этом случае пользователь оставался вообще без сессии:
  // старая уже стёрта, новая не встала.
  const previousCookiesSnapshot = await getAllTwitchCookies();

  await sendToAllTwitchTabsAndWait({ action: 'clearLocalStorage' }, 3000);

  const clearResult = await clearTwitchCookies();
  if (clearResult.failedDetails.length) {
    console.warn('[Twitch Alt Manager] Не удалось удалить некоторые старые cookies перед переключением:', clearResult.failedDetails);
  }

  const setReport = await setCookies(cookies);

  const relevantCritical = CRITICAL_COOKIE_NAMES.filter(name => cookies.some(c => c.name === name));
  const missingCritical = relevantCritical.filter(name => !setReport.succeeded.includes(name));
  const missingAuthLike = setReport.failed.filter(f => AUTH_LIKE_PATTERN.test(f.name) && !missingCritical.includes(f.name));
  const allMissingNames = [...missingCritical, ...missingAuthLike.map(f => f.name)];

  async function rollback(reason) {
    console.warn(`[Twitch Alt Manager] Откат к предыдущей сессии (${reason})`);
    try {
      await clearTwitchCookies();
      await setCookies(previousCookiesSnapshot);
      console.info('[Twitch Alt Manager] Откат выполнен.');
    } catch (rollbackErr) {
      console.error('[Twitch Alt Manager] Откат тоже не удался:', rollbackErr);
    }
  }

  if (allMissingNames.length > 0) {
    await rollback('не установились критичные cookies');
    const details = allMissingNames
      .map(name => {
        const f = setReport.failed.find(x => x.name === name);
        return f ? `${name} (${f.reason})` : name;
      })
      .join(', ');
    throw new Error(
      `Не удалось установить критичные cookies: ${details}. Была предпринята попытка вернуть предыдущую сессию. Вкладки НЕ будут перезагружены — проверь вход вручную.`
    );
  }

  // FIX (свежий разбор проблемы #2): успешный chrome.cookies.set() не значит,
  // что cookie реально остался в браузере (могли сработать тихие причины —
  // например, тонкости domain/SameSite). Перепроверяем фактическое наличие.
  const verifyCookies = await getAllTwitchCookies();
  const stillMissingAfterVerify = relevantCritical.filter(
    name => !verifyCookies.some(c => c.name === name && c.value)
  );

  if (stillMissingAfterVerify.length > 0) {
    await rollback('cookies не удержались при повторной проверке');
    throw new Error(
      `Cookies (${stillMissingAfterVerify.join(', ')}) не удержались в браузере после установки. ` +
      'Попробуй пересохранить этот аккаунт заново после входа в него.'
    );
  }

  await chrome.storage.local.set({ activeAccountId: accountId });

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

// FIX (проблема #9): раньше удаление несуществующего accountId молча
// завершалось "успешно". Теперь явная проверка и ошибка.
async function deleteAccount(accountId) {
  const accounts = await loadAccounts();
  if (!accounts.some(a => a.id === accountId)) {
    throw new Error('Аккаунт не найден (возможно, уже был удалён).');
  }

  const filtered = accounts.filter(a => a.id !== accountId);
  await saveAccounts(filtered);

  const { activeAccountId, pendingStorageData } = await chrome.storage.local.get(['activeAccountId', 'pendingStorageData']);
  if (activeAccountId === accountId) await chrome.storage.local.remove('activeAccountId');
  if (pendingStorageData && pendingStorageData.accountId === accountId) await chrome.storage.local.remove('pendingStorageData');
}

// ─── Message handler ──────────────────────────────────────────────────────────

// FIX (проблема #8, настоящая причина): гонка была не столько в
// pendingStorageData (он и раньше был защищён привязкой к accountId), сколько
// в том, что ДВА параллельных switchToAccount() могут перемежать вызовы
// chrome.cookies.remove/set друг друга — например, второе переключение может
// удалить cookie, который первое только что установило, прямо посреди цикла
// первого. Результат — гибридная, нерабочая сессия, не принадлежащая ни
// одному аккаунту. Та же гонка теоретически возможна и для самой первой
// инициализации ключа шифрования (два одновременных вызова getEncryptionKey()
// из разных сообщений могли бы сгенерировать два РАЗНЫХ ключа). Решение —
// общая FIFO-очередь для всех операций, которые МЕНЯЮТ состояние
// (captureAccount/switchAccount/deleteAccount/refreshAccount): они всегда
// выполняются строго по одной, в порядке поступления. Операции только на
// чтение (loadAccounts/getCurrentCookieUser) через очередь не проходят —
// незачем тормозить UI ради чтения.
const MUTATING_ACTIONS = new Set(['captureAccount', 'switchAccount', 'deleteAccount', 'refreshAccount']);

let mutationQueueTail = Promise.resolve();
function runExclusive(fn) {
  const run = mutationQueueTail.then(fn, fn); // выполняем fn независимо от исхода предыдущей операции
  mutationQueueTail = run.catch(() => {});    // одна ошибка не должна остановить очередь для следующих
  return run;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const task = async () => {
    try {
      switch (msg.action) {
        case 'captureAccount': {
          const account = await captureCurrentAccount(msg.label);
          sendResponse({ ok: true, account });
          break;
        }
        case 'switchAccount': {
          const { account, setReport } = await switchToAccount(msg.accountId);

          // FIX (свежий разбор): раньше ошибки chrome.tabs.reload() тихо
          // проглатывались (catch(_){}), и popup всегда получал "успех", даже
          // если ВСЕ перезагрузки вкладок провалились.
          const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
          let reloadFailures = 0;
          for (const tab of tabs) {
            try {
              await chrome.tabs.reload(tab.id, { bypassCache: true });
            } catch (e) {
              reloadFailures++;
              console.warn(`[Twitch Alt Manager] Не удалось перезагрузить вкладку ${tab.id}:`, e.message);
            }
          }

          sendResponse({ ok: true, account, warnings: setReport.failed, reloadFailures, totalTabs: tabs.length });
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
  };

  if (MUTATING_ACTIONS.has(msg.action)) {
    runExclusive(task);
  } else {
    task();
  }

  return true; // async response
});
