import { api, esc, comma, won, parseMoney, toast, modal, confirmBox, today } from '../core.js';
import { datasetSheet, downloadCsv, downloadCompany, fileSafe, stamp, periodDownloadButton, bindPeriodDownload } from '../exporter.js';

export async function render(main, ctx) {
  let rows = [];
  let onlyOpen = true;
  let filter = '';

  main.innerHTML = `
    <div class="page-head">
      <div><h2>미수금 관리</h2><div class="sub">청구(세금계산서) 건별로 청구액과 수금액을 기록합니다. 잔액 = 청구액 − 수금액</div></div>
      <div class="filters">
        <div class="seg" id="r-open"><button type="button" data-v="1" class="on">미수 건만</button><button type="button" data-v="0">전체</button></div>
        <input class="input" id="r-filter" placeholder="거래처 검색" style="width:160px">
        ${periodDownloadButton('r-dl')}
        <button class="btn primary" id="r-add">+ 청구 등록</button>
      </div>
    </div>
    <div class="card"><div class="table-wrap" id="r-table"></div></div>`;

  const form = (r) => { r = r || {}; return `
    <div class="form-grid">
      <div class="field full"><label>거래처 *</label><input class="input" name="customer" list="dl-c" value="${esc(r.customer || '')}" required></div>
      <div class="field"><label>청구일자 *</label><input class="input" type="date" name="invoice_date" value="${esc(r.invoice_date || today())}" required></div>
      <div class="field"><label>결제예정일</label><input class="input" type="date" name="due_date" value="${esc(r.due_date || '')}"></div>
      <div class="field"><label>청구액 (원) *</label><input class="input money" name="amount" value="${comma(r.amount || '')}" required></div>
      <div class="field"><label>수금액 (원)</label><input class="input money" name="collected" value="${comma(r.collected || '')}"></div>
      <div class="field"><label>수금일자</label><input class="input" type="date" name="collected_date" value="${esc(r.collected_date || '')}"></div>
      <div class="field"><label>비고</label><input class="input" name="note" value="${esc(r.note || '')}"></div>
    </div>
    <datalist id="dl-c">${ctx.meta.customers.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` };

  const read = (f) => {
    const d = Object.fromEntries(new FormData(f));
    d.amount = parseMoney(d.amount);
    d.collected = parseMoney(d.collected);
    return d;
  };

  function edit(r) {
    modal({
      title: r ? '미수금 수정 / 수금 처리' : '청구 등록',
      body: form(r),
      onSubmit: async (f) => {
        await api(r ? `/api/mgmt/receivables/${r.id}` : '/api/mgmt/receivables', { method: r ? 'PUT' : 'POST', body: read(f) });
        toast('저장했습니다.');
        await ctx.reloadMeta();
        await load();
      },
    });
  }

  const ageDays = (d) => Math.floor((Date.now() - new Date(d + 'T00:00:00')) / 86400000);

  function draw() {
    const q = filter.toLowerCase();
    const list = q ? rows.filter((r) => r.customer.toLowerCase().includes(q)) : rows;
    const sum = (k) => list.reduce((a, r) => a + r[k], 0);
    const t = today();
    main.querySelector('#r-table').innerHTML = list.length ? `
      <table class="tbl">
        <thead><tr><th>거래처</th><th>청구일자</th><th class="r">경과일</th><th>결제예정일</th><th class="r">청구액</th><th class="r">수금액</th><th class="r">잔액</th><th>수금일자</th><th>비고</th><th></th></tr></thead>
        <tbody>${list.map((r) => {
          const bal = r.amount - r.collected;
          const overdue = bal > 0.5 && r.due_date && r.due_date < t;
          const days = ageDays(r.invoice_date);
          return `<tr>
          <td>${esc(r.customer)}</td><td>${esc(r.invoice_date)}</td>
          <td class="r num">${bal > 0.5 ? `${days}일${days > 90 ? ' <span class="status-chip critical">90+</span>' : ''}` : '-'}</td>
          <td>${esc(r.due_date)}${overdue ? ' <span class="status-chip warning">! 경과</span>' : ''}</td>
          <td class="r num">${comma(r.amount)}</td><td class="r num">${comma(r.collected)}</td>
          <td class="r num"><b>${bal > 0.5 ? comma(bal) : '<span class="status-chip good">✓ 완료</span>'}</b></td>
          <td>${esc(r.collected_date)}</td><td>${esc(r.note)}</td>
          <td class="r"><button class="btn sm" data-edit="${r.id}">수정</button> <button class="btn sm danger" data-del="${r.id}">삭제</button></td></tr>`;
        }).join('')}</tbody>
        <tfoot><tr><td colspan="4">${list.length}건 합계</td><td class="r num">${comma(sum('amount'))}</td><td class="r num">${comma(sum('collected'))}</td>
          <td class="r num">${comma(sum('amount') - sum('collected'))}</td><td colspan="3">잔액 ${won(sum('amount') - sum('collected'))}</td></tr></tfoot>
      </table>` : `<div class="empty">${onlyOpen ? '미수 잔액이 남은 청구 건이 없습니다.' : '등록된 청구 건이 없습니다.'} <a href="#/upload">엑셀(수금) 파일 업로드 →</a></div>`;
  }

  async function load() {
    rows = await api(`/api/mgmt/receivables${onlyOpen ? '?open=1' : ''}`);
    draw();
  }

  main.querySelector('#r-open').addEventListener('click', (e) => {
    if (!e.target.dataset.v) return;
    onlyOpen = e.target.dataset.v === '1';
    main.querySelectorAll('#r-open button').forEach((b) => b.classList.toggle('on', b === e.target));
    load();
  });
  main.querySelector('#r-filter').addEventListener('input', (e) => { filter = e.target.value; draw(); });
  main.querySelector('#r-add').addEventListener('click', () => edit(null));
  // 내려받기: 기간을 고르면 그 기간에 청구된 건(미수·수금 완료 모두) + 엑셀은 달마다 월말 기준 미수금 현황
  //           '전체'는 지금 화면처럼(미수 건만/전체) + 이번 달 미수금 현황
  const match = (r) => !filter || r.customer.toLowerCase().includes(filter.toLowerCase());
  bindPeriodDownload(main, 'r-dl', {
    mode: 'month',
    hint: '기간을 고르면 그 기간에 청구된 건이 모두 담기고, 엑셀에는 달마다 월말 기준 미수금 현황 시트가 들어갑니다. \'전체\'는 지금 화면(미수 건만/전체) 그대로입니다. 검색어를 입력해 두면 그 거래처만 담깁니다.',
    onExcel: (p) => downloadCompany({ kind: 'receivables', period: p, open: !p && onlyOpen ? '1' : '', q: filter }),
    onCsv: async (p, label) => {
      const list = p ? (await api(`/api/mgmt/export?period=${p}`)).receivables.filter(match) : [...rows.filter(match)].reverse();
      downloadCsv(fileSafe(`뉴토크코리아_미수금_${p ? label : onlyOpen ? '미수건' : '전체'}${filter ? `_${filter}` : ''}_${stamp()}`), datasetSheet('receivables', list));
    },
  });
  main.querySelector('#r-table').addEventListener('click', async (e) => {
    const id = Number(e.target.dataset.edit || e.target.dataset.del);
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    if (e.target.dataset.edit) return edit(r);
    if (await confirmBox(`${r.customer} ${r.invoice_date} 청구 건(${won(r.amount)})을 삭제할까요?`, '삭제')) {
      await api(`/api/mgmt/receivables/${id}`, { method: 'DELETE' });
      toast('삭제했습니다.');
      load();
    }
  });

  await load();
}
