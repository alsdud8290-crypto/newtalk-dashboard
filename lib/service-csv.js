// 서비스 데이터 CSV 업로드 (회사 출장보고서 관리 프로그램에서 월별로 내보낸 파일, 예: 서비스데이터_202601.csv)
//  - 1줄 = 출장보고서 1건. 같은 *ID가 이어서 나오는 줄은 그 보고서의 제품 목록(모델명·사양·일련번호·수량)만 더 있는 줄
//  - 중복 기준: *ID. 다시 올리면 같은 ID의 보고서를 새 내용으로 덮어씀 (내용이 같으면 건너뜀)
//  - 지역: "지역" 칸(예: 경상남도 김해시, 서울특별시)에서 시·도·시·군을 읽고, 비어 있으면 기억된 요청처 지역 → 요청처·출장 목적 글자에서 찾기
//  읽기 → 확인 화면(사람이 고치기) → 저장 흐름은 lib/uploads.js가 맡는다
import { db } from './db.js';
import { registerHandler, UploadError } from './uploads.js';
import { REGIONS, DISTRICTS, cleanReport, validateReport, saveReport } from './service.js';

// ---------- CSV 읽기 ----------
// UTF-8(BOM 있어도 됨)으로 읽고, 깨지면 EUC-KR(엑셀 "CSV" 기본 저장)로 다시 읽는다
function decodeCsv(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, '');
  if (!utf8.includes('�')) return utf8;
  try { return new TextDecoder('euc-kr').decode(buffer); } catch { return utf8; }
}
// 따옴표 안의 쉼표·줄바꿈, "" (따옴표 두 개 = 따옴표 글자)를 처리하는 CSV 파서
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------- 값 다듬기 ----------
const t = (v) => String(v ?? '').trim();
const oneLine = (v) => t(v).replace(/\s*\n\s*/g, ' ');
// "김현진 Assistant Manager (hjkim@newtork.co.kr)" → "김현진 Assistant Manager" (같은 사람이 메일 주소만 다르게 적힌 경우를 하나로)
const personName = (v) => oneLine(v).replace(/\s*\([^)]*@[^)]*\)\s*$/, '').trim();
// "A (a@x), B (b@x)" → [A, B]. 메일 괄호 안의 글자는 나누지 않음
const people = (v) => splitTop(v).map(personName).filter(Boolean);
// 괄호 밖의 쉼표로만 나눔: "Torque Sensor (Pressure sensor, Torque Tranducer), Motor excl. rotor" → 2개
function splitTop(v) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of t(v)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}
// 작업 구분 "수리 ,설치 / 시운전 / 세팅 " → "수리, 설치 / 시운전 / 세팅"
const workType = (v) => t(v).split(',').map((x) => x.trim()).filter(Boolean).join(', ');
const ID_OF = (v) => t(v).replace(/^"+|"+$/g, '').trim(); // """8106905""" → 8106905

// ---------- 지역 ----------
const REGION_ALIASES = {
  서울: '서울특별시', 서울시: '서울특별시', 부산: '부산광역시', 부산시: '부산광역시', 대구: '대구광역시', 대구시: '대구광역시', 인천: '인천광역시', 인천시: '인천광역시',
  광주광역시: '광주광역시', 대전: '대전광역시', 대전시: '대전광역시', 울산: '울산광역시', 울산시: '울산광역시', 세종: '세종특별자치시', 세종시: '세종특별자치시',
  경기: '경기도', 강원: '강원특별자치도', 강원도: '강원특별자치도', 충북: '충청북도', 충남: '충청남도', 전북: '전북특별자치도', 전라북도: '전북특별자치도',
  전북특별자치도: '전북특별자치도', 전남: '전라남도', 경북: '경상북도', 경남: '경상남도', 제주: '제주특별자치도', 제주도: '제주특별자치도',
};
const toRegion = (w) => (REGIONS.includes(w) ? w : REGION_ALIASES[w] || '');
// 시·군 이름 → 그 이름을 가진 시·도들 (고성군처럼 두 곳에 있으면 정하지 않음)
const DISTRICT_HOMES = {};
for (const [region, list] of Object.entries(DISTRICTS)) for (const d of list) (DISTRICT_HOMES[d] ||= []).push(region);

// "지역" 칸: "경상남도 김해시", "서울특별시", "경기 안산시 단원구", "김해시" → { region, district }. 못 읽으면 null (날짜 등이 들어 있는 예전 파일)
export function regionFromText(text) {
  const words = oneLine(text).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let region = toRegion(words[0]);
  const rest = region ? words.slice(1) : words;
  let district = '';
  for (const w of rest) {
    const homes = DISTRICT_HOMES[w] || [];
    if (region ? homes.includes(region) : homes.length === 1) { district = w; region ||= homes[0]; break; }
  }
  if (!region) return null;
  if (!DISTRICTS[region]) district = ''; // 특별·광역시는 시·군 없음
  return { region, district };
}
// 요청처·출장 목적 글자에서 지역 찾기 (예: "여주시수도사업소" → 경기도 여주시, "대전광역시상수도사업본부…" → 대전광역시)
function regionFromWords(text) {
  const s = oneLine(text);
  if (!s) return null;
  for (const r of REGIONS) if (s.includes(r)) {
    const list = DISTRICTS[r] || [];
    return { region: r, district: list.find((d) => s.includes(d)) || '' };
  }
  for (const [d, homes] of Object.entries(DISTRICT_HOMES)) if (homes.length === 1 && s.includes(d)) return { region: homes[0], district: d };
  return null;
}

// ---------- CSV 머리글 → 칸 ----------
const H = {
  id: '*ID', status: '상태', requester_type: '요청처 구분', requester: '요청처', requester_alt: '요청처(검색불가시)', start_date: '출장 시작일', end_date: '출장 종료일',
  extra_trip: '추가 출장', companions: '동행자', author: '작성자', region: '지역', work_type: '작업 구분', purpose: '출장 목적',
  fault: '고장 내용', work: '작업 내용', result: '작업 결과', work2: '2차 출장 작업 내용', result2: '2차 출장 작업 결과', work3: '3차 출장 작업 내용', result3: '3차 출장 작업 결과',
  note: '특이사항', paid_type: '비용청구 유무', parts: '부품 사용 내역',
  model: '제품 목록-모델명', spec: '제품 목록-사양', serial: '제품 목록-일련번호', qty: '제품 목록-수량',
};
const REQUIRED_HEADERS = ['id', 'start_date', 'paid_type'];
const norm = (h) => t(h).replace(/\s+/g, '');

function headerIndex(header) {
  const idx = {};
  const cells = header.map(norm);
  for (const [k, label] of Object.entries(H)) {
    const i = cells.indexOf(norm(label));
    if (i >= 0) idx[k] = i;
  }
  // "*ID"의 별표가 빠진 파일도 받음
  if (idx.id === undefined) { const i = cells.findIndex((c) => c.replace(/^\*/, '').toUpperCase() === 'ID'); if (i >= 0) idx.id = i; }
  return idx;
}

// 작업 내용·결과: 2차·3차 출장 내용과 특이사항을 이어 붙임
const joinParts = (...pairs) => pairs.filter(([, v]) => t(v)).map(([label, v]) => (label ? `[${label}]\n${t(v)}` : t(v))).join('\n\n');

export const COLUMNS = [
  ['external_id', 'ID'], ['start_date', '출장 시작일'], ['end_date', '출장 종료일'], ['requester', '요청처'], ['region', '시·도', { choices: REGIONS }],
  ['district', '시·군', { choices_by: 'region', choices_map: DISTRICTS }], ['paid_type', '비용청구', { choices: ['유상', '무상'] }], ['author', '작성자'],
  ['companions', '동행자(줄마다 1명)', { multiline: true }], ['products', '제품(모델명 | 사양 | 일련번호 | 수량)', { multiline: true }],
  ['parts', '교체 부품(줄마다 1개)', { multiline: true }], ['work_type', '작업 구분'], ['requester_type', '요청처 구분'], ['extra_trip', '추가 출장'],
  ['purpose', '출장 목적'], ['fault_description', '고장 내용', { multiline: true }], ['work_description', '작업 내용', { multiline: true }],
  ['work_result', '작업 결과', { multiline: true }],
];
const KEYS = COLUMNS.map(([k]) => k);

const productLine = (line) => {
  const p = line.split('|').map((x) => x.trim());
  while (p.length < 4) p.push('');
  return { model_name: p[0], spec: p[1], serial_no_raw: p[2], quantity: p[3].replace(/[^\d]/g, '') };
};
const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
// 확인 표 한 행 → 공통 보고서 데이터 (검사·저장 규칙은 lib/service.js와 같음)
const toReport = (v) => cleanReport({ ...v, companions: lines(v.companions), parts: lines(v.parts), products: lines(v.products).map(productLine) });

export async function parseServiceCsv(buffer) {
  const table = parseCsv(decodeCsv(buffer));
  const hi = table.findIndex((r) => r.some((c) => norm(c).replace(/^\*/, '').toUpperCase() === 'ID'));
  if (hi < 0) throw new UploadError(400, "'*ID' 제목 칸을 찾을 수 없습니다. 서비스 데이터 CSV(서비스데이터_YYYYMM.csv)인지 확인해 주세요.");
  const idx = headerIndex(table[hi]);
  const missing = REQUIRED_HEADERS.filter((k) => idx[k] === undefined).map((k) => H[k]);
  if (missing.length) throw new UploadError(400, `다음 제목 칸이 없습니다: ${missing.join(', ')}`);
  const known = Object.fromEntries((await db.all('SELECT requester, region, district FROM requester_regions')).map((r) => [r.requester, r]));
  const get = (r, k) => (idx[k] === undefined ? '' : r[idx[k]] ?? '');

  const rows = [];
  const byId = {};
  let skipped = 0;
  table.slice(hi + 1).forEach((r, i) => {
    const rowNo = hi + i + 2;
    const id = ID_OF(get(r, 'id'));
    if (!id) { skipped += 1; return; }
    const product = [get(r, 'model'), get(r, 'spec'), get(r, 'serial'), get(r, 'qty')].map(oneLine);
    if (product[0] && !product[3].replace(/[^\d]/g, '')) product[3] = '1'; // 수량이 빈 제품은 1대
    const productText = product[0] || product[2] ? product.join(' | ') : '';
    const head = byId[id];
    // 같은 ID의 이어지는 줄: 제품만 더함 (보고서 내용 칸이 비어 있음)
    if (head && !t(get(r, 'start_date'))) {
      if (productText) head.values.products = [head.values.products, productText].filter(Boolean).join('\n');
      return;
    }
    const requester = oneLine(get(r, 'requester_alt')) || oneLine(get(r, 'requester'));
    const purpose = oneLine(get(r, 'purpose'));
    const place = regionFromText(get(r, 'region')) || known[requester] || regionFromWords(requester) || regionFromWords(purpose) || { region: '', district: '' };
    const values = {
      external_id: id,
      start_date: oneLine(get(r, 'start_date')).slice(0, 10),
      end_date: oneLine(get(r, 'end_date')).slice(0, 10),
      requester: requester || '(요청처 미기재)',
      region: place.region,
      district: place.district || '',
      paid_type: oneLine(get(r, 'paid_type')),
      author: personName(get(r, 'author')),
      companions: people(get(r, 'companions')).join('\n'),
      products: productText,
      parts: splitTop(get(r, 'parts')).join('\n'),
      work_type: workType(get(r, 'work_type')),
      requester_type: oneLine(get(r, 'requester_type')),
      extra_trip: oneLine(get(r, 'extra_trip')),
      purpose,
      fault_description: t(get(r, 'fault')),
      work_description: joinParts(['', get(r, 'work')], ['2차 출장 작업 내용', get(r, 'work2')], ['3차 출장 작업 내용', get(r, 'work3')]),
      work_result: joinParts(['', get(r, 'result')], ['2차 출장 작업 결과', get(r, 'result2')], ['3차 출장 작업 결과', get(r, 'result3')], ['특이사항', get(r, 'note')]),
    };
    const row = { row_no: rowNo, sheet: '', values };
    // 같은 ID가 떨어져서 다시 나오면 아래쪽 줄을 쓴다 (lib/uploads.js가 "건너뜀(아래 행 사용)"으로 표시)
    byId[id] = row;
    rows.push(row);
  });
  if (!rows.length) throw new UploadError(400, '읽을 수 있는 출장보고서가 없습니다. *ID 칸이 채워진 줄이 있는지 확인해 주세요.');
  return { rows, skipped };
}

// 이미 저장된 보고서의 지금 값 (확인 표와 같은 글자 모양) — 바뀐 칸만 "갱신"으로 보여 주고, 같으면 건너뜀
async function existingValues(ids) {
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 300) {
    const chunk = ids.slice(i, i + 300);
    const reps = await db.all(`SELECT * FROM trip_reports WHERE external_id IN (${chunk.map(() => '?').join(',')})`, ...chunk);
    if (!reps.length) continue;
    const rid = reps.map((r) => r.id);
    const ph = rid.map(() => '?').join(',');
    const [comps, prods, parts] = await Promise.all([
      db.all(`SELECT report_id, name FROM trip_companions WHERE report_id IN (${ph}) ORDER BY id`, ...rid),
      db.all(`SELECT report_id, model_name, spec, serial_no_raw, quantity FROM trip_products WHERE report_id IN (${ph}) ORDER BY id`, ...rid),
      db.all(`SELECT report_id, part_name FROM trip_parts WHERE report_id IN (${ph}) ORDER BY id`, ...rid),
    ]);
    const of = (list, id, f) => list.filter((x) => x.report_id === id).map(f).join('\n');
    for (const r of reps) {
      out[r.external_id] = {
        ...Object.fromEntries(KEYS.map((k) => [k, r[k] ?? ''])),
        companions: of(comps, r.id, (x) => x.name),
        products: of(prods, r.id, (x) => [x.model_name, x.spec, x.serial_no_raw, x.quantity].join(' | ')),
        parts: of(parts, r.id, (x) => x.part_name),
      };
    }
  }
  return out;
}

async function saveRows(rows, userId) {
  for (const row of rows) {
    const d = toReport(row.values);
    d.external_id = String(row.values.external_id).trim();
    await saveReport(d, userId, 'csv');
  }
  return rows.length;
}

registerHandler({
  kind: 'service_csv', team: 'service', extensions: ['.csv'], keyField: 'external_id', updateExisting: true, columns: COLUMNS,
  parse: parseServiceCsv,
  duplicateKey: (v) => String(v.external_id || '').trim() || null,
  existingValues,
  validate(v) {
    const errors = validateReport(toReport(v));
    if (!String(v.external_id || '').trim()) errors.external_id = 'ID가 없습니다.';
    return errors;
  },
  save: saveRows,
  // 덮어쓰기: 같은 ID의 예전 보고서(제품·부품·동행자 포함)를 지우고 새 내용으로 저장
  async update(rows, userId) {
    for (const row of rows) {
      const id = String(row.values.external_id).trim();
      const old = await db.all('SELECT id FROM trip_reports WHERE external_id = ?', id);
      for (const o of old) {
        await db.batch([['DELETE FROM trip_companions WHERE report_id = ?', [o.id]], ['DELETE FROM trip_products WHERE report_id = ?', [o.id]],
          ['DELETE FROM trip_parts WHERE report_id = ?', [o.id]], ['DELETE FROM trip_reports WHERE id = ?', [o.id]]]);
      }
    }
    return saveRows(rows, userId);
  },
});
