// 납기 캘린더 (ITB2026에서 옮겨 옴): 제조내역 납기일을 날짜별·수주번호별로. 처리 상태는 출고일로 판단
//  앞으로 처리할 건은 진하게, 출고 완료 건은 흐리게 + 기호(! ○ ◐ ✓). 범례에 상태별 건수, 출고 완료 숨기기
//  항목 왼쪽 체크박스 = 출고 완료 (체크하면 출고일이 빈 제품의 출고일을 납기일로, 해제하면 출고일을 지움 — 수정 권한자만)
//  항목(또는 날짜)을 누르면 아래 상세에서 수주번호·판매처·사업명·대수·일련번호와 실제 출고일을 고칠 수 있다
//  납기일과 실제 출고일은 따로 저장된다 (출고일을 고쳐도 납기일·달력 위치는 그대로). 아래 "납기 검색"은 모든 달에서 찾음
import { api, esc, toast } from '../core.js';
import { DUE_STATUS, DUE_STATUS_ORDER, statusKey, statusChip, dDayChip, orderLabel, qty, dash } from './prod-common.js';

const p2 = (n) => String(n).padStart(2, '0');
const keyOf = (o) => `${o.due_date}|${o.po_no}`;
// 체크박스: 모두 출고 = 체크, 일부 출고 = 중간 상태(−)
const shipBox = (o, editable, cls = '') => `<input type="checkbox" class="ship-chk ${cls}" data-key="${esc(keyOf(o))}" ${o.status === 'done' ? 'checked' : ''}
  ${o.status === 'partial' ? 'data-partial' : ''} ${editable ? '' : 'disabled'} title="${o.status === 'done' ? '출고 완료 — 해제하면 출고일을 지웁니다' : '출고 완료로 표시 (출고일 = 납기일, 아래 상세에서 고칠 수 있음)'}" aria-label="출고 완료">`;

export async function render(main, ctx) {
  const editable = !!ctx?.canEdit?.('production');
  const now = new Date();
  const start = sessionStorage.getItem('calendarDate');
  sessionStorage.removeItem('calendarDate');
  const st = {
    year: start ? +start.slice(0, 4) : now.getFullYear(),
    month: start ? +start.slice(5, 7) : now.getMonth() + 1,
    selected: start || '',
    focus: '', // 상세에서 강조할 항목 (달력에서 누른 수주)
    hideDone: (() => { try { return localStorage.getItem('calendar.hideDone') === '1'; } catch { return false; } })(),
    highlight: new Set(),
  };
  let data = null;

  main.innerHTML = `
    <div class="page-head"><div><h2>납기 캘린더</h2><div class="sub">제조내역의 납기일 기준 · 수주번호(PO번호)별 대수 · 처리 상태는 출고일로 판단${editable ? ' · 체크박스 = 출고 완료, 항목을 누르면 아래에서 실제 출고일 수정' : ''}</div></div></div>
    <div class="card" style="margin-bottom:16px" id="cal-card"></div>
    <div id="cal-day"></div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="ttl"><h3>납기 검색</h3><span class="hint">수주번호(# 없이도)·판매처·사업명·일련번호·거래처 주문번호 — 모든 달에서 찾음</span></div></div>
      <form id="cal-search" class="filters"><input class="input" name="q" placeholder="예: 26006, 가람, N82265001" style="width:280px"><button class="btn primary">검색</button></form>
      <div id="cal-results" style="margin-top:12px"></div>
    </div>`;
  const $ = (s) => main.querySelector(s);
  const findOrder = (key) => data?.days.flatMap((d) => d.orders).find((o) => keyOf(o) === key);
  // 일부 출고는 체크박스 중간 상태로 (HTML 속성으로는 못 정해서 그린 뒤에 설정)
  const markPartial = (el) => el.querySelectorAll('.ship-chk[data-partial]').forEach((c) => { c.indeterminate = true; });

  async function load() {
    data = await api(`/api/production/due-calendar?year=${st.year}&month=${st.month}`);
    draw();
  }

  function draw() {
    const byDate = Object.fromEntries(data.days.map((d) => [d.date, d.orders]));
    const counts = Object.fromEntries(DUE_STATUS_ORDER.map((k) => [k, 0]));
    data.days.forEach((d) => d.orders.forEach((o) => { counts[statusKey(o)] += 1; }));
    const first = new Date(st.year, st.month - 1, 1).getDay(); // 0=일
    const days = new Date(st.year, st.month, 0).getDate();
    const cells = [];
    for (let i = 0; i < first; i += 1) cells.push('<div class="cal-cell empty"></div>');
    for (let d = 1; d <= days; d += 1) {
      const iso = `${st.year}-${p2(st.month)}-${p2(d)}`;
      const orders = (byDate[iso] || []).filter((o) => !(st.hideDone && o.status === 'done'));
      const dow = (first + d - 1) % 7;
      // 칸 안에 체크박스가 있어 <button> 대신 div(역할 = 버튼)
      cells.push(`<div role="button" tabindex="0" class="cal-cell ${iso === data.today ? 'today' : ''} ${iso === st.selected ? 'sel' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}" data-date="${iso}">
        <span class="d">${d}</span>
        ${orders.slice(0, 3).map((o) => { const s = DUE_STATUS[statusKey(o)]; return `<span class="cal-ev ${s.cls} ${st.highlight.has(keyOf(o)) ? 'hl' : ''}" data-ev="${esc(keyOf(o))}" title="${s.label} — 누르면 아래에서 실제 출고일 수정">${shipBox(o, editable)}<span class="ev-t">${s.icon} ${o.po_no ? `#${esc(o.po_no)}` : '번호 없음'} · ${o.quantity}대</span></span>`; }).join('')}
        ${orders.length > 3 ? `<span class="cal-more">+${orders.length - 3}건</span>` : ''}
      </div>`);
    }
    $('#cal-card').innerHTML = `
      <div class="card-head">
        <div class="filters"><button class="btn sm" data-nav="-1">◀</button><h3 style="margin:0 6px">${st.year}년 ${st.month}월</h3><button class="btn sm" data-nav="1">▶</button>
          <button class="btn sm" data-nav="0">이번 달</button></div>
        <div class="filters cal-legend">
          ${DUE_STATUS_ORDER.map((k) => `<span class="status-chip ${DUE_STATUS[k].cls}">${DUE_STATUS[k].icon} ${DUE_STATUS[k].label} ${counts[k]}</span>`).join('')}
          <label class="chk"><input type="checkbox" id="cal-hide" ${st.hideDone ? 'checked' : ''}> 출고 완료 건 숨기기</label>
        </div>
      </div>
      <div class="cal-grid">${['일', '월', '화', '수', '목', '금', '토'].map((w) => `<div class="cal-w">${w}</div>`).join('')}${cells.join('')}</div>`;
    markPartial($('#cal-card'));
    drawDay();
  }

  // 실제 출고일 칸: 모두 같은 날 출고면 그 날짜, 아직이거나 날짜가 섞여 있으면 빈 칸 + 안내
  const shippedText = (o) => (!o.shipped_dates.length ? '' : o.shipped_dates.length === 1 && o.shipped === o.quantity ? '' : `<div class="hint">지금: ${o.shipped_dates.map(esc).join(', ')}${o.shipped < o.quantity ? ` (${o.shipped}/${o.quantity}대)` : ''}</div>`);
  function drawDay() {
    const el = $('#cal-day');
    const orders = data.days.find((d) => d.date === st.selected)?.orders;
    if (!st.selected || st.selected.slice(0, 7) !== `${st.year}-${p2(st.month)}`) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="ttl"><h3>${st.selected} 납기</h3><span class="hint">${orders ? `수주 ${orders.length}건 · ${qty(orders.reduce((a, o) => a + o.quantity, 0))}` : '이날 납기가 없습니다'}</span></div></div>
        ${orders ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th class="c">출고</th><th>상태</th><th>수주번호</th><th>판매처</th><th>사업명</th><th class="r">출고 / 대수</th><th>실제 출고일 <span class="muted">(납기일 ${st.selected})</span></th><th>일련번호</th></tr></thead>
          <tbody>${orders.map((o) => `<tr data-row="${esc(keyOf(o))}" class="${o.status === 'done' ? 'dim' : ''} ${st.highlight.has(keyOf(o)) || st.focus === keyOf(o) ? 'sel' : ''}">
            <td class="c">${shipBox(o, editable)}</td>
            <td>${statusChip(o)}</td><td><b>${orderLabel(o)}</b></td><td>${dash(o.customers.join(', '))}</td><td>${dash(o.projects.join(', '))}</td>
            <td class="r num">${o.shipped} / ${qty(o.quantity)}</td>
            <td>${editable ? `<form class="filters ship-form" data-key="${esc(keyOf(o))}" style="flex-wrap:nowrap;gap:6px">
                <input class="input" type="date" name="d" value="${o.shipped_dates.length === 1 && o.shipped === o.quantity ? o.shipped_dates[0] : ''}" style="width:150px" aria-label="실제 출고일">
                <button class="btn sm primary">저장</button></form>${shippedText(o)}`
              : esc(o.shipped_dates.join(', ') || '-')}</td>
            <td class="wrap">${o.serials.map((s) => `<a href="#/production/serials" data-serial="${esc(s)}">${esc(s)}</a>`).join(' ')}</td></tr>`).join('')}</tbody>
        </table></div>
        ${editable ? '<p class="hint" style="margin:10px 0 0">실제 출고일을 저장하면 이 수주의 모든 제품 출고일이 그 날짜로 바뀝니다. 납기일과 달력 위치는 바뀌지 않습니다.</p>' : ''}` : ''}
      </div>`;
    markPartial(el);
  }

  // 출고 처리 저장 → 그 달을 다시 읽어 상태·건수를 새로 그림
  async function ship(key, body) {
    const o = findOrder(key);
    if (!o) return;
    try {
      const r = await api('/api/production/due-calendar/shipment', { method: 'PATCH', body: { due_date: o.due_date, po_no: o.po_no, ...body } });
      toast(`${o.po_no ? `#${o.po_no}` : '수주번호 없음'} ${body.shipped ? `출고 완료 (출고일 ${r.shipped_dates.join(', ')})` : '출고 전으로 되돌렸습니다'}`);
    } catch (err) { toast(err.message, true); }
    await load();
  }

  // (main은 화면이 바뀌어도 그대로라 여기 붙이면 다시 열 때마다 겹친다 → 이 화면이 새로 만드는 칸에 붙임)
  const onShipChange = (e) => {
    const c = e.target.closest?.('.ship-chk');
    if (!c || c.disabled) return;
    ship(c.dataset.key, { shipped: c.checked });
  };
  $('#cal-card').addEventListener('change', onShipChange);
  $('#cal-day').addEventListener('change', onShipChange);
  $('#cal-day').addEventListener('submit', (e) => {
    const f = e.target.closest('.ship-form');
    if (!f) return;
    e.preventDefault();
    if (!f.d.value) { toast('실제 출고일을 골라 주세요. 출고 전으로 되돌리려면 체크를 해제하세요.', true); return; }
    ship(f.dataset.key, { shipped: true, shipped_date: f.d.value });
  });

  const selectDay = (iso, focus = '') => {
    st.focus = focus;
    st.selected = focus ? iso : (st.selected === iso ? '' : iso);
    draw();
    if (focus) $('#cal-day').querySelector('tr.sel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  $('#cal-card').addEventListener('click', (e) => {
    if (e.target.closest('input')) return; // 체크박스는 change에서 처리
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const n = Number(nav.dataset.nav);
      if (!n) { st.year = now.getFullYear(); st.month = now.getMonth() + 1; } else {
        const d = new Date(st.year, st.month - 1 + n, 1);
        st.year = d.getFullYear(); st.month = d.getMonth() + 1;
      }
      st.selected = '';
      load();
      return;
    }
    const cell = e.target.closest('[data-date]');
    if (cell) selectDay(cell.dataset.date, e.target.closest('[data-ev]')?.dataset.ev || '');
  });
  $('#cal-card').addEventListener('keydown', (e) => {
    const cell = e.target.closest?.('.cal-cell[data-date]');
    if (cell && e.target === cell && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectDay(cell.dataset.date); }
  });
  $('#cal-card').addEventListener('change', (e) => {
    if (e.target.id !== 'cal-hide') return;
    st.hideDone = e.target.checked;
    try { localStorage.setItem('calendar.hideDone', st.hideDone ? '1' : '0'); } catch { /* 무시 */ }
    draw();
  });
  main.addEventListener('click', (e) => { const a = e.target.closest('[data-serial]'); if (a) sessionStorage.setItem('serialQuery', a.dataset.serial); });

  // 납기 검색: 줄을 누르면 위 달력의 그 달·날짜로 이동, 검색에 걸린 수주는 테두리로 강조
  $('#cal-search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (!q) return;
    try {
      const r = await api(`/api/production/due-calendar/search?q=${encodeURIComponent(q)}`);
      st.highlight = new Set(r.results.map(keyOf));
      $('#cal-results').innerHTML = !r.results.length ? `<div class="notice warn" style="margin:0">"${esc(q)}"에 맞는 납기가 없습니다.</div>` : `
        <div class="hint" style="margin-bottom:6px">${r.total}건${r.total > r.limit ? ` 중 최근 ${r.limit}건` : ''} · 줄을 누르면 달력의 그 날짜로 이동</div>
        <div class="table-wrap"><table class="tbl click"><thead><tr><th>상태</th><th>납기일</th><th>D-day</th><th>수주번호</th><th>판매처</th><th>사업명</th><th class="r">출고 / 대수</th></tr></thead>
        <tbody>${r.results.map((o) => `<tr data-go="${o.due_date}"><td>${statusChip(o)}</td><td>${o.due_date}</td><td>${dDayChip(o.d_day)}</td><td><b>${orderLabel(o)}</b></td>
          <td>${dash(o.customers.join(', '))}</td><td>${dash(o.projects.join(', '))}</td><td class="r num">${o.shipped} / ${qty(o.quantity)}</td></tr>`).join('')}</tbody></table></div>`;
      draw();
    } catch (err) { $('#cal-results').innerHTML = `<div class="notice err" style="margin:0">${esc(err.message)}</div>`; }
  });
  $('#cal-results').addEventListener('click', async (e) => {
    const tr = e.target.closest('[data-go]');
    if (!tr) return;
    const iso = tr.dataset.go;
    st.year = +iso.slice(0, 4); st.month = +iso.slice(5, 7); st.selected = iso;
    await load();
    $('#cal-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  await load();
}
