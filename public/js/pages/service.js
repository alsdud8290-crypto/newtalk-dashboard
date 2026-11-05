// 서비스팀 화면 (ITB2026에서 옮겨 옴)
//  대시보드: 출장 실적(횟수·유상/무상·월별) · 출장지 지도와 지역 순위(시·도/시·군) · 교체 부품 · A/S 모델 · 담당자
//  출장보고서 목록·상세 / 입력(PDF 올리기·직접 입력)
import { api, esc, toast, today } from '../core.js';
import { donut, countStack, SERIES, OTHER, hideTooltip } from '../charts.js';
import { koreaMap, hideMapTip } from '../korea-map.js';
import { periodDownloadButton, bindPeriodDownload, downloadFrom, addCardMenus, bindCardMenus } from '../exporter.js';
import { prodPeriod, periodQS, periodSelector, dlPeriod, dash } from './prod-common.js';
import { mountUpload } from './team-upload.js';

const PAID_COLORS = { 유상: SERIES[0], 무상: SERIES[2] };
const paidColor = (n) => PAID_COLORS[n] || OTHER;
const cnt = (v) => `${Number(v).toLocaleString('ko-KR')}회`;
const wonText = (v) => (v === null || v === undefined ? '-' : `${Number(v).toLocaleString('ko-KR')}원`);
const PERSON_TOP = 5;

function hbars(rows, unit, { limit = 10 } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.quantity));
  const total = rows.reduce((a, r) => a + r.quantity, 0);
  return `<table class="tbl rank static"><tbody>${rows.slice(0, limit).map((r) => `<tr>
    <td class="nm" title="${esc(r.name)}">${esc(r.name)}</td><td class="bar"><span style="width:${r.quantity / max * 100}%;background:${SERIES[0]}"></span></td>
    <td class="r num"><b>${r.quantity}${unit}</b></td><td class="r muted">${total ? Math.round(r.quantity / total * 1000) / 10 : 0}%</td></tr>`).join('') || '<tr><td class="muted">데이터가 없습니다.</td></tr>'}</tbody></table>
    ${rows.length > limit ? `<p class="hint" style="margin:6px 0 0">상위 ${limit}개 (전체 ${rows.length}개)</p>` : ''}`;
}

export async function render(main) {
  let level = 'region';
  let data = null;
  const charts = [];
  const destroy = () => { while (charts.length) charts.pop().destroy(); hideTooltip(); hideMapTip(); };

  main.innerHTML = `
    <div class="page-head">
      <div><h2>서비스팀 대시보드</h2><div class="sub">출장보고서 기준 · 출장 시작일로 기간에 넣음 (여러 날 출장도 1회)</div></div>
      <div class="filters"><div id="sv-period"></div>${periodDownloadButton('sv-dl')}</div>
    </div>
    <div id="sv-body"><div class="empty">불러오는 중…</div></div>`;

  async function load() {
    try {
      data = await api(`/api/service/dashboard?${periodQS()}`);
      await draw();
    } catch (e) { main.querySelector('#sv-body').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  }

  async function draw() {
    destroy();
    const s = data.service;
    const persons = s.by_person.slice(0, PERSON_TOP).map((p) => ({ label: p.name, value: p.quantity }));
    const rest = s.by_person.slice(PERSON_TOP).reduce((a, p) => a + p.quantity, 0);
    if (rest) persons.push({ label: '기타', value: rest });
    const personTotal = s.by_person.reduce((a, p) => a + p.quantity, 0);
    // 담당자 색: 이름 가나다순으로 고정 (기간이 바뀌어도 같은 사람은 같은 색)
    const pNames = persons.filter((p) => p.label !== '기타').map((p) => p.label).sort((a, b) => a.localeCompare(b, 'ko'));
    const PCOL = [SERIES[2], SERIES[3], SERIES[6], SERIES[4], SERIES[5]];
    const personColor = (n) => (n === '기타' ? OTHER : PCOL[pNames.indexOf(n)] || OTHER);
    const regionItems = level === 'region' ? s.by_region : s.by_district;
    const modelMax = Math.max(1, ...s.by_model.map((m) => m.quantity));

    main.querySelector('#sv-body').innerHTML = `
      <div class="card" style="margin-bottom:18px" data-card="trips">
        <div class="card-head"><div class="ttl"><h3>${esc(data.period.label)} 출장 실적</h3></div></div>
        <div class="sv-top">
          <div>
            <div class="big-num">${s.trip_count.toLocaleString('ko-KR')}<small>회</small></div>
            <div class="hint" style="margin-bottom:10px">출장 시작일 기준, 여러 날 출장도 1회</div>
            <div class="donut-row"><div class="donut-box small"><canvas id="sv-paid"></canvas></div><div class="legend" id="sv-paid-legend"></div></div>
          </div>
          <div>
            <div class="diff-legend"><span class="muted">${data.period.start.slice(0, 4)}년 월별 출장 횟수 (선택한 기간은 진하게)</span>
              ${['유상', '무상'].map((n) => `<span><i style="background:${paidColor(n)}"></i>${n}</span>`).join('')}</div>
            <div class="chart-box" style="height:250px"><canvas id="sv-monthly"></canvas></div>
          </div>
        </div>
      </div>
      <div class="split2" style="margin-bottom:18px">
        <div class="card" data-card="map">
          <div class="card-head"><div class="ttl"><h3>출장지 지도</h3><span class="hint">점이 클수록 출장이 많음 (점에 마우스를 올리면 횟수)</span></div>
            <div class="seg sm" id="sv-level">${[['region', '시·도별'], ['district', '시·군별']].map(([v, l]) => `<button type="button" data-l="${v}" class="${level === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <div id="sv-map" class="map-wrap"></div>
          ${level === 'district' ? '<p class="hint" style="margin:6px 0 0">특별·광역시·세종시는 시 전체를 점 하나로 표시합니다.</p>' : ''}
        </div>
        <div class="card" data-card="regions">
          <div class="card-head"><div class="ttl"><h3>지역별 출장 순위</h3><span class="hint">${level === 'region' ? '시·도별' : '시·군별'}</span></div></div>
          ${hbars(regionItems, '회', { limit: 17 })}
        </div>
      </div>
      <div class="split3">
        <div class="card" data-card="parts">
          <div class="card-head"><div class="ttl"><h3>교체 부품 순위</h3><span class="hint">사용 횟수 (보고서에 수량이 없어 1회씩)</span></div><a class="btn sm" href="#/prices/parts">단가 보기</a></div>
          ${!s.by_part.length ? '<div class="empty">데이터가 없습니다.</div>' : `<table class="tbl rank static parts-rank"><colgroup><col style="width:34%"><col style="width:24%"><col style="width:42%"></colgroup><thead><tr><th>부품명</th><th>사용 횟수</th><th class="r">현재 단가</th></tr></thead><tbody>${s.by_part.slice(0, 10).map((p) => {
            const max = s.by_part[0].quantity;
            const ch = p.change ? `<div class="${p.change > 0 ? 'up' : 'down'}" style="font-size:11px" title="직전 단가 대비">직전 ${p.change > 0 ? '+' : ''}${p.change.toLocaleString('ko-KR')}원${p.change_rate !== null ? ` (${p.change_rate > 0 ? '+' : ''}${p.change_rate}%)` : ''}</div>` : '';
            return `<tr><td class="nm" title="${esc(p.name)}">${esc(p.name)}</td><td><div class="inline-bar"><span style="width:${p.quantity / max * 100}%"></span><b>${p.quantity}회</b></div></td><td class="r num">${wonText(p.current_price)}${ch}</td></tr>`;
          }).join('')}</tbody></table>`}
        </div>
        <div class="card" data-card="models">
          <div class="card-head"><div class="ttl"><h3>A/S 제품 모델 순위</h3><span class="hint">수량 · 유상·무상</span></div></div>
          <div class="diff-legend">${['유상', '무상'].map((n) => `<span><i style="background:${paidColor(n)}"></i>${n}</span>`).join('')}</div>
          ${!s.by_model.length ? '<div class="empty">데이터가 없습니다.</div>' : `<div class="split-bars">${s.by_model.slice(0, 10).map((m) => `
            <div title="유상 ${m.paid}대 · 무상 ${m.unpaid}대"><span class="nm">${esc(m.name)}</span>
              <span class="bars"><i style="width:${m.paid / modelMax * 100}%;background:${paidColor('유상')}"></i><i style="width:${m.unpaid / modelMax * 100}%;background:${paidColor('무상')}"></i></span>
              <b>${m.quantity}대</b></div>`).join('')}</div>`}
        </div>
        <div class="card" data-card="persons">
          <div class="card-head"><div class="ttl"><h3>출장 담당자 비중</h3><span class="hint">작성자+동행자, 보고서 1건당 1인 1회</span></div></div>
          ${persons.length ? '<div class="donut-row"><div class="donut-box small"><canvas id="sv-person"></canvas></div><div class="legend" id="sv-person-legend"></div></div>' : '<div class="empty">데이터가 없습니다.</div>'}
          <p class="hint" style="margin:10px 0 0">비중 = 전체 참여 ${personTotal}회 중 차지하는 몫${s.by_person.length > PERSON_TOP ? ' · 6위부터는 "기타"로 묶음' : ''}</p>
        </div>
      </div>`;

    addCardMenus(main.querySelector('#sv-body'));
    charts.push(donut(main.querySelector('#sv-paid'), main.querySelector('#sv-paid-legend'), s.paid.map((p) => ({ label: p.name, value: p.quantity })), paidColor, { fmt: cnt }));
    const hl = data.period.months.map((m) => m - 1);
    charts.push(countStack(main.querySelector('#sv-monthly'), s.monthly.map((m) => `${m.month}월`), [
      { label: '유상', data: s.monthly.map((m) => m.paid), color: paidColor('유상') },
      { label: '무상', data: s.monthly.map((m) => m.unpaid), color: paidColor('무상') },
    ], { highlight: hl }));
    if (persons.length) charts.push(donut(main.querySelector('#sv-person'), main.querySelector('#sv-person-legend'), persons, personColor, { fmt: cnt }));
    // 지도를 못 불러와도 나머지 화면은 그대로 보이게
    try {
      await koreaMap(main.querySelector('#sv-map'), regionItems, { small: level === 'district' });
    } catch {
      main.querySelector('#sv-map').innerHTML = '<div class="empty">지도를 불러오지 못했습니다. 오른쪽 지역별 순위를 참고해 주세요.</div>';
    }
    main.querySelector('#sv-level').addEventListener('click', (e) => { const b = e.target.closest('[data-l]'); if (b && b.dataset.l !== level) { level = b.dataset.l; draw(); } });
  }

  // 카드별 [⬇] → PDF · 데이터(CSV). 표는 화면에 보이는 내용 그대로
  const share = (rows) => { const t = rows.reduce((a, r) => a + r.quantity, 0); return rows.map((r) => [r.name, r.quantity, t ? Math.round(r.quantity / t * 1000) / 10 : 0]); };
  function cardData(key) {
    if (!data) return null;
    const s = data.service;
    const label = data.period.label;
    const lv = level === 'region' ? '시·도' : '시·군';
    switch (key) {
      case 'trips': return { name: '출장실적', aoa: [
        [`${label} 출장 실적`], ['항목', '횟수(회)'], ['출장 횟수', s.trip_count], ...s.paid.map((p) => [p.name, p.quantity]), [],
        [`${data.period.start.slice(0, 4)}년 월별 출장`], ['월', '유상(회)', '무상(회)', '합계(회)'], ...s.monthly.map((m) => [`${m.month}월`, m.paid, m.unpaid, m.count])] };
      case 'map':
      case 'regions': return { name: `지역별출장_${lv}`, aoa: [[lv, '횟수(회)', '비중(%)'], ...share(level === 'region' ? s.by_region : s.by_district)] };
      case 'parts': return { name: '교체부품순위', aoa: [['부품명', '사용 횟수(회)', '현재 단가(원)', '직전 대비(원)', '직전 대비(%)'],
        ...s.by_part.map((p) => [p.name, p.quantity, p.current_price ?? '', p.change ?? '', p.change_rate ?? ''])] };
      case 'models': return { name: 'AS제품모델순위', aoa: [['모델', '유상(대)', '무상(대)', '합계(대)'], ...s.by_model.map((m) => [m.name, m.paid, m.unpaid, m.quantity])] };
      case 'persons': return { name: '출장담당자', aoa: [['담당자', '참여(회)', '비중(%)'], ...share(s.by_person)] };
      default: return null;
    }
  }
  bindCardMenus(main, { getData: cardData, prefix: '서비스팀', label: () => data?.period.label || '' });

  bindPeriodDownload(main, 'sv-dl', {
    ...dlPeriod(), modes: ['month', 'quarter', 'year'], current: dlPeriod, currentYear: () => prodPeriod.year,
    hint: '고른 기간의 출장 실적·월별·지역·교체 부품·AS 모델·담당자·출장보고서 목록을 시트별로 담습니다(CSV는 시트별 파일을 ZIP 하나로).',
    onExcel: (period) => downloadFrom(`/api/service/dashboard/export?period=${period}`),
    onCsv: (period) => downloadFrom(`/api/service/dashboard/export?period=${period}&format=csv`),
  });
  await periodSelector(main.querySelector('#sv-period'), load);
  await load();
  return destroy;
}

// ---------------- 출장보고서 목록 · 상세 ----------------
export const reports = {
  async render(main, ctx) {
    const editable = ctx.canEdit('service');
    let list = null;
    let openId = null;
    main.innerHTML = `
      <div class="page-head">
        <div><h2>출장보고서 목록</h2><div class="sub">출장 시작일 기준 · 줄을 누르면 고장·작업 내용까지 상세</div></div>
        <div class="filters"><div id="rp-period"></div>${editable ? '<a class="btn primary" href="#/service/reports/new">+ 직접 입력</a>' : ''}</div>
      </div>
      <div class="card" style="margin-bottom:16px"><div id="rp-table"><div class="empty">불러오는 중…</div></div></div>
      <div id="rp-detail"></div>`;
    const $ = (s) => main.querySelector(s);
    async function load() {
      list = await api(`/api/service/reports?${periodQS()}`);
      draw();
      if (openId && !list.results.some((r) => r.id === openId)) { openId = null; $('#rp-detail').innerHTML = ''; }
    }
    function draw() {
      $('#rp-table').innerHTML = !list.results.length ? '<div class="empty">이 기간의 출장보고서가 없습니다.</div>' : `
        <div class="hint" style="margin-bottom:8px">${esc(list.period.label)} · ${list.results.length}건</div>
        <div class="table-wrap" style="max-height:60vh"><table class="tbl click">
          <thead><tr><th>출장일</th><th>요청처</th><th>지역</th><th>비용</th><th>작업</th><th>모델</th><th>작성자</th><th>입력</th></tr></thead>
          <tbody>${list.results.map((r) => `<tr data-id="${r.id}" class="${openId === r.id ? 'sel' : ''}">
            <td>${esc(r.start_date)}${r.end_date && r.end_date !== r.start_date ? ` ~ ${esc(r.end_date.slice(5))}` : ''}</td><td><b>${esc(r.requester)}</b></td>
            <td>${esc(r.region)}${r.district ? ` ${esc(r.district)}` : ''}</td>
            <td><span class="status-chip ${r.paid_type === '유상' ? 'pending' : 'good'}">${esc(r.paid_type)}</span></td><td>${dash(r.work_type)}</td>
            <td>${esc(r.models.join(', ') || '-')}</td><td>${esc(r.author)}</td><td class="muted">${r.input_method === 'manual' ? '직접 입력' : 'PDF'}</td></tr>`).join('')}</tbody>
        </table></div>`;
    }
    async function open(id) {
      openId = id;
      draw();
      const r = await api(`/api/service/reports/${id}`);
      const field = (l, v) => `<tr><th>${l}</th><td class="wrap">${v === '' || v === null || v === undefined ? '<span class="muted">-</span>' : v}</td></tr>`;
      $('#rp-detail').innerHTML = `
        <div class="card">
          <div class="card-head"><div class="ttl"><h3>${esc(r.start_date)} ${esc(r.requester)}</h3><span class="hint">${esc(r.input_method_display)} · 작성 ${esc(r.author)}</span></div></div>
          <div class="split2">
            <table class="tbl detail-tbl"><tbody>
              ${field('출장 기간', `${esc(r.start_date)}${r.end_date ? ` ~ ${esc(r.end_date)}` : ''}`)}${field('추가 출장', esc(r.extra_trip))}
              ${field('비용청구', esc(r.paid_type))}${field('요청처', `${esc(r.requester)} <span class="muted">${esc(r.requester_type)}</span>`)}
              ${field('지역', `${esc(r.region)} ${esc(r.district)}`)}${field('작업 구분', esc(r.work_type))}${field('출장 목적', esc(r.purpose))}
              ${field('작성자 · 동행자', `${esc(r.author)}${r.companions.length ? ` · ${esc(r.companions.join(', '))}` : ''}`)}
            </tbody></table>
            <table class="tbl detail-tbl"><tbody>
              ${field('제품', r.products.map((p) => `${esc(p.model_name)} × ${p.quantity}${p.spec ? ` <span class="muted">${esc(p.spec)}</span>` : ''}${p.serial_no_raw ? ` <span class="muted">S/N ${esc(p.serial_no_raw)}</span>` : ''}`).join('<br>'))}
              ${field('교체 부품', esc(r.parts.join(', ')))}${field('고장 내용', esc(r.fault_description))}${field('작업 내용', esc(r.work_description))}${field('작업 결과', esc(r.work_result))}
            </tbody></table>
          </div>
          <p class="hint" style="margin:10px 0 0">출장보고서 일련번호(A800…)는 제조내역 일련번호와 형식이 달라 원문 그대로 저장만 합니다.</p>
        </div>`;
      $('#rp-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    $('#rp-table').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) open(Number(tr.dataset.id)); });
    await periodSelector($('#rp-period'), load);
    await load();
  },
};

// ---------------- 출장보고서 입력: PDF 올리기 + 직접 입력 (서비스팀 수정 권한) ----------------
export const reportForm = {
  async render(main) {
    const ch = await api('/api/service/form-choices');
    const regionOf = Object.fromEntries(ch.requesters.map((r) => [r.requester, r]));
    const productRow = (p = {}) => `<div class="prod-row">
      <input class="input" data-p="model_name" placeholder="모델명 *" list="rf-models" value="${esc(p.model_name || '')}">
      <input class="input" data-p="quantity" type="number" min="1" placeholder="수량 *" value="${esc(p.quantity || '1')}" style="width:90px">
      <input class="input" data-p="spec" placeholder="사양" value="${esc(p.spec || '')}">
      <input class="input" data-p="serial_no_raw" placeholder="일련번호(원문)" value="${esc(p.serial_no_raw || '')}">
      <button type="button" class="btn sm danger" data-rm>삭제</button></div>`;
    main.innerHTML = `
      <div class="page-head">
        <div><h2>출장보고서 입력</h2><div class="sub">PDF로 올리거나 직접 입력합니다. 같은 출장 시작일·요청처의 보고서가 있으면 저장 전에 알려 줍니다.</div></div>
        <div class="filters"><a class="btn" href="#/service/reports">← 목록</a><a class="btn" href="#/service/uploads">업로드 이력</a></div>
      </div>
      <div id="rf-upload"></div>
      <form id="rf" class="card" style="max-width:980px" autocomplete="off">
        <div class="card-head"><div class="ttl"><h3>직접 입력</h3><span class="hint">PDF 업로드와 같은 규칙으로 검사합니다</span></div></div>
        <datalist id="rf-requesters">${ch.requesters.map((r) => `<option value="${esc(r.requester)}">`).join('')}</datalist>
        <datalist id="rf-people">${ch.people.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <datalist id="rf-models">${ch.models.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <datalist id="rf-parts">${ch.parts.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="form-grid three">
          <div class="field"><label>출장 시작일 *</label><input class="input" type="date" name="start_date" value="${today()}" required></div>
          <div class="field"><label>출장 종료일</label><input class="input" type="date" name="end_date"></div>
          <div class="field"><label>비용청구 *</label><div class="seg" id="rf-paid"><button type="button" data-v="유상" class="on">유상</button><button type="button" data-v="무상">무상</button></div></div>
          <div class="field"><label>요청처 *</label><input class="input" name="requester" list="rf-requesters" required placeholder="예: ○○정수장"><span class="hint" id="rf-req-hint"></span></div>
          <div class="field"><label>시·도 *</label><select class="input" name="region"><option value="">선택</option>${ch.regions.map((r) => `<option>${r}</option>`).join('')}</select></div>
          <div class="field"><label>시·군</label><select class="input" name="district" disabled><option value="">없음</option></select></div>
          <div class="field"><label>요청처 구분</label><input class="input" name="requester_type" placeholder="예: 검색 불가"></div>
          <div class="field"><label>작업 구분</label><input class="input" name="work_type" list="rf-work" placeholder="예: 수리"><datalist id="rf-work"><option value="수리"><option value="점검"><option value="설치"></datalist></div>
          <div class="field"><label>추가 출장</label><input class="input" name="extra_trip" placeholder="예: 없음"></div>
          <div class="field full"><label>출장 목적</label><input class="input" name="purpose"></div>
          <div class="field"><label>작성자 *</label><input class="input" name="author" list="rf-people" required></div>
          <div class="field" style="grid-column:span 2"><label>동행자 (쉼표로 구분)</label><input class="input" name="companions" list="rf-people" placeholder="예: 김○○ 대리, 이○○ 과장"></div>
          <div class="field full"><label>제품 (모델명·수량은 필수)</label><div id="rf-products">${productRow()}</div><button type="button" class="btn sm" id="rf-add-prod">+ 제품 추가</button></div>
          <div class="field full"><label>교체 부품 (쉼표로 구분 — 부품 단가표 품명을 쓰면 단가와 연결됩니다)</label><input class="input" name="parts" list="rf-parts" placeholder="예: Main Board, Magnetic Contactor"></div>
          <div class="field full"><label>고장 내용</label><textarea class="input" name="fault_description" rows="3"></textarea></div>
          <div class="field full"><label>작업 내용</label><textarea class="input" name="work_description" rows="3"></textarea></div>
          <div class="field full"><label>작업 결과</label><textarea class="input" name="work_result" rows="2"></textarea></div>
        </div>
        <div id="rf-msg"></div>
        <div class="filters" style="margin-top:14px"><label class="chk" id="rf-dup-wrap" hidden><input type="checkbox" id="rf-dup"> 중복 아님 — 같은 곳에 실제로 두 번 간 경우 저장</label>
          <button class="btn primary">저장</button></div>
      </form>`;
    mountUpload(main.querySelector('#rf-upload'), 'trip_report_pdf', { heading: 'PDF로 올리기' });
    const f = main.querySelector('#rf');
    let paid = '유상';
    const districtSel = f.district;
    const fillDistricts = (region, sel = '') => {
      const list = ch.districts[region] || [];
      districtSel.disabled = !list.length;
      districtSel.innerHTML = list.length ? `<option value="">선택</option>${list.map((d) => `<option ${d === sel ? 'selected' : ''}>${d}</option>`).join('')}` : '<option value="">없음 (특별·광역시)</option>';
    };
    f.region.addEventListener('change', () => fillDistricts(f.region.value));
    // 요청처를 고르면 기억된 시·도·시·군을 자동으로 채운다
    f.requester.addEventListener('change', () => {
      const m = regionOf[f.requester.value.trim()];
      main.querySelector('#rf-req-hint').textContent = m ? `기억된 지역: ${m.region} ${m.district}` : '';
      if (m) { f.region.value = m.region; fillDistricts(m.region, m.district); }
    });
    main.querySelector('#rf-paid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b) return;
      paid = b.dataset.v;
      main.querySelectorAll('#rf-paid button').forEach((x) => x.classList.toggle('on', x === b));
    });
    main.querySelector('#rf-add-prod').addEventListener('click', () => main.querySelector('#rf-products').insertAdjacentHTML('beforeend', productRow({ quantity: '1' })));
    main.querySelector('#rf-products').addEventListener('click', (e) => { if ('rm' in e.target.dataset) e.target.closest('.prod-row').remove(); });
    const split = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const LABEL = { start_date: '출장 시작일', end_date: '출장 종료일', requester: '요청처', author: '작성자', region: '시·도', district: '시·군', paid_type: '비용청구',
      products: '제품', parts: '교체 부품', companions: '동행자' };
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(f));
      const body = {
        ...fd, district: districtSel.disabled ? '' : districtSel.value, paid_type: paid, companions: split(fd.companions), parts: split(fd.parts),
        products: [...main.querySelectorAll('.prod-row')].map((row) => Object.fromEntries([...row.querySelectorAll('[data-p]')].map((i) => [i.dataset.p, i.value]))),
        allow_duplicate: main.querySelector('#rf-dup').checked,
      };
      const msg = main.querySelector('#rf-msg');
      try {
        const r = await api('/api/service/reports', { method: 'POST', body });
        toast(`${r.start_date} ${r.requester} 출장보고서를 저장했습니다.`);
        location.hash = '#/service/reports';
      } catch (err) {
        if (err.status === 409) main.querySelector('#rf-dup-wrap').hidden = false;
        const fields = err.data?.fields;
        msg.innerHTML = `<div class="notice ${err.status === 409 ? 'warn' : 'err'}" style="margin:14px 0 0"><b>${esc(err.message)}</b>
          ${fields ? `<ul>${Object.entries(fields).map(([k, v]) => `<li>${esc(LABEL[k] || k)}: ${esc(v)}</li>`).join('')}</ul>` : ''}
          ${err.data?.existing ? `<ul>${err.data.existing.map((x) => `<li>${esc(x.start_date)} ${esc(x.requester)} (작성 ${esc(x.author)})</li>`).join('')}</ul>` : ''}</div>`;
      }
    });
  },
};
