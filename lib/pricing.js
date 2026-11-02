// 단가 — ITB2026(생산·서비스 웹)의 pricing·service 단가 기능을 옮겨 온 것
//  1) 제품 단가·원가: 기업 제품 가격 계산표 재현 (원재료 USD → 판매가 → 특별할인가, 커미션·이익)
//  2) 부품 단가: 뉴토크 기준값(단가표 기준단가 × (1 − 할인율) + 추가단가)과 출장지(업체)별 단가 비교
// 금액 계산은 소수까지 정확히(decimal.js) 하고, 화면에는 원 단위로 보여 준다.
// 실제 단가표·원가는 대외비라 넣지 않는다. 처음 실행 시 가상 값(모델·파트넘버 "VX…")만 만든다.
import DecimalBase from 'decimal.js';
import { db, nowStr } from './db.js';

const D = DecimalBase.clone({ precision: 40 });
const dec = (v) => new D(v ?? 0);
const won = (v) => Number(dec(v).toDecimalPlaces(0, D.ROUND_HALF_UP));
const roundTo = (v, unit, rounding) => Number(dec(v).div(unit).toDecimalPlaces(0, rounding).mul(unit));
const round1 = (v) => Number(dec(v).toDecimalPlaces(1, D.ROUND_HALF_UP));
const today = () => nowStr().slice(0, 10);

export class PricingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ======================================================================
// 1) 제품 단가·원가
// ======================================================================
// 계산 순서 (기업 계산표 그대로):
// 1. 원화 = 원재료(USD) × 환율 (원재료: Assembly 기본, Complete 선택)
// 2. 옵션 반영 = 원화 + 옵션(USD) × 환율 (옵션 단위·단계는 확인 필요)
// 3. 통관 = 옵션 반영 × 통관 배수
// 4. 원가(판관비 반영) = 통관 × (1 + 판관비율 ÷ 100)
// 5. 마진 반영 = 원가 ÷ 마진 값
// 6. 판매가 = 마진 반영을 올림 단위(천원)로 올림
// 7. 특별할인가 = 판매가 × (1 − 특별할인율 ÷ 100)을 올림 단위로 올림
// 커미션(판매금액 기준): 이익 = 판매금액 − 마진 반영 금액, 커미션 = 판매금액 × 커미션율 ÷ 100을 만원 단위 버림,
//                     커미션 차감 이익 = 이익 − 커미션, 마진율(제안) = 차감 이익 ÷ 판매금액 × 100
export const STEPS = [
  ['krw', '원화 환산'], ['with_option', '옵션 반영'], ['customs', '통관'], ['cost', '원가(판관비 반영)'],
  ['margin_price', '마진 반영'], ['sale_price', '판매가'], ['special_price', '특별할인가'],
];

export function computeSteps(usd, s, optionUsd = 0) {
  const rate = dec(s.exchange_rate);
  const krw = dec(usd).mul(rate);
  const withOption = krw.plus(dec(optionUsd).mul(rate));
  const customs = withOption.mul(dec(s.customs_factor));
  const cost = customs.mul(dec(1).plus(dec(s.sga_rate).div(100)));
  const marginPrice = cost.div(dec(s.margin));
  const unit = s.price_round_unit || 1000;
  const salePrice = roundTo(marginPrice, unit, D.ROUND_CEIL);
  const specialPrice = roundTo(dec(salePrice).mul(dec(1).minus(dec(s.special_discount_rate).div(100))), unit, D.ROUND_CEIL);
  return { krw, with_option: withOption, customs, cost, margin_price: marginPrice, sale_price: salePrice, special_price: specialPrice };
}

export function computeCommission(saleAmount, marginPrice, s) {
  const sale = dec(saleAmount);
  const profit = sale.minus(dec(marginPrice));
  const commission = roundTo(sale.mul(dec(s.commission_rate)).div(100), s.commission_unit || 10000, D.ROUND_FLOOR);
  const net = profit.minus(commission);
  return {
    sale_amount: won(sale),
    supply_price: won(marginPrice),
    profit: won(profit),
    commission,
    net_profit: won(net),
    margin_rate: sale.isZero() ? null : round1(net.div(sale).mul(100)),
  };
}

const currentSetting = () => db.get('SELECT * FROM price_settings ORDER BY effective_date DESC LIMIT 1');
async function requireSetting() {
  const s = await currentSetting();
  if (!s) throw new PricingError(404, '제품 가격 기준값이 없습니다. 관리자가 가격 계산표를 먼저 넣어야 합니다.');
  return s;
}
const settingJson = (s) => ({
  effective_date: s.effective_date,
  exchange_rate: Number(s.exchange_rate),
  customs_factor: Number(s.customs_factor),
  sga_rate: Number(s.sga_rate),
  margin: Number(s.margin),
  special_discount_rate: Number(s.special_discount_rate),
  price_round_unit: Number(s.price_round_unit),
  commission_rate: Number(s.commission_rate),
  commission_unit: Number(s.commission_unit),
});

// 쿼리 숫자: 비었으면 null, low < 값 <= high
function decimalParam(raw, name, low, high) {
  if (raw === undefined || raw === null || raw === '') return null;
  let v;
  try { v = dec(String(raw).trim()); } catch { throw new PricingError(400, `${name}는 숫자여야 합니다.`); }
  if (!v.isFinite() || !(v.gt(low) && v.lte(high))) throw new PricingError(400, `${name}는 ${low}보다 크고 ${high} 이하여야 합니다.`);
  return v.toString();
}

// 대외비 열람 기록: 같은 사람은 10분에 한 번만 (시뮬레이션 값을 바꿀 때마다 API를 부르므로)
export async function logAccess(userId) {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const sinceStr = `${since.getFullYear()}-${p(since.getMonth() + 1)}-${p(since.getDate())} ${p(since.getHours())}:${p(since.getMinutes())}:${p(since.getSeconds())}`;
  if (!(await db.get('SELECT 1 FROM price_access_log WHERE user_id = ? AND viewed_at >= ?', userId, sinceStr))) {
    await db.run('INSERT INTO price_access_log (user_id, viewed_at) VALUES (?, ?)', userId, nowStr());
  }
}

// GET 제품 단가표 (+ 시뮬레이션: 환율·마진·옵션·원재료 기준을 바꿔 다시 계산만, 저장하지 않음)
export async function productPrices(query) {
  const s = await requireSetting();
  const exchangeRate = decimalParam(query.exchange_rate, '환율', 0, 100000);
  const margin = decimalParam(query.margin, '마진 값', 0, 1);
  const base = query.base || 'assembly';
  if (!['assembly', 'complete'].includes(base)) throw new PricingError(400, '원재료 기준은 assembly 또는 complete여야 합니다.');
  let option = null;
  if (query.option) {
    option = await db.get('SELECT * FROM product_options WHERE name = ?', String(query.option));
    if (!option) throw new PricingError(400, '없는 옵션입니다.');
  }
  const sim = { ...s, ...(exchangeRate ? { exchange_rate: exchangeRate } : {}), ...(margin ? { margin } : {}) };
  const simulating = !!(exchangeRate || margin || base !== 'assembly' || option);

  const models = await db.all('SELECT * FROM product_models ORDER BY sort_order, model_name');
  const rows = [];
  const commissions = [];
  for (const m of models) {
    const usd = base === 'complete' ? m.complete_usd : m.assembly_usd;
    const standard = computeSteps(m.assembly_usd, s);
    if (usd === null || usd === undefined || usd === '') {
      rows.push({ model_name: m.model_name, series: m.series, usd: null, steps: null, standard_sale_price: standard.sale_price, change: null });
      continue;
    }
    const steps = computeSteps(usd, sim, option ? option.price_usd : 0);
    rows.push({
      model_name: m.model_name,
      series: m.series,
      usd: Number(usd),
      steps: Object.fromEntries(STEPS.map(([k]) => [k, won(steps[k])])),
      standard_sale_price: standard.sale_price,
      change: steps.sale_price - standard.sale_price,
    });
    if (m.sale_price) commissions.push({ model_name: m.model_name, ...computeCommission(m.sale_price, standard.margin_price, s) });
  }
  const options = await db.all('SELECT * FROM product_options ORDER BY sort_order, name');
  return {
    setting: settingJson(s),
    simulation: { active: simulating, exchange_rate: Number(sim.exchange_rate), margin: Number(sim.margin), base, option: option ? option.name : '' },
    steps: STEPS.map(([key, label]) => ({ key, label })),
    options: options.map((o) => ({ name: o.name, price_usd: Number(o.price_usd) })),
    margin_choices: JSON.parse(s.margin_choices || '[]'),
    series: [...new Set(models.map((m) => m.series))],
    models: rows,
    commissions,
  };
}

// GET 판매금액을 넣어 이익·커미션 계산 (현재 기준값)
export async function commissionCalc(query) {
  const s = await requireSetting();
  const m = await db.get('SELECT * FROM product_models WHERE model_name = ?', String(query.model || ''));
  if (!m) throw new PricingError(400, '모델을 골라 주세요.');
  const sale = decimalParam(query.sale_amount, '판매금액', 0, 10_000_000_000);
  if (!sale) throw new PricingError(400, '판매금액을 입력해 주세요.');
  return { model_name: m.model_name, ...computeCommission(sale, computeSteps(m.assembly_usd, s).margin_price, s) };
}

// 화면에서 바꿀 수 있는 기준값 (반올림·버림 단위와 마진 선택 목록은 지금 값을 그대로 이어 쓴다)
export const EDITABLE = [['exchange_rate', '환율', 1, 100000], ['customs_factor', '통관 배수', 1, 10], ['sga_rate', '판관비율', 0, 1000],
  ['margin', '마진 값', 0.01, 1], ['special_discount_rate', '특별할인율', 0, 100], ['commission_rate', '커미션율', 0, 100]];

export async function settingHistory() {
  const list = await db.all(`SELECT s.*, u.name AS user_name FROM price_settings s LEFT JOIN users u ON u.id = s.created_by
                             ORDER BY s.effective_date DESC`);
  return {
    fields: EDITABLE.map(([key, label]) => ({ key, label })),
    settings: list.map((s, i) => {
      const prev = list[i + 1];
      return {
        id: s.id,
        ...settingJson(s),
        note: s.note,
        created_by: s.user_name || '계산표 파일',
        created_at: s.created_at,
        changes: prev ? EDITABLE.filter(([k]) => !dec(prev[k]).eq(dec(s[k])))
          .map(([k, label]) => ({ label, old: Number(prev[k]), new: Number(s[k]) })) : [],
      };
    }),
  };
}

// POST 기준값 바꾸기 → 새 적용일로 저장 (같은 적용일이 있으면 그 줄을 고친다)
export async function saveSetting(body, userId) {
  const base = await requireSetting();
  const date = String(body.effective_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PricingError(400, '적용일을 입력해 주세요.');
  if (date > today()) throw new PricingError(400, '적용일은 오늘이나 그 이전 날짜여야 합니다.');
  if (date < base.effective_date) throw new PricingError(400, `적용일은 지금 기준값 적용일(${base.effective_date}) 이후여야 합니다.`);
  const values = {};
  for (const [k, label, lo, hi] of EDITABLE) {
    let v;
    try { v = dec(String(body[k] ?? '').trim()); } catch { throw new PricingError(400, `${label}는 숫자여야 합니다.`); }
    if (!v.isFinite() || v.lt(lo) || v.gt(hi)) throw new PricingError(400, `${label}는 ${lo} 이상 ${hi} 이하여야 합니다.`);
    values[k] = v.toString();
  }
  if (EDITABLE.every(([k]) => dec(values[k]).eq(dec(base[k])))) throw new PricingError(400, '바뀐 값이 없습니다.');
  const note = String(body.note || '').trim().slice(0, 200);
  const cols = EDITABLE.map(([k]) => k);
  await db.run(`INSERT INTO price_settings (effective_date, ${cols.join(', ')}, price_round_unit, commission_unit, margin_choices, note, created_by, created_at)
                VALUES (?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(effective_date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')},
                  note = excluded.note, created_by = excluded.created_by, created_at = excluded.created_at`,
  date, ...cols.map((c) => values[c]), base.price_round_unit, base.commission_unit, base.margin_choices, note, userId, nowStr());
  return settingHistory();
}

export async function accessLog() {
  const logs = await db.all(`SELECT l.viewed_at, u.name, u.username, u.dept FROM price_access_log l JOIN users u ON u.id = l.user_id
                             ORDER BY l.viewed_at DESC, l.id DESC LIMIT 100`);
  return { logs: logs.map((l) => ({ user: l.name, username: l.username, role: l.dept, viewed_at: l.viewed_at })) };
}

// ======================================================================
// 2) 부품 단가 — 뉴토크 기준값과 출장지(업체)별 단가
// ======================================================================
// - 뉴토크 기준값 = 단가표 기준단가 × (1 − 할인율 ÷ 100) + 추가단가 (원 단위 반올림)
//   할인율·추가단가는 부품마다 따로 정할 수 있고, 비어 있으면 전체 기본값을 쓴다
// - 출장지별 단가 = 그 부품에 연결된 단가 중 업체마다 가장 최근 단가 1개 (오늘 이후 적용 예정 단가 제외)
// - 평균·최저·최고·최고−최저 = 위 출장지별 단가로 계산 (평균은 원 단위 반올림)
// - 기준값 대비 차이는 견적 당시 단가표(적용 시작일 이전 가장 최근 기준일)로 계산.
//   단가표보다 먼저 받은 견적은 가장 오래된 단가표와 비교한다
// - 크게 낮음: 기준값 대비 차이율이 −(크게 낮음 기준)% 이하 (할인 과다 점검, 임시 10%)
export async function getStandard() {
  await db.run('INSERT OR IGNORE INTO price_standard (id) VALUES (1)');
  return db.get('SELECT * FROM price_standard WHERE id = 1');
}

const effectiveSettings = (item, std) => [
  dec(item.discount_rate ?? std.default_discount_rate),
  item.extra_price ?? Number(std.default_extra_price),
];
function standardPrice(item, std, listPrice = item.list_price) {
  if (listPrice === null || listPrice === undefined) return null;
  const [discount, extra] = effectiveSettings(item, std);
  return won(dec(listPrice).mul(dec(1).minus(discount.div(100))).plus(extra));
}
function listPriceOn(item, revisions, day) {
  if (!revisions.length) return [item.list_price, item.list_price_date];
  const before = revisions.filter((r) => r.effective_date <= day);
  const r = before.length ? before[before.length - 1] : revisions[0];
  return [r.list_price, r.effective_date];
}
function compareToStandard(item, revisions, std, price) {
  const [listPrice, baseDate] = listPriceOn(item, revisions, price.effective_date);
  const base = standardPrice(item, std, listPrice);
  if (!base) return { base_price: base, base_date: baseDate, diff: null, diff_rate: null, low: false };
  const rate = round1((price.unit_price - base) / base * 100);
  return { base_price: base, base_date: baseDate, diff: price.unit_price - base, diff_rate: rate, low: rate <= -Number(std.low_alert_rate) };
}
// 업체마다 가장 최근 단가 1개 (적용 예정 제외, 업체명이 비면 '(업체 미입력)')
function companyPrices(prices, day = today()) {
  const latest = new Map();
  for (const p of [...prices].filter((x) => x.effective_date <= day).sort((a, b) => (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : a.id - b.id))) {
    latest.set(p.quote_company || '(업체 미입력)', p);
  }
  return latest;
}
function priceStats(prices) {
  const v = prices.map((p) => p.unit_price);
  if (!v.length) return { count: 0, average: null, min: null, max: null, range: null };
  return { count: v.length, average: won(dec(v.reduce((a, b) => a + b, 0)).div(v.length)), min: Math.min(...v), max: Math.max(...v), range: Math.max(...v) - Math.min(...v) };
}
// 파트넘버 검색용: 대소문자·하이픈·공백 무시 (예: 'xx-05 a' → 'XX05A')
const normalize = (t) => String(t || '').replace(/[\s-]/g, '').toUpperCase();

async function loadCatalog(category = '') {
  const items = await db.all(`SELECT * FROM part_catalog ${category ? 'WHERE category = ?' : ''} ORDER BY sort_order, part_no`, ...(category ? [category] : []));
  const prices = await db.all('SELECT * FROM part_prices WHERE catalog_item_id IS NOT NULL');
  const revisions = await db.all('SELECT * FROM part_list_prices ORDER BY effective_date');
  const by = (rows, key) => rows.reduce((m, r) => ((m[r[key]] ||= []).push(r), m), {});
  const pricesOf = by(prices, 'catalog_item_id');
  const revsOf = by(revisions, 'item_id');
  return items.map((item) => ({ item, prices: pricesOf[item.id] || [], revisions: revsOf[item.id] || [] }));
}

function itemRow({ item, prices }, std) {
  const [discount, extra] = effectiveSettings(item, std);
  return {
    id: item.id,
    part_no: item.part_no,
    category: item.category,
    name: item.name,
    applies_to: item.applies_to,
    list_price: item.list_price,
    list_price_date: item.list_price_date,
    discount_rate: Number(discount),
    extra_price: extra,
    custom: item.discount_rate !== null || item.extra_price !== null,
    standard_price: standardPrice(item, std),
    stats: priceStats([...companyPrices(prices).values()]),
  };
}

export async function catalogTable(query = '', category = '') {
  const std = await getStandard();
  const q = normalize(query);
  const matches = ({ item }) => {
    if (!q) return true;
    const number = normalize(item.part_no);
    // 숫자만 입력하면(예: 0501) 파트넘버의 숫자만 모아 비교 → 'XX-05-A-01'도 찾음
    const digitsOnly = /^\d+$/.test(q) && number.replace(/\D/g, '').includes(q);
    return number.includes(q) || normalize(item.name).includes(q) || digitsOnly;
  };
  const rows = (await loadCatalog(category)).filter(matches).map((x) => itemRow(x, std));
  const all = await db.all('SELECT category, list_price_date FROM part_catalog ORDER BY sort_order, part_no');
  return {
    standard: { default_discount_rate: Number(std.default_discount_rate), default_extra_price: Number(std.default_extra_price), low_alert_rate: Number(std.low_alert_rate) },
    list_price_date: all.map((r) => r.list_price_date).filter(Boolean).sort().pop() || null,
    categories: [...new Set(all.map((r) => r.category))],
    items: rows,
  };
}

export async function catalogDetail(id) {
  const std = await getStandard();
  const entry = (await loadCatalog()).find((x) => x.item.id === Number(id));
  if (!entry) throw new PricingError(404, '단가표에 없는 부품입니다.');
  const { item, prices, revisions } = entry;
  const latestIds = new Set([...companyPrices(prices).values()].map((p) => p.id));
  const day = today();
  const history = [...prices].sort((a, b) => (b.effective_date.localeCompare(a.effective_date)
    || (a.quote_company || '').localeCompare(b.quote_company || '') || b.id - a.id)).map((p) => ({
    id: p.id,
    company: p.quote_company || '(업체 미입력)',
    unit_price: p.unit_price,
    effective_date: p.effective_date,
    upcoming: p.effective_date > day,
    latest: latestIds.has(p.id),
    ...compareToStandard(item, revisions, std, p),
    source: p.source === 'quote' ? '견적서' : '직접 입력',
    quote_no: p.quote_no,
    project: p.quote_project,
    note: p.quote_note,
  }));
  return {
    ...itemRow(entry, std),
    low_alert_rate: Number(std.low_alert_rate),
    revisions: [...revisions].reverse().map((r) => ({ effective_date: r.effective_date, list_price: r.list_price, standard_price: standardPrice(item, std, r.list_price) })),
    prices: history,
  };
}

// 업체(출장지)별 비교: 업체가 견적한 부품마다 기준값 대비 몇 %인지 구해 업체 단위로 모은다
// 평균 차이율 = 부품 차이율의 단순 평균 (부품 가격 크기와 상관없이 같은 무게)
export async function companyComparison(category = '') {
  const std = await getStandard();
  const companies = new Map();
  for (const { item, prices, revisions } of await loadCatalog(category)) {
    for (const [company, p] of companyPrices(prices)) {
      const c = compareToStandard(item, revisions, std, p);
      if (c.diff_rate === null) continue;
      if (!companies.has(company)) companies.set(company, []);
      companies.get(company).push({ id: item.id, part_no: item.part_no, name: item.name, unit_price: p.unit_price, effective_date: p.effective_date, ...c });
    }
  }
  const rows = [...companies].map(([company, parts]) => {
    const rates = parts.map((p) => p.diff_rate);
    return {
      company,
      count: parts.length,
      average_rate: round1(rates.reduce((a, b) => a + b, 0) / rates.length),
      min_rate: Math.min(...rates),
      max_rate: Math.max(...rates),
      above: rates.filter((r) => r > 0).length,
      below: rates.filter((r) => r < 0).length,
      low: parts.filter((p) => p.low).length,
      parts: parts.sort((a, b) => b.diff_rate - a.diff_rate),
    };
  }).sort((a, b) => b.average_rate - a.average_rate || a.company.localeCompare(b.company));
  return { low_alert_rate: Number(std.low_alert_rate), low_count: rows.reduce((n, r) => n + r.low, 0), companies: rows };
}

// 단가 입력 화면에서 고를 부품 목록 + 이미 입력된 업체 이름
export async function catalogChoices() {
  const items = await db.all('SELECT * FROM part_catalog ORDER BY sort_order, part_no');
  const companies = await db.all("SELECT DISTINCT quote_company AS c FROM part_prices WHERE quote_company <> '' ORDER BY 1");
  return {
    items: items.map((i) => ({ id: i.id, part_no: i.part_no, name: i.name, applies_to: i.applies_to,
      label: `${i.part_no} ${i.name}${i.applies_to ? ` (${i.applies_to})` : ''}` })),
    companies: companies.map((r) => r.c),
  };
}

// 부품별 할인율·추가단가 (null이면 전체 기본값)
export async function setCatalogItem(id, body) {
  const { discount, extra } = cleanSetting(body, true);
  const r = await db.run('UPDATE part_catalog SET discount_rate = ?, extra_price = ? WHERE id = ?', discount, extra, Number(id));
  if (!r.changes) throw new PricingError(404, '단가표에 없는 부품입니다.');
  return catalogDetail(id);
}
function cleanSetting(body, allowNull) {
  const blank = (v) => v === null || v === undefined || v === '';
  let discount = null;
  let extra = null;
  if (!blank(body.discount_rate)) {
    const v = dec(String(body.discount_rate));
    if (!v.isFinite() || v.lt(0) || v.gt(100)) throw new PricingError(400, '할인율은 0~100 사이여야 합니다.');
    discount = v.toDecimalPlaces(2).toString();
  }
  if (!blank(body.extra_price)) {
    const v = Number(body.extra_price);
    if (!Number.isInteger(v) || Math.abs(v) > 100_000_000) throw new PricingError(400, '추가단가는 원 단위 정수여야 합니다.');
    extra = v;
  }
  if (!allowNull) { discount ??= '0'; extra ??= 0; }
  return { discount, extra };
}
export async function setStandard(body) {
  const { discount, extra } = cleanSetting(body, false);
  await getStandard();
  let low = null;
  if (body.low_alert_rate !== undefined && body.low_alert_rate !== '') {
    const v = dec(String(body.low_alert_rate));
    if (!v.isFinite() || v.lt(0) || v.gt(100)) throw new PricingError(400, '크게 낮음 기준은 0~100 사이여야 합니다.');
    low = v.toDecimalPlaces(2).toString();
  }
  await db.run(`UPDATE price_standard SET default_discount_rate = ?, default_extra_price = ?, low_alert_rate = COALESCE(?, low_alert_rate), updated_at = ? WHERE id = 1`,
    discount, extra, low, nowStr());
  const s = await getStandard();
  return { discount_rate: Number(s.default_discount_rate), extra_price: Number(s.default_extra_price), low_alert_rate: Number(s.low_alert_rate) };
}

// 단가 한 줄 입력: 단가표 부품, 업체(출장지), 단가(원 단위 정수, 부가세 제외), 적용 시작일. 같은 부품·업체·날짜는 한 줄만
export async function addPartPrice(body, userId) {
  const item = await db.get('SELECT * FROM part_catalog WHERE id = ?', Number(body.catalog_item) || 0);
  if (!item) throw new PricingError(400, '목록에서 파트넘버를 골라 주세요.');
  const company = String(body.quote_company || '').trim().slice(0, 100);
  if (!company) throw new PricingError(400, '업체(출장지)를 입력해 주세요.');
  const price = Number(String(body.unit_price ?? '').replace(/,/g, ''));
  if (!Number.isInteger(price) || price < 0) throw new PricingError(400, '단가는 0 이상의 원 단위 정수로 입력해 주세요.');
  const date = String(body.effective_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PricingError(400, '적용 시작일을 입력해 주세요.');
  if (await db.get('SELECT 1 FROM part_prices WHERE catalog_item_id = ? AND quote_company = ? AND effective_date = ?', item.id, company, date)) {
    throw new PricingError(400, '이 부품은 같은 업체·같은 적용 시작일의 단가가 이미 있습니다. 기존 줄을 지운 뒤 다시 입력해 주세요.');
  }
  const note = String(body.quote_note || '').trim().slice(0, 1000);
  const r = await db.run(`INSERT INTO part_prices (part_name, catalog_item_id, unit_price, effective_date, source, quote_company, quote_note, created_by, created_at)
                          VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?)`, item.name, item.id, price, date, company, note, userId, nowStr());
  return { id: r.lastInsertRowid };
}
export async function deletePartPrice(id) {
  const r = await db.run('DELETE FROM part_prices WHERE id = ?', Number(id));
  if (!r.changes) throw new PricingError(404, '없는 단가입니다.');
}

// ======================================================================
// 가상 값 (처음 한 번) — 실제 계산표·단가표가 아니다. 모델·파트넘버는 실제와 헷갈리지 않게 "VX"로 시작
// ======================================================================
const VIRTUAL_SETTING = { exchange_rate: '1300', customs_factor: '1.2', sga_rate: '25', margin: '0.75', special_discount_rate: '3', commission_rate: '10',
  margin_choices: [0.6, 0.65, 0.7, 0.75, 0.8, 0.85] };
const VIRTUAL_MODELS = [
  ['VXA-01', 'VXA', '500', '560', 2500000], ['VXA-02', 'VXA', '650', '720', 3200000], ['VXA-03', 'VXA', '900', '1000', null],
  ['VXB-01', 'VXB', '400', '450', 2000000], ['VXB-02', 'VXB', '1200', '1340', null],
];
const VIRTUAL_OPTIONS = [['가상 옵션A', '150'], ['가상 옵션B', '400']];
const VIRTUAL_CATALOG = [
  ['VX-01-A-00', '01 현장서비스', '가상 점검 출장', '', 300000], ['VX-01-B-00', '01 현장서비스', '가상 긴급 출장', '', 450000],
  ['VX-05-A-01', '05 MOTOR', 'Motor', 'NTI-01 ~ 03', 500000], ['VX-05-A-02', '05 MOTOR', 'Motor', 'NTI-04 ~ 05', 900000],
  ['VX-07-A-01', '07 BOARD', 'Main Board', 'NTI series', 900000], ['VX-07-B-01', '07 BOARD', 'Power Board', 'NTI-01 ~ 03', 500000],
  ['VX-09-B-01', '09 ELECTRONICS', 'Magnetic Contactor', 'NTI-01 ~ 05', 230000], ['VX-10-A-01', '10 ETC', 'Limit Switch', 'NTI series', null],
];
const VIRTUAL_COMPANY_PRICES = [
  ['VX-01-A-00', '가상정수센터', '2026-03-10', 300000], ['VX-01-A-00', '가상발전소', '2026-05-02', 350000], ['VX-01-A-00', '가상플랜트', '2026-08-20', 320000],
  ['VX-05-A-01', '가상정수센터', '2026-02-15', 480000], ['VX-05-A-01', '가상발전소', '2026-06-01', 560000], ['VX-05-A-01', '가상정수센터', '2026-09-05', 500000],
  ['VX-07-A-01', '가상가스', '2026-04-12', 950000], ['VX-07-A-01', '가상플랜트', '2026-07-07', 870000], ['VX-07-B-01', '가상발전소', '2026-01-20', 520000],
  ['VX-09-B-01', '가상정수센터', '2026-03-03', 240000], ['VX-09-B-01', '가상가스', '2026-05-18', 230000], ['VX-09-B-01', '가상플랜트', '2026-10-01', 260000],
];

export async function seedVirtualPricing() {
  if (!(await db.get('SELECT 1 FROM price_settings LIMIT 1'))) {
    const v = VIRTUAL_SETTING;
    await db.batch([
      ['INSERT INTO price_settings (effective_date, exchange_rate, customs_factor, sga_rate, margin, special_discount_rate, commission_rate, margin_choices) VALUES (?,?,?,?,?,?,?,?)',
        ['2026-01-01', v.exchange_rate, v.customs_factor, v.sga_rate, v.margin, v.special_discount_rate, v.commission_rate, JSON.stringify(v.margin_choices)]],
      ...VIRTUAL_MODELS.map(([n, s, a, c, sale], i) => ['INSERT OR IGNORE INTO product_models (model_name, series, assembly_usd, complete_usd, sale_price, sort_order) VALUES (?,?,?,?,?,?)', [n, s, a, c, sale, i + 1]]),
      ...VIRTUAL_OPTIONS.map(([n, p], i) => ['INSERT OR IGNORE INTO product_options (name, price_usd, sort_order) VALUES (?,?,?)', [n, p, i + 1]]),
    ]);
  }
  if (!(await db.get('SELECT 1 FROM part_catalog LIMIT 1'))) {
    await db.batch(VIRTUAL_CATALOG.map(([no, cat, name, applies, price], i) => ['INSERT INTO part_catalog (part_no, category, name, applies_to, list_price, sort_order) VALUES (?,?,?,?,?,?)', [no, cat, name, applies, price, i + 1]]));
    const ids = Object.fromEntries((await db.all('SELECT id, part_no, name FROM part_catalog')).map((r) => [r.part_no, r]));
    await db.batch(VIRTUAL_COMPANY_PRICES.map(([no, company, date, price]) => ['INSERT INTO part_prices (part_name, catalog_item_id, unit_price, effective_date, quote_company) VALUES (?,?,?,?,?)', [ids[no].name, ids[no].id, price, date, company]]));
  }
  await getStandard();
}

// ---------- 엑셀 내려받기 (화면과 같은 조건) ----------
const CATALOG_COLUMNS = [
  ['분류', 'category', 16], ['파트넘버', 'part_no', 14], ['품명', 'name', 22], ['적용 모델', 'applies_to', 16],
  ['단가표 기준단가', 'list_price', 15, 'won'], ['단가표 기준일', 'list_price_date', 13], ['할인율(%)', 'discount_rate', 10],
  ['추가단가', 'extra_price', 12, 'won'], ['뉴토크 기준값', 'standard_price', 15, 'won'], ['출장지 평균', 'average', 14, 'won'],
  ['출장지 최저', 'min', 14, 'won'], ['출장지 최고', 'max', 14, 'won'], ['최고-최저', 'range', 14, 'won'], ['출장지 수', 'count', 10],
];
const COMPANY_COLUMNS = [
  ['출장지(업체)', 'company', 18], ['비교 부품 수', 'count', 12], ['평균 차이율(%)', 'average_rate', 14], ['최저 차이율(%)', 'min_rate', 14],
  ['최고 차이율(%)', 'max_rate', 14], ['비쌈', 'above', 8], ['쌈', 'below', 8], ['크게 낮음', 'low', 10],
];
const COMPANY_PART_COLUMNS = [
  ['출장지(업체)', 'company', 18], ['파트넘버', 'part_no', 14], ['품명', 'name', 22], ['당시 뉴토크 기준값', 'base_price', 16, 'won'],
  ['단가표 기준일', 'base_date', 13], ['업체 단가', 'unit_price', 14, 'won'], ['차이(원)', 'diff', 14, 'won'], ['차이율(%)', 'diff_rate', 10],
  ['적용 시작일', 'effective_date', 13], ['크게 낮음', 'low_text', 10],
];

export async function simpleWorkbook(sheets) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NEWTORK 경영 대시보드';
  for (const [title, cols, rows] of sheets) {
    const ws = wb.addWorksheet(title, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width, style: fmt === 'won' ? { numFmt: '#,##0' } : fmt ? { numFmt: fmt } : {} }));
    ws.getRow(1).eachCell((c) => {
      c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
      c.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    rows.forEach((r) => ws.addRow(Object.fromEntries(cols.map(([, key]) => [key, r[key] ?? null]))));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
// CSV: 시트 하나 = CSV 하나. 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM, 숫자는 콤마 없이 원값
export function sheetCsv([, cols, rows]) {
  const cell = (v) => {
    const t = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return `\ufeff${[cols.map(([h]) => h), ...rows.map((r) => cols.map(([, k]) => r[k]))].map((line) => line.map(cell).join(',')).join('\r\n')}\r\n`;
}
// 시트가 여러 개면 CSV 여러 개를 ZIP 하나로
export async function csvZip(sheets) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  for (const sh of sheets) zip.file(`${sh[0]}.csv`, sheetCsv(sh));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function catalogSheets(q, category) {
  const data = await catalogTable(q, category);
  return [['부품 단가', CATALOG_COLUMNS, data.items.map((i) => ({ ...i, ...i.stats }))]];
}
export async function companySheets(category) {
  const data = await companyComparison(category);
  const parts = data.companies.flatMap((c) => c.parts.map((p) => ({ ...p, company: c.company, low_text: p.low ? '크게 낮음' : '' })));
  return [['업체 요약', COMPANY_COLUMNS, data.companies], ['부품별 차이', COMPANY_PART_COLUMNS, parts]];
}
