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

// ─── Render ────────────────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
       + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function getInitial(name) {
  return (name || '?').charAt(0).toUpperCase();
}

// Rotating purple shades for avatars
const AVATAR_COLORS = [
  '#6441a5','#9147ff','#772ce8','#4b2fa3','#7c4dca'
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function renderAccounts() {
  accountsList.innerHTML = '';

  if (!state.accounts.length) {
    accountsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎮</div>
        Нет сохранённых аккаунтов.<br>
        Войдите на Twitch и нажмите <strong>+ Сохранить</strong>.
      </div>`;
    return;
  }

  for (const acc of state.accounts) {
    const isActive = acc.id === state.activeAccountId;
    const card = document.createElement('div');
    card.className = `account-card${isActive ? ' active' : ''}`;
    card.dataset.id = acc.id;

    card.innerHTML = `
      <div class="account-avatar" style="background:${avatarColor(acc.username)}">${getInitial(acc.username)}</div>
      <div class="account-info">
        <div class="account-name">${escHtml(acc.username)}</div>
        <div class="account-meta">${acc.cookieCount || 0} cookies · ${formatDate(acc.capturedAt)}</div>
      </div>
      ${isActive ? '<span class="active-badge">✓ АКТИВЕН</span>' : ''}
      <div class="card-actions">
        <button class="icon-btn" data-action="refresh" data-id="${acc.id}" title="Обновить сессию (должны быть эти куки в браузере)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        <button class="icon-btn danger" data-action="delete" data-id="${acc.id}" title="Удалить аккаунт">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>`;

    // Switch on card click (not action buttons)
    card.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      switchAccount(acc.id, acc.username);
    });

    accountsList.appendChild(card);
  }

  // Action buttons
  accountsList.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { action, id } = btn.dataset;
      if (action === 'delete') deleteAccount(id);
      if (action === 'refresh') refreshAccount(id);
    });
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    state.currentUser = curResp.username;
    const loggedIn = curResp.loggedIn;

    // Header status
    currentName.textContent = loggedIn ? (curResp.username || 'Неизвестно') : 'Не авторизован';
    statusDot.className = `status-dot${loggedIn ? ' online' : ''}`;
    btnCapture.disabled = !loggedIn;

    // Footer hint
    footerHint.textContent = state.accounts.length
      ? 'Кликните по аккаунту для мгновенного переключения'
      : 'Войдите в Twitch и сохраните сессию';

    renderAccounts();
  } catch (e) {
    showToast('Ошибка загрузки: ' + e.message, 'error');
  }
}

async function switchAccount(accountId, username) {
  showSwitching(username);
  try {
    await sendMsg({ action: 'switchAccount', accountId });
    state.activeAccountId = accountId;
    renderAccounts();
    showToast(`Переключено: ${username}`, 'success');
    // Brief delay so user sees the success state before popup closes
    setTimeout(() => window.close(), 800);
  } catch (e) {
    hideSwitching();
    showToast('Ошибка: ' + e.message, 'error');
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

async function refreshAccount(accountId) {
  const acc = state.accounts.find(a => a.id === accountId);
  if (!acc) return;
  // Refreshing means re-capturing current browser cookies for this account name
  // Only makes sense if current browser session IS that account
  if (state.currentUser && acc.username.toLowerCase() !== state.currentUser.toLowerCase()) {
    showToast(`Сначала войдите как ${acc.username}`, 'error', 3000);
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
