import { api, esc, toast } from '../core.js';
import { DATASETS, datasetSheet, downloadCsv, downloadCsvZip, downloadCompany, stamp } from '../exporter.js';

const KEYS = ['targets', 'monthly', 'sales', 'receivables'];
const DESC = {
  targets: '연도별 목표매출액',
  monthly: '월별 매출·매입·경비 · 엑셀은 달마다 회사 양식 시트(매입·경비·기타 지출 = 지출 칸)도 함께',
  sales: '판매처별 매출 건',
  receivables: '청구 건별 청구액·수금액 · 엑셀은 이번 달 회사 양식(미수금 현황)도 함께',
};
const KIND = { targets: 'targets', monthly: 'monthly', sales: 'sales', receivables: 'receivables' };

export async function render(main, ctx) {
  const years = [...new Set(ctx.meta.years)].sort((a, b) => b - a);
  main.innerHTML = `
    <div class="page-head">
      <div><h2>데이터 내보내기</h2><div class="sub">엑셀은 모두 회사 "경영지원 관리" 양식으로 내려받습니다. 그대로 <a href="#/upload">엑셀 업로드</a>에 올리면 반영됩니다.</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><h3>범위</h3></div>
      <div class="filters">
        <select class="input" id="x-year">
          <option value="">전체 기간</option>
          ${years.map((y) => `<option value="${y}">${y}년</option>`).join('')}
        </select>
        <span class="hint" style="color:var(--text-3)">연도를 고르면 그 해 데이터만 (미수금은 청구일 기준)</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="ttl"><h3>한 번에 받기</h3><span class="hint">엑셀 한 파일: 안내 · 달마다 경영지원 관리(미수금 현황·매입·경비·기타 지출) · 연간목표 · 월별실적 · 매출내역 · 미수금</span></div></div>
      <div class="filters">
        <button class="btn brand" id="x-all">⬇ 전체 데이터 엑셀 (경영지원 관리 양식)</button>
        <button class="btn" id="x-all-csv" title="CSV 파일 4개를 ZIP 하나로 묶어 내려받습니다">⬇ 전체 데이터 CSV (ZIP · 파일 4개)</button>
      </div>
      <div class="hint" style="margin-top:10px" id="x-count"></div>
    </div>
    <div class="card">
      <div class="card-head"><h3>항목별로 받기</h3><span class="hint">CSV는 서식 없이 표 하나만 담깁니다</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>항목</th><th>내용</th><th class="r">건수</th><th></th></tr></thead>
        <tbody>${KEYS.map((k) => `
          <tr><td><b>${DATASETS[k].sheet}</b></td><td>${esc(DESC[k])}</td><td class="r num" id="x-n-${k}">-</td>
            <td class="r"><button class="btn sm" data-x="${k}" data-f="xlsx">⬇ 엑셀</button> <button class="btn sm" data-x="${k}" data-f="csv">⬇ CSV</button></td></tr>`).join('')}
        </tbody></table></div>
    </div>`;

  const yearSel = main.querySelector('#x-year');
  let data = null;
  const scopeName = () => (yearSel.value ? `${yearSel.value}년` : '전체');

  async function load() {
    data = await api(`/api/mgmt/export${yearSel.value ? `?year=${yearSel.value}` : ''}`);
    KEYS.forEach((k) => { main.querySelector(`#x-n-${k}`).textContent = `${data[k].length.toLocaleString()}건`; });
    main.querySelector('#x-count').textContent = KEYS.map((k) => `${DATASETS[k].sheet} ${data[k].length}`).join(' · ');
  }
  yearSel.addEventListener('change', load);

  main.querySelector('#x-all').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await downloadCompany({ kind: 'full', year: yearSel.value });
    e.target.disabled = false;
  });
  main.querySelector('#x-all-csv').addEventListener('click', async (e) => {
    if (!data) return;
    e.target.disabled = true;
    await downloadCsvZip(`뉴토크코리아_경영데이터_CSV_${scopeName()}_${stamp()}`,
      KEYS.map((k) => ({ name: `${DATASETS[k].sheet}_${scopeName()}`, sheet: datasetSheet(k, data[k]) })));
    e.target.disabled = false;
    toast('CSV 파일 4개를 ZIP으로 내려받았습니다.');
  });
  main.querySelector('tbody').addEventListener('click', (e) => {
    const k = e.target.dataset.x;
    if (!k || !data) return;
    if (e.target.dataset.f === 'csv') downloadCsv(`뉴토크코리아_${DATASETS[k].sheet}_${scopeName()}_${stamp()}`, datasetSheet(k, data[k]));
    else downloadCompany({ kind: KIND[k], year: k === 'receivables' ? '' : yearSel.value });
  });

  await load();
}
