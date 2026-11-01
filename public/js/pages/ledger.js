// 채권·채무 현황 — 회사 양식 "경영지원 관리" 와 같은 구성 (기준월별)
import { api, esc, comma, won, parseMoney, toast, modal, confirmBox, bindMoneyInputs } from '../core.js';
import { saveBlob } from '../exporter.js';

const SECTIONS = [
  { key: 'ar', title: '외상매출금', who: '거래처명', code: true,
    groups: [['long', '장기 미수금 업체'], ['collected', '당월 수금된 업체'], ['scheduled', '당월 수금예정인 업체']] },
  { key: 'ap', title: '외상매입금', who: '거래처명', note: '당월 매입 지출', groups: [['normal', '']] },
  { key: 'staff', title: '미지급비용-직원', who: '직원명', note: '당월 경비 지출', groups: [['normal', '']] },
  { key: 'vendor', title: '미지급비용-업체', who: '거래처명', note: '당월 그 외 지출', groups: [['auto', '자동이체'], ['normal', '그 외 지출']] },
];
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const sum = (list) => list.reduce((a, e) => a + (Number(e.balance) || 0), 0);

const remembered = () => { try { return localStorage.getItem('ledgerMonth'); } catch { return null; } };
const remember = (m) => { try { localStorage.setItem('ledgerMonth', m); } catch { /* 무시 */ } };

export async function render(main) {
  let month = remembered() || thisMonth();
  let entries = [];
  let dirty = false;
  let saved = []; // 저장된 기준월 목록

  main.innerHTML = `
    <div class="page-head">
      <div><h2>채권·채무 현황</h2><div class="sub">회사 엑셀 "경영지원 관리"와 같은 형식 · 기준월별로 입력하고, 같은 양식으로 내려받거나 올립니다.</div></div>
      <div class="filters">
        <input class="input" type="month" id="l-month" value="${month}" aria-label="기준월">
        <button class="btn" id="l-down" title="회사 양식 엑셀로 내려받기 (이 달)">⬇ 회사 양식 엑셀</button>
        <button class="btn" id="l-down-all" title="저장된 모든 달을 시트별로 내려받기">⬇ 전체 월</button>
        <label class="btn" title="회사 양식 엑셀을 올려 반영">⬆ 회사 양식 업로드<input type="file" id="l-file" accept=".xlsx" hidden></label>
        <button class="btn primary" id="l-save">저장</button>
      </div>
    </div>
    <div id="l-status"></div>
    <div id="l-body"></div>`;

  const body = main.querySelector('#l-body');
  const status = main.querySelector('#l-status');
  const setStatus = (html, cls = '') => { status.innerHTML = html ? `<div class="notice ${cls}">${html}</div>` : ''; };
  const markDirty = () => {
    dirty = true;
    setStatus('저장하지 않은 변경 사항이 있습니다. 확인 후 <b>[저장]</b>을 눌러 주세요.', 'warn');
  };

  function rowHtml(e, i, sec) {
    const grpSelect = sec.groups.length > 1
      ? `<td><select class="input" data-i="${i}" data-f="grp">${sec.groups.map(([g, l]) => `<option value="${g}" ${e.grp === g ? 'selected' : ''}>${l}</option>`).join('')}</select></td>` : '';
    return `<tr>
      ${grpSelect}
      ${sec.code ? `<td><input class="input" data-i="${i}" data-f="code" value="${esc(e.code)}" style="min-width:100px" placeholder="코드"></td>` : ''}
      <td><input class="input" data-i="${i}" data-f="name" value="${esc(e.name)}" style="min-width:160px;${e.red ? 'color:var(--critical)' : ''}"></td>
      <td><input class="input money" data-i="${i}" data-f="balance" value="${comma(e.balance)}" style="${e.red ? 'color:var(--critical)' : ''}"></td>
      <td><input class="input" data-i="${i}" data-f="memo" value="${esc(e.memo)}" style="min-width:180px"></td>
      <td class="c"><input type="checkbox" data-i="${i}" data-f="red" ${e.red ? 'checked' : ''} title="빨간 글씨로 표시"></td>
      <td class="r"><button class="btn sm danger" data-del="${i}">삭제</button></td>
    </tr>`;
  }

  function draw() {
    body.innerHTML = SECTIONS.map((sec) => {
      const list = entries.map((e, i) => [e, i]).filter(([e]) => e.section === sec.key);
      // 소구분 순서대로 정렬해 보여 줌
      const order = Object.fromEntries(sec.groups.map(([g], k) => [g, k]));
      list.sort((a, b) => (order[a[0].grp] ?? 9) - (order[b[0].grp] ?? 9));
      return `
      <div class="card" style="margin-bottom:16px" data-sec="${sec.key}">
        <div class="card-head">
          <div class="ttl"><h3>${sec.title} <span class="badge blue">${list.length}건</span></h3><span class="hint" data-sub="${sec.key}"></span></div>
          <div class="card-tools">
            <span style="font-weight:800;font-size:16px" data-total="${sec.key}"></span>
            ${sec.key === 'ar' ? '<button class="btn sm" data-fill title="미수금 관리 데이터로 이 달 외상매출금 채우기">미수금 관리에서 채우기</button>' : ''}
            <button class="btn sm" data-add="${sec.key}">+ 행 추가</button>
          </div>
        </div>
        ${list.length ? `<div class="table-wrap"><table class="tbl edit">
          <thead><tr>${sec.groups.length > 1 ? '<th>구분</th>' : ''}${sec.code ? '<th>코드</th>' : ''}<th>${sec.who}</th><th class="r">잔액</th><th>적요</th><th class="c">빨간 글씨</th><th></th></tr></thead>
          <tbody>${list.map(([e, i]) => rowHtml(e, i, sec)).join('')}</tbody></table></div>`
        : `<div class="empty" style="padding:18px">입력된 내용이 없습니다. [+ 행 추가] ${sec.key === 'ar' ? '또는 [미수금 관리에서 채우기]' : ''}로 입력하세요.</div>`}
      </div>`;
    }).join('');
    bindMoneyInputs(body);
    updateTotals();
  }

  // 합계만 다시 계산 (입력 중 표를 다시 그리지 않아 커서가 유지됨)
  function updateTotals() {
    for (const sec of SECTIONS) {
      const list = entries.filter((e) => e.section === sec.key);
      body.querySelector(`[data-total="${sec.key}"]`).textContent = `총액 ${won(sum(list))}`;
      body.querySelector(`[data-sub="${sec.key}"]`).innerHTML = sec.groups.length > 1
        ? sec.groups.map(([g, l]) => `${l} <b>${won(sum(list.filter((e) => e.grp === g)))}</b>`).join(' · ')
        : esc(sec.note);
    }
  }

  body.addEventListener('input', (e) => {
    const { i, f } = e.target.dataset;
    if (i === undefined || !f) return;
    const entry = entries[Number(i)];
    if (f === 'red') entry.red = e.target.checked ? 1 : 0;
    else if (f === 'balance') entry.balance = parseMoney(e.target.value);
    else entry[f] = e.target.value;
    markDirty();
    if (f === 'grp' || f === 'red') draw();
    else if (f === 'balance') updateTotals();
  });
  body.addEventListener('click', async (e) => {
    const add = e.target.dataset.add;
    if (add) {
      const sec = SECTIONS.find((s) => s.key === add);
      entries.push({ section: add, grp: sec.groups[sec.groups.length - 1][0], code: '', name: '', balance: 0, memo: '', red: 0 });
      markDirty();
      draw();
      return;
    }
    if (e.target.dataset.del !== undefined) {
      entries.splice(Number(e.target.dataset.del), 1);
      markDirty();
      draw();
      return;
    }
    if (e.target.hasAttribute('data-fill')) {
      const has = entries.some((x) => x.section === 'ar');
      if (has && !(await confirmBox('현재 외상매출금 내용을 미수금 관리 데이터로 바꿀까요?', '바꾸기'))) return;
      const r = await api(`/api/mgmt/ledger/${month}/from-receivables`);
      entries = [...r.entries, ...entries.filter((x) => x.section !== 'ar')];
      markDirty();
      draw();
      toast(`미수금 관리 데이터로 외상매출금 ${r.entries.length}곳을 채웠습니다. 확인 후 저장해 주세요.`);
    }
  });

  async function load() {
    remember(month);
    const [r, months] = await Promise.all([api(`/api/mgmt/ledger/${month}`), api('/api/mgmt/ledger/months')]);
    entries = r.entries;
    saved = months;
    dirty = false;
    const info = saved.length ? `저장된 기준월: ${saved.map((m) => `<a href="#" data-month="${m.month}">${m.month}</a>`).join(' · ')}` : '아직 저장된 기준월이 없습니다.';
    setStatus(entries.length ? '' : `${month} 데이터가 없습니다. 직접 입력하거나 회사 양식 엑셀을 올려 주세요. ${info}`);
    if (entries.length && saved.length > 1) setStatus(info);
    draw();
  }
  status.addEventListener('click', (e) => {
    const m = e.target.dataset.month;
    if (!m) return;
    e.preventDefault();
    main.querySelector('#l-month').value = m;
    main.querySelector('#l-month').dispatchEvent(new Event('change'));
  });

  main.querySelector('#l-month').addEventListener('change', async (e) => {
    const next = e.target.value;
    if (!/^\d{4}-\d{2}$/.test(next)) return;
    if (dirty && !(await confirmBox('저장하지 않은 변경 사항이 있습니다. 기준월을 바꿀까요?', '바꾸기'))) { e.target.value = month; return; }
    month = next;
    load();
  });

  main.querySelector('#l-save').addEventListener('click', async () => {
    try {
      const r = await api(`/api/mgmt/ledger/${month}`, { method: 'PUT', body: { entries } });
      toast(`${month} 채권·채무 현황 ${r.count}건을 저장했습니다.`);
      await load();
    } catch (err) { toast(err.message, true); }
  });

  async function download(months) {
    if (dirty) toast('저장하지 않은 변경 사항은 내려받은 파일에 들어가지 않습니다.', true);
    const res = await fetch(`/api/mgmt/ledger-export?months=${encodeURIComponent(months)}`, { credentials: 'same-origin' });
    if (!res.ok) return toast((await res.json().catch(() => null))?.error || '내려받기에 실패했습니다.', true);
    const cd = res.headers.get('Content-Disposition') || '';
    const name = decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'ledger.xlsx');
    saveBlob(name, await res.blob());
  }
  main.querySelector('#l-down').addEventListener('click', () => download(month));
  main.querySelector('#l-down-all').addEventListener('click', () => download('all'));

  // 회사 양식 업로드: 시트 하나 → 편집 화면에 불러오기(저장 전 확인), 여러 시트 → 기준월별로 한 번에 저장
  main.querySelector('#l-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const b64 = await new Promise((ok, fail) => {
      const fr = new FileReader();
      fr.onload = () => ok(String(fr.result).split(',')[1]);
      fr.onerror = () => fail(fr.error);
      fr.readAsDataURL(file);
    });
    let sheets;
    try {
      ({ sheets } = await api('/api/mgmt/ledger/parse', { method: 'POST', body: { file: b64 } }));
    } catch (err) { return toast(err.message, true); }
    if (!sheets.length) return toast('회사 양식(외상매출금·외상매입금·미지급비용)을 찾지 못했습니다.', true);
    const countText = (s) => SECTIONS.map((x) => `${x.title} ${s.counts[x.key] || 0}`).join(' · ');
    const warn = (s) => (s.warnings.length ? `<div class="notice warn" style="margin:8px 0 0">${s.warnings.map(esc).join('<br>')}</div>` : '');

    if (sheets.length === 1) {
      const s = sheets[0];
      const target = s.month || month;
      if (target !== month) {
        if (dirty && !(await confirmBox(`파일의 기준월(${target})로 이동합니다. 저장하지 않은 변경 사항은 사라집니다.`, '이동'))) return;
        month = target;
        main.querySelector('#l-month').value = month;
      }
      entries = s.entries;
      draw();
      dirty = true;
      setStatus(`<b>${esc(file.name)}</b>을(를) ${month} 기준으로 불러왔습니다 (${countText(s)}). 내용을 확인한 뒤 <b>[저장]</b>을 누르면 이 달의 기존 내용을 바꿉니다.${s.month ? '' : ' 시트 이름에 기준월이 없어 위에서 고른 기준월을 썼습니다.'}${warn(s)}`, 'warn');
      return;
    }
    // 여러 시트
    modal({
      title: '여러 기준월 업로드',
      wide: true,
      body: `<p style="margin:0 0 12px">시트마다 기준월을 확인해 주세요. [모두 저장]을 누르면 각 기준월의 기존 내용을 바꿉니다.</p>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>시트</th><th>기준월</th><th>건수</th></tr></thead>
          <tbody>${sheets.map((s, k) => `<tr><td>${esc(s.sheet)}</td>
            <td><input class="input" type="month" name="m${k}" value="${s.month || ''}" required style="width:160px"></td>
            <td>${countText(s)}${warn(s)}</td></tr>`).join('')}</tbody></table></div>`,
      submitLabel: '모두 저장',
      onSubmit: async (form) => {
        const f = new FormData(form);
        for (let k = 0; k < sheets.length; k++) {
          const m = f.get(`m${k}`);
          if (!/^\d{4}-\d{2}$/.test(m)) throw new Error(`${sheets[k].sheet}: 기준월을 입력해 주세요.`);
          await api(`/api/mgmt/ledger/${m}`, { method: 'PUT', body: { entries: sheets[k].entries } });
        }
        toast(`${sheets.length}개 기준월을 저장했습니다.`);
        await load();
      },
    });
  });

  await load();
  return () => {};
}
