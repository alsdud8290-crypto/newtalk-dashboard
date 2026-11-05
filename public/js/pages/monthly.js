import { api, esc, comma, won, parseMoney, bindMoneyInputs, toast, period, setPeriod, yearOptions, VIEW_ONLY } from '../core.js';
import { datasetSheet, downloadCsv, downloadCompany, stamp, periodDownloadButton, bindPeriodDownload } from '../exporter.js';

// [필드, 이름, 묶음] — 매출: 손익계산서 매출액·영업외수익 / 지출: 손익계산서 + 제조원가명세서 / 미수금 총액: 월말 잔액 수기 입력
export const FIELDS = [
  ['product_sales', '제품매출', 'sales'],
  ['goods_sales', '상품매출', 'sales'],
  ['service_sales', '용역매출', 'sales'],
  ['non_op_income', '영업외수익', 'sales'],
  ['product_purchase', '상품 매입', 'cost'],
  ['sga_expense', '판관비', 'cost'],
  ['non_op_expense', '영업외비용', 'cost'],
  ['material_purchase', '원재료 매입', 'cost'],
  ['labor_cost', '노무비', 'cost'],
  ['expense', '경비', 'cost'],
  ['receivables_total', '미수금 총액', 'recv'],
];
const LABEL = Object.fromEntries(FIELDS.map(([f, l]) => [f, l]));
const TYPE_FIELD = { 제품: 'product_sales', 상품: 'goods_sales', 용역: 'service_sales' };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

export async function render(main, ctx) {
  let year = period.year;
  let dirty = false;
  const editable = ctx.canEdit('mgmt');

  main.innerHTML = `
    <div class="page-head">
      <div><h2>월별 실적·목표 입력</h2><div class="sub">경영지원팀 · 금액은 원 단위 숫자로 입력합니다.</div></div>
      <div class="filters"><select class="input" id="m-year">${yearOptions(year, ctx.meta.years)}</select></div>
    </div>
    ${editable ? '<div id="st-box"></div>' : ''}
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
        <div class="ttl"><h3 id="m-title"></h3><span class="hint">미수금 총액은 그 달 말 기준 잔액을 직접 입력합니다</span></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${periodDownloadButton('m-dl')}
          <button class="btn sm" id="m-fill">매출 내역 합계로 매출 채우기</button>
          <button class="btn sm primary" id="m-save">월별 실적 저장</button>
        </div>
      </div>
      <div class="table-wrap"><table class="tbl edit month-grid" id="m-table"></table></div>
    </div>`;

  // 열람 전용: 입력칸은 읽기만, 저장·채우기 버튼은 숨김
  if (!editable) {
    main.querySelector('.page-head').insertAdjacentHTML('afterend', VIEW_ONLY);
    main.querySelectorAll('#t-form button, #m-fill, #m-save').forEach((b) => { b.hidden = true; });
    main.querySelector('#t-form input').readOnly = true;
  }
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

  // 표: 행 = 항목, 열 = 1~12월 + 합계 (미수금 총액은 잔액이라 합계 없음)
  const input = (f, mo) => table.querySelector(`input[data-f="${f}"][data-m="${mo}"]`);
  const val = (f, mo) => parseMoney(input(f, mo).value);
  function totals() {
    for (const group of ['sales', 'cost']) {
      const fs = FIELDS.filter((x) => x[2] === group).map((x) => x[0]);
      const tr = table.querySelector(`tr[data-total="${group}"]`);
      let all = 0;
      MONTHS.forEach((mo, i) => { const t = fs.reduce((a, f) => a + val(f, mo), 0); all += t; tr.children[i + 1].textContent = comma(t); });
      tr.children[13].textContent = comma(all);
      fs.forEach((f) => { table.querySelector(`tr[data-row="${f}"] .row-total`).textContent = comma(MONTHS.reduce((a, mo) => a + val(f, mo), 0)); });
    }
  }

  async function load() {
    main.querySelector('#m-title').textContent = `${year}년 월별 실적`;
    const [t, m] = await Promise.all([api(`/api/mgmt/targets/${year}`), api(`/api/mgmt/monthly/${year}`)]);
    tInput.value = t.revenue ? comma(t.revenue) : '';
    updateTargetHint();
    detail = m.detail;
    const byMonth = Object.fromEntries(m.rows.map((r) => [r.month, r]));
    const row = ([f, l, g]) => `<tr data-row="${f}"><th class="row-head">${l}</th>
      ${MONTHS.map((mo) => `<td><input class="input money" data-f="${f}" data-m="${mo}" value="${comma(byMonth[mo]?.[f] || '')}" aria-label="${mo}월 ${l}"></td>`).join('')}
      <td class="r num ${g === 'recv' ? 'muted' : 'row-total'}">${g === 'recv' ? '-' : ''}</td></tr>`;
    const totalRow = (g, l) => `<tr class="sum-row" data-total="${g}"><th class="row-head">${l}</th>${MONTHS.map(() => '<td class="r num"></td>').join('')}<td class="r num"></td></tr>`;
    const group = (g, l) => `<tr class="grp-row"><th class="row-head" colspan="14">${l}</th></tr>`;
    table.innerHTML = `
      <thead><tr><th class="row-head">항목</th>${MONTHS.map((mo) => `<th class="r">${mo}월</th>`).join('')}<th class="r">합계</th></tr></thead>
      <tbody>
        ${group('sales', '매출')}${FIELDS.filter((x) => x[2] === 'sales').map(row).join('')}${totalRow('sales', '매출 합계')}
        ${group('cost', '지출')}${FIELDS.filter((x) => x[2] === 'cost').map(row).join('')}${totalRow('cost', '지출 합계')}
        ${group('recv', '미수금')}${FIELDS.filter((x) => x[2] === 'recv').map(row).join('')}
      </tbody>`;
    bindMoneyInputs(table);
    if (!editable) table.querySelectorAll('input').forEach((el) => { el.readOnly = true; });
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
      const el = TYPE_FIELD[d.sales_type] && input(TYPE_FIELD[d.sales_type], d.month);
      if (el) el.value = comma(d.amount);
    }
    // 내역이 없는 월·구분은 그대로 둔다
    dirty = true;
    totals();
    toast('매출 내역 합계를 채웠습니다. 확인 후 저장해 주세요.');
  });

  // 내려받기: 기간(월·분기·연간·전체)을 골라 저장된 값 기준으로. 엑셀은 회사 양식(경영지원 관리) — 달마다 시트 + 연간목표·월별실적
  bindPeriodDownload(main, 'm-dl', {
    years: ctx.meta.years, year, mode: 'year', currentYear: () => year,
    onExcel: (p) => {
      if (dirty) toast('저장하지 않은 변경 사항은 들어가지 않습니다. 먼저 저장해 주세요.', true);
      return downloadCompany({ kind: 'monthly', period: p });
    },
    onCsv: async (p, label) => {
      if (dirty) toast('저장하지 않은 변경 사항은 들어가지 않습니다. 먼저 저장해 주세요.', true);
      const d = await api(`/api/mgmt/export${p ? `?period=${p}` : ''}`);
      downloadCsv(`뉴토크코리아_월별실적_${label}_${stamp()}`, datasetSheet('monthly', d.monthly));
    },
  });

  main.querySelector('#m-save').addEventListener('click', async () => {
    const rows = MONTHS.map((mo) => ({ month: mo, ...Object.fromEntries(FIELDS.map(([f]) => [f, val(f, mo)])) }));
    try {
      await api(`/api/mgmt/monthly/${year}`, { method: 'PUT', body: { rows } });
      dirty = false;
      toast(`${year}년 월별 실적을 저장했습니다.`);
      ctx.reloadMeta();
    } catch (err) { toast(err.message, true); }
  });

  // ---------- 손익계산서·제조원가명세서 올리기 → 그 달 실적 칸 자동 입력 ----------
  const box = main.querySelector('#st-box');
  let parsed = [];
  function drawPicker() {
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>손익계산서·제조원가명세서 올리기</h3>
          <span class="hint">회계 프로그램에서 한 달씩 조회해 받은 엑셀(.xls·.xlsx)을 올리면 그 달 실적 칸에 자동으로 들어갑니다</span></div></div>
        <label class="dropzone" id="st-drop"><input type="file" id="st-file" accept=".xls,.xlsx" multiple hidden>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">파일을 여기에 끌어다 놓거나 클릭해서 선택 (여러 개 가능)</div>
          <div class="hint">올리면 바로 저장되지 않고 확인 화면이 나옵니다</div></label>
        <ul class="hint tips">
          <li>손익계산서 → 제품·상품·용역 매출, 영업외수익, 상품 매입(당기상품매입액), 판관비, 영업외비용</li>
          <li>제조원가명세서 → 원재료 매입(당기원재료매입액), 노무비, 경비</li>
          <li>기준월은 파일의 조회기간에서 읽습니다. 파일에 있는 항목만 그 달 값을 덮어쓰고, 미수금 총액은 건드리지 않습니다.</li>
        </ul>
      </div>`;
    const drop = box.querySelector('#st-drop');
    const fi = box.querySelector('#st-file');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFiles([...e.dataTransfer.files]); });
    fi.addEventListener('change', () => readFiles([...fi.files]));
  }

  async function readFiles(files) {
    if (!files.length) return;
    box.innerHTML = '<div class="card empty" style="margin-bottom:16px">파일을 읽는 중…</div>';
    try {
      const body = { files: await Promise.all(files.map(async (f) => {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { name: f.name, file: btoa(bin) };
      })) };
      parsed = (await api('/api/mgmt/statements/parse', { method: 'POST', body })).files
        .map((p) => ({ ...p, month: p.month || `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}` }));
      drawPreview();
    } catch (err) {
      drawPicker();
      box.insertAdjacentHTML('afterbegin', `<div class="notice err">${esc(err.message)}</div>`);
    }
  }

  function drawPreview() {
    const usable = parsed.filter((p) => p.type && !p.empty);
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>손익계산서·제조원가명세서 확인</h3><span class="hint">기준월을 확인하고 [반영]을 누르면 아래 표의 그 달 칸에 저장됩니다</span></div>
          <div class="filters"><button class="btn" id="st-cancel">취소</button><button class="btn primary" id="st-apply" ${usable.length ? '' : 'disabled'}>반영 (${usable.length}개 파일)</button></div></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>파일</th><th>종류</th><th>기준월</th><th>읽은 금액</th></tr></thead>
          <tbody>${parsed.map((p, k) => `<tr>
            <td class="wrap">${esc(p.file)}</td>
            <td>${p.type ? `<span class="badge blue">${esc(p.title)}</span>` : '<span class="badge">건너뜀</span>'}</td>
            <td>${p.type ? `<input class="input" type="month" data-st="${k}" value="${esc(p.month)}" style="width:160px">` : '-'}</td>
            <td class="wrap">${p.type ? Object.entries(p.values).map(([f, v]) => `${LABEL[f]} <b class="num">${comma(v)}</b>`).join(' · ') : ''}
              ${p.warnings.length ? `<div class="notice warn" style="margin:6px 0 0">${p.warnings.map(esc).join('<br>')}</div>` : ''}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    box.querySelectorAll('[data-st]').forEach((el) => el.addEventListener('change', () => { parsed[Number(el.dataset.st)].month = el.value; }));
    box.querySelector('#st-cancel').addEventListener('click', () => { parsed = []; drawPicker(); });
    box.querySelector('#st-apply').addEventListener('click', async (e) => {
      if (dirty && !window.confirm('표에 저장하지 않은 변경 사항이 있습니다. 반영하면 표를 다시 불러와 그 변경 사항은 사라집니다. 계속할까요?')) return;
      e.target.disabled = true;
      try {
        const items = usable.map((p) => ({ file: p.file, title: p.title, month: p.month, values: p.values }));
        await api('/api/mgmt/statements/apply', { method: 'POST', body: { items } });
        const months = [...new Set(items.map((x) => x.month))].sort();
        toast(`${months.join(', ')} 실적에 반영했습니다.`);
        const y = Number(months[months.length - 1].slice(0, 4));
        if (y !== year) { year = y; setPeriod({ year }); main.querySelector('#m-year').innerHTML = yearOptions(year, [...ctx.meta.years, year]); }
        parsed = [];
        drawPicker();
        ctx.reloadMeta();
        await load();
      } catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
  }
  if (box) drawPicker();

  await load();
  return () => {};
}
