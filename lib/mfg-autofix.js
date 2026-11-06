// 제조내역(생산 데이터) 업로드: 흔한 입력 오타를 자동으로 고치고, 고친 칸·확인이 필요한 칸을 확인 화면에 알린다
//  row.fixes    = { 칸: '원래 값 → 고친 이유' }   (값은 이미 고쳐져 있음, 저장을 막지 않음)
//  row.warnings = { 칸: '확인 필요 이유' }        (값은 그대로, 저장을 막지 않음)
// 규칙 (회사 생산데이터 엑셀에서 실제로 나온 오타 기준)
//  1) 일련번호 번호 부분이 3자리: N8226544 → N82260544 (검사번호 NTK26544의 년도·번호로 확인)
//  2) 검사번호 년도 오타: NTK25293 인데 일련번호·제조일자가 26년 → NTK26293
//  3) 전원 "/" 빠짐: 380/360 → 380/3/60
//  4) 납기일·출고일·검사일자의 년도가 제조일자보다 2년 이상 뒤: 2029-10-14 (제조 2026-10-01) → 2026-10-14
//  5) 사업명에 같은 줄이 두 번: "A\nA" → "A"
//  6) 판매번호: 같은 거래처·사업명·제조일자 묶음의 다른 행과 한 글자만 다름 → 묶음 값으로 (#25053 → #26053)
//     두 글자 이상 다르면 고치지 않고 확인 필요로만 표시

// 일련번호 = 타입 문자 + 국가번호(1~3자리) + 년도 2 + 번호 4 (예: N82260001, N966260295, N7260543, NE62260617)
export const SERIAL_PATTERN = /^(NE|N|M|B|Q|C|P)\d{7,9}$/;
const SERIAL_PARTS = /^(NE|N|M|B|Q|C|P)(\d+)$/;
// 출장보고서 일련번호 원문 → 제조내역과 비교할 번호 ("N82260045 (분배조)" → N82260045). 구 버전 A 번호·"식별불가"·빈칸은 ''
export const serialKeyOf = (raw) => String(raw || '').toUpperCase().match(/(?:^|[^A-Z0-9])((?:NE|N|M|B|Q|C|P)\d{7,9})(?![0-9])/)?.[1] || '';
// 연결이 안 되는 이유: old = 구 버전 제품(A로 시작), none = 번호 없음(식별불가·빈칸 등)
export const serialKindOf = (raw) => (serialKeyOf(raw) ? 'new' : /^\s*A\d{6,}/i.test(String(raw || '')) ? 'old' : 'none');
const INSPECTION = /^NTK(\d{2})(\d{3,4})$/;

const note = (row, kind, field, text) => { (row[kind] ||= {})[field] = text; };
function fix(row, field, value, reason) {
  const old = row.values[field];
  if (old === value) return;
  row.values[field] = value;
  note(row, 'fixes', field, `원래 값 "${String(old).replace(/\n/g, ' / ')}" → 자동 수정 (${reason})`);
}

function fixSerialAndInspection(row) {
  const v = row.values;
  const yy = (v.manufactured_date || '').slice(2, 4); // 제조일자 년도 2자리 (판단 기준)
  const s = String(v.serial_full || '').trim().toUpperCase().match(SERIAL_PARTS);
  const ins = String(v.inspection_no || '').trim().toUpperCase().match(INSPECTION);
  if (!s || !ins) return;
  const [, type, digits] = s;
  const [, insYear, insSeq] = ins;
  const year = yy || insYear;
  const seq4 = insSeq.padStart(4, '0');
  const countryOk = (tail) => digits.endsWith(tail) && digits.length - tail.length >= 1 && digits.length - tail.length <= 3;
  // 1) 번호 부분이 3자리 (0이 빠짐)
  if (!countryOk(`${year}${seq4}`) && insSeq.length === 3 && insYear === year && countryOk(`${year}${insSeq}`)) {
    const country = digits.slice(0, digits.length - 2 - insSeq.length);
    fix(row, 'serial_full', `${type}${country}${year}${seq4}`, `번호 부분이 3자리라 앞에 0을 채움 — 검사번호 ${ins[0]} 기준`);
    return;
  }
  // 2) 검사번호 년도 오타: 일련번호가 제조 년도·같은 번호로 끝나는데 검사번호 년도만 다름
  if (yy && insYear !== yy && countryOk(`${yy}${seq4}`)) {
    fix(row, 'inspection_no', `NTK${yy}${insSeq}`, `일련번호·제조일자가 ${yy}년이라 검사번호 년도를 맞춤`);
  }
}

function fixPower(row) {
  const t = String(row.values.power || '').trim();
  const m = t.match(/^(\d{3})\/([13])(50|60)$/);
  if (m) fix(row, 'power', `${m[1]}/${m[2]}/${m[3]}`, '"/"가 빠져 전압/상/주파수로 나눔');
}

function fixDates(row) {
  const v = row.values;
  const made = v.manufactured_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(made || '')) return;
  const y = +made.slice(0, 4);
  for (const [f, label] of [['inspection_date', '검사일자'], ['due_date', '납기일'], ['shipped_date', '출고일']]) {
    const d = v[f];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || +d.slice(0, 4) < y + 2) continue;
    let nd = `${y}${d.slice(4)}`;
    if (nd < made) nd = `${y + 1}${d.slice(4)}`; // 연말 제조 → 다음 해 납기
    fix(row, f, nd, `${label} 년도가 제조일자(${made})보다 2년 이상 뒤라 년도 오타로 보고 고침`);
  }
}

function fixDuplicateLines(row) {
  const t = String(row.values.project_name || '');
  if (!t.includes('\n')) return;
  const lines = [...new Set(t.split('\n').map((x) => x.trim()).filter(Boolean))];
  const joined = lines.join(' ');
  if (joined !== t) fix(row, 'project_name', joined, '같은 내용이 줄바꿈으로 반복되어 하나로 합침');
}

const charDiff = (a, b) => (a.length !== b.length ? Infinity : [...a].filter((ch, i) => ch !== b[i]).length);
function fixSalesNumbers(rows) {
  const groups = new Map();
  for (const row of rows) {
    const v = row.values;
    if (!v.po_no || !v.manufactured_date) continue;
    const key = [v.customer, v.final_orderer, v.project_name, v.manufactured_date].map((x) => String(x || '').trim()).join('|');
    (groups.get(key) || groups.set(key, []).get(key)).push(row);
  }
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    const counts = {};
    for (const r of list) counts[r.values.po_no] = (counts[r.values.po_no] || 0) + 1;
    const [major, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (n < 2) continue;
    for (const r of list) {
      const po = r.values.po_no;
      if (po === major || counts[po] >= n) continue;
      if (charDiff(po, major) === 1) fix(r, 'po_no', major, `같은 거래처·사업명·제조일자의 다른 ${n}대는 #${major}라 한 글자 오타로 보고 맞춤`);
      else note(r, 'warnings', 'po_no', `확인 필요: 같은 거래처·사업명·제조일자의 다른 ${n}대는 #${major}입니다.`);
    }
  }
}

export function autofixMfgRows(rows) {
  for (const row of rows) {
    fixSerialAndInspection(row);
    fixPower(row);
    fixDates(row);
    fixDuplicateLines(row);
  }
  fixSalesNumbers(rows);
  return rows;
}
