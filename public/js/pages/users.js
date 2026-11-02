import { api, esc, toast, modal } from '../core.js';

// 팀별 열람/수정 + 관리자 페이지. 기본값: 경영지원팀·대표·관리자 = 전부, 생산·서비스·겸직 = 자기 팀 열람, 팀장만 수정
const TEAMS = [['mgmt', '경영지원'], ['production', '생산'], ['service', '서비스']];
const ROLES = ['팀원', '팀장'];

export async function render(main, ctx) {
  let users = [];
  const defaults = await api('/api/admin/default-perms');

  main.innerHTML = `
    <div class="page-head">
      <div><h2>사용자·권한 관리</h2><div class="sub">부서·직책을 고르면 기본 권한이 채워지며, 사람마다 팀별 열람·수정 권한을 켜고 끌 수 있습니다.</div></div>
      <div class="filters">
        <button class="btn primary" id="u-add">+ 사용자 등록</button>
      </div>
    </div>
    <div class="notice">기본 권한 — <b>경영지원팀·대표·관리자</b>: 모든 권한 / <b>생산팀·서비스팀·겸직</b>: 자기 팀만 열람, <b>팀장만 수정</b>.
      수정을 켜면 열람도 함께 켜지고, 열람을 끄면 수정도 꺼집니다. '관리자' 권한이 있어야 이 페이지를 볼 수 있습니다.</div>
    <div class="card"><div class="table-wrap" id="u-table"></div></div>`;

  const permChecks = (p) => `
    <table class="perm-grid">
      <thead><tr><th></th>${TEAMS.map(([, l]) => `<th>${l}</th>`).join('')}<th>관리자 페이지</th></tr></thead>
      <tbody>
        <tr><th>열람</th>${TEAMS.map(([k]) => `<td><input type="checkbox" name="perm_${k}" ${p[k] ? 'checked' : ''}></td>`).join('')}
          <td rowspan="2"><input type="checkbox" name="perm_admin" ${p.admin ? 'checked' : ''}></td></tr>
        <tr><th>수정</th>${TEAMS.map(([k]) => `<td><input type="checkbox" name="perm_edit_${k}" ${p[`edit_${k}`] ? 'checked' : ''}></td>`).join('')}</tr>
      </tbody>
    </table>`;
  const deptOptions = (sel) => ctx.meta.depts.map((d) => `<option ${d === sel ? 'selected' : ''}>${d}</option>`).join('');
  const roleOptions = (sel) => ROLES.map((r) => `<option ${r === sel ? 'selected' : ''}>${r}</option>`).join('');
  const KEYS = ['admin', ...TEAMS.flatMap(([k]) => [k, `edit_${k}`])];
  const readPerms = (f) => Object.fromEntries(KEYS.map((k) => [k, f.querySelector(`[name=perm_${k}]`).checked]));
  const setPerms = (f, p) => KEYS.forEach((k) => { f.querySelector(`[name=perm_${k}]`).checked = !!p[k]; });

  // 부서·직책을 바꾸면 기본 권한으로 채우고, 수정↔열람 체크를 서로 맞춘다
  function bindForm(m) {
    const f = m.el;
    const fill = () => setPerms(f, defaults[f.querySelector('[name=dept]').value][f.querySelector('[name=role]').value]);
    f.querySelector('[name=dept]').addEventListener('change', fill);
    f.querySelector('[name=role]').addEventListener('change', fill);
    for (const [k] of TEAMS) {
      const view = f.querySelector(`[name=perm_${k}]`);
      const edit = f.querySelector(`[name=perm_edit_${k}]`);
      edit.addEventListener('change', () => { if (edit.checked) view.checked = true; });
      view.addEventListener('change', () => { if (!view.checked) edit.checked = false; });
    }
  }

  function addUser() {
    const m = modal({
      title: '사용자 등록',
      body: `<div class="form-grid">
        <div class="field"><label>이름 *</label><input class="input" name="name" required></div>
        <div class="field"><label>부서 *</label><select class="input" name="dept">${deptOptions('경영지원팀')}</select></div>
        <div class="field"><label>직책</label><select class="input" name="role">${roleOptions('팀원')}</select></div>
        <div class="field"><label>아이디 * (영문/숫자)</label><input class="input" name="username" required pattern="[a-zA-Z0-9._\\-]{3,30}"></div>
        <div class="field full"><label>초기 비밀번호 * (8자 이상)</label><input class="input" name="password" required minlength="8"></div>
        <div class="field full"><label>메뉴 권한</label>${permChecks(defaults['경영지원팀']['팀원'])}</div>
      </div><p class="hint" style="color:var(--text-3);margin:10px 0 0">처음 로그인할 때 비밀번호를 변경하도록 안내됩니다.</p>`,
      submitLabel: '등록',
      onSubmit: async (f) => {
        const d = Object.fromEntries(new FormData(f));
        await api('/api/admin/users', { method: 'POST', body: { name: d.name, dept: d.dept, role: d.role, username: d.username, password: d.password, perms: readPerms(f) } });
        toast(`${d.name} 님을 등록했습니다.`);
        await load();
      },
    });
    bindForm(m);
  }

  function editUser(u) {
    const m = modal({
      title: `${u.name} (${u.username}) 수정`,
      body: `<div class="form-grid">
        <div class="field"><label>이름</label><input class="input" name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>부서</label><select class="input" name="dept">${deptOptions(u.dept)}</select></div>
        <div class="field"><label>직책</label><select class="input" name="role">${roleOptions(u.role)}</select></div>
        <div class="field"><label>계정 상태</label><div class="check-row"><label><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 (해제 시 로그인 불가)</label></div></div>
        <div class="field full"><label>메뉴 권한 <span class="hint">부서·직책을 바꾸면 기본 권한으로 다시 채워집니다</span></label>${permChecks(u.perms)}</div>
      </div>`,
      onSubmit: async (f) => {
        const d = Object.fromEntries(new FormData(f));
        await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { name: d.name, dept: d.dept, role: d.role, perms: readPerms(f), active: !!d.active } });
        toast('저장했습니다.');
        await load();
      },
    });
    bindForm(m);
  }

  function resetPw(u) {
    modal({
      title: `${u.name} 비밀번호 초기화`,
      body: `<div class="field"><label>새 임시 비밀번호 (8자 이상)</label><input class="input" name="password" minlength="8" required></div>
             <p class="hint" style="color:var(--text-3);margin:10px 0 0">기존 로그인은 모두 해제되고, 다음 로그인 때 비밀번호를 변경하도록 안내됩니다.</p>`,
      submitLabel: '초기화',
      onSubmit: async (f) => {
        await api(`/api/admin/users/${u.id}/reset-password`, { method: 'POST', body: { password: new FormData(f).get('password') } });
        toast('비밀번호를 초기화했습니다.');
      },
    });
  }

  const sw = (u, key, title) => `<label class="switch" title="${title}"><input type="checkbox" data-id="${u.id}" data-perm="${key}" ${u.perms[key] ? 'checked' : ''} ${u.active ? '' : 'disabled'}><span></span></label>`;
  function draw() {
    main.querySelector('#u-table').innerHTML = `
      <table class="tbl perm-tbl">
        <thead>
          <tr><th rowspan="2">이름</th><th rowspan="2">아이디</th><th rowspan="2">부서</th><th rowspan="2">직책</th>
            ${TEAMS.map(([, l]) => `<th class="c grp" colspan="2">${l}</th>`).join('')}<th class="c" rowspan="2">관리자</th><th class="c" rowspan="2">상태</th><th rowspan="2"></th></tr>
          <tr>${TEAMS.map(() => '<th class="c sub">열람</th><th class="c sub">수정</th>').join('')}</tr>
        </thead>
        <tbody>${users.map((u) => `
          <tr style="${u.active ? '' : 'opacity:.5'}">
            <td><b>${esc(u.name)}</b>${u.id === ctx.user.id ? ' <span class="badge blue">나</span>' : ''}</td>
            <td>${esc(u.username)}</td><td>${esc(u.dept)}</td>
            <td>${u.role === '팀장' ? '<span class="badge blue">팀장</span>' : '<span class="muted">팀원</span>'}</td>
            ${TEAMS.map(([k, l]) => `<td class="c grp">${sw(u, k, `${l} 열람`)}</td><td class="c">${sw(u, `edit_${k}`, `${l} 수정`)}</td>`).join('')}
            <td class="c">${sw(u, 'admin', '관리자 페이지')}</td>
            <td class="c">${u.active ? '<span class="status-chip good">사용</span>' : '<span class="badge">중지</span>'}</td>
            <td class="r"><button class="btn sm" data-edit="${u.id}">수정</button> <button class="btn sm" data-pw="${u.id}">비밀번호 초기화</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <div class="hint" style="color:var(--text-3);margin-top:10px">총 ${users.filter((u) => u.active).length}명 사용 중 · 스위치를 누르면 바로 저장됩니다. 수정을 켜면 열람도 켜지고, 열람을 끄면 수정도 꺼집니다.</div>`;
  }

  async function load() {
    users = await api('/api/admin/users');
    draw();
  }

  const LABEL = Object.fromEntries([...TEAMS.flatMap(([k, l]) => [[k, `${l} 열람`], [`edit_${k}`, `${l} 수정`]]), ['admin', '관리자 페이지']]);
  const table = main.querySelector('#u-table');
  table.addEventListener('change', async (e) => {
    const { id, perm } = e.target.dataset;
    if (!perm) return;
    const u = users.find((x) => x.id === Number(id));
    try {
      const updated = await api(`/api/admin/users/${id}`, { method: 'PUT', body: { perms: { [perm]: e.target.checked } } });
      Object.assign(u, updated);
      draw(); // 수정↔열람 연동 결과를 다시 그림
      toast(`${u.name}: ${LABEL[perm]} 권한 ${e.target.checked ? '부여' : '해제'}`);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });
  table.addEventListener('click', (e) => {
    const u = users.find((x) => x.id === Number(e.target.dataset.edit || e.target.dataset.pw));
    if (!u) return;
    if (e.target.dataset.edit) editUser(u);
    else resetPw(u);
  });
  main.querySelector('#u-add').addEventListener('click', addUser);

  await load();
}
