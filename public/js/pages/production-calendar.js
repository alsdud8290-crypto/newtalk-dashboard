// 납기 캘린더 (ITB2026에서 옮겨 옴): 제조내역 납기일을 날짜별·수주번호별로. 처리 상태는 출고일로 판단
//  앞으로 처리할 건은 진하게, 출고 완료 건은 흐리게 + 기호(! ○ ◐ ✓). 범례에 상태별 건수, 출고 완료 숨기기
//  날짜를 누르면 그날 수주번호·판매처·사업명·대수·일련번호. 아래 "납기 검색"은 모든 달에서 찾음
import { api, esc } from '../core.js';
import { DUE_STATUS, DUE_STATUS_ORDER, statusKey, statusChip, dDayChip, orderLabel, qty, dash } from './prod-common.js';

const p2 = (n) => String(n).padStart(2, '0');

export async function render(main) {
  const now = new Date();
  const start = sessionStorage.getItem('calendarDate');
  sessionStorage.removeItem('calendarDate');
  const st = {
    year: start ? +start.slice(0, 4) : now.getFullYear(),
    month: start ? +start.slice(5, 7) : now.getMonth() + 1,
    selected: start || '',
    hideDone: (() => { try { return localStorage.getItem('calendar.hideDone') === '1'; } catch { return false; } })(),
    highlight: new Set(),
  };
  let data = null;

  main.innerHTML = `
    <div class="page-head"><div><h2>납기 캘린더</h2><div class="sub">제조내역의 납기일 기준 · 수주번호(PO번호)별 대수 · 처리 상태는 출고일로 판단</div></div></div>
    <div class="card" style="margin-bottom:16px" id="cal-card"></div>
    <div id="cal-day"></div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div class="ttl"><h3>납기 검색</h3><span class="hint">수주번호(# 없이도)·판매처·사업명·일련번호·거래처 주문번호 — 모든 달에서 찾음</span></div></div>
      <form id="cal-search" class="filters"><input class="input" name="q" placeholder="예: 26006, 가람, N82265001" style="width:280px"><button class="btn primary">검색</button></form>
      <div id="cal-results" style="margin-top:12px"></div>
    </div>`;
  const $ = (s) => main.querySelector(s);

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
      cells.push(`<button type="button" class="cal-cell ${iso === data.today ? 'today' : ''} ${iso === st.selected ? 'sel' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}" data-date="${iso}">
        <span class="d">${d}</span>
        ${orders.slice(0, 3).map((o) => { const s = DUE_STATUS[statusKey(o)]; return `<span class="cal-ev ${s.cls} ${st.highlight.has(`${o.due_date}|${o.po_no}`) ? 'hl' : ''}" title="${s.label}">${s.icon} ${o.po_no ? `#${esc(o.po_no)}` : '번호 없음'} · ${o.quantity}대</span>`; }).join('')}
        ${orders.length > 3 ? `<span class="cal-more">+${orders.length - 3}건</span>` : ''}
      </button>`);
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
    drawDay();
  }

  function drawDay() {
    const el = $('#cal-day');
    const orders = data.days.find((d) => d.date === st.selected)?.orders;
    if (!st.selected || st.selected.slice(0, 7) !== `${st.year}-${p2(st.month)}`) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="ttl"><h3>${st.selected} 납기</h3><span class="hint">${orders ? `수주 ${orders.length}건 · ${qty(orders.reduce((a, o) => a + o.quantity, 0))}` : '이날 납기가 없습니다'}</span></div></div>
        ${orders ? `<div class="table-wrap"><table class="tbl">
          <thead><tr><th>상태</th><th>수주번호</th><th>판매처</th><th>사업명</th><th class="r">출고 / 대수</th><th>일련번호</th></tr></thead>
          <tbody>${orders.map((o) => `<tr class="${o.status === 'done' ? 'dim' : ''} ${st.highlight.has(`${o.due_date}|${o.po_no}`) ? 'sel' : ''}">
            <td>${statusChip(o)}</td><td><b>${orderLabel(o)}</b></td><td>${dash(o.customers.join(', '))}</td><td>${dash(o.projects.join(', '))}</td>
            <td class="r num">${o.shipped} / ${qty(o.quantity)}</td>
            <td class="wrap">${o.serials.map((s) => `<a href="#/production/serials" data-serial="${esc(s)}">${esc(s)}</a>`).join(' ')}</td></tr>`).join('')}</tbody>
        </table></div>` : ''}
      </div>`;
  }

  $('#cal-card').addEventListener('click', (e) => {
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
    if (cell) { st.selected = st.selected === cell.dataset.date ? '' : cell.dataset.date; draw(); }
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
      st.highlight = new Set(r.results.map((o) => `${o.due_date}|${o.po_no}`));
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
