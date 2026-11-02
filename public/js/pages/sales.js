import { api, esc, comma, won, parseMoney, toast, modal, confirmBox, period, setPeriod, yearOptions, today, VIEW_ONLY } from '../core.js';
import { datasetSheet, downloadCsv, downloadCompany, fileSafe, stamp, periodDownloadButton, bindPeriodDownload } from '../exporter.js';

export async function render(main, ctx) {
  let year = period.year;
  // 조회 기간: 연간 / 분기 / 월 (이 브라우저에 기억). 연도별로 받아 화면에서 그 기간만 거름
  const now = new Date();
  const view = (() => {
    const base = { kind: 'year', month: now.getMonth() + 1, quarter: Math.ceil((now.getMonth() + 1) / 3) };
    try { return { ...base, ...JSON.parse(localStorage.getItem('sales.view') || '{}') }; } catch { return base; }
  })();
  const saveView = () => { try { localStorage.setItem('sales.view', JSON.stringify(view)); } catch { /* 무시 */ } };
  const viewMonths = () => (view.kind === 'month' ? [view.month] : view.kind === 'quarter' ? [view.quarter * 3 - 2, view.quarter * 3 - 1, view.quarter * 3] : null);
  const viewLabel = () => (view.kind === 'month' ? `${year}년 ${view.month}월` : view.kind === 'quarter' ? `${year}년 ${view.quarter}분기` : `${year}년`);
  let rows = [];
  let filter = '';
  const editable = ctx.canEdit('mgmt');

  main.innerHTML = `
    <div class="page-head">
      <div><h2>매출 내역 (판매처별)</h2><div class="sub">산업 분야·제품 시리즈 비중 그래프와 판매처 순위의 기준 데이터입니다.</div></div>
      <div class="filters">
        <select class="input" id="s-year">${yearOptions(year, ctx.meta.years)}</select>
        <div class="seg" id="s-kind">${[['year', '연간'], ['quarter', '분기'], ['month', '월']].map(([v, l]) => `<button type="button" data-kind="${v}" class="${view.kind === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="input" id="s-quarter" ${view.kind === 'quarter' ? '' : 'hidden'}>${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === view.quarter ? 'selected' : ''}>${q}분기 (${q * 3 - 2}~${q * 3}월)</option>`).join('')}</select>
        <select class="input" id="s-month" ${view.kind === 'month' ? '' : 'hidden'}>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === view.month ? 'selected' : ''}>${i + 1}월</option>`).join('')}</select>
        <input class="input" id="s-filter" placeholder="판매처·시리즈 검색" style="width:180px">
        ${periodDownloadButton('s-dl')}
        ${editable ? '<button class="btn primary" id="s-add">+ 매출 등록</button>' : ''}
      </div>
    </div>
    ${editable ? '' : VIEW_ONLY}
    <div class="card"><div class="table-wrap" id="s-table"></div></div>`;

  const form = (r) => { r = r || {}; return `
    <div class="form-grid">
      <div class="field"><label>일자 *</label><input class="input" type="date" name="date" value="${esc(r.date || today())}" required></div>
      <div class="field"><label>매출 구분 *</label><select class="input" name="sales_type">${ctx.meta.salesTypes.map((t) => `<option ${t === (r.sales_type || '제품') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field full"><label>판매처 (실제 판매처) *</label><input class="input" name="customer" list="dl-customers" value="${esc(r.customer || '')}" required></div>
      <div class="field"><label>산업 분야 *</label><select class="input" name="industry">${ctx.meta.industries.map((t) => `<option ${t === r.industry ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>제품 시리즈</label><input class="input" name="series" list="dl-series" value="${esc(r.series || '')}"></div>
      <div class="field full"><label>금액 (원) *</label><input class="input money" name="amount" value="${comma(r.amount || '')}" required></div>
      <div class="field full"><label>비고</label><input class="input" name="note" value="${esc(r.note || '')}"></div>
    </div>
    <datalist id="dl-customers">${ctx.meta.customers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <datalist id="dl-series">${ctx.meta.series.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` };

  const read = (f) => {
    const d = Object.fromEntries(new FormData(f));
    d.amount = parseMoney(d.amount);
    return d;
  };

  function edit(r) {
    modal({
      title: r ? '매출 수정' : '매출 등록',
      body: form(r),
      onSubmit: async (f) => {
        await api(r ? `/api/mgmt/sales/${r.id}` : '/api/mgmt/sales', { method: r ? 'PUT' : 'POST', body: read(f) });
        toast('저장했습니다.');
        await ctx.reloadMeta();
        await load();
      },
    });
  }

  function draw() {
    const q = filter.toLowerCase();
    const ms = viewMonths();
    const list = rows.filter((r) => (!ms || ms.includes(Number(r.date.slice(5, 7)))) && (!q || `${r.customer} ${r.series} ${r.note}`.toLowerCase().includes(q)));
    const total = list.reduce((a, r) => a + r.amount, 0);
    main.querySelector('#s-table').innerHTML = list.length ? `
      <table class="tbl">
        <thead><tr><th>일자</th><th>판매처</th><th>산업 분야</th><th>제품 시리즈</th><th>구분</th><th class="r">금액</th><th>비고</th><th></th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td>${esc(r.date)}</td><td>${esc(r.customer)}</td><td>${esc(r.industry)}</td><td>${esc(r.series)}</td><td>${esc(r.sales_type)}</td>
          <td class="r num">${comma(r.amount)}</td><td>${esc(r.note)}</td>
          <td class="r">${editable ? `<button class="btn sm" data-edit="${r.id}">수정</button> <button class="btn sm danger" data-del="${r.id}">삭제</button>` : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5">${viewLabel()} ${list.length}건 합계</td><td class="r num">${comma(total)}</td><td colspan="2">${won(total)}</td></tr></tfoot>
      </table>` : `<div class="empty">${viewLabel()} 매출 내역이 ${q ? '검색 결과에 ' : ''}없습니다. [+ 매출 등록] 또는 <a href="#/upload">경영 데이터 업로드</a>로 입력해 주세요.</div>`;
  }

  async function load() {
    rows = await api(`/api/mgmt/sales?year=${year}`);
    draw();
  }

  main.querySelector('#s-year').addEventListener('change', (e) => { year = Number(e.target.value); setPeriod({ year }); load(); });
  main.querySelector('#s-kind').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b || b.dataset.kind === view.kind) return;
    view.kind = b.dataset.kind;
    main.querySelectorAll('#s-kind [data-kind]').forEach((x) => x.classList.toggle('on', x === b));
    main.querySelector('#s-quarter').hidden = view.kind !== 'quarter';
    main.querySelector('#s-month').hidden = view.kind !== 'month';
    saveView();
    draw();
  });
  main.querySelector('#s-quarter').addEventListener('change', (e) => { view.quarter = Number(e.target.value); saveView(); draw(); });
  main.querySelector('#s-month').addEventListener('change', (e) => { view.month = Number(e.target.value); saveView(); draw(); });
  main.querySelector('#s-filter').addEventListener('input', (e) => { filter = e.target.value; draw(); });
  main.querySelector('#s-add')?.addEventListener('click', () => edit(null));
  // 내려받기: 기간(월·분기·연간·전체)을 골라서, 검색어가 있으면 검색 결과만
  const match = (r) => !filter || `${r.customer} ${r.series} ${r.note}`.toLowerCase().includes(filter.toLowerCase());
  bindPeriodDownload(main, 's-dl', {
    years: ctx.meta.years, year, mode: view.kind, month: view.month, quarter: view.quarter, currentYear: () => year,
    current: () => ({ mode: view.kind, month: view.month, quarter: view.quarter }), // 내려받기 창은 화면에서 고른 기간으로 시작
    hint: '검색어를 입력해 두면 검색 결과만 담깁니다.',
    onExcel: (p) => downloadCompany({ kind: 'sales', period: p, q: filter }),
    onCsv: async (p, label) => {
      const d = await api(`/api/mgmt/export${p ? `?period=${p}` : ''}`);
      downloadCsv(fileSafe(`뉴토크코리아_매출내역_${label}${filter ? `_${filter}` : ''}_${stamp()}`), datasetSheet('sales', d.sales.filter(match)));
    },
  });
  main.querySelector('#s-table').addEventListener('click', async (e) => {
    const id = Number(e.target.dataset.edit || e.target.dataset.del);
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    if (e.target.dataset.edit) return edit(r);
    if (await confirmBox(`${r.date} ${r.customer} ${won(r.amount)} 매출을 삭제할까요?`, '삭제')) {
      await api(`/api/mgmt/sales/${id}`, { method: 'DELETE' });
      toast('삭제했습니다.');
      load();
    }
  });

  await load();
}
