// 회계 프로그램에서 내려받은 월별 손익계산서·제조원가명세서(.xls/.xlsx) 읽기 → 월별 실적 칸
//   손익계산서   : 상품·제품·용역 매출, 당기상품매입액(→ 상품 매입), 판매비와 관리비, 영업외 수익·비용
//   제조원가명세서: 당기원재료매입액(→ 원재료 매입), 노무비, 경비
// 항목 이름(A열)으로 찾고, 금액은 그 행 오른쪽 칸의 숫자. 합계 행에 금액이 없으면 아래 세부 항목을 더한다.
// 기준월은 머리글의 조회기간(예: 2026-10-01 ~ 2026-10-31)에서 읽는다.
import XLSX from 'xlsx';

export const STATEMENT_FIELDS = {
  product_sales: '제품매출', goods_sales: '상품매출', service_sales: '용역매출', non_op_income: '영업외수익',
  product_purchase: '상품 매입', sga_expense: '판관비', non_op_expense: '영업외비용',
  material_purchase: '원재료 매입', labor_cost: '노무비', expense: '경비',
};

// 종류별 찾을 항목: [필드, 항목 이름(공백·번호 뺀 형태), 합계 행이면 true]
const ITEMS = {
  pl: [
    ['goods_sales', '상품매출'], ['product_sales', '제품매출'], ['service_sales', '용역매출'],
    ['product_purchase', '당기상품매입액'], ['sga_expense', '판매비와관리비', true],
    ['non_op_income', '영업외수익', true], ['non_op_expense', '영업외비용', true],
  ],
  mc: [['material_purchase', '당기원재료매입액'], ['labor_cost', '노무비', true], ['expense', '경비', true]],
};
const TITLES = { pl: '손익계산서', mc: '제조원가명세서' };

const SECTION_RE = /^\s*([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|\d+)\s*\./; // "Ⅳ. 판매비와 관리비", "3. 노무비"
const label = (v) => String(v ?? '').replace(SECTION_RE, '').replace(/[\s　]/g, '');
function amount(v) {
  if (typeof v === 'number') return v;
  const t = String(v ?? '').trim();
  if (!t) return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
  const n = Number(t.replace(/[(),\s원-]/g, ''));
  return Number.isFinite(n) && t.replace(/[(),\s원-]/g, '') !== '' ? (neg ? -n : n) : null;
}

// "2026-10-01 ~ 2026-10-31", "2026 년 10 월 01 일 ~ 2026 년 10 월31 일"
function periodOf(texts) {
  for (const t of texts) {
    const ds = [...String(t).matchAll(/(20\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/g)].map((m) => `${m[1]}-${m[2].padStart(2, '0')}`);
    if (ds.length) return { from: ds[0], to: ds[ds.length - 1] };
  }
  return null;
}

export function parseStatement(buffer, fileName = '') {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  const head = aoa.slice(0, 5).flat().map(String);
  const all = aoa.map((r) => label(r[0]));
  const type = head.some((t) => t.replace(/\s/g, '').includes('제조원가명세서')) || /제조원가/.test(fileName) ? 'mc'
    : head.some((t) => t.replace(/\s/g, '').includes('손익계산서')) || /손익/.test(fileName) ? 'pl'
      : all.includes('당기원재료매입액') ? 'mc' : all.includes('판매비와관리비') ? 'pl' : null;
  if (!type) return { file: fileName, type: null, warnings: ['손익계산서·제조원가명세서가 아닙니다. 건너뜁니다.'] };

  const rows = aoa.map((r) => ({ label: label(r[0]), section: SECTION_RE.test(String(r[0] ?? '')), value: r.slice(1).map(amount).filter((v) => v !== null).pop() ?? null }));
  const values = {};
  const missing = [];
  for (const [field, name, total] of ITEMS[type]) {
    const i = rows.findIndex((r) => r.label === name);
    if (i < 0) { missing.push(name); continue; }
    let v = rows[i].value;
    if (v === null && total) { // 합계 칸이 비었으면 다음 구분(Ⅴ., 5.) 전까지 세부 항목 합
      let sum = null;
      for (let k = i + 1; k < rows.length && !rows[k].section; k++) if (rows[k].value !== null) sum = (sum || 0) + rows[k].value;
      v = sum;
    }
    values[field] = Math.round(v || 0);
  }
  const warnings = [];
  if (missing.length) warnings.push(`항목을 찾지 못했습니다: ${missing.join(', ')} (0으로 둡니다)`);
  const p = periodOf(head);
  if (!p) warnings.push('조회기간을 찾지 못했습니다. 기준월을 골라 주세요.');
  else if (p.from !== p.to) warnings.push(`조회기간이 ${p.from} ~ ${p.to} 여러 달입니다. 한 달만 조회한 파일을 올려 주세요 (그대로 저장하면 이 금액이 고른 한 달에 들어갑니다).`);
  const empty = !rows.some((r) => r.value);
  if (empty) warnings.push('금액이 하나도 없습니다. 저장하지 않습니다.');
  return { file: fileName, type, title: TITLES[type], month: p?.to || null, period: p, values, empty, warnings };
}
