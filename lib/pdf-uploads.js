// PDF 업로드 규칙 2가지 (ITB2026 uploads/handlers의 sales_order_pdf · trip_report_pdf를 옮긴 것)
// 읽기 → 확인 화면(사람이 고치기) → 저장 흐름은 lib/uploads.js가 맡고, 여기서는 종류별 읽기·검사·저장만 정한다.
import { db, nowStr } from './db.js';
import { readPages, TRUNCATED } from './pdf-form.js';
import { parseIsoDate, registerHandler } from './uploads.js';
import { INDUSTRIES, toIndustry } from './production.js';
import { REGIONS, DISTRICTS, cleanReport, validateReport, saveReport } from './service.js';

const isoOk = (t) => { try { return parseIsoDate(t); } catch { return undefined; } };

// ======================================================================
// 수주서 PDF — 1페이지 = 수주서 1건, 확인 표는 제품 1개 = 1행 (주문 정보는 행마다 반복)
//  중복 기준: 판매번호 (이미 저장된 판매번호의 수주서는 통째로 건너뜀) / 잘린 값(…)은 오류
// ======================================================================
const SO_LABELS = ['브랜드 구분', '작업 구분', '사업 구분', '수출 구분', '판매번호', '수주일', '판매처', '최종발주처 / EPC', '사업명', '수주번호', '출고된 리모컨 수',
  '납기일', '매출액', '제작관련 공통사양 / 납품 관련 사항 / 비고', '납품일 / 출장일', '납품처 담당자 (연락처)', '생산/출장 담당자', '수주서류',
  '영업/계약/결제 관련 특이사항', '결제방법', '세금계산서 발행일', '견적서', '영업 담당자', '수금일'];
const SO_HEADINGS = ['구분', '판매정보', '제품정보', '결제정보'];
const SO_ITEM_HEADERS = ['품명', '전원', 'Flange', 'RPM/OT', '스템/부시가공', '수량'];
export const SO_ORDER_FIELDS = { sales_no: '판매번호', order_date: '수주일', business_type_raw: '사업 구분', customer: '판매처', final_orderer: '최종발주처 / EPC', project_name: '사업명',
  order_no: '수주번호', due_date: '납기일', delivery_date: '납품일 / 출장일', order_doc_no: '수주서류', note: '제작관련 공통사양 / 납품 관련 사항 / 비고' };
export const SO_ITEM_FIELDS = { product_name: '품명', quantity: '수량', power: '전원', flange: 'Flange', rpm_ot: 'RPM/OT', stem_bush: '스템/부시가공' };
export const SO_ORDER_KEYS = [...Object.keys(SO_ORDER_FIELDS), 'industry'];
export const SO_DATES = ['order_date', 'due_date', 'delivery_date'];
const SO_LIMITS = { sales_no: 30, order_no: 30, order_doc_no: 30, business_type_raw: 50, industry: 20, customer: 100, final_orderer: 100, project_name: 200,
  product_name: 100, power: 30, flange: 30, rpm_ot: 30, stem_bush: 50 };

registerHandler({
  kind: 'sales_order_pdf', team: 'production', extensions: ['.pdf'], keyField: 'sales_no',
  columns: [['sales_no', '판매번호'], ['item_no', '품목 순번'], ['due_date', '납기일'], ['order_date', '수주일'], ['business_type_raw', '사업구분'],
    ['industry', '산업 분야', { choices: INDUSTRIES }], ['customer', '판매처'], ['final_orderer', '최종발주처/EPC'], ['project_name', '사업명'], ['product_name', '품명'],
    ['quantity', '수량'], ['power', '전원'], ['flange', 'Flange'], ['rpm_ot', 'RPM/OT'], ['stem_bush', '스템/부시가공'], ['order_no', '수주번호'],
    ['order_doc_no', '수주서류 번호'], ['delivery_date', '납품일/출장일'], ['note', '비고', { multiline: true }]],
  async parse(buffer) {
    const rows = [];
    (await readPages(buffer)).forEach((page, i) => {
      const pageNo = i + 1;
      if (!page.find('판매번호')) return;
      const order = Object.fromEntries(Object.entries(SO_ORDER_FIELDS).map(([k, label]) => [k, (page.value(label, SO_LABELS, SO_HEADINGS) || '').replace(/\n/g, ' ').trim()]));
      // 수주서류 "#26024 파일이름.p…" → 번호 26024만 저장
      const m = order.order_doc_no.match(/#?\s*(\d+)/);
      if (m) order.order_doc_no = m[1];
      order.industry = toIndustry(order.business_type_raw);
      const items = page.table(SO_ITEM_HEADERS, ['합계']);
      (items.length ? items : [{}]).forEach((item, n) => { // 제품이 없어도 1행은 보여줌
        const values = { ...order, item_no: String(n + 1) };
        for (const [k, h] of Object.entries(SO_ITEM_FIELDS)) values[k] = item[h] || '';
        values.quantity = values.quantity.replace(/[^\d]/g, ''); // "1 대" → 1
        rows.push({ row_no: pageNo, sheet: `${pageNo}쪽`, values });
      });
    });
    if (!rows.length) throw Object.assign(new Error("'판매번호' 항목을 찾을 수 없습니다. 수주서 PDF인지 확인해 주세요."), { status: 400, userMessage: true });
    return { rows, skipped: 0 };
  },
  // 같은 판매번호 안에서 품목 순번이 겹치면 "파일 안 중복"
  duplicateKey: (v) => { const s = String(v.sales_no || '').trim(); return s ? `${s}|${String(v.item_no || '').trim()}` : null; },
  async existingKeys(keys) {
    const nos = [...new Set(keys.map((k) => k.split('|')[0]))];
    const saved = new Set(nos.length ? (await db.all(`SELECT sales_no FROM sales_orders WHERE sales_no IN (${nos.map(() => '?').join(',')})`, ...nos)).map((r) => r.sales_no) : []);
    return new Set(keys.filter((k) => saved.has(k.split('|')[0])));
  },
  validate(v) {
    const errors = {};
    const s = (k) => String(v[k] ?? '').trim();
    if (!s('sales_no')) errors.sales_no = '판매번호가 없습니다.';
    if (!s('product_name')) errors.product_name = '품명이 없습니다.';
    if (!/^\d+$/.test(s('quantity')) || +s('quantity') === 0) errors.quantity = '수량은 1 이상의 숫자입니다.';
    if (!INDUSTRIES.includes(v.industry)) errors.industry = `다음 중 하나: ${INDUSTRIES.join(', ')}`;
    for (const f of SO_DATES) {
      const d = isoOk(v[f]);
      if (d === undefined) errors[f] = '날짜 형식: YYYY-MM-DD';
      else if (d === null && f === 'due_date') errors[f] = '납기일이 없습니다 (판매량 집계 기준).';
    }
    for (const [k] of this.columns) if (String(v[k] ?? '').includes(TRUNCATED) && !errors[k]) errors[k] = 'PDF에서 잘린 값(…)입니다. 전체 값으로 고쳐 주세요.';
    for (const [k, n] of Object.entries(SO_LIMITS)) if (String(v[k] ?? '').length > n && !errors[k]) errors[k] = `${n}자 이하로 입력해 주세요.`;
    return errors;
  },
  // 같은 판매번호의 행끼리 주문 정보가 같아야 한다 (한 수주서로 저장되므로)
  validateAll(rows) {
    const first = {};
    for (const row of rows) {
      const no = String(row.values.sales_no || '').trim();
      if (!no) continue;
      if (!first[no]) { first[no] = row.values; continue; }
      for (const k of SO_ORDER_KEYS) if (String(row.values[k] ?? '').trim() !== String(first[no][k] ?? '').trim()) row.errors[k] ??= '같은 판매번호의 첫 행과 값이 다릅니다.';
    }
  },
  async save(rows, userId) {
    const ids = {};
    for (const row of rows) {
      const v = Object.fromEntries(Object.entries(row.values).map(([k, x]) => [k, String(x ?? '').trim()]));
      if (!ids[v.sales_no]) {
        const cols = SO_ORDER_KEYS;
        const r = await db.run(`INSERT INTO sales_orders (${cols.join(', ')}, created_by, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`,
          ...cols.map((c) => (SO_DATES.includes(c) ? v[c] || null : v[c])), userId, nowStr());
        ids[v.sales_no] = r.lastInsertRowid;
      }
      await db.run('INSERT INTO sales_order_items (order_id, product_name, quantity, power, flange, rpm_ot, stem_bush) VALUES (?,?,?,?,?,?,?)',
        ids[v.sales_no], v.product_name, Number(v.quantity), v.power, v.flange, v.rpm_ot, v.stem_bush);
    }
    return rows.length;
  },
});

// ======================================================================
// 출장보고서 PDF — 1페이지 = 보고서 1건 = 확인 표 1행
//  여러 개인 값은 한 칸에 줄바꿈으로: 동행자, 교체 부품, 제품("모델명 | 사양 | 일련번호 | 수량")
//  요청처 → 시·도·시·군: 대응표에 있으면 자동, 없으면 확인 화면에서 고름 (저장할 때 기억)
//  검사·저장 규칙은 직접 입력과 같다 (lib/service.js). 중복 기준: 출장 시작일 + 요청처 → "중복 아님" 체크로 저장 가능
// ======================================================================
const TR_LABELS = ['요청처 구분', '출장 시작일', '작성일', '요청처(검색불가시)', '요청처', '출장 종료일', '작성자', '현장담당자 / 연락처', '추가 출장', '해피콜 예정일',
  '동행자', '작업 구분', '출장 목적', '고장 내용', '작업 내용', '작업 결과', '명판 사진', '작업 전 사진', '작업 후 사진', '부품 교체 전 사진', '부품 교체 후 사진',
  '관련 자료 (판넬 도면 등)', '비용청구 유무', '견적서 구분', '승인자', '부품 사용 내역', '견적서', '참조자'];
const TR_HEADINGS = ['출장정보', '작업 개요', '제품 목록', '수리 내역', '비고'];
const TR_PRODUCT_HEADERS = ['모델명', '사양', '일련번호', '수량'];
const TR_TEXT = { requester_type: '요청처 구분', start_date: '출장 시작일', end_date: '출장 종료일', extra_trip: '추가 출장', author: '작성자', work_type: '작업 구분',
  purpose: '출장 목적', paid_type: '비용청구 유무' };
const TR_LONG = { fault_description: '고장 내용', work_description: '작업 내용', work_result: '작업 결과' };
const splitLines = (t) => String(t || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const splitKeep = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean); // 부품명·제품 줄에는 쉼표가 들어갈 수 있음
const productLine = (line) => {
  const p = line.split('|').map((x) => x.trim());
  while (p.length < 4) p.push('');
  return { model_name: p[0], spec: p[1], serial_no_raw: p[2], quantity: p[3].replace(/[^\d]/g, '') };
};
// 확인 표 한 행(여러 개 값은 줄바꿈으로 나뉜 글자) → 공통 보고서 데이터
const toReport = (v) => cleanReport({ ...v, companions: splitLines(v.companions), parts: splitKeep(v.parts), products: splitKeep(v.products).map(productLine) });

registerHandler({
  kind: 'trip_report_pdf', team: 'service', extensions: ['.pdf'], keyField: 'start_date', allowDuplicateOverride: true,
  columns: [['start_date', '출장 시작일'], ['end_date', '출장 종료일'], ['requester', '요청처'], ['region', '시·도', { choices: REGIONS }],
    ['district', '시·군', { choices_by: 'region', choices_map: DISTRICTS }], ['paid_type', '비용청구', { choices: ['유상', '무상'] }], ['author', '작성자'],
    ['companions', '동행자(줄마다 1명)', { multiline: true }], ['products', '제품(모델명 | 사양 | 일련번호 | 수량)', { multiline: true }],
    ['parts', '교체 부품(줄마다 1개)', { multiline: true }], ['work_type', '작업 구분'], ['requester_type', '요청처 구분'], ['extra_trip', '추가 출장'],
    ['purpose', '출장 목적'], ['fault_description', '고장 내용', { multiline: true }], ['work_description', '작업 내용', { multiline: true }],
    ['work_result', '작업 결과', { multiline: true }]],
  async parse(buffer) {
    const known = Object.fromEntries((await db.all('SELECT requester, region, district FROM requester_regions')).map((r) => [r.requester, r]));
    const rows = [];
    (await readPages(buffer)).forEach((page, i) => {
      const pageNo = i + 1;
      if (!page.find('출장 시작일')) return;
      const value = (label) => page.value(label, TR_LABELS, TR_HEADINGS) || '';
      const values = Object.fromEntries(Object.entries(TR_TEXT).map(([k, l]) => [k, value(l).replace(/\n/g, ' ').trim()]));
      for (const [k, l] of Object.entries(TR_LONG)) values[k] = value(l).trim();
      // 요청처: "검색 불가"이면 직접 적은 칸, 아니면 요청처 칸
      values.requester = (value('요청처(검색불가시)') || value('요청처')).replace(/\n/g, ' ').trim();
      values.region = known[values.requester]?.region || '';
      values.district = known[values.requester]?.district || '';
      values.companions = splitLines(value('동행자')).join('\n');
      values.parts = splitKeep(value('부품 사용 내역')).join('\n');
      values.products = page.table(TR_PRODUCT_HEADERS, ['수리 내역']).map((p) => [p.모델명, p.사양, p.일련번호, p.수량.replace(/[^\d]/g, '')].join(' | ')).join('\n');
      rows.push({ row_no: pageNo, sheet: `${pageNo}쪽`, values });
    });
    if (!rows.length) throw Object.assign(new Error("'출장 시작일' 항목을 찾을 수 없습니다. 출장보고서 PDF인지 확인해 주세요."), { status: 400, userMessage: true });
    return { rows, skipped: 0 };
  },
  duplicateKey: (v) => { const a = String(v.start_date || '').trim(); const b = String(v.requester || '').trim(); return a && b ? `${a}|${b}` : null; },
  async existingKeys(keys) {
    const found = new Set();
    for (const k of keys) {
      const [start, requester] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      if (await db.get('SELECT 1 FROM trip_reports WHERE start_date = ? AND requester = ?', start, requester)) found.add(k);
    }
    return found;
  },
  validate: (v) => validateReport(toReport(v)),
  async save(rows, userId) {
    for (const row of rows) await saveReport(toReport(row.values), userId, 'pdf');
    return rows.length;
  },
});
