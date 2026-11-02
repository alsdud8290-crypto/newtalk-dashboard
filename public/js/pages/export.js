import { api, esc, toast } from '../core.js';
import { DATASETS, datasetSheet, downloadCsv, downloadCsvZip, downloadCompany, stamp, periodPickerHtml, bindPeriodPicker } from '../exporter.js';

const KEYS = ['targets', 'monthly', 'sales', 'receivables'];
const DESC = {
  targets: '연도별 목표매출액',
  monthly: '월별 매출·매입·경비 · 엑셀은 달마다 회사 양식 시트(매입·경비·기타 지출 = 지출 칸)도 함께',
  sales: '판매처별 매출 건',
  receivables: '청구 건별 청구액·수금액 · 엑셀은 달마다(전체는 이번 달) 미수금 현황도 함께',
};
const KIND = { targets: 'targets', monthly: 'monthly', sales: 'sales', receivables: 'receivables' };

export async function render(main, ctx) {
  const years = [...new Set(ctx.meta.years)].sort((a, b) => b - a);
  main.innerHTML = `
    <div class="page-head">
      <div><h2>데이터 내보내기</h2><div class="sub">엑셀은 모두 회사 "경영지원 관리" 양식으로 내려받습니다. 그대로 <a href="#/upload">엑셀 업로드</a>에 올리면 반영됩니다.</div></div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="ttl"><h3>① 기간 고르기 → ② 내려받기</h3><span class="hint">고른 기간의 데이터만 담습니다 (미수금은 청구일 기준). 기간 파일을 다시 올리면 그 기간만 교체됩니다.</span></div></div>
      <div id="x-pp">${periodPickerHtml({ years, mode: '' })}</div>
      <div class="filters" style="margin-top:14px">
        <button class="btn brand" id="x-all">⬇ 엑셀 (경영지원 관리 양식)</button>
        <button class="btn" id="x-all-csv" title="CSV 파일 4개를 ZIP 하나로 묶어 내려받습니다">⬇ CSV (ZIP · 파일 4개)</button>
      </div>
      <div class="hint" style="margin-top:10px" id="x-count"></div>
      <div class="hint" style="margin-top:4px;color:var(--text-3)">엑셀 한 파일: 안내 · 달마다 경영지원 관리(미수금 현황·매입·경비·기타 지출) · 연간목표 · 월별실적 · 매출내역 · 미수금</div>
    </div>
    <div class="card">
      <div class="card-head"><h3>항목별로 받기</h3><span class="hint">위에서 고른 기간 · CSV는 서식 없이 표 하나만 담깁니다</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>항목</th><th>내용</th><th class="r">건수</th><th></th></tr></thead>
        <tbody>${KEYS.map((k) => `
          <tr><td><b>${DATASETS[k].sheet}</b></td><td>${esc(DESC[k])}</td><td class="r num" id="x-n-${k}">-</td>
            <td class="r"><button class="btn sm" data-x="${k}" data-f="xlsx">⬇ 엑셀</button> <button class="btn sm" data-x="${k}" data-f="csv">⬇ CSV</button></td></tr>`).join('')}
        </tbody></table></div>
    </div>`;

  let data = null;
  const picker = bindPeriodPicker(main.querySelector('#x-pp .pp'), () => load());
  const period = () => picker.period();
  const scopeName = () => picker.label();

  async function load() {
    data = await api(`/api/mgmt/export${period() ? `?period=${period()}` : ''}`);
    KEYS.forEach((k) => { main.querySelector(`#x-n-${k}`).textContent = `${data[k].length.toLocaleString()}건`; });
    main.querySelector('#x-count').textContent = `${scopeName()} · ${KEYS.map((k) => `${DATASETS[k].sheet} ${data[k].length}건`).join(' · ')}`;
  }

  main.querySelector('#x-all').addEventListener('click', async (e) => {
    e.target.disabled = true;
    await downloadCompany({ kind: 'full', period: period() });
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
    else downloadCompany({ kind: KIND[k], period: period() });
  });

  await load();
}
