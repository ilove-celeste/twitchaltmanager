// popup.js — UI logic for Twitch Alt Manager

const accountsList   = document.getElementById('accountsList');
const currentName    = document.getElementById('currentName');
const statusDot      = document.getElementById('statusDot');
const btnCapture     = document.getElementById('btnCapture');
const addPanel       = document.getElementById('addPanel');
const labelInput     = document.getElementById('labelInput');
const btnConfirm     = document.getElementById('btnConfirmCapture');
const switchOverlay  = document.getElementById('switchOverlay');
const switchLabel    = document.getElementById('switchLabel');
const footerHint     = document.getElementById('footerHint');
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmMessage = document.getElementById('confirmMessage');
const confirmOkBtn   = document.getElementById('confirmOkBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');

let state = { accounts: [], activeAccountId: null, currentUser: null };

// ─── Toast ─────────────────────────────────────────────────────────────────

function showToast(msg, type = 'success', duration = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => { t.className = 'toast'; }, duration);
}

// ─── Overlay ───────────────────────────────────────────────────────────────

function showSwitching(name) {
  switchLabel.textContent = `Входим как ${name}…`;
  switchOverlay.classList.add('show');
}
function hideSwitching() {
  switchOverlay.classList.remove('show');
}

// FIX (проблема #10): собственное модальное окно вместо нативного confirm().
// Дело не в том, что confirm() "блокируется в Service Worker" (он вызывается
// в popup.js, а не в фоновом сервис-воркере — там confirm() вообще недоступен
// и не вызывается) — а в том, что нативный диалог визуально выбивается из
// тёмной темы попапа и в некоторых managed-конфигурациях браузера может быть
// отключён политикой (JavaScriptDialogsAllowed и подобные enterprise-политики
// иногда подавляют window.confirm/alert внутри расширений).
function showConfirm(message) {
  return new Promise(resolve => {
    confirmMessage.textContent = message; // textContent — без HTML-инъекций
    confirmOverlay.classList.add('show');

    const cleanup = (result) => {
      confirmOverlay.classList.remove('show');
      confirmOkBtn.removeEventListener('click', onOk);
      confirmCancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    confirmOkBtn.addEventListener('click', onOk);
    confirmCancelBtn.addEventListener('click', onCancel);
  });
}

// ─── Message to background ─────────────────────────────────────────────────

// FIX (проблема #6): технически это уже было безопасно и без явного try/catch —
// синхронный throw внутри исполнителя `new Promise((resolve, reject) => {...})`
// автоматически превращается в reject самим движком JS (это встроенное
// поведение конструктора Promise, а не что-то, что нужно писать вручную).
// Явный try/catch добавлен ниже для ясности и как страховка на случай
// будущих изменений кода, а не потому что раньше был реальный баг.
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, resp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Unknown error'));
        resolve(resp);
      });
    } catch (e) {
      reject(new Error(`Не удалось отправить сообщение расширению: ${e.message}. Попробуй переоткрыть попап.`));
    }
  });
}

// ─── Render helpers ────────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
       + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function getInitial(name) {
  return (name || '?').charAt(0).toUpperCase();
}

const AVATAR_COLORS = ['#6441a5', '#9147ff', '#772ce8', '#4b2fa3', '#7c4dca'];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function createSvgIcon(pathsData, viewBox = '0 0 24 24') {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of pathsData) {
    const el = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function refreshIconSvg() {
  return createSvgIcon([
    ['polyline', { points: '23 4 23 10 17 10' }],
    ['polyline', { points: '1 20 1 14 7 14' }],
    ['path', { d: 'M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15' }]
  ]);
}

function deleteIconSvg() {
  return createSvgIcon([
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6l-1 14H6L5 6' }],
    ['path', { d: 'M10 11v6M14 11v6' }],
    ['path', { d: 'M9 6V4h6v2' }]
  ]);
}

function renderAccounts() {
  accountsList.textContent = '';

  if (!state.accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';

    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '🎮';

    const text = document.createElement('div');
    text.append('Нет сохранённых аккаунтов.', document.createElement('br'));
    const strong = document.createElement('strong');
    strong.textContent = '+ Сохранить';
    text.append('Войдите на Twitch и нажмите ', strong, '.');

    empty.append(icon, text);
    accountsList.appendChild(empty);
    return;
  }

  for (const acc of state.accounts) {
    const isActive = acc.id === state.activeAccountId;

    const card = document.createElement('div');
    card.className = `account-card${isActive ? ' active' : ''}`;
    card.dataset.id = acc.id;

    const avatar = document.createElement('div');
    avatar.className = 'account-avatar';
    avatar.style.background = avatarColor(acc.username);
    avatar.textContent = getInitial(acc.username);

    const info = document.createElement('div');
    info.className = 'account-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'account-name';
    nameEl.textContent = acc.username;

    // FIX (проблема #13): если у аккаунта есть отдельно определённый реальный
    // логин Twitch (twitchLogin), и он отличается от отображаемого имени
    // (кастомного label), показываем его в подписи — так пользователю видно,
    // под каким РЕАЛЬНЫМ логином нужно быть в браузере, чтобы кнопка
    // "обновить сессию" сработала.
    const metaParts = [`${acc.cookieCount || 0} cookies`, formatDate(acc.capturedAt)];
    if (acc.twitchLogin && acc.twitchLogin.toLowerCase() !== acc.username.toLowerCase()) {
      metaParts.push(`логин: ${acc.twitchLogin}`);
    }
    const metaEl = document.createElement('div');
    metaEl.className = 'account-meta';
    metaEl.textContent = metaParts.join(' · ');

    info.append(nameEl, metaEl);
    card.append(avatar, info);

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'active-badge';
      badge.textContent = '✓ АКТИВЕН';
      card.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'icon-btn';
    refreshBtn.dataset.action = 'refresh';
    refreshBtn.dataset.id = acc.id;
    refreshBtn.title = 'Обновить сессию (нужно быть залогиненным в браузере под этим аккаунтом)';
    refreshBtn.appendChild(refreshIconSvg());

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn danger';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.dataset.id = acc.id;
    deleteBtn.title = 'Удалить аккаунт';
    deleteBtn.appendChild(deleteIconSvg());

    actions.append(refreshBtn, deleteBtn);
    card.appendChild(actions);

    card.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      switchAccount(acc.id, acc.username);
    });

    accountsList.appendChild(card);
  }

  accountsList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { action, id } = btn.dataset;
      if (action === 'delete') deleteAccount(id);
      if (action === 'refresh') refreshAccount(id);
    });
  });
}

// ─── Actions ───────────────────────────────────────────────────────────────

// FIX (проблема #16): раньше Promise.all "проваливал" весь loadState при
// падении ЛЮБОГО одного запроса — UI вообще не обновлялся, даже если второй
// запрос успешно вернул данные. Теперь Promise.allSettled: каждая часть UI
// обновляется независимо от того, упал ли соседний запрос.
async function loadState() {
  const [accsResult, curResult] = await Promise.allSettled([
    sendMsg({ action: 'loadAccounts' }),
    sendMsg({ action: 'getCurrentCookieUser' })
  ]);

  if (accsResult.status === 'fulfilled') {
    state.accounts = accsResult.value.accounts;
    state.activeAccountId = accsResult.value.activeAccountId;
  } else {
    console.warn('[Twitch Alt Manager] loadAccounts не удался:', accsResult.reason?.message);
  }

  if (curResult.status === 'fulfilled') {
    state.currentUser = curResult.value.username;
    const loggedIn = curResult.value.loggedIn;
    currentName.textContent = loggedIn ? (curResult.value.username || 'Неизвестно') : 'Не авторизован';
    statusDot.className = `status-dot${loggedIn ? ' online' : ''}`;
    btnCapture.disabled = !loggedIn;
  } else {
    console.warn('[Twitch Alt Manager] getCurrentCookieUser не удался:', curResult.reason?.message);
    currentName.textContent = 'Ошибка';
    statusDot.className = 'status-dot';
    btnCapture.disabled = true; // безопасный дефолт, раз не знаем состояние логина
  }

  footerHint.textContent = state.accounts.length
    ? 'Кликните по аккаунту для мгновенного переключения'
    : 'Войдите в Twitch и сохраните сессию';

  renderAccounts();

  if (accsResult.status === 'rejected' || curResult.status === 'rejected') {
    showToast('Часть данных не удалось загрузить', 'error');
  } else if (state.accounts.length) {
    try {
      const keyStatus = await sendMsg({ action: 'getEncryptionKeyStatus' });
      if (keyStatus.checkFailed) {
        showToast('Не удалось проверить ключ шифрования. Попробуй открыть панель ещё раз.', 'error', 5000);
      } else if (!keyStatus.available) {
        showToast('Ключ шифрования не найден. Сохранённые аккаунты не удастся расшифровать — пересохрани их.', 'error', 6000);
      }
    } catch (e) {
      console.warn('[Twitch Alt Manager] Не удалось проверить ключ шифрования:', e.message);
    }
  }
}

async function switchAccount(accountId, username) {
  showSwitching(username);
  try {
    const resp = await sendMsg({ action: 'switchAccount', accountId });

    if (resp.warnings && resp.warnings.length) {
      console.warn('[Twitch Alt Manager] Не все cookies установились:', resp.warnings);
    }

    state.activeAccountId = accountId;
    renderAccounts();
    await loadState();

    // FIX (свежий разбор): теперь любое количество неудачных reload видимо
    // пользователю, а не только случай, когда не обновилась ни одна вкладка.
    if (resp.reloadFailures > 0) {
      showToast(`Аккаунт переключён: ${username}, но ${resp.reloadFailures} из ${resp.totalTabs} вкладок не удалось обновить`, 'error', 5000);
    } else {
      showToast(`Переключено: ${username}`, 'success');
    }

    setTimeout(() => window.close(), 2000);
  } catch (e) {
    hideSwitching();
    showToast('Ошибка: ' + e.message, 'error', 4000);
  }
}

async function deleteAccount(accountId) {
  const acc = state.accounts.find(a => a.id === accountId);
  if (!acc) return;
  const confirmed = await showConfirm(`Удалить аккаунт «${acc.username}»?`);
  if (!confirmed) return;
  try {
    await sendMsg({ action: 'deleteAccount', accountId });
    state.accounts = state.accounts.filter(a => a.id !== accountId);
    if (state.activeAccountId === accountId) state.activeAccountId = null;
    renderAccounts();
    showToast('Аккаунт удалён', 'success');
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

// FIX (проблема #13): сравниваем с реальным логином Twitch (twitchLogin), а
// не с отображаемым именем (username/label) — иначе кастомное имя вроде
// "Основной" никогда бы не совпало с реальным логином из cookies, и кнопка
// обновления сессии была бы вечно заблокирована. Для аккаунтов, сохранённых
// до этого исправления (без поля twitchLogin), используем username как
// раньше — чтобы не сломать уже существующие записи.
async function refreshAccount(accountId) {
  const acc = state.accounts.find(a => a.id === accountId);
  if (!acc) return;

  if (!state.currentUser) {
    showToast('Не удалось определить текущий аккаунт браузера', 'error', 3000);
    return;
  }

  const identity = acc.twitchLogin || acc.username;

  if (identity.toLowerCase() !== state.currentUser.toLowerCase()) {
    showToast(`Сначала войди как ${identity} (сейчас: ${state.currentUser})`, 'error', 3500);
    return;
  }

  try {
    await sendMsg({ action: 'refreshAccount', accountId });
    showToast(`Сессия обновлена: ${acc.username}`, 'success');
    await loadState();
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

// ─── Capture flow ──────────────────────────────────────────────────────────

btnCapture.addEventListener('click', async () => {
  addPanel.classList.toggle('open');
  if (!addPanel.classList.contains('open')) return;

  await loadState();
  if (!addPanel.classList.contains('open')) return;
  labelInput.value = state.currentUser || '';
  labelInput.focus();
  labelInput.select();
});

btnConfirm.addEventListener('click', async () => {
  const label = labelInput.value.trim();
  btnConfirm.disabled = true;
  btnConfirm.textContent = '...';
  try {
    const resp = await sendMsg({ action: 'captureAccount', label });
    state.accounts = state.accounts.filter(a => a.id !== resp.account.id);
    state.accounts.push(resp.account);
    addPanel.classList.remove('open');
    labelInput.value = '';
    renderAccounts();
    showToast(`Сохранено: ${resp.account.username}`, 'success');
    await loadState();
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error', 4000);
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = 'Сохранить';
  }
});

labelInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!btnConfirm.disabled) btnConfirm.click();
  }
  if (e.key === 'Escape') addPanel.classList.remove('open');
});

// ─── Init ──────────────────────────────────────────────────────────────────

loadState();
