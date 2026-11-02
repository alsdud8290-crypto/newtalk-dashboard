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
        <div class="seg" id="x-mode">
          ${[['', '전체'], ['year', '연간'], ['quarter', '분기'], ['month', '월']].map(([v, l]) => `<button type="button" class="${v ? '' : 'on'}" data-m="${v}">${l}</button>`).join('')}
        </div>
        <select class="input" id="x-year" hidden>${years.map((y) => `<option value="${y}">${y}년</option>`).join('')}</select>
        <select class="input" id="x-q" hidden>${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === Math.ceil((new Date().getMonth() + 1) / 3) ? 'selected' : ''}>${q}분기 (${q * 3 - 2}~${q * 3}월)</option>`).join('')}</select>
        <select class="input" id="x-m" hidden>${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i === new Date().getMonth() ? 'selected' : ''}>${i + 1}월</option>`).join('')}</select>
        <span class="hint" style="color:var(--text-3)">고른 기간의 데이터만 담습니다 (미수금은 청구일 기준). 기간 파일을 다시 올리면 그 기간만 교체됩니다.</span>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px">
      <div class="card-head"><div class="ttl"><h3>한 번에 받기</h3><span class="hint">위에서 고른 기간 · 엑셀 한 파일: 안내 · 달마다 경영지원 관리(미수금 현황·매입·경비·기타 지출) · 연간목표 · 월별실적 · 매출내역 · 미수금</span></div></div>
      <div class="filters">
        <button class="btn brand" id="x-all">⬇ 엑셀 (경영지원 관리 양식)</button>
        <button class="btn" id="x-all-csv" title="CSV 파일 4개를 ZIP 하나로 묶어 내려받습니다">⬇ CSV (ZIP · 파일 4개)</button>
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
  const qSel = main.querySelector('#x-q');
  const mSel = main.querySelector('#x-m');
  const thisYear = String(new Date().getFullYear());
  if ([...yearSel.options].some((o) => o.value === thisYear)) yearSel.value = thisYear;
  let mode = '';
  let data = null;
  // 서버 period 형식: '' 전체 · 2026 · 2026-Q3 · 2026-09
  const period = () => (!mode || !yearSel.value ? '' : mode === 'year' ? yearSel.value
    : mode === 'quarter' ? `${yearSel.value}-Q${qSel.value}` : `${yearSel.value}-${mSel.value.padStart(2, '0')}`);
  const scopeName = () => (!mode ? '전체' : mode === 'year' ? `${yearSel.value}년`
    : mode === 'quarter' ? `${yearSel.value}년${qSel.value}분기` : `${yearSel.value}년${mSel.value}월`);

  main.querySelector('#x-mode').addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    mode = b.dataset.m;
    main.querySelectorAll('#x-mode [data-m]').forEach((x) => x.classList.toggle('on', x === b));
    yearSel.hidden = !mode;
    qSel.hidden = mode !== 'quarter';
    mSel.hidden = mode !== 'month';
    load();
  });
  [qSel, mSel].forEach((el) => el.addEventListener('change', load));

  async function load() {
    data = await api(`/api/mgmt/export${period() ? `?period=${period()}` : ''}`);
    KEYS.forEach((k) => { main.querySelector(`#x-n-${k}`).textContent = `${data[k].length.toLocaleString()}건`; });
    main.querySelector('#x-count').textContent = KEYS.map((k) => `${DATASETS[k].sheet} ${data[k].length}`).join(' · ');
  }
  yearSel.addEventListener('change', load);

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
    else downloadCompany({ kind: KIND[k], period: k === 'receivables' ? '' : period() });
  });

  await load();
}
