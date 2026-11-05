// 생산팀 목록 화면 (ITB2026에서 옮겨 옴)
//  제조내역: 기간(제조년월) 안의 제조내역 — 검색·모델·출고 상태, 100건씩, 줄을 누르면 일련번호 상세
//  수주 내역: 기간(납기일) 안의 수주서 — 검색·산업 분야, 줄을 누르면 제품 정보 전체
//  엑셀: 지금 걸러 놓은 조건 그대로 전체를 .xlsx로
import { api, esc } from '../core.js';
import { downloadFrom, periodDownloadButton, bindPeriodDownload } from '../exporter.js';
import { periodQS, pickQS, periodSelector, dlPeriod, qty, dash } from './prod-common.js';

function pager(d) {
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  if (pages <= 1) return '';
  return `<div class="pager"><button class="btn sm" data-page="${d.page - 1}" ${d.page <= 1 ? 'disabled' : ''}>← 이전</button>
    <span>${d.page} / ${pages}쪽 · ${d.total.toLocaleString('ko-KR')}건</span>
    <button class="btn sm" data-page="${d.page + 1}" ${d.page >= pages ? 'disabled' : ''}>다음 →</button></div>`;
}

// ---------------- 제조내역 ----------------
export const records = {
  async render(main) {
    const f = { q: '', model: sessionStorage.getItem('recordsModel') || '', shipped: '', page: 1 };
    sessionStorage.removeItem('recordsModel');
    main.innerHTML = `
      <div class="page-head">
        <div><h2>제조내역</h2><div class="sub">제조년월 기준 (대시보드 생산량과 같음) · 줄을 누르면 일련번호 상세 · 수정은 엑셀 업로드로만</div></div>
        <div id="rl-period"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <form id="rl-form" class="filters">
            <input class="input" name="q" placeholder="일련번호·거래처·최종발주처·사업명·PO번호·주문번호" style="width:300px">
            <select class="input" name="model"><option value="">모든 모델</option></select>
            <button class="btn">검색</button>
          </form>
          <div class="filters"><div class="seg" id="rl-shipped"></div>${periodDownloadButton('rl-dl', 'sm')}</div>
        </div>
        <div id="rl-table"><div class="empty">불러오는 중…</div></div>
      </div>`;
    const $ = (s) => main.querySelector(s);
    const qs = () => `${periodQS()}&${new URLSearchParams({ q: f.q, model: f.model, shipped: f.shipped })}`;
    async function load() {
      const d = await api(`/api/production/records?${qs()}&page=${f.page}`);
      const sel = $('#rl-form').model;
      if (sel.options.length === 1) {
        d.model_names.forEach((m) => sel.add(new Option(m, m)));
        sel.add(new Option('(미입력)', '(미입력)'));
        sel.value = f.model;
      }
      $('#rl-shipped').innerHTML = [['', `전체 ${d.counts.total}`], ['yes', `✓ 출고 ${d.counts.shipped}`], ['no', `○ 출고 전 ${d.counts.not_shipped}`]]
        .map(([v, l]) => `<button type="button" data-s="${v}" class="${f.shipped === v ? 'on' : ''}">${l}</button>`).join('');
      $('#rl-table').innerHTML = !d.results.length ? '<div class="empty">조건에 맞는 제조내역이 없습니다.</div>' : `
        <div class="table-wrap"><table class="tbl click">
          <thead><tr><th>일련번호</th><th>모델</th><th>제조년월</th><th>검사일자</th><th>거래처</th><th>사업명</th><th>PO번호</th><th>납기일</th><th>출고</th></tr></thead>
          <tbody>${d.results.map((r) => `<tr data-serial="${esc(r.serial_full)}">
            <td><b>${esc(r.serial_full)}</b></td><td>${dash(r.model_name)}</td><td>${dash(r.manufactured_date)}</td><td>${dash(r.inspection_date)}</td>
            <td>${dash(r.customer)}</td><td>${dash(r.project_name)}</td><td>${r.po_no ? `#${esc(r.po_no)}` : '-'}</td><td>${dash(r.due_date)}</td>
            <td>${r.shipped_date ? `<span class="status-chip done">✓ ${esc(r.shipped_date)}</span>` : '<span class="status-chip pending">○ 출고 전</span>'}</td></tr>`).join('')}</tbody>
        </table></div>${pager(d)}`;
    }
    $('#rl-form').addEventListener('submit', (e) => { e.preventDefault(); f.q = e.target.q.value.trim(); f.model = e.target.model.value; f.page = 1; load(); });
    $('#rl-form').model.addEventListener('change', (e) => { f.model = e.target.value; f.page = 1; load(); });
    $('#rl-shipped').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { f.shipped = b.dataset.s; f.page = 1; load(); } });
    $('#rl-table').addEventListener('click', (e) => {
      const p = e.target.closest('[data-page]');
      if (p) { f.page = Number(p.dataset.page); load(); return; }
      const tr = e.target.closest('tr[data-serial]');
      if (tr) { sessionStorage.setItem('serialQuery', tr.dataset.serial); location.hash = '#/production/serials'; }
    });
    // 내려받기: 고른 기간 + 지금 검색 조건(검색어·모델·출고)
    const rlUrl = (p) => `/api/production/records/export?${pickQS(p)}&${new URLSearchParams({ q: f.q, model: f.model, shipped: f.shipped })}`;
    bindPeriodDownload(main, 'rl-dl', {
      ...dlPeriod(), modes: ['year', 'quarter', 'month'], current: dlPeriod, currentYear: () => dlPeriod().year,
      hint: '검색어·모델·출고 조건은 화면에서 고른 그대로 담습니다.',
      onExcel: (p) => downloadFrom(rlUrl(p)), onCsv: (p) => downloadFrom(`${rlUrl(p)}&format=csv`),
    });
    await periodSelector($('#rl-period'), () => { f.page = 1; load(); });
    await load();
  },
};

// ---------------- 수주 내역 ----------------
export const orders = {
  async render(main) {
    const f = { q: '', industry: '', page: 1 };
    let open = '';
    main.innerHTML = `
      <div class="page-head">
        <div><h2>수주 내역</h2><div class="sub">납기일 기준 (대시보드 판매량과 같음) · 줄을 누르면 제품 정보 전체</div></div>
        <div id="ol-period"></div>
      </div>
      <div class="card">
        <div class="card-head">
          <form id="ol-form" class="filters">
            <input class="input" name="q" placeholder="판매번호·수주서류 번호·판매처·최종발주처·사업명·품명" style="width:300px">
            <select class="input" name="industry"><option value="">모든 산업 분야</option></select>
            <button class="btn">검색</button>
          </form>
          <div class="filters"><span class="hint" id="ol-count"></span>${periodDownloadButton('ol-dl', 'sm')}</div>
        </div>
        <div id="ol-table"><div class="empty">불러오는 중…</div></div>
      </div>`;
    const $ = (s) => main.querySelector(s);
    const qs = () => `${periodQS()}&${new URLSearchParams({ q: f.q, industry: f.industry })}`;
    let d = null;
    async function load() {
      d = await api(`/api/production/orders?${qs()}&page=${f.page}`);
      const sel = $('#ol-form').industry;
      if (sel.options.length === 1) d.industries.forEach((i) => sel.add(new Option(i, i)));
      draw();
    }
    function draw() {
      $('#ol-count').textContent = `수주서 ${d.counts.total}건 · 수량 ${qty(d.counts.quantity)}`;
      $('#ol-table').innerHTML = !d.results.length ? '<div class="empty">조건에 맞는 수주서가 없습니다. 수주서 PDF 업로드는 다음 단계에서 옮겨 옵니다.</div>' : `
        <div class="table-wrap"><table class="tbl click">
          <thead><tr><th>납기일</th><th>판매번호</th><th>수주서류</th><th>수주일</th><th>산업 분야</th><th>판매처</th><th>사업명</th><th>제품 × 수량</th><th class="r">수량</th></tr></thead>
          <tbody>${d.results.map((o) => `<tr data-o="${esc(o.sales_no)}" class="${open === o.sales_no ? 'sel' : ''}">
            <td>${dash(o.due_date)}</td><td><b>${esc(o.sales_no)}</b></td><td>${o.order_doc_no ? `#${esc(o.order_doc_no)}` : '-'}</td><td>${dash(o.order_date)}</td>
            <td>${esc(o.industry)}</td><td>${dash(o.customer)}</td><td>${dash(o.project_name)}</td>
            <td class="wrap">${o.items.map((i) => `${esc(i.product_name)} × ${i.quantity}`).join('<br>')}</td><td class="r num"><b>${qty(o.quantity)}</b></td></tr>
            ${open === o.sales_no ? `<tr class="detail-row"><td colspan="9">
              <div class="kv-row small" style="margin-bottom:8px"><span>최종발주처 <b>${dash(o.final_orderer)}</b></span><span>사업구분 원문 <b>${dash(o.business_type_raw)}</b></span>
                <span>납품일/출장일 <b>${dash(o.delivery_date)}</b></span>${o.note ? `<span>비고 <b>${esc(o.note)}</b></span>` : ''}</div>
              <table class="tbl mini"><thead><tr><th>품명</th><th class="r">수량</th><th>전원</th><th>Flange</th><th>RPM/OT</th><th>스템/부시가공</th></tr></thead>
                <tbody>${o.items.map((i) => `<tr><td>${esc(i.product_name)}</td><td class="r">${i.quantity}</td><td>${dash(i.power)}</td><td>${dash(i.flange)}</td><td>${dash(i.rpm_ot)}</td><td>${dash(i.stem_bush)}</td></tr>`).join('')}</tbody></table>
            </td></tr>` : ''}`).join('')}</tbody>
        </table></div>${pager(d)}`;
    }
    $('#ol-form').addEventListener('submit', (e) => { e.preventDefault(); f.q = e.target.q.value.trim(); f.page = 1; load(); });
    $('#ol-form').industry.addEventListener('change', (e) => { f.industry = e.target.value; f.page = 1; load(); });
    $('#ol-table').addEventListener('click', (e) => {
      const p = e.target.closest('[data-page]');
      if (p) { f.page = Number(p.dataset.page); load(); return; }
      const tr = e.target.closest('tr[data-o]');
      if (tr) { open = open === tr.dataset.o ? '' : tr.dataset.o; draw(); }
    });
    const olUrl = (p) => `/api/production/orders/export?${pickQS(p)}&${new URLSearchParams({ q: f.q, industry: f.industry })}`;
    bindPeriodDownload(main, 'ol-dl', {
      ...dlPeriod(), modes: ['year', 'quarter', 'month'], current: dlPeriod, currentYear: () => dlPeriod().year,
      hint: '검색어·산업 분야 조건은 화면에서 고른 그대로 담습니다.',
      onExcel: (p) => downloadFrom(olUrl(p)), onCsv: (p) => downloadFrom(`${olUrl(p)}&format=csv`),
    });
    await periodSelector($('#ol-period'), () => { f.page = 1; load(); });
    await load();
  },
};

// ---------------- 일련번호 조회 ----------------
// 4자리(예: 0001, 1) 또는 전체 번호(예: N82260001)로 검색 → 여러 건이면 목록에서 고름 → 11개 항목
export const serials = {
  async render(main) {
    main.innerHTML = `
      <div class="page-head"><div><h2>일련번호 조회</h2><div class="sub">4자리(예: 0001) 또는 전체 번호(예: N82260001)로 찾습니다. 여러 건이 나오면 목록에서 고르세요.</div></div></div>
      <div class="card" style="margin-bottom:16px;max-width:900px">
        <form id="sr-form" class="filters"><input class="input" name="q" placeholder="일련번호" style="width:260px" autocomplete="off"><button class="btn primary">조회</button></form>
        <div id="sr-list" style="margin-top:12px"></div>
      </div>
      <div id="sr-detail"></div>`;
    const $ = (s) => main.querySelector(s);
    async function search(q) {
      $('#sr-detail').innerHTML = '';
      const d = await api(`/api/production/serials?q=${encodeURIComponent(q)}`);
      if (!d.results.length) { $('#sr-list').innerHTML = `<div class="notice warn" style="margin:0">"${esc(q)}"에 맞는 일련번호가 없습니다.</div>`; return; }
      if (d.results.length === 1) { $('#sr-list').innerHTML = ''; return detail(d.results[0].serial_full); }
      $('#sr-list').innerHTML = `<div class="hint" style="margin-bottom:6px">${d.results.length}건${d.results.length >= d.limit ? ` (최대 ${d.limit}건)` : ''} — 하나를 고르세요</div>
        <div class="table-wrap"><table class="tbl click"><thead><tr><th>일련번호</th><th>모델</th><th>제조년월</th><th>거래처</th><th>사업명</th></tr></thead>
        <tbody>${d.results.map((r) => `<tr data-serial="${esc(r.serial_full)}"><td><b>${esc(r.serial_full)}</b></td><td>${dash(r.model_name)}</td><td>${dash(r.manufactured_date)}</td><td>${dash(r.customer)}</td><td>${dash(r.project_name)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    async function detail(serial) {
      main.querySelectorAll('#sr-list tr[data-serial]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.serial === serial));
      const d = await api(`/api/production/serials/${encodeURIComponent(serial)}`);
      const val = (v) => (v && typeof v === 'object'
        ? `<div class="kv-row">${Object.entries(v).map(([k, x]) => `<span>${esc(k)} <b>${x ? esc(x) : '<span class="muted">-</span>'}</b>${k === 'Flange' && !x ? ' <span class="muted">(수주서에서 보완)</span>' : ''}</span>`).join('')}</div>`
        : (v ? esc(v) : '<span class="muted">-</span>'));
      $('#sr-detail').innerHTML = `
        <div class="card" style="max-width:900px">
          <div class="card-head"><div class="ttl"><h3>${esc(d.serial_full)}</h3><span class="hint">조회 항목 11개</span></div></div>
          <table class="tbl detail-tbl"><tbody>${d.items.map((i) => `<tr><th><span class="no">${i.no}</span>${esc(i.label)}</th><td>${val(i.value)}</td></tr>`).join('')}</tbody></table>
          <p class="hint" style="margin:10px 0 0">Flange는 제조내역 엑셀에 없어 수주서에서 보완합니다 (임시: 수주서류 번호 = PO번호로 연결, 기업 확인 필요).</p>
        </div>`;
    }
    $('#sr-form').addEventListener('submit', (e) => { e.preventDefault(); const q = e.target.q.value.trim(); if (q) search(q); });
    $('#sr-list').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-serial]'); if (tr) detail(tr.dataset.serial); });
    const q0 = sessionStorage.getItem('serialQuery');
    sessionStorage.removeItem('serialQuery');
    if (q0) { $('#sr-form').q.value = q0; await search(q0); }
  },
};
