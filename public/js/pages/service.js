// 서비스팀 화면 (ITB2026에서 옮겨 옴)
//  대시보드: 출장 실적(횟수·유상/무상·월별) · 출장지 지도와 지역 순위(시·도/시·군) · 교체 부품 · A/S 모델 · 담당자
//  출장보고서 목록·상세 / 서비스 데이터 업로드(엑셀)
import { api, esc } from '../core.js';
import { donut, countStack, SERIES, OTHER, hideTooltip } from '../charts.js';
import { koreaMap, hideMapTip, mapKey } from '../korea-map.js';
import { DISTRICT_POINTS } from '../regions.js';
import { periodDownloadButton, bindPeriodDownload, downloadFrom, downloadPdf, fileSafe, stamp, addCardMenus, bindCardMenus } from '../exporter.js';
import { prodPeriod, periodQS, periodSelector, dlPeriod, dash, openSerial } from './prod-common.js';
import { mountUpload } from './team-upload.js';

const PAID_COLORS = { 유상: SERIES[0], 무상: SERIES[2] };
const paidColor = (n) => PAID_COLORS[n] || OTHER;
const cnt = (v) => `${Number(v).toLocaleString('ko-KR')}회`;
const wonText = (v) => (v === null || v === undefined ? '-' : `${Number(v).toLocaleString('ko-KR')}원`);
const PERSON_TOP = 5;

// 순위 막대표. keyOf를 주면 줄마다 data-key(지도 원과 같은 값), hollow(r)이면 이름 앞에 빈 원 표시
function hbars(rows, unit, { limit = 10, keyOf = null, hollow = () => false } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.quantity));
  const total = rows.reduce((a, r) => a + r.quantity, 0);
  return `<table class="tbl rank static"><tbody>${rows.slice(0, limit).map((r) => `<tr${keyOf ? ` data-key="${esc(keyOf(r))}"` : ''}>
    <td class="nm" title="${esc(r.name)}">${hollow(r) ? '<i class="hollow-mark" title="시·군 없이 시·도 위치에 표시"></i>' : ''}${esc(r.name)}</td><td class="bar"><span style="width:${r.quantity / max * 100}%;background:${SERIES[0]}"></span></td>
    <td class="r num"><b>${r.quantity}${unit}</b></td><td class="r muted">${total ? Math.round(r.quantity / total * 1000) / 10 : 0}%</td></tr>`).join('') || '<tr><td class="muted">데이터가 없습니다.</td></tr>'}</tbody></table>
    ${rows.length > limit ? `<p class="hint" style="margin:6px 0 0">상위 ${limit}개 (전체 ${rows.length}개)</p>` : ''}`;
}

// 지도 글자용 짧은 이름: 시·도별은 시·도, 시·군별은 시·군 (고성군처럼 두 도에 있는 이름만 "경남 고성군")
const DUP_DISTRICTS = (() => {
  const seen = {};
  Object.values(DISTRICT_POINTS).forEach((m) => Object.keys(m).forEach((d) => { seen[d] = (seen[d] || 0) + 1; }));
  return new Set(Object.keys(seen).filter((d) => seen[d] > 1));
})();
const mapShortName = (i) => (!i.district ? (i.region || i.name) : DUP_DISTRICTS.has(i.district) ? i.name : i.district);

export async function render(main) {
  let level = 'region';
  let data = null;
  const charts = [];
  const destroy = () => { while (charts.length) charts.pop().destroy(); hideTooltip(); hideMapTip(); };

  main.innerHTML = `
    <div class="page-head">
      <div><h2>서비스팀 대시보드</h2><div class="sub">출장보고서 기준 · 출장 시작일로 기간에 넣음 (여러 날 출장도 1회)</div></div>
      <div class="filters"><div id="sv-period"></div>
        <button type="button" class="btn" id="sv-pdf" title="대시보드 전체를 PDF로 저장">⬇ PDF로 저장</button>${periodDownloadButton('sv-dl')}</div>
    </div>
    <div id="sv-body"><div class="empty">불러오는 중…</div></div>`;
  main.querySelector('#sv-pdf').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await downloadPdf(main.querySelector('#sv-body'), fileSafe(`서비스팀_대시보드_${data?.period.label || ''}_${stamp()}`), { maxPages: 2 });
    e.target.disabled = false;
  });

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
    const regionTotal = regionItems.reduce((a, r) => a + r.quantity, 0);
    const modelMax = Math.max(1, ...s.by_model.map((m) => m.quantity));
    const ag = s.as_age;

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
            <div class="diff-legend"><span class="muted">${data.period.end.slice(0, 4)}년 월별 출장 횟수 (선택한 기간은 진하게)</span>
              ${['유상', '무상'].map((n) => `<span><i style="background:${paidColor(n)}"></i>${n}</span>`).join('')}</div>
            <div class="chart-box" style="height:250px"><canvas id="sv-monthly"></canvas></div>
          </div>
        </div>
      </div>
      <div class="split2" style="margin-bottom:18px">
        <div class="card" data-card="map">
          <div class="card-head"><div class="ttl"><h3>출장지 지도</h3><span class="hint">${level === 'region' ? '시·도' : '시·군'} 기준 · 상위 지역은 이름·횟수·비중을 바로 표시</span></div>
            <div class="seg sm" id="sv-level">${[['region', '시·도별'], ['district', '시·군별']].map(([v, l]) => `<button type="button" data-l="${v}" class="${level === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          <div class="map-caption"><span>원 크기 = 출장 횟수 · 비율 = 전체 ${regionTotal.toLocaleString('ko-KR')}회 대비</span><span>마우스를 올리면 횟수·비중</span>
            ${level === 'district' ? '<span><i class="hollow-mark"></i>시·군 없이 시·도 위치에 표시 (특별·광역시·세종시, 시·군 미지정)</span>' : ''}</div>
          <div id="sv-map" class="map-wrap"></div>
        </div>
        <div class="card" data-card="regions">
          <div class="card-head"><div class="ttl"><h3>지역별 출장 순위</h3><span class="hint">${level === 'region' ? '시·도별' : '시·군별'}</span></div></div>
          <div id="sv-rank">${hbars(regionItems, '회', { limit: 17, keyOf: mapKey, hollow: (r) => level === 'district' && !r.district })}</div>
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
      </div>
      <div class="card" style="margin-top:18px" data-card="asage">
        <div class="card-head"><div class="ttl"><h3>A/S 제품 출고 후 경과 기간</h3><span class="hint">이 기간 "수리" 출장의 제품을 일련번호로 제조내역과 이어, 출고(없으면 제조) 후 몇 년 만에 A/S를 받았는지</span></div></div>
        ${!ag.total ? '<div class="empty">이 기간 수리 출장이 없습니다.</div>' : `
        <div class="kv-row" style="margin-bottom:12px"><span>수리 출장 제품 <b class="big">${ag.total}</b>대</span><span>제조내역과 연결 ${ag.linked}대</span>
          ${ag.median_text ? `<span>가운데 값 <b>출고 후 ${esc(ag.median_text)}</b></span>` : ''}</div>
        <div class="split2 tight">
          <div><div class="sub-ttl">출고 후 경과 (연결된 ${ag.linked}대)</div>${hbars(ag.buckets, '대', { limit: 4 })}</div>
          <div><div class="sub-ttl">연결 안 됨 (${ag.total - ag.linked}대)</div>${hbars(ag.unlinked.filter((x) => x.quantity), '대', { limit: 3 })}</div>
        </div>`}
      </div>`;

    addCardMenus(main.querySelector('#sv-body'));
    charts.push(donut(main.querySelector('#sv-paid'), main.querySelector('#sv-paid-legend'), s.paid.map((p) => ({ label: p.name, value: p.quantity })), paidColor, { fmt: cnt }));
    const hl = data.period.yms.filter((v) => v.startsWith(data.period.end.slice(0, 4))).map((v) => Number(v.slice(5)) - 1);
    charts.push(countStack(main.querySelector('#sv-monthly'), s.monthly.map((m) => `${m.month}월`), [
      { label: '유상', data: s.monthly.map((m) => m.paid), color: paidColor('유상') },
      { label: '무상', data: s.monthly.map((m) => m.unpaid), color: paidColor('무상') },
    ], { highlight: hl }));
    if (persons.length) charts.push(donut(main.querySelector('#sv-person'), main.querySelector('#sv-person-legend'), persons, personColor, { fmt: cnt }));
    // 지도를 못 불러와도 나머지 화면은 그대로 보이게
    try {
      // 지도 원 ↔ 순위표 줄: 한쪽에 마우스를 올리면 다른 쪽도 강조
      const rank = main.querySelector('#sv-rank');
      const markRow = (key) => rank.querySelectorAll('tr[data-key]').forEach((tr) => tr.classList.toggle('hl', tr.dataset.key === key));
      const map = await koreaMap(main.querySelector('#sv-map'), regionItems, { small: level === 'district', shortName: mapShortName, onHover: markRow });
      rank.addEventListener('mouseover', (e) => { const tr = e.target.closest('tr[data-key]'); map.highlight(tr ? tr.dataset.key : null); markRow(tr ? tr.dataset.key : null); });
      rank.addEventListener('mouseleave', () => { map.highlight(null); markRow(null); });
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
        [`${data.period.end.slice(0, 4)}년 월별 출장`], ['월', '유상(회)', '무상(회)', '합계(회)'], ...s.monthly.map((m) => [`${m.month}월`, m.paid, m.unpaid, m.count])] };
      case 'map':
      case 'regions': return { name: `지역별출장_${lv}`, aoa: [[lv, '횟수(회)', '비중(%)'], ...share(level === 'region' ? s.by_region : s.by_district)] };
      case 'parts': return { name: '교체부품순위', aoa: [['부품명', '사용 횟수(회)', '현재 단가(원)', '직전 대비(원)', '직전 대비(%)'],
        ...s.by_part.map((p) => [p.name, p.quantity, p.current_price ?? '', p.change ?? '', p.change_rate ?? ''])] };
      case 'models': return { name: 'AS제품모델순위', aoa: [['모델', '유상(대)', '무상(대)', '합계(대)'], ...s.by_model.map((m) => [m.name, m.paid, m.unpaid, m.quantity])] };
      case 'persons': return { name: '출장담당자', aoa: [['담당자', '참여(회)', '비중(%)'], ...share(s.by_person)] };
      case 'asage': return { name: 'AS출고후경과', aoa: [['구분', '대수'], ...s.as_age.buckets.map((x) => [`출고 후 ${x.name}`, x.quantity]), ...s.as_age.unlinked.map((x) => [`연결 안 됨: ${x.name}`, x.quantity])] };
      default: return null;
    }
  }
  bindCardMenus(main, { getData: cardData, prefix: '서비스팀', label: () => data?.period.label || '' });

  bindPeriodDownload(main, 'sv-dl', {
    ...dlPeriod(), modes: ['year', 'quarter', 'month'], current: dlPeriod, currentYear: () => prodPeriod.year,
    hint: '고른 기간의 출장 실적·월별·지역·교체 부품·AS 모델·담당자·AS 출고 후 경과·출장보고서 목록을 시트별로 담습니다(CSV는 시트별 파일을 ZIP 하나로).',
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
    const canProd = ctx.can('production');
    // 제품 줄 아래: 제조내역 연결 정보 (요약은 누구나, 일련번호 조회 링크는 생산팀 열람 권한이 있을 때만)
    const mfgLine = (m) => {
      if (!m) return '';
      if (m.status === 'linked') {
        const sn = canProd ? `<a href="#/production/serials" data-serial="${esc(m.serial_full)}">일련번호 조회 →</a>` : '';
        return `<div class="mfg-link">제조 ${dash(m.manufactured_date)} · 출고 ${dash(m.shipped_date)} · ${dash(m.customer)}${m.project_name ? ` · ${esc(m.project_name)}` : ''}
          ${m.elapsed ? ` · <b>${esc(m.base_label)} 후 ${esc(m.elapsed)}</b>` : ''} ${sn}</div>`;
      }
      const t = { missing: '제조내역에 없는 일련번호', old: '구 버전 제품 (A 번호 — 제조내역 없음)', none: '' }[m.status];
      return t ? `<div class="mfg-link muted">${t}</div>` : '';
    };
    let list = null;
    let openId = null;
    main.innerHTML = `
      <div class="page-head">
        <div><h2>출장보고서 목록</h2><div class="sub">출장 시작일 기준 · 줄을 누르면 고장·작업 내용까지 상세</div></div>
        <div class="filters"><div id="rp-period"></div>${editable ? '<a class="btn primary" href="#/service/upload">서비스 데이터 업로드</a>' : ''}</div>
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
            <td>${esc(r.models.join(', ') || '-')}</td><td>${esc(r.author)}</td><td class="muted">${{ excel: '엑셀', csv: 'CSV', pdf: 'PDF', manual: '직접 입력' }[r.input_method] || esc(r.input_method)}</td></tr>`).join('')}</tbody>
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
              ${field('제품', r.products.map((p) => `<div class="prod-line">${esc(p.model_name)} × ${p.quantity}${p.spec ? ` <span class="muted">${esc(p.spec)}</span>` : ''}${p.serial_no_raw ? ` <span class="muted">S/N ${esc(p.serial_no_raw)}</span>` : ''}${mfgLine(p.mfg)}</div>`).join(''))}
              ${field('교체 부품', esc(r.parts.join(', ')))}${field('고장 내용', esc(r.fault_description))}${field('작업 내용', esc(r.work_description))}${field('작업 결과', esc(r.work_result))}
            </tbody></table>
          </div>
          <p class="hint" style="margin:10px 0 0">일련번호가 N·Q 등으로 시작하면 제조내역과 이어 제조일자·출고일과 출장 때까지 지난 기간을 보여 줍니다. A로 시작하는 번호는 구 버전 제품이라 제조내역에 없습니다.</p>
        </div>`;
      $('#rp-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#rp-detail').querySelectorAll('[data-serial]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openSerial(a.dataset.serial); }));
    }
    $('#rp-table').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) open(Number(tr.dataset.id)); });
    await periodSelector($('#rp-period'), load);
    await load();
    // 일련번호 조회의 A/S 이력에서 넘어온 경우 그 보고서를 바로 연다
    let pending = null;
    try { pending = sessionStorage.getItem('openTripReport'); sessionStorage.removeItem('openTripReport'); } catch { /* 무시 */ }
    if (pending) await open(Number(pending));
  },
};

// ---------------- 서비스 데이터 업로드: 엑셀 (서비스팀 수정 권한) ----------------
export const dataUpload = {
  async render(main) {
    main.innerHTML = `
      <div class="page-head">
        <div><h2>서비스 데이터 업로드</h2><div class="sub">서비스 데이터 엑셀(서비스데이터_YYYYMM.xlsx)을 올리면 출장보고서로 읽어 확인 화면에 보여 줍니다. 같은 ID가 이미 있으면 새 내용으로 덮어씁니다.</div></div>
        <div class="filters"><a class="btn" href="#/service/reports">출장보고서 목록</a><a class="btn" href="#/service/uploads">업로드 이력</a></div>
      </div>
      <div id="sd-upload"></div>`;
    mountUpload(main.querySelector('#sd-upload'), 'service_excel');
  },
};
