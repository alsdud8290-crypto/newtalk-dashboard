import { api, esc, modal, toast } from './core.js';
import * as dashboard from './pages/dashboard.js';
import * as monthly from './pages/monthly.js';
import * as sales from './pages/sales.js';
import * as receivables from './pages/receivables.js';
import * as upload from './pages/upload.js';
import * as exportPage from './pages/export.js';
import * as users from './pages/users.js';
import * as placeholder from './pages/placeholder.js';
import * as partPrices from './pages/part-prices.js';
import * as partPriceInput from './pages/part-price-input.js';
import * as pricing from './pages/pricing.js';

const root = document.getElementById('root');
const state = { user: null, meta: null, cleanup: null };

// perm: 필요한 권한(배열이면 그중 하나). 메뉴·라우트 모두 이 표 기준으로 노출/차단
// 단가: 부품 단가는 서비스팀 + 경영지원·관리자, 제품 단가·원가(대외비)는 경영지원·관리자만 (서버 API도 같은 기준)
const PART_PERMS = ['service', 'mgmt', 'admin'];
const PRICING_PERMS = ['mgmt', 'admin'];
const ROUTES = {
  '/dashboard': { page: dashboard, perm: 'mgmt', title: '경영 현황' },
  '/input/monthly': { page: monthly, perm: 'mgmt', title: '월별 실적·목표' },
  '/input/sales': { page: sales, perm: 'mgmt', title: '매출 내역' },
  '/input/receivables': { page: receivables, perm: 'mgmt', title: '미수금 관리' },
  '/upload': { page: upload, perm: 'mgmt', title: '엑셀 업로드' },
  '/export': { page: exportPage, perm: 'mgmt', title: '데이터 내보내기' },
  '/production': { page: placeholder, perm: 'production', title: '생산팀', team: 'production' },
  '/service': { page: placeholder, perm: 'service', title: '서비스팀', team: 'service' },
  '/prices/parts': { page: partPrices, perm: PART_PERMS, title: '부품별 단가 비교', tab: 'parts' },
  '/prices/companies': { page: partPrices, perm: PART_PERMS, title: '출장지별 단가 비교', tab: 'companies' },
  '/prices/input': { page: partPriceInput, perm: PART_PERMS, title: '단가 직접 입력' },
  '/prices/products': { page: pricing, perm: PRICING_PERMS, title: '제품 단가·원가' },
  '/admin/users': { page: users, perm: 'admin', title: '사용자·권한 관리' },
};

// 사이드 메뉴: 단독 항목(item) 또는 아이콘 제목 + 하위 항목(group)
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  mgmt: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h2M14 10h2M8 14h2M14 14h2M8 18h2M14 18h2"/>',
  production: '<path d="M2 20h20M4 20V10l5 3V10l5 3V6l6 4v10"/>',
  service: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  price: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

const MENU = [
  { type: 'item', href: '/dashboard', label: '경영 대시보드', icon: 'dashboard', perm: 'mgmt' },
  { type: 'group', label: '경영지원', icon: 'mgmt', perm: 'mgmt', items: [
    ['/input/monthly', '월별 실적·목표 입력'],
    ['/input/sales', '매출 내역 (판매처)'],
    ['/input/receivables', '미수금 관리'],
    ['/upload', '엑셀 업로드·데이터 이관'],
    ['/export', '데이터 내보내기'],
  ] },
  { type: 'item', href: '/production', label: '생산', icon: 'production', perm: 'production', soon: true },
  { type: 'item', href: '/service', label: '서비스', icon: 'service', perm: 'service', soon: true },
  // 하위 항목 세 번째 값: 그 항목만의 권한 (없으면 묶음 권한)
  { type: 'group', label: '단가', icon: 'price', perm: PART_PERMS, items: [
    ['/prices/parts', '부품별 비교'],
    ['/prices/companies', '출장지별 비교'],
    ['/prices/input', '단가 직접 입력'],
    ['/prices/products', '제품 단가·원가', PRICING_PERMS],
  ] },
  { type: 'item', href: '/admin/users', label: '관리자', icon: 'admin', perm: 'admin' },
];

const can = (perm) => [].concat(perm).some((p) => !!state.user?.perms?.[p]);
const firstAllowed = () => Object.keys(ROUTES).find((r) => can(ROUTES[r].perm));

const BRAND = `
  <span class="brand">
    <img class="mark" src="/img/logo-mark.png" alt="">
    <img class="word" src="/img/logo-wordmark.png" alt="NEWTORK">
    <span class="divider"></span><span class="product">경영 대시보드</span>
  </span>`;

function renderLogin(message = '') {
  root.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login">
        <img class="login-logo" src="/img/logo-full.png" alt="NEWTORK">
        <h1>경영 대시보드</h1>
        <p>사내 계정으로 로그인해 주세요.</p>
        <div class="field"><label>아이디</label><input class="input" name="username" autocomplete="username" required></div>
        <div class="field"><label>비밀번호</label><input class="input" type="password" name="password" autocomplete="current-password" required></div>
        <div class="notice err" ${message ? '' : 'hidden'} id="login-err">${esc(message)}</div>
        <button class="btn primary">로그인</button>
      </form>
    </div>`;
  root.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { user } = await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      state.user = user;
      await boot();
    } catch (err) {
      const box = root.querySelector('#login-err');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
}

function renderShell() {
  const u = state.user;
  const soon = (m) => (m.soon ? '<span class="soon">준비 중</span>' : '');
  const nav = MENU.filter((m) => can(m.perm)).map((m) => (m.type === 'item'
    ? `<a class="nav-item" href="#${m.href}" data-href="${m.href}">${icon(m.icon)}<span>${esc(m.label)}</span>${soon(m)}</a>`
    : `<div class="nav-group">
        <div class="nav-group-title">${icon(m.icon)}<span>${esc(m.label)}</span></div>
        ${m.items.filter(([, , perm]) => !perm || can(perm)).map(([href, label]) => `<a class="nav-sub" href="#${href}" data-href="${href}">${esc(label)}</a>`).join('')}
      </div>`)).join('');
  root.innerHTML = `
    <div class="app">
      <header class="gnb">
        <button class="menu-toggle" aria-label="메뉴">☰</button>
        <a href="#/" aria-label="홈">${BRAND}</a>
        <div class="spacer"></div>
        <div class="user-chip">
          <button type="button" id="user-btn" aria-haspopup="menu">
            <span class="avatar">${esc(u.name.slice(0, 1))}</span>
            <span class="who"><b>${esc(u.name)}</b><span>${esc(u.dept)}</span></span>
            <span class="caret">▾</span>
          </button>
          <div class="user-menu" id="user-menu" role="menu" hidden>
            <button type="button" id="pw-btn" role="menuitem">비밀번호 변경</button>
            <button type="button" id="logout-btn" role="menuitem">로그아웃</button>
          </div>
        </div>
      </header>
      <aside class="lnb">
        ${state.meta?.ephemeralStorage ? '<div class="notice warn lnb-warn">⚠ 데이터베이스(Turso)가 연결되지 않아 입력한 데이터가 서버 재시작 시 삭제됩니다. 관리자에게 문의해 주세요.</div>' : ''}
        ${nav || '<div class="empty">열람 가능한 메뉴가 없습니다.<br>관리자에게 권한을 요청해 주세요.</div>'}
      </aside>
      <main class="main" id="main"></main>
    </div>`;
  const menu = root.querySelector('#user-menu');
  root.querySelector('#user-btn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  root.querySelector('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    renderLogin();
  });
  root.querySelector('#pw-btn').addEventListener('click', () => changePassword(false));
  root.querySelector('.menu-toggle').addEventListener('click', () => root.querySelector('.app').classList.toggle('menu-open'));
}

function changePassword(forced) {
  modal({
    title: forced ? '초기 비밀번호를 변경해 주세요' : '비밀번호 변경',
    body: `
      ${forced ? '<div class="notice warn">보안을 위해 처음 로그인 시 비밀번호를 변경해야 합니다.</div>' : ''}
      <div class="field" style="margin-bottom:10px"><label>현재 비밀번호</label><input class="input" type="password" name="current" required></div>
      <div class="field" style="margin-bottom:10px"><label>새 비밀번호 (8자 이상)</label><input class="input" type="password" name="next" minlength="8" required></div>
      <div class="field"><label>새 비밀번호 확인</label><input class="input" type="password" name="confirm" minlength="8" required></div>`,
    submitLabel: '변경',
    onSubmit: async (form) => {
      const f = new FormData(form);
      if (f.get('next') !== f.get('confirm')) throw new Error('새 비밀번호가 일치하지 않습니다.');
      await api('/api/me/password', { method: 'POST', body: { current: f.get('current'), next: f.get('next') } });
      state.user.mustChangePassword = false;
      toast('비밀번호가 변경되었습니다.');
    },
  });
}

async function route() {
  if (!state.user) return;
  const path = location.hash.replace(/^#/, '') || '/';
  const target = ROUTES[path] ? path : firstAllowed();
  if (!target) { document.getElementById('main').innerHTML = '<div class="card empty">열람 가능한 메뉴가 없습니다. 관리자에게 권한을 요청해 주세요.</div>'; return; }
  if (path !== target && !ROUTES[path]) { location.replace(`#${target}`); return; }
  const r = ROUTES[target];
  const main = document.getElementById('main');
  root.querySelectorAll('.lnb [data-href]').forEach((a) => a.classList.toggle('active', a.dataset.href === target));
  root.querySelector('.app')?.classList.remove('menu-open');
  document.title = `${r.title} · NEWTORK 경영 대시보드`;
  if (typeof state.cleanup === 'function') state.cleanup();
  state.cleanup = null;
  if (!can(r.perm)) {
    main.innerHTML = '<div class="card empty">이 메뉴에 대한 열람 권한이 없습니다. 관리자에게 권한을 요청해 주세요.</div>';
    return;
  }
  main.innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    state.cleanup = await r.page.render(main, { user: state.user, meta: state.meta, team: r.team, tab: r.tab, reloadMeta });
  } catch (err) {
    main.innerHTML = `<div class="notice err">${esc(err.message)}</div>`;
  }
}

async function reloadMeta() {
  state.meta = await api('/api/meta');
  return state.meta;
}

async function boot() {
  try {
    if (!state.user) state.user = (await api('/api/me')).user;
  } catch {
    return renderLogin();
  }
  await reloadMeta();
  renderShell();
  await route();
  if (state.user.mustChangePassword) changePassword(true);
}

window.addEventListener('hashchange', route);
window.addEventListener('auth:expired', () => { state.user = null; renderLogin('세션이 만료되었습니다. 다시 로그인해 주세요.'); });
boot();
