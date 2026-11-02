// 교체부품 단가 — 파트넘버별 5개 기준 비교 (ITB2026 서비스팀 단가 화면을 옮겨 옴)
//  부품별 비교: 뉴토크 기준값(단가표 기준단가 × (1 − 할인율) + 추가단가) + 출장지(업체)별 평균·최저·최고·최고−최저
//              줄을 누르면 아래에 출장지별 단가와 기준값 대비 차이
//  출장지별 비교: 업체마다 기준값 대비 평균 차이율 막대 → 누르면 그 업체의 부품별 차이
import { api, esc, toast, VIEW_ONLY } from '../core.js';
import { diffBar, DIFF_ABOVE, DIFF_BELOW, hideTooltip } from '../charts.js';
import { downloadFrom } from '../exporter.js';

const wonText = (v) => (v === null || v === undefined ? '-' : `${Number(v).toLocaleString('ko-KR')}원`);
const signed = (v) => (v > 0 ? `+${v.toLocaleString('ko-KR')}` : v.toLocaleString('ko-KR'));
const signedRate = (r) => `${r > 0 ? '+' : ''}${r}%`;
const settingText = (rate, extra) => `할인 ${rate}% · 추가 ${extra >= 0 ? '+' : ''}${Number(extra).toLocaleString('ko-KR')}원`;
const lowBadge = (title) => `<span class="badge low" title="${esc(title)}">크게 낮음</span>`;
const legend = `<div class="diff-legend">
  <span><i style="background:${DIFF_BELOW}"></i>기준값보다 쌈 (−)</span>
  <span><i style="background:${DIFF_ABOVE}"></i>기준값보다 비쌈 (+)</span>
  <span>가운데 진한 선 = 뉴토크 기준값 (0%)</span></div>`;

export async function render(main, ctx) {
  const tab = ctx.tab === 'companies' ? 'companies' : 'parts';
  const editable = ctx.canEdit('service');
  const charts = [];
  const destroyCharts = () => { while (charts.length) charts.pop().destroy(); hideTooltip(); };

  main.innerHTML = `
    <div class="page-head">
      <div><h2>교체부품 단가</h2><div class="sub">파트넘버별 뉴토크 기준값과 출장지(업체)별 단가를 비교합니다.</div></div>
      ${editable ? '<div class="filters"><a class="btn" href="#/prices/input">단가 직접 입력</a></div>' : ''}
    </div>
    <div class="tabs">
      <a href="#/prices/parts" class="${tab === 'parts' ? 'active' : ''}">부품별 비교</a>
      <a href="#/prices/companies" class="${tab === 'companies' ? 'active' : ''}">출장지별 비교</a>
    </div>
    ${editable ? '' : VIEW_ONLY}
    <div id="pp-body"></div>`;
  const body = main.querySelector('#pp-body');

  if (tab === 'companies') await renderCompanies(body, charts, destroyCharts);
  else await renderParts(body, charts, destroyCharts, sessionStorage.getItem('openPart'), editable);
  sessionStorage.removeItem('openPart');
  return destroyCharts;
}

// ---------------- 부품별 비교 ----------------
async function renderParts(body, charts, destroyCharts, openId, editable) {
  const filters = { q: '', category: '' };
  let data = null;
  let detail = null;

  body.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div class="ttl"><h3>파트넘버별 기준값 · 출장지 단가</h3><span class="hint" id="pp-count"></span></div>
        <div class="filters"><button class="btn sm" id="pp-xlsx">⬇ 엑셀</button><button class="btn sm" id="pp-csv">⬇ CSV</button></div>
      </div>
      <div class="filters" style="margin-bottom:12px">
        <form id="pp-search" class="filters"><input class="input" name="q" placeholder="파트넘버(예: 05-A-01, 0501) 또는 품명" style="width:280px"><button class="btn">검색</button></form>
        <select class="input" id="pp-cat"><option value="">모든 분류</option></select>
        <button class="btn sm" id="pp-clear" hidden>조건 지우기</button>
      </div>
      <div class="std-box" id="pp-std"></div>
      <div id="pp-table"></div>
    </div>
    <div id="pp-detail"></div>`;

  const $ = (s) => body.querySelector(s);
  async function load() {
    data = await api(`/api/parts/catalog?q=${encodeURIComponent(filters.q)}&category=${encodeURIComponent(filters.category)}`);
    const cat = $('#pp-cat');
    if (cat.options.length === 1) data.categories.forEach((c) => cat.add(new Option(c, c)));
    $('#pp-clear').hidden = !(filters.q || filters.category);
    drawStandard();
    drawTable();
    // 검색 결과가 하나면 바로 상세를 연다 (파트넘버로 찾을 때)
    if (data.items.length === 1) await open(data.items[0].id);
    else if (detail && !data.items.some((i) => i.id === detail.id)) { detail = null; drawDetail(); }
  }

  function drawStandard() {
    const s = data.standard;
    $('#pp-std').innerHTML = `
      <span><b>뉴토크 기준값</b> = 단가표 기준단가 × (1 − 할인율) + 추가단가</span>
      <span class="muted">· 전체 기본값: ${settingText(s.default_discount_rate, s.default_extra_price)}</span>
      ${data.list_price_date ? `<span class="muted">· 단가표 기준일 ${esc(data.list_price_date)}</span>` : ''}
      <span class="muted">· 크게 낮음: 기준값보다 ${s.low_alert_rate}% 이상 낮은 견적 (임시 기준)</span>
      ${editable ? '<button class="btn sm" id="pp-std-edit">기본값 수정</button>' : ''}`;
    $('#pp-std-edit')?.addEventListener('click', editStandard);
  }

  function editStandard() {
    const s = data.standard;
    $('#pp-std').innerHTML = `
      <form id="pp-std-form" class="filters">
        <label>할인율 <input class="input" name="discount_rate" type="number" min="0" max="100" step="0.01" value="${s.default_discount_rate}" style="width:90px"> %</label>
        <label>추가단가 <input class="input" name="extra_price" type="number" step="1" value="${s.default_extra_price}" style="width:120px"> 원</label>
        <label>크게 낮음 기준 <input class="input" name="low_alert_rate" type="number" min="0" max="100" step="0.1" value="${s.low_alert_rate}" style="width:80px"> %</label>
        <button class="btn primary sm">저장</button><button type="button" class="btn sm" id="pp-std-cancel">취소</button>
      </form>`;
    $('#pp-std-cancel').addEventListener('click', drawStandard);
    $('#pp-std-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        await api('/api/parts/standard', { method: 'PUT', body: { discount_rate: f.discount_rate, extra_price: Number(f.extra_price), low_alert_rate: f.low_alert_rate } });
        toast('기본값을 저장했습니다.');
        await load();
        if (detail) await open(detail.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  function drawTable() {
    const n = data.items.length;
    $('#pp-count').textContent = `${n}개 부품 · 줄을 누르면 출장지별 단가`;
    $('#pp-xlsx').disabled = !n;
    $('#pp-csv').disabled = !n;
    $('#pp-table').innerHTML = !n
      ? `<div class="empty">${filters.q || filters.category ? '조건에 맞는 부품이 없습니다.' : '단가표가 없습니다. 관리자가 단가표를 넣어야 합니다.'}</div>`
      : `<div class="table-wrap" style="max-height:60vh"><table class="tbl click">
        <thead><tr><th>파트넘버</th><th>품명</th><th>적용 모델</th><th class="r std-col">뉴토크 기준값</th><th class="r">평균</th><th class="r">최저</th><th class="r">최고</th><th class="r">최고−최저</th><th class="r">출장지</th></tr></thead>
        <tbody>${data.items.map((i) => `
          <tr data-id="${i.id}" class="${detail?.id === i.id ? 'sel' : ''}">
            <td><b>${esc(i.part_no)}</b></td><td>${esc(i.name)}</td><td class="muted">${esc(i.applies_to || '-')}</td>
            <td class="r std-col"><b>${wonText(i.standard_price)}</b>${i.custom ? ' <span class="badge" title="이 부품만 할인율·추가단가를 따로 정함">별도</span>' : ''}</td>
            <td class="r num">${wonText(i.stats.average)}</td><td class="r num">${wonText(i.stats.min)}</td><td class="r num">${wonText(i.stats.max)}</td>
            <td class="r num">${wonText(i.stats.range)}</td><td class="r muted">${i.stats.count}곳</td>
          </tr>`).join('')}</tbody></table></div>
        <p class="hint" style="margin:10px 0 0">평균·최저·최고는 출장지(업체)마다 가장 최근 단가 1개로 계산합니다(적용 예정 단가 제외). 단가표 기준단가가 "-"인 부품은 기준값이 비어 있습니다.</p>`;
  }

  async function open(id) {
    detail = await api(`/api/parts/catalog/${id}`);
    body.querySelectorAll('#pp-table tr[data-id]').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.id) === detail.id));
    drawDetail();
  }

  function drawDetail() {
    destroyCharts();
    const el = $('#pp-detail');
    if (!detail) { el.innerHTML = ''; return; }
    const d = detail;
    const bars = d.prices.filter((p) => p.latest && p.diff_rate !== null).sort((a, b) => b.diff_rate - a.diff_rate)
      .map((p) => ({ key: p.id, label: p.company, rate: p.diff_rate, detail: `${wonText(p.unit_price)} (${signed(p.diff)}원)` }));
    el.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="ttl"><h3>${esc(d.part_no)} ${esc(d.name)}</h3><span class="hint">${esc(d.category)} · ${esc(d.applies_to || '적용 모델 없음')}</span></div></div>
        <div class="kv-row">
          <span>단가표 기준단가 <b>${wonText(d.list_price)}</b>${d.list_price_date ? ` <span class="muted">(${esc(d.list_price_date)} 기준)</span>` : ''}</span>
          <span>${settingText(d.discount_rate, d.extra_price)} <span class="muted">${d.custom ? '(이 부품 별도)' : '(전체 기본값)'}</span></span>
          <span>뉴토크 기준값 <b>${wonText(d.standard_price)}</b></span>
        </div>
        ${editable ? `<form id="pp-item" class="filters" style="margin:12px 0">
          <span class="muted">이 부품만 따로:</span>
          <label>할인율 <input class="input" name="discount_rate" type="number" min="0" max="100" step="0.01" placeholder="기본값" value="${d.custom ? d.discount_rate : ''}" style="width:90px"> %</label>
          <label>추가단가 <input class="input" name="extra_price" type="number" step="1" placeholder="기본값" value="${d.custom ? d.extra_price : ''}" style="width:120px"> 원</label>
          <button class="btn primary sm">저장</button>
          ${d.custom ? '<button type="button" class="btn sm" id="pp-item-reset">전체 기본값으로</button>' : ''}
        </form>` : '<div style="margin-bottom:12px"></div>'}
        ${d.revisions.length ? `<details class="hint" style="margin-bottom:12px"><summary>단가표 개정 이력 ${d.revisions.length}건</summary>
          <table class="tbl" style="width:auto;margin-top:6px"><thead><tr><th>단가표 기준일</th><th class="r">기준단가</th><th class="r">뉴토크 기준값</th></tr></thead>
          <tbody>${d.revisions.map((r) => `<tr><td>${esc(r.effective_date)}</td><td class="r">${wonText(r.list_price)}</td><td class="r">${wonText(r.standard_price)}</td></tr>`).join('')}</tbody></table></details>` : ''}
        <div class="stat5">
          ${[['뉴토크 기준값', d.standard_price, true], ['평균', d.stats.average], ['최저', d.stats.min], ['최고', d.stats.max], ['최고−최저', d.stats.range]]
            .map(([l, v, std]) => `<div class="${std ? 'std' : ''}"><span>${l}</span><b>${wonText(v)}</b></div>`).join('')}
        </div>
        ${bars.length ? `<div style="margin:16px 0"><div class="sub-ttl">출장지별 단가 · 뉴토크 기준값 대비</div>${legend}<div class="chart-box"><canvas id="pp-bars"></canvas></div></div>` : ''}
        ${!d.prices.length ? '<div class="empty">아직 출장지별 단가가 없습니다. 단가 직접 입력으로 쌓입니다.</div>' : `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>출장지(업체)</th><th>적용 시작일</th><th class="r">단가</th><th class="r" title="견적 적용 시작일에 쓰이던 단가표로 계산한 뉴토크 기준값">당시 기준값</th><th class="r">기준값 대비</th><th>출처</th><th>사업명</th><th>비고</th></tr></thead>
          <tbody>${d.prices.map((p) => `
            <tr class="${p.latest ? '' : 'dim'}">
              <td>${esc(p.company)}${p.latest ? ' <span class="badge blue" title="평균·최저·최고 계산에 쓰인 단가">비교 기준</span>' : ''}</td>
              <td>${esc(p.effective_date)}${p.upcoming ? ' <span class="badge">예정</span>' : ''}</td>
              <td class="r num">${wonText(p.unit_price)}</td>
              <td class="r num muted">${wonText(p.base_price)}</td>
              <td class="r num">${p.diff !== null ? `${signed(p.diff)}원 <span class="muted">(${signedRate(p.diff_rate)})</span>` : '-'}${p.low ? ` ${lowBadge(`기준값보다 ${d.low_alert_rate}% 이상 낮음 (할인 과다 점검)`)}` : ''}</td>
              <td>${esc(p.source)}${p.quote_no ? ` <span class="muted">${esc(p.quote_no)}</span>` : ''}</td>
              <td>${esc(p.project || '-')}</td><td class="wrap">${esc(p.note || '-')}</td>
            </tr>`).join('')}</tbody></table></div>`}
        <p class="hint" style="margin:10px 0 0">기준값 대비는 견적 적용 시작일에 쓰이던 단가표(당시 기준값)로 계산합니다. "크게 낮음"은 기준값보다 ${d.low_alert_rate}% 이상 낮은 견적입니다.
          흐린 줄은 같은 업체의 이전 단가(또는 적용 예정)라 평균·최저·최고 계산에서 빠집니다.</p>
      </div>`;
    if (bars.length) charts.push(diffBar(el.querySelector('#pp-bars'), bars));
    el.querySelector('#pp-item')?.addEventListener('submit', (e) => { e.preventDefault(); saveItem(new FormData(e.target)); });
    el.querySelector('#pp-item-reset')?.addEventListener('click', () => saveItem(null));
  }

  async function saveItem(fd) {
    const v = (k) => (fd && fd.get(k) !== '' ? fd.get(k) : null);
    try {
      detail = await api(`/api/parts/catalog/${detail.id}`, { method: 'PATCH', body: { discount_rate: v('discount_rate'), extra_price: v('extra_price') === null ? null : Number(v('extra_price')) } });
      toast('저장했습니다.');
      const id = detail.id;
      await load();
      if (!detail || detail.id !== id) await open(id);
      else drawDetail();
    } catch (err) { toast(err.message, true); }
  }

  $('#pp-search').addEventListener('submit', (e) => { e.preventDefault(); filters.q = e.target.q.value.trim(); load(); });
  $('#pp-cat').addEventListener('change', (e) => { filters.category = e.target.value; load(); });
  $('#pp-clear').addEventListener('click', () => { filters.q = ''; filters.category = ''; $('#pp-search').q.value = ''; $('#pp-cat').value = ''; load(); });
  $('#pp-table').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) open(Number(tr.dataset.id)); });
  const catalogUrl = () => `/api/parts/catalog/export?q=${encodeURIComponent(filters.q)}&category=${encodeURIComponent(filters.category)}`;
  $('#pp-xlsx').addEventListener('click', () => downloadFrom(catalogUrl()));
  $('#pp-csv').addEventListener('click', () => downloadFrom(`${catalogUrl()}&format=csv`));

  await load();
  if (openId && !(detail && detail.id === Number(openId))) {
    await open(Number(openId));
    $('#pp-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---------------- 출장지별 비교 ----------------
async function renderCompanies(body, charts, destroyCharts) {
  let category = '';
  let data = null;
  let selected = null;
  const cats = (await api('/api/parts/catalog')).categories;

  body.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div class="ttl"><h3>출장지별 단가 비교</h3><span class="hint">뉴토크 기준값 대비 평균 차이율</span></div>
        <div class="filters">
          <select class="input" id="pc-cat"><option value="">모든 분류</option>${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select>
          <button class="btn sm" id="pc-xlsx">⬇ 엑셀</button><button class="btn sm" id="pc-csv" title="업체 요약·부품별 차이 CSV 두 개를 ZIP 하나로">⬇ CSV</button>
        </div>
      </div>
      <div id="pc-main"></div>
    </div>
    <div id="pc-detail"></div>`;
  const $ = (s) => body.querySelector(s);

  async function load() {
    data = await api(`/api/parts/companies?category=${encodeURIComponent(category)}`);
    if (!data.companies.some((c) => c.company === selected)) selected = null;
    draw();
  }

  function draw() {
    destroyCharts();
    $('#pc-xlsx').disabled = !data.companies.length;
    $('#pc-csv').disabled = !data.companies.length;
    $('#pc-main').innerHTML = !data.companies.length
      ? '<div class="empty">비교할 출장지 단가가 없습니다. 단가 직접 입력으로 쌓입니다.</div>'
      : `${data.low_count ? `<div class="notice warn">${lowBadge('')} 뉴토크 기준값보다 <b>${data.low_alert_rate}% 이상 낮은</b> 견적이 <b>${data.low_count}건</b> 있습니다. 업체를 눌러 어떤 부품인지 확인하세요. (기준 ${data.low_alert_rate}%는 임시값 — 부품별 비교의 "기본값 수정"에서 바꿀 수 있음)</div>` : ''}
        ${legend}<div class="chart-box"><canvas id="pc-bars"></canvas></div>
        <div class="table-wrap" style="margin-top:14px"><table class="tbl click">
          <thead><tr><th>출장지(업체)</th><th class="r">비교 부품</th><th class="r">평균 차이율</th><th class="r">최저</th><th class="r">최고</th><th class="r">비쌈 · 쌈</th><th class="r">크게 낮음</th></tr></thead>
          <tbody>${data.companies.map((c) => `
            <tr data-c="${esc(c.company)}" class="${selected === c.company ? 'sel' : ''}">
              <td><b>${esc(c.company)}</b></td><td class="r">${c.count}개</td><td class="r"><b>${signedRate(c.average_rate)}</b></td>
              <td class="r">${signedRate(c.min_rate)}</td><td class="r">${signedRate(c.max_rate)}</td><td class="r muted">${c.above} · ${c.below}</td>
              <td class="r">${c.low ? `<span class="badge low">${c.low}건</span>` : '<span class="muted">-</span>'}</td>
            </tr>`).join('')}</tbody></table></div>
        <p class="hint" style="margin:10px 0 0">차이율 = (업체 단가 − 견적 당시 뉴토크 기준값) ÷ 당시 기준값. 부품마다 그 업체의 가장 최근 단가 1개만 쓰고, 평균은 부품마다 같은 무게로 계산합니다.
          기준값이 없는 부품은 빠집니다. 막대나 줄을 누르면 부품별 차이가 나옵니다.</p>`;
    if (data.companies.length) {
      charts.push(diffBar($('#pc-bars'), data.companies.map((c) => ({ key: c.company, label: c.company, rate: c.average_rate, detail: `부품 ${c.count}개 평균 (비쌈 ${c.above} · 쌈 ${c.below})` })),
        { selected, onSelect: toggle }));
    }
    drawDetail();
  }

  function drawDetail() {
    const c = data.companies.find((x) => x.company === selected);
    const el = $('#pc-detail');
    if (!c) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="ttl"><h3>${esc(c.company)}</h3><span class="hint">부품 ${c.count}개, 평균 ${signedRate(c.average_rate)}</span></div></div>
        ${legend}<div class="chart-box"><canvas id="pc-part-bars"></canvas></div>
        <div class="table-wrap" style="margin-top:14px"><table class="tbl">
          <thead><tr><th>파트넘버</th><th>품명</th><th class="r" title="견적 적용 시작일에 쓰이던 단가표로 계산한 뉴토크 기준값">당시 기준값</th><th class="r">업체 단가</th><th class="r">기준값 대비</th><th>적용 시작일</th></tr></thead>
          <tbody>${c.parts.map((p) => `
            <tr><td><a href="#/prices/parts" data-open="${p.id}" title="부품별 비교에서 이 부품 열기"><b>${esc(p.part_no)}</b></a></td><td>${esc(p.name)}</td>
              <td class="r num">${wonText(p.base_price)}</td><td class="r num">${wonText(p.unit_price)}</td>
              <td class="r num">${signed(p.diff)}원 <span class="muted">(${signedRate(p.diff_rate)})</span>${p.low ? ` ${lowBadge('')}` : ''}</td>
              <td>${esc(p.effective_date)}</td></tr>`).join('')}</tbody></table></div>
      </div>`;
    charts.push(diffBar(el.querySelector('#pc-part-bars'), c.parts.map((p) => ({ key: p.id, label: `${p.part_no} ${p.name}`, rate: p.diff_rate,
      detail: `${wonText(p.unit_price)} (당시 기준값 ${wonText(p.base_price)})${p.low ? ' · 크게 낮음' : ''}` }))));
  }

  function toggle(company) {
    selected = selected === company ? null : company;
    draw();
    if (selected) $('#pc-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#pc-cat').addEventListener('change', (e) => { category = e.target.value; load(); });
  $('#pc-xlsx').addEventListener('click', () => downloadFrom(`/api/parts/companies/export?category=${encodeURIComponent(category)}`));
  $('#pc-csv').addEventListener('click', () => downloadFrom(`/api/parts/companies/export?category=${encodeURIComponent(category)}&format=csv`));
  $('#pc-main').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-c]'); if (tr) toggle(tr.dataset.c); });
  // 출장지별 비교에서 파트넘버를 누르면 부품별 비교로 가서 그 부품을 연다
  $('#pc-detail').addEventListener('click', (e) => { const a = e.target.closest('[data-open]'); if (a) sessionStorage.setItem('openPart', a.dataset.open); });
  await load();
}
