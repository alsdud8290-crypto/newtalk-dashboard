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
      ['product_purchase', '상품매입액', money], ['material_purchase', '원재료매입액', money], ['expense', '경비지출액', money],
      ['ad_expense', '광고선전비', money], ['entertainment_expense', '접대비', money], ['other_expense', '그외지출액', money],
      // 아래 합계 열은 참고용 (업로드 시에는 무시됨)
      [(r) => n(r.product_sales) + n(r.goods_sales) + n(r.service_sales), '매출합계', money],
      [(r) => n(r.product_purchase) + n(r.material_purchase) + n(r.expense) + n(r.ad_expense) + n(r.entertainment_expense) + n(r.other_expense), '지출합계', money],
    ],
  },
  sales: {
    sheet: '매출내역',
    cols: [['date', '일자'], ['customer', '판매처'], ['industry', '산업분야'], ['series', '제품시리즈'], ['sales_type', '매출구분'], ['amount', '금액', money], ['note', '비고']],
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
  const res = await fetch(`/api/mgmt/xlsx?${qs}`, { credentials: 'same-origin' });
  if (!res.ok) return toast((await res.json().catch(() => null))?.error || '내려받기에 실패했습니다.', true);
  const cd = res.headers.get('Content-Disposition') || '';
  saveBlob(decodeURIComponent((cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1] || 'export.xlsx'), await res.blob());
}
export const downloadFull = (year) => downloadCompany({ kind: 'full', year });
