// PDF 업로드 규칙 3가지 (ITB2026 uploads/handlers의 sales_order_pdf · trip_report_pdf · quote_pdf를 옮긴 것)
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
const SO_ORDER_FIELDS = { sales_no: '판매번호', order_date: '수주일', business_type_raw: '사업 구분', customer: '판매처', final_orderer: '최종발주처 / EPC', project_name: '사업명',
  order_no: '수주번호', due_date: '납기일', delivery_date: '납품일 / 출장일', order_doc_no: '수주서류', note: '제작관련 공통사양 / 납품 관련 사항 / 비고' };
const SO_ITEM_FIELDS = { product_name: '품명', quantity: '수량', power: '전원', flange: 'Flange', rpm_ot: 'RPM/OT', stem_bush: '스템/부시가공' };
const SO_ORDER_KEYS = [...Object.keys(SO_ORDER_FIELDS), 'industry'];
const SO_DATES = ['order_date', 'due_date', 'delivery_date'];
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

// ======================================================================
// 유상 A/S 견적서 PDF → 출장지(업체)별 부품 단가
//  위쪽 표: 항목 이름 오른쪽에 값 (항목 이름 글자 사이 공백은 빼고 비교, 예: "날       짜")
//  품목 표: 번호 | 품명 및 규격 | 수량 | 단가(원) | 금액(원) — 숫자 3칸은 머리글 가운데와 가장 가까운 칸으로
//  단가 = 단가(원)(부가세 제외), 적용 시작일 = 견적서 날짜, 업체명 = 출장지. 견적서 품명 → 파트넘버는 기억해 다음부터 자동
//  중복 기준: 견적 번호 + 견적서 품명. 수신자·담당자·연락처는 읽지 않는다 (개인정보)
// ======================================================================
const QT_ITEM_HEADERS = ['번호', '품명및규격', '수량', '단가(원)', '금액(원)'];
const QT_NUMBER_HEADERS = ['수량', '단가(원)', '금액(원)'];
const QT_TABLE_END = ['납기', '공급가액', '총량'];
const QT_HEADER_LABELS = new Set(['견적번호', '날짜', '업체명', '수신자', '합계금액', '등록번호', '상호', '대표', '주소', '업태', '종목', '전화번호', '팩스번호', '사업명', '비고']);
const compact = (t) => String(t || '').replace(/\s+/g, '');
const toInt = (t) => { const d = String(t || '').replace(/[,\s원]/g, ''); return /^\d+$/.test(d) ? Number(d) : null; };
const findLabel = (page, label) => page.words.find((w) => compact(w.text) === label);
function valueRightOf(page, label) {
  const f = findLabel(page, label);
  if (!f) return '';
  const out = [];
  for (const w of page.words.filter((x) => Math.abs(x.top - f.top) < 3 && x.x0 > f.x1).sort((a, b) => a.x0 - b.x0)) {
    if (QT_HEADER_LABELS.has(compact(w.text))) break;
    out.push(w.text.trim());
  }
  return out.join(' ');
}
// 아래쪽 큰 비고 칸: 왼쪽에 '비'·'고'가 세로로 따로 적혀 있고, 그 오른쪽이 내용
function bottomNote(page) {
  const bi = page.words.find((w) => w.text.trim() === '비');
  const go = bi && page.words.find((w) => w.text.trim() === '고' && w.top > bi.top);
  if (!bi || !go) return '';
  const top = bi.top - 15; const bottom = go.bottom + 15; const left = Math.max(bi.x1, go.x1) + 5;
  return page.lines(page.words.filter((w) => top <= w.top && w.top <= bottom && w.x0 > left && !w.text.startsWith('『'))).join('\n');
}
function readQuoteItems(page) {
  const headers = {};
  for (const w of page.words) if (QT_ITEM_HEADERS.includes(compact(w.text))) headers[compact(w.text)] ??= w;
  if (QT_ITEM_HEADERS.some((h) => !headers[h])) return null;
  const top = headers.번호.top;
  const ends = page.words.filter((w) => w.top > top + 1 && QT_TABLE_END.includes(compact(w.text))).map((w) => w.top);
  const bottom = ends.length ? Math.min(...ends) : page.height + 1;
  const centers = Object.fromEntries(QT_NUMBER_HEADERS.map((n) => [n, (headers[n].x0 + headers[n].x1) / 2]));
  const numberLeft = headers.수량.x0 - 20; // 이보다 오른쪽은 숫자 칸
  const noRight = headers.번호.x1 + 5; // 이보다 왼쪽에서 끝나면 번호 칸
  const body = page.words.filter((w) => top + 1 < w.top && w.top < bottom).sort((a, b) => Math.round(a.top) - Math.round(b.top) || a.x0 - b.x0);
  const lines = [];
  for (const w of body) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.top - w.top) < 1.5) last.words.push(w); else lines.push({ top: w.top, words: [w] });
  }
  const KEY = { 수량: 'quantity', '단가(원)': 'unit_price', '금액(원)': 'amount' };
  const items = [];
  for (const { words } of lines) {
    const row = { no: '', item: [], quantity: '', unit_price: '', amount: '' };
    for (const w of words) {
      if (w.x0 >= numberLeft) {
        const mid = (w.x0 + w.x1) / 2;
        const name = QT_NUMBER_HEADERS.reduce((a, b) => (Math.abs(mid - centers[b]) < Math.abs(mid - centers[a]) ? b : a));
        row[KEY[name]] = w.text.trim();
      } else if (w.x1 <= noRight) row.no = w.text.trim();
      else row.item.push(w.text.trim());
    }
    const item = row.item.join(' ');
    if (!row.no && items.length && item && !row.unit_price) items[items.length - 1].item += ` ${item}`; // 품명이 두 줄로 넘어간 경우
    else if (item || row.unit_price) items.push({ item, quantity: row.quantity, unit_price: row.unit_price, amount: row.amount });
  }
  return items;
}
// 단가표 부품 찾기: 맨 앞 낱말을 파트넘버로 보고, 같은 파트넘버가 여럿이면 뒤의 품명으로 고른다
async function findCatalogItem(text) {
  const t = String(text || '').trim();
  if (!t) return [null, '파트넘버를 고르거나 입력해 주세요.'];
  const sp = t.indexOf(' ');
  const partNo = sp < 0 ? t : t.slice(0, sp);
  const rest = sp < 0 ? '' : t.slice(sp + 1);
  let m = await db.all('SELECT * FROM part_catalog WHERE upper(part_no) = upper(?)', partNo);
  if (!m.length) return [null, `단가표에 없는 파트넘버입니다: ${partNo}`];
  if (m.length > 1) {
    m = m.filter((x) => rest && rest.startsWith(x.name));
    if (m.length !== 1) return [null, `파트넘버 ${partNo}가 여러 품목에 쓰여 있습니다. 목록에서 품명까지 골라 주세요.`];
  }
  return [m[0], null];
}
const catalogLabel = (i) => `${i.part_no} ${i.name}${i.applies_to ? ` (${i.applies_to})` : ''}`;
const QT_COLUMNS = [['quote_no', '견적 번호'], ['effective_date', '적용 시작일(견적 날짜)'], ['quote_item', '견적서 품명'], ['part_no', '파트넘버(단가표 부품)', { suggestions: 'catalog_items' }],
  ['unit_price', '단가(원, 부가세 제외)'], ['quantity', '수량'], ['amount', '금액(원)'], ['quote_company', '업체명(방문한 회사)'], ['quote_project', '사업명'],
  ['quote_note', '비고(단가가 달라진 이유 등)', { multiline: true }]];

registerHandler({
  kind: 'quote_pdf', team: 'service', extensions: ['.pdf'], keyField: 'quote_item',
  columns: QT_COLUMNS,
  async suggestions() { return { catalog_items: (await db.all('SELECT * FROM part_catalog ORDER BY sort_order, part_no')).map(catalogLabel) }; },
  async parse(buffer) {
    const labels = Object.fromEntries((await db.all('SELECT * FROM part_catalog')).map((c) => [c.id, catalogLabel(c)]));
    const aliases = Object.fromEntries((await db.all('SELECT quote_item, catalog_item_id FROM quote_part_aliases WHERE catalog_item_id IS NOT NULL')).map((a) => [a.quote_item, labels[a.catalog_item_id] || '']));
    const rows = [];
    (await readPages(buffer)).forEach((page, i) => {
      const quoteNo = valueRightOf(page, '견적번호');
      const items = readQuoteItems(page);
      if (!quoteNo || !items) return;
      const ctx = {
        quote_company: valueRightOf(page, '업체명'), quote_project: valueRightOf(page, '사업명'),
        quote_note: [valueRightOf(page, '비고'), bottomNote(page)].filter(Boolean).join('\n'),
      };
      for (const it of items) {
        rows.push({ row_no: rows.length + 1, sheet: `${i + 1}쪽`, values: { quote_no: quoteNo, effective_date: valueRightOf(page, '날짜'), quote_item: it.item,
          part_no: aliases[it.item] || '', unit_price: it.unit_price, quantity: it.quantity, amount: it.amount, ...ctx } });
      }
    });
    if (!rows.length) throw Object.assign(new Error("'견적 번호'와 품목 표를 찾을 수 없습니다. 유상 A/S 견적서 PDF인지 확인해 주세요."), { status: 400, userMessage: true });
    return { rows, skipped: 0 };
  },
  duplicateKey: (v) => { const a = String(v.quote_no || '').trim(); const b = String(v.quote_item || '').trim(); return a && b ? `${a}|${b}` : null; },
  async existingKeys(keys) {
    const found = new Set();
    for (const k of keys) {
      const i = k.indexOf('|');
      if (await db.get('SELECT 1 FROM part_prices WHERE quote_no = ? AND quote_item = ?', k.slice(0, i), k.slice(i + 1))) found.add(k);
    }
    return found;
  },
  // 파트넘버 확인은 DB를 봐야 해서 validateAll에서 (validate는 동기 검사만)
  validate(values) {
    const errors = {};
    const v = Object.fromEntries(QT_COLUMNS.map(([k]) => [k, String(values[k] ?? '').trim()]));
    if (!v.quote_no) errors.quote_no = '견적 번호가 없습니다.';
    if (!isoOk(v.effective_date)) errors.effective_date = '날짜 형식: YYYY-MM-DD';
    if (!v.quote_item) errors.quote_item = '견적서 품명이 없습니다.';
    const price = toInt(v.unit_price); const qty = toInt(v.quantity); const amount = toInt(v.amount);
    if (price === null) errors.unit_price = '단가를 숫자로 입력해 주세요 (원 단위).';
    if (!qty) errors.quantity = '수량은 1 이상의 숫자입니다.';
    if (price !== null && qty && amount !== null && price * qty !== amount) errors.amount = `수량 × 단가(${(price * qty).toLocaleString('ko-KR')})가 금액과 다릅니다. PDF를 확인해 주세요.`;
    for (const [k, n] of [['quote_company', 100], ['quote_project', 200]]) if (v[k].length > n) errors[k] = `${n}자 이하로 입력해 주세요.`;
    for (const k of ['quote_no', 'quote_item', 'part_no']) if (v[k].includes(TRUNCATED) && !errors[k]) errors[k] = '잘린 값(…)입니다. 전체 값으로 고쳐 주세요.';
    return errors;
  },
  async validateAll(rows) {
    const seen = {};
    for (const row of rows) {
      const v = row.values;
      const [item, msg] = await findCatalogItem(v.part_no);
      if (msg) { row.errors.part_no ??= msg; continue; }
      const date = String(v.effective_date || '').trim();
      const company = String(v.quote_company || '').trim();
      if (isoOk(date) && await db.get('SELECT 1 FROM part_prices WHERE catalog_item_id = ? AND quote_company = ? AND effective_date = ?', item.id, company, date)) {
        row.errors.part_no ??= `이 부품은 같은 업체의 ${date} 단가가 이미 있습니다. 교체부품 단가 화면에서 확인해 주세요.`;
      }
      // 같은 파일 안에서 같은 부품·같은 업체·같은 날짜가 두 번 나오면 단가가 겹침
      const key = `${item.id}|${company}|${date}`;
      if (date && seen[key] && !row.errors.part_no) row.errors.part_no = `이 파일의 ${seen[key]}번째 줄과 같은 부품·같은 업체·같은 날짜입니다. 하나만 남겨 주세요.`;
      seen[key] ??= row.row_no;
    }
  },
  async save(rows, userId) {
    for (const row of rows) {
      const v = Object.fromEntries(Object.entries(row.values).map(([k, x]) => [k, String(x ?? '').trim()]));
      const [item] = await findCatalogItem(v.part_no);
      await db.batch([
        [`INSERT INTO part_prices (part_name, catalog_item_id, unit_price, effective_date, source, quote_no, quote_item, quote_company, quote_project, quote_note, created_by, created_at)
          VALUES (?, ?, ?, ?, 'quote', ?, ?, ?, ?, ?, ?, ?)`, [item.name, item.id, toInt(v.unit_price), v.effective_date, v.quote_no, v.quote_item, v.quote_company, v.quote_project, v.quote_note, userId, nowStr()]],
        // 확인 화면에서 고른 파트넘버를 기억 → 다음 견적서부터 자동으로 채움
        [`INSERT INTO quote_part_aliases (quote_item, part_name, catalog_item_id) VALUES (?, ?, ?)
          ON CONFLICT(quote_item) DO UPDATE SET part_name = excluded.part_name, catalog_item_id = excluded.catalog_item_id`, [v.quote_item, item.name, item.id]],
      ]);
    }
    return rows.length;
  },
});
