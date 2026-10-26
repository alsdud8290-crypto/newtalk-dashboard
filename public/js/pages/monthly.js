import { api, comma, won, parseMoney, bindMoneyInputs, toast, period, setPeriod, yearOptions } from '../core.js';
import { datasetSheet, downloadXlsx, downloadCsv, stamp } from '../exporter.js';

export const FIELDS = [
  ['product_sales', '제품 매출액', 'sales'],
  ['goods_sales', '상품 매출액', 'sales'],
  ['service_sales', '용역 매출액', 'sales'],
  ['product_purchase', '상품 매입액', 'cost'],
  ['material_purchase', '원재료 매입액', 'cost'],
  ['expense', '경비 지출액', 'cost'],
  ['ad_expense', '광고선전비', 'cost'],
  ['entertainment_expense', '접대비', 'cost'],
  ['other_expense', '그 외 지출액', 'cost'],
];
const TYPE_FIELD = { 제품: 'product_sales', 상품: 'goods_sales', 용역: 'service_sales' };

export async function render(main, ctx) {
  let year = period.year;
  let dirty = false;

  main.innerHTML = `
    <div class="page-head">
      <div><h2>월별 실적·목표 입력</h2><div class="sub">경영지원팀 · 금액은 원 단위 숫자로 입력합니다.</div></div>
      <div class="filters"><select class="input" id="m-year">${yearOptions(year, ctx.meta.years)}</select></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>연간 목표매출액</h3><span class="hint">대시보드 달성률·목표 페이스 계산 기준</span></div>
      <form id="t-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input class="input money" name="revenue" style="max-width:260px" placeholder="예: 5,000,000,000">
        <span id="t-won" class="hint" style="color:var(--text-3)"></span>
        <button class="btn primary">목표 저장</button>
      </form>
    </div>
    <div class="card">
      <div class="card-head">
        <h3 id="m-title"></h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn sm" id="m-xlsx">⬇ 엑셀</button>
          <button class="btn sm" id="m-csv">⬇ CSV</button>
          <button class="btn sm" id="m-fill">매출 내역 합계로 매출 채우기</button>
          <button class="btn sm primary" id="m-save">월별 실적 저장</button>
        </div>
      </div>
      <div class="table-wrap"><table class="tbl edit" id="m-table"></table></div>
    </div>`;

  const tForm = main.querySelector('#t-form');
  const tInput = tForm.querySelector('input');
  const table = main.querySelector('#m-table');
  let detail = [];

  const updateTargetHint = () => { main.querySelector('#t-won').textContent = parseMoney(tInput.value) ? `= ${won(parseMoney(tInput.value))} (분기 ${won(parseMoney(tInput.value) / 4)})` : ''; };
  tInput.addEventListener('input', updateTargetHint);
  tInput.addEventListener('blur', updateTargetHint);
  bindMoneyInputs(tForm);

  tForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/mgmt/targets/${year}`, { method: 'PUT', body: { revenue: parseMoney(tInput.value) } });
      toast(`${year}년 목표매출액을 저장했습니다.`);
    } catch (err) { toast(err.message, true); }
  });

  function totals() {
    const rows = [...table.querySelectorAll('tbody tr')];
    rows.forEach((tr) => {
      const v = (f) => parseMoney(tr.querySelector(`[name=${f}]`).value);
      tr.querySelector('.s-total').textContent = comma(FIELDS.filter((f) => f[2] === 'sales').reduce((a, f) => a + v(f[0]), 0));
      tr.querySelector('.c-total').textContent = comma(FIELDS.filter((f) => f[2] === 'cost').reduce((a, f) => a + v(f[0]), 0));
    });
    const foot = table.querySelector('tfoot tr');
    FIELDS.forEach(([f], i) => {
      foot.children[i + 1 + (i >= 3 ? 1 : 0)].textContent = comma(rows.reduce((a, tr) => a + parseMoney(tr.querySelector(`[name=${f}]`).value), 0));
    });
    foot.querySelector('.s-total').textContent = comma(rows.reduce((a, tr) => a + parseMoney(tr.querySelector('.s-total').textContent), 0));
    foot.querySelector('.c-total').textContent = comma(rows.reduce((a, tr) => a + parseMoney(tr.querySelector('.c-total').textContent), 0));
  }

  async function load() {
    main.querySelector('#m-title').textContent = `${year}년 월별 실적`;
    const [t, m] = await Promise.all([api(`/api/mgmt/targets/${year}`), api(`/api/mgmt/monthly/${year}`)]);
    tInput.value = t.revenue ? comma(t.revenue) : '';
    updateTargetHint();
    detail = m.detail;
    const byMonth = Object.fromEntries(m.rows.map((r) => [r.month, r]));
    const sales = FIELDS.filter((f) => f[2] === 'sales');
    const costs = FIELDS.filter((f) => f[2] === 'cost');
    const cell = (mo, f) => `<td><input class="input money" name="${f}" value="${comma(byMonth[mo]?.[f] || '')}"></td>`;
    table.innerHTML = `
      <thead><tr><th class="c">월</th>${sales.map((f) => `<th class="r">${f[1]}</th>`).join('')}<th class="r">매출 합계</th>
        ${costs.map((f) => `<th class="r">${f[1]}</th>`).join('')}<th class="r">지출 합계</th></tr></thead>
      <tbody>${Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => `
        <tr data-month="${mo}"><td class="c"><b>${mo}월</b></td>${sales.map((f) => cell(mo, f[0])).join('')}<td class="r num s-total"></td>
        ${costs.map((f) => cell(mo, f[0])).join('')}<td class="r num c-total"></td></tr>`).join('')}</tbody>
      <tfoot><tr><td class="c">합계</td>${sales.map(() => '<td class="r num"></td>').join('')}<td class="r num s-total"></td>
        ${costs.map(() => '<td class="r num"></td>').join('')}<td class="r num c-total"></td></tr></tfoot>`;
    bindMoneyInputs(table);
    table.querySelectorAll('input').forEach((el) => el.addEventListener('input', () => { dirty = true; }));
    table.querySelectorAll('input').forEach((el) => el.addEventListener('blur', totals));
    totals();
    dirty = false;
  }

  main.querySelector('#m-year').addEventListener('change', async (e) => {
    if (dirty && !window.confirm('저장하지 않은 변경 사항이 있습니다. 연도를 바꾸시겠습니까?')) { e.target.value = year; return; }
    year = Number(e.target.value);
    setPeriod({ year });
    await load();
  });

  main.querySelector('#m-fill').addEventListener('click', () => {
    if (!detail.length) return toast('이 연도의 매출 내역이 없습니다.', true);
    for (const d of detail) {
      const tr = table.querySelector(`tr[data-month="${d.month}"]`);
      const input = tr?.querySelector(`[name=${TYPE_FIELD[d.sales_type]}]`);
      if (input) input.value = comma(d.amount);
    }
    // 내역이 없는 월·구분은 그대로 둔다
    dirty = true;
    totals();
    toast('매출 내역 합계를 채웠습니다. 확인 후 저장해 주세요.');
  });

  // 화면의 표 값 그대로 내려받기 (엑셀에는 연간 목표 시트도 포함)
  const tableRows = () => [...table.querySelectorAll('tbody tr')].map((tr) => ({
    year, month: Number(tr.dataset.month),
    ...Object.fromEntries(FIELDS.map(([f]) => [f, parseMoney(tr.querySelector(`[name=${f}]`).value)])),
  }));
  main.querySelector('#m-xlsx').addEventListener('click', () => {
    if (dirty) toast('저장하지 않은 변경 사항도 화면 그대로 포함됩니다.');
    downloadXlsx(`뉴토크코리아_월별실적_${year}년_${stamp()}`, [
      datasetSheet('targets', [{ year, revenue: parseMoney(tInput.value) }]),
      datasetSheet('monthly', tableRows()),
    ]);
  });
  main.querySelector('#m-csv').addEventListener('click', () => downloadCsv(`뉴토크코리아_월별실적_${year}년_${stamp()}`, datasetSheet('monthly', tableRows())));

  main.querySelector('#m-save').addEventListener('click', async () => {
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => ({
      month: Number(tr.dataset.month),
      ...Object.fromEntries(FIELDS.map(([f]) => [f, parseMoney(tr.querySelector(`[name=${f}]`).value)])),
    }));
    try {
      await api(`/api/mgmt/monthly/${year}`, { method: 'PUT', body: { rows } });
      dirty = false;
      toast(`${year}년 월별 실적을 저장했습니다.`);
      ctx.reloadMeta();
    } catch (err) { toast(err.message, true); }
  });

  await load();
  return () => {};
}

