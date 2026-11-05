// 부품 단가 — ITB2026(생산·서비스 웹)의 서비스 단가 기능을 옮겨 온 것
//  뉴토크 기준값(= 단가표 기준단가)과 출장지(업체)별 단가 비교
//  기준값은 부품별 비교 화면에서 칸을 두 번 눌러 직접 고칠 수 있다.
//  부품은 "신규 부품 등록"(직접 입력·엑셀) 또는 "부품 단가 데이터 업로드"(CSV)로 넣는다 — 같은 파트넘버는 새 값으로 덮어씀
// 실제 단가표는 대외비라 넣지 않는다. 처음 실행 시 가상 값(파트넘버 "VX…")만 만든다.
import DecimalBase from 'decimal.js';
import { db, nowStr } from './db.js';

const D = DecimalBase.clone({ precision: 40 });
const dec = (v) => new D(v ?? 0);
const won = (v) => Number(dec(v).toDecimalPlaces(0, D.ROUND_HALF_UP));
const round1 = (v) => Number(dec(v).toDecimalPlaces(1, D.ROUND_HALF_UP));
const today = () => nowStr().slice(0, 10);

export class PricingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ======================================================================
// 부품 단가 — 뉴토크 기준값과 출장지(업체)별 단가
// ======================================================================
// - 뉴토크 기준값 = 단가표 기준단가 그대로 (빈 값 = 미입력, 0원과 다름)
// - 출장지별 단가 = 그 부품에 연결된 단가 중 업체마다 가장 최근 단가 1개 (오늘 이후 적용 예정 단가 제외)
// - 평균·최저·최고·최고−최저 = 위 출장지별 단가로 계산 (평균은 원 단위 반올림)
// - 기준값 대비 차이율 = (단가 − 기준값) ÷ 기준값 × 100. 기준값이 없거나 0원이면 계산하지 않음
// - 크게 낮음: 기준값 대비 차이율이 −10% 이하 (할인 과다 점검)
export const LOW_ALERT_RATE = 10;

function compareToStandard(item, price) {
  const base = item.list_price;
  if (!base) return { base_price: base ?? null, diff: null, diff_rate: null, low: false };
  const rate = round1((price.unit_price - base) / base * 100);
  return { base_price: base, diff: price.unit_price - base, diff_rate: rate, low: rate <= -LOW_ALERT_RATE };
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
export const normalize = (t) => String(t || '').replace(/[\s-]/g, '').toUpperCase();

async function loadCatalog(category = '') {
  const items = await db.all(`SELECT * FROM part_catalog ${category ? 'WHERE category = ?' : ''} ORDER BY sort_order, part_no`, ...(category ? [category] : []));
  const prices = await db.all('SELECT * FROM part_prices WHERE catalog_item_id IS NOT NULL');
  const pricesOf = prices.reduce((m, r) => ((m[r.catalog_item_id] ||= []).push(r), m), {});
  return items.map((item) => ({ item, prices: pricesOf[item.id] || [] }));
}

function itemRow({ item, prices }) {
  return {
    id: item.id,
    part_no: item.part_no,
    category: item.category,
    name: item.name,
    applies_to: item.applies_to,
    list_price: item.list_price,
    list_price_date: item.list_price_date,
    standard_price: item.list_price,
    stats: priceStats([...companyPrices(prices).values()]),
  };
}

export async function catalogTable(query = '', category = '') {
  const q = normalize(query);
  const matches = ({ item }) => {
    if (!q) return true;
    const number = normalize(item.part_no);
    // 숫자만 입력하면(예: 0501) 파트넘버의 숫자만 모아 비교 → 'XX-05-A-01'도 찾음
    const digitsOnly = /^\d+$/.test(q) && number.replace(/\D/g, '').includes(q);
    return number.includes(q) || normalize(item.name).includes(q) || digitsOnly;
  };
  const rows = (await loadCatalog(category)).filter(matches).map(itemRow);
  const all = await db.all('SELECT category FROM part_catalog ORDER BY sort_order, part_no');
  return {
    low_alert_rate: LOW_ALERT_RATE,
    categories: [...new Set(all.map((r) => r.category).filter(Boolean))],
    items: rows,
  };
}

export async function catalogDetail(id) {
  const entry = (await loadCatalog()).find((x) => x.item.id === Number(id));
  if (!entry) throw new PricingError(404, '단가표에 없는 부품입니다.');
  const { item, prices } = entry;
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
    ...compareToStandard(item, p),
    source: { quote: '견적서', upload: 'CSV 업로드' }[p.source] || '직접 입력',
    quote_no: p.quote_no,
    project: p.quote_project,
    note: p.quote_note,
  }));
  return { ...itemRow(entry), low_alert_rate: LOW_ALERT_RATE, prices: history };
}

// 업체(출장지)별 비교: 업체가 견적한 부품마다 기준값 대비 몇 %인지 구해 업체 단위로 모은다
// 평균 차이율 = 부품 차이율의 단순 평균 (부품 가격 크기와 상관없이 같은 무게)
export async function companyComparison(category = '') {
  const companies = new Map();
  for (const { item, prices } of await loadCatalog(category)) {
    for (const [company, p] of companyPrices(prices)) {
      const c = compareToStandard(item, p);
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
  return { low_alert_rate: LOW_ALERT_RATE, low_count: rows.reduce((n, r) => n + r.low, 0), companies: rows };
}

// 기준단가(= 뉴토크 기준값) 직접 고치기: 부품별 비교 표의 칸을 두 번 눌러 입력. 빈 값이면 미입력으로
export function cleanPrice(v, label = '기준단가') {
  const t = String(v ?? '').replace(/[,\s원]/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t) || Number(t) > 10_000_000_000) throw new PricingError(400, `${label}는 0 이상의 원 단위 정수로 입력해 주세요.`);
  return Number(t);
}
export async function setListPrice(id, body) {
  const price = cleanPrice(body.list_price);
  const r = await db.run('UPDATE part_catalog SET list_price = ?, list_price_date = ? WHERE id = ?', price, today(), Number(id));
  if (!r.changes) throw new PricingError(404, '단가표에 없는 부품입니다.');
  return catalogDetail(id);
}

// ---------- 신규 부품 등록 (직접 입력 한 건 / 엑셀·CSV 업로드) ----------
// 같은 부품 = 같은 파트넘버 (대소문자·앞뒤 공백 무시). 이미 있으면 새 값으로 덮어쓴다
export const CATALOG_FIELDS = [['category', '분류'], ['part_no', '파트넘버'], ['name', '품목'], ['applies_to', '적용모델'], ['list_price', '기준단가']];
export const CATALOG_LIMITS = { category: 50, part_no: 50, name: 200, applies_to: 200 };
export function cleanCatalogItem(body) {
  const v = Object.fromEntries(CATALOG_FIELDS.map(([k]) => [k, String(body[k] ?? '').trim()]));
  v.part_no = v.part_no.toUpperCase();
  const errors = {};
  if (!v.part_no) errors.part_no = '파트넘버를 입력해 주세요.';
  if (!v.name) errors.name = '품목을 입력해 주세요.';
  for (const [k, n] of Object.entries(CATALOG_LIMITS)) if (v[k].length > n && !errors[k]) errors[k] = `${n}자 이하로 입력해 주세요.`;
  try { v.list_price = cleanPrice(v.list_price); } catch (e) { errors.list_price = e.message; }
  return { values: v, errors };
}
export const findByPartNo = (partNo) => db.get('SELECT * FROM part_catalog WHERE upper(trim(part_no)) = upper(trim(?)) ORDER BY id LIMIT 1', partNo);
// 저장(새로 또는 덮어쓰기)할 SQL 한 줄. existing이 있으면 그 줄을 고친다
export async function upsertCatalogStatements(items) {
  const maxSort = Number((await db.get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM part_catalog')).m);
  const day = today();
  let next = maxSort;
  const stmts = [];
  for (const v of items) {
    const existing = await findByPartNo(v.part_no);
    if (existing) {
      stmts.push(['UPDATE part_catalog SET category = ?, part_no = ?, name = ?, applies_to = ?, list_price = ?, list_price_date = ? WHERE id = ?',
        [v.category, v.part_no, v.name, v.applies_to, v.list_price, existing.list_price === v.list_price ? existing.list_price_date : day, existing.id]]);
    } else {
      next += 1;
      stmts.push(['INSERT INTO part_catalog (category, part_no, name, applies_to, list_price, list_price_date, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [v.category, v.part_no, v.name, v.applies_to, v.list_price, v.list_price === null ? null : day, next]]);
    }
  }
  return stmts;
}
// 입력폼 한 건 저장. 같은 파트넘버가 있으면 overwrite=true일 때만 덮어씀 (아니면 409로 확인 요청)
export async function saveCatalogItem(body) {
  const { values, errors } = cleanCatalogItem(body);
  if (Object.keys(errors).length) throw Object.assign(new PricingError(400, Object.values(errors)[0]), { errors });
  const existing = await findByPartNo(values.part_no);
  if (existing && !body.overwrite) {
    throw Object.assign(new PricingError(409, `파트넘버 ${values.part_no}(${existing.name})가 이미 있습니다. 새 내용으로 덮어쓸까요?`), { existing: itemRow({ item: existing, prices: [] }) });
  }
  try {
    await db.batch(await upsertCatalogStatements([values]));
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new PricingError(400, '같은 파트넘버·품목의 부품이 이미 있습니다.');
    throw e;
  }
  const saved = await findByPartNo(values.part_no);
  return { id: saved.id, overwritten: !!existing, item: itemRow({ item: saved, prices: [] }) };
}

// ======================================================================
// 가상 값 (처음 한 번) — 실제 단가표가 아니다. 파트넘버는 실제와 헷갈리지 않게 "VX"로 시작
// ======================================================================
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
  if (!(await db.get('SELECT 1 FROM part_catalog LIMIT 1'))) {
    await db.batch(VIRTUAL_CATALOG.map(([no, cat, name, applies, price], i) => ['INSERT INTO part_catalog (part_no, category, name, applies_to, list_price, sort_order) VALUES (?,?,?,?,?,?)', [no, cat, name, applies, price, i + 1]]));
    const ids = Object.fromEntries((await db.all('SELECT id, part_no, name FROM part_catalog')).map((r) => [r.part_no, r]));
    await db.batch(VIRTUAL_COMPANY_PRICES.map(([no, company, date, price]) => ['INSERT INTO part_prices (part_name, catalog_item_id, unit_price, effective_date, quote_company) VALUES (?,?,?,?,?)', [ids[no].name, ids[no].id, price, date, company]]));
  }
}

// ---------- 엑셀 내려받기 (화면과 같은 조건) ----------
const CATALOG_COLUMNS = [
  ['분류', 'category', 16], ['파트넘버', 'part_no', 14], ['품목', 'name', 22], ['적용모델', 'applies_to', 16],
  ['뉴토크 기준값(기준단가)', 'standard_price', 18, 'won'], ['기준단가 수정일', 'list_price_date', 14], ['출장지 평균', 'average', 14, 'won'],
  ['출장지 최저', 'min', 14, 'won'], ['출장지 최고', 'max', 14, 'won'], ['최고-최저', 'range', 14, 'won'], ['출장지 수', 'count', 10],
];
const COMPANY_COLUMNS = [
  ['출장지(업체)', 'company', 18], ['비교 부품 수', 'count', 12], ['평균 차이율(%)', 'average_rate', 14], ['최저 차이율(%)', 'min_rate', 14],
  ['최고 차이율(%)', 'max_rate', 14], ['비쌈', 'above', 8], ['쌈', 'below', 8], ['크게 낮음', 'low', 10],
];
const COMPANY_PART_COLUMNS = [
  ['출장지(업체)', 'company', 18], ['파트넘버', 'part_no', 14], ['품목', 'name', 22], ['뉴토크 기준값', 'base_price', 16, 'won'],
  ['업체 단가', 'unit_price', 14, 'won'], ['차이(원)', 'diff', 14, 'won'], ['차이율(%)', 'diff_rate', 10],
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
