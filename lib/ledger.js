// 회사 양식 "경영지원 관리" (채권·채무 현황) — 엑셀 읽기·쓰기
// 양식 구조: 외상매출금(장기 미수금 / 당월 수금된 / 당월 수금예정 업체) · 외상매입금 · 미지급비용-직원 · 미지급비용-업체(자동이체 + 그 외)
// 내려받기는 회사 양식 파일(templates/)을 열어 서식(글꼴·색·테두리·병합·합계 수식)을 그대로 복사해 행을 다시 그린다.
import ExcelJS from 'exceljs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(here, '..', 'templates', 'company-ledger-template.xlsx');

export const SECTIONS = {
  ar: { title: '외상매출금', groups: ['long', 'collected', 'scheduled'] },
  ap: { title: '외상매입금', groups: ['normal'], note: '← 당월 매입 지출', min: 9 },
  staff: { title: '미지급비용-직원', groups: ['normal'], note: '← 당월 경비 지출', min: 10 },
  vendor: { title: '미지급비용-업체', groups: ['auto', 'normal'], note: '← 당월 그 외 지출', min: 13 },
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

// ---------- DB ----------
export async function listMonths() {
  return db.all(`SELECT month, COUNT(*) AS n, SUM(balance) AS total FROM ledger GROUP BY month ORDER BY month DESC`);
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

export async function replaceMonth(month, entries) {
  const rows = entries.map(cleanEntry).filter((e) => e.name || e.balance || e.code || e.memo);
  const stmts = [['DELETE FROM ledger WHERE month = ?', [month]]];
  rows.forEach((e, i) => stmts.push([
    'INSERT INTO ledger (month, section, grp, code, name, balance, memo, red, sort) VALUES (?,?,?,?,?,?,?,?,?)',
    [month, e.section, e.grp, e.code, e.name, e.balance, e.memo, e.red, i],
  ]));
  await db.batch(stmts);
  return rows.length;
}

// ---------- 미수금 관리 데이터 → 외상매출금 (월말 기준) ----------
// 날짜 → '9/12' (기준월과 연도가 다르면 '25.9/12')
const md = (d, y) => `${y && Number(d.slice(0, 4)) !== y ? `${d.slice(2, 4)}.` : ''}${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const manwon = (v) => (Math.abs(v) >= 1e4 ? `${Math.round(v / 1e4).toLocaleString('ko-KR')}만` : `${Math.round(v).toLocaleString('ko-KR')}`);

export async function receivablesToAr(month) {
  const [y, m] = month.split('-').map(Number);
  const end = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  const endDate = new Date(`${end}T00:00:00`);
  const rows = await db.all('SELECT * FROM receivables WHERE invoice_date <= ?', end);
  const by = {};
  for (const r of rows) {
    const c = (by[r.customer] ||= { name: r.customer, balance: 0, collectedNow: [], dueNow: [], oldestOpen: null });
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
      memo = `${md(last, y)} 수금 ${manwon(sumC)}${c.balance > 0.5 ? '' : ' · 완납'}`;
    } else if (c.balance > 0.5) {
      grp = 'scheduled';
      memo = c.dueNow.length ? `${md(c.dueNow.sort()[0], y)} 수금 예정` : '';
    } else {
      continue;
    }
    out.push({ section: 'ar', grp, code: '', name: c.name, balance: Math.round(c.balance), memo, red: grp === 'long' ? 1 : 0 });
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
  if (/^외상매출금/.test(t)) return 'ar';
  if (/^외상매입금/.test(t)) return 'ap';
  if (/^미지급비용-?직원/.test(t)) return 'staff';
  if (/^미지급비용-?업체/.test(t)) return 'vendor';
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

// months: [{ month, entries }] → 시트 하나씩 (시트 이름 = 기준월)
export async function buildWorkbook(months) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const src = wb.worksheets[0];
  const st = collectStyles(src);
  for (const { month, entries } of months) {
    const ws = wb.addWorksheet(month, { views: [{ showGridLines: true }] });
    writeSheet(ws, src, st, entries);
  }
  wb.removeWorksheet(src.id);
  wb.creator = 'NEWTORK 경영 대시보드';
  return wb.xlsx.writeBuffer();
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
    ['customer', '거래처', 26], ['invoice_date', '청구일자', 12], ['amount', '청구액', 16, 'money'], ['collected', '수금액', 16, 'money'],
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

function writeGuide(ws, st, sheetsInfo) {
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 80;
  const put = (addr, v, style) => { const c = ws.getCell(addr); c.value = v; if (style) c.style = clone(style); };
  put('A1', FULL_MARK, { ...st.title, font: { ...(st.title.font || {}), size: 12, bold: true } });
  const d = new Date();
  put('A2', '내려받은 날짜');
  put('B2', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  put('A4', '시트', st.head);
  put('B4', '내용', st.head);
  sheetsInfo.forEach(([a, b], i) => { put(`A${5 + i}`, a, st.name); put(`B${5 + i}`, b, st.name); });
  const r = 6 + sheetsInfo.length;
  put(`A${r}`, '다시 올리기');
  put(`B${r}`, '이 파일을 웹의 [엑셀 업로드·데이터 이관]에 그대로 올리면 전체가 반영됩니다. (매출내역·미수금은 파일 내용으로 교체)');
  put(`A${r + 1}`, '주의');
  put(`B${r + 1}`, '시트 이름과 2행의 열 이름은 바꾸지 마세요. 행은 자유롭게 추가·삭제할 수 있습니다.');
}

// data: { targets, monthly, sales, receivables }, months: [{ month, entries }]
export async function buildFullWorkbook(data, months) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const src = wb.worksheets[0];
  const st = collectStyles(src);
  const info = [
    ...months.map(({ month }) => [month, `채권·채무 현황 (회사 양식) — ${month.replace('-', '년 ')}월 기준`]),
    ...DATA_SHEETS.map(([key, title]) => [title, `${{ targets: '연도별 목표매출액', monthly: '월별 매출·매입·경비 (합계 열은 참고용)', sales: '판매처별 매출 건', receivables: '청구 건별 청구액·수금액 (잔액 열은 참고용)' }[key]} · ${data[key].length}건`]),
  ];
  writeGuide(wb.addWorksheet('안내'), st, info);
  for (const { month, entries } of months) writeSheet(wb.addWorksheet(month), src, st, entries);
  for (const [key, title, cols] of DATA_SHEETS) writeDataSheet(wb.addWorksheet(title), st, title, cols, data[key]);
  wb.removeWorksheet(src.id);
  wb.creator = 'NEWTORK 경영 대시보드';
  return wb.xlsx.writeBuffer();
}
