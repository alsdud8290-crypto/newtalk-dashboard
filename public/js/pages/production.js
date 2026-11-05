// 생산팀 대시보드 (ITB2026에서 옮겨 옴): 납기 임박(오늘 기준) + 생산 실적(목표 대비·비교) + 납기·출고 + 판매 실적
import { api, esc, toast } from '../core.js';
import { gauge, prodBars, donut, SERIES, OTHER, INDUSTRY_COLORS, ORDER_LINE, hideTooltip } from '../charts.js';
import { periodDownloadButton, bindPeriodDownload, downloadFrom, downloadPdf, fileSafe, stamp, addCardMenus, bindCardMenus } from '../exporter.js';
import { prodPeriod, setProdPeriod, periodQS, periodSelector, dlPeriod, statusChip, dDayChip, orderLabel, qty, dash } from './prod-common.js';

const store = (key, def) => { try { return { ...def, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return { ...def }; } };
const save = (key, v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* 무시 */ } };
const signed = (n) => (n > 0 ? `▲ ${n.toLocaleString('ko-KR')}` : n < 0 ? `▼ ${(-n).toLocaleString('ko-KR')}` : '변동 없음');
const fmt1 = (v) => Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 1 });
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const COMPARES = [['none', '비교 안 함'], ['previous', '직전 기간'], ['last_year', '전년 동기']];

export async function render(main, ctx) {
  const editable = ctx.canEdit('production');
  const view = store('production.dashboard.view', { compare: 'none', showOrders: true, barUnit: 'month' });
  const charts = [];
  const destroy = () => { while (charts.length) charts.pop().destroy(); hideTooltip(); };
  let data = null;
  let soon = null;
  let salesData = null;

  main.innerHTML = `
    <div class="page-head">
      <div><h2>생산팀 대시보드</h2><div class="sub">생산 실적(제조년월 기준) · 납기·출고 · 판매 실적(수주서 제품 수량)</div></div>
      <div class="filters"><div id="pd-period"></div>
        <button type="button" class="btn" id="pd-pdf" title="대시보드 전체를 PDF로 저장">⬇ PDF로 저장</button>${periodDownloadButton('pd-dl')}</div>
    </div>
    <div id="pd-export">
      <div id="pd-soon"></div>
      <div id="pd-body"><div class="empty">불러오는 중…</div></div>
      <div id="pd-sales"></div>
    </div>`;
  main.querySelector('#pd-pdf').addEventListener('click', async (e) => {
    e.target.disabled = true;
    // 다른 대시보드와 같이 화면 그대로 A4 1~2쪽 (긴 표 전체는 카드별 ⬇ → PDF)
    await downloadPdf(main.querySelector('#pd-export'), fileSafe(`생산팀_대시보드_${data?.period.label || ''}_${stamp()}`), { maxPages: 2 });
    e.target.disabled = false;
  });

  // ---------- 납기 임박 (기간 선택과 관계없이 오늘 기준) ----------
  api('/api/production/due-soon').then((d) => {
    soon = d;
    main.querySelector('#pd-soon').innerHTML = `
      <div class="card" style="margin-bottom:18px" data-card="soon">
        <div class="card-head"><div class="ttl"><h3>납기 임박</h3><span class="hint">오늘부터 ${d.days}일 안 + 납기 지남, 출고가 끝나지 않은 수주 ${d.items.length}건</span></div>
          <a class="btn sm" href="#/production/calendar">납기 캘린더 →</a></div>
        ${!d.items.length ? `<div class="empty" style="padding:18px">${d.days}일 안에 납기가 돌아오는 미출고 수주가 없습니다.</div>` : `
        <div class="table-wrap" style="max-height:280px"><table class="tbl">
          <thead><tr><th>D-day</th><th>납기일</th><th>수주번호</th><th>판매처</th><th>사업명</th><th class="r">출고 / 대수</th><th>상태</th></tr></thead>
          <tbody>${d.items.map((o) => `<tr>
            <td>${dDayChip(o.d_day)}</td><td><a href="#/production/calendar" data-date="${o.due_date}">${o.due_date}</a></td><td>${orderLabel(o)}</td>
            <td>${dash(o.customers.join(', '))}</td><td>${dash(o.projects.join(', '))}</td><td class="r num">${o.shipped} / ${qty(o.quantity)}</td><td>${statusChip(o)}</td></tr>`).join('')}</tbody>
        </table></div>`}
      </div>`;
    addCardMenus(main.querySelector('#pd-soon'));
    main.querySelector('#pd-soon').addEventListener('click', (e) => { const a = e.target.closest('[data-date]'); if (a) sessionStorage.setItem('calendarDate', a.dataset.date); });
  }).catch((e) => { main.querySelector('#pd-soon').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; });

  async function load() {
    try {
      data = await api(`/api/production/dashboard?${periodQS()}&compare=${view.compare}`);
      draw();
    } catch (e) { main.querySelector('#pd-body').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
    loadSales();
  }

  // 모델 색: 전체 모델명 목록(가나다순) 순서로 고정 → 기간이 바뀌어도 같은 모델은 같은 색
  const modelColor = (name) => { const i = data.model_names.indexOf(name); return i === -1 || i >= SERIES.length ? OTHER : SERIES[i]; };

  function barsData() {
    const months = data.monthly.months;
    // 막대 그래프는 기간이 끝나는 해 1~12월 → 그 해에 든 달만 진하게
    const sel = data.period.yms.filter((v) => v.startsWith(data.period.end.slice(0, 4))).map((v) => Number(v.slice(5)));
    const thisYear = Number(data.period.end.slice(0, 4)) === new Date().getFullYear();
    const thisMonth = new Date().getMonth() + 1;
    if (view.barUnit === 'month') {
      return months.map((m) => ({ value: m.month, label: `${m.month}월`, actual: m.actual, orders: m.orders, lastYear: m.last_year, selected: sel.includes(m.month), inProgress: thisYear && m.month === thisMonth }));
    }
    return [1, 2, 3, 4].map((q) => {
      const qm = [q * 3 - 2, q * 3 - 1, q * 3];
      const sum = (k) => months.filter((m) => qm.includes(m.month)).reduce((a, m) => a + (m[k] ?? 0), 0);
      return { value: q, label: `${q}분기`, actual: sum('actual'), orders: sum('orders'), lastYear: sum('last_year'), selected: qm.some((m) => sel.includes(m)), inProgress: thisYear && qm.includes(thisMonth) };
    });
  }
  // 분기 목표 = 연간 ÷ 4 (= 연간 ÷ 12 × 3, 같은 임시 기준)
  const barTarget = () => (view.barUnit === 'month' ? data.monthly.monthly_target : (data.production.annual_target ? Math.round(data.production.annual_target / 4 * 10) / 10 : null));

  function draw() {
    destroy();
    const pr = data.production;
    const hasTarget = pr.period_target !== null && pr.period_target > 0;
    const over = hasTarget ? Math.max(pr.actual - pr.period_target, 0) : 0;
    const t = todayIso();
    const inProgress = data.period.start <= t && t <= data.period.end;
    const yp = data.year_progress;
    const ypRate = yp.annual_target ? Math.round(yp.cumulative / yp.annual_target * 1000) / 10 : 0;
    const dl = data.delivery;
    const un = data.unshipped;
    const maxBucket = Math.max(1, ...un.buckets.map((b) => b.count));
    const unitName = view.barUnit === 'month' ? '달' : '분기';
    const targetName = view.barUnit === 'month' ? '월 목표' : '분기 목표';
    const bt = barTarget();
    main.querySelector('#pd-body').innerHTML = `
      <div class="card" style="margin-bottom:18px" data-card="production">
        <div class="card-head">
          <div class="ttl"><h3>${esc(data.period.label)} 생산 실적</h3></div>
          <div class="filters">
            <label>비교 <select class="input" id="pd-compare">${COMPARES.map(([v, l]) => `<option value="${v}" ${view.compare === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <span id="pd-target"></span>
          </div>
        </div>
        <div class="prod-grid">
          <div>
            <div class="ring-row">
              <div class="gauge-box"><canvas id="pd-gauge"></canvas>
                <div class="gauge-center">${hasTarget ? `<b>${pr.achievement_rate}<small>%</small></b><span>달성률</span>` : '<span>목표 없음</span>'}</div></div>
              <div class="kv-col">
                <div><span>생산량</span><b>${qty(pr.actual)}</b></div>
                <div><span>기간 목표</span><b>${hasTarget ? `${fmt1(pr.period_target)}대` : '-'}</b></div>
                <div><span>${over ? '목표 초과' : '부족치'}</span><b class="${over ? 'good' : pr.shortfall ? 'bad' : ''}">${hasTarget ? `${fmt1(over || pr.shortfall)}대` : '-'}</b></div>
              </div>
            </div>
            ${data.compare ? `<p class="hint" style="margin:14px 0 0">${esc(data.compare.label)} ${qty(data.compare.actual)} 대비 <b>${signed(data.compare.change)}대</b>
              ${data.compare.change_rate !== null ? `<span class="muted">(${data.compare.change_rate > 0 ? '+' : ''}${data.compare.change_rate}%)</span>` : ''}
              ${inProgress ? '<br><span class="muted">이번 기간은 아직 진행 중이라 끝난 기간보다 적게 보일 수 있습니다.</span>' : ''}</p>` : ''}
          </div>
          <div>
            <div class="filters" style="margin-bottom:6px">
              <div class="seg sm" id="pd-unit">${[['month', '월별'], ['quarter', '분기별']].map(([v, l]) => `<button type="button" data-u="${v}" class="${view.barUnit === v ? 'on' : ''}">${l}</button>`).join('')}</div>
              <span class="diff-legend" style="margin:0">
                <span><i style="background:${SERIES[0]}"></i>생산량</span>
                ${bt !== null ? `<span><i class="dash-line"></i>${targetName} ${fmt1(bt)}대</span>` : ''}
                ${view.compare !== 'none' ? `<span><i class="ghost"></i>전년 같은 ${unitName}</span>` : ''}
                <label class="chk"><input type="checkbox" id="pd-orders" ${view.showOrders ? 'checked' : ''}><i class="line" style="border-color:${ORDER_LINE}"></i>수주량</label>
              </span>
            </div>
            <div class="chart-box" style="height:250px"><canvas id="pd-bars"></canvas></div>
            <p class="hint" style="margin:4px 0 0">${data.period.end.slice(0, 4)}년 · 선택한 기간은 진하게, 막대를 누르면 그 기간 제조내역 목록</p>
          </div>
        </div>
        ${pr.annual_target === null ? '<div class="notice warn" style="margin:14px 0 0">연간 목표 생산량이 없어 달성률·부족치를 계산할 수 없습니다.</div>' : ''}
        <p class="hint" style="margin:12px 0 0">※ 당월·분기 목표는 "연간 목표 ÷ 12 × 개월 수"로 나눈 임시 기준입니다 (기업 확인 필요).
          수주량 = 그 달 납기일인 수주서 제품 수량. 일련번호로 잇지 않고 월 합계만 비교합니다.</p>
        <div class="split2" style="margin-top:18px;padding-top:18px;border-top:1px solid var(--border)">
          <div>
            <div class="sub-ttl">${yp.year}년 연간 목표 진행 ${yp.as_of ? `<span class="muted">· ${yp.as_of}까지</span>` : ''}</div>
            ${yp.annual_target ? `
              <div class="kv-row" style="justify-content:space-between"><span>누적 <b>${qty(yp.cumulative)}</b> / ${qty(yp.annual_target)}</span><span>${ypRate}%</span></div>
              <div class="progress"><span style="width:${Math.min(ypRate, 100)}%"></span></div>
              <p class="hint" style="margin:8px 0 0">${yp.remaining === 0 ? `✓ 연간 목표를 달성했습니다 (초과 ${qty(yp.cumulative - yp.annual_target)}).`
                : yp.remaining_months ? `목표까지 <b>${qty(yp.remaining)}</b> 남음 · 남은 ${yp.remaining_months}개월(이번 달 포함) 동안 <b>월 평균 ${fmt1(yp.required_per_month)}대</b> 필요`
                  : `목표보다 ${qty(yp.remaining)} 부족하게 마감`}</p>
              ${yp.forecast !== null ? `<div class="forecast">연말 예상 생산량 <b>${qty(yp.forecast)}</b> <span class="badge">예측</span>
                <span class="muted">· 1월 1일부터 오늘까지의 속도가 이어진다고 가정 (목표 대비 ${Math.round(yp.forecast / yp.annual_target * 1000) / 10}%)</span></div>` : ''}`
              : '<p class="hint">연간 목표 생산량이 없습니다.</p>'}
          </div>
          <div>
            <div class="sub-ttl">${esc(data.period.label)} 모델별 생산 <span class="muted">· 누르면 그 모델 목록</span></div>
            ${data.by_model.length ? '<div class="donut-row"><div class="donut-box small"><canvas id="pd-model"></canvas></div><div class="legend" id="pd-model-legend"></div></div>' : '<div class="empty">이 기간 생산 기록이 없습니다.</div>'}
          </div>
        </div>
      </div>

      <div class="split2" style="margin-bottom:18px">
        <div class="card" data-card="delivery">
          <div class="card-head"><div class="ttl"><h3>${esc(data.period.label)} 납기 준수율</h3><span class="hint">납기일이 이 기간에 있고 이미 지난 제품</span></div></div>
          ${!dl.total ? `<div class="empty">아직 납기가 온 제품이 없습니다${dl.not_due_yet ? ` (납기 전 ${dl.not_due_yet}대)` : ''}.</div>` : `
          <div class="kv-row"><span>준수율 <b class="big">${dl.rate}%</b></span><span>대상 ${qty(dl.total)}</span>${dl.avg_delay_days !== null ? `<span>평균 지연 ${dl.avg_delay_days}일</span>` : ''}${dl.not_due_yet ? `<span class="muted">납기 전 ${dl.not_due_yet}대 제외</span>` : ''}</div>
          <div class="stackbar">${[['on_time', '기한 내 출고', 'good'], ['late', '늦게 출고', 'warning'], ['open', '미출고(납기 지남)', 'critical']]
            .map(([k, l, c]) => (dl[k] ? `<span class="${c}" style="width:${dl[k] / dl.total * 100}%" title="${l} ${dl[k]}대"></span>` : '')).join('')}</div>
          <div class="kv-row small">${[['on_time', '✓ 기한 내 출고'], ['late', '◐ 늦게 출고'], ['open', '! 미출고(납기 지남)']].map(([k, l]) => `<span>${l} <b>${dl[k]}</b>대</span>`).join('')}</div>
          <div class="split2 tight" style="margin-top:14px">
            ${[['by_model', '모델별'], ['by_customer', '거래처별']].map(([k, l]) => `<div><div class="sub-ttl">${l} 준수율 낮은 순</div>
              <table class="tbl mini"><tbody>${dl[k].filter((r) => r.total).slice(0, 5).map((r) => `<tr><td>${esc(r.name)}</td><td class="r">${r.rate === null ? '-' : `${r.rate}%`}</td><td class="r muted">${r.on_time}/${r.total}대</td></tr>`).join('')}</tbody></table></div>`).join('')}
          </div>`}
        </div>
        <div class="card" data-card="unshipped">
          <div class="card-head"><div class="ttl"><h3>미출고 현황</h3><span class="hint">오늘(${un.as_of}) 기준 · 제조됐고 출고일이 없는 제품 ${qty(un.total)}</span></div></div>
          ${!un.total ? '<div class="empty">미출고 제품이 없습니다.</div>' : `
          <div class="buckets">${un.buckets.map((b) => `<div><span>${b.label}</span><div class="bar"><i style="width:${b.count / maxBucket * 100}%"></i></div><b>${qty(b.count)}</b></div>`).join('')}</div>
          <div class="sub-ttl" style="margin-top:14px">가장 오래된 미출고 5건 <span class="muted">· 누르면 일련번호 상세</span></div>
          <table class="tbl mini"><tbody>${un.oldest.map((r) => `<tr><td><a href="#/production/serials" data-serial="${esc(r.serial_full)}"><b>${esc(r.serial_full)}</b></a></td><td>${esc(r.model_name || '-')}</td>
            <td class="muted">${esc(r.manufactured_date)} 제조</td><td class="r">${r.days}일</td></tr>`).join('')}</tbody></table>
          <div class="kv-row small" style="margin-top:10px">${un.by_model.slice(0, 6).map((m) => `<span>${esc(m.name)} <b>${m.quantity}</b></span>`).join('')}</div>`}
        </div>
      </div>`;

    addCardMenus(main.querySelector('#pd-body'));
    // 그래프
    if (hasTarget) charts.push(gauge(main.querySelector('#pd-gauge'), pr.actual, pr.period_target, { fmt: (v) => `${fmt1(v)}대` }));
    else charts.push(gauge(main.querySelector('#pd-gauge'), 0, 0));
    charts.push(prodBars(main.querySelector('#pd-bars'), barsData(), {
      target: bt, targetName, unitName, showOrders: view.showOrders, showLastYear: view.compare !== 'none',
      onSelect: (v) => { setProdPeriod({ year: Number(data.period.end.slice(0, 4)), ...(view.barUnit === 'month' ? { kind: 'month', month: v } : { kind: 'quarter', quarter: v }) }); location.hash = '#/production/records'; },
    }));
    if (data.by_model.length) {
      charts.push(donut(main.querySelector('#pd-model'), main.querySelector('#pd-model-legend'), data.by_model.map((m) => ({ label: m.name, value: m.quantity })), modelColor,
        { fmt: qty, onSelect: (m) => { sessionStorage.setItem('recordsModel', m); location.hash = '#/production/records'; } }));
    }

    // 목표 생산량 (모두 볼 수 있고, 수정 권한자만 [목표 수정])
    const tslot = main.querySelector('#pd-target');
    const drawTarget = (editing) => {
      const t0 = data.production.annual_target;
      tslot.innerHTML = editing
        ? `<form class="filters" id="pd-tform"><span class="hint">${data.period.end.slice(0, 4)}년 연간 목표</span><input class="input" name="v" type="number" min="0" required value="${t0 ?? ''}" style="width:110px"><button class="btn primary sm">저장</button><button type="button" class="btn sm" id="pd-tcancel">취소</button></form>`
        : `<span class="hint">${data.period.end.slice(0, 4)}년 연간 목표 생산량 <b>${t0 === null ? '미입력' : qty(t0)}</b></span>${editable ? ` <button class="btn sm" id="pd-tedit">${t0 === null ? '목표 입력' : '목표 수정'}</button>` : ''}`;
      tslot.querySelector('#pd-tedit')?.addEventListener('click', () => drawTarget(true));
      tslot.querySelector('#pd-tcancel')?.addEventListener('click', () => drawTarget(false));
      tslot.querySelector('#pd-tform')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(`/api/production/targets/${data.period.end.slice(0, 4)}`, { method: 'PUT', body: { target_quantity: e.target.v.value } });
          toast('연간 목표 생산량을 저장했습니다.');
          load();
        } catch (err) { toast(err.message, true); }
      });
    };
    drawTarget(false);

    main.querySelector('#pd-compare').addEventListener('change', (e) => { view.compare = e.target.value; save('production.dashboard.view', view); load(); });
    main.querySelector('#pd-unit').addEventListener('click', (e) => { const b = e.target.closest('[data-u]'); if (b) { view.barUnit = b.dataset.u; save('production.dashboard.view', view); draw(); } });
    main.querySelector('#pd-orders').addEventListener('change', (e) => { view.showOrders = e.target.checked; save('production.dashboard.view', view); draw(); });
    main.querySelector('#pd-body').addEventListener('click', (e) => { const a = e.target.closest('[data-serial]'); if (a) sessionStorage.setItem('serialQuery', a.dataset.serial); });
  }

  // ---------- 판매 실적: 직원이 기준을 바꿔 보는 화면 ----------
  const OPTIONS = {
    date_basis: ['기준 날짜', [['due', '납기일'], ['order', '수주일'], ['delivery', '납품일']]],
    customer_basis: ['거래처', [['customer', '판매처'], ['final_orderer', '최종발주처']]],
    product_group: ['제품 묶음', [['name', '품명 그대로'], ['model', '모델별'], ['size', '구경별'], ['type', '종류별']]],
    compare: ['비교', COMPARES],
  };
  const settings = store('production.sales.settings', { date_basis: 'due', customer_basis: 'customer', product_group: 'name', compare: 'none' });
  const filters = { industry: '', customer: '', product: '' };
  const FILTER_NAMES = { industry: '산업 분야', customer: '거래처', product: '제품' };
  let salesSeq = 0;

  async function loadSales() {
    const seq = ++salesSeq;
    const qs = new URLSearchParams({ ...settings, ...filters });
    try {
      const d = await api(`/api/production/sales?${periodQS()}&${qs}`);
      if (seq === salesSeq) drawSales(d);
    } catch (e) { main.querySelector('#pd-sales').innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  }

  function ranking(key, rows, total, colorOf) {
    const max = Math.max(1, ...rows.map((r) => r.quantity));
    return `<table class="tbl rank"><tbody>${rows.map((r) => `
      <tr data-f="${key}" data-v="${esc(r.name)}" class="${filters[key] === r.name ? 'sel' : ''}">
        <td class="nm"><i style="background:${colorOf ? colorOf(r.name) : SERIES[0]}"></i>${esc(r.name)}</td>
        <td class="bar"><span style="width:${r.quantity / max * 100}%;background:${colorOf ? colorOf(r.name) : SERIES[0]}"></span></td>
        <td class="r num"><b>${qty(r.quantity)}</b></td><td class="r muted">${total ? Math.round(r.quantity / total * 1000) / 10 : 0}%</td>
        ${r.change !== null ? `<td class="r ${r.change > 0 ? 'up' : r.change < 0 ? 'down' : 'muted'}">${r.change > 0 ? '▲' : r.change < 0 ? '▼' : '–'} ${Math.abs(r.change) || ''}</td>` : ''}
      </tr>`).join('') || '<tr><td class="muted">데이터 없음</td></tr>'}</tbody></table>`;
  }

  function drawSales(d) {
    salesData = d;
    const s = d.sales;
    const industryColor = (n) => INDUSTRY_COLORS[n] || OTHER;
    const sum = (rows) => rows.reduce((a, r) => a + r.quantity, 0);
    const active = Object.entries(filters).filter(([, v]) => v);
    const el = main.querySelector('#pd-sales');
    if (el.__chart) { el.__chart.destroy(); el.__chart = null; }
    el.innerHTML = `
      <div class="card" data-card="sales">
        <div class="card-head"><div class="ttl"><h3>${esc(d.period.label)} 판매 실적</h3><span class="hint">수주서 제품 수량 · 항목을 누르면 나머지 순위가 그 조건으로 좁혀집니다</span></div></div>
        <div class="filters" style="margin-bottom:12px">
          ${Object.entries(OPTIONS).map(([k, [l, ch]]) => `<label>${l} <select class="input" data-opt="${k}">${ch.map(([v, t]) => `<option value="${v}" ${settings[k] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`).join('')}
        </div>
        ${active.length ? `<div class="notice" style="margin-bottom:12px">걸러 보는 중: ${active.map(([k, v]) => `<b>${FILTER_NAMES[k]} = ${esc(v)}</b> <button class="btn sm" data-clear="${k}">✕</button>`).join(' ')} <button class="btn sm" data-clear="all">모두 풀기</button></div>` : ''}
        <div class="kv-row" style="margin-bottom:14px"><span>판매량 합계 <b class="big">${qty(s.total)}</b></span>
          ${s.compare ? `<span>${esc(s.compare.label)} ${qty(s.compare.total)} 대비 <b>${signed(s.compare.change)}대</b></span>` : ''}
          ${s.missing_date_orders ? `<span class="muted">고른 기준 날짜가 비어 있는 수주서 ${s.missing_date_orders}건은 빠짐</span>` : ''}</div>
        <div class="split3">
          <div><div class="sub-ttl">산업 분야</div>
            ${s.by_industry.length ? '<div class="donut-box small" style="margin:0 auto 10px"><canvas id="ps-ind"></canvas></div>' : ''}
            ${ranking('industry', s.by_industry, sum(s.by_industry), industryColor)}</div>
          <div><div class="sub-ttl">거래처 (${settings.customer_basis === 'customer' ? '판매처' : '최종발주처'})</div>${ranking('customer', s.by_customer, sum(s.by_customer))}</div>
          <div><div class="sub-ttl">제품 (${OPTIONS.product_group[1].find(([v]) => v === settings.product_group)[1]})</div>${ranking('product', s.by_product, sum(s.by_product))}</div>
        </div>
        <p class="hint" style="margin:12px 0 0">거래처·제품은 개수가 정해져 있지 않아 원형 그래프 대신 순위 막대와 비중(%)으로 보여 줍니다. ▲▼는 비교 기간 대비 증감입니다.</p>
      </div>`;
    addCardMenus(el);
    if (s.by_industry.length) el.__chart = donut(el.querySelector('#ps-ind'), null, s.by_industry.map((r) => ({ label: r.name, value: r.quantity })), industryColor, { fmt: qty, onSelect: (v) => toggleFilter('industry', v) });
    el.querySelectorAll('[data-opt]').forEach((sel) => sel.addEventListener('change', () => {
      settings[sel.dataset.opt] = sel.value;
      // 기준이 바뀌면 같은 이름이 다른 뜻이 되므로 그 필터는 푼다
      if (sel.dataset.opt === 'customer_basis') filters.customer = '';
      if (sel.dataset.opt === 'product_group') filters.product = '';
      save('production.sales.settings', settings);
      loadSales();
    }));
    el.onclick = (e) => {
      const c = e.target.closest('[data-clear]');
      if (c) { if (c.dataset.clear === 'all') Object.keys(filters).forEach((k) => { filters[k] = ''; }); else filters[c.dataset.clear] = ''; loadSales(); return; }
      const tr = e.target.closest('tr[data-f]');
      if (tr) toggleFilter(tr.dataset.f, tr.dataset.v);
    };
  }
  const toggleFilter = (k, v) => { filters[k] = filters[k] === v ? '' : v; loadSales(); };

  // 카드별 [⬇] → PDF · 데이터(CSV). 표는 화면에 보이는 내용 그대로
  const rankRows = (rows) => { const total = rows.reduce((a, r) => a + r.quantity, 0); return rows.map((r) => [r.name, r.quantity, total ? Math.round(r.quantity / total * 1000) / 10 : 0, ...(r.change !== null && r.change !== undefined ? [r.change] : [])]); };
  const section = (title, head, rows) => [[title], head, ...rows, []];
  function cardData(key) {
    const label = data?.period.label || '';
    if (key === 'soon' && soon) {
      return { name: '납기임박', aoa: [['D-day', '납기일', '수주번호', '판매처', '사업명', '출고', '대수', '상태'],
        ...soon.items.map((o) => [o.d_day, o.due_date, o.po_no, o.customers.join(', '), o.projects.join(', '), o.shipped, o.quantity, o.overdue ? '납기 지남' : { done: '출고 완료', partial: '일부 출고', pending: '출고 전' }[o.status]])] };
    }
    if (!data) return null;
    if (key === 'production') {
      const pr = data.production;
      const yp = data.year_progress;
      const bars = barsData();
      return { name: '생산실적', aoa: [
        ...section(`${label} 생산 실적`, ['항목', '값'], [['생산량(대)', pr.actual], ['기간 목표(대)', pr.period_target ?? ''], ['달성률(%)', pr.achievement_rate ?? ''], ['부족치(대)', pr.shortfall ?? ''],
          ...(data.compare ? [[`${data.compare.label} 생산량(대)`, data.compare.actual], ['증감(대)', data.compare.change]] : [])]),
        ...section(`${data.period.end.slice(0, 4)}년 ${view.barUnit === 'month' ? '월별' : '분기별'} 생산`, [view.barUnit === 'month' ? '월' : '분기', '생산량(대)', '수주량(대)', view.barUnit === 'month' ? '월 목표(대)' : '분기 목표(대)', ...(view.compare !== 'none' ? ['전년(대)'] : [])],
          bars.map((b) => [b.label, b.actual, b.orders, barTarget() ?? '', ...(view.compare !== 'none' ? [b.lastYear ?? 0] : [])])),
        ...section(`${yp.year}년 연간 목표 진행`, ['항목', '값'], [['연간 목표(대)', yp.annual_target ?? ''], ['누적(대)', yp.cumulative], ['남은 양(대)', yp.remaining ?? ''], ['월 평균 필요(대)', yp.required_per_month ?? ''], ['연말 예상(대, 예측)', yp.forecast ?? '']]),
        ...section(`${label} 모델별 생산`, ['모델', '생산량(대)', '비중(%)'], rankRows(data.by_model)),
      ] };
    }
    if (key === 'delivery') {
      const dl = data.delivery;
      const head = ['이름', '준수율(%)', '기한 내 출고(대)', '늦게 출고(대)', '미출고·납기 지남(대)', '대상(대)'];
      const row = (r) => [r.name, r.rate ?? '', r.on_time, r.late, r.open, r.total];
      return { name: '납기준수율', aoa: [
        ...section(`${label} 납기 준수율`, head, [row({ ...dl, name: '전체' })]),
        ...section('모델별', head, dl.by_model.map(row)),
        ...section('거래처별', head, dl.by_customer.map(row)),
      ] };
    }
    if (key === 'unshipped') {
      const un = data.unshipped;
      return { name: '미출고현황', aoa: [
        ...section(`미출고 현황 (${un.as_of} 기준)`, ['경과', '대수'], un.buckets.map((b) => [b.label, b.count])),
        ...section('모델별', ['모델', '대수'], un.by_model.map((m) => [m.name, m.quantity])),
        ...section('가장 오래된 미출고', ['일련번호', '모델', '제조일', '경과일'], un.oldest.map((r) => [r.serial_full, r.model_name, r.manufactured_date, r.days])),
      ] };
    }
    if (key === 'sales' && salesData) {
      const s = salesData.sales;
      const head = (n) => [n, '수량(대)', '비중(%)', ...(s.compare ? ['증감(대)'] : [])];
      return { name: '판매실적', aoa: [
        ...section(`${salesData.period.label} 판매 실적 (합계 ${s.total}대)`, head('산업 분야'), rankRows(s.by_industry)),
        ...section('거래처', head('거래처'), rankRows(s.by_customer)),
        ...section('제품', head('제품'), rankRows(s.by_product)),
      ] };
    }
    return null;
  }
  bindCardMenus(main, { getData: cardData, prefix: '생산팀', label: () => data?.period.label || '' });

  const dashUrl = (period) => `/api/production/dashboard/export?period=${period}&${new URLSearchParams({ date_basis: settings.date_basis, customer_basis: settings.customer_basis, product_group: settings.product_group })}`;
  // 엑셀: 고른 기간의 생산 실적·납기·판매 실적(지금 고른 기준)·제조내역 (대시보드 전체 CSV 내려받기는 없앰 → [PDF로 저장])
  bindPeriodDownload(main, 'pd-dl', {
    ...dlPeriod(), modes: ['year', 'quarter', 'month'], current: dlPeriod, currentYear: () => prodPeriod.year,
    hint: '고른 기간의 생산 실적·납기 준수·판매 실적·제조내역을 엑셀 시트별로 담습니다. 미출고는 오늘 기준입니다. 화면 그대로는 [PDF로 저장]을 쓰세요.',
    onExcel: (period) => downloadFrom(dashUrl(period)),
  });
  await periodSelector(main.querySelector('#pd-period'), load);
  await load();
  return () => { destroy(); const el = main.querySelector('#pd-sales'); el?.__chart?.destroy(); };
}
