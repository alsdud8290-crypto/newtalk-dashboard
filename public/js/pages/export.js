import { api, esc, toast } from '../core.js';
import { DATASETS, datasetSheet, downloadXlsx, downloadCsv, stamp } from '../exporter.js';

const KEYS = ['targets', 'monthly', 'sales', 'receivables'];
const DESC = {
  targets: '연도별 목표매출액',
  monthly: '월별 매출·매입·경비 (매출합계·지출합계 참고 열 포함)',
  sales: '판매처별 매출 건',
  receivables: '청구 건별 청구액·수금액 (잔액 참고 열 포함)',
};

export async function render(main, ctx) {
  const years = [...new Set(ctx.meta.years)].sort((a, b) => b - a);
  main.innerHTML = `
    <div class="page-head">
      <div><h2>데이터 내보내기</h2><div class="sub">웹에서 입력·수정한 데이터를 엑셀 또는 CSV 파일로 내려받습니다.</div></div>
    </div>
    <div class="notice">엑셀 파일은 업로드 양식과 같은 형식이라, 백업해 두었다가 <a href="#/upload">엑셀 업로드</a>로 그대로 다시 올릴 수 있습니다.</div>
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
      <div class="card-head"><h3>한 번에 받기</h3></div>
      <button class="btn primary" id="x-all">⬇ 전체 데이터 엑셀 (시트 4개)</button>
      <span class="hint" style="color:var(--text-3);margin-left:8px" id="x-count"></span>
    </div>
    <div class="card">
      <div class="card-head"><h3>항목별로 받기</h3><span class="hint">CSV는 한 파일에 표 하나만 담기므로 항목별로 받습니다</span></div>
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

  main.querySelector('#x-all').addEventListener('click', () => {
    if (!data) return;
    downloadXlsx(`뉴토크코리아_경영데이터_${scopeName()}_${stamp()}`, KEYS.map((k) => datasetSheet(k, data[k])));
    toast('엑셀 파일을 내려받았습니다.');
  });
  main.querySelector('tbody').addEventListener('click', (e) => {
    const k = e.target.dataset.x;
    if (!k || !data) return;
    const sheet = datasetSheet(k, data[k]);
    const name = `뉴토크코리아_${DATASETS[k].sheet}_${scopeName()}_${stamp()}`;
    if (e.target.dataset.f === 'csv') downloadCsv(name, sheet);
    else downloadXlsx(name, [sheet]);
  });

  await load();
}
