import { api, esc, comma, won, parseMoney, toast, modal, confirmBox, period, setPeriod, today, VIEW_ONLY } from '../core.js';
import { downloadCompany, periodDownloadButton, bindPeriodDownload } from '../exporter.js';
import { periodControl, periodRange, periodLabel } from '../period-control.js';
import { readSalesFiles } from '../sales-file.js';

export async function render(main, ctx) {
  // 조회 기간: 월 / 분기 / 연간 / 기간(시작월~종료월) — 이 브라우저에 기억
  const now = new Date();
  const view = (() => {
    const base = { kind: 'year', year: period.year, month: now.getMonth() + 1, quarter: Math.ceil((now.getMonth() + 1) / 3) };
    try { return { ...base, ...JSON.parse(localStorage.getItem('sales.view') || '{}') }; } catch { return base; }
  })();
  const saveView = () => { try { localStorage.setItem('sales.view', JSON.stringify(view)); } catch { /* 무시 */ } };
  const viewLabel = () => periodLabel(view);
  const dlStart = () => (view.kind === 'range' ? { mode: 'year', year: +view.to.slice(0, 4) } : { mode: view.kind, year: view.year, month: view.month, quarter: view.quarter });
  let rows = [];
  let filter = '';
  const searchText = (r) => `${r.customer} ${r.series} ${r.note} ${r.project || ''} ${r.order_no || ''} ${r.end_client || ''}`.toLowerCase();
  const editable = ctx.canEdit('mgmt');

  main.innerHTML = `
    <div class="page-head">
      <div><h2>매출 내역 (판매처별)</h2><div class="sub">산업 분야·제품 시리즈 비중 그래프와 판매처 순위의 기준 데이터입니다.</div></div>
      <div class="filters">
        <div id="s-period"></div>
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
    const list = rows.filter((r) => !q || searchText(r).includes(q));
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
      </table>` : `<div class="empty">${viewLabel()} 매출 내역이 ${q ? '검색 결과에 ' : ''}없습니다. [+ 매출 등록] 또는 위의 매출자료 올리기로 입력해 주세요.</div>`;
  }

  async function load() {
    const r = periodRange(view);
    rows = await api(`/api/mgmt/sales?from=${r.from}&to=${r.to}`);
    draw();
  }

  const ctl = periodControl(main.querySelector('#s-period'), view, { years: ctx.meta.years, onChange: () => { saveView(); if (view.kind !== 'range') setPeriod({ year: view.year }); load(); } });
  main.querySelector('#s-filter').addEventListener('input', (e) => { filter = e.target.value; draw(); });
  main.querySelector('#s-add')?.addEventListener('click', () => edit(null));
  // 내려받기: 기간(월·분기·연간·전체)을 골라서, 검색어가 있으면 검색 결과만
  bindPeriodDownload(main, 's-dl', {
    years: ctx.meta.years, ...dlStart(), currentYear: () => dlStart().year,
    current: dlStart, // 내려받기 창은 화면에서 고른 기간으로 시작
    hint: '매출자료 형식(달마다 시트·파일 하나)으로 담습니다. 검색어를 입력해 두면 검색 결과만 담깁니다. 받은 파일은 그대로 다시 올릴 수 있습니다.',
    onExcel: (p) => downloadCompany({ kind: 'sales', period: p, q: filter }),
    onCsv: (p) => downloadCompany({ kind: 'sales', period: p, q: filter, format: 'csv' }),
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

  // ---------- 매출자료 올리기(CSV·엑셀): 확인 후 저장, 같은 ID는 덮어씀 ----------
  const box = main.querySelector('#csv-box');
  let files = [];
  function drawPicker() {
    box.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>매출자료 올리기</h3><span class="hint">매출자료_YYYYMM.csv 파일(또는 여기서 내려받은 매출자료 엑셀)을 올리면 매출 내역에 자동으로 들어갑니다 (여러 개 가능)</span></div></div>
        <label class="dropzone" id="csv-drop" style="padding:28px 20px"><input type="file" id="csv-file" accept=".csv,.xlsx,.xls" multiple hidden>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">CSV·엑셀 파일을 여기에 끌어다 놓거나 클릭해서 선택</div>
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
    const ok = list.filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name));
    if (!ok.length) return toast('매출자료 CSV 또는 엑셀 파일을 골라 주세요.', true);
    files = (await Promise.all(ok.map(readSalesFiles))).flat().sort((a, b) => a.month.localeCompare(b.month));
    if (!files.length) return toast('매출자료 형식(*ID·작업 구분·판매처·매출액)의 시트가 없습니다.', true);
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
        // 올린 달이 지금 보는 기간 밖이면 그 해 연간으로 바꿔 보여 준다
        const lastMonth = files.map((f) => f.month).sort().pop();
        const shown = periodRange(view);
        files = [];
        drawPicker();
        await ctx.reloadMeta();
        if (lastMonth < shown.from || lastMonth > shown.to) { Object.assign(view, { kind: 'year', year: +lastMonth.slice(0, 4) }); saveView(); ctl.redraw(); }
        await load();
      } catch (err) { toast(err.message, true); e.target.disabled = false; }
    });
  }
  if (box) drawPicker();

  await load();
}
