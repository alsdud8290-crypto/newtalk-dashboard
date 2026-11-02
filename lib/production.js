// 생산팀 — ITB2026(생산·서비스 웹)의 production 기능을 옮겨 온 것
//  - 생산 실적: 기간 생산량(제조년월 기준) · 목표 대비 달성률·부족치 · 월별/분기별 · 연간 진행 · 모델별
//  - 납기·출고: 납기 준수율, 미출고 현황, 납기 임박, 납기 캘린더(출고일로 처리 상태 판단), 납기 검색
//  - 판매 실적: 수주서 제품 수량 (기준 날짜·거래처 기준·제품 묶음·비교 기간·교차 필터)
//  - 일련번호 조회(11개 항목), 제조내역·수주 내역 목록과 엑셀
// 날짜는 'YYYY-MM-DD' 글자로 저장·비교한다. 계산식은 원본(specs/09-metrics.md 3절)과 같다.
import { db, nowStr } from './db.js';

export class ProdError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const p2 = (n) => String(n).padStart(2, '0');
export const todayStr = () => nowStr().slice(0, 10);
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const daysBetween = (a, b) => dayNum(b) - dayNum(a); // b − a (일)
const addDays = (iso, n) => new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10);
const round1 = (v) => Math.round(v * 10) / 10;
const rate = (part, whole) => (whole ? round1(part / whole * 100) : null);
const NO_NAME = '(미입력)';

// ---------------- 기간 (당월·분기·연간, 분기는 일반 달력 기준) ----------------
export const quarterOf = (m) => Math.floor((m - 1) / 3) + 1;
export function makePeriod(kind, year, month = 1, quarter = 1) {
  let months;
  let label;
  if (kind === 'month') { months = [month]; label = `${year}년 ${month}월`; }
  else if (kind === 'quarter') { const f = (quarter - 1) * 3 + 1; months = [f, f + 1, f + 2]; label = `${year}년 ${quarter}분기`; }
  else { months = Array.from({ length: 12 }, (_, i) => i + 1); label = `${year}년`; }
  const last = months[months.length - 1];
  return { kind, year, months, label, start: `${year}-${p2(months[0])}-01`, end: `${year}-${p2(last)}-${p2(lastDay(year, last))}` };
}
function intParam(v, def, lo, hi, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new ProdError(400, `${name}는 ${lo}~${hi} 사이여야 합니다.`);
  return n;
}
// ?year=&period=month|quarter|year&month=&quarter= → 기간 (값이 없으면 오늘 기준)
export function periodFrom(q) {
  const t = todayStr();
  const kind = q.period || 'month';
  if (!['month', 'quarter', 'year'].includes(kind)) throw new ProdError(400, 'period는 month, quarter, year 중 하나여야 합니다.');
  const year = intParam(q.year, +t.slice(0, 4), 2000, 2100, '연도');
  const month = intParam(q.month, +t.slice(5, 7), 1, 12, '월');
  const quarter = intParam(q.quarter, quarterOf(month), 1, 4, '분기');
  return makePeriod(kind, year, month, quarter);
}
export const periodInfo = (p) => ({ kind: p.kind, label: p.label, start: p.start, end: p.end, months: p.months });

// 비교 기간: previous = 바로 앞 기간(전월·전 분기·전년), last_year = 전년 같은 기간
export function previousPeriod(p, compare) {
  if (compare === 'last_year' || p.kind === 'year') return makePeriod(p.kind, p.year - 1, p.months[0], quarterOf(p.months[0]));
  if (p.kind === 'month') return p.months[0] === 1 ? makePeriod('month', p.year - 1, 12) : makePeriod('month', p.year, p.months[0] - 1);
  const q = quarterOf(p.months[0]);
  return q === 1 ? makePeriod('quarter', p.year - 1, 1, 4) : makePeriod('quarter', p.year, 1, q - 1);
}
export const COMPARES = ['none', 'previous', 'last_year'];
export function choice(v, choices, def, name) {
  const x = v || def;
  if (!choices.includes(x)) throw new ProdError(400, `${name}는 ${choices.join(', ')} 중 하나여야 합니다.`);
  return x;
}

// ---------------- 연간 목표 생산량 ----------------
const targetOf = async (year) => (await db.get('SELECT target_quantity FROM prod_targets WHERE year = ?', year))?.target_quantity ?? null;
export async function getTarget(year) { return { year, target_quantity: await targetOf(year) }; }
export async function setTarget(year, body) {
  const v = Number(String(body.target_quantity ?? '').replace(/,/g, ''));
  if (!Number.isInteger(v) || v < 0 || v > 10_000_000) throw new ProdError(400, '연간 목표 생산량은 0 이상의 정수(대)로 입력해 주세요.');
  await db.run(`INSERT INTO prod_targets (year, target_quantity, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(year) DO UPDATE SET target_quantity = excluded.target_quantity, updated_at = excluded.updated_at`, year, v, nowStr());
  return getTarget(year);
}

// ---------------- 생산 실적 ----------------
const countMade = async (start, end) => Number((await db.get('SELECT COUNT(*) AS n FROM mfg_records WHERE manufactured_date BETWEEN ? AND ?', start, end)).n);

// 기간 생산량, 기간 목표(연간 ÷ 12 × 개월 수 — 기업 확인 전 임시 기준), 달성률, 부족치
async function productionSummary(p) {
  const actual = await countMade(p.start, p.end);
  const annual = await targetOf(p.year);
  if (annual === null) return { actual, annual_target: null, period_target: null, achievement_rate: null, shortfall: null };
  const periodTarget = annual * p.months.length / 12;
  return {
    actual,
    annual_target: annual,
    period_target: round1(periodTarget),
    achievement_rate: periodTarget ? round1(actual / periodTarget * 100) : null,
    shortfall: round1(Math.max(periodTarget - actual, 0)),
  };
}

async function monthlyCounts(year) {
  const rows = await db.all(`SELECT CAST(substr(manufactured_date, 6, 2) AS INTEGER) AS m, COUNT(*) AS n FROM mfg_records
                             WHERE substr(manufactured_date, 1, 4) = ? GROUP BY m`, String(year));
  return Object.fromEntries(rows.map((r) => [Number(r.m), Number(r.n)]));
}
// 월별 수주 수량 (수주서 납기일 기준 — 판매 실적 기본 기준과 같음)
async function monthlyOrders(year) {
  const rows = await db.all(`SELECT CAST(substr(o.due_date, 6, 2) AS INTEGER) AS m, SUM(i.quantity) AS n FROM sales_order_items i
                             JOIN sales_orders o ON o.id = i.order_id WHERE substr(o.due_date, 1, 4) = ? GROUP BY m`, String(year));
  return Object.fromEntries(rows.map((r) => [Number(r.m), Number(r.n)]));
}
async function monthlyProduction(year, withLastYear) {
  const [counts, orders, last, annual] = await Promise.all([monthlyCounts(year), monthlyOrders(year), withLastYear ? monthlyCounts(year - 1) : null, targetOf(year)]);
  return {
    months: Array.from({ length: 12 }, (_, i) => i + 1).map((m) => ({ month: m, actual: counts[m] || 0, orders: orders[m] || 0, ...(last ? { last_year: last[m] || 0 } : {}) })),
    monthly_target: annual !== null ? round1(annual / 12) : null,
  };
}
async function productionCompare(p, compare) {
  if (compare === 'none') return null;
  const q = previousPeriod(p, compare);
  const [previous, current] = await Promise.all([countMade(q.start, q.end), countMade(p.start, p.end)]);
  const change = current - previous;
  return { label: q.label, actual: previous, change, change_rate: previous ? round1(change / previous * 100) : null };
}

// 납기 준수율 (제조내역 1행 = 1대): 납기일이 기간에 있고 오늘까지 납기가 온 제품
//  기한 내 출고: 출고일 ≤ 납기일 / 늦게 출고: 출고일 > 납기일 / 미출고(납기 지남): 출고일 없음
//  평균 지연일 = 늦은 제품의 (출고일 또는 오늘) − 납기일 평균
async function deliveryPerformance(p, today = todayStr()) {
  const notDueYet = Number((await db.get('SELECT COUNT(*) AS n FROM mfg_records WHERE due_date BETWEEN ? AND ? AND due_date > ?', p.start, p.end, today)).n);
  const rows = await db.all('SELECT model_name, customer, due_date, shipped_date FROM mfg_records WHERE due_date BETWEEN ? AND ? AND due_date <= ?', p.start, p.end, today);
  const classify = (r) => (!r.shipped_date ? ['open', daysBetween(r.due_date, today)] : r.shipped_date <= r.due_date ? ['on_time', 0] : ['late', daysBetween(r.due_date, r.shipped_date)]);
  const summarize = (items) => {
    const k = items.map(classify);
    const onTime = k.filter(([x]) => x === 'on_time').length;
    const delays = k.filter(([x]) => x !== 'on_time').map(([, d]) => d);
    return {
      total: items.length, on_time: onTime, late: k.filter(([x]) => x === 'late').length, open: k.filter(([x]) => x === 'open').length,
      rate: rate(onTime, items.length), avg_delay_days: delays.length ? round1(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
    };
  };
  const by = (field) => {
    const groups = {};
    for (const r of rows) (groups[r[field] || NO_NAME] ||= []).push(r);
    // 준수율이 낮은 순 (같으면 대수가 많은 순) → 먼저 챙길 곳이 위로
    return Object.entries(groups).map(([name, items]) => ({ name, ...summarize(items) }))
      .sort((a, b) => (a.rate ?? 0) - (b.rate ?? 0) || b.total - a.total || a.name.localeCompare(b.name));
  };
  return { ...summarize(rows), not_due_yet: notDueYet, by_model: by('model_name'), by_customer: by('customer') };
}

// 미출고 현황 (오늘 기준): 오늘까지 제조됐고 출고일이 없는 제품, 경과일 = 오늘 − 제조년월
const UNSHIPPED_BUCKETS = [[0, 29, '30일 미만'], [30, 59, '30~59일'], [60, null, '60일 이상']];
async function unshippedStatus(today = todayStr()) {
  const rows = (await db.all(`SELECT serial_full, model_name, manufactured_date, due_date, customer FROM mfg_records
                              WHERE manufactured_date <= ? AND shipped_date IS NULL ORDER BY manufactured_date, serial_full`, today))
    .map((r) => ({ ...r, days: daysBetween(r.manufactured_date, today) }));
  const byModel = {};
  for (const r of rows) byModel[r.model_name || NO_NAME] = (byModel[r.model_name || NO_NAME] || 0) + 1;
  return {
    as_of: today,
    total: rows.length,
    buckets: UNSHIPPED_BUCKETS.map(([lo, hi, label]) => ({ label, count: rows.filter((r) => r.days >= lo && (hi === null || r.days <= hi)).length })),
    by_model: Object.entries(byModel).map(([name, quantity]) => ({ name, quantity })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name)),
    oldest: rows.slice(0, 5),
  };
}

// 연간 목표까지 남은 양 · 월 평균 필요량(남은 개월은 이번 달 포함) · 연말 예상(예측: 지금 속도가 이어진다고 가정)
async function yearProgress(year, today = todayStr()) {
  const ty = +today.slice(0, 4);
  const annual = await targetOf(year);
  let cumulative;
  let remainingMonths;
  if (year < ty) { cumulative = await countMade(`${year}-01-01`, `${year}-12-31`); remainingMonths = 0; }
  else if (year === ty) { cumulative = await countMade(`${year}-01-01`, today); remainingMonths = 12 - +today.slice(5, 7) + 1; }
  else { cumulative = 0; remainingMonths = 12; }
  const remaining = annual !== null ? Math.max(annual - cumulative, 0) : null;
  let forecast = null;
  if (year === ty) {
    const passed = daysBetween(`${year}-01-01`, today) + 1;
    const inYear = daysBetween(`${year}-01-01`, `${year + 1}-01-01`);
    forecast = Math.round(cumulative / passed * inYear);
  }
  return {
    year, is_current_year: year === ty, annual_target: annual, cumulative,
    as_of: year <= ty ? (year < ty ? `${year}-12-31` : today) : null,
    remaining, remaining_months: remainingMonths,
    required_per_month: remaining !== null && remainingMonths ? round1(remaining / remainingMonths) : null,
    forecast,
  };
}

async function productionByModel(p) {
  const rows = await db.all(`SELECT model_name, COUNT(*) AS n FROM mfg_records WHERE manufactured_date BETWEEN ? AND ?
                             GROUP BY model_name ORDER BY n DESC, model_name`, p.start, p.end);
  return rows.map((r) => ({ name: r.model_name || NO_NAME, quantity: Number(r.n) }));
}
export async function modelNames() {
  return (await db.all("SELECT DISTINCT model_name FROM mfg_records WHERE model_name <> '' ORDER BY model_name")).map((r) => r.model_name);
}

export async function dashboard(q) {
  const p = periodFrom(q);
  const compare = choice(q.compare, COMPARES, 'none', '비교');
  const [production, cmp, monthly, delivery, unshipped, progress, byModel, names] = await Promise.all([
    productionSummary(p), productionCompare(p, compare), monthlyProduction(p.year, compare !== 'none'),
    deliveryPerformance(p), unshippedStatus(), yearProgress(p.year), productionByModel(p), modelNames(),
  ]);
  return { period: periodInfo(p), production, compare: cmp, monthly, delivery, unshipped, year_progress: progress, by_model: byModel, model_names: names };
}

// ---------------- 판매 실적 (수주서 제품 수량) ----------------
export const INDUSTRIES = ['상하수도', '발전소', '가스', '오일', '석유', '민간 플랜트', '기타'];
// 수주서 "사업구분" 원문 → 7개 산업 분야 (낱말 포함 규칙, 위에서부터 먼저 맞는 것. 모르는 값은 기타 — 기업 확인 전 임시)
const KEYWORD_RULES = [['상하수도', '상하수도'], ['발전', '발전소'], ['가스', '가스'], ['오일', '오일'], ['석유', '석유'], ['플랜트', '민간 플랜트']];
export const toIndustry = (raw) => KEYWORD_RULES.find(([k]) => String(raw || '').includes(k))?.[1] || '기타';

const DATE_BASES = { due: 'due_date', order: 'order_date', delivery: 'delivery_date' };
const CUSTOMER_BASES = { customer: 'customer', final_orderer: 'final_orderer' };
const PRODUCT_GROUPS = ['name', 'model', 'size', 'type'];
const OTHER_FORMAT = '기타(형식 다름)';
// 품명 형식 "제수 150A: NTI-03" = 종류 구경: 모델 (확인 필요 — 형식이 다르면 "기타(형식 다름)")
const PRODUCT_NAME_RE = /^\s*(?<type>\S+)\s+(?<size>\d+A)\s*:\s*(?<model>\S+)\s*$/;
const productGroup = (name, group) => (group === 'name' ? (name || NO_NAME) : (String(name || '').match(PRODUCT_NAME_RE)?.groups?.[group] || OTHER_FORMAT));

export async function salesSummary(q) {
  const p = periodFrom(q);
  const dateBasis = choice(q.date_basis, Object.keys(DATE_BASES), 'due', '기준 날짜');
  const customerBasis = choice(q.customer_basis, Object.keys(CUSTOMER_BASES), 'customer', '거래처 기준');
  const group = choice(q.product_group, PRODUCT_GROUPS, 'name', '제품 묶음');
  const compare = choice(q.compare, COMPARES, 'none', '비교');
  const filt = { industry: q.industry || '', customer: q.customer || '', product: q.product || '' };
  const dateCol = DATE_BASES[dateBasis];
  const custCol = CUSTOMER_BASES[customerBasis];

  const itemsIn = (per) => db.all(`SELECT i.product_name, i.quantity, o.industry, o.${custCol} AS cust FROM sales_order_items i
                                   JOIN sales_orders o ON o.id = i.order_id WHERE o.${dateCol} BETWEEN ? AND ?`, per.start, per.end);
  // 교차 필터: 각 순위는 "자기 자신을 뺀 나머지 필터"만 적용 (산업 분야를 골라도 산업 분야 순위는 전체)
  const apply = (items, skip) => items.filter((it) => (!filt.industry || skip === 'industry' || it.industry === filt.industry)
    && (!filt.customer || skip === 'customer' || (it.cust || NO_NAME) === filt.customer)
    && (!filt.product || skip === 'product' || productGroup(it.product_name, group) === filt.product));
  const grouped = (items, key) => items.reduce((m, it) => { const k = key(it); m[k] = (m[k] || 0) + Number(it.quantity); return m; }, {});
  const periods = [p, ...(compare !== 'none' ? [previousPeriod(p, compare)] : [])];
  const results = [];
  for (const per of periods) {
    const base = await itemsIn(per);
    results.push({
      total: apply(base).reduce((a, it) => a + Number(it.quantity), 0),
      by_industry: grouped(apply(base, 'industry'), (it) => it.industry || NO_NAME),
      by_customer: grouped(apply(base, 'customer'), (it) => it.cust || NO_NAME),
      by_product: grouped(apply(base, 'product'), (it) => productGroup(it.product_name, group)),
    });
  }
  const [cur, prev] = results;
  const ranking = (c, pv) => Object.entries(c).map(([name, quantity]) => ({
    name, quantity, previous: pv ? (pv[name] || 0) : null, change: pv ? quantity - (pv[name] || 0) : null,
  })).sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  // 고른 날짜가 비어 있어 이 기준으로는 셀 수 없는 수주서 수 (화면에 안내)
  const missing = Number((await db.get(`SELECT COUNT(*) AS n FROM sales_orders WHERE ${dateCol} IS NULL OR ${dateCol} = ''`)).n);
  const sales = {
    total: cur.total,
    by_industry: ranking(cur.by_industry, prev?.by_industry),
    by_customer: ranking(cur.by_customer, prev?.by_customer),
    by_product: ranking(cur.by_product, prev?.by_product),
    missing_date_orders: missing,
  };
  if (prev) sales.compare = { label: periods[1].label, total: prev.total, change: cur.total - prev.total };
  return { period: periodInfo(p), sales };
}

// ---------------- 납기 캘린더 · 납기 임박 · 납기 검색 ----------------
// 제조내역의 납기일을 날짜별·수주번호(PO번호)별로 묶는다 (행 수 = 그 수주의 납기 대수)
// 처리 상태(출고일로 판단): done 모두 출고 / partial 일부 / pending 출고 전 / overdue 출고가 안 끝났는데 납기 지남
const DUE_SOON_DAYS = 14;
const OVERDUE_LOOKBACK_DAYS = 30;
const SEARCH_LIMIT = 50;
function groupOrders(records, today) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.due_date}|${r.po_no}`;
    if (!groups.has(key)) groups.set(key, { due_date: r.due_date, po_no: r.po_no, customers: [], projects: [], serials: [], shipped: 0 });
    const g = groups.get(key);
    g.serials.push(r.serial_full);
    if (r.shipped_date) g.shipped += 1;
    if (r.customer && !g.customers.includes(r.customer)) g.customers.push(r.customer);
    if (r.project_name && !g.projects.includes(r.project_name)) g.projects.push(r.project_name);
  }
  return [...groups.values()].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.po_no.localeCompare(b.po_no)).map((g) => {
    const quantity = g.serials.length;
    const status = g.shipped === quantity ? 'done' : g.shipped ? 'partial' : 'pending';
    return { ...g, quantity, status, overdue: status !== 'done' && g.due_date < today };
  });
}
const DUE_COLS = 'serial_full, po_no, due_date, shipped_date, customer, project_name';
export async function dueCalendar(q) {
  const p = periodFrom({ ...q, period: 'month' });
  const today = todayStr();
  const records = await db.all(`SELECT ${DUE_COLS} FROM mfg_records WHERE due_date BETWEEN ? AND ? ORDER BY due_date, po_no, serial_full`, p.start, p.end);
  const days = {};
  for (const o of groupOrders(records, today)) (days[o.due_date] ||= []).push(o);
  return { year: p.year, month: p.months[0], today, days: Object.entries(days).map(([date, orders]) => ({ date, orders })) };
}
export async function dueSoon() {
  const today = todayStr();
  const records = await db.all(`SELECT ${DUE_COLS} FROM mfg_records WHERE due_date BETWEEN ? AND ? ORDER BY due_date, po_no, serial_full`,
    addDays(today, -OVERDUE_LOOKBACK_DAYS), addDays(today, DUE_SOON_DAYS));
  const items = groupOrders(records, today).filter((o) => o.status !== 'done')
    .map(({ serials, ...o }) => ({ ...o, d_day: daysBetween(today, o.due_date) }));
  return { days: DUE_SOON_DAYS, items };
}
// 수주번호(# 없이도)·판매처·사업명·일련번호·거래처 주문번호로 모든 달에서 찾기 (최근 납기일부터 최대 50건)
export async function searchDue(qs) {
  const q = String(qs || '').trim();
  const po = q.replace(/^#+/, '');
  if (!po) throw new ProdError(400, '검색어를 입력해 주세요.');
  const like = (s) => `%${s.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const matched = await db.all(`SELECT DISTINCT due_date, po_no FROM mfg_records WHERE due_date IS NOT NULL AND (
    po_no LIKE ? ESCAPE '\\' OR customer LIKE ? ESCAPE '\\' OR project_name LIKE ? ESCAPE '\\' OR serial_full LIKE ? ESCAPE '\\' OR customer_order_no LIKE ? ESCAPE '\\')`,
  like(po), like(q), like(q), like(q.toUpperCase()), like(q));
  const keys = matched.sort((a, b) => b.due_date.localeCompare(a.due_date) || b.po_no.localeCompare(a.po_no)).slice(0, SEARCH_LIMIT);
  const keySet = new Set(keys.map((k) => `${k.due_date}|${k.po_no}`));
  const dates = [...new Set(keys.map((k) => k.due_date))];
  const records = dates.length ? (await db.all(`SELECT ${DUE_COLS} FROM mfg_records WHERE due_date IN (${dates.map(() => '?').join(',')}) ORDER BY due_date, po_no, serial_full`, ...dates))
    .filter((r) => keySet.has(`${r.due_date}|${r.po_no}`)) : [];
  const today = todayStr();
  return { query: q, total: matched.length, limit: SEARCH_LIMIT, results: groupOrders(records, today).reverse().map((o) => ({ ...o, d_day: daysBetween(today, o.due_date) })) };
}

// ---------------- 일련번호 조회 ----------------
// 숫자 1~4자리면 4자리 번호로(1 → 0001), 그 외는 전체 번호로 (대소문자 무관, 최대 50건, 최근 제조 순)
export async function searchSerials(qs) {
  const q = String(qs || '').trim().toUpperCase();
  if (!q) return { results: [], limit: SEARCH_LIMIT };
  const rows = /^\d{1,4}$/.test(q)
    ? await db.all('SELECT * FROM mfg_records WHERE serial_short = ? ORDER BY manufactured_date DESC, serial_full LIMIT ?', q.padStart(4, '0'), SEARCH_LIMIT)
    : await db.all('SELECT * FROM mfg_records WHERE serial_full = ? LIMIT ?', q, SEARCH_LIMIT);
  return { results: rows.map((r) => ({ serial_full: r.serial_full, model_name: r.model_name, manufactured_date: r.manufactured_date, customer: r.customer, project_name: r.project_name })), limit: SEARCH_LIMIT };
}
// 부시 가공 숫자 6자리 → 엑셀 표시 형식과 같게 (301008 → Ø30x10x08)
export const formatBush = (v) => (/^\d{6}$/.test(v || '') ? `Ø${v.slice(0, 2)}x${v.slice(2, 4)}x${v.slice(4, 6)}` : v);
export async function serialDetail(serial) {
  const r = await db.get('SELECT * FROM mfg_records WHERE serial_full = ?', String(serial || '').toUpperCase());
  if (!r) throw new ProdError(404, '없는 일련번호입니다.');
  // 플랜지는 제조내역 엑셀에 열이 없어 수주서에서 보완: 임시로 "수주서류 번호 = 제조내역 PO번호"로 잇는다 (기업 확인 필요)
  let flange = null;
  if (r.po_no) {
    const fl = await db.all(`SELECT DISTINCT i.flange FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id
                             WHERE o.order_doc_no = ? AND i.flange <> '' ORDER BY i.flange`, r.po_no);
    flange = fl.map((x) => x.flange).join(', ') || null;
  }
  return {
    serial_full: r.serial_full,
    items: [
      { no: 1, label: '제품 사양', value: { 모델명: r.model_name, '부시 가공': formatBush(r.bush_machining), rpm: r.rpm, 전원: r.power, Flange: flange } },
      { no: 2, label: '제조년월', value: r.manufactured_date || '' },
      { no: 3, label: '검사일자', value: r.inspection_date || '' },
      { no: 4, label: '검사번호', value: r.inspection_no },
      { no: 5, label: '수주번호', value: { PO번호: r.po_no ? `#${r.po_no}` : '', SO번호: r.so_no } },
      { no: 6, label: '판매처', value: r.customer },
      { no: 7, label: '최종발주처', value: r.final_orderer },
      { no: 8, label: '사업명', value: r.project_name },
      { no: 9, label: '출고일자', value: r.shipped_date || '' },
      { no: 10, label: '납기일자', value: r.due_date || '' },
      { no: 11, label: '비고', value: r.note },
    ],
  };
}

// ---------------- 목록 (제조내역: 제조년월 기준 / 수주 내역: 납기일 기준) ----------------
const PAGE_SIZE = 100;
const likeOf = (s) => `%${s.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
function pageOf(q) {
  const raw = String(q.page || '1');
  if (!/^\d+$/.test(raw) || +raw < 1) throw new ProdError(400, 'page는 1 이상의 숫자여야 합니다.');
  return +raw;
}
function recordWhere(p, q) {
  const where = ['manufactured_date BETWEEN ? AND ?'];
  const args = [p.start, p.end];
  const text = String(q.q || '').trim().replace(/^#+/, '');
  if (text) {
    where.push(`(${['serial_full', 'customer', 'final_orderer', 'project_name', 'po_no', 'customer_order_no'].map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    args.push(...Array(6).fill(likeOf(text)));
  }
  if (q.model) { where.push('model_name = ?'); args.push(q.model === NO_NAME ? '' : q.model); }
  return { where, args };
}
export async function recordList(q) {
  const p = periodFrom(q);
  const page = pageOf(q);
  const { where, args } = recordWhere(p, q);
  const shipped = q.shipped || '';
  if (!['', 'yes', 'no'].includes(shipped)) throw new ProdError(400, 'shipped는 yes 또는 no여야 합니다.');
  // 출고 상태 버튼에 붙일 건수는 출고 상태로 거르기 전 기준
  const c = await db.get(`SELECT COUNT(*) AS total, SUM(CASE WHEN shipped_date IS NOT NULL THEN 1 ELSE 0 END) AS shipped FROM mfg_records WHERE ${where.join(' AND ')}`, ...args);
  if (shipped) where.push(`shipped_date IS ${shipped === 'yes' ? 'NOT ' : ''}NULL`);
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM mfg_records WHERE ${where.join(' AND ')}`, ...args)).n);
  const rows = await db.all(`SELECT * FROM mfg_records WHERE ${where.join(' AND ')} ORDER BY manufactured_date DESC, serial_full DESC LIMIT ? OFFSET ?`, ...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return {
    period: periodInfo(p),
    counts: { total: Number(c.total), shipped: Number(c.shipped || 0), not_shipped: Number(c.total) - Number(c.shipped || 0) },
    results: rows.map((r) => ({ serial_full: r.serial_full, model_name: r.model_name, manufactured_date: r.manufactured_date, inspection_date: r.inspection_date,
      customer: r.customer, project_name: r.project_name, po_no: r.po_no, due_date: r.due_date, shipped_date: r.shipped_date })),
    page, page_size: PAGE_SIZE, total, model_names: await modelNames(),
  };
}
export const RECORD_COLUMNS = [
  ['일련번호', 'serial_full', 13], ['모델명', 'model_name', 10], ['부시 가공', 'bush_machining', 10], ['rpm', 'rpm', 8], ['전원', 'power', 12],
  ['제조년월', 'manufactured_date', 12], ['검사일자', 'inspection_date', 12], ['검사번호', 'inspection_no', 11], ['뉴토크 PO번호', 'po_no', 12],
  ['SO번호', 'so_no', 12], ['거래처 주문번호', 'customer_order_no', 14], ['거래처', 'customer', 18], ['최종발주처', 'final_orderer', 18],
  ['사업명', 'project_name', 24], ['납기일', 'due_date', 12], ['출고일', 'shipped_date', 12], ['비고', 'note', 20],
];
export async function recordExportRows(q) {
  const p = periodFrom(q);
  const { where, args } = recordWhere(p, q);
  if (q.shipped === 'yes' || q.shipped === 'no') where.push(`shipped_date IS ${q.shipped === 'yes' ? 'NOT ' : ''}NULL`);
  return { label: p.label, rows: await db.all(`SELECT * FROM mfg_records WHERE ${where.join(' AND ')} ORDER BY manufactured_date DESC, serial_full DESC`, ...args) };
}

function orderWhere(p, q) {
  const where = ['o.due_date BETWEEN ? AND ?'];
  const args = [p.start, p.end];
  const text = String(q.q || '').trim().replace(/^#+/, '');
  if (text) {
    where.push(`(${['o.sales_no', 'o.order_doc_no', 'o.customer', 'o.final_orderer', 'o.project_name'].map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')}
      OR EXISTS (SELECT 1 FROM sales_order_items x WHERE x.order_id = o.id AND x.product_name LIKE ? ESCAPE '\\'))`);
    args.push(...Array(6).fill(likeOf(text)));
  }
  if (q.industry) { where.push('o.industry = ?'); args.push(q.industry); }
  return { where, args };
}
async function withItems(orders) {
  if (!orders.length) return [];
  const items = await db.all(`SELECT * FROM sales_order_items WHERE order_id IN (${orders.map(() => '?').join(',')}) ORDER BY id`, ...orders.map((o) => o.id));
  const by = items.reduce((m, i) => ((m[i.order_id] ||= []).push(i), m), {});
  return orders.map((o) => {
    const its = (by[o.id] || []).map(({ product_name, quantity, power, flange, rpm_ot, stem_bush }) => ({ product_name, quantity: Number(quantity), power, flange, rpm_ot, stem_bush }));
    return { ...o, items: its, quantity: its.reduce((a, i) => a + i.quantity, 0) };
  });
}
export async function orderList(q) {
  const p = periodFrom(q);
  const page = pageOf(q);
  const { where, args } = orderWhere(p, q);
  const w = where.join(' AND ');
  const total = Number((await db.get(`SELECT COUNT(*) AS n FROM sales_orders o WHERE ${w}`, ...args)).n);
  const qty = Number((await db.get(`SELECT SUM(i.quantity) AS n FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id WHERE ${w}`, ...args)).n || 0);
  const rows = await db.all(`SELECT o.* FROM sales_orders o WHERE ${w} ORDER BY o.due_date DESC, o.sales_no LIMIT ? OFFSET ?`, ...args, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return { period: periodInfo(p), counts: { total, quantity: qty }, results: await withItems(rows), page, page_size: PAGE_SIZE, total, industries: INDUSTRIES };
}
export const ORDER_COLUMNS = [
  ['판매번호', 'sales_no', 16], ['수주서류 번호', 'order_doc_no', 12], ['수주일', 'order_date', 12], ['산업 분야', 'industry', 10], ['사업구분 원문', 'business_type_raw', 16],
  ['판매처', 'customer', 18], ['최종발주처/EPC', 'final_orderer', 18], ['사업명', 'project_name', 24], ['납기일', 'due_date', 12], ['납품일/출장일', 'delivery_date', 12],
  ['품명', 'item.product_name', 22], ['수량', 'item.quantity', 8], ['전원', 'item.power', 12], ['Flange', 'item.flange', 10], ['RPM/OT', 'item.rpm_ot', 10], ['스템/부시가공', 'item.stem_bush', 14],
];
// 수주서 1건에 제품이 여러 개면 엑셀에서는 제품 1개 = 1행 (주문 정보는 행마다 반복)
export async function orderExportRows(q) {
  const p = periodFrom(q);
  const { where, args } = orderWhere(p, q);
  const orders = await withItems(await db.all(`SELECT o.* FROM sales_orders o WHERE ${where.join(' AND ')} ORDER BY o.due_date DESC, o.sales_no`, ...args));
  const rows = orders.flatMap((o) => (o.items.length ? o.items : [null]).map((it) => Object.fromEntries(ORDER_COLUMNS.map(([, k]) => [k, k.startsWith('item.') ? (it ? it[k.slice(5)] : '') : o[k]]))));
  return { label: p.label, rows };
}

// 데이터가 있는 가장 이른 연도 (연도 선택 목록용)
export async function earliestYear() {
  const r = await db.get(`SELECT MIN(y) AS y FROM (SELECT MIN(substr(manufactured_date, 1, 4)) AS y FROM mfg_records
                          UNION ALL SELECT MIN(substr(due_date, 1, 4)) FROM sales_orders)`);
  return r?.y ? Number(r.y) : null;
}

// ---------------- 가상 데이터 (처음 한 번, 올해·작년) ----------------
// 실제 기업 데이터가 아니다. 일련번호는 5001번부터, 판매번호는 V를 넣어 실제 번호와 구분한다
const CUSTOMERS = ['가람상수도사업소', '나래정수센터', '다온발전', '라온가스', '마루플랜트', '바다석유화학'];
const MODELS = ['NTI-01', 'NTI-02', 'NTI-03', 'NTI-04', 'NTI-05'];
const ORDER_CUSTOMERS = [['가람상수도사업소', '상하수도(지자체)'], ['나래정수센터', '상하수도(지자체)'], ['다온발전', '발전소'], ['라온가스', '가스'],
  ['마루플랜트', '민간 플랜트'], ['바다석유화학', '석유화학'], ['사랑오일', '오일'], ['아름엔지니어링', '건축']];
const PRODUCTS = ['제수 150A: NTI-03', '제수 200A: NTI-04', '버터플라이 300A: NTI-05', '게이트 100A: NTI-02'];
function rng(seed) { // 같은 연도면 같은 가상 데이터
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}
async function seedYear(year, target, today) {
  const r = rng(year);
  const yy = String(year).slice(2);
  const lastMonth = year === +today.slice(0, 4) ? +today.slice(5, 7) : 12;
  const recs = [];
  let seq = 5001;
  for (let m = 1; m <= lastMonth; m += 1) {
    for (let k = r.int(15, 35); k > 0; k -= 1) {
      const last = year === +today.slice(0, 4) && m === lastMonth ? +today.slice(8, 10) : 28;
      const made = `${year}-${p2(m)}-${p2(r.int(1, last))}`;
      const due = addDays(made, r.int(5, 20));
      let shipped = addDays(due, -2);
      const late = due >= addDays(today, -7) && r.next() < 0.4;
      if (shipped > today || late) shipped = null;
      const short = p2(seq).padStart(4, '0');
      recs.push([`N82${yy}${short}`, short, r.pick(MODELS), made, made, `NTK${yy}${String(seq % 1000).padStart(3, '0')}`, `${yy}${String(r.int(1, 300)).padStart(3, '0')}`,
        r.pick(CUSTOMERS), '가상 사업', due, shipped, '가상데이터']);
      seq += 1;
    }
  }
  await db.batch([
    ...recs.map((v) => [`INSERT OR IGNORE INTO mfg_records (serial_full, serial_short, model_name, manufactured_date, inspection_date, inspection_no, po_no, customer, project_name, due_date, shipped_date, source_sheet)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, v]),
    ['INSERT OR IGNORE INTO prod_targets (year, target_quantity) VALUES (?, ?)', [year, target]],
  ]);
  let count = 0;
  for (let m = 1; m <= lastMonth; m += 1) {
    for (let k = r.int(3, 7); k > 0; k -= 1) {
      count += 1;
      const [customer, bt] = r.pick(ORDER_CUSTOMERS);
      const due = `${year}-${p2(m)}-${p2(r.int(1, 28))}`;
      const res = await db.run(`INSERT OR IGNORE INTO sales_orders (sales_no, order_doc_no, order_date, business_type_raw, industry, customer, final_orderer, project_name, due_date)
                                VALUES (?,?,?,?,?,?,?,?,?)`, `NTK-SO-V${yy}${String(count).padStart(3, '0')}`, `${yy}${String(r.int(1, 300)).padStart(3, '0')}`,
      addDays(due, -r.int(20, 60)), bt, toIndustry(bt), customer, customer, '가상 사업', due);
      if (!res.changes) continue;
      const products = [...PRODUCTS].sort(() => r.next() - 0.5).slice(0, r.int(1, 2));
      await db.batch(products.map((pn) => ['INSERT INTO sales_order_items (order_id, product_name, quantity, power, flange, rpm_ot) VALUES (?,?,?,?,?,?)',
        [res.lastInsertRowid, pn, r.int(1, 6), '380/3/60', 'F10A', '29']]));
    }
  }
}
export async function seedVirtualProduction() {
  if (await db.get('SELECT 1 FROM mfg_records LIMIT 1')) return;
  const today = todayStr();
  const y = +today.slice(0, 4);
  await seedYear(y - 1, 280, today);
  await seedYear(y, 300, today);
}
