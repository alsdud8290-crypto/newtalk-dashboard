// 내보내기 공통: 입력 데이터 → 엑셀/CSV, 화면 영역 → PNG 이미지
// 엑셀 시트·열 이름은 업로드 양식과 같다 → 내려받은 파일을 그대로 다시 업로드(백업·복원)할 수 있다.
import { toast } from './core.js';

const money = '#,##0';
export const DATASETS = {
  targets: {
    sheet: '연간목표',
    cols: [['year', '연도'], ['revenue', '목표매출액', money]],
  },
  monthly: {
    sheet: '월별실적',
    cols: [
      ['year', '연도'], ['month', '월'],
      ['product_sales', '제품매출액', money], ['goods_sales', '상품매출액', money], ['service_sales', '용역매출액', money],
      ['non_op_income', '영업외수익', money],
      ['product_purchase', '상품매입액', money], ['sga_expense', '판매비와관리비', money], ['non_op_expense', '영업외비용', money],
      ['material_purchase', '원재료매입액', money], ['labor_cost', '노무비', money], ['expense', '경비', money],
      ['receivables_total', '미수금총액', money],
      // 아래 합계 열은 참고용 (업로드 시에는 무시됨)
      [(r) => n(r.product_sales) + n(r.goods_sales) + n(r.service_sales) + n(r.non_op_income), '매출합계', money],
      [(r) => n(r.product_purchase) + n(r.sga_expense) + n(r.non_op_expense) + n(r.material_purchase) + n(r.labor_cost) + n(r.expense), '지출합계', money],
    ],
  },
  sales: {
    sheet: '매출내역',
    cols: [['date', '일자'], ['customer', '판매처'], ['industry', '산업분야'], ['series', '제품시리즈'], ['sales_type', '매출구분'], ['amount', '금액', money], ['note', '비고'],
      ['order_no', '판매번호'], ['project', '사업명'], ['end_client', '최종발주처']],
  },
  receivables: {
    sheet: '미수금',
    cols: [
      ['code', '코드'], ['customer', '거래처'], ['invoice_date', '청구일자'], ['amount', '청구액', money], ['collected', '수금액', money],
      ['collected_date', '수금일자'], ['due_date', '결제예정일'],
      [(r) => n(r.amount) - n(r.collected), '잔액', money], // 참고용
      ['note', '비고'],
    ],
  },
};
const n = (v) => Number(v) || 0;

// 데이터 종류 + 행 → 시트 정의 { name, aoa, formats }
export function datasetSheet(key, rows) {
  const def = DATASETS[key];
  return {
    name: def.sheet,
    aoa: [def.cols.map((c) => c[1]), ...rows.map((r) => def.cols.map(([k]) => (typeof k === 'function' ? k(r) : r[k] ?? '')))],
    formats: def.cols.map((c) => c[2] || null),
  };
}

function toWorksheet({ aoa, formats = [], widths }) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // 숫자 서식 (천 단위 콤마, 비율 등)
  for (let r = 1; r < aoa.length; r++) {
    formats.forEach((fmt, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (fmt && cell && typeof cell.v === 'number') cell.z = fmt;
    });
  }
  ws['!cols'] = (widths || aoa[0].map((h, c) => {
    const longest = Math.max(...aoa.slice(0, 200).map((row) => String(row[c] ?? '').length), String(h).length);
    return Math.min(40, Math.max(8, Math.ceil(longest * 1.6)));
  })).map((wch) => ({ wch }));
  return ws;
}

export function downloadXlsx(filename, sheets) {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, toWorksheet(s), s.name.slice(0, 31));
  XLSX.writeFile(wb, `${filename}.xlsx`);
}

// CSV: 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM을 붙인다. 숫자는 콤마 없이 원값
// CSV 본문. 서식이 없으므로 값 자체를 읽기 쉽게: 비율 → 백분율 숫자(85.3) + 열 이름에 (%), 금액 → 원 단위 정수
function csvText(sheet) {
  const fmts = sheet.formats || [];
  const aoa = sheet.aoa.map((row, r) => row.map((v, c) => {
    if (r === 0) return fmts[c] === '0.0%' ? `${v} (%)` : v;
    if (typeof v !== 'number') return v;
    if (fmts[c] === '0.0%') return Math.round(v * 1000) / 10;
    if (fmts[c] === money) return Math.round(v);
    return v;
  }));
  // 엑셀에서 한글이 깨지지 않도록 UTF-8 BOM
  return '\ufeff' + XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(aoa));
}

export function downloadCsv(filename, sheet) {
  saveBlob(`${filename}.csv`, new Blob([csvText(sheet)], { type: 'text/csv;charset=utf-8' }));
}

// 여러 표를 CSV 파일 여러 개로 → ZIP 하나에 담아 내려받기 (files: [{ name, sheet }])
export async function downloadCsvZip(filename, files) {
  if (!window.JSZip) return toast('ZIP 기능을 불러오지 못했습니다.', true);
  const zip = new JSZip();
  for (const f of files) zip.file(`${f.name}.csv`, csvText(f.sheet));
  saveBlob(`${filename}.zip`, await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }));
}

export function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// 화면 영역을 PNG로 저장 (그래프·제목·범례 포함). data-no-export 요소는 제외
export async function downloadImage(el, filename) {
  if (!window.html2canvas) return toast('이미지 저장 기능을 불러오지 못했습니다.', true);
  try {
    const canvas = await html2canvas(el, {
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      scale: Math.max(2, window.devicePixelRatio || 1),
      ignoreElements: (node) => node.hasAttribute?.('data-no-export'),
      logging: false,
    });
    canvas.toBlob((blob) => (blob ? saveBlob(`${filename}.png`, blob) : toast('이미지를 만들지 못했습니다.', true)), 'image/png');
  } catch (err) {
    toast(`이미지 저장 실패: ${err.message}`, true);
  }
}

// 화면 영역 → PDF (A4 가로). 카드가 페이지 경계에서 잘리지 않게 카드 아래쪽에서 페이지를 나눈다.
//  PDF는 직접 만든다: 페이지마다 JPEG 그림 한 장 (외부 라이브러리 없음)
export async function downloadPdf(el, filename) {
  if (!window.html2canvas) return toast('PDF 저장 기능을 불러오지 못했습니다.', true);
  try {
    const scale = 2;
    const canvas = await html2canvas(el, {
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      scale, ignoreElements: (node) => node.hasAttribute?.('data-no-export'), logging: false,
    });
    const top = el.getBoundingClientRect().top;
    const cuts = [...el.querySelectorAll('.card, .section-title, .notice, .kpis, .grid')]
      .map((n) => Math.round((n.getBoundingClientRect().bottom - top) * scale)).sort((a, b) => a - b);
    const [pw, ph, margin] = [842, 595, 24]; // A4 가로 (pt)
    const fit = (pw - margin * 2) / canvas.width;
    const pageH = Math.floor((ph - margin * 2) / fit);
    const pages = [];
    for (let y = 0; y < canvas.height;) {
      let end = Math.min(canvas.height, y + pageH);
      if (end < canvas.height) {
        const c = cuts.filter((v) => v > y + pageH * 0.4 && v <= end).pop();
        if (c) end = c + 2 * scale;
      }
      const part = document.createElement('canvas');
      part.width = canvas.width;
      part.height = end - y;
      const ctx = part.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, part.width, part.height);
      ctx.drawImage(canvas, 0, y, canvas.width, part.height, 0, 0, canvas.width, part.height);
      const bin = atob(part.toDataURL('image/jpeg', 0.9).split(',')[1]);
      pages.push({ w: part.width, h: part.height, jpg: Uint8Array.from(bin, (ch) => ch.charCodeAt(0)) });
      y = end;
    }
    saveBlob(`${filename}.pdf`, pdfFromImages(pages, pw, ph, margin, fit));
  } catch (err) {
    toast(`PDF 저장 실패: ${err.message}`, true);
  }
}

function pdfFromImages(pages, pw, ph, margin, fit) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body, stream) => {
    offsets[n] = size;
    push(`${n} 0 obj\n${body}\n`);
    if (stream) { push('stream\n'); push(stream); push('\nendstream\n'); }
    push('endobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const [pg, img, cs] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
    const w = (p.w * fit).toFixed(2);
    const h = (p.h * fit).toFixed(2);
    const draw = enc.encode(`q ${w} 0 0 ${h} ${margin} ${(ph - margin - p.h * fit).toFixed(2)} cm /Im0 Do Q`);
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${cs} 0 R >>`);
    obj(img, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpg.length} >>`, p.jpg);
    obj(cs, `<< /Length ${draw.length} >>`, draw);
  });
  const n = 3 + pages.length * 3;
  const xref = size;
  push(`xref\n0 ${n}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new Blob(parts, { type: 'application/pdf' });
}

// 파일 이름에 쓸 수 없는 문자 제거
export const fileSafe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
export const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

// 페이지 머리에 붙이는 [엑셀][CSV] 버튼
export const exportButtons = (prefix) => `
  <button type="button" class="btn" id="${prefix}-xlsx" title="엑셀 파일로 내려받기">⬇ 엑셀</button>
  <button type="button" class="btn" id="${prefix}-csv" title="CSV 파일로 내려받기">⬇ CSV</button>`;

// 엑셀 내려받기 (모두 회사 "경영지원 관리" 양식 서식) — params: { kind, year, q, open }
export async function downloadCompany(params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();
  return downloadFrom(`/api/mgmt/xlsx?${qs}`);
}
// 서버가 만든 파일 내려받기 (파일 이름은 서버 Content-Disposition 기준)
export async function downloadFrom(url) {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) return toast((await res.json().catch(() => null))?.error || '내려받기에 실패했습니다.', true);
  const cd = res.headers.get('Content-Disposition') || '';
  saveBlob(decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'export.xlsx'), await res.blob());
}
export const downloadFull = (year) => downloadCompany({ kind: 'full', year });

// ---------- 기간 고르기 (전체·연간·분기·월) ----------
// 서버 period 형식: '' 전체 · '2026' 연간 · '2026-Q3' 분기 · '2026-09' 월
const PERIOD_MODES = [['', '전체'], ['year', '연간'], ['quarter', '분기'], ['month', '월']];
//   modes: 보여 줄 보기와 순서 (기본 전부), month·quarter: 처음 고를 월·분기 (기본 이번 달)
export function periodPickerHtml({ years = [], year, mode = '', modes, month, quarter } = {}) {
  const now = new Date();
  const m0 = month || now.getMonth() + 1;
  const q0 = quarter || Math.ceil(m0 / 3);
  const y0 = year || now.getFullYear();
  const ys = [...new Set([...years, y0, now.getFullYear()])].sort((a, b) => b - a);
  return `<div class="pp" data-mode="${mode}">
    <div class="seg">${(modes ? modes.map((m) => PERIOD_MODES.find(([v]) => v === m)) : PERIOD_MODES).map(([v, l]) => `<button type="button" data-m="${v}" class="${v === mode ? 'on' : ''}">${l}</button>`).join('')}</div>
    <select class="input" data-pp="y" ${mode ? '' : 'hidden'}>${ys.map((v) => `<option value="${v}" ${v === y0 ? 'selected' : ''}>${v}년</option>`).join('')}</select>
    <select class="input" data-pp="q" ${mode === 'quarter' ? '' : 'hidden'}>${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === q0 ? 'selected' : ''}>${q}분기 (${q * 3 - 2}~${q * 3}월)</option>`).join('')}</select>
    <select class="input" data-pp="m" ${mode === 'month' ? '' : 'hidden'}>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === m0 ? 'selected' : ''}>${i + 1}월</option>`).join('')}</select>
  </div>`;
}
// el: .pp 요소 → { period(), label() }. 바뀔 때 onChange 호출
export function bindPeriodPicker(el, onChange = () => {}) {
  const sel = (k) => el.querySelector(`[data-pp="${k}"]`);
  let mode = el.dataset.mode || '';
  el.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    mode = b.dataset.m;
    el.querySelectorAll('[data-m]').forEach((x) => x.classList.toggle('on', x === b));
    sel('y').hidden = !mode;
    sel('q').hidden = mode !== 'quarter';
    sel('m').hidden = mode !== 'month';
    onChange();
  });
  el.querySelectorAll('select').forEach((s) => s.addEventListener('change', onChange));
  const y = () => sel('y').value;
  return {
    period: () => (!mode ? '' : mode === 'year' ? y() : mode === 'quarter' ? `${y()}-Q${sel('q').value}` : `${y()}-${sel('m').value.padStart(2, '0')}`),
    label: () => (!mode ? '전체' : mode === 'year' ? `${y()}년` : mode === 'quarter' ? `${y()}년${sel('q').value}분기` : `${y()}년${sel('m').value}월`),
  };
}

// 페이지 머리의 [⬇ 내려받기] → 기간 고르고 엑셀/CSV
//   opts: { years, year, mode, modes, month, quarter, hint, currentYear(), onExcel(period, label), onCsv(period, label) } — onCsv가 없으면 엑셀만
export const periodDownloadButton = (id) => `<span class="dl-menu pd" id="${id}"><button type="button" class="btn" data-pd-open aria-haspopup="true">⬇ 내려받기</button></span>`;
export function bindPeriodDownload(root, id, opts) {
  const wrap = root.querySelector(`#${id}`);
  const pop = document.createElement('div');
  pop.className = 'pd-pop';
  pop.hidden = true;
  pop.innerHTML = `<div class="pd-title">기간을 골라 내려받기</div>
    ${periodPickerHtml(opts)}
    ${opts.hint ? `<div class="pd-hint">${opts.hint}</div>` : ''}
    <div class="pd-actions"><button type="button" class="btn brand" data-pd="xlsx">⬇ 엑셀</button>${opts.onCsv ? '<button type="button" class="btn" data-pd="csv">⬇ CSV</button>' : ''}</div>`;
  wrap.appendChild(pop);
  const picker = bindPeriodPicker(pop.querySelector('.pp'));
  const close = (e) => { if (!wrap.contains(e.target)) { pop.hidden = true; document.removeEventListener('click', close); } };
  wrap.querySelector('[data-pd-open]').addEventListener('click', () => {
    // 화면에서 고른 연도를 기본값으로
    const ySel = pop.querySelector('[data-pp="y"]');
    const cy = opts.currentYear?.();
    if (pop.hidden && cy && ySel.value !== String(cy)) {
      if (![...ySel.options].some((o) => o.value === String(cy))) ySel.add(new Option(`${cy}년`, cy));
      ySel.value = String(cy);
    }
    // 화면에서 고른 보기·월·분기도 그대로 (opts.current() → { mode, month, quarter })
    const cur = pop.hidden && opts.current?.();
    if (cur) {
      if (cur.month) pop.querySelector('[data-pp="m"]').value = String(cur.month);
      if (cur.quarter) pop.querySelector('[data-pp="q"]').value = String(cur.quarter);
      pop.querySelector(`[data-m="${cur.mode}"]`)?.click();
    }
    pop.hidden = !pop.hidden;
    if (!pop.hidden) setTimeout(() => document.addEventListener('click', close));
  });
  pop.querySelector('.pd-actions').addEventListener('click', async (e) => {
    const f = e.target.dataset.pd;
    if (!f) return;
    e.target.disabled = true;
    try { await (f === 'xlsx' ? opts.onExcel : opts.onCsv)(picker.period(), picker.label()); } catch (err) { toast(err.message, true); }
    e.target.disabled = false;
  });
}

// ---------- 카드별 [⬇] 내려받기 (이미지 PNG · 데이터 CSV) ----------
// 카드 머리 정리: 설명(hint)은 제목 아래 작은 줄로, 오른쪽에는 상태 배지 + [⬇] 내려받기 메뉴(PNG/CSV)
export function addCardMenus(root) {
  root.querySelectorAll('[data-card]').forEach((card) => {
    const head = card.querySelector(':scope > .card-head, :scope > .section-title');
    if (!head || head.querySelector('.dl-menu')) return;
    let tools = head.querySelector(':scope > .card-tools');
    if (!tools) {
      tools = document.createElement('div');
      tools.className = 'card-tools';
      if (head.classList.contains('card-head')) {
        const had = head.querySelector(':scope > .ttl');
        const ttl = had || document.createElement('div');
        ttl.className = 'ttl';
        if (!had) head.prepend(ttl);
        [...head.children].forEach((c) => {
          if (c === ttl) return;
          if (c.tagName === 'H3' || c.classList.contains('hint')) ttl.append(c);
          else tools.append(c);
        });
      }
      head.append(tools);
    }
    const menu = document.createElement('div');
    menu.className = 'dl-menu';
    menu.setAttribute('data-no-export', '');
    menu.innerHTML = `
      <button type="button" class="btn sm dl-btn" data-dl-toggle title="내려받기" aria-haspopup="menu">⬇</button>
      <div class="dl-pop" role="menu" hidden>
        <button type="button" data-export="png" role="menuitem">이미지 (PNG)</button>
        <button type="button" data-export="csv" role="menuitem">데이터 (CSV)</button>
      </div>`;
    tools.append(menu);
  });
}
// 카드 메뉴 동작: getData(카드 키) → { name, aoa, formats }, prefix·label은 파일 이름에 씀
let menuCloser = false;
//  root(화면 본문)는 페이지가 바뀌어도 같은 요소라, 듣는 함수는 한 번만 붙이고 새 페이지의 opts로 바꿔 끼운다
export function bindCardMenus(root, opts) {
  root.__cardMenus = opts;
  if (root.__cardMenusBound) return;
  root.__cardMenusBound = true;
  if (!menuCloser) {
    menuCloser = true;
    document.addEventListener('click', (e) => { if (!e.target.closest('.dl-menu')) document.querySelectorAll('.dl-pop').forEach((p) => { p.hidden = true; }); });
  }
  root.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-dl-toggle]');
    if (toggle) {
      const pop = toggle.nextElementSibling;
      const open = pop.hidden;
      document.querySelectorAll('.dl-pop').forEach((p) => { p.hidden = true; });
      pop.hidden = !open;
      return;
    }
    const btn = e.target.closest('[data-export]');
    if (!btn) return;
    btn.closest('.dl-pop').hidden = true;
    const { getData, prefix = '뉴토크코리아', label = () => '' } = root.__cardMenus;
    const card = btn.closest('[data-card]');
    const data = getData(card.dataset.card);
    if (!data) return;
    const name = fileSafe(`${prefix}_${data.name}_${label()}_${stamp()}`);
    if (btn.dataset.export === 'csv') return downloadCsv(name, data);
    btn.disabled = true;
    await downloadImage(card, name);
    btn.disabled = false;
  });
}
