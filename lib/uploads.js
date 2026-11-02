// 팀 업로드 공통 (ITB2026 uploads 앱을 옮겨 옴): 업로드 → 추출 → 사람이 확인·수정 → 저장 또는 취소
// 원본 파일은 보관하지 않고 추출 결과(행 목록)만 upload_batches.data(JSON)에 둔다.
// 파일 종류마다 handler를 하나 두고 parse / validate / existingKeys(또는 existingValues) / save(/update)를 정한다.
//
// 추출 결과 한 행: { id, row_no, sheet, values: {...}, errors: {칸: 메시지}, duplicate, excluded, ... }
import ExcelJS from 'exceljs';
import { db, nowStr } from './db.js';
import { todayStr } from './production.js';

export class UploadError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; Object.assign(this, extra); }
}

const KIND_LABEL = { manufacturing_excel: '제조내역 엑셀', sales_order_pdf: '수주서 PDF', trip_report_pdf: '출장보고서 PDF', quote_pdf: '견적서 PDF' };
const STATUS_LABEL = { extracted: '확인 대기', saving: '저장 중', saved: '저장 완료', cancelled: '취소' };
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// ---------- 날짜 ----------
export function parseIsoDate(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('날짜 형식');
  return t;
}

// ======================================================================
// 제조내역 엑셀
// ======================================================================
// 샘플 엑셀 구조: 위쪽 몇 줄은 작성방법 안내, 제목이 두 줄(병합) → "일련번호" 제목이 있는 줄을 찾아 그 아래부터 읽는다
// 셀에는 짧은 값만 있고 앞부분은 셀 표시 형식에 있다:
//   일련번호 '0001' + 형식 "N8226"@ → N82260001 / 모델명 '04' + "NTI-"@ → NTI-04 / 검사번호 '001' + "NTK26"@ → NTK26001
// 일련번호가 없는 행(오른쪽 OPUN 등 숫자만 있는 행)은 제외한다
const HEADER_MAP = {
  일련번호: 'serial', 모델명: 'model_name', 부시가공: 'bush_machining', rpm: 'rpm', 전원: 'power', 제조년월: 'manufactured_date',
  검사일자: 'inspection_date', 검사번호: 'inspection_no', PO번호: 'po_no', SO번호: 'so_no', 거래처주문번호: 'customer_order_no',
  거래처: 'customer', 최종발주처: 'final_orderer', 사업명: 'project_name', 납기일: 'due_date', 출고일: 'shipped_date', 비고: 'note',
};
const MFG_DATE_FIELDS = ['manufactured_date', 'inspection_date', 'due_date', 'shipped_date'];
const SERIAL_PATTERN = /^(NE|N|M|B|Q|C|P)\d{8}$/; // 타입 문자 + 국가 2 + 년도 2 + 번호 4
const TEXT_PREFIX = /^"([^"]*)"@$/; // 예: "N8226"@
const NUMBER_PREFIX = /^"([^"]*)"(0+)$/; // 예: "NTK26"000
const MFG_LIMITS = { serial_full: 20, model_name: 30, bush_machining: 10, rpm: 20, power: 30, inspection_no: 20, po_no: 20, so_no: 30,
  customer_order_no: 50, customer: 100, final_orderer: 100, project_name: 200, note: 200 };
const norm = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ''));
const numText = (v) => (Number.isInteger(v) ? String(v) : String(v));
const isoOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
// ExcelJS 셀 값 → 기본 값 (수식은 계산된 값, 서식 있는 글자는 이어 붙인 글자)
function rawValue(cell) {
  let v = cell.value;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((t) => t.text).join('');
    else if ('text' in v) v = v.text;
    else if ('error' in v) v = null;
  }
  return v;
}
// 병합된 칸의 아래·오른쪽 칸은 비어 있는 것으로 본다 (openpyxl과 같게)
const headerText = (cell) => (cell.isMerged && cell.master !== cell ? '' : norm(rawValue(cell)));
function displayText(cell) {
  const v = rawValue(cell);
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date) return isoOf(v);
  const fmt = cell.numFmt || '';
  const np = fmt.match(NUMBER_PREFIX);
  if (np && typeof v === 'number') return np[1] + numText(v).padStart(np[2].length, '0');
  const text = typeof v === 'number' ? numText(v) : String(v).trim();
  const tp = fmt.match(TEXT_PREFIX);
  return tp ? tp[1] + text : text;
}
function dateText(cell) {
  const v = rawValue(cell);
  // 날짜가 숫자(예: 46031)로 저장된 경우 → 2026-01-09
  if (typeof v === 'number') return isoOf(new Date(Math.round((v - 25569) * 86400000)));
  return displayText(cell);
}
function serialOf(cell) {
  const v = rawValue(cell);
  const short = typeof v === 'number' ? numText(v).padStart(4, '0') : String(v).trim();
  const fmt = cell.numFmt || '';
  const m = fmt.match(TEXT_PREFIX) || fmt.match(NUMBER_PREFIX);
  return (m ? m[1] : '') + short;
}

function parseMfgSheet(ws) {
  let headerRow = null;
  for (let r = 1; r <= Math.min(ws.rowCount, 30) && !headerRow; r += 1) {
    for (let c = 1; c <= Math.min(ws.columnCount, 40); c += 1) if (norm(rawValue(ws.getCell(r, c))) === '일련번호') { headerRow = r; break; }
  }
  if (!headerRow) return null;
  // 제목이 두 줄이므로 아래 줄(예: PO번호, SO번호)을 먼저 보고, 없으면 위 줄 제목을 쓴다. 같은 제목이 두 번 나오면 왼쪽 열
  const colOf = {};
  const labeled = new Set();
  let subUsed = false;
  for (let c = 1; c <= ws.columnCount; c += 1) {
    const upper = headerText(ws.getCell(headerRow, c));
    const lower = headerText(ws.getCell(headerRow + 1, c));
    if (upper || lower) labeled.add(c);
    for (const name of [lower, upper]) {
      const field = name && (HEADER_MAP[name] || HEADER_MAP[name.toLowerCase()]);
      if (field && !(field in colOf)) { colOf[field] = c; if (name === lower) subUsed = true; break; }
    }
  }
  const rows = [];
  let skipped = 0;
  for (let r = headerRow + (subUsed ? 2 : 1); r <= ws.rowCount; r += 1) {
    const serialCell = ws.getCell(r, colOf.serial);
    const sv = rawValue(serialCell);
    if (sv === null || sv === undefined || sv === '') {
      if ([...labeled].some((c) => { const x = rawValue(ws.getCell(r, c)); return x !== null && x !== undefined && x !== ''; })) skipped += 1;
      continue;
    }
    const values = { serial_full: serialOf(serialCell) };
    for (const [field, c] of Object.entries(colOf)) {
      if (field === 'serial') continue;
      const cell = ws.getCell(r, c);
      const v = rawValue(cell);
      if (MFG_DATE_FIELDS.includes(field)) values[field] = dateText(cell);
      else if (field === 'bush_machining' && typeof v === 'number') values[field] = numText(v).padStart(6, '0');
      else if (field === 'po_no') values[field] = displayText(cell).replace(/^#+/, '');
      else values[field] = displayText(cell);
    }
    for (const [key] of MFG_COLUMNS) values[key] ??= '';
    rows.push({ row_no: r, sheet: ws.name, values });
  }
  return { rows, skipped };
}

const MFG_COLUMNS = [
  ['serial_full', '일련번호'], ['model_name', '모델명'], ['bush_machining', '부시 가공'], ['rpm', 'rpm'], ['power', '전원'],
  ['manufactured_date', '제조년월'], ['inspection_date', '검사일자'], ['inspection_no', '검사번호'], ['po_no', 'PO번호'], ['so_no', 'SO번호'],
  ['customer_order_no', '거래처 주문번호'], ['customer', '거래처'], ['final_orderer', '최종발주처'], ['project_name', '사업명'],
  ['due_date', '납기일'], ['shipped_date', '출고일'], ['note', '비고'],
];
const manufacturingExcel = {
  kind: 'manufacturing_excel',
  team: 'production',
  extensions: ['.xlsx'],
  keyField: 'serial_full',
  updateExisting: true, // 같은 일련번호가 다시 올라오면 최신 값으로 갱신 (파일 안에서는 마지막 행 기준)
  columns: MFG_COLUMNS,
  async parse(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    let rows = [];
    let skipped = 0;
    let found = false;
    wb.eachSheet((ws) => {
      const r = parseMfgSheet(ws);
      if (!r) return;
      found = true;
      rows = rows.concat(r.rows);
      skipped += r.skipped;
    });
    if (!found) throw new UploadError(400, "'일련번호' 제목 칸을 찾을 수 없습니다. 제조내역 엑셀 양식인지 확인해 주세요.");
    return { rows, skipped };
  },
  validate(v) {
    const errors = {};
    const serial = String(v.serial_full || '').trim();
    if (!serial) errors.serial_full = '일련번호가 없습니다.';
    else if (!SERIAL_PATTERN.test(serial)) errors.serial_full = '형식: 타입 문자(N/M/B/Q/C/P/NE) + 숫자 8자리 (예: N82260001)';
    for (const f of MFG_DATE_FIELDS) {
      try {
        if (parseIsoDate(v[f]) === null && f === 'manufactured_date') errors[f] = '제조년월이 없습니다 (생산량 집계 기준).';
      } catch { errors[f] = '날짜 형식: YYYY-MM-DD'; }
    }
    const bush = String(v.bush_machining || '').trim();
    if (bush && !/^\d{6}$/.test(bush)) errors.bush_machining = '숫자 6자리 (예: 301008)';
    for (const [key, limit] of Object.entries(MFG_LIMITS)) {
      if (String(v[key] || '').length > limit && !errors[key]) errors[key] = `${limit}자 이하로 입력해 주세요.`;
    }
    return errors;
  },
  // 이미 저장된 일련번호의 지금 값 (확인 화면과 같은 글자 모양: 날짜 YYYY-MM-DD, 빈 값 '')
  async existingValues(keys) {
    if (!keys.length) return {};
    const out = {};
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      const rows = await db.all(`SELECT * FROM mfg_records WHERE serial_full IN (${chunk.map(() => '?').join(',')})`, ...chunk);
      for (const r of rows) out[r.serial_full] = Object.fromEntries(MFG_COLUMNS.map(([k]) => [k, r[k] ?? '']));
    }
    return out;
  },
  clean(row) {
    const v = Object.fromEntries(MFG_COLUMNS.map(([k]) => [k, String(row.values[k] ?? '').trim()]));
    for (const f of MFG_DATE_FIELDS) v[f] = v[f] || null;
    v.serial_full = v.serial_full.toUpperCase();
    return v;
  },
  async save(rows, userId) {
    const cols = MFG_COLUMNS.map(([k]) => k);
    await db.batch(rows.map((row) => {
      const v = this.clean(row);
      return [`INSERT INTO mfg_records (${cols.join(', ')}, serial_short, source_sheet, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?)`,
        [...cols.map((c) => v[c]), v.serial_full.slice(-4), row.sheet || '', userId]];
    }));
    return rows.length;
  },
  // 이미 있는 일련번호를 새로 올린 값으로 고친다 (최신 업로드 기준, 처음 입력자는 그대로)
  async update(rows) {
    const cols = MFG_COLUMNS.map(([k]) => k).filter((k) => k !== 'serial_full');
    await db.batch(rows.map((row) => {
      const v = this.clean(row);
      return [`UPDATE mfg_records SET ${cols.map((c) => `${c} = ?`).join(', ')}, serial_short = ?, source_sheet = ?, updated_at = ? WHERE serial_full = ?`,
        [...cols.map((c) => v[c]), v.serial_full.slice(-4), row.sheet || '', nowStr(), v.serial_full]];
    }));
    return rows.length;
  },
};

export const HANDLERS = { manufacturing_excel: manufacturingExcel };
export const registerHandler = (h) => { HANDLERS[h.kind] = h; };

// ======================================================================
// 행 검사
// ======================================================================
async function checkRows(h, rows) {
  if (h.updateExisting) return checkRowsLatest(h, rows);
  const active = rows.filter((r) => !r.excluded);
  const keys = active.map((r) => (h.duplicateKey ? h.duplicateKey(r.values) : String(r.values[h.keyField] || '').trim() || null));
  const existing = await h.existingKeys([...new Set(keys.filter(Boolean))]);
  const seen = new Set();
  active.forEach((row, i) => {
    const key = keys[i];
    const errors = h.validate(row.values);
    const override = h.allowDuplicateOverride && !!row.allow_duplicate;
    row.in_file_duplicate = !!(key && seen.has(key));
    row.matches_existing = !!(key && existing.has(key));
    if (row.in_file_duplicate && !override && !errors[h.keyField]) errors[h.keyField] = '파일 안에서 같은 기준 번호가 이미 나왔습니다.';
    if (key) seen.add(key);
    row.duplicate = row.matches_existing && !override; // 이미 저장됨 → 저장 때 건너뜀
    row.errors = row.duplicate ? {} : errors;
  });
  await h.validateAll?.(active.filter((r) => !r.duplicate));
  for (const row of rows) if (row.excluded) Object.assign(row, { errors: {}, duplicate: false, matches_existing: false, in_file_duplicate: false });
  return rows;
}
// 최신 업로드 기준: superseded(파일 아래쪽에 같은 번호가 다시 나옴) / update(이미 있는데 값이 바뀜) / duplicate(건너뜀)
async function checkRowsLatest(h, rows) {
  const active = rows.filter((r) => !r.excluded);
  const keys = active.map((r) => String(r.values[h.keyField] || '').trim().toUpperCase() || null);
  const last = {};
  const counts = {};
  keys.forEach((k, i) => { if (k) { last[k] = i; counts[k] = (counts[k] || 0) + 1; } });
  const existing = await h.existingValues([...new Set(keys.filter(Boolean))]);
  active.forEach((row, i) => {
    const key = keys[i];
    const errors = h.validate(row.values);
    const superseded = !!(key && last[key] !== i);
    const changes = {};
    row.superseded = superseded;
    row.in_file_duplicate = !!(key && counts[key] > 1);
    row.matches_existing = !!(key && existing[key]);
    if (row.matches_existing && !superseded) {
      for (const [field, old] of Object.entries(existing[key])) {
        const nv = String(row.values[field] ?? '').trim();
        if (String(old) !== nv) changes[field] = { old: String(old), new: nv };
      }
    }
    row.changes = changes;
    row.update = row.matches_existing && Object.keys(changes).length > 0 && !superseded;
    row.duplicate = superseded || (row.matches_existing && !Object.keys(changes).length);
    row.errors = row.duplicate ? {} : errors;
  });
  await h.validateAll?.(active.filter((r) => !r.duplicate));
  for (const row of rows) {
    if (row.excluded) Object.assign(row, { errors: {}, duplicate: false, changes: {}, matches_existing: false, in_file_duplicate: false, superseded: false, update: false });
  }
  return rows;
}
function summarize(rows, skipped = 0) {
  const active = rows.filter((r) => !r.excluded);
  const hasErr = (r) => Object.keys(r.errors || {}).length > 0;
  return {
    total: rows.length,
    error_rows: active.filter(hasErr).length,
    duplicate_rows: active.filter((r) => r.duplicate && !hasErr(r)).length,
    excluded_rows: rows.length - active.length,
    to_save: active.filter((r) => !hasErr(r) && !r.duplicate).length,
    update_rows: active.filter((r) => r.update && !hasErr(r)).length,
    superseded_rows: active.filter((r) => r.superseded).length,
    skipped_rows: skipped,
  };
}
// 확인 화면에 보낼 열 정보: choices(선택 목록), choices_by+choices_map(같은 행의 다른 칸에 따라 바뀌는 목록), multiline, suggestions(추천 목록)
async function columnSpecs(h) {
  const lists = h.suggestions ? await h.suggestions() : {};
  return h.columns.map(([key, label, opts]) => {
    const spec = { key, label, ...(opts || {}) };
    if (spec.suggestions) spec.suggestions = lists[spec.suggestions] || [];
    return spec;
  });
}

function batchData(b) {
  const data = typeof b.data === 'string' ? JSON.parse(b.data || '{}') : b.data;
  const h = HANDLERS[b.kind];
  return {
    id: b.id, kind: b.kind, kind_display: KIND_LABEL[b.kind] || b.kind, file_name: b.file_name, status: b.status,
    columns: data.columns || [], rows: data.rows || [], summary: summarize(data.rows || [], data.skipped_count || 0),
    saved_count: Number(b.saved_count), allow_duplicate_override: !!h?.allowDuplicateOverride, update_existing: !!h?.updateExisting,
  };
}
const canEdit = (user, team) => !!user?.[`perm_edit_${team}`];

// ======================================================================
// API 동작
// ======================================================================
export async function createBatch(body, user) {
  const h = HANDLERS[body.kind];
  if (!h) throw new UploadError(400, '아직 지원하지 않는 파일 종류입니다.');
  if (!canEdit(user, h.team)) throw new UploadError(403, '이 파일을 업로드할 권한이 없습니다.');
  const name = String(body.file_name || '').trim().slice(0, 255);
  if (!name || !body.file) throw new UploadError(400, '파일을 선택해 주세요.');
  if (!h.extensions.some((e) => name.toLowerCase().endsWith(e))) throw new UploadError(400, `${h.extensions.join(', ')} 파일만 올릴 수 있습니다.`);
  const buffer = Buffer.from(String(body.file), 'base64');
  if (buffer.length > MAX_FILE_SIZE) throw new UploadError(400, '10MB 이하 파일만 올릴 수 있습니다.');
  let parsed;
  try {
    parsed = await h.parse(buffer);
  } catch (e) {
    if (e instanceof UploadError) throw e;
    if (e.userMessage) throw new UploadError(400, e.message);
    console.error('파일 추출 실패', name, e);
    throw new UploadError(400, '파일을 읽을 수 없습니다. 양식과 파일 형식을 확인해 주세요.');
  }
  const rows = parsed.rows.map((r, i) => ({ ...r, id: i, excluded: false }));
  await checkRows(h, rows);
  const data = { columns: await columnSpecs(h), rows, skipped_count: parsed.skipped || 0 };
  const res = await db.run('INSERT INTO upload_batches (kind, file_name, data, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    h.kind, name, JSON.stringify(data), user.id, nowStr(), nowStr());
  return batchData(await db.get('SELECT * FROM upload_batches WHERE id = ?', res.lastInsertRowid));
}

async function getBatch(id, user) {
  const b = await db.get('SELECT * FROM upload_batches WHERE id = ?', Number(id));
  if (!b) throw new UploadError(404, '없는 업로드입니다.');
  const h = HANDLERS[b.kind];
  if (!canEdit(user, h.team)) throw new UploadError(403, '이 파일을 업로드할 권한이 없습니다.');
  if (b.status !== 'extracted') throw new UploadError(400, `이미 처리된 업로드입니다 (${STATUS_LABEL[b.status]}).`);
  return { b, h, data: JSON.parse(b.data || '{}') };
}

// 확인 화면에서 고친 값·제외 여부 반영 후 다시 검사
export async function patchBatch(id, body, user) {
  const { b, h, data } = await getBatch(id, user);
  const editable = new Set(h.columns.map(([k]) => k));
  const byId = Object.fromEntries(data.rows.map((r) => [r.id, r]));
  for (const ch of body.rows || []) {
    const row = byId[ch.id];
    if (!row) continue;
    for (const [k, v] of Object.entries(ch.values || {})) if (editable.has(k)) row.values[k] = v === null || v === undefined ? '' : String(v);
    if ('excluded' in ch) row.excluded = !!ch.excluded;
    if ('allow_duplicate' in ch && h.allowDuplicateOverride) row.allow_duplicate = !!ch.allow_duplicate;
  }
  await checkRows(h, data.rows);
  await db.run('UPDATE upload_batches SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(data), nowStr(), b.id);
  return batchData({ ...b, data });
}

// 최종 저장: 저장 직전에 다시 검사, 오류가 있으면 저장하지 않음. 이미 있는 번호는 건너뛰거나(기본) 갱신(최신 업로드 기준 종류)
export async function confirmBatch(id, user) {
  const { b, h, data } = await getBatch(id, user);
  // 두 번 누름 방지: 상태를 먼저 '저장 중'으로 바꾸는 데 성공한 요청만 진행
  const lock = await db.run("UPDATE upload_batches SET status = 'saving' WHERE id = ? AND status = 'extracted'", b.id);
  if (!lock.changes) throw new UploadError(409, '이미 저장 중인 업로드입니다.');
  try {
    await checkRows(h, data.rows);
    const sum = summarize(data.rows);
    if (sum.error_rows) {
      await db.run("UPDATE upload_batches SET status = 'extracted', data = ?, updated_at = ? WHERE id = ?", JSON.stringify(data), nowStr(), b.id);
      throw new UploadError(400, `오류가 있는 행이 ${sum.error_rows}개 있습니다. 고치거나 제외한 뒤 저장해 주세요.`, { batch: batchData({ ...b, data }) });
    }
    const toSave = data.rows.filter((r) => !r.excluded && !r.duplicate);
    const updates = toSave.filter((r) => r.update);
    let saved = await h.save(toSave.filter((r) => !r.update), user.id);
    if (updates.length) saved += await h.update(updates, user.id);
    await db.run("UPDATE upload_batches SET status = 'saved', saved_count = ?, data = ?, updated_at = ? WHERE id = ?", saved, JSON.stringify(data), nowStr(), b.id);
    return batchData({ ...b, data, status: 'saved', saved_count: saved });
  } catch (e) {
    if (!(e instanceof UploadError)) await db.run("UPDATE upload_batches SET status = 'extracted' WHERE id = ? AND status = 'saving'", b.id);
    throw e;
  }
}

export async function cancelBatch(id, user) {
  const { b, data } = await getBatch(id, user);
  await db.run("UPDATE upload_batches SET status = 'cancelled', updated_at = ? WHERE id = ?", nowStr(), b.id);
  return batchData({ ...b, data, status: 'cancelled' });
}

// 업로드 이력: 그 팀 파일 종류만, 최근 100건 (그 팀 수정 권한)
export async function history(team, user) {
  const kinds = Object.values(HANDLERS).filter((h) => h.team === team).map((h) => h.kind);
  if (!['production', 'service'].includes(team)) throw new UploadError(400, 'team은 production 또는 service여야 합니다.');
  if (!canEdit(user, team)) throw new UploadError(403, '이 팀의 업로드 이력을 볼 권한이 없습니다.');
  const rows = kinds.length ? await db.all(`SELECT b.id, b.kind, b.file_name, b.status, b.data, b.saved_count, b.created_at, u.name AS uploader
    FROM upload_batches b LEFT JOIN users u ON u.id = b.created_by WHERE b.kind IN (${kinds.map(() => '?').join(',')})
    ORDER BY b.created_at DESC, b.id DESC LIMIT 100`, ...kinds) : [];
  return {
    limit: 100,
    results: rows.map((b) => ({
      id: b.id, created_at: b.created_at, uploaded_by: b.uploader || '-', kind: b.kind, kind_display: KIND_LABEL[b.kind] || b.kind,
      file_name: b.file_name, status: b.status, status_display: STATUS_LABEL[b.status] || b.status,
      row_count: (JSON.parse(b.data || '{}').rows || []).length, saved_count: Number(b.saved_count),
    })),
    today: todayStr(),
  };
}
