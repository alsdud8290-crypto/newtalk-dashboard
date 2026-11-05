// 매출자료 (판매 관리 프로그램에서 받은 월별 파일, 예: 매출자료_202601.csv) 읽기 — 매출 내역 화면·경영 데이터 업로드가 같이 씀
// 열: *ID, 작업 구분, 사업 구분, 수출 구분, 판매번호, 최종발주처 / EPC, 사업명, 판매처, 매출액. 날짜 열이 없어 기준월은 파일·시트 이름에서 읽는다.
const CSV_COLS = { ext_id: 'id', work_type: '작업구분', biz_type: '사업구분', export_type: '수출구분', order_no: '판매번호',
  end_client: '최종발주처epc', project: '사업명', customer: '판매처', amount: '매출액' };
const WORK_TO_TYPE = [[/부품|교체/, '상품'], [/점검|수리|공사|용역/, '용역']]; // 그 외(제품·기타) → 제품
const BIZ_TO_INDUSTRY = [[/상하수도|수도/, '상하수도'], [/발전/, '발전소'], [/가스|오일|석유|정유/, '가스·오일·석유화학'], [/플랜트/, '민간 플랜트']];
const hnorm = (h) => String(h).replace(/[\s*/_·.\-]/g, '').toLowerCase();

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 이름(파일·시트)의 YYYYMM → 'YYYY-MM'
export function monthFromName(name) {
  const ym = String(name).normalize('NFC').match(/(20\d{2})[-_.]?(0[1-9]|1[0-2])(?!\d)/);
  return ym ? `${ym[1]}-${ym[2]}` : '';
}
// 첫 줄이 매출자료 머리글인지 (*ID·작업 구분·판매처·매출액)
export function isSalesFileHead(row) {
  const h = (row || []).map(hnorm);
  return h.includes('판매처') && h.includes('매출액') && (h.includes('작업구분') || h.includes('id'));
}

// 표(aoa) → { month, rows, warnings }
export function parseSalesAoa(aoa, name) {
  const head = (aoa[0] || []).map(hnorm);
  const idx = Object.fromEntries(Object.entries(CSV_COLS).map(([k, h]) => [k, head.indexOf(h)]));
  const missing = ['customer', 'amount'].filter((k) => idx[k] < 0).map((k) => CSV_COLS[k]);
  const month = monthFromName(name);
  const out = { month, rows: [], warnings: [] };
  if (missing.length) { out.warnings.push(`필수 열이 없습니다: ${missing.join(', ')}`); return out; }
  if (!month) out.warnings.push('이름에서 기준월(예: 매출자료_202601)을 찾지 못했습니다. 기준월을 골라 주세요.');
  for (const r of aoa.slice(1)) {
    if (!r.some((c) => String(c ?? '').trim())) continue;
    const v = Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i < 0 ? '' : String(r[i] ?? '').trim()]));
    v.ext_id = v.ext_id.replace(/"/g, '').trim();
    v.amount = Math.round(Number(v.amount.replace(/,/g, '')) || 0);
    v.sales_type = (WORK_TO_TYPE.find(([re]) => re.test(v.work_type)) || [, '제품'])[1];
    v.industry = (BIZ_TO_INDUSTRY.find(([re]) => re.test(v.biz_type)) || [, '기타'])[1];
    v.series = v.work_type;
    if (!v.customer) { out.warnings.push(`판매처가 빈 행을 건너뜁니다 (판매번호 ${v.order_no || '-'})`); continue; }
    out.rows.push(v);
  }
  return out;
}

export async function readSalesCsv(file) {
  const buf = await file.arrayBuffer();
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\uFFFD')) text = new TextDecoder('euc-kr').decode(buf); // 엑셀에서 저장한 CSV(CP949)
  return { file: file.name, ...parseSalesAoa(parseCsv(text.replace(/^\uFEFF/, '')), file.name) };
}

// 파일 → 결과 목록: CSV는 하나, 엑셀(내려받은 매출자료 파일)은 매출자료 시트마다 하나
export async function readSalesFiles(file) {
  if (/\.csv$/i.test(file.name)) return [await readSalesCsv(file)];
  const wb = XLSX.read(await file.arrayBuffer());
  return wb.SheetNames.map((name) => ({ name, aoa: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' }) }))
    .filter(({ aoa }) => isSalesFileHead(aoa[0]))
    .map(({ name, aoa }) => ({ file: `${file.name} › ${name}`, ...parseSalesAoa(aoa, monthFromName(name) ? name : file.name) }));
}
