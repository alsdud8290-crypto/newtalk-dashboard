import { api, esc, toast, modal } from '../core.js';

const PERM_LABELS = [['mgmt', '경영지원팀'], ['production', '생산팀'], ['service', '서비스팀'], ['admin', '관리자']];

export async function render(main, ctx) {
  let users = [];
  const defaults = await api('/api/admin/default-perms');

  main.innerHTML = `
    <div class="page-head">
      <div><h2>사용자·권한 관리</h2><div class="sub">부서를 고르면 기본 권한이 채워지며, 사람마다 필요한 메뉴 권한을 켜고 끌 수 있습니다.</div></div>
      <div class="filters">
        <button class="btn" id="u-sample" title="화면 확인용 샘플 직원 13명을 추가합니다">샘플 직원 추가</button>
        <button class="btn primary" id="u-add">+ 사용자 등록</button>
      </div>
    </div>
    <div class="notice">기본 권한 — 경영지원팀·대표·관리자: 전체 / 생산팀: 생산팀만 / 서비스팀: 서비스팀만 / 겸직: 생산·서비스팀. '관리자' 권한이 있어야 이 페이지를 볼 수 있습니다.</div>
    <div class="card"><div class="table-wrap" id="u-table"></div></div>`;

  const permChecks = (perms) => `<div class="check-row">${PERM_LABELS.map(([k, l]) => `<label><input type="checkbox" name="perm_${k}" ${perms[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>`;
  const deptOptions = (sel) => ctx.meta.depts.map((d) => `<option ${d === sel ? 'selected' : ''}>${d}</option>`).join('');
  const readPerms = (f) => Object.fromEntries(PERM_LABELS.map(([k]) => [k, f.querySelector(`[name=perm_${k}]`).checked]));

  function bindDeptDefaults(m) {
    m.el.querySelector('[name=dept]').addEventListener('change', (e) => {
      const p = defaults[e.target.value];
      PERM_LABELS.forEach(([k]) => { m.el.querySelector(`[name=perm_${k}]`).checked = !!p[k]; });
    });
  }

  function addUser() {
    const m = modal({
      title: '사용자 등록',
      body: `<div class="form-grid">
        <div class="field"><label>이름 *</label><input class="input" name="name" required></div>
        <div class="field"><label>부서 *</label><select class="input" name="dept">${deptOptions('경영지원팀')}</select></div>
        <div class="field"><label>아이디 * (영문/숫자)</label><input class="input" name="username" required pattern="[a-zA-Z0-9._\\-]{3,30}"></div>
        <div class="field"><label>초기 비밀번호 * (8자 이상)</label><input class="input" name="password" required minlength="8"></div>
        <div class="field full"><label>메뉴 권한</label>${permChecks(defaults['경영지원팀'])}</div>
      </div><p class="hint" style="color:var(--text-3);margin:10px 0 0">처음 로그인할 때 비밀번호를 변경하도록 안내됩니다.</p>`,
      submitLabel: '등록',
      onSubmit: async (f) => {
        const d = Object.fromEntries(new FormData(f));
        await api('/api/admin/users', { method: 'POST', body: { name: d.name, dept: d.dept, username: d.username, password: d.password, perms: readPerms(f) } });
        toast(`${d.name} 님을 등록했습니다.`);
        await load();
      },
    });
    bindDeptDefaults(m);
  }

  function editUser(u) {
    const m = modal({
      title: `${u.name} (${u.username}) 수정`,
      body: `<div class="form-grid">
        <div class="field"><label>이름</label><input class="input" name="name" value="${esc(u.name)}" required></div>
        <div class="field"><label>부서</label><select class="input" name="dept">${deptOptions(u.dept)}</select></div>
        <div class="field full"><label>메뉴 권한</label>${permChecks(u.perms)}</div>
        <div class="field full"><label>계정 상태</label><div class="check-row"><label><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 사용 (해제 시 로그인 불가)</label></div></div>
      </div>`,
      onSubmit: async (f) => {
        const d = Object.fromEntries(new FormData(f));
        await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { name: d.name, dept: d.dept, perms: readPerms(f), active: !!d.active } });
        toast('저장했습니다.');
        await load();
      },
    });
    bindDeptDefaults(m);
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

  function draw() {
    main.querySelector('#u-table').innerHTML = `
      <table class="tbl">
        <thead><tr><th>이름</th><th>아이디</th><th>부서</th>${PERM_LABELS.map(([, l]) => `<th class="c">${l}</th>`).join('')}<th class="c">상태</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr style="${u.active ? '' : 'opacity:.5'}">
            <td><b>${esc(u.name)}</b>${u.id === ctx.user.id ? ' <span class="badge blue">나</span>' : ''}</td>
            <td>${esc(u.username)}</td><td>${esc(u.dept)}</td>
            ${PERM_LABELS.map(([k]) => `<td class="c"><label class="switch" title="${k}"><input type="checkbox" data-id="${u.id}" data-perm="${k}" ${u.perms[k] ? 'checked' : ''} ${u.active ? '' : 'disabled'}><span></span></label></td>`).join('')}
            <td class="c">${u.active ? '<span class="status-chip good">사용</span>' : '<span class="badge">중지</span>'}</td>
            <td class="r"><button class="btn sm" data-edit="${u.id}">수정</button> <button class="btn sm" data-pw="${u.id}">비밀번호 초기화</button></td>
          </tr>`).join('')}</tbody>
      </table>
      <div class="hint" style="color:var(--text-3);margin-top:10px">총 ${users.filter((u) => u.active).length}명 사용 중 · 스위치를 누르면 바로 저장됩니다.</div>`;
  }

  async function load() {
    users = await api('/api/admin/users');
    draw();
  }

  const table = main.querySelector('#u-table');
  table.addEventListener('change', async (e) => {
    const { id, perm } = e.target.dataset;
    if (!perm) return;
    const u = users.find((x) => x.id === Number(id));
    try {
      await api(`/api/admin/users/${id}`, { method: 'PUT', body: { perms: { [perm]: e.target.checked } } });
      u.perms[perm] = e.target.checked;
      toast(`${u.name}: ${PERM_LABELS.find(([k]) => k === perm)[1]} 권한 ${e.target.checked ? '부여' : '해제'}`);
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
  main.querySelector('#u-sample').addEventListener('click', async () => {
    const r = await api('/api/admin/sample-users', { method: 'POST' });
    toast(r.added ? `샘플 직원 ${r.added}명을 추가했습니다. (초기 비밀번호 ${r.password})` : '샘플 직원이 이미 모두 등록되어 있습니다.');
    await load();
  });

  await load();
}
