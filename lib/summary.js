import { db } from './db.js';

export const INDUSTRIES = ['상하수도', '발전소', '가스', '오일', '석유', '민간 플랜트', '기타'];
export const SALES_TYPES = ['제품', '상품', '용역'];
const SERIES_TOP_N = 7;

const pad = (n) => String(n).padStart(2, '0');
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export function periodMonths(mode, period) {
  if (mode === 'month') return [period];
  return [period * 3 - 2, period * 3 - 1, period * 3];
}

export function periodLabel(year, mode, period) {
  return mode === 'month' ? `${year}년 ${period}월` : `${year}년 ${period}분기`;
}

function emptyMonth() {
  return {
    product_purchase: 0, material_purchase: 0, expense: 0,
    ad_expense: 0, entertainment_expense: 0, other_expense: 0,
    product_sales: 0, goods_sales: 0, service_sales: 0,
  };
}

// 연도의 1~12월 데이터. 월별 매출 입력이 비어 있으면 매출내역 합계로 대체한다.
function loadYear(year) {
  const months = Array.from({ length: 12 }, () => ({ ...emptyMonth(), salesFromDetail: false }));
  for (const r of db.prepare('SELECT * FROM monthly WHERE year = ?').all(year)) {
    Object.assign(months[r.month - 1], r);
  }
  const detail = db.prepare(`
    SELECT CAST(substr(date, 6, 2) AS INTEGER) AS m, sales_type, SUM(amount) AS amt
    FROM sales WHERE substr(date, 1, 4) = ? GROUP BY m, sales_type`).all(String(year));
  const byMonth = {};
  for (const d of detail) (byMonth[d.m] ||= {})[d.sales_type] = d.amt;
  months.forEach((m, i) => {
    const d = byMonth[i + 1];
    if (d && m.product_sales + m.goods_sales + m.service_sales === 0) {
      m.product_sales = d['제품'] || 0;
      m.goods_sales = d['상품'] || 0;
      m.service_sales = d['용역'] || 0;
      m.salesFromDetail = true;
    }
  });
  return months;
}

function aggregate(months, list) {
  const pick = (k) => sum(list.map((mo) => months[mo - 1][k]));
  const sales = {
    product: pick('product_sales'),
    goods: pick('goods_sales'),
    service: pick('service_sales'),
  };
  sales.total = sales.product + sales.goods + sales.service;
  const costs = {
    productPurchase: pick('product_purchase'),
    materialPurchase: pick('material_purchase'),
    expense: pick('expense'),
    adExpense: pick('ad_expense'),
    entertainmentExpense: pick('entertainment_expense'),
    otherExpense: pick('other_expense'),
  };
  costs.etcTotal = costs.adExpense + costs.entertainmentExpense + costs.otherExpense;
  costs.total = costs.productPurchase + costs.materialPurchase + costs.expense + costs.etcTotal;
  return { sales, costs, profit: sales.total - costs.total };
}

function breakdown(year, monthList, field) {
  const ym = monthList.map((m) => `${year}-${pad(m)}`);
  const rows = db.prepare(`
    SELECT ${field} AS k, SUM(amount) AS amt FROM sales
    WHERE substr(date, 1, 7) IN (${ym.map(() => '?').join(',')})
    GROUP BY ${field} ORDER BY amt DESC`).all(...ym);
  return rows.map((r) => ({ label: r.k || '(미지정)', value: r.amt }));
}

function industryBreakdown(year, monthList) {
  const raw = Object.fromEntries(breakdown(year, monthList, 'industry').map((r) => [r.label, r.value]));
  // 고정 순서 → 색상이 항상 같은 분야를 가리키도록
  const known = INDUSTRIES.map((label) => ({ label, value: raw[label] || 0 }));
  const unknown = Object.entries(raw).filter(([k]) => !INDUSTRIES.includes(k)).reduce((a, [, v]) => a + v, 0);
  known[known.length - 1].value += unknown;
  return known;
}

function seriesBreakdown(year, monthList) {
  const rows = breakdown(year, monthList, 'series');
  if (rows.length <= SERIES_TOP_N) return rows;
  const head = rows.slice(0, SERIES_TOP_N - 1);
  const rest = sum(rows.slice(SERIES_TOP_N - 1).map((r) => r.value));
  return [...head, { label: '기타', value: rest }];
}

function receivablesStats(year, monthList, today) {
  const rows = db.prepare('SELECT * FROM receivables').all();
  const open = rows
    .map((r) => ({ ...r, balance: r.amount - r.collected }))
    .filter((r) => r.balance > 0.5);
  const days = (d) => Math.floor((today - new Date(d + 'T00:00:00')) / 86400000);
  const aging = [
    { label: '30일 이내', value: 0, count: 0 },
    { label: '31~60일', value: 0, count: 0 },
    { label: '61~90일', value: 0, count: 0 },
    { label: '90일 초과', value: 0, count: 0 },
  ];
  for (const r of open) {
    const d = days(r.invoice_date);
    const i = d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3;
    aging[i].value += r.balance;
    aging[i].count += 1;
  }
  const byCustomer = {};
  for (const r of open) {
    const c = (byCustomer[r.customer] ||= { customer: r.customer, balance: 0, count: 0, oldest: r.invoice_date });
    c.balance += r.balance;
    c.count += 1;
    if (r.invoice_date < c.oldest) c.oldest = r.invoice_date;
  }
  const ym = new Set(monthList.map((m) => `${year}-${pad(m)}`));
  const inPeriod = (d) => d && ym.has(d.slice(0, 7));
  const invoiced = sum(rows.filter((r) => inPeriod(r.invoice_date)).map((r) => r.amount));
  const collected = sum(rows.filter((r) => inPeriod(r.collected_date)).map((r) => r.collected));
  const overdue = open.filter((r) => r.due_date && new Date(r.due_date + 'T00:00:00') < today);
  return {
    outstanding: sum(open.map((r) => r.balance)),
    openCount: open.length,
    overdueAmount: sum(overdue.map((r) => r.balance)),
    overdueCount: overdue.length,
    aging,
    topCustomers: Object.values(byCustomer).sort((a, b) => b.balance - a.balance).slice(0, 8),
    period: { invoiced, collected },
  };
}

export function summarize(year, mode, period, today = new Date()) {
  const months = loadYear(year);
  const prevYearMonths = loadYear(year - 1);
  const target = db.prepare('SELECT revenue FROM targets WHERE year = ?').get(year)?.revenue || 0;

  const selMonths = periodMonths(mode, period);
  const endMonth = selMonths[selMonths.length - 1];
  const ytdMonths = Array.from({ length: endMonth }, (_, i) => i + 1);
  const allMonths = Array.from({ length: 12 }, (_, i) => i + 1);

  const bucketCount = mode === 'month' ? 12 : 4;
  const buckets = Array.from({ length: bucketCount }, (_, i) => {
    const p = i + 1;
    return { label: mode === 'month' ? `${p}월` : `${p}분기`, ...aggregate(months, periodMonths(mode, p)) };
  });

  const current = aggregate(months, selMonths);
  const prev = period > 1
    ? aggregate(months, periodMonths(mode, period - 1))
    : aggregate(prevYearMonths, periodMonths(mode, bucketCount));
  const lastYearSame = aggregate(prevYearMonths, selMonths);
  const ytd = aggregate(months, ytdMonths);
  const annual = aggregate(months, allMonths);

  // 진행 중인 기간이면 오늘까지 경과한 만큼만 기대치로 본다 (예: 10월 17일 → 9.5개월)
  let elapsed = endMonth;
  if (year === today.getFullYear() && endMonth >= today.getMonth() + 1) {
    const dim = new Date(year, today.getMonth() + 1, 0).getDate();
    elapsed = today.getMonth() + today.getDate() / dim;
  } else if (year > today.getFullYear()) {
    elapsed = 0;
  }
  const expectedToDate = target * (elapsed / 12);
  const periodTarget = target * (selMonths.length / 12);

  return {
    year, mode, period,
    label: periodLabel(year, mode, period),
    prevLabel: period > 1 ? periodLabel(year, mode, period - 1) : periodLabel(year - 1, mode, bucketCount),
    target,
    periodTarget,
    current, prev, lastYearSame, ytd, annual,
    achievement: {
      ytdSales: ytd.sales.total,
      rate: target ? ytd.sales.total / target : null,
      expectedToDate,
      paceRate: expectedToDate ? ytd.sales.total / expectedToDate : null,
      remaining: Math.max(0, target - ytd.sales.total),
      monthsElapsed: elapsed,
      monthsLeft: Math.max(0, Math.ceil(12 - elapsed - 1e-9)),
    },
    buckets,
    months: allMonths.map((m) => aggregate(months, [m])),
    salesFromDetailMonths: months.map((m, i) => (m.salesFromDetail ? i + 1 : null)).filter(Boolean),
    industry: { period: industryBreakdown(year, selMonths), year: industryBreakdown(year, ytdMonths) },
    series: { period: seriesBreakdown(year, selMonths), year: seriesBreakdown(year, ytdMonths) },
    customers: {
      period: breakdown(year, selMonths, 'customer').slice(0, 10),
      year: breakdown(year, ytdMonths, 'customer').slice(0, 10),
    },
    receivables: receivablesStats(year, selMonths, today),
  };
}
