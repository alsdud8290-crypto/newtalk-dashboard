// 수주내역 엑셀 업로드 (생산 데이터 업로드 — 엑셀 한 파일에서 수주내역 시트를 읽는다. 제조내역 시트는 lib/uploads.js의 manufacturing_excel)
//  시트 구분: 위쪽 20줄 안에 "판매번호"·"품명"(또는 "제품정보-품명")·"수량" 제목이 있는 시트 = 수주내역
//  수주내역 시트가 없으면 제조내역 행을 판매번호별로 묶어 수주내역을 만든다 (아래 ordersFromMfg)
//  열 이름은 회사 판매 관리 내보내기와 같다: 판매번호, 수주일, 사업 구분, 판매처, 최종발주처 / EPC, 사업명, 수주번호, 납기일, 납품일 / 출장일, 수주서류,
//   제작관련 공통사양 / 납품 관련 사항 / 비고, 제품정보-품명·전원·Flange·RPM/OT·스템/부시가공·수량 ("제품정보-"는 없어도 됨)
//  한 수주에 제품이 여럿이면 둘째 줄부터 주문 정보 칸이 비어 있다 → 같은 *ID(없으면 바로 위 수주)의 값을 쓴다
//  저장 필드·확인 표 열·검사 규칙은 수주서 PDF와 같다 (sales_orders + sales_order_items)
//  중복 기준: 판매번호 + 품목 순번 → 이미 있으면 새 값으로 덮어씀 (수주서 PDF 업로드는 지금처럼 건너뜀)
import XLSX from 'xlsx';
import { db, nowStr } from './db.js';
import { HANDLERS, registerHandler, UploadError } from './uploads.js';
import { toIndustry } from './production.js';
import './pdf-uploads.js';
import { SO_ORDER_FIELDS, SO_ITEM_FIELDS, SO_ORDER_KEYS, SO_DATES } from './pdf-uploads.js';

const pdf = HANDLERS.sales_order_pdf;
const headKey = (v) => String(v ?? '').replace(/\s+/g, '').replace(/^제품정보-?/, '').toLowerCase();
const HEADS = {
  id: ['*id', 'id'],
  ...Object.fromEntries(Object.entries({ ...SO_ORDER_FIELDS, ...SO_ITEM_FIELDS }).map(([k, label]) => [k, [headKey(label)]])),
};
HEADS.final_orderer.push('최종발주처');
HEADS.delivery_date.push('납품일', '출장일');
const ITEM_KEYS = Object.keys(SO_ITEM_FIELDS);
const ORDER_FIELD_KEYS = Object.keys(SO_ORDER_FIELDS);

const text = (v) => (v === null || v === undefined ? '' : String(v).replace(/\r/g, '').trim());
// 날짜 칸: 엑셀 날짜(숫자) → YYYY-MM-DD, 글자는 2026.1.5 · 2026/01/05 · 2026-01-05 13:08 모두
function dateOf(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const t = text(v);
  const m = t.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : t;
}
const numText = (v) => (typeof v === 'number' ? String(Math.round(v)) : text(v).replace(/[,\s]|대$/g, ''));
// 수주서류: "#26024 파일이름.pdf" → 26024 (수주서 PDF와 같게). 번호가 없으면 글자 그대로
const docNo = (v) => { const t = text(v); const m = t.match(/#\s*(\d+)/) || t.match(/^(\d+)$/); return m ? m[1] : t; };

function parseOrders(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const rows = [];
  let skipped = 0;
  let found = false;
  for (const sheet of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', raw: true });
    const hi = grid.slice(0, 20).findIndex((r) => { const k = r.map(headKey); return ['sales_no', 'product_name', 'quantity'].every((f) => k.some((x) => HEADS[f].includes(x))); });
    if (hi < 0) continue;
    found = true;
    const keys = grid[hi].map(headKey);
    const col = {};
    for (const [f, names] of Object.entries(HEADS)) { const i = keys.findIndex((x) => names.includes(x)); if (i >= 0) col[f] = i; }
    const get = (r, f) => (col[f] === undefined ? '' : r[col[f]]);
    const byId = {};
    let order = null;
    const counts = {};
    for (let i = hi + 1; i < grid.length; i += 1) {
      const r = grid[i];
      if (!r.some((x) => text(x))) continue;
      const id = text(get(r, 'id')).replace(/"/g, '');
      if (text(get(r, 'sales_no'))) {
        order = Object.fromEntries(ORDER_FIELD_KEYS.map((f) => [f, SO_DATES.includes(f) ? dateOf(get(r, f)) : text(get(r, f)).replace(/\n+/g, ' ')]));
        order.order_doc_no = docNo(get(r, 'order_doc_no'));
        order.industry = toIndustry(order.business_type_raw);
        if (id) byId[id] = order;
      } else if (id && byId[id]) order = byId[id];
      else if (id) order = null; // 판매번호가 없는 새 수주 → 판매번호 오류로 보여 줌
      const item = Object.fromEntries(ITEM_KEYS.map((f) => [f, f === 'quantity' ? numText(get(r, f)) : text(get(r, f))]));
      if (!order && !item.product_name) { skipped += 1; continue; }
      const base = order || Object.fromEntries([...SO_ORDER_KEYS].map((f) => [f, '']));
      const no = base.sales_no || `(행 ${i + 1})`;
      counts[no] = (counts[no] || 0) + 1;
      rows.push({ row_no: i + 1, sheet, values: { ...base, item_no: String(counts[no]), ...item } });
    }
  }
  if (!found) return null;
  if (!rows.length) throw new UploadError(400, '수주내역 시트에 읽을 행이 없습니다.');
  return { rows, skipped };
}

// 수주내역 시트가 없으면 제조내역 행(1행 = 제품 1대)에서 만든다 (회사 생산데이터 엑셀: 판매번호·거래처·최종발주처·사업명·납기일이 행마다 있음)
//  판매번호(PO, "#26024" → 26024)별로 수주 1건: 판매번호·수주서류 번호 = 26024, 판매처·최종발주처·사업명·납기일 = 그 판매번호의 첫 행
//  제품 = 모델명·전원·rpm·부시 가공이 같은 대수끼리 묶어 품명(모델명)·수량(대수)·전원·RPM/OT·스템/부시가공
//  사업 구분은 파일에 없어 산업 분야는 '기타'. 판매번호가 빈 행은 건너뜀
async function ordersFromMfg(buffer) {
  let mfg;
  try { mfg = await HANDLERS.manufacturing_excel.parse(buffer); } catch { return null; }
  const groups = new Map();
  let skipped = 0;
  for (const { values: v, row_no: rowNo, sheet } of mfg.rows) {
    const po = String(v.po_no || '').trim();
    if (!po) { skipped += 1; continue; }
    if (!groups.has(po)) {
      groups.set(po, { sheet, row_no: rowNo, items: new Map(),
        order: { sales_no: po, order_doc_no: po, order_date: '', business_type_raw: '', industry: toIndustry(''), customer: v.customer || '', final_orderer: v.final_orderer || '',
          project_name: v.project_name || '', order_no: '', due_date: v.due_date || '', delivery_date: '', note: '' } });
    }
    const g = groups.get(po);
    const item = { product_name: v.model_name || '(모델명 없음)', power: v.power || '', flange: '', rpm_ot: v.rpm || '', stem_bush: v.bush_machining || '' };
    const k = JSON.stringify(item);
    if (!g.items.has(k)) g.items.set(k, { ...item, quantity: 0 });
    g.items.get(k).quantity += 1;
  }
  const rows = [];
  for (const g of groups.values()) {
    [...g.items.values()].forEach((it, i) => rows.push({ row_no: g.row_no, sheet: `${g.sheet} (제조내역에서)`, values: { ...g.order, item_no: String(i + 1), ...it, quantity: String(it.quantity) } }));
  }
  if (!rows.length) return null;
  return { rows, skipped };
}

async function parseUpload(buffer) {
  const r = parseOrders(buffer) || await ordersFromMfg(buffer);
  if (!r) throw new UploadError(400, "수주내역을 찾을 수 없습니다 — '판매번호·품명·수량' 제목의 수주내역 시트도, 판매번호가 있는 제조내역 시트도 없습니다.");
  return r;
}

// 저장된 판매번호의 지금 값: 키 '판매번호|품목 순번' → 주문 칸 + 그 순번의 제품 칸 (확인 화면과 같은 글자 모양)
async function existingValues(keys) {
  const nos = [...new Set(keys.map((k) => k.split('|')[0]))];
  if (!nos.length) return {};
  const orders = await db.all(`SELECT * FROM sales_orders WHERE sales_no IN (${nos.map(() => '?').join(',')})`, ...nos);
  if (!orders.length) return {};
  const items = await db.all(`SELECT * FROM sales_order_items WHERE order_id IN (${orders.map(() => '?').join(',')}) ORDER BY id`, ...orders.map((o) => o.id));
  const itemsOf = items.reduce((m, it) => ((m[it.order_id] ||= []).push(it), m), {});
  const bySales = Object.fromEntries(orders.map((o) => [o.sales_no, o]));
  const out = {};
  for (const k of keys) {
    const [no, n] = k.split('|');
    const o = bySales[no];
    const it = o && (itemsOf[o.id] || [])[Number(n) - 1];
    if (!it) continue; // 저장된 수주에 없는 순번 → 새 제품으로 추가
    out[k] = Object.fromEntries([...SO_ORDER_KEYS.map((f) => [f, o[f] ?? '']), ...ITEM_KEYS.map((f) => [f, it[f] === null || it[f] === undefined ? '' : String(it[f])])]);
  }
  return out;
}

// 새로 넣기·덮어쓰기 공통 (한 묶음 = 원자적): 수주는 판매번호로 넣거나 덮어쓰고, 제품은 순번 자리에 덮어쓰거나 뒤에 추가
async function write(rows, userId) {
  if (!rows.length) return 0;
  const clean = (v) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x ?? '').trim()]));
  const list = rows.map((r) => clean(r.values));
  const nos = [...new Set(list.map((v) => v.sales_no))];
  const saved = await db.all(`SELECT o.sales_no, i.id FROM sales_order_items i JOIN sales_orders o ON o.id = i.order_id
    WHERE o.sales_no IN (${nos.map(() => '?').join(',')}) ORDER BY i.id`, ...nos);
  const itemIds = saved.reduce((m, r) => ((m[r.sales_no] ||= []).push(r.id), m), {});
  const stmts = [];
  const cols = SO_ORDER_KEYS;
  const orderVal = (v, c) => (SO_DATES.includes(c) ? v[c] || null : v[c]);
  for (const no of nos) {
    const v = list.find((x) => x.sales_no === no);
    stmts.push([`INSERT INTO sales_orders (${cols.join(', ')}, created_by, created_at) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)
      ON CONFLICT(sales_no) DO UPDATE SET ${cols.filter((c) => c !== 'sales_no').map((c) => `${c} = excluded.${c}`).join(', ')}`,
    [...cols.map((c) => orderVal(v, c)), userId ?? null, nowStr()]]);
  }
  for (const v of [...list].sort((a, b) => Number(a.item_no) - Number(b.item_no))) {
    const id = (itemIds[v.sales_no] || [])[Number(v.item_no) - 1];
    const vals = [v.product_name, Number(v.quantity), v.power, v.flange, v.rpm_ot, v.stem_bush];
    if (id) stmts.push(['UPDATE sales_order_items SET product_name = ?, quantity = ?, power = ?, flange = ?, rpm_ot = ?, stem_bush = ? WHERE id = ?', [...vals, id]]);
    else stmts.push(['INSERT INTO sales_order_items (order_id, product_name, quantity, power, flange, rpm_ot, stem_bush) VALUES ((SELECT id FROM sales_orders WHERE sales_no = ?), ?, ?, ?, ?, ?, ?)', [v.sales_no, ...vals]]);
  }
  await db.batch(stmts);
  return rows.length;
}

registerHandler({
  ...pdf,
  kind: 'sales_order_excel',
  extensions: ['.xlsx'],
  updateExisting: true,
  parse: parseUpload,
  // 수주서 PDF와 같은 검사. 다만 엑셀 내보내기에는 납기일이 빈 수주(부품 판매 등)가 있어 납기일 빈 값은 허용 (판매 실적에서 "날짜 빈 수주서"로 안내됨)
  validate(v) {
    const errors = pdf.validate.call(this, v);
    if (errors.due_date && !String(v.due_date ?? '').trim()) delete errors.due_date;
    return errors;
  },
  existingKeys: undefined,
  existingValues,
  save: write,
  update: write,
});
