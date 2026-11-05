import { api, esc, comma, won, parseMoney, toast, modal, confirmBox, period, setPeriod, yearOptions, today, VIEW_ONLY } from '../core.js';
import { datasetSheet, downloadCsv, downloadCompany, fileSafe, stamp, periodDownloadButton, bindPeriodDownload } from '../exporter.js';

// ---------- 매출자료 CSV (판매 관리 프로그램에서 받은 월별 파일, 예: 매출자료_202601.csv) ----------
// 열: *ID, 작업 구분, 사업 구분, 수출 구분, 판매번호, 최종발주처 / EPC, 사업명, 판매처, 매출액. 날짜 열이 없어 기준월은 파일 이름에서 읽는다.
const CSV_COLS = { ext_id: 'id', work_type: '작업구분', biz_type: '사업구분', export_type: '수출구분', order_no: '판매번호',
  end_client: '최종발주처epc', project: '사업명', customer: '판매처', amount: '매출액' };
const WORK_TO_TYPE = [[/부품|교체/, '상품'], [/점검|수리|공사|용역/, '용역']]; // 그 외(제품·기타) → 제품
const BIZ_TO_INDUSTRY = [[/상하수도|수도/, '상하수도'], [/발전/, '발전소'], [/가스|오일|석유|정유/, '가스·오일·석유화학'], [/플랜트/, '민간 플랜트']];
const hnorm = (h) => String(h).replace(/[\s*/_·.\-]/g, '').toLowerCase();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function readSalesCsv(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\uFFFD')) text = new TextDecoder('euc-kr').decode(buf); // 엑셀에서 저장한 CSV(CP949)
  const aoa = parseCsv(text.replace(/^\uFEFF/, ''));
  const head = (aoa[0] || []).map(hnorm);
  const idx = Object.fromEntries(Object.entries(CSV_COLS).map(([k, h]) => [k, head.indexOf(h)]));
  const missing = ['customer', 'amount'].filter((k) => idx[k] < 0).map((k) => CSV_COLS[k]);
  const ym = file.name.normalize('NFC').match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])(?!\d)/);
  const out = { file: file.name, month: ym ? `${ym[1]}-${ym[2]}` : '', rows: [], warnings: [] };
  if (missing.length) { out.warnings.push(`필수 열이 없습니다: ${missing.join(', ')}`); return out; }
  if (!ym) out.warnings.push('파일 이름에서 기준월(예: 매출자료_202601)을 찾지 못했습니다. 기준월을 골라 주세요.');
  for (const r of aoa.slice(1)) {
    if (!r.some((c) => String(c).trim())) continue;
    const v = Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i < 0 ? '' : String(r[i] ?? '').trim()]));
    v.ext_id = v.ext_id.replace(/"/g, '').trim();
    v.amount = Math.round(Number(v.amount.replace(/,/g, '')) || 0);
    v.sales_type = (WORK_TO_TYPE.find(([re]) => re.test(v.work_type)) || [, '제품'])[1];
    v.industry = (BIZ_TO_INDUSTRY.find(([re]) => re.test(v.biz_type)) || [, '기타'])[1];
    v.series = v.work_type;
    if (!v.customer) { out.warnings.push(`판매처가 빈 행을 건너뜁니다 (판매번호 ${v.order_no || '-'})`); continue; }
    out.rows.push(v);
  }
  return out;
}

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
  const searchText = (r) => `${r.customer} ${r.series} ${r.note} ${r.project || ''} ${r.order_no || ''} ${r.end_client || ''}`.toLowerCase();
  const editable = ctx.canEdit('mgmt');

  main.innerHTML = `
    <div class="page-head">
      <div><h2>매출 내역 (판매처별)</h2><div class="sub">산업 분야·제품 시리즈 비중 그래프와 판매처 순위의 기준 데이터입니다.</div></div>
      <div class="filters">
        <select class="input" id="s-year">${yearOptions(year, ctx.meta.years)}</select>
        <div class="seg" id="s-kind">${[['year', '연간'], ['quarter', '분기'], ['month', '월']].map(([v, l]) => `<button type="button" data-kind="${v}" class="${view.kind === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="input" id="s-quarter" ${view.kind === 'quarter' ? '' : 'hidden'}>${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === view.quarter ? 'selected' : ''}>${q}분기 (${q * 3 - 2}~${q * 3}월)</option>`).join('')}</select>
        <select class="input" id="s-month" ${view.kind === 'month' ? '' : 'hidden'}>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === view.month ? 'selected' : ''}>${i + 1}월</option>`).join('')}</select>
        <input class="input" id="s-filter" placeholder="판매처·사업명·판매번호 검색" style="width:200px">
        ${periodDownloadButton('s-dl')}
        ${editable ? '<button class="btn primary" id="s-add">+ 매출 등록</button>' : ''}
      </div>
    </div>
    ${editable ? '<div id="csv-box"></div>' : VIEW_ONLY}
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
    const list = rows.filter((r) => (!ms || ms.includes(Number(r.date.slice(5, 7)))) && (!q || searchText(r).includes(q)));
    const total = list.reduce((a, r) => a + r.amount, 0);
    main.querySelector('#s-table').innerHTML = list.length ? `
      <table class="tbl">
        <thead><tr><th>일자</th><th>판매처</th><th>사업명</th><th>산업 분야</th><th>제품 시리즈</th><th>구분</th><th class="r">금액</th><th>비고</th><th></th></tr></thead>
        <tbody>${list.map((r) => `<tr>
          <td>${r.ext_id ? `${esc(r.date.slice(0, 7))}` : esc(r.date)}</td><td>${esc(r.customer)}</td>
          <td class="wrap" style="min-width:220px">${esc(r.project)}${r.order_no ? `<div class="hint">${esc(r.order_no)}</div>` : ''}</td>
          <td>${esc(r.industry)}</td><td>${esc(r.series)}</td><td>${esc(r.sales_type)}</td>
          <td class="r num">${comma(r.amount)}</td><td>${esc(r.note)}</td>
          <td class="r">${editable ? `<button class="btn sm" data-edit="${r.id}">수정</button> <button class="btn sm danger" data-del="${r.id}">삭제</button>` : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="6">${viewLabel()} ${list.length}건 합계</td><td class="r num">${comma(total)}</td><td colspan="2">${won(total)}</td></tr></tfoot>
      </table>` : `<div class="empty">${viewLabel()} 매출 내역이 ${q ? '검색 결과에 ' : ''}없습니다. [+ 매출 등록] 또는 위의 매출자료 CSV 올리기로 입력해 주세요.</div>`;
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
  const match = (r) => !filter || searchText(r).includes(filter.toLowerCase());
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

  // ---------- 매출자료 CSV 올리기: 확인 후 저장, 같은 ID는 덮어씀 ----------
  const box = main.querySelector('#csv-box');
  let files = [];
  function drawPicker() {
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>매출자료 CSV 올리기</h3><span class="hint">매출자료_YYYYMM.csv 파일을 올리면 매출 내역에 자동으로 들어갑니다 (여러 개 가능)</span></div></div>
        <label class="dropzone" id="csv-drop" style="padding:28px 20px"><input type="file" id="csv-file" accept=".csv" multiple hidden>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">CSV 파일을 여기에 끌어다 놓거나 클릭해서 선택</div>
          <div class="hint">올리면 바로 저장되지 않고 확인 화면이 나옵니다 · 같은 ID의 매출을 다시 올리면 새 값으로 덮어씁니다</div></label>
        <ul class="hint tips">
          <li>기준월은 파일 이름(_202601)에서 읽습니다. 매출 일자는 그 달 1일로 저장됩니다.</li>
          <li>작업 구분 → 매출 구분: 제품 → 제품, 부품 및 교체 → 상품, 점검/수리/공사/용역 → 용역 (작업 구분은 제품 시리즈 칸에 남깁니다)</li>
          <li>사업 구분 → 산업 분야: 상하수도(지자체·밸브사) → 상하수도, 발전 → 발전소, 가스·오일·석유화학·민간 플랜트·기타는 그대로</li>
        </ul>
      </div>`;
    const drop = box.querySelector('#csv-drop');
    const fi = box.querySelector('#csv-file');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); readFiles([...e.dataTransfer.files]); });
    fi.addEventListener('change', () => readFiles([...fi.files]));
  }
  async function readFiles(list) {
    const csv = list.filter((f) => /\.csv$/i.test(f.name));
    if (!csv.length) return toast('CSV 파일을 골라 주세요.', true);
    files = (await Promise.all(csv.map(readSalesCsv))).sort((a, b) => a.month.localeCompare(b.month));
    drawPreview();
  }
  function drawPreview() {
    const all = files.flatMap((f) => f.rows.map((r) => ({ ...r, month: f.month })));
    const ready = files.every((f) => !f.rows.length || /^\d{4}-\d{2}$/.test(f.month));
    const sumOf = (rs) => rs.reduce((a, r) => a + r.amount, 0);
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>매출자료 확인</h3><span class="hint">${files.length}개 파일 · ${all.length}건 · ${won(sumOf(all))}</span></div>
          <div class="filters"><button class="btn" id="csv-cancel">취소</button><button class="btn primary" id="csv-save" ${all.length && ready ? '' : 'disabled'}>저장 (${all.length}건)</button></div></div>
        <div class="table-wrap" style="margin-bottom:12px"><table class="tbl">
          <thead><tr><th>파일</th><th>기준월</th><th class="r">건수</th><th class="r">매출 합계</th><th>확인할 점</th></tr></thead>
          <tbody>${files.map((f, k) => `<tr><td>${esc(f.file.normalize('NFC'))}</td>
            <td><input class="input" type="month" data-cm="${k}" value="${esc(f.month)}" style="width:160px"></td>
            <td class="r">${f.rows.length}</td><td class="r num">${comma(sumOf(f.rows))}</td>
            <td class="wrap">${f.warnings.length ? `<span class="muted">${f.warnings.map(esc).join('<br>')}</span>` : '-'}</td></tr>`).join('')}</tbody>
        </table></div>
        <div class="table-wrap" style="max-height:50vh"><table class="tbl">
          <thead><tr><th>기준월</th><th>판매번호</th><th>판매처</th><th>사업명</th><th>작업 구분 → 매출 구분</th><th>사업 구분 → 산업 분야</th><th class="r">매출액</th></tr></thead>
          <tbody>${all.map((r) => `<tr><td>${esc(r.month || '-')}</td><td>${esc(r.order_no)}</td><td>${esc(r.customer)}</td><td class="wrap" style="min-width:240px">${esc(r.project)}</td>
            <td>${esc(r.work_type)} → <b>${r.sales_type}</b></td><td>${esc(r.biz_type)} → <b>${r.industry}</b></td><td class="r num">${comma(r.amount)}</td></tr>`).join('')}</tbody>
        </table></div>
      </div>`;
    box.querySelectorAll('[data-cm]').forEach((el) => el.addEventListener('change', () => { files[Number(el.dataset.cm)].month = el.value; drawPreview(); }));
    box.querySelector('#csv-cancel').addEventListener('click', () => { files = []; drawPicker(); });
    box.querySelector('#csv-save').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const body = { rows: files.flatMap((f) => f.rows.map((r) => ({ ...r, file: f.file.normalize('NFC'), date: `${f.month}-01`, note: '' }))) };
        const r = await api('/api/mgmt/sales/upsert', { method: 'POST', body });
        toast(`매출자료를 저장했습니다 — 새로 ${r.inserted}건, 덮어씀 ${r.updated}건`);
        const y = Number(files.map((f) => f.month).sort().pop().slice(0, 4));
        files = [];
        drawPicker();
        await ctx.reloadMeta();
        if (y !== year) { year = y; setPeriod({ year }); main.querySelector('#s-year').innerHTML = yearOptions(year, ctx.meta.years); }
        await load();
      } catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
  }
  if (box) drawPicker();

  await load();
}
