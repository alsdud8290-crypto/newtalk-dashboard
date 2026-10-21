import { api, esc, modal, toast } from './core.js';
import * as dashboard from './pages/dashboard.js';
import * as monthly from './pages/monthly.js';
import * as sales from './pages/sales.js';
import * as receivables from './pages/receivables.js';
import * as upload from './pages/upload.js';
import * as users from './pages/users.js';
import * as placeholder from './pages/placeholder.js';

const root = document.getElementById('root');
const state = { user: null, meta: null, cleanup: null };

// perm: 필요한 권한. 메뉴·라우트 모두 이 표 기준으로 노출/차단
const ROUTES = {
  '/dashboard': { page: dashboard, perm: 'mgmt', title: '경영 현황' },
  '/input/monthly': { page: monthly, perm: 'mgmt', title: '월별 실적·목표' },
  '/input/sales': { page: sales, perm: 'mgmt', title: '매출 내역' },
  '/input/receivables': { page: receivables, perm: 'mgmt', title: '미수금 관리' },
  '/upload': { page: upload, perm: 'mgmt', title: '엑셀 업로드' },
  '/production': { page: placeholder, perm: 'production', title: '생산팀', team: 'production' },
  '/service': { page: placeholder, perm: 'service', title: '서비스팀', team: 'service' },
  '/admin/users': { page: users, perm: 'admin', title: '사용자·권한 관리' },
};

const MENU = [
  { group: '경영지원팀', perm: 'mgmt', items: [
    ['/dashboard', '경영 현황 대시보드'],
    ['/input/monthly', '월별 실적·목표 입력'],
    ['/input/sales', '매출 내역 (판매처)'],
    ['/input/receivables', '미수금 관리'],
    ['/upload', '엑셀 업로드·데이터 이관'],
  ] },
  { group: '생산팀', perm: 'production', soon: true, items: [['/production', '생산 현황']] },
  { group: '서비스팀', perm: 'service', soon: true, items: [['/service', '서비스(A/S) 현황']] },
  { group: '관리자', perm: 'admin', items: [['/admin/users', '사용자·권한 관리']] },
];

const can = (perm) => !!state.user?.perms?.[perm];
const firstAllowed = () => Object.keys(ROUTES).find((r) => can(ROUTES[r].perm));

function renderLogin(message = '') {
  root.innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login">
        <div class="brand-mark"><span class="logo">N</span>뉴토크 코리아</div>
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
  const groups = MENU.filter((g) => can(g.perm)).map((g) => `
    <div class="group">
      <div class="group-title">${esc(g.group)} ${g.soon ? '<span class="badge">준비 중</span>' : ''}</div>
      ${g.items.map(([href, label]) => `<a class="item" href="#${href}" data-href="${href}">${esc(label)}</a>`).join('')}
    </div>`).join('');
  const apps = [
    ['/dashboard', '대시보드', 'mgmt'], ['/input/monthly', '데이터 입력', 'mgmt'],
    ['/upload', '엑셀 업로드', 'mgmt'], ['/admin/users', '관리자', 'admin'],
  ].filter(([, , p]) => can(p));
  root.innerHTML = `
    <div class="app">
      <header class="gnb">
        <button class="menu-toggle" aria-label="메뉴">☰</button>
        <a class="brand-mark" href="#/"><span class="logo">N</span>뉴토크 코리아</a>
        <nav class="gnb-apps">${apps.map(([h, l]) => `<a href="#${h}" data-app="${h}">${l}</a>`).join('')}</nav>
        <div class="spacer"></div>
        <div class="user">
          <span class="avatar">${esc(u.name.slice(0, 1))}</span>
          <span class="uname">${esc(u.name)} · ${esc(u.dept)}</span>
          <button class="btn sm" id="pw-btn">비밀번호 변경</button>
          <button class="btn sm" id="logout-btn">로그아웃</button>
        </div>
      </header>
      <aside class="lnb">
        <div class="lnb-title">경영 대시보드</div>
        ${state.meta?.ephemeralStorage ? '<div class="notice warn" style="margin:0 4px 12px;font-size:12px">⚠ 데이터베이스(Turso)가 연결되지 않아 입력한 데이터가 서버 재시작 시 삭제됩니다. 관리자에게 문의해 주세요.</div>' : ''}
        ${groups || '<div class="empty">열람 가능한 메뉴가 없습니다.<br>관리자에게 권한을 요청해 주세요.</div>'}
      </aside>
      <main class="main" id="main"></main>
    </div>`;
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
  root.querySelectorAll('.lnb a.item').forEach((a) => a.classList.toggle('active', a.dataset.href === target));
  root.querySelectorAll('.gnb-apps a').forEach((a) => a.classList.toggle('active', target.startsWith(a.dataset.app.split('/').slice(0, 2).join('/'))));
  root.querySelector('.app')?.classList.remove('menu-open');
  document.title = `${r.title} - 뉴토크 코리아 경영 대시보드`;
  if (typeof state.cleanup === 'function') state.cleanup();
  state.cleanup = null;
  if (!can(r.perm)) {
    main.innerHTML = '<div class="card empty">이 메뉴에 대한 열람 권한이 없습니다. 관리자에게 권한을 요청해 주세요.</div>';
    return;
  }
  main.innerHTML = '<div class="empty">불러오는 중…</div>';
  try {
    state.cleanup = await r.page.render(main, { user: state.user, meta: state.meta, team: r.team, reloadMeta });
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
