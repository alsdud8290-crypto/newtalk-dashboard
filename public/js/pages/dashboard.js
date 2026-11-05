import { api, esc, won, pct, period, setPeriod, yearOptions, toast } from '../core.js';
import { donut, gauge, compareBar, hideTooltip, INDUSTRY_COLORS, seriesColor, SERIES, OTHER } from '../charts.js';
import { downloadXlsx, downloadPdf, fileSafe, stamp, addCardMenus, bindCardMenus } from '../exporter.js';

let charts = [];
let loadSeq = 0; // 늦게 도착한 이전 조회 결과는 버린다 (빠른 연속 클릭·화면 이동 대비)
let current = null; // 화면에 표시 중인 조회 결과 (내보내기용)
let currentAi = null;

const MODES = [['month', '월'], ['quarter', '분기'], ['year', '연간'], ['range', '기간']];
const SALES_COLORS = { 제품매출: SERIES[0], 상품매출: SERIES[1], 용역매출: SERIES[2], 영업외수익: SERIES[3] };
const COST_COLORS = { '상품 매입': SERIES[0], 판관비: SERIES[1], 영업외비용: SERIES[2], '원재료 매입': SERIES[3], 노무비: SERIES[4], 경비: SERIES[5] };
const salesMixOf = (c) => [
  { label: '제품매출', value: c.sales.product }, { label: '상품매출', value: c.sales.goods },
  { label: '용역매출', value: c.sales.service }, { label: '영업외수익', value: c.sales.nonOp },
];
const costMixOf = (c) => [
  { label: '상품 매입', value: c.costs.productPurchase }, { label: '판관비', value: c.costs.sga }, { label: '영업외비용', value: c.costs.nonOp },
  { label: '원재료 매입', value: c.costs.materialPurchase }, { label: '노무비', value: c.costs.labor }, { label: '경비', value: c.costs.expense },
];
const nextLabel = { month: '다음 달', quarter: '다음 분기', year: '내년', range: '다음 기간' };
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

// 증감 표시. 지출처럼 늘면 나쁜 지표는 invert
// 증감 배지. 지출처럼 늘면 나쁜 지표는 invert. 비교 기준이 0 이하이면 % 대신 금액 차이
function delta(label, cur, base, invert = false) {
  if (!base && !cur) return `<div><span>${esc(label)}</span><span class="pill none">-</span></div>`;
  const diff = cur - base;
  const good = invert ? diff <= 0 : diff >= 0;
  const text = base > 0 ? pct(Math.abs(diff / base)) : won(Math.abs(diff));
  return `<div><span>${esc(label)}</span><span class="pill ${good ? 'up' : 'down'}">${diff >= 0 ? '▲' : '▼'}${text}</span></div>`;
}

// 큰 숫자 + 작은 단위: "4.82억 원"
function kv(v) {
  const t = won(v);
  return `<div class="k-value num ${v < 0 ? 'neg' : ''}"><span class="kv-num">${esc(t.replace(/원$/, ''))}</span><span class="kv-unit">원</span></div>`;
}

function paceChip(rate) {
  if (rate === null) return '';
  if (rate >= 1) return '<span class="status-chip good">✓ 목표 페이스 이상</span>';
  if (rate >= 0.9) return '<span class="status-chip warning">! 목표 페이스 근접</span>';
  return '<span class="status-chip critical">▼ 목표 페이스 미달</span>';
}

// ---------- 조회 조건 ----------
function periodControl() {
  const n = period.mode === 'month' ? 12 : 4;
  const opts = Array.from({ length: n }, (_, i) => i + 1)
    .map((p) => `<option value="${p}" ${p === period.period ? 'selected' : ''}>${p}${period.mode === 'month' ? '월' : '분기'}</option>`).join('');
  return `
    <select class="input" id="f-year" ${period.mode === 'range' ? 'hidden' : ''}>${yearOptions(period.year)}</select>
    <div class="seg" id="f-mode">${MODES.map(([m, l]) => `<button type="button" data-mode="${m}" class="${period.mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>
    <select class="input" id="f-period" ${['month', 'quarter'].includes(period.mode) ? '' : 'hidden'}>${opts}</select>
    <span id="f-range" class="filters" ${period.mode === 'range' ? '' : 'hidden'}>
      <input class="input" type="month" id="f-from" value="${esc(period.from)}" aria-label="시작월">
      <span class="range-sep">~</span>
      <input class="input" type="month" id="f-to" value="${esc(period.to)}" aria-label="종료월">
      <button type="button" class="btn primary" id="f-go">조회</button>
    </span>`;
}

// 단위를 바꿔도 같은 시점을 유지
function switchMode(mode) {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  const toY = Number(period.to.slice(0, 4));
  const toM = Number(period.to.slice(5, 7));
  let { year } = period;
  let refMonth;
  if (period.mode === 'month') refMonth = period.period;
  else if (period.mode === 'quarter') refMonth = period.period * 3;
  else if (period.mode === 'year') refMonth = year === curY ? curM : 12;
  else { year = toY; refMonth = toM; }
  if (year === curY) refMonth = Math.min(refMonth, curM);

  const next = { mode, year };
  if (mode === 'month') next.period = refMonth;
  if (mode === 'quarter') next.period = Math.ceil(refMonth / 3);
  if (mode === 'range') {
    if (period.mode === 'month') Object.assign(next, { from: ym(year, period.period), to: ym(year, period.period) });
    else if (period.mode === 'quarter') Object.assign(next, { from: ym(year, period.period * 3 - 2), to: ym(year, period.period * 3) });
    else if (period.mode === 'year') Object.assign(next, { from: ym(year, 1), to: ym(year, year === curY ? curM : 12) });
  }
  setPeriod(next);
}

function query() {
  const p = period;
  if (p.mode === 'range') return `mode=range&from=${p.from}&to=${p.to}`;
  if (p.mode === 'year') return `mode=year&year=${p.year}`;
  return `mode=${p.mode}&year=${p.year}&period=${p.period}`;
}

export async function render(main) {
  main.innerHTML = `
    <div class="page-head">
      <div><h2>경영 대시보드</h2><div class="sub" id="d-sub"></div></div>
      <div class="filters">
        <div class="filters" id="d-filters">${periodControl()}</div>
        <button type="button" class="btn" id="d-pdf" title="대시보드 전체를 PDF로 저장">⬇ PDF로 저장</button>
        <button type="button" class="btn" id="d-xlsx" title="대시보드 수치를 엑셀로 저장">⬇ 수치 엑셀</button>
      </div>
    </div>
    <div id="d-body"><div class="empty">불러오는 중…</div></div>`;

  const filters = main.querySelector('#d-filters');
  const redraw = () => { filters.innerHTML = periodControl(); bind(); load(main); };
  function bind() {
    filters.querySelector('#f-year').addEventListener('change', (e) => { setPeriod({ year: Number(e.target.value) }); load(main); });
    filters.querySelector('#f-period').addEventListener('change', (e) => { setPeriod({ period: Number(e.target.value) }); load(main); });
    filters.querySelector('#f-mode').addEventListener('click', (e) => {
      const mode = e.target.dataset.mode;
      if (!mode || mode === period.mode) return;
      switchMode(mode);
      redraw();
    });
    const go = () => {
      const from = filters.querySelector('#f-from').value;
      const to = filters.querySelector('#f-to').value;
      if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return toast('시작월과 종료월을 YYYY-MM 형식으로 입력해 주세요.', true);
      if (from > to) return toast('시작월이 종료월보다 늦습니다.', true);
      setPeriod({ from, to, year: Number(to.slice(0, 4)) });
      load(main);
    };
    filters.querySelector('#f-go').addEventListener('click', go);
    filters.querySelectorAll('#f-from, #f-to').forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
  }
  bind();

  main.querySelector('#d-pdf').addEventListener('click', async (e) => {
    if (!current) return;
    e.target.disabled = true;
    await downloadPdf(main.querySelector('#d-body'), fileSafe(`뉴토크코리아_대시보드_${current.label}_${stamp()}`));
    e.target.disabled = false;
  });
  main.querySelector('#d-xlsx').addEventListener('click', () => current && exportNumbers(current));
  // 카드별 [PNG] [CSV] 저장
  bindCardMenus(main, { getData: (key) => current && cardData(key, current), prefix: '뉴토크코리아', label: () => current?.label || '' });

  await load(main);
  return () => { loadSeq += 1; hideTooltip(); charts.forEach((c) => c.destroy()); charts = []; };
}

async function load(main) {
  const q = query();
  const seq = ++loadSeq;
  let s;
  let ai;
  try {
    [s, ai] = await Promise.all([api(`/api/mgmt/summary?${q}`), api(`/api/mgmt/ai-comment?${q}`)]);
  } catch (err) {
    if (seq === loadSeq) toast(err.message, true);
    return;
  }
  if (seq !== loadSeq || !main.isConnected) return;
  current = s;
  hideTooltip();
  charts.forEach((c) => c.destroy());
  charts = [];
  main.querySelector('#d-sub').textContent = `${s.label} 기준 · 금액 단위 원 (표시는 만원/억원)`;

  const body = main.querySelector('#d-body');
  const cur = s.current;
  const r = s.receivables;
  const a = s.achievement;
  const margin = cur.sales.total ? cur.profit / cur.sales.total : null;

  body.innerHTML = `
    ${s.salesFromDetailMonths.length ? `<div class="notice">${s.salesFromDetailMonths.join(', ')}은 월별 매출이 입력되지 않아 <b>매출 내역 합계</b>로 표시합니다.</div>` : ''}
    ${!s.target ? `<div class="notice warn">${s.year}년 연간 목표매출액이 설정되지 않았습니다. <a href="#/input/monthly">목표 설정하기 →</a></div>` : ''}

    <div class="section-block" data-card="kpi">
    <div class="section-title"><span class="num-badge">01</span>주요 지표 <span class="hint">${esc(s.label)}</span></div>
    <div class="kpis">
      <div class="card kpi">
        <div class="k-label">매출</div>
        ${kv(cur.sales.total)}
        <div class="k-meta">${s.periodTarget ? `기간 목표 ${won(s.periodTarget)} 대비 <b>${pct(cur.sales.total / s.periodTarget)}</b>` : '목표 미설정'}</div>
        <div class="k-lines">
          ${delta('직전 대비', cur.sales.total, s.prev.sales.total)}
          ${delta('전년 동기 대비', cur.sales.total, s.lastYearSame.sales.total)}
        </div>
      </div>
      <div class="card kpi">
        <div class="k-label">지출</div>
        ${kv(cur.costs.total)}
        <div class="k-meta">지출 6개 항목 합계 · 매출 대비 <b>${cur.sales.total ? pct(cur.costs.total / cur.sales.total) : '-'}</b></div>
        <div class="k-lines">
          ${delta('직전 대비', cur.costs.total, s.prev.costs.total, true)}
          ${delta('전년 동기 대비', cur.costs.total, s.lastYearSame.costs.total, true)}
        </div>
      </div>
      <div class="card kpi">
        <div class="k-label">추정 이익</div>
        ${kv(cur.profit)}
        <div class="k-meta">매출 − 지출 · 이익률 <b>${pct(margin)}</b></div>
        <div class="k-lines">
          ${delta('직전 대비', cur.profit, s.prev.profit)}
          ${delta('전년 동기 대비', cur.profit, s.lastYearSame.profit)}
        </div>
      </div>
      <div class="card kpi">
        <div class="k-label">미수금</div>
        ${kv(r.outstanding)}
        <div class="k-meta">${r.month ? `${Number(r.month.slice(5))}월 말 기준 미수금 총액` : '월별 실적에 미수금 총액이 입력되지 않았습니다'}</div>
        <div class="k-lines">
          ${delta('직전 대비', r.outstanding, r.prev, true)}
          ${delta('전년 동기 대비', r.outstanding, r.lastYearSame, true)}
        </div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px">비교 기간 · 직전: ${esc(s.prevLabel)} · 전년 동기: ${esc(s.lyLabel)}</div>
    </div>

    <div class="section-title"><span class="num-badge">02</span>현황 분석</div>
    ${targetCard(s)}
    <div class="grid g3">
      <div class="card accent" data-card="annual">
        <div class="card-head"><h3>${s.year}년 목표매출 달성률</h3>${paceChip(a.paceRate)}</div>
        <div class="donut-box"><canvas id="c-gauge" aria-label="연간 목표매출 달성률"></canvas>
          <div class="donut-center"><div><div class="big num">${s.target ? pct(a.rate) : '-'}</div><div class="small">${s.year}년 목표 대비</div></div></div>
        </div>
        <div class="target-meta">
          <div><div class="lab">연간 목표</div><div class="val">${won(s.target)}</div></div>
          <div><div class="lab">누적 매출 (~${a.endMonth}월)</div><div class="val">${won(a.ytdSales)}</div></div>
          <div><div class="lab">경과 기간 기준 기대치 (${a.monthsElapsed.toFixed(1)}개월)</div><div class="val">${won(a.expectedToDate)}</div></div>
          <div><div class="lab">남은 목표 (${a.monthsLeft}개월)</div><div class="val">${won(a.remaining)}</div></div>
        </div>
      </div>
      ${donutCard('c-sales-mix', '매출 구성', '제품 · 상품 · 용역 · 영업외수익', won(cur.sales.total), s.short)}
      ${donutCard('c-cost-mix', '지출 구성', '상품 매입 · 판관비 · 영업외비용 · 원재료 · 노무비 · 경비', won(cur.costs.total), s.short)}
    </div>

    <div class="section-title"><span class="num-badge">03</span>추이 및 분석</div>
    <div class="grid g-trend">
      <div class="card" data-card="trend">
        <div class="card-head"><h3>매출 · 지출 추이</h3><span class="hint">${trendHint(s)}</span></div>
        <div class="chart-box" style="height:320px"><canvas id="c-trend"></canvas></div>
      </div>
      ${donutCard('c-industry', '산업 분야별 매출', s.label, null, s.short)}
      ${donutCard('c-series', '제품별 매출', s.label, null, s.short)}
    </div>

    <div class="section-title"><span class="num-badge">04</span>AI 분석</div>
    <div class="card ai-card" id="ai-card" data-card="ai"></div>`;

  // ② 목표 달성 타일 + 원형 그래프
  charts.push(gauge(body.querySelector('#c-gauge'), a.ytdSales, s.target, { color: '#ffffff', rest: 'rgba(255,255,255,.28)', gap: 'rgba(0,0,0,0)' }));
  quarterStats(s).forEach((x) => { const c = body.querySelector(`#c-q${x.key}`); if (c) charts.push(gauge(c, x.sales, x.target)); });

  charts.push(donut(body.querySelector('#c-sales-mix'), body.querySelector('#l-c-sales-mix'), salesMixOf(cur), (l) => SALES_COLORS[l]));
  charts.push(donut(body.querySelector('#c-cost-mix'), body.querySelector('#l-c-cost-mix'), costMixOf(cur), (l) => COST_COLORS[l]));
  emptyLegend(body, 'c-sales-mix', cur.sales.total, '이 기간의 매출이 없습니다.');
  emptyLegend(body, 'c-cost-mix', cur.costs.total, '이 기간의 지출이 없습니다.');

  // ③ 추이 + 분야/제품
  charts.push(compareBar(body.querySelector('#c-trend'), s.buckets.map((b) => b.label), [
    { label: '매출', data: s.buckets.map((b) => b.sales.total), color: SERIES[0] },
    { label: '지출', data: s.buckets.map((b) => b.costs.total), color: SERIES[1] },
  ], {
    selected: s.buckets.map((b) => b.selected),
    line: s.buckets.some((b) => b.target) ? { label: '목표 매출', data: s.buckets.map((b) => b.target) } : null,
  }));
  const indTotal = s.industry.reduce((t, x) => t + x.value, 0);
  const serTotal = s.series.reduce((t, x) => t + x.value, 0);
  body.querySelector('#t-c-industry').textContent = won(indTotal);
  body.querySelector('#t-c-series').textContent = won(serTotal);
  charts.push(donut(body.querySelector('#c-industry'), body.querySelector('#l-c-industry'), s.industry, (l) => INDUSTRY_COLORS[l] || OTHER));
  charts.push(donut(body.querySelector('#c-series'), body.querySelector('#l-c-series'), s.series, seriesColor));
  emptyLegend(body, 'c-series', serTotal, '매출 내역이 없습니다.<br><a href="#/input/sales">매출 내역 입력 →</a>');

  renderAi(body.querySelector('#ai-card'), s, ai);
  addCardMenus(body);
}


const M = '#,##0';
const P = '0.0%';
const stateName = { done: '완료', running: '진행 중', future: '예정' };
const share = (list) => {
  const total = list.reduce((t, x) => t + x.value, 0);
  return list.map((x) => [x.label, x.value, total ? x.value / total : 0]);
};

// 카드별 표 데이터 { name, aoa, formats } — 카드 CSV와 "수치 엑셀"이 같은 정의를 쓴다
function cardData(key, s) {
  const c = s.current;
  const r = s.receivables;
  const a = s.achievement;
  const cmp = (label, f) => [label, f(c), f(s.prev), f(s.lastYearSame)];
  switch (key) {
    case 'kpi': return {
      name: '주요지표',
      aoa: [
        ['항목', s.label, `직전 (${s.prevLabel})`, `전년 동기 (${s.lyLabel})`],
        cmp('매출', (x) => x.sales.total), cmp('지출', (x) => x.costs.total), cmp('추정 이익 (매출−지출)', (x) => x.profit),
        ['미수금 총액 (기간 마지막 입력 월 말)', r.outstanding, r.prev, r.lastYearSame],
        ['기간 목표 매출', s.periodTarget, '', ''],
      ],
      formats: [null, M, M, M],
    };
    case 'quarter': return {
      name: `${s.year}년 분기별 목표달성`,
      aoa: [['분기', '목표', '실적', '달성률', '상태'], ...quarterStats(s).map((x) => [`${x.key}분기`, x.target, x.sales, x.state === 'future' ? '' : x.rate, stateName[x.state]])],
      formats: [null, M, M, P, null],
    };
    case 'annual': return {
      name: `${s.year}년 목표매출 달성률`,
      // 금액과 비율은 열을 나눠 담는다 (CSV·엑셀 서식이 열 단위라서)
      aoa: [['항목', '금액', '비율', '설명'],
        ['연간 목표', s.target, '', ''],
        [`누적 매출 (~${a.endMonth}월)`, a.ytdSales, a.rate ?? '', '비율 = 달성률 (누적 매출 ÷ 연간 목표)'],
        [`경과 기간 기준 기대치 (${a.monthsElapsed.toFixed(1)}개월)`, a.expectedToDate, a.paceRate ?? '', '비율 = 진도율 (누적 매출 ÷ 기대치)'],
        [`남은 목표 (${a.monthsLeft}개월)`, a.remaining, '', '']],
      formats: [null, M, P, null],
    };
    case 'c-sales-mix': return {
      name: '매출 구성', aoa: [['구분', '매출', '비중'], ...share(salesMixOf(c))], formats: [null, M, P],
    };
    case 'c-cost-mix': return {
      name: '지출 구성',
      aoa: [['구분', '지출', '비중'], ...share(costMixOf(c))],
      formats: [null, M, P],
    };
    case 'trend': return {
      name: '매출·지출 추이',
      aoa: [['기간', '매출', '지출', '추정 이익', '목표 매출'], ...s.buckets.map((b) => [b.label, b.sales.total, b.costs.total, b.profit, b.target])],
      formats: [null, M, M, M, M],
    };
    case 'c-industry': return { name: '산업 분야별 매출', aoa: [['산업 분야', '매출', '비중'], ...share(s.industry)], formats: [null, M, P] };
    case 'c-series': return { name: '제품별 매출', aoa: [['제품 시리즈', '매출', '비중'], ...share(s.series)], formats: [null, M, P] };
    case 'ai': {
      const ai = currentAi;
      const rows = ai ? [['요약', ai.headline], ...(ai.status || []).map((t) => ['이번 기간 현황', t]),
        ...(ai.shortfalls || []).map((t) => ['부족한 점·주의', t]), ...(ai.nextActions || []).map((t) => ['개선할 점', t]),
        ['작성', `${ai.source === 'claude' ? 'Claude AI' : '규칙 기반 자동 요약'} · ${ai.createdAt}`]] : [['안내', '아직 분석이 없습니다.']];
      return { name: 'AI 분석 코멘트', aoa: [['구분', '내용'], ...rows], formats: [] };
    }
    default: return { name: key, aoa: [['데이터 없음']], formats: [] };
  }
}

const CARD_KEYS = ['kpi', 'quarter', 'annual', 'c-sales-mix', 'c-cost-mix', 'trend', 'c-industry', 'c-series', 'ai'];

// 대시보드 수치 엑셀: 카드별 표를 시트로
function exportNumbers(s) {
  const sheets = CARD_KEYS.filter((k) => k !== 'quarter' || s.target).map((k) => cardData(k, s));
  downloadXlsx(fileSafe(`뉴토크코리아_대시보드수치_${s.label}_${stamp()}`), [
    { name: '조회조건', aoa: [['조회 기간', s.label], ['기간', `${s.from} ~ ${s.to}`], [`${s.year}년 연간 목표`, s.target], ['내려받은 날짜', stamp()]], formats: [null, M] },
    ...sheets,
  ]);
}

function trendHint(s) {
  const unit = s.mode === 'quarter' ? '분기별' : '월별';
  const scope = s.mode === 'range' ? s.label : `${s.year}년`;
  return `${scope} ${unit} · 점선: 목표 매출${s.mode === 'month' || s.mode === 'quarter' ? ' · 선택 기간 진하게' : ''}`;
}

function donutCard(id, title, hint, total, scope) {
  return `
    <div class="card" data-card="${id}">
      <div class="card-head"><h3>${esc(title)}</h3><span class="hint">${esc(hint)}</span></div>
      <div class="donut-box"><canvas id="${id}" aria-label="${esc(title)}"></canvas>
        <div class="donut-center"><div><div class="big num" style="font-size:18px" id="t-${id}">${total ?? ''}</div><div class="small">${esc(scope)}</div></div></div>
      </div>
      <div class="legend" id="l-${id}"></div>
    </div>`;
}

function emptyLegend(body, id, total, html) {
  if (!total) body.querySelector(`#l-${id}`).innerHTML = `<div class="empty" style="padding:12px">${html}</div>`;
}

// ---------- 목표 달성 현황 (분기 + 월) ----------
// 분기 목표 = 연간 목표 ÷ 4, 월 목표 = ÷ 12. 진행 중인 기간은 오늘까지 경과한 만큼과도 비교
function stat(key, sales, target, startMonth, lenMonths, elapsedYear) {
  const inside = Math.min(lenMonths, Math.max(0, elapsedYear - (startMonth - 1)));
  const state = inside >= lenMonths ? 'done' : inside > 0 ? 'running' : 'future';
  return {
    key, sales, target, state,
    rate: target ? sales / target : null,
    paceRate: state === 'running' && target ? sales / (target * (inside / lenMonths)) : null,
    gap: target - sales,
  };
}

function quarterStats(s) {
  return [1, 2, 3, 4].map((q) => {
    const sales = s.yearMonths.slice((q - 1) * 3, q * 3).reduce((t, m) => t + m.sales.total, 0);
    return { ...stat(q, sales, s.target / 4, q * 3 - 2, 3, s.yearElapsed), selected: s.yearMonths.slice((q - 1) * 3, q * 3).some((m) => m.selected) && s.mode !== 'year' };
  });
}

function statusChip(x) {
  if (x.state === 'future') return '<span class="badge">예정</span>';
  if (x.rate >= 1) return '<span class="status-chip good">✓ 달성</span>';
  if (x.state === 'running') return x.paceRate >= 1 ? '<span class="status-chip good">✓ 진행 중 · 페이스 양호</span>' : `<span class="status-chip warning">! 진행 중 · 페이스 ${pct(x.paceRate, 0)}</span>`;
  return '<span class="status-chip critical">▼ 미달</span>';
}

function targetCard(s) {
  if (!s.target) return '';
  const quarters = quarterStats(s).map((x) => {
    const gapLine = x.state === 'future' ? '&nbsp;'
      : x.gap > 0 ? `목표까지 <b>${won(x.gap)}</b> ${x.state === 'done' ? '부족' : '남음'}`
        : `목표 대비 <b style="color:var(--good)">+${won(-x.gap)}</b> 초과`;
    return `
      <div class="q-tile ${x.selected ? 'sel' : ''}">
        <div class="q-head"><b>${x.key}분기</b>${statusChip(x)}</div>
        <div class="q-donut"><canvas id="c-q${x.key}" aria-label="${x.key}분기 목표 달성률"></canvas>
          <div class="donut-center"><div class="big num">${x.state === 'future' ? '-' : pct(x.rate, 0)}</div></div>
        </div>
        <div class="q-nums"><span>실적</span><b class="num">${won(x.sales)}</b></div>
        <div class="q-nums"><span>목표</span><span class="num">${won(x.target)}</span></div>
        <div class="q-gap">${gapLine}</div>
      </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:16px" data-card="quarter">
      <div class="card-head"><h3>${s.year}년 분기별 목표 달성 현황</h3><span class="hint">분기 목표 = 연간 목표 ${won(s.target)} ÷ 4</span></div>
      <div class="q-grid">${quarters}</div>
    </div>`;
}

// ---------- ④ AI 분석 ----------
function renderAi(el, s, ai) {
  currentAi = ai;
  const list = (items, empty) => (items?.length ? `<ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : `<div class="ai-meta">${empty}</div>`);
  el.innerHTML = `
    <div class="card-head">
      <h3>AI 분석 코멘트 · ${esc(s.label)}</h3>
      <div style="display:flex;gap:8px;align-items:center">
        ${ai ? `<span class="ai-meta">${ai.source === 'claude' ? 'Claude AI 분석' : '자동 요약(규칙 기반)'} · ${esc(ai.createdAt)}</span>` : ''}
        <button class="btn sm primary" id="ai-gen">${ai ? '다시 분석' : '분석 생성'}</button>
      </div>
    </div>
    ${ai ? `
      <div class="headline">${esc(ai.headline)}</div>
      <div class="ai-cols">
        <div><h4><span class="dot" style="background:var(--accent)"></span>이번 기간 현황</h4>${list(ai.status, '-')}</div>
        <div><h4><span class="dot" style="background:var(--critical)"></span>부족한 점·주의</h4>${list(ai.shortfalls, '특이사항 없음')}</div>
        <div><h4><span class="dot" style="background:var(--good)"></span>${nextLabel[s.mode]} 개선할 점</h4>${list(ai.nextActions, '-')}</div>
      </div>`
    : '<div class="ai-meta">아직 분석이 없습니다. [분석 생성]을 누르면 이 기간의 매출 상황, 부족한 점, 다음 기간 개선점을 요약합니다.</div>'}`;
  addCardMenus(el.parentElement);
  el.querySelector('#ai-gen').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '분석 중…';
    try {
      const body = { mode: s.mode, year: s.year, from: s.from, to: s.to, period: period.period };
      const res = await api('/api/mgmt/ai-comment', { method: 'POST', body });
      if (res.source === 'rules') toast('AI 연결이 설정되지 않아 규칙 기반 요약으로 표시합니다.');
      renderAi(el, s, res);
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
      e.target.textContent = '다시 시도';
    }
  });
}
