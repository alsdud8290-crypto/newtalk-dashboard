// 회사 양식 "경영지원 관리" (채권·채무 현황) — 엑셀 읽기·쓰기
// 양식 구조: 미수금 현황(장기 미수금 / 당월 수금된 / 당월 수금예정 업체) · 매입 지출 · 경비 지출 · 기타 지출(자동이체 + 그 외)
// 구역 제목은 내용에 맞춘 이름으로 쓰고, 읽을 때는 회사 원본 제목(외상매출금·외상매입금·미지급비용-직원/업체)도 받는다.
// 내려받기는 회사 양식 파일(templates/)을 열어 서식(글꼴·색·테두리·병합·합계 수식)을 그대로 복사해 행을 다시 그린다.
import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, '..', 'templates', 'company-ledger-template.xlsx');

export const SECTIONS = {
  ar: { title: '미수금 현황', groups: ['long', 'collected', 'scheduled'] },
  ap: { title: '매입 지출 (상품·원재료)', groups: ['normal'], note: '← 당월 매입 지출', min: 9 },
  staff: { title: '경비 지출', groups: ['normal'], note: '← 당월 경비 지출', min: 10 },
  vendor: { title: '기타 지출 (광고·접대·그 외)', groups: ['auto', 'normal'], note: '← 당월 그 외 지출', min: 13 },
};
export const AR_GROUPS = {
  long: { label: '장기 미수금 업체', note: '← 장기 미수금 업체', min: 2 },
  collected: { label: '당월 수금된 업체', note: '← 당월 수금된 업체', min: 20 },
  scheduled: { label: '당월 수금예정인 업체', note: '← 당월 수금예정인 업체', min: 13 },
};
const SECTION_KEYS = Object.keys(SECTIONS);
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function validMonth(m) {
  return MONTH_RE.test(String(m || ''));
}


export async function getEntries(month) {
  return db.all('SELECT * FROM ledger WHERE month = ? ORDER BY section, sort, id', month);
}

export function cleanEntry(e, i) {
  const section = SECTION_KEYS.includes(e.section) ? e.section : null;
  if (!section) throw new Error(`${i + 1}번째 행: 구분(section)이 올바르지 않습니다.`);
  const groups = SECTIONS[section].groups;
  const grp = groups.includes(e.grp) ? e.grp : groups[groups.length - 1];
  const balance = Number(String(e.balance ?? '').replace(/[,\s원]/g, '')) || 0;
  return {
    section, grp,
    code: String(e.code ?? '').trim().slice(0, 40),
    name: String(e.name ?? '').trim().slice(0, 100),
    balance,
    memo: String(e.memo ?? '').trim().slice(0, 200),
    red: e.red ? 1 : 0,
  };
}


// ---------- 미수금 관리 데이터 → 외상매출금 (월말 기준) ----------
// 날짜 → '9/12' (기준월과 연도가 다르면 '25.9/12')
const md = (d, y) => `${y && Number(d.slice(0, 4)) !== y ? `${d.slice(2, 4)}.` : ''}${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export async function receivablesToAr(month) {
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const endDate = new Date(`${end}T00:00:00`);
  const rows = await db.all('SELECT * FROM receivables WHERE invoice_date <= ?', end);
  const by = {};
  for (const r of rows) {
    const c = (by[r.customer] ||= { name: r.customer, code: '', balance: 0, collectedNow: [], dueNow: [], oldestOpen: null });
    if (!c.code && r.code) c.code = r.code;
    const collectedByEnd = r.collected_date && r.collected_date <= end ? r.collected : 0;
    const bal = r.amount - collectedByEnd;
    if (bal > 0.5) {
      c.balance += bal;
      if (!c.oldestOpen || r.invoice_date < c.oldestOpen) c.oldestOpen = r.invoice_date;
      if (r.due_date && r.due_date.slice(0, 7) === month) c.dueNow.push(r.due_date);
    }
    if (r.collected_date && r.collected_date.slice(0, 7) === month && r.collected > 0) c.collectedNow.push([r.collected_date, r.collected]);
  }
  const out = [];
  for (const c of Object.values(by)) {
    const age = c.oldestOpen ? Math.floor((endDate - new Date(`${c.oldestOpen}T00:00:00`)) / 86400000) : 0;
    let grp;
    let memo;
    if (c.balance > 0.5 && age > 90) {
      grp = 'long';
      memo = `${md(c.oldestOpen, y)} 청구분부터 미수 (${age}일)`;
    } else if (c.collectedNow.length) {
      grp = 'collected';
      const sumC = c.collectedNow.reduce((a, [, v]) => a + v, 0);
      const last = c.collectedNow.map(([d]) => d).sort().pop();
      memo = `${md(last, y)} 수금 ${Math.round(sumC).toLocaleString('ko-KR')}원${c.balance > 0.5 ? '' : ' · 완납'}`;
    } else if (c.balance > 0.5) {
      grp = 'scheduled';
      memo = c.dueNow.length ? `${md(c.dueNow.sort()[0], y)} 수금 예정` : '';
    } else {
      continue;
    }
    out.push({ section: 'ar', grp, code: c.code, name: c.name, balance: Math.round(c.balance), memo, red: grp === 'long' ? 1 : 0 });
  }
  const order = { long: 0, collected: 1, scheduled: 2 };
  return out.sort((a, b) => order[a.grp] - order[b.grp] || b.balance - a.balance);
}

// ---------- 엑셀 읽기 (업로드) ----------
const norm = (s) => String(s ?? '').replace(/\s+/g, '');
function cellText(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `${v.getUTCMonth() + 1}/${v.getUTCDate()}`;
  if (typeof v === 'object') {
    if ('result' in v) return v.result instanceof Date ? `${v.result.getUTCMonth() + 1}/${v.result.getUTCDate()}` : String(v.result ?? '');
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
  }
  return String(v);
}
function cellNumber(cell) {
  const v = cell.value;
  const raw = v && typeof v === 'object' && 'result' in v ? v.result : v;
  if (typeof raw === 'number') return raw;
  const n = Number(String(raw ?? '').replace(/[,\s원]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
const isRed = (cell) => /FF0000$/i.test(cell.font?.color?.argb || '');

function sectionOf(text) {
  const t = norm(text);
  if (/^(외상매출금|미수금현황$)/.test(t)) return 'ar';
  if (/^(외상매입금|매입지출(\(|$))/.test(t)) return 'ap';
  if (/^(미지급비용-?직원|경비지출$)/.test(t)) return 'staff';
  if (/^(미지급비용-?업체|기타지출(\(|$))/.test(t)) return 'vendor';
  return null;
}

// 시트 이름에서 기준월 추정: 2026-09, 2026.9, 2026년 9월, 26년9월
function monthFromName(name) {
  const s = norm(name);
  let m = s.match(/(20\d{2})[-.년/]?(\d{1,2})월?/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  m = s.match(/^(\d{2})년(\d{1,2})월/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `20${m[1]}-${String(+m[2]).padStart(2, '0')}`;
  return null;
}

function parseSheet(ws) {
  const merges = (ws.model.merges || []).map((r) => {
    const [a, b = a] = r.split(':');
    const col = (x) => ws.getCell(x).col;
    const row = (x) => ws.getCell(x).row;
    return { c1: col(a), c2: col(b), r1: row(a), r2: row(b) };
  });
  const titles = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell((cell) => {
      const sec = sectionOf(cellText(cell));
      if (sec && !titles.some((t) => t.row === row.number)) titles.push({ sec, row: row.number });
    });
  });
  const entries = [];
  const warnings = [];
  titles.forEach((t, ti) => {
    const endRow = (titles[ti + 1]?.row || ws.rowCount + 1) - 1;
    // 머리글 행: '거래처명'이 있는 첫 행
    let head = null;
    for (let r = t.row + 1; r <= Math.min(endRow, t.row + 3) && !head; r++) {
      ws.getRow(r).eachCell((cell) => { if (norm(cellText(cell)) === '거래처명') head = r; });
    }
    if (!head) { warnings.push(`${SECTIONS[t.sec].title}: 머리글(거래처명) 행을 찾지 못했습니다.`); return; }
    const cols = {};
    ws.getRow(head).eachCell((cell) => {
      const h = norm(cellText(cell));
      if (h === '코드') cols.code = cell.col;
      if (h === '거래처명') cols.name = cell.col;
      if (h === '잔액' || h === '금액') cols.balance = cell.col;
      if (h === '적요' || h === '비고') cols.memo = cell.col;
      if (h === '총액' || h === '합계') cols.total = cell.col;
    });
    if (!cols.name || !cols.balance) { warnings.push(`${SECTIONS[t.sec].title}: 거래처명·잔액 열을 찾지 못했습니다.`); return; }
    const totalCol = cols.total || cols.balance + 2;
    // 외상매출금 소구분: 총액 열의 병합 블록 + 오른쪽 메모(← 장기 미수금 업체 등)
    const blocks = merges.filter((g) => g.c1 === totalCol && g.r1 > head && g.r1 <= endRow).map((g) => {
      let label = '';
      for (let r = g.r1; r <= g.r2; r++) {
        ws.getRow(r).eachCell((cell) => { if (cell.col > totalCol && cellText(cell).includes('←')) label = cellText(cell); });
      }
      const grp = /장기/.test(label) ? 'long' : /예정/.test(label) ? 'scheduled' : /수금/.test(label) ? 'collected' : null;
      return { ...g, grp };
    });
    for (let r = head + 1; r <= endRow; r++) {
      const row = ws.getRow(r);
      const name = cellText(row.getCell(cols.name)).trim();
      const balance = cellNumber(row.getCell(cols.balance));
      const code = cols.code ? cellText(row.getCell(cols.code)).trim() : '';
      let memo = cols.memo ? cellText(row.getCell(cols.memo)).trim() : '';
      if (!name && !balance && !code) continue;
      if (sectionOf(name)) continue;
      const red = isRed(row.getCell(cols.name)) || isRed(row.getCell(cols.balance));
      let grp = 'normal';
      if (t.sec === 'ar') {
        grp = blocks.find((b) => r >= b.r1 && r <= b.r2)?.grp || (red ? 'long' : 'collected');
      } else if (t.sec === 'vendor') {
        const auto = memo === '자동이체' || cellText(row.getCell(totalCol)) === '자동이체' || ws.getCell(r, cols.name).fill?.fgColor?.theme === 9;
        if (auto) { grp = 'auto'; memo = memo.replace(/^자동이체\s*·?\s*/, ''); } // 내려받을 때 붙인 '자동이체 · ' 제거
      }
      // 장기 미수금은 양식상 항상 빨간 글씨, 그 외는 실제 글자색을 따른다
      entries.push({ section: t.sec, grp, code, name, balance, memo, red: grp === 'long' || red ? 1 : 0 });
    }
  });
  return { entries, warnings, found: titles.map((t) => t.sec) };
}

export async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheets = [];
  wb.eachSheet((ws) => {
    const r = parseSheet(ws);
    if (!r.found.length) return;
    const counts = {};
    for (const e of r.entries) counts[e.section] = (counts[e.section] || 0) + 1;
    sheets.push({ sheet: ws.name, month: monthFromName(ws.name), ...r, counts });
  });
  return sheets;
}

// ---------- 엑셀 쓰기 (내려받기) ----------
const clone = (o) => JSON.parse(JSON.stringify(o || {}));

// 양식에서 칸별 서식 수집 (주소는 회사 양식 기준)
function collectStyles(src) {
  const s = (a) => clone(src.getCell(a).style);
  const st = {
    title: s('C1'), headCode: s('A2'), head: s('C2'), note: s('H3'),
    code: s('A6'),
    arName: s('C6'), arBal: s('D6'), arMemo: s('E6'),
    redName: s('C3'), redBal: s('D3'), redMemo: s('E3'),
    name: s('C41'), bal: s('D41'), memo: s('E41'),
    redBal2: s('D77'), redMemo2: s('E77'),
    autoName: s('C66'), autoBal: s('D66'), autoMemo: s('E66'),
    totalTop: s('F5'), totalMid: s('F6'),
  };
  // 빨간 글씨 거래처명(외상매출금 외 구역용)
  st.redName2 = clone(st.name);
  st.redName2.font = { ...(st.redName2.font || {}), color: { argb: 'FFFF0000' } };
  return st;
}

function writeSheet(ws, src, st, entries) {
  // 열 너비·인쇄 설정은 양식 그대로
  src.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.width) col.width = c.width;
    if (c.hidden) col.hidden = true; // 원본처럼 코드(A열)는 숨김 상태 유지
  });
  ws.pageSetup = clone(src.pageSetup);
  ws.properties.defaultRowHeight = 15;

  let r = 1;
  const put = (addr, value, style) => {
    const c = ws.getCell(addr);
    c.value = value ?? null;
    if (style) c.style = clone(style);
    return c;
  };
  const title = (text, withCode) => {
    put(`C${r}`, text, st.title);
    ws.mergeCells(`C${r}:F${r}`);
    r += 1;
    if (withCode) put(`A${r}`, '코드', st.headCode);
    ['거래처명', '잔액', '적요', '총액'].forEach((h, i) => put(`${'CDEF'[i]}${r}`, h, st.head));
    r += 1;
  };
  // 블록: 행들 + 총액 열 병합(합계 수식) + 오른쪽 메모
  const block = (rows, min, note, notePos, styleFor, withCode) => {
    const n = Math.max(min, rows.length);
    const start = r;
    for (let i = 0; i < n; i++, r++) {
      const e = rows[i];
      const s = styleFor(e);
      if (withCode) put(`A${r}`, e?.code || null, st.code);
      put(`C${r}`, e?.name || null, s.name);
      put(`D${r}`, e ? e.balance : null, s.bal);
      put(`E${r}`, e?.memo || null, s.memo);
      put(`F${r}`, null, i === 0 ? st.totalTop : st.totalMid);
    }
    const end = r - 1;
    const total = rows.reduce((a, e) => a + (Number(e.balance) || 0), 0);
    ws.getCell(`F${start}`).value = { formula: `SUM(D${start}:D${end})`, result: total };
    const last = ws.getCell(`F${end}`);
    last.style = { ...clone(last.style), border: { ...(last.style.border || {}), bottom: { style: 'thin' } } };
    if (end > start) ws.mergeCells(`F${start}:F${end}`);
    put(`H${start + Math.min(n - 1, notePos(n))}`, note, st.note);
  };

  const of = (sec, grp) => entries.filter((e) => e.section === sec && (!grp || e.grp === grp));
  const arStyle = (e) => (e?.red
    ? { name: st.redName, bal: st.redBal, memo: st.redMemo }
    : { name: st.arName, bal: st.arBal, memo: st.arMemo });
  const plainStyle = (e) => (e?.red
    ? { name: st.redName2, bal: st.redBal2, memo: st.redMemo2 }
    : { name: st.name, bal: st.bal, memo: st.memo });

  // 외상매출금
  title(SECTIONS.ar.title, true);
  block(of('ar', 'long'), AR_GROUPS.long.min, AR_GROUPS.long.note, () => 0, (e) => arStyle(e || { red: 1 }), true);
  block(of('ar', 'collected'), AR_GROUPS.collected.min, AR_GROUPS.collected.note, (n) => Math.floor(n * 0.6), arStyle, true);
  block(of('ar', 'scheduled'), AR_GROUPS.scheduled.min, AR_GROUPS.scheduled.note, (n) => Math.floor(n / 2), arStyle, true);
  r += 1;
  // 외상매입금 · 미지급비용-직원
  for (const sec of ['ap', 'staff']) {
    title(SECTIONS[sec].title, false);
    block(of(sec), SECTIONS[sec].min, SECTIONS[sec].note, (n) => Math.floor(n / 2) - 1, plainStyle, false);
    r += 1;
  }
  // 미지급비용-업체: 자동이체 행(총액 칸에 '자동이체') + 그 외 블록
  title(SECTIONS.vendor.title, false);
  const autos = of('vendor', 'auto');
  for (let i = 0; i < Math.max(1, autos.length); i++, r++) {
    const e = autos[i];
    put(`C${r}`, e?.name || null, st.autoName);
    put(`D${r}`, e ? e.balance : null, st.autoBal);
    put(`E${r}`, e?.memo ? `자동이체 · ${e.memo}` : '자동이체', st.autoMemo);
    put(`F${r}`, null, st.autoMemo);
    ws.mergeCells(`E${r}:F${r}`);
  }
  block(of('vendor', 'normal'), SECTIONS.vendor.min, SECTIONS.vendor.note, (n) => Math.floor(n / 2), plainStyle, false);
}


// ---------- 경영지원 관리 "전체" 내려받기 ----------
// 한 파일에: 안내 · 채권·채무 현황(기준월마다 회사 양식 시트) · 연간목표 · 월별실적 · 매출내역 · 미수금
// 데이터 시트의 시트 이름·열 이름은 엑셀 업로드가 읽는 이름과 같다 → 그대로 다시 올리면 전체 복원
export const FULL_MARK = '뉴토크코리아 경영지원 관리 (전체)';
const n0 = (v) => Number(v) || 0;
const DATA_SHEETS = [
  ['targets', '연간목표', [['year', '연도', 8], ['revenue', '목표매출액', 18, 'money']]],
  ['monthly', '월별실적', [
    ['year', '연도', 7], ['month', '월', 5],
    ['product_sales', '제품매출액', 15, 'money'], ['goods_sales', '상품매출액', 15, 'money'], ['service_sales', '용역매출액', 15, 'money'],
    ['product_purchase', '상품매입액', 15, 'money'], ['material_purchase', '원재료매입액', 15, 'money'], ['expense', '경비지출액', 15, 'money'],
    ['ad_expense', '광고선전비', 13, 'money'], ['entertainment_expense', '접대비', 13, 'money'], ['other_expense', '그외지출액', 13, 'money'],
    [(r) => n0(r.product_sales) + n0(r.goods_sales) + n0(r.service_sales), '매출합계', 15, 'money'],
    [(r) => n0(r.product_purchase) + n0(r.material_purchase) + n0(r.expense) + n0(r.ad_expense) + n0(r.entertainment_expense) + n0(r.other_expense), '지출합계', 15, 'money'],
  ]],
  ['sales', '매출내역', [
    ['date', '일자', 12], ['customer', '판매처', 26], ['industry', '산업분야', 12], ['series', '제품시리즈', 18],
    ['sales_type', '매출구분', 9], ['amount', '금액', 16, 'money'], ['note', '비고', 22],
  ]],
  ['receivables', '미수금', [
    ['code', '코드', 12], ['customer', '거래처', 26], ['invoice_date', '청구일자', 12], ['amount', '청구액', 16, 'money'], ['collected', '수금액', 16, 'money'],
    ['collected_date', '수금일자', 12], ['due_date', '결제예정일', 12], [(r) => n0(r.amount) - n0(r.collected), '잔액', 16, 'money'], ['note', '비고', 22],
  ]],
];

function writeDataSheet(ws, st, title, cols, rows) {
  cols.forEach(([, , w], i) => { ws.getColumn(i + 1).width = w; });
  const last = String.fromCharCode(64 + cols.length);
  const t = ws.getCell('A1');
  t.value = title;
  t.style = clone(st.title);
  ws.mergeCells(`A1:${last}1`);
  cols.forEach(([, h], i) => { const c = ws.getCell(2, i + 1); c.value = h; c.style = clone(st.head); });
  rows.forEach((r, k) => {
    cols.forEach(([key, , , kind], i) => {
      const c = ws.getCell(k + 3, i + 1);
      const v = typeof key === 'function' ? key(r) : r[key];
      c.value = v === '' || v === undefined ? null : v;
      c.style = clone(kind === 'money' ? st.bal : st.name);
    });
  });
  ws.views = [{ state: 'frozen', ySplit: 2 }];
}

function writeGuide(ws, st, sheetsInfo, scope) {
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 80;
  const put = (addr, v, style) => { const c = ws.getCell(addr); c.value = v; if (style) c.style = clone(style); };
  put('A1', scope ? `뉴토크코리아 경영지원 관리 (${scope.label})` : FULL_MARK, { ...st.title, font: { ...(st.title.font || {}), size: 12, bold: true } });
  const d = new Date();
  put('A2', '내려받은 날짜');
  put('B2', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  if (scope) { put('A3', '기간'); put('B3', `${scope.from} ~ ${scope.to}`); }
  put('A4', '시트', st.head);
  put('B4', '내용', st.head);
  sheetsInfo.forEach(([a, b], i) => { put(`A${5 + i}`, a, st.name); put(`B${5 + i}`, b, st.name); });
  const r = 6 + sheetsInfo.length;
  put(`A${r}`, '다시 올리기');
  put(`B${r}`, scope
    ? `이 파일을 웹의 [엑셀 업로드·데이터 이관]에 그대로 올리면 이 기간(${scope.from} ~ ${scope.to})만 반영됩니다. (이 기간의 매출내역·미수금은 파일 내용으로 교체, 다른 기간은 그대로)`
    : '이 파일을 웹의 [엑셀 업로드·데이터 이관]에 그대로 올리면 전체가 반영됩니다. (매출내역·미수금은 파일 내용으로 교체)');
  put(`A${r + 1}`, '주의');
  put(`B${r + 1}`, '시트 이름과 2행의 열 이름은 바꾸지 마세요. 행은 자유롭게 추가·삭제할 수 있습니다.');
}



// ======================================================================
// 회사 양식 ↔ 기존 화면 데이터 연결 (별도 탭 없이)
//   미수금 현황 (외상매출금)          ↔ 미수금 관리
//   매입 지출 (외상매입금) 합계        ↔ 월별실적 상품매입액·원재료매입액 (이름·적요에 '상품'이 있으면 상품매입)
//   경비 지출 (미지급비용-직원) 합계    ↔ 월별실적 경비지출액
//   기타 지출 (미지급비용-업체) 합계    ↔ 월별실적 광고선전비('광고')·접대비('접대')·그외지출액(나머지)
// 회사 양식의 행 단위 내용(거래처·적요)은 ledger 테이블에 보관해 두었다가 다시 내려받을 때 그대로 쓴다.
// ======================================================================
const COST_FIELDS = ['product_purchase', 'material_purchase', 'expense', 'ad_expense', 'entertainment_expense', 'other_expense'];
const costField = (e) => {
  const t = `${e.name} ${e.memo}`;
  if (e.section === 'ap') return /상품/.test(t) ? 'product_purchase' : 'material_purchase';
  if (e.section === 'staff') return 'expense';
  if (e.section === 'vendor') return /광고/.test(t) ? 'ad_expense' : /접대/.test(t) ? 'entertainment_expense' : 'other_expense';
  return null;
};
export function costTotals(entries) {
  const t = Object.fromEntries(COST_FIELDS.map((f) => [f, 0]));
  for (const e of entries) { const f = costField(e); if (f) t[f] += Number(e.balance) || 0; }
  return t;
}
// 월별실적 값만 있을 때 회사 양식 행 만들기 (행 이름에 분류 키워드가 들어 있어 다시 올려도 같은 칸으로 감)
function synthCosts(m) {
  const rows = [];
  const add = (section, grp, name, v) => { if (Number(v)) rows.push({ section, grp, code: '', name, balance: Number(v), memo: '월별실적', red: 0 }); };
  add('ap', 'normal', '상품 매입', m?.product_purchase);
  add('ap', 'normal', '원재료 매입', m?.material_purchase);
  add('staff', 'normal', '경비', m?.expense);
  add('vendor', 'normal', '광고선전비', m?.ad_expense);
  add('vendor', 'normal', '접대비', m?.entertainment_expense);
  add('vendor', 'normal', '그 외 지출', m?.other_expense);
  return rows;
}

// 기준월 시트 내용: 외상매출금은 미수금 관리에서, 나머지는 보관된 행(월별실적 합계와 맞을 때) 또는 월별실적 값으로
export async function composeMonth(month) {
  const [y, mo] = month.split('-').map(Number);
  const [stored, monthlyRow, ar] = await Promise.all([
    getEntries(month),
    db.get('SELECT * FROM monthly WHERE year = ? AND month = ?', y, mo),
    receivablesToAr(month),
  ]);
  const costs = stored.filter((e) => e.section !== 'ar');
  const t = costTotals(costs);
  const same = costs.length && COST_FIELDS.every((f) => Math.round(t[f]) === Math.round(Number(monthlyRow?.[f]) || 0));
  return [...ar, ...(same ? costs : synthCosts(monthlyRow))];
}

// 기준월이 있는 달 목록: 월별실적이 있거나 보관된 회사 양식 행이 있는 달
// range: { from: 'YYYY-MM', to: 'YYYY-MM' } (없으면 전체)
export async function monthsWithData(range) {
  const rows = await db.all(`SELECT printf('%04d-%02d', year, month) AS m FROM monthly ${range ? "WHERE printf('%04d-%02d', year, month) BETWEEN ? AND ?" : ''}
                             UNION SELECT month FROM ledger ${range ? 'WHERE month BETWEEN ? AND ?' : ''} ORDER BY 1`,
  ...(range ? [range.from, range.to, range.from, range.to] : []));
  return rows.map((r) => r.m);
}

// 외상매출금 행 → 미수금 관리 행 (월말 기준 잔액 스냅숏)
const pad2 = (n) => String(n).padStart(2, '0');
function memoDate(memo, month, re) {
  const m = String(memo || '').match(re);
  if (!m) return null;
  const [y0, mo0] = month.split('-').map(Number);
  let y = m[1] ? 2000 + Number(m[1]) : y0;
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!m[1] && mm > mo0 + 1) y -= 1; // 기준월보다 한참 뒤 월이면 작년
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${pad2(mm)}-${pad2(dd)}`;
}
export function arToReceivables(month, arEntries) {
  const [y, mo] = month.split('-').map(Number);
  const first = `${month}-01`;
  const end = `${month}-${pad2(new Date(y, mo, 0).getDate())}`;
  const back = (days) => { const d = new Date(`${end}T00:00:00`); d.setDate(d.getDate() - days); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const out = [];
  for (const e of arEntries) {
    const bal = Math.round(Number(e.balance) || 0);
    const base = { customer: e.name, code: e.code || '', note: e.memo || '' };
    if (!e.name) continue;
    if (e.grp === 'long') {
      if (bal > 0) out.push({ ...base, invoice_date: memoDate(e.memo, month, /(?:(\d{2})\.)?(\d{1,2})\/(\d{1,2})\s*청구/) || back(120), amount: bal, collected: 0, collected_date: '', due_date: '' });
    } else if (e.grp === 'scheduled') {
      if (bal > 0) out.push({ ...base, invoice_date: first, amount: bal, collected: 0, collected_date: '', due_date: memoDate(e.memo, month, /(?:(\d{2})\.)?(\d{1,2})\/(\d{1,2})[^/]*예정/) || '' });
    } else {
      if (bal > 0) out.push({ ...base, invoice_date: first, amount: bal, collected: 0, collected_date: '', due_date: '' });
      // "9/12 수금 87,330,000원" → 그 달 수금 기록
      const cm = String(e.memo || '').match(/(?:(\d{2})\.)?(\d{1,2})\/(\d{1,2})\s*수금\s*([\d,]+)\s*(만)?/);
      if (cm) {
        const amt = Number(cm[4].replace(/,/g, '')) * (cm[5] ? 10000 : 1);
        const d = memoDate(e.memo, month, /(?:(\d{2})\.)?(\d{1,2})\/(\d{1,2})\s*수금/);
        if (amt > 0 && d) out.push({ ...base, invoice_date: d, amount: amt, collected: amt, collected_date: d, due_date: '', note: '수금 기록' });
      }
    }
  }
  return out;
}

// 회사 양식 한 달 반영: 행 보관 + (선택) 월별실적 지출 칸 + (선택) 미수금 관리 교체
export async function importCompanyMonth(month, entries, { applyMonthly = true, applyReceivables = true } = {}) {
  const clean = entries.map(cleanEntry).filter((e) => e.name || e.balance || e.code || e.memo);
  const stmts = [['DELETE FROM ledger WHERE month = ?', [month]]];
  clean.forEach((e, i) => stmts.push(['INSERT INTO ledger (month, section, grp, code, name, balance, memo, red, sort) VALUES (?,?,?,?,?,?,?,?,?)',
    [month, e.section, e.grp, e.code, e.name, e.balance, e.memo, e.red, i]]));
  const costs = costTotals(clean.filter((e) => e.section !== 'ar'));
  const hasCostRows = clean.some((e) => e.section !== 'ar' && (e.name || e.balance));
  if (applyMonthly && hasCostRows) {
    const [y, mo] = month.split('-').map(Number);
    stmts.push([`INSERT INTO monthly (year, month, ${COST_FIELDS.join(', ')}) VALUES (?, ?, ${COST_FIELDS.map(() => '?').join(', ')})
                 ON CONFLICT(year, month) DO UPDATE SET ${COST_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')}`,
    [y, mo, ...COST_FIELDS.map((f) => costs[f])]]);
  }
  // 거래처명이 있는 외상매출금 행이 하나도 없으면(빈 양식) 미수금 관리를 건드리지 않는다
  const arRows = clean.filter((e) => e.section === 'ar' && e.name);
  const rec = arToReceivables(month, arRows);
  const doRecv = applyReceivables && arRows.length > 0;
  if (doRecv) {
    stmts.push(['DELETE FROM receivables', []]);
    for (const r of rec) stmts.push(['INSERT INTO receivables (customer, code, invoice_date, amount, collected, collected_date, due_date, note) VALUES (?,?,?,?,?,?,?,?)',
      [r.customer, r.code, r.invoice_date, r.amount, r.collected, r.collected_date, r.due_date, r.note]]);
  }
  await db.batch(stmts);
  return {
    rows: clean.length,
    monthly: applyMonthly && hasCostRows ? costs : null,
    receivables: doRecv ? rec.length : null,
  };
}

// 회사 양식 스타일 엑셀 (모든 내려받기 공통)
//   months: 기준월 목록 → 달마다 회사 양식 시트 / data: { targets?, monthly?, sales?, receivables? } → 같은 서식의 상세 시트
export async function buildCompanyWorkbook({ months = [], data = {}, guide = false, scope = null }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const src = wb.worksheets[0];
  const st = collectStyles(src);
  const monthData = [];
  for (const month of months) monthData.push({ month, entries: await composeMonth(month) });
  const dataSheets = DATA_SHEETS.filter(([key]) => Array.isArray(data[key]));
  if (guide) {
    writeGuide(wb.addWorksheet('안내'), st, [
      ...monthData.map(({ month }) => [month, `경영지원 관리 (회사 양식) — ${month.replace('-', '년 ')}월 · 미수금 현황=미수금 관리, 매입·경비·기타 지출=월별실적 지출`]),
      ...dataSheets.map(([key, title]) => [title, `${{ targets: '연도별 목표매출액', monthly: '월별 매출·매입·경비 (합계 열은 참고용)', sales: '판매처별 매출 건', receivables: `청구 건별 청구액·수금액 (잔액 열은 참고용${scope ? ', 청구일 기준' : ''})` }[key]} · ${data[key].length}건`]),
    ], scope);
  }
  for (const { month, entries } of monthData) writeSheet(wb.addWorksheet(month), src, st, entries);
  for (const [key, title, cols] of dataSheets) writeDataSheet(wb.addWorksheet(title), st, title, cols, data[key]);
  if (wb.worksheets.length === 1) writeDataSheet(wb.addWorksheet('데이터 없음'), st, '내려받을 데이터가 없습니다', [['x', '', 30]], []);
  wb.removeWorksheet(src.id);
  wb.creator = 'NEWTORK 경영 대시보드';
  return wb.xlsx.writeBuffer();
}
