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

// state.currentUser хранит имя, полученное из cookies (см. FIX #9 ниже)
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

// ─── Message to background ─────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Unknown error'));
      resolve(resp);
    });
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

// FIX #5 (было: escHtml не экранировал одинарные кавычки)
// Оставлена для обратной совместимости / прочих мест, где используется textContent-safe строка,
// но теперь она больше не нужна для рендера списка аккаунтов (см. FIX #10 — используем DOM API).
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Небольшой хелпер для создания SVG-иконок без innerHTML
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

// FIX #10 (было: renderAccounts использовал innerHTML с непроверенными данными —
// потенциальный вектор для HTML/script-инъекции через имя аккаунта).
// Теперь весь DOM строится через document.createElement/textContent, без innerHTML.
function renderAccounts() {
  accountsList.textContent = ''; // safe clear

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

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'account-avatar';
    avatar.style.background = avatarColor(acc.username);
    avatar.textContent = getInitial(acc.username);

    // Info block
    const info = document.createElement('div');
    info.className = 'account-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'account-name';
    nameEl.textContent = acc.username; // textContent — безопасно, HTML не интерпретируется

    const metaEl = document.createElement('div');
    metaEl.className = 'account-meta';
    metaEl.textContent = `${acc.cookieCount || 0} cookies · ${formatDate(acc.capturedAt)}`;

    info.append(nameEl, metaEl);

    card.append(avatar, info);

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'active-badge';
      badge.textContent = '✓ АКТИВЕН';
      card.appendChild(badge);
    }

    // Actions
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

async function loadState() {
  try {
    const [accsResp, curResp] = await Promise.all([
      sendMsg({ action: 'loadAccounts' }),
      sendMsg({ action: 'getCurrentCookieUser' })
    ]);
    state.accounts = accsResp.accounts;
    state.activeAccountId = accsResp.activeAccountId;
    // FIX #9: currentUser берём строго из cookies (username, извлечённый background.js
    // через twilight-user JSON / login cookie), а не из label аккаунта.
    state.currentUser = curResp.username;
    const loggedIn = curResp.loggedIn;

    currentName.textContent = loggedIn ? (curResp.username || 'Неизвестно') : 'Не авторизован';
    statusDot.className = `status-dot${loggedIn ? ' online' : ''}`;
    btnCapture.disabled = !loggedIn;

    footerHint.textContent = state.accounts.length
      ? 'Кликните по аккаунту для мгновенного переключения'
      : 'Войдите в Twitch и сохраните сессию';

    renderAccounts();
  } catch (e) {
    showToast('Ошибка загрузки: ' + e.message, 'error');
  }
}

// FIX #14 (было: окно закрывалось сразу после showToast, без явной гарантии,
// что состояние (активный аккаунт) уже актуализировано).
// Теперь: 1) дожидаемся успешного switchAccount от background,
//         2) обновляем локальное состояние,
//         3) дожидаемся полного loadState() (перезапрос актуальных данных),
//         4) только после этого закрываем попап.
async function switchAccount(accountId, username) {
  showSwitching(username);
  try {
    const resp = await sendMsg({ action: 'switchAccount', accountId });

    if (resp.warnings && resp.warnings.length) {
      console.warn('[Twitch Alt Manager] Не все cookies установились:', resp.warnings);
    }

    state.activeAccountId = accountId;
    renderAccounts();

    // Дожидаемся полного обновления состояния (не просто оптимистичного рендера)
    await loadState();

    showToast(`Переключено: ${username}`, 'success');

    // Закрываем попап только после полного успеха переключения и обновления состояния
    setTimeout(() => window.close(), 800);
  } catch (e) {
    hideSwitching();
    showToast('Ошибка: ' + e.message, 'error', 4000);
  }
}

async function deleteAccount(accountId) {
  const acc = state.accounts.find(a => a.id === accountId);
  if (!acc) return;
  if (!confirm(`Удалить аккаунт «${acc.username}»?`)) return;
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

// FIX #9 (было: сравнение acc.username с state.currentUser могло ложно не совпасть,
// если label был изменён вручную и отличался от реального логина в cookies).
// state.currentUser теперь всегда берётся из cookies (см. loadState/FIX #9 выше),
// а не из label — поэтому сравнение здесь корректно отражает реальный залогиненный
// в браузере аккаунт, независимо от того, как пользователь назвал сохранённую запись.
async function refreshAccount(accountId) {
  const acc = state.accounts.find(a => a.id === accountId);
  if (!acc) return;

  if (!state.currentUser) {
    showToast('Не удалось определить текущий аккаунт браузера', 'error', 3000);
    return;
  }

  if (acc.username.toLowerCase() !== state.currentUser.toLowerCase()) {
    showToast(`Сначала войдите как ${acc.username} (сейчас: ${state.currentUser})`, 'error', 3500);
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

btnCapture.addEventListener('click', () => {
  addPanel.classList.toggle('open');
  if (addPanel.classList.contains('open')) {
    labelInput.value = state.currentUser || '';
    labelInput.focus();
    labelInput.select();
  }
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
  if (e.key === 'Enter') btnConfirm.click();
  if (e.key === 'Escape') addPanel.classList.remove('open');
});

// ─── Init ──────────────────────────────────────────────────────────────────

loadState();
