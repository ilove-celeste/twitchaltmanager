// background.js — Service Worker for Twitch Alt Manager
// Handles cookie capture, account switching, and encrypted storage

const TWITCH_DOMAINS = ['.twitch.tv', 'twitch.tv', 'www.twitch.tv', 'passport.twitch.tv'];

// Key cookie names that identify a Twitch session
const SESSION_COOKIES = [
  'auth-token',
  'login',
  'twilight-user',
  'persistent',
  'api_token',
  'unique_id',
  'unique_id_durable',
  'device_id',
  'server_session_id',
  'twitch.lohp.countryCode',
  'ab-session-v2',
  'ab-testing-v2',
  'eu-cookie-accepted-v2'
];

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

async function getAllTwitchCookies() {
  const cookies = await chrome.cookies.getAll({ domain: 'twitch.tv' });
  return cookies;
}

async function clearTwitchCookies() {
  const cookies = await getAllTwitchCookies();
  const removals = cookies.map(c => {
    const url = `https://${c.domain.startsWith('.') ? 'www' : ''}${c.domain.startsWith('.') ? c.domain.substring(1) : c.domain}${c.path}`;
    return chrome.cookies.remove({ url, name: c.name });
  });
  await Promise.allSettled(removals);
}

async function setCookies(cookieList) {
  for (const c of cookieList) {
    try {
      const domain = c.domain || '.twitch.tv';
      const url = `https://${domain.startsWith('.') ? 'www' : ''}${domain.startsWith('.') ? domain.substring(1) : domain}${c.path || '/'}`;
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
        // Refresh expiry to 30 days from now so session doesn't expire
        details.expirationDate = Math.max(c.expirationDate, Date.now() / 1000 + 60 * 60 * 24 * 30);
      }
      await chrome.cookies.set(details);
    } catch (e) {
      // Some cookies may fail (httpOnly from content script, etc.) — skip silently
    }
  }
}

// ─── Account storage ──────────────────────────────────────────────────────────

async function loadAccounts() {
  const { accounts } = await chrome.storage.local.get('accounts');
  return accounts || [];
}

async function saveAccounts(accounts) {
  await chrome.storage.local.set({ accounts });
}

async function captureLocalStorageFromTab() {
  // Grab localStorage keys from the active Twitch tab via scripting API
  try {
    const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'], active: true, currentWindow: true });
    const tab = tabs[0] || (await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] }))[0];
    if (!tab) return null;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const data = {};
        const sensitiveKeys = ['twilight-user', 'login', 'auth-token', 'persistent', 'api_token', 'server_session_id'];
        for (const key of sensitiveKeys) {
          const val = localStorage.getItem(key);
          if (val) data[key] = val;
        }
        // Also capture any key matching auth/token/session/login pattern
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && ['auth','token','session','login','persist'].some(p => key.toLowerCase().includes(p))) {
            data[key] = localStorage.getItem(key);
          }
        }
        return data;
      }
    });
    return results?.[0]?.result || null;
  } catch (e) {
    return null; // scripting may fail if no Twitch tab active — not fatal
  }
}

async function captureCurrentAccount(label) {
  const cookies = await getAllTwitchCookies();
  if (!cookies.length) throw new Error('No Twitch cookies found. Are you logged in?');

  // Try to find login name from cookies
  const loginCookie = cookies.find(c => c.name === 'login' || c.name === 'twilight-user');
  let username = label;
  if (!username && loginCookie) {
    username = loginCookie.value;
    try { username = decodeURIComponent(username); } catch (_) {}
  }
  if (!username) username = `Account ${Date.now()}`;

  // Check if auth-token exists
  const authToken = cookies.find(c => c.name === 'auth-token');
  if (!authToken) throw new Error('auth-token not found. Make sure you are fully logged in to Twitch.');

  // Also capture localStorage (Twitch stores session data there too)
  const localStorageData = await captureLocalStorageFromTab();

  // Encrypt cookie + localStorage data together
  const payload = JSON.stringify({ cookies, localStorageData });
  const encrypted = await encrypt(payload);

  const accounts = await loadAccounts();

  // Check if account with same username already exists — update it
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

async function sendToAllTwitchTabs(msg) {
  const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
  const results = await Promise.allSettled(
    tabs.map(tab => chrome.tabs.sendMessage(tab.id, msg))
  );
  return { tabs, results };
}

async function switchToAccount(accountId) {
  const accounts = await loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) throw new Error('Account not found');

  const payloadJson = await decrypt(account.encryptedCookies);
  const payload = JSON.parse(payloadJson);

  // Support both old format (array of cookies) and new format ({cookies, localStorageData})
  const cookies = Array.isArray(payload) ? payload : payload.cookies;
  const localStorageData = Array.isArray(payload) ? null : payload.localStorageData;

  // Step 1: Tell all Twitch tabs to wipe their localStorage/sessionStorage/IndexedDB
  // CRITICAL: Twitch caches auth in localStorage — if we don't clear this,
  // the page reloads with the old session even after cookie swap
  await sendToAllTwitchTabs({ action: 'clearLocalStorage' });

  // Step 2: Small delay to let localStorage clear before cookie swap
  await new Promise(r => setTimeout(r, 150));

  // Step 3: Clear all current Twitch cookies
  await clearTwitchCookies();

  // Step 4: Set the saved session cookies for the target account
  await setCookies(cookies);

  // Step 5: Mark as active
  await chrome.storage.local.set({ activeAccountId: accountId });

  // Step 6: Store localStorage data so content script can restore it on next load
  if (localStorageData && Object.keys(localStorageData).length > 0) {
    await chrome.storage.local.set({ pendingLocalStorage: localStorageData });
  } else {
    await chrome.storage.local.remove('pendingLocalStorage');
  }

  return account;
}

async function deleteAccount(accountId) {
  const accounts = await loadAccounts();
  const filtered = accounts.filter(a => a.id !== accountId);
  await saveAccounts(filtered);
  const { activeAccountId } = await chrome.storage.local.get('activeAccountId');
  if (activeAccountId === accountId) {
    await chrome.storage.local.remove('activeAccountId');
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
          const account = await switchToAccount(msg.accountId);
          // Reload all Twitch tabs AFTER cookies are set
          // Small extra delay to ensure cookies are flushed to disk before reload
          await new Promise(r => setTimeout(r, 200));
          const tabs = await chrome.tabs.query({ url: ['*://*.twitch.tv/*'] });
          for (const tab of tabs) {
            try { await chrome.tabs.reload(tab.id, { bypassCache: true }); } catch(_) {}
          }
          sendResponse({ ok: true, account });
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
          // Strip encrypted data before sending to popup
          const safe = accounts.map(({ encryptedCookies, ...rest }) => rest);
          sendResponse({ ok: true, accounts: safe, activeAccountId });
          break;
        }
        case 'getCurrentCookieUser': {
          const cookies = await getAllTwitchCookies();
          const login = cookies.find(c => c.name === 'login');
          const authToken = cookies.find(c => c.name === 'auth-token');
          sendResponse({
            ok: true,
            username: login ? decodeURIComponent(login.value) : null,
            loggedIn: !!authToken
          });
          break;
        }
        case 'refreshAccount': {
          // Re-capture cookies for an existing account id
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
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // async response
});

// Keep service worker alive with periodic alarm
chrome.alarms.create('keepAlive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});
