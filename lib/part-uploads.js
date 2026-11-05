// 부품 단가 업로드 규칙 (읽기 → 확인 화면 → 저장 흐름은 lib/uploads.js)
//  1) part_price_csv     : 부품 단가 데이터 CSV — 회사 "부품 및 단가리스트" [부품] 시트를 CSV로 저장한 파일 그대로
//  2) part_catalog_excel : 신규 부품 등록 엑셀 — 분류·파트넘버·품목·적용모델·기준단가 (CSV도 가능)
//  3) company_price_csv  : 출장지(업체)별 단가 CSV — 파트넘버·품목(선택)·출장지·단가·적용 시작일·비고(선택)
//                          또는 수주 내역 CSV(판매처·수주일·제품정보-품명·제품정보-단가) — 판매처 = 출장지, 수주일 = 적용 시작일
//                          단가표에 없는 파트넘버는 품목이 있으면 단가표에 새로 등록(분류·기준단가 비움)
//
// 1)·2) 머리글은 같은 뜻 다른 이름도 인식한다. 회사 원본 형식:
//   [대외비] 안내 줄 → "종류,,,기준단가" → "구분,품목,적요," (구분 = 파트넘버, 적요 = 적용모델)
//   → "01 현장서비스"처럼 칸 하나만 찬 줄 = 분류 제목 → 그 아래 부품 줄
// 같은 부품 = 같은 파트넘버 → 이미 있으면 새 내용으로 덮어씀(바뀐 칸 표시). 파일 안에 같은 파트넘버가 또 나오면 아래 줄 기준
import XLSX from 'xlsx';
import { db, nowStr } from './db.js';
import { parseIsoDate, registerHandler, UploadError } from './uploads.js';
import { CATALOG_FIELDS, cleanCatalogItem, upsertCatalogStatements, normalize, cleanPrice } from './pricing.js';

// ---------- 파일 → 2차원 표 ----------
// CSV: UTF-8(BOM 있어도 됨)으로 읽고, 깨지면 EUC-KR(엑셀 "CSV" 기본 저장)로 다시 읽는다
function decodeCsv(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('euc-kr').decode(buffer); } catch { return utf8; }
}
const isCsv = (buffer) => !(buffer[0] === 0x50 && buffer[1] === 0x4b) && !(buffer[0] === 0xd0 && buffer[1] === 0xcf); // zip(xlsx)·ole(xls)이 아니면 글자 파일
function readTables(buffer) {
  const wb = isCsv(buffer)
    ? XLSX.read(decodeCsv(buffer), { type: 'string', raw: true })
    : XLSX.read(buffer, { type: 'buffer' });
  // 회사 원본 엑셀은 [부품] 시트만 읽는다 ([제품]·[Data]·[커미션]은 읽지 않음)
  const names = wb.SheetNames.includes('부품') ? ['부품'] : wb.SheetNames;
  return names.map((n) => ({ sheet: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false, rawNumbers: true }) }));
}
const cellText = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const headerKey = (v) => cellText(v).replace(/[\s()·_\-/]/g, '').toLowerCase();

// 머리글 이름(공백·괄호 빼고 비교) → 칸
const ALIASES = {
  category: ['분류', '카테고리', '부품분류', 'category'],
  part_no: ['파트넘버', '파트번호', '부품번호', 'partno', 'partnumber', 'pn'],
  part_no_alt: ['구분'], // 회사 원본: "구분" 칸이 파트넘버
  name: ['품목', '품명', '부품명', '품목명', 'name', 'item'],
  applies_to: ['적용모델', '적용', '모델', '적요', 'model'],
  list_price: ['기준단가', '기준단가원', '단가', '단가원', '가격', 'price'],
  company: ['출장지', '출장지업체', '업체', '업체명', '거래처', '요청처'],
  unit_price: ['단가', '단가원', '업체단가', '견적단가', '금액'],
  effective_date: ['적용시작일', '적용일', '견적일', '견적날짜', '날짜', '일자'],
  note: ['비고', '메모', 'note'],
};
// 머리글 줄 찾기: 위에서 20줄 안에서 필요한 칸이 모두 있는 첫 줄
function findHeader(rows, wanted, optional) {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const keys = rows[i].map(headerKey);
    const col = {};
    for (const f of [...wanted, ...optional]) {
      const idx = keys.findIndex((k, j) => k && ALIASES[f].includes(k) && !Object.values(col).includes(j));
      if (idx >= 0) col[f] = idx;
    }
    if (col.part_no === undefined && col.part_no_alt !== undefined) col.part_no = col.part_no_alt;
    delete col.part_no_alt;
    if (wanted.every((f) => f === 'part_no_alt' || col[f] !== undefined)) return { index: i, col };
  }
  return null;
}
// 금액 칸: 콤마·원·₩ 빼고 정수로. 엑셀 회계 서식으로 저장한 CSV는 0을 " - "로 적으므로 0으로 읽는다
const toDigits = (v) => { const t = cellText(v).replace(/[,\s원₩]/g, ''); if (t === '-') return '0'; return /^-?\d+(\.0+)?$/.test(t) ? String(Math.round(Number(t))) : cellText(v); };

// ======================================================================
// 1)·2) 부품 단가표 (분류·파트넘버·품목·적용모델·기준단가)
// ======================================================================
function parseCatalog(buffer) {
  const out = [];
  let skipped = 0;
  for (const { sheet, rows } of readTables(buffer)) {
    const h = findHeader(rows, ['part_no', 'name'], ['category', 'applies_to', 'list_price', 'part_no_alt']);
    if (!h) continue;
    const { col } = h;
    // 회사 원본: "기준단가"가 머리글 바로 위 줄("종류,,,기준단가")에 있다
    if (col.list_price === undefined) {
      for (let j = h.index - 1; j >= Math.max(0, h.index - 2) && col.list_price === undefined; j -= 1) {
        const idx = rows[j].map(headerKey).findIndex((k) => ['기준단가', '기준단가원'].includes(k));
        if (idx >= 0) col.list_price = idx;
      }
    }
    let category = '';
    for (let i = h.index + 1; i < rows.length; i += 1) {
      const r = rows[i];
      const get = (k) => (col[k] === undefined ? '' : cellText(r[col[k]]));
      const filled = r.map(cellText).filter(Boolean);
      if (!filled.length) continue;
      const partNo = get('part_no');
      // 분류 제목 줄: 칸 하나만 찼고 파트넘버 칸에 있는 글자가 파트넘버처럼 보이지 않음 (예: "01 현장서비스")
      if (filled.length === 1 && col.category === undefined && (!partNo || /\s/.test(partNo)) && !get('list_price')) { category = filled[0]; skipped += 1; continue; }
      if (headerKey(partNo) && ALIASES.part_no.concat(ALIASES.part_no_alt).includes(headerKey(partNo))) { skipped += 1; continue; } // 머리글 반복
      if (!partNo) { skipped += 1; continue; }
      out.push({
        sheet, row_no: i + 1,
        values: {
          category: col.category !== undefined ? get('category') : category,
          part_no: partNo.toUpperCase(), name: get('name'), applies_to: get('applies_to'),
          list_price: col.list_price === undefined ? '' : toDigits(r[col.list_price]),
        },
      });
    }
    if (out.length) break;
  }
  if (!out.length && parseOrderExport(readTables(buffer)).found) {
    throw new UploadError(400, '이 파일은 수주 내역(판매처·수주일·제품정보) 형식입니다. 위에서 "출장지(판매처)별 단가"를 고른 뒤 올려 주세요.');
  }
  if (!out.length) {
    throw new UploadError(400, '파트넘버·품목 머리글을 찾을 수 없습니다. 첫 줄(또는 위쪽 20줄 안)에 "분류, 파트넘버, 품목, 적용모델, 기준단가" 머리글이 있는지 확인해 주세요.');
  }
  return { rows: out, skipped };
}

const catalogHandler = {
  team: 'service', keyField: 'part_no', updateExisting: true,
  columns: CATALOG_FIELDS.map(([k, l]) => [k, l]),
  parse: parseCatalog,
  validate: (v) => cleanCatalogItem(v).errors,
  // 이미 있는 파트넘버의 지금 값 (확인 화면과 같은 글자 모양)
  async existingValues(keys) {
    if (!keys.length) return {};
    const rows = await db.all(`SELECT * FROM part_catalog WHERE upper(trim(part_no)) IN (${keys.map(() => '?').join(',')}) ORDER BY id`, ...keys);
    const out = {};
    for (const r of rows) {
      out[String(r.part_no).trim().toUpperCase()] ??= Object.fromEntries(CATALOG_FIELDS.map(([k]) => [k, r[k] === null || r[k] === undefined ? '' : String(r[k])]));
    }
    return out;
  },
  async save(rows) {
    if (!rows.length) return 0;
    await db.batch(await upsertCatalogStatements(rows.map((r) => cleanCatalogItem(r.values).values)));
    return rows.length;
  },
  async update(rows) { return this.save(rows); },
};
registerHandler({ ...catalogHandler, kind: 'part_price_csv', extensions: ['.csv'] });
registerHandler({ ...catalogHandler, kind: 'part_catalog_excel', extensions: ['.xlsx', '.xls', '.csv'] });

// ======================================================================
// 3) 출장지(업체)별 단가 — 같은 부품·출장지·적용 시작일이면 새 단가로 덮어씀
// ======================================================================
const dateText = (v) => {
  const t = cellText(v);
  if (/^\d+(\.\d+)?$/.test(t) && Number(t) > 20000 && Number(t) < 80000) { // 엑셀 날짜 숫자
    const d = XLSX.SSF.parse_date_code(Number(t));
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const m = t.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : t;
};
// 수주 내역 CSV (회사 판매 관리 프로그램에서 내보낸 파일, 예: 부품단가데이터.csv)
//  한 줄 = 판매 품목 1개. 한 수주에 품목이 여럿이면 둘째 줄부터는 수주 정보 칸이 비어 있다 → 같은 *ID의 첫 줄 값을 쓴다
//  제품정보-품명 = "MD-07-A-01 Main Board for NTI-04" → 파트넘버 / 품목 / 적용모델("for" 뒤)
//  출장지(업체) = 판매처, 적용 시작일 = 수주일, 단가 = 제품정보-단가 (판매가 = 단가 × 수량이라 쓰지 않음)
//  파트넘버가 없는 줄(출장수리비·nego 등)과 단가가 빈 줄은 건너뜀
const ORDER_COLS = { id: ['*id', 'id'], product: ['제품정보품명'], unit_price: ['제품정보단가'], company: ['판매처'], date: ['수주일'], so_no: ['판매번호'], project: ['사업명'] };
const PRODUCT_PART = /^([A-Z]{1,4}\d*(?:-[A-Z0-9]{1,4}){2,})\s+(.+)$/i;
export function splitProduct(text) {
  const m = cellText(text).match(PRODUCT_PART);
  if (!m || !/\d/.test(m[1])) return null;
  const f = m[2].match(/^(.*?)\s+for\s+(.+)$/i);
  return { part_no: m[1].toUpperCase(), name: (f ? f[1] : m[2]).trim(), applies_to: f ? f[2].trim() : '' };
}
function parseOrderExport(tables) {
  for (const { sheet, rows } of tables) {
    const hi = rows.slice(0, 20).findIndex((r) => ['product', 'unit_price', 'company', 'date'].every((k) => r.map(headerKey).some((x) => ORDER_COLS[k].includes(x))));
    if (hi < 0) continue;
    const keys = rows[hi].map(headerKey);
    const col = Object.fromEntries(Object.entries(ORDER_COLS).map(([k, names]) => [k, keys.findIndex((x) => names.includes(x))]));
    const get = (r, k) => (col[k] < 0 ? '' : cellText(r[col[k]]));
    const out = [];
    let skipped = 0;
    let order = {};
    const orders = {};
    for (let i = hi + 1; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r.map(cellText).some(Boolean)) continue;
      const id = get(r, 'id').replace(/"/g, '');
      if (get(r, 'company') || get(r, 'date')) {
        order = { company: get(r, 'company'), date: get(r, 'date'), so_no: get(r, 'so_no'), project: get(r, 'project') };
        if (id) orders[id] = order;
      } else if (id && orders[id]) order = orders[id];
      const part = splitProduct(get(r, 'product'));
      const price = col.unit_price < 0 ? '' : toDigits(r[col.unit_price]);
      if (!part || !price) { skipped += 1; continue; }
      out.push({
        sheet, row_no: i + 1,
        values: { ...part, company: order.company || '', unit_price: price, effective_date: dateText(order.date), note: '',
          quote_no: order.so_no || '', project: order.project || '', format: 'order' },
      });
    }
    return { rows: out, skipped, found: true };
  }
  return { found: false };
}

function parseCompanyPrices(buffer) {
  const out = [];
  let skipped = 0;
  const tables = readTables(buffer);
  const order = parseOrderExport(tables);
  if (order.found) {
    if (!order.rows.length) throw new UploadError(400, '수주 내역에서 파트넘버(예: MD-07-A-01)와 단가가 있는 줄을 찾지 못했습니다.');
    return order;
  }
  for (const { sheet, rows } of tables) {
    const h = findHeader(rows, ['part_no', 'company', 'unit_price', 'effective_date'], ['name', 'note']);
    if (!h) continue;
    const get = (r, k) => (h.col[k] === undefined ? '' : cellText(r[h.col[k]]));
    for (let i = h.index + 1; i < rows.length; i += 1) {
      const r = rows[i];
      if (!r.map(cellText).some(Boolean)) continue;
      if (!get(r, 'part_no')) { skipped += 1; continue; }
      out.push({
        sheet, row_no: i + 1,
        values: {
          part_no: get(r, 'part_no').toUpperCase(), name: get(r, 'name'), company: get(r, 'company'),
          unit_price: toDigits(r[h.col.unit_price]), effective_date: dateText(r[h.col.effective_date]), note: get(r, 'note'),
        },
      });
    }
    if (out.length) break;
  }
  if (!out.length) throw new UploadError(400, '머리글을 찾을 수 없습니다. "파트넘버, 품목(선택), 출장지, 단가, 적용 시작일, 비고(선택)" 머리글이 있는지 확인해 주세요.');
  return { rows: out, skipped };
}
// 파트넘버(+ 품목)로 단가표 부품 찾기: 파트넘버가 같은 부품이 여럿이면 품목으로 고른다
async function catalogIndex() {
  const items = await db.all('SELECT id, part_no, name FROM part_catalog');
  const by = {};
  for (const i of items) (by[normalize(i.part_no)] ||= []).push(i);
  return (v) => {
    const list = by[normalize(v.part_no)] || [];
    if (list.length <= 1) return list[0] || null;
    return list.find((i) => normalize(i.name) === normalize(v.name)) || null;
  };
}
// 수주 내역 줄은 같은 파트넘버를 같은 부품으로 본다(품명 표기가 줄마다 달라도) → 품목은 기준에서 뺀다
const companyKey = (v) => (v.part_no ? `${normalize(v.part_no)}|${v.format === 'order' ? '' : normalize(v.name)}|${String(v.company || '').trim()}|${String(v.effective_date || '').trim()}` : null);
// 단가표에 없는 파트넘버: 품목이 있으면 단가표에 새로 등록(분류·기준단가는 비움, 나중에 신규 부품 등록에서 채움)
const canAutoRegister = (v) => !!String(v.name || '').trim();
// 파트넘버로 단가표 부품 id 찾기 (저장 묶음 안에서 방금 새로 등록한 부품도 찾도록 SQL 안에서 찾는다)
const ITEM_ID_SQL = '(SELECT id FROM part_catalog WHERE upper(trim(part_no)) = upper(trim(?)) ORDER BY id LIMIT 1)';
async function newCatalogStatements(rows, find) {
  const seen = new Set();
  const items = [];
  for (const { values: v } of rows) {
    const k = normalize(v.part_no);
    if (find(v) || seen.has(k)) continue;
    seen.add(k);
    items.push({ category: '', part_no: v.part_no.trim().toUpperCase(), name: v.name.trim().slice(0, 200), applies_to: String(v.applies_to || '').trim().slice(0, 200), list_price: null });
  }
  return items.length ? upsertCatalogStatements(items) : [];
}

registerHandler({
  kind: 'company_price_csv', team: 'service', extensions: ['.csv', '.xlsx'], keyField: 'part_no', updateExisting: true,
  columns: [['part_no', '파트넘버'], ['name', '품목(선택)'], ['company', '출장지(업체)'], ['unit_price', '단가(원)'], ['effective_date', '적용 시작일'], ['note', '비고']],
  parse: parseCompanyPrices,
  duplicateKey: companyKey,
  validate(v) {
    const errors = {};
    if (!String(v.part_no || '').trim()) errors.part_no = '파트넘버가 없습니다.';
    if (!String(v.company || '').trim()) errors.company = '출장지(업체)가 없습니다.';
    else if (String(v.company).length > 100) errors.company = '100자 이하로 입력해 주세요.';
    try { if (cleanPrice(v.unit_price, '단가') === null) errors.unit_price = '단가가 없습니다.'; } catch (e) { errors.unit_price = e.message; }
    try { if (!parseIsoDate(v.effective_date)) errors.effective_date = '적용 시작일이 없습니다.'; } catch { errors.effective_date = '날짜 형식: 2026-03-10'; }
    return errors;
  },
  async validateAll(rows) {
    const find = await catalogIndex();
    for (const r of rows) {
      r.new_part = false;
      if (r.errors.part_no || find(r.values)) continue;
      const many = (await db.all('SELECT 1 FROM part_catalog WHERE upper(trim(part_no)) = upper(trim(?))', r.values.part_no)).length > 1;
      if (many) r.errors.part_no = '이 파트넘버의 부품이 여럿입니다. 품목 칸에 정확한 품목을 적어 주세요.';
      else if (canAutoRegister(r.values)) r.new_part = true; // 저장할 때 단가표에 새로 등록
      else r.errors.part_no = '단가표에 없는 파트넘버입니다. 품목을 적으면 새 부품으로 함께 등록합니다.';
    }
  },
  async existingValues(keys) {
    if (!keys.length) return {};
    const want = new Set(keys);
    const rows = await db.all(`SELECT p.unit_price, p.quote_note, p.quote_company, p.effective_date, c.part_no, c.name,
      (SELECT COUNT(*) FROM part_catalog x WHERE upper(trim(x.part_no)) = upper(trim(c.part_no))) AS same_no
      FROM part_prices p JOIN part_catalog c ON c.id = p.catalog_item_id ORDER BY p.id`);
    const out = {};
    for (const r of rows) {
      // 파트넘버가 하나뿐인 부품은 품목 칸이 비어 있어도 같은 행으로 본다
      for (const name of r.same_no > 1 ? [r.name] : [r.name, '']) {
        const k = companyKey({ part_no: r.part_no, name, company: r.quote_company, effective_date: r.effective_date });
        if (want.has(k)) out[k] = { unit_price: String(r.unit_price), note: r.quote_note || '' };
      }
    }
    return out;
  },
  // 단가표에 없는 부품 등록 + 단가 저장을 한 묶음(원자적)으로
  async save(rows, userId) {
    if (!rows.length) return 0;
    const find = await catalogIndex();
    const prices = rows.map(({ values: v }) => {
      const item = find(v);
      const ref = item ? ['?', item.id] : [ITEM_ID_SQL, v.part_no];
      return [`INSERT INTO part_prices (part_name, catalog_item_id, unit_price, effective_date, source, quote_no, quote_project, quote_company, quote_note, created_by, created_at)
        VALUES (?, ${ref[0]}, ?, ?, 'upload', ?, ?, ?, ?, ?, ?)`, [item ? item.name : v.name.trim(), ref[1], cleanPrice(v.unit_price), v.effective_date,
        String(v.quote_no || '').trim(), String(v.project || '').trim(), v.company.trim(), String(v.note || '').trim(), userId, nowStr()]];
    });
    await db.batch([...await newCatalogStatements(rows, find), ...prices]);
    return rows.length;
  },
  async update(rows) {
    const find = await catalogIndex();
    await db.batch(rows.map(({ values: v }) => {
      const item = find(v);
      const order = v.format === 'order';
      return [`UPDATE part_prices SET unit_price = ?, quote_note = ?, source = 'upload'${order ? ', quote_no = ?, quote_project = ?' : ''} WHERE catalog_item_id = ? AND quote_company = ? AND effective_date = ?`,
        [cleanPrice(v.unit_price), String(v.note || '').trim(), ...(order ? [String(v.quote_no || '').trim(), String(v.project || '').trim()] : []), item.id, v.company.trim(), v.effective_date]];
    }));
    return rows.length;
  },
});
