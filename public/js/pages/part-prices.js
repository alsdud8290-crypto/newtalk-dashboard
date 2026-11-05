// 교체부품 단가 — 파트넘버별 비교 (ITB2026 서비스팀 단가 화면을 옮겨 옴)
//  부품별 비교: 뉴토크 기준값(= 단가표 기준단가, 칸을 두 번 눌러 직접 수정) + 출장지(업체)별 평균·최저·최고·최고−최저
//              줄을 누르면 아래에 출장지별 단가와 기준값 대비 차이
//  출장지별 비교: 업체마다 기준값 대비 평균 차이율 막대 → 누르면 그 업체의 부품별 차이
//  부품 단가 데이터 업로드: 부품 단가 데이터 CSV(단가표) / 출장지별 단가 CSV
//  신규 부품 등록: 직접 입력(한 건) + 엑셀로 여러 건 (같은 파트넘버는 덮어씀)
import { api, esc, toast, confirmBox, VIEW_ONLY } from '../core.js';
import { diffBar, DIFF_ABOVE, DIFF_BELOW, hideTooltip } from '../charts.js';
import { downloadFrom, periodDownloadButton, bindPeriodDownload } from '../exporter.js';
import { mountUpload } from './team-upload.js';

const wonText = (v) => (v === null || v === undefined ? '-' : `${Number(v).toLocaleString('ko-KR')}원`);
const signed = (v) => (v > 0 ? `+${v.toLocaleString('ko-KR')}` : v.toLocaleString('ko-KR'));
const signedRate = (r) => `${r > 0 ? '+' : ''}${r}%`;
const lowBadge = (title) => `<span class="badge low" title="${esc(title)}">크게 낮음</span>`;
const legend = `<div class="diff-legend">
  <span><i style="background:${DIFF_BELOW}"></i>기준값보다 쌈 (−)</span>
  <span><i style="background:${DIFF_ABOVE}"></i>기준값보다 비쌈 (+)</span>
  <span>가운데 진한 선 = 뉴토크 기준값 (0%)</span></div>`;
const TABS = [['parts', '#/prices/parts', '부품별 비교'], ['companies', '#/prices/companies', '출장지별 비교'],
  ['upload', '#/prices/upload', '부품 단가 데이터 업로드', true], ['new', '#/prices/new', '신규 부품 등록', true]];

export async function render(main, ctx) {
  const tab = TABS.some(([k]) => k === ctx.tab) ? ctx.tab : 'parts';
  const editable = ctx.canEdit('service');
  const charts = [];
  const destroyCharts = () => { while (charts.length) charts.pop().destroy(); hideTooltip(); };

  main.innerHTML = `
    <div class="page-head">
      <div><h2>교체부품 단가</h2><div class="sub">파트넘버별 뉴토크 기준값과 출장지(업체)별 단가를 비교합니다.</div></div>
    </div>
    ${editable ? '' : VIEW_ONLY}
    <div id="pp-body"></div>`;
  const body = main.querySelector('#pp-body');

  if (tab === 'companies') await renderCompanies(body, charts, destroyCharts);
  else if (tab === 'upload') renderUpload(body);
  else if (tab === 'new') await renderNew(body);
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
        <div class="filters">${periodDownloadButton('pp-dl', 'sm')}</div>
      </div>
      <div class="filters" style="margin-bottom:12px">
        <form id="pp-search" class="filters"><input class="input" name="q" placeholder="파트넘버(예: 05-A-01, 0501) 또는 품목" style="width:280px"><button class="btn">검색</button></form>
        <select class="input" id="pp-cat"><option value="">모든 분류</option></select>
        <button class="btn sm" id="pp-clear" hidden>조건 지우기</button>
      </div>
      <div class="std-box"><span><b>뉴토크 기준값</b> = 단가표 기준단가</span>
        ${editable ? '<span class="muted">· 기준값 칸을 <b>두 번 누르면</b> 직접 고칠 수 있습니다 (Enter 저장 · Esc 취소)</span>' : ''}</div>
      <div id="pp-table"></div>
    </div>
    <div id="pp-detail"></div>`;

  const $ = (s) => body.querySelector(s);
  async function load() {
    data = await api(`/api/parts/catalog?q=${encodeURIComponent(filters.q)}&category=${encodeURIComponent(filters.category)}`);
    const cat = $('#pp-cat');
    if (cat.options.length === 1) data.categories.forEach((c) => cat.add(new Option(c, c)));
    $('#pp-clear').hidden = !(filters.q || filters.category);
    drawTable();
    // 검색 결과가 하나면 바로 상세를 연다 (파트넘버로 찾을 때)
    if (data.items.length === 1) await open(data.items[0].id);
    else if (detail && !data.items.some((i) => i.id === detail.id)) { detail = null; drawDetail(); }
  }

  function drawTable() {
    const n = data.items.length;
    $('#pp-count').textContent = `${n}개 부품 · 줄을 누르면 출장지별 단가`;
    $('#pp-table').innerHTML = !n
      ? `<div class="empty">${filters.q || filters.category ? '조건에 맞는 부품이 없습니다.' : '단가표가 없습니다. 신규 부품 등록이나 부품 단가 데이터 업로드로 넣어 주세요.'}</div>`
      : `<div class="table-wrap" style="max-height:60vh"><table class="tbl click">
        <thead><tr><th>파트넘버</th><th>품목</th><th>적용모델</th><th class="r std-col">뉴토크 기준값</th><th class="r">평균</th><th class="r">최저</th><th class="r">최고</th><th class="r">최고−최저</th><th class="r">출장지</th></tr></thead>
        <tbody>${data.items.map((i) => `
          <tr data-id="${i.id}" class="${detail?.id === i.id ? 'sel' : ''}">
            <td><b>${esc(i.part_no)}</b></td><td>${esc(i.name)}</td><td class="muted">${esc(i.applies_to || '-')}</td>
            <td class="r std-col" ${editable ? 'data-std tabindex="0" title="두 번 눌러 직접 수정"' : ''}><b>${wonText(i.standard_price)}</b></td>
            <td class="r num">${wonText(i.stats.average)}</td><td class="r num">${wonText(i.stats.min)}</td><td class="r num">${wonText(i.stats.max)}</td>
            <td class="r num">${wonText(i.stats.range)}</td><td class="r muted">${i.stats.count}곳</td>
          </tr>`).join('')}</tbody></table></div>
        <p class="hint" style="margin:10px 0 0">평균·최저·최고는 출장지(업체)마다 가장 최근 단가 1개로 계산합니다(적용 예정 단가 제외). 기준값이 "-"인 부품은 기준단가가 비어 있습니다.</p>`;
  }

  // 기준값 칸 직접 수정: 두 번 누르기(또는 칸에서 Enter/F2) → 입력칸 → Enter·칸 밖 누르기 = 저장, Esc = 취소
  function editStd(td) {
    if (td.querySelector('input')) return;
    const id = Number(td.closest('tr').dataset.id);
    const item = data.items.find((i) => i.id === id);
    td.innerHTML = `<input class="input" inputmode="numeric" value="${item.standard_price ?? ''}" style="width:120px;text-align:right" placeholder="빈 값 = 미입력">`;
    const input = td.querySelector('input');
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const raw = input.value.replace(/[,\s원]/g, '');
      if (!save || raw === String(item.standard_price ?? '')) { td.innerHTML = `<b>${wonText(item.standard_price)}</b>`; return; }
      try {
        const d = await api(`/api/parts/catalog/${id}`, { method: 'PATCH', body: { list_price: raw } });
        item.standard_price = d.standard_price;
        item.list_price = d.list_price;
        toast(`${item.part_no} 뉴토크 기준값: ${wonText(d.standard_price)} 저장`);
        td.innerHTML = `<b>${wonText(item.standard_price)}</b>`;
        if (detail?.id === id) { detail = d; drawDetail(); }
      } catch (err) {
        toast(err.message, true);
        td.innerHTML = `<b>${wonText(item.standard_price)}</b>`;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
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
        <div class="card-head"><div class="ttl"><h3>${esc(d.part_no)} ${esc(d.name)}</h3><span class="hint">${esc(d.category || '분류 없음')} · ${esc(d.applies_to || '적용모델 없음')}</span></div></div>
        <div class="kv-row" style="margin-bottom:12px">
          <span>뉴토크 기준값(기준단가) <b>${wonText(d.standard_price)}</b>${d.list_price_date ? ` <span class="muted">(${esc(d.list_price_date)} 수정)</span>` : ''}</span>
        </div>
        <div class="stat5">
          ${[['뉴토크 기준값', d.standard_price, true], ['평균', d.stats.average], ['최저', d.stats.min], ['최고', d.stats.max], ['최고−최저', d.stats.range]]
            .map(([l, v, std]) => `<div class="${std ? 'std' : ''}"><span>${l}</span><b>${wonText(v)}</b></div>`).join('')}
        </div>
        ${bars.length ? `<div style="margin:16px 0"><div class="sub-ttl">출장지별 단가 · 뉴토크 기준값 대비</div>${legend}<div class="chart-box"><canvas id="pp-bars"></canvas></div></div>` : ''}
        ${!d.prices.length ? '<div class="empty">아직 출장지별 단가가 없습니다. 부품 단가 데이터 업로드의 "출장지별 단가"로 넣을 수 있습니다.</div>' : `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>출장지(업체)</th><th>적용 시작일</th><th class="r">단가</th><th class="r">뉴토크 기준값</th><th class="r">기준값 대비</th><th>출처</th><th>사업명</th><th>비고</th></tr></thead>
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
        <p class="hint" style="margin:10px 0 0">기준값 대비는 지금의 뉴토크 기준값으로 계산합니다. "크게 낮음"은 기준값보다 ${d.low_alert_rate}% 이상 낮은 단가입니다.
          흐린 줄은 같은 업체의 이전 단가(또는 적용 예정)라 평균·최저·최고 계산에서 빠집니다.</p>
      </div>`;
    if (bars.length) charts.push(diffBar(el.querySelector('#pp-bars'), bars));
  }

  $('#pp-search').addEventListener('submit', (e) => { e.preventDefault(); filters.q = e.target.q.value.trim(); load(); });
  $('#pp-cat').addEventListener('change', (e) => { filters.category = e.target.value; load(); });
  $('#pp-clear').addEventListener('click', () => { filters.q = ''; filters.category = ''; $('#pp-search').q.value = ''; $('#pp-cat').value = ''; load(); });
  $('#pp-table').addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) open(Number(tr.dataset.id));
  });
  $('#pp-table').addEventListener('dblclick', (e) => { const td = e.target.closest('td[data-std]'); if (td) editStd(td); });
  $('#pp-table').addEventListener('keydown', (e) => {
    const td = e.target.closest?.('td[data-std]');
    if (td && e.target === td && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); editStd(td); }
  });
  const catalogUrl = () => `/api/parts/catalog/export?q=${encodeURIComponent(filters.q)}&category=${encodeURIComponent(filters.category)}`;
  bindPeriodDownload(body, 'pp-dl', { noPeriod: true, hint: '검색어·분류는 화면에서 고른 그대로 담습니다.',
    onExcel: () => downloadFrom(catalogUrl()), onCsv: () => downloadFrom(`${catalogUrl()}&format=csv`) });

  await load();
  if (openId && !(detail && detail.id === Number(openId))) {
    await open(Number(openId));
    $('#pp-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---------------- 부품 단가 데이터 업로드 (CSV) ----------------
//  ① 부품 단가 데이터 (단가표: 분류·파트넘버·품목·적용모델·기준단가) — 회사 "부품 및 단가리스트" [부품] 시트 CSV 그대로
//  ② 출장지별 단가 (파트넘버·출장지·단가·적용 시작일)
const UPLOAD_KINDS = [
  ['part_price_csv', '부품 단가 데이터 (기준단가)', 'catalog'],
  ['company_price_csv', '출장지별 단가', 'company'],
];
function renderUpload(body) {
  let kind = UPLOAD_KINDS[0];
  const draw = () => {
    body.innerHTML = `
      <div class="filters" style="margin-bottom:12px">
        <div class="seg" id="pu-kind">${UPLOAD_KINDS.map((k) => `<button type="button" data-k="${k[0]}" class="${k === kind ? 'on' : ''}">${k[1]}</button>`).join('')}</div>
        <button class="btn sm" id="pu-tpl">⬇ CSV 양식</button>
      </div>
      <div id="pu-body"></div>`;
    mountUpload(body.querySelector('#pu-body'), kind[0], { heading: kind[0] === 'part_price_csv' ? '부품 단가 데이터 CSV 업로드' : '출장지별 단가 CSV 업로드' });
    body.querySelector('#pu-kind').addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b && b.dataset.k !== kind[0]) { kind = UPLOAD_KINDS.find((k) => k[0] === b.dataset.k); draw(); }
    });
    body.querySelector('#pu-tpl').addEventListener('click', () => downloadFrom(`/api/parts/template?kind=${kind[2]}&format=csv`));
  };
  draw();
}

// ---------------- 신규 부품 등록 ----------------
//  직접 입력: 분류·파트넘버·품목·적용모델·기준단가 → 한 건 저장 (같은 파트넘버가 있으면 덮어쓸지 물어봄)
//  엑셀 업로드: 여러 건 한 번에 (같은 파트넘버는 새 내용으로 덮어씀)
async function renderNew(body) {
  const { categories } = await api('/api/parts/catalog');
  body.innerHTML = `
    <form id="pn-form" class="card" style="max-width:980px;margin-bottom:16px" autocomplete="off">
      <div class="card-head"><div class="ttl"><h3>직접 입력</h3><span class="hint">한 건씩 저장합니다. 같은 파트넘버가 있으면 덮어쓸지 물어봅니다.</span></div></div>
      <datalist id="pn-cats">${categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <div class="form-grid three">
        <div class="field"><label>분류</label><input class="input" name="category" list="pn-cats" placeholder="예: 05 MOTOR"></div>
        <div class="field"><label>파트넘버 *</label><input class="input" name="part_no" required placeholder="예: MD-05-A-01"></div>
        <div class="field"><label>품목 *</label><input class="input" name="name" required placeholder="예: Motor"></div>
        <div class="field"><label>적용모델</label><input class="input" name="applies_to" placeholder="예: NTI-01 ~ 03"></div>
        <div class="field"><label>기준단가 (원)</label><input class="input" name="list_price" inputmode="numeric" placeholder="예: 500,000 (비우면 미입력)"></div>
      </div>
      <div class="filters" style="margin-top:12px"><button class="btn primary">저장</button><button type="reset" class="btn">지우기</button><span class="hint" id="pn-msg"></span></div>
    </form>
    <div class="filters" style="margin-bottom:12px"><button class="btn sm" id="pn-tpl">⬇ 엑셀 양식</button></div>
    <div id="pn-upload"></div>`;
  const form = body.querySelector('#pn-form');
  const send = async (values, overwrite = false) => api('/api/parts/catalog', { method: 'POST', body: { ...values, overwrite } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    try {
      let r;
      try {
        r = await send(values);
      } catch (err) {
        if (err.status !== 409) throw err;
        const ex = err.data?.existing;
        const ok = await confirmBox(`${err.message}${ex ? ` (지금 값: ${ex.category || '-'} · ${ex.name} · ${ex.applies_to || '-'} · ${wonText(ex.standard_price)})` : ''}`, '덮어쓰기');
        if (!ok) return;
        r = await send(values, true);
      }
      toast(`${r.item.part_no} ${r.item.name} ${r.overwritten ? '덮어썼습니다' : '등록했습니다'}.`);
      body.querySelector('#pn-msg').innerHTML = `마지막 저장: <b>${esc(r.item.part_no)}</b> ${esc(r.item.name)} · ${wonText(r.item.standard_price)} — <a href="#/prices/parts" data-open="${r.id}">부품별 비교에서 보기</a>`;
      form.reset();
      form.part_no.focus();
    } catch (err) { toast(err.message, true); }
  });
  body.querySelector('#pn-msg').addEventListener('click', (e) => { const a = e.target.closest('[data-open]'); if (a) sessionStorage.setItem('openPart', a.dataset.open); });
  body.querySelector('#pn-tpl').addEventListener('click', () => downloadFrom('/api/parts/template?kind=catalog'));
  mountUpload(body.querySelector('#pn-upload'), 'part_catalog_excel', { heading: '엑셀로 여러 부품 등록' });
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
          ${periodDownloadButton('pc-dl', 'sm')}
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
    $('#pc-main').innerHTML = !data.companies.length
      ? '<div class="empty">비교할 출장지 단가가 없습니다. 부품 단가 데이터 업로드의 "출장지별 단가"로 넣을 수 있습니다.</div>'
      : `${data.low_count ? `<div class="notice warn">${lowBadge('')} 뉴토크 기준값보다 <b>${data.low_alert_rate}% 이상 낮은</b> 견적이 <b>${data.low_count}건</b> 있습니다. 업체를 눌러 어떤 부품인지 확인하세요.</div>` : ''}
        ${legend}<div class="chart-box"><canvas id="pc-bars"></canvas></div>
        <div class="table-wrap" style="margin-top:14px"><table class="tbl click">
          <thead><tr><th>출장지(업체)</th><th class="r">비교 부품</th><th class="r">평균 차이율</th><th class="r">최저</th><th class="r">최고</th><th class="r">비쌈 · 쌈</th><th class="r">크게 낮음</th></tr></thead>
          <tbody>${data.companies.map((c) => `
            <tr data-c="${esc(c.company)}" class="${selected === c.company ? 'sel' : ''}">
              <td><b>${esc(c.company)}</b></td><td class="r">${c.count}개</td><td class="r"><b>${signedRate(c.average_rate)}</b></td>
              <td class="r">${signedRate(c.min_rate)}</td><td class="r">${signedRate(c.max_rate)}</td><td class="r muted">${c.above} · ${c.below}</td>
              <td class="r">${c.low ? `<span class="badge low">${c.low}건</span>` : '<span class="muted">-</span>'}</td>
            </tr>`).join('')}</tbody></table></div>
        <p class="hint" style="margin:10px 0 0">차이율 = (업체 단가 − 뉴토크 기준값) ÷ 뉴토크 기준값. 부품마다 그 업체의 가장 최근 단가 1개만 쓰고, 평균은 부품마다 같은 무게로 계산합니다.
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
          <thead><tr><th>파트넘버</th><th>품목</th><th class="r">뉴토크 기준값</th><th class="r">업체 단가</th><th class="r">기준값 대비</th><th>적용 시작일</th></tr></thead>
          <tbody>${c.parts.map((p) => `
            <tr><td><a href="#/prices/parts" data-open="${p.id}" title="부품별 비교에서 이 부품 열기"><b>${esc(p.part_no)}</b></a></td><td>${esc(p.name)}</td>
              <td class="r num">${wonText(p.base_price)}</td><td class="r num">${wonText(p.unit_price)}</td>
              <td class="r num">${signed(p.diff)}원 <span class="muted">(${signedRate(p.diff_rate)})</span>${p.low ? ` ${lowBadge('')}` : ''}</td>
              <td>${esc(p.effective_date)}</td></tr>`).join('')}</tbody></table></div>
      </div>`;
    charts.push(diffBar(el.querySelector('#pc-part-bars'), c.parts.map((p) => ({ key: p.id, label: `${p.part_no} ${p.name}`, rate: p.diff_rate,
      detail: `${wonText(p.unit_price)} (기준값 ${wonText(p.base_price)})${p.low ? ' · 크게 낮음' : ''}` }))));
  }

  function toggle(company) {
    selected = selected === company ? null : company;
    draw();
    if (selected) $('#pc-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#pc-cat').addEventListener('change', (e) => { category = e.target.value; load(); });
  bindPeriodDownload(body, 'pc-dl', { noPeriod: true, hint: '고른 분류의 업체 요약·부품별 차이를 담습니다 (CSV는 두 파일을 ZIP 하나로).',
    onExcel: () => downloadFrom(`/api/parts/companies/export?category=${encodeURIComponent(category)}`),
    onCsv: () => downloadFrom(`/api/parts/companies/export?category=${encodeURIComponent(category)}&format=csv`) });
  $('#pc-main').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-c]'); if (tr) toggle(tr.dataset.c); });
  // 출장지별 비교에서 파트넘버를 누르면 부품별 비교로 가서 그 부품을 연다
  $('#pc-detail').addEventListener('click', (e) => { const a = e.target.closest('[data-open]'); if (a) sessionStorage.setItem('openPart', a.dataset.open); });
  await load();
}
