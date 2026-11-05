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

// 과목 행 전부 [A열 과목, 세부(B), 합계(C)] — 첫 구분 행(Ⅰ., 1.)부터. 올린 파일 그대로 내려받기에 쓴다
function statementLines(aoa) {
  const first = aoa.findIndex((r) => SECTION_RE.test(String(r[0] ?? '')));
  return aoa.slice(first < 0 ? 0 : first).filter((r) => String(r[0] ?? '').trim()).slice(0, 300)
    .map((r) => [String(r[0]).slice(0, 100), amount(r[1]), amount(r[2])]);
}
// 과목 행 → 월별 실적 칸. 금액은 그 행 오른쪽 칸의 숫자, 합계 행이 비었으면 다음 구분 전까지 세부 항목 합
function valuesOf(type, lines) {
  const rows = lines.map((r) => ({ label: label(r[0]), section: SECTION_RE.test(r[0]), value: r[2] ?? r[1] }));
  const values = {};
  const missing = [];
  for (const [field, name, total] of ITEMS[type]) {
    const i = rows.findIndex((r) => r.label === name);
    if (i < 0) { missing.push(name); continue; }
    let v = rows[i].value;
    if (v === null && total) {
      let sum = null;
      for (let k = i + 1; k < rows.length && !rows[k].section; k++) if (rows[k].value !== null) sum = (sum || 0) + rows[k].value;
      v = sum;
    }
    values[field] = Math.round(v || 0);
  }
  return { values, missing };
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

  const lines = statementLines(aoa);
  const { values, missing } = valuesOf(type, lines);
  const warnings = [];
  if (missing.length) warnings.push(`항목을 찾지 못했습니다: ${missing.join(', ')} (0으로 둡니다)`);
  const p = periodOf(head);
  if (!p) warnings.push('조회기간을 찾지 못했습니다. 기준월을 골라 주세요.');
  else if (p.from !== p.to) warnings.push(`조회기간이 ${p.from} ~ ${p.to} 여러 달입니다. 한 달만 조회한 파일을 올려 주세요 (그대로 저장하면 이 금액이 고른 한 달에 들어갑니다).`);
  const empty = !lines.some((r) => r[1] !== null || r[2] !== null);
  if (empty) warnings.push('금액이 하나도 없습니다. 저장하지 않습니다.');
  return { file: fileName, type, title: TITLES[type], month: p?.to || null, period: p, values, lines, empty, warnings };
}

// ---------------- 쓰기: 회계 프로그램 양식과 같은 배치 (월별 손익계산서·제조원가명세서) ----------------
// [A열 과목, 금액 칸('B' 세부 · 'C' 합계), 값] — 사이트에 없는 과목은 빈칸으로 둔다 (다시 올리면 같은 칸을 읽음)
const IND3 = '　　　';
const IND2 = '　　';
const PL_LAYOUT = [
  ['Ⅰ. 매출액', 'C', (m) => n(m.product_sales) + n(m.goods_sales) + n(m.service_sales)],
  [`${IND3}상품매출`, 'B', (m) => m.goods_sales], [`${IND3}제품매출`, 'B', (m) => m.product_sales], [`${IND3}용역매출`, 'B', (m) => m.service_sales],
  ['Ⅱ. 매출원가'], [`${IND2}상품매출원가`], [`${IND3}기초상품재고액`], [`${IND3}당기상품매입액`, 'B', (m) => m.product_purchase], [`${IND3}기말상품재고액`],
  ['Ⅲ. 매출총이익'],
  ['Ⅳ. 판매비와 관리비', 'C', (m) => m.sga_expense],
  ...['직원급여', '복리후생비', '여비교통비', '접대비', '통신비', '수도광열비', '세금과공과금', '지급임차료', '수선비', '보험료', '차량유지비', '운반비', '교육훈련비', '포장비', '소모품비', '지급수수료', '광고선전비'].map((t) => [`${IND3}${t}`]),
  ['Ⅴ. 영업이익'],
  ['Ⅵ. 영업외 수익', 'C', (m) => m.non_op_income], ...['이자수익', '외환차익', '국고보조금', '잡이익'].map((t) => [`${IND3}${t}`]),
  ['Ⅶ. 영업외 비용', 'C', (m) => m.non_op_expense], ...['이자비용', '외환차손'].map((t) => [`${IND3}${t}`]),
  ['Ⅷ. 법인세차감전이익'], ['Ⅸ. 법인세등'], ['Ⅹ. 당기순이익'],
];
const MC_LAYOUT = [
  ['1. 원재료비'], ['원재료비'], ['기초원재료재고액'], ['당기원재료매입액', 'B', (m) => m.material_purchase], ['기말원재료재고액'],
  ['2. 부재료비'],
  ['3. 노무비', 'C', (m) => m.labor_cost], ['급여'], ['잡급'],
  ['4. 경비', 'C', (m) => m.expense],
  ...['복리후생비', '여비교통비', '통신비', '전력비', '세금과공과금', '지급임차료', '수선비', '보험료', '차량유지비', '경상연구개발비', '교육훈련비', '포장비', '소모품비', '지급수수료'].map((t) => [t]),
  ['5. 당기총제조비용'], ['6. 기초재공품재고액'], ['7. 타계정에서 대체액'], ['8. 합계'], ['9. 기말재공품재고액'], ['10. 타계정으로 대체액'], ['11. 당기제품제조원가'],
];
const n = (v) => Number(v) || 0;
const p2 = (v) => String(v).padStart(2, '0');
const lastDay = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();

// 사이트에서 값을 고친 칸 → 그 차이만큼 바뀌는 합계·이익 행 (+1 더함, -1 뺌)
const AFFECTS = {
  goods_sales: [['매출액', 1], ['매출총이익', 1], ['영업이익', 1], ['법인세차감전이익', 1], ['당기순이익', 1]],
  product_purchase: [['상품매출원가', 1], ['매출원가', 1], ['매출총이익', -1], ['영업이익', -1], ['법인세차감전이익', -1], ['당기순이익', -1]],
  sga_expense: [['영업이익', -1], ['법인세차감전이익', -1], ['당기순이익', -1]],
  non_op_income: [['법인세차감전이익', 1], ['당기순이익', 1]],
  non_op_expense: [['법인세차감전이익', -1], ['당기순이익', -1]],
  material_purchase: [['원재료비', 1], ['당기총제조비용', 1], ['합계', 1], ['당기제품제조원가', 1]],
  labor_cost: [['당기총제조비용', 1], ['합계', 1], ['당기제품제조원가', 1]],
};
AFFECTS.product_sales = AFFECTS.service_sales = AFFECTS.goods_sales;
AFFECTS.expense = AFFECTS.labor_cost;

// 올린 손익계산서·제조원가명세서의 과목 행 그대로 + 그 뒤 사이트에서 고친 값 반영
//  고친 칸은 새 값, 그 칸이 합계면 아래 세부 항목은 맞지 않으므로 비우고, 매출총이익·영업이익 등은 차이만큼 고친다
function savedBody(kind, lines, m) {
  const rows = lines.map((r) => [...r]);
  if (!m) return rows;
  const base = valuesOf(kind, lines).values;
  const find = (name) => rows.findIndex((r) => label(r[0]) === name);
  for (const [field, name, total] of ITEMS[kind]) {
    const d = Math.round(n(m[field])) - n(base[field]);
    const i = find(name);
    if (!d || i < 0) continue;
    const col = rows[i][2] !== null || (rows[i][1] === null && total) ? 2 : 1;
    rows[i][col] = n(base[field]) + d;
    if (total) for (let k = i + 1; k < rows.length && !SECTION_RE.test(rows[k][0]); k++) rows[k][1] = rows[k][2] = null;
    for (const [target, sign] of AFFECTS[field] || []) {
      rows.forEach((r, j) => {
        const c = r[2] !== null ? 2 : r[1] !== null ? 1 : null;
        if (j !== i && c && label(r[0]) === target) r[c] += sign * d;
      });
    }
  }
  return rows;
}

// 시트 한 장 = 한 달. m = 월별 실적 행(없으면 빈 양식), lines = 그 달에 올린 명세서의 과목 행(있으면 그대로)
export function statementAoa(kind, month, m = null, lines = null) {
  const [y, mo] = [month.slice(0, 4), month.slice(5, 7)];
  const end = `${month}-${p2(lastDay(month))}`;
  const head = kind === 'pl'
    ? [['손익계산서'], [`조회기간 : ${month}-01 ~ ${end}`]]
    : [['제조원가명세서'], [`  제 ${+y - 2006} 기  ${y} 년  ${mo} 월  01 일 ~ ${y} 년  ${mo} 월${p2(lastDay(month))} 일`]];
  const body = lines?.length
    ? savedBody(kind, lines, m).map(([a, b, c]) => [a, b === null ? '' : Math.round(b), c === null ? '' : Math.round(c)])
    : (kind === 'pl' ? PL_LAYOUT : MC_LAYOUT).map(([label, col, fn]) => {
      const v = m && fn ? Math.round(n(fn(m))) : null;
      return [label, col === 'B' && v ? v : '', col === 'C' && v ? v : ''];
    });
  return [...head, [], [], ['', '당기', '금액'], ...body];
}
export const statementSheetName = (kind, month) => `${TITLES[kind]}_${month.replace('-', '')}`;

// exceljs 시트에 쓰기 (제목·조회기간·머리글·금액 서식)
export function writeStatementSheet(ws, kind, month, m, lines = null) {
  const aoa = statementAoa(kind, month, m, lines);
  aoa.forEach((r, i) => { ws.getRow(i + 1).values = r; });
  ws.columns = [{ width: 34 }, { width: 18 }, { width: 18 }];
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.getCell('A2').font = { size: 10, color: { argb: 'FF555555' } };
  const thin = { style: 'thin', color: { argb: 'FFB7B7B7' } };
  ['A5', 'B5', 'C5'].forEach((a) => { const c = ws.getCell(a); c.font = { bold: true }; c.alignment = { horizontal: 'center' }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE8' } }; c.border = { top: thin, bottom: thin }; });
  for (let r = 6; r <= aoa.length; r++) {
    const isSection = SECTION_RE.test(String(aoa[r - 1][0]));
    ws.getCell(`A${r}`).font = isSection ? { bold: true } : {};
    ['B', 'C'].forEach((c) => { ws.getCell(`${c}${r}`).numFmt = '#,##0'; if (isSection) ws.getCell(`${c}${r}`).font = { bold: true }; });
  }
}

// 여러 시트가 든 파일(내려받은 파일·업로드 양식)도 시트마다 읽는다
export function parseStatements(buffer, fileName = '') {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const out = [];
  for (const name of wb.SheetNames) {
    // 시트 맨 위 제목 칸이 '손익계산서'·'제조원가명세서'인 시트만 (안내 시트의 설명 글자는 무시)
    const title = String(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' })[0]?.[0] ?? '').replace(/\s/g, '');
    if (name === '안내' || !['손익계산서', '제조원가명세서'].includes(title)) continue;
    const one = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(one, wb.Sheets[name], 'S');
    const r = parseStatement(XLSX.write(one, { type: 'buffer', bookType: 'xlsx' }), `${fileName}${wb.SheetNames.length > 1 ? ` › ${name}` : ''}`);
    if (r.type) out.push({ ...r, sheet: name, file: fileName });
  }
  return out;
}

// ---------------- 매출자료 (판매 관리 프로그램 CSV와 같은 열) ----------------
export const SALES_FILE_HEAD = ['*ID', '작업 구분', '사업 구분', '수출 구분', '판매번호', '최종발주처 / EPC', '사업명', '판매처', '매출액'];
const TYPE_TO_WORK = { 제품: '제품', 상품: '부품 및 교체', 용역: '점검/수리/공사/용역' };
// 직접 등록한 매출(원본 ID 없음)은 'NT-행번호'로 내보낸다 → 다시 올리면 그 행을 덮어씀
export const salesFileRow = (r) => [r.ext_id || `NT-${r.id}`, r.work_type || TYPE_TO_WORK[r.sales_type] || r.sales_type || '', r.biz_type || r.industry || '',
  r.export_type || '', r.order_no || '', r.end_client || '', r.project || r.note || '', r.customer || '', Math.round(n(r.amount))];
export const salesFileAoa = (rows) => [SALES_FILE_HEAD, ...rows.map(salesFileRow)];
export const salesSheetName = (month) => `매출자료_${month.replace('-', '')}`;
export function writeAoaTable(ws, aoa, widths, moneyCols = []) {
  aoa.forEach((r, i) => { ws.getRow(i + 1).values = r; });
  ws.columns = widths.map((w) => ({ width: w }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1EEE8' } }; });
  moneyCols.forEach((ci) => { for (let r = 2; r <= aoa.length; r++) ws.getRow(r).getCell(ci).numFmt = '#,##0'; });
}

// CSV 한 장 (엑셀에서 한글이 깨지지 않게 UTF-8 BOM, 줄바꿈 CRLF)
export function aoaCsv(aoa) {
  const q = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return `﻿${aoa.map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}
