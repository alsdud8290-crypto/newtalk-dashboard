import { db } from './db.js';

export const INDUSTRIES = ['상하수도', '발전소', '가스', '오일', '석유', '민간 플랜트', '기타'];
export const SALES_TYPES = ['제품', '상품', '용역'];
const SERIES_TOP_N = 7;
const MAX_RANGE_MONTHS = 60;

// 월은 "월 인덱스"(연도×12 + 월−1)로 다룬다 → 연도를 넘는 기간도 같은 방식으로 계산
const pad = (n) => String(n).padStart(2, '0');
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const toIdx = (y, m) => y * 12 + (m - 1);
const yOf = (i) => Math.floor(i / 12);
const mOf = (i) => (i % 12) + 1;
const ymStr = (i) => `${yOf(i)}-${pad(mOf(i))}`;
const span = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const ymLabel = (i) => `${yOf(i)}년 ${mOf(i)}월`;

export class PeriodError extends Error {}

// 조회 조건 → 시작/종료 월 인덱스와 표시 이름
//  month: year+period(1~12) / quarter: year+period(1~4) / year: year / range: from~to ('YYYY-MM')
export function resolvePeriod({ mode, year, period, from, to }) {
  const y = Number(year);
  const p = Number(period);
  const needYear = () => {
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new PeriodError(`잘못된 연도: ${year}`);
  };
  if (mode === 'range') {
    const parse = (s, name) => {
      const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
      if (!m || +m[2] < 1 || +m[2] > 12) throw new PeriodError(`${name} 형식은 YYYY-MM 이어야 합니다: ${s || '(빈 값)'}`);
      return toIdx(+m[1], +m[2]);
    };
    const start = parse(from, '시작월');
    const end = parse(to, '종료월');
    if (start > end) throw new PeriodError('시작월이 종료월보다 늦습니다.');
    if (end - start + 1 > MAX_RANGE_MONTHS) throw new PeriodError(`기간은 최대 ${MAX_RANGE_MONTHS}개월까지 조회할 수 있습니다.`);
    const label = start === end ? ymLabel(start)
      : yOf(start) === yOf(end) ? `${yOf(start)}년 ${mOf(start)}~${mOf(end)}월` : `${ymLabel(start)} ~ ${ymLabel(end)}`;
    return { mode, start, end, label, short: label };
  }
  needYear();
  if (mode === 'year') return { mode, start: toIdx(y, 1), end: toIdx(y, 12), label: `${y}년`, short: '연간' };
  if (mode === 'month') {
    if (!Number.isInteger(p) || p < 1 || p > 12) throw new PeriodError(`잘못된 월: ${period}`);
    return { mode, start: toIdx(y, p), end: toIdx(y, p), label: `${y}년 ${p}월`, short: `${p}월` };
  }
  if (!Number.isInteger(p) || p < 1 || p > 4) throw new PeriodError(`잘못된 분기: ${period}`);
  return { mode: 'quarter', start: toIdx(y, p * 3 - 2), end: toIdx(y, p * 3), label: `${y}년 ${p}분기`, short: `${p}분기` };
}

// 비교 기간 이름: 분기·연도 경계와 맞으면 "2026년 2분기", "2025년"처럼 표시
function rangeLabel(start, end) {
  const len = end - start + 1;
  if (len === 12 && mOf(start) === 1) return `${yOf(start)}년`;
  if (len === 3 && mOf(start) % 3 === 1) return `${yOf(start)}년 ${Math.ceil(mOf(start) / 3)}분기`;
  if (start === end) return ymLabel(start);
  return yOf(start) === yOf(end) ? `${yOf(start)}년 ${mOf(start)}~${mOf(end)}월` : `${ymLabel(start)} ~ ${ymLabel(end)}`;
}

function emptyMonth() {
  return {
    product_sales: 0, goods_sales: 0, service_sales: 0, non_op_income: 0,
    product_purchase: 0, sga_expense: 0, non_op_expense: 0, material_purchase: 0, labor_cost: 0, expense: 0,
    receivables_total: 0, salesFromDetail: false,
  };
}

// [start, end] 구간의 월별 데이터. 월별 매출 입력이 비어 있으면 매출내역 합계로 대체한다.
async function loadMonths(start, end) {
  const months = new Map(span(start, end).map((i) => [i, emptyMonth()]));
  const [rows, detail] = await Promise.all([
    db.all('SELECT * FROM monthly WHERE year * 12 + month - 1 BETWEEN ? AND ?', start, end),
    db.all(`SELECT substr(date, 1, 7) AS ym, sales_type, SUM(amount) AS amt FROM sales
            WHERE substr(date, 1, 7) BETWEEN ? AND ? GROUP BY ym, sales_type`, ymStr(start), ymStr(end)),
  ]);
  for (const r of rows) Object.assign(months.get(toIdx(Number(r.year), Number(r.month))), r);
  const byMonth = {};
  for (const d of detail) (byMonth[d.ym] ||= {})[d.sales_type] = d.amt;
  for (const [i, m] of months) {
    const d = byMonth[ymStr(i)];
    if (d && m.product_sales + m.goods_sales + m.service_sales === 0) {
      m.product_sales = d['제품'] || 0;
      m.goods_sales = d['상품'] || 0;
      m.service_sales = d['용역'] || 0;
      m.salesFromDetail = true;
    }
  }
  return months;
}

// 매출 = 제품 + 상품 + 용역 + 영업외수익, 지출 = 상품 매입 + 판관비 + 영업외비용 + 원재료 매입 + 노무비 + 경비
function aggregate(months, idxList) {
  const pick = (k) => sum(idxList.map((i) => months.get(i)?.[k] || 0));
  const sales = { product: pick('product_sales'), goods: pick('goods_sales'), service: pick('service_sales'), nonOp: pick('non_op_income') };
  sales.total = sales.product + sales.goods + sales.service + sales.nonOp;
  const costs = {
    productPurchase: pick('product_purchase'),
    sga: pick('sga_expense'),
    nonOp: pick('non_op_expense'),
    materialPurchase: pick('material_purchase'),
    labor: pick('labor_cost'),
    expense: pick('expense'),
  };
  costs.total = costs.productPurchase + costs.sga + costs.nonOp + costs.materialPurchase + costs.labor + costs.expense;
  return { sales, costs, profit: sales.total - costs.total };
}

async function breakdown(start, end, field) {
  const rows = await db.all(`
    SELECT ${field} AS k, SUM(amount) AS amt FROM sales
    WHERE substr(date, 1, 7) BETWEEN ? AND ?
    GROUP BY ${field} ORDER BY amt DESC`, ymStr(start), ymStr(end));
  return rows.map((r) => ({ label: r.k || '(미지정)', value: r.amt }));
}

async function industryBreakdown(start, end) {
  const raw = Object.fromEntries((await breakdown(start, end, 'industry')).map((r) => [r.label, r.value]));
  // 고정 순서 → 색상이 항상 같은 분야를 가리키도록
  const known = INDUSTRIES.map((label) => ({ label, value: raw[label] || 0 }));
  const unknown = Object.entries(raw).filter(([k]) => !INDUSTRIES.includes(k)).reduce((a, [, v]) => a + v, 0);
  known[known.length - 1].value += unknown;
  return known;
}

async function seriesBreakdown(start, end) {
  const rows = await breakdown(start, end, 'series');
  if (rows.length <= SERIES_TOP_N) return rows;
  const head = rows.slice(0, SERIES_TOP_N - 1);
  return [...head, { label: '기타', value: sum(rows.slice(SERIES_TOP_N - 1).map((r) => r.value)) }];
}

// 미수금 총액(월별 실적에 수기 입력한 월말 잔액): 기간 안에서 입력된 마지막 달 값
function receivablesAt(months, start, end) {
  for (let i = end; i >= start; i--) {
    const v = months.get(i)?.receivables_total || 0;
    if (v) return { value: v, month: ymStr(i) };
  }
  return { value: 0, month: null };
}

// 추이 차트의 막대 단위: 분기 조회 → 그 해 4개 분기, 월·연간 조회 → 그 해 12개월, 기간 조회 → 기간 내 각 월
function bucketPlan(p) {
  const y = yOf(p.end);
  if (p.mode === 'quarter') {
    return [1, 2, 3, 4].map((q) => {
      const idx = span(toIdx(y, q * 3 - 2), toIdx(y, q * 3));
      return { label: `${q}분기`, idx, selected: idx[0] === p.start };
    });
  }
  const list = p.mode === 'range' ? span(p.start, p.end) : span(toIdx(y, 1), toIdx(y, 12));
  const multiYear = p.mode === 'range' && yOf(p.start) !== yOf(p.end);
  return list.map((i) => ({
    label: multiYear ? `${String(yOf(i)).slice(2)}.${mOf(i)}월` : `${mOf(i)}월`,
    idx: [i],
    selected: p.mode === 'month' ? i === p.start : true,
  }));
}

export async function summarize(query, today = new Date()) {
  const p = resolvePeriod(query);
  const len = p.end - p.start + 1;
  const prevStart = p.start - len;
  const lyStart = p.start - 12;
  const year = yOf(p.end); // 목표 달성 현황은 조회 기간이 끝나는 해 기준
  const yStart = toIdx(year, 1);
  const yEnd = toIdx(year, 12);

  const plan = bucketPlan(p);
  const loadFrom = Math.min(prevStart, lyStart, yStart, ...plan.map((b) => b.idx[0]));
  const loadTo = Math.max(p.end, yEnd);
  const yearsNeeded = [...new Set(span(loadFrom, loadTo).map(yOf))];

  const [months, targetRows] = await Promise.all([
    loadMonths(loadFrom, loadTo),
    db.all(`SELECT year, revenue FROM targets WHERE year IN (${yearsNeeded.map(() => '?').join(',')})`, ...yearsNeeded),
  ]);
  const targets = Object.fromEntries(targetRows.map((r) => [Number(r.year), Number(r.revenue)]));
  const monthTarget = (i) => (targets[yOf(i)] || 0) / 12;
  const target = targets[year] || 0;

  const sel = span(p.start, p.end);
  const current = aggregate(months, sel);
  const prev = aggregate(months, span(prevStart, p.start - 1));
  const lastYearSame = aggregate(months, span(lyStart, lyStart + len - 1));
  const periodTarget = sum(sel.map(monthTarget));

  // 연간 목표 진도: 조회 기간 끝(또는 오늘) 기준 누적
  const endMonth = mOf(p.end);
  const ytd = aggregate(months, span(yStart, p.end));
  let elapsed = endMonth;
  if (year === today.getFullYear() && endMonth >= today.getMonth() + 1) {
    const dim = new Date(year, today.getMonth() + 1, 0).getDate();
    elapsed = today.getMonth() + today.getDate() / dim; // 예: 10월 17일 → 9.5개월
  } else if (year > today.getFullYear()) {
    elapsed = 0;
  }
  const expectedToDate = target * (elapsed / 12);
  // 분기·월 달성 현황 타일용: 올해의 경과 개월 (조회 기간과 무관하게 오늘 기준)
  const yearElapsed = year < today.getFullYear() ? 12 : year > today.getFullYear() ? 0
    : today.getMonth() + today.getDate() / new Date(year, today.getMonth() + 1, 0).getDate();

  const [industry, series, customers] = await Promise.all([
    industryBreakdown(p.start, p.end),
    seriesBreakdown(p.start, p.end),
    breakdown(p.start, p.end, 'customer'),
  ]);
  const recv = receivablesAt(months, p.start, p.end);
  const receivables = {
    outstanding: recv.value, month: recv.month,
    prev: receivablesAt(months, prevStart, p.start - 1).value,
    lastYearSame: receivablesAt(months, lyStart, lyStart + len - 1).value,
  };

  return {
    mode: p.mode,
    year,
    label: p.label,
    short: p.short,
    from: ymStr(p.start),
    to: ymStr(p.end),
    months: len,
    prevLabel: rangeLabel(prevStart, p.start - 1),
    lyLabel: rangeLabel(lyStart, lyStart + len - 1),
    target,
    periodTarget,
    current, prev, lastYearSame,
    achievement: {
      year,
      endMonth,
      ytdSales: ytd.sales.total,
      rate: target ? ytd.sales.total / target : null,
      expectedToDate,
      paceRate: expectedToDate ? ytd.sales.total / expectedToDate : null,
      remaining: Math.max(0, target - ytd.sales.total),
      monthsElapsed: elapsed,
      monthsLeft: Math.max(0, Math.ceil(12 - elapsed - 1e-9)),
    },
    yearElapsed,
    yearMonths: span(yStart, yEnd).map((i) => ({ month: mOf(i), ...aggregate(months, [i]), selected: i >= p.start && i <= p.end })),
    buckets: plan.map((b) => ({
      label: b.label, selected: b.selected, target: sum(b.idx.map(monthTarget)), ...aggregate(months, b.idx),
    })),
    salesFromDetailMonths: sel.filter((i) => months.get(i).salesFromDetail).map(ymStr),
    industry,
    series,
    customers: customers.slice(0, 10),
    receivables,
  };
}
