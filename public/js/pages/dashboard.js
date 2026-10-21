import { api, esc, won, pct, period, setPeriod, yearOptions, toast } from '../core.js';
import { donut, gauge, stackedBar, hbar, INDUSTRY_COLORS, seriesColor, SERIES, OTHER } from '../charts.js';

let charts = [];
let scope = 'period'; // 산업분야·시리즈 도넛 범위: period(선택 기간) | year(연간 누적)

function delta(cur, base, label) {
  if (!base) return `<span>${esc(label)} 데이터 없음</span>`;
  const g = cur / base - 1;
  return `<span class="delta ${g >= 0 ? 'up' : 'down'}">${g >= 0 ? '▲' : '▼'} ${pct(Math.abs(g))}</span><span>${esc(label)} 대비</span>`;
}

function paceChip(rate) {
  if (rate === null) return '';
  if (rate >= 1) return '<span class="status-chip good">✓ 목표 페이스 이상</span>';
  if (rate >= 0.9) return '<span class="status-chip warning">! 목표 페이스 근접</span>';
  return '<span class="status-chip critical">▼ 목표 페이스 미달</span>';
}

function periodSelect() {
  const n = period.mode === 'month' ? 12 : 4;
  return Array.from({ length: n }, (_, i) => i + 1)
    .map((p) => `<option value="${p}" ${p === period.period ? 'selected' : ''}>${p}${period.mode === 'month' ? '월' : '분기'}</option>`).join('');
}

export async function render(main, ctx) {
  main.innerHTML = `
    <div class="page-head">
      <div><h2>경영 현황 대시보드</h2><div class="sub" id="d-sub"></div></div>
      <div class="filters">
        <select class="input" id="f-year">${yearOptions(period.year, ctx.meta.years)}</select>
        <div class="seg" id="f-mode">
          <button type="button" data-mode="quarter" class="${period.mode === 'quarter' ? 'on' : ''}">분기</button>
          <button type="button" data-mode="month" class="${period.mode === 'month' ? 'on' : ''}">월</button>
        </div>
        <select class="input" id="f-period">${periodSelect()}</select>
      </div>
    </div>
    <div id="d-body"><div class="empty">불러오는 중…</div></div>`;

  const reload = () => load(main);
  main.querySelector('#f-year').addEventListener('change', (e) => { setPeriod({ year: Number(e.target.value) }); reload(); });
  main.querySelector('#f-period').addEventListener('change', (e) => { setPeriod({ period: Number(e.target.value) }); reload(); });
  main.querySelector('#f-mode').addEventListener('click', (e) => {
    const mode = e.target.dataset.mode;
    if (!mode || mode === period.mode) return;
    // 분기 ↔ 월 전환 시 같은 시점을 유지
    const p = mode === 'month' ? (period.period - 1) * 3 + 3 : Math.ceil(period.period / 3);
    const nowY = new Date().getFullYear();
    const curMonth = new Date().getMonth() + 1;
    setPeriod({ mode, period: mode === 'month' && period.year === nowY ? Math.min(p, curMonth) : p });
    main.querySelectorAll('#f-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    main.querySelector('#f-period').innerHTML = periodSelect();
    reload();
  });

  await load(main);
  return () => { charts.forEach((c) => c.destroy()); charts = []; };
}

async function load(main) {
  const q = `year=${period.year}&mode=${period.mode}&period=${period.period}`;
  const [s, ai] = await Promise.all([api(`/api/mgmt/summary?${q}`), api(`/api/mgmt/ai-comment?${q}`)]);
  charts.forEach((c) => c.destroy());
  charts = [];
  main.querySelector('#d-sub').textContent = `${s.label} 기준 · 금액 단위 원 (표시는 만원/억원)`;

  const now = new Date();
  const endMonth = s.mode === 'month' ? s.period : s.period * 3;
  const refMonth = s.mode === 'month' ? s.period
    : (s.year === now.getFullYear() ? Math.min(endMonth, Math.max(endMonth - 2, now.getMonth() + 1)) : endMonth);
  const refQuarter = Math.ceil(refMonth / 3);
  const mCur = s.months[refMonth - 1];
  const mPrev = refMonth > 1 ? s.months[refMonth - 2] : null;
  const qSales = s.months.slice((refQuarter - 1) * 3, refQuarter * 3).reduce((a, m) => a + m.sales.total, 0);
  const qTarget = s.target / 4;
  const a = s.achievement;
  const r = s.receivables;

  const body = main.querySelector('#d-body');
  body.innerHTML = `
    ${s.salesFromDetailMonths.length ? `<div class="notice">${s.salesFromDetailMonths.join(', ')}월은 월별 매출이 입력되지 않아 <b>매출 내역 합계</b>로 표시합니다.</div>` : ''}
    ${!s.target ? `<div class="notice warn">${s.year}년 연간 목표매출액이 설정되지 않았습니다. <a href="#/input/monthly">목표 설정하기 →</a></div>` : ''}

    <div class="kpis">
      <div class="card kpi">
        <div class="k-label">당월 매출 (${refMonth}월)</div>
        <div class="k-value num">${won(mCur.sales.total)}</div>
        <div class="k-sub">${!mCur.sales.total ? '<span>아직 입력되지 않음</span>' : mPrev ? delta(mCur.sales.total, mPrev.sales.total, `${refMonth - 1}월`) : '<span>1월</span>'}</div>
      </div>
      <div class="card kpi">
        <div class="k-label">분기 매출 (${refQuarter}분기)</div>
        <div class="k-value num">${won(qSales)}</div>
        <div class="k-sub">${s.target ? `<span>분기 목표 ${won(qTarget)} 대비</span><b>${pct(qSales / qTarget)}</b>` : '<span>목표 미설정</span>'}</div>
      </div>
      <div class="card kpi">
        <div class="k-label">연간 누적 매출 (~${endMonth}월)</div>
        <div class="k-value num">${won(a.ytdSales)}</div>
        <div class="k-sub">${s.target ? `<span>연간 목표 대비</span><b>${pct(a.rate)}</b>` : '<span>목표 미설정</span>'}</div>
      </div>
      <div class="card kpi">
        <div class="k-label">매입·경비 (${esc(s.label.replace(`${s.year}년 `, ''))})</div>
        <div class="k-value num">${won(s.current.costs.total)}</div>
        <div class="k-sub"><span>추정 손익</span><span class="delta ${s.current.profit >= 0 ? 'up' : 'down'}">${won(s.current.profit)}</span></div>
      </div>
      <div class="card kpi">
        <div class="k-label">미수금 잔액</div>
        <div class="k-value num">${won(r.outstanding)}</div>
        <div class="k-sub">${r.aging[3].value > 0 ? `<span class="status-chip critical">90일 초과 ${won(r.aging[3].value)}</span>` : `<span>${r.openCount}건</span>`}</div>
      </div>
    </div>

    ${quarterCard(s, a, refQuarter)}

    <div class="grid g3">
      <div class="card">
        <div class="card-head"><h3>연간 목표매출 달성률</h3>${paceChip(a.paceRate)}</div>
        <div class="donut-box"><canvas id="c-gauge" aria-label="목표 달성률"></canvas>
          <div class="donut-center"><div><div class="big num">${s.target ? pct(a.rate) : '-'}</div><div class="small">${s.year}년 목표 대비</div></div></div>
        </div>
        <div class="target-meta">
          <div><div class="lab">연간 목표</div><div class="val">${won(s.target)}</div></div>
          <div><div class="lab">누적 매출 (~${endMonth}월)</div><div class="val">${won(a.ytdSales)}</div></div>
          <div><div class="lab">경과 기간 기준 기대치 (${a.monthsElapsed.toFixed(1)}개월)</div><div class="val">${won(a.expectedToDate)}</div></div>
          <div><div class="lab">남은 목표 (${a.monthsLeft}개월)</div><div class="val">${won(a.remaining)}</div></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h3>산업 분야별 매출 비중</h3>${scopeToggle()}</div>
        <div class="donut-box"><canvas id="c-industry" aria-label="산업 분야별 매출 비중"></canvas>
          <div class="donut-center"><div><div class="big num" style="font-size:18px" id="c-industry-total"></div><div class="small" id="c-industry-scope"></div></div></div>
        </div>
        <div class="legend" id="l-industry"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>제품 시리즈별 매출 비중</h3>${scopeToggle()}</div>
        <div class="donut-box"><canvas id="c-series" aria-label="제품 시리즈별 매출 비중"></canvas>
          <div class="donut-center"><div><div class="big num" style="font-size:18px" id="c-series-total"></div><div class="small" id="c-series-scope"></div></div></div>
        </div>
        <div class="legend" id="l-series"></div>
      </div>
    </div>

    <div class="card ai-card" style="margin-bottom:16px" id="ai-card"></div>

    <div class="grid g21">
      <div class="card">
        <div class="card-head"><h3>${s.mode === 'month' ? '월별' : '분기별'} 매출 추이</h3><span class="hint">점선: 목표 페이스 (연간 목표 ÷ ${s.mode === 'month' ? 12 : 4})</span></div>
        <div class="chart-box"><canvas id="c-sales"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>판매처 TOP 10</h3>${scopeToggle()}</div>
        <div class="table-wrap" id="t-customers"></div>
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="card-head"><h3>${s.mode === 'month' ? '월별' : '분기별'} 매입·지출 구성</h3></div>
        <div class="chart-box"><canvas id="c-costs"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>미수금 현황</h3><span class="hint">청구일 기준 경과일 · 오늘 기준</span></div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px" class="target-meta">
          <div><div class="lab">잔액</div><div class="val">${won(r.outstanding)}</div></div>
          <div><div class="lab">결제예정일 경과</div><div class="val" style="color:${r.overdueAmount ? 'var(--critical)' : 'inherit'}">${won(r.overdueAmount)} (${r.overdueCount}건)</div></div>
          <div><div class="lab">${esc(s.label.replace(`${s.year}년 `, ''))} 청구 / 수금</div><div class="val">${won(r.period.invoiced)} / ${won(r.period.collected)}</div></div>
        </div>
        <div style="position:relative;height:150px"><canvas id="c-aging"></canvas></div>
        <div class="table-wrap" style="margin-top:12px">
          <table class="tbl"><thead><tr><th>거래처</th><th class="r">미수 잔액</th><th class="c">건수</th><th>최초 청구일</th></tr></thead>
          <tbody>${r.topCustomers.length ? r.topCustomers.map((c) => `<tr><td>${esc(c.customer)}</td><td class="r num">${won(c.balance)}</td><td class="c">${c.count}</td><td>${esc(c.oldest)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">미수금이 없습니다.</td></tr>'}</tbody></table>
        </div>
      </div>
    </div>`;

  charts.push(gauge(body.querySelector('#c-gauge'), a.ytdSales, s.target));
  quarterStats(s, a).forEach((q) => {
    const c = body.querySelector(`#c-q${q.q}`);
    if (c) charts.push(gauge(c, q.sales, q.target));
  });

  const labels = s.buckets.map((b) => b.label);
  const sel = s.period - 1;
  charts.push(stackedBar(body.querySelector('#c-sales'), labels, [
    { label: '제품 매출', data: s.buckets.map((b) => b.sales.product), color: SERIES[0] },
    { label: '상품 매출', data: s.buckets.map((b) => b.sales.goods), color: SERIES[1] },
    { label: '용역 매출', data: s.buckets.map((b) => b.sales.service), color: SERIES[2] },
  ], { highlightIndex: sel, line: s.target ? { label: '목표 페이스', data: labels.map(() => s.target / labels.length) } : null }));

  charts.push(stackedBar(body.querySelector('#c-costs'), labels, [
    { label: '상품 매입', data: s.buckets.map((b) => b.costs.productPurchase), color: SERIES[0] },
    { label: '원재료 매입', data: s.buckets.map((b) => b.costs.materialPurchase), color: SERIES[1] },
    { label: '경비', data: s.buckets.map((b) => b.costs.expense), color: SERIES[2] },
    { label: '기타 지출(광고·접대 등)', data: s.buckets.map((b) => b.costs.etcTotal), color: SERIES[3] },
  ], { highlightIndex: sel }));

  charts.push(hbar(body.querySelector('#c-aging'), r.aging.map((x) => `${x.label} (${x.count})`), r.aging.map((x) => x.value),
    ['#86b6ef', '#3987e5', '#1c5cab', '#d03b3b']));

  renderScoped(body, s);
  body.querySelectorAll('[data-scope]').forEach((btn) => btn.addEventListener('click', () => {
    scope = btn.dataset.scope;
    body.querySelectorAll('[data-scope]').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
    renderScoped(body, s);
  }));

  renderAi(body.querySelector('#ai-card'), s, ai);
}

// 분기별 목표(연간 목표 ÷ 4) 대비 실적. 진행 중인 분기는 경과 일수만큼 안분한 기대치와도 비교한다.
function quarterStats(s, a) {
  const qTarget = s.target / 4;
  return [1, 2, 3, 4].map((q) => {
    const sales = s.months.slice((q - 1) * 3, q * 3).reduce((t, m) => t + m.sales.total, 0);
    const elapsedInQ = Math.min(3, Math.max(0, a.monthsElapsed - (q - 1) * 3));
    const state = elapsedInQ >= 3 ? 'done' : elapsedInQ > 0 ? 'running' : 'future';
    return {
      q, sales, target: qTarget, state,
      rate: qTarget ? sales / qTarget : null,
      paceRate: state === 'running' && qTarget ? sales / (qTarget * (elapsedInQ / 3)) : null,
      gap: qTarget - sales,
    };
  });
}

function quarterCard(s, a, selQuarter) {
  if (!s.target) return '';
  const tiles = quarterStats(s, a).map((x) => {
    let chip;
    if (x.state === 'future') chip = '<span class="badge">예정</span>';
    else if (x.rate >= 1) chip = '<span class="status-chip good">✓ 달성</span>';
    else if (x.state === 'running') chip = x.paceRate >= 1 ? '<span class="status-chip good">✓ 진행 중 · 페이스 양호</span>' : `<span class="status-chip warning">! 진행 중 · 페이스 ${pct(x.paceRate, 0)}</span>`;
    else chip = '<span class="status-chip critical">▼ 미달</span>';
    const gapLine = x.state === 'future' ? '&nbsp;'
      : x.gap > 0 ? `목표까지 <b>${won(x.gap)}</b> ${x.state === 'done' ? '부족' : '남음'}`
        : `목표 대비 <b style="color:var(--good)">+${won(-x.gap)}</b> 초과`;
    return `
      <div class="q-tile ${x.q === selQuarter ? 'sel' : ''}">
        <div class="q-head"><b>${x.q}분기</b>${chip}</div>
        <div class="q-donut"><canvas id="c-q${x.q}" aria-label="${x.q}분기 목표 달성률"></canvas>
          <div class="donut-center"><div class="big num">${x.state === 'future' ? '-' : pct(x.rate, 0)}</div></div>
        </div>
        <div class="q-nums"><span>실적</span><b class="num">${won(x.sales)}</b></div>
        <div class="q-nums"><span>목표</span><span class="num">${won(x.target)}</span></div>
        <div class="q-gap">${gapLine}</div>
      </div>`;
  }).join('');
  return `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>${s.year}년 분기별 목표 달성 현황</h3><span class="hint">분기 목표 = 연간 목표 ${won(s.target)} ÷ 4</span></div>
      <div class="q-grid">${tiles}</div>
    </div>`;
}

function scopeToggle() {
  return `<div class="seg" style="transform:scale(.9);transform-origin:right">
    <button type="button" data-scope="period" class="${scope === 'period' ? 'on' : ''}">선택 기간</button>
    <button type="button" data-scope="year" class="${scope === 'year' ? 'on' : ''}">연간 누적</button></div>`;
}

let scopedCharts = [];
function renderScoped(body, s) {
  scopedCharts.forEach((c) => { c.destroy(); charts = charts.filter((x) => x !== c); });
  scopedCharts = [];
  const scopeLabel = scope === 'period' ? s.label.replace(`${s.year}년 `, '') : '연간 누적';
  const ind = s.industry[scope];
  const ser = s.series[scope];
  const indTotal = ind.reduce((a, b) => a + b.value, 0);
  const serTotal = ser.reduce((a, b) => a + b.value, 0);

  body.querySelector('#c-industry-total').textContent = won(indTotal);
  body.querySelector('#c-industry-scope').textContent = scopeLabel;
  body.querySelector('#c-series-total').textContent = won(serTotal);
  body.querySelector('#c-series-scope').textContent = scopeLabel;

  scopedCharts.push(donut(body.querySelector('#c-industry'), body.querySelector('#l-industry'), ind, (l) => INDUSTRY_COLORS[l] || OTHER));
  scopedCharts.push(donut(body.querySelector('#c-series'), body.querySelector('#l-series'), ser, seriesColor));
  if (!serTotal) body.querySelector('#l-series').innerHTML = '<div class="empty" style="padding:12px">매출 내역이 없습니다.<br><a href="#/input/sales">매출 내역 입력 →</a></div>';
  charts.push(...scopedCharts);

  const cust = s.customers[scope];
  const cTotal = cust.reduce((a, b) => a + b.value, 0);
  body.querySelector('#t-customers').innerHTML = cust.length
    ? `<table class="tbl"><thead><tr><th class="c">#</th><th>판매처</th><th class="r">매출</th><th class="r">비중</th></tr></thead><tbody>
      ${cust.map((c, i) => `<tr><td class="c">${i + 1}</td><td>${esc(c.label)}</td><td class="r num">${won(c.value)}</td><td class="r num">${pct(c.value / cTotal)}</td></tr>`).join('')}
      </tbody></table>`
    : '<div class="empty">매출 내역이 없습니다.</div>';
}

function renderAi(el, s, ai) {
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
        <div><h4><span class="dot" style="background:var(--good)"></span>다음 ${s.mode === 'month' ? '달' : '분기'} 개선할 점</h4>${list(ai.nextActions, '-')}</div>
      </div>`
    : '<div class="ai-meta">아직 분석이 없습니다. 데이터 입력 후 [분석 생성]을 누르면 이번 기간의 매출 상황, 부족한 점, 다음 기간 개선점을 요약합니다.</div>'}`;
  el.querySelector('#ai-gen').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '분석 중…';
    try {
      const res = await api('/api/mgmt/ai-comment', { method: 'POST', body: { year: s.year, mode: s.mode, period: s.period } });
      if (res.source === 'rules') toast('AI 연결이 설정되지 않아 규칙 기반 요약으로 표시합니다.');
      renderAi(el, s, res);
    } catch (err) {
      toast(err.message, true);
      e.target.disabled = false;
      e.target.textContent = '다시 시도';
    }
  });
}
