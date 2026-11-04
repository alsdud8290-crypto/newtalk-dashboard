import { downloadCompany } from '../exporter.js';
import { api, esc, comma, toast } from '../core.js';

// 시트 종류별 열 이름 별칭. 기존 엑셀의 열 이름이 달라도 아래 중 하나와 맞으면 인식한다.
const SCHEMAS = {
  targets: {
    title: '연간목표',
    cols: { year: ['연도', '년도'], revenue: ['목표매출액', '목표매출', '연간목표매출액', '목표'] },
    required: ['year', 'revenue'],
  },
  monthly: {
    title: '월별실적',
    cols: {
      year: ['연도', '년도'], month: ['월'],
      product_purchase: ['상품매입액', '상품매입'], material_purchase: ['원재료매입액', '원재료매입', '원재료'],
      expense: ['경비지출액', '경비', '월간경비지출액'], ad_expense: ['광고선전비', '광고비'], entertainment_expense: ['접대비'],
      other_expense: ['그외지출액', '그외지출', '기타지출액', '기타지출'],
      product_sales: ['제품매출액', '제품매출'], goods_sales: ['상품매출액', '상품매출'], service_sales: ['용역매출액', '용역매출'],
    },
    required: ['month'],
  },
  sales: {
    title: '매출내역',
    cols: {
      date: ['일자', '날짜', '매출일', '매출일자', '작성일자'], customer: ['판매처', '거래처', '거래처명', '업체명', '상호'],
      industry: ['산업분야', '분야', '카테고리', '업종'], series: ['제품시리즈', '시리즈', '제품군', '품목'],
      sales_type: ['매출구분', '구분'], amount: ['금액', '매출액', '공급가액', '합계금액'], note: ['비고', '메모', '적요'],
    },
    required: ['date', 'customer', 'amount'],
  },
  receivables: {
    title: '미수금',
    cols: {
      code: ['코드', '거래처코드'], customer: ['거래처', '거래처명', '업체명', '상호', '판매처'], invoice_date: ['청구일자', '청구일', '발행일', '계산서일자', '세금계산서일자', '일자'],
      amount: ['청구액', '청구금액', '합계금액', '금액'], collected: ['수금액', '입금액', '수금금액'],
      collected_date: ['수금일자', '수금일', '입금일', '입금일자'], due_date: ['결제예정일', '수금예정일', '만기일', '결제일'], note: ['비고', '메모'],
    },
    required: ['customer', 'invoice_date', 'amount'],
  },
};

const INDUSTRY_ALIASES = {
  상하수도: ['상하수도', '상/하수도', '상수도', '하수도', '수도', '정수장', '하수처리'],
  발전소: ['발전소', '발전'], 가스: ['가스'], 오일: ['오일', 'oil'], 석유: ['석유', '정유', '석유화학'],
  '민간 플랜트': ['민간플랜트', '민간 플랜트', '플랜트'], 기타: ['기타'],
};

const norm = (h) => String(h ?? '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[\s_·.\-/]/g, '').toLowerCase();

function detectType(name, headers) {
  const n = norm(name);
  const hs = headers.map(norm);
  if (/목표/.test(n)) return 'targets';
  if (/미수|수금|채권/.test(n)) return 'receivables';
  if (/월별|실적|손익/.test(n)) return 'monthly';
  if (/매출/.test(n)) return 'sales';
  const has = (list) => list.some((a) => hs.includes(norm(a)));
  if (has(SCHEMAS.receivables.cols.collected) || has(['청구일자', '청구액'])) return 'receivables';
  if (has(['월']) && has(['제품매출액', '경비지출액', '원재료매입액'])) return 'monthly';
  if (has(SCHEMAS.sales.cols.customer) && has(SCHEMAS.sales.cols.amount)) return 'sales';
  if (has(SCHEMAS.targets.cols.revenue)) return 'targets';
  return null;
}

// 상단 제목줄이 있어도 헤더 행을 찾는다 (처음 10행 중 아는 열 이름이 2개 이상인 행)
function findHeader(aoa, type) {
  const known = new Set(Object.values(SCHEMAS[type].cols).flat().map(norm));
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    if ((aoa[i] || []).filter((h) => known.has(norm(h))).length >= 2) return i;
  }
  return -1;
}

function toDate(v) {
  if (v === null || v === undefined || v === '') return '';
  if (v instanceof Date && !Number.isNaN(v)) {
    const d = new Date(v.getTime() + 12 * 3600000); // 시간대 경계 보정
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[.\-/년\s]+(\d{1,2})[.\-/월\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})$/);
  if (m) return `20${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s; // 서버 검증에서 오류로 표시
}

function toIndustry(v, warn) {
  const s = norm(v);
  for (const [k, list] of Object.entries(INDUSTRY_ALIASES)) if (list.some((a) => s.includes(norm(a)))) return k;
  if (s) warn(`산업분야 '${v}' → '기타'로 분류`);
  return '기타';
}

function parseSheet(name, ws) {
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const type = detectType(name, aoa.slice(0, 10).flat());
  if (!type) {
    const company = aoa.slice(0, 5).flat().some((c) => /외상매출금|외상매입금|미지급비용|^미수금 ?현황$/.test(String(c).trim()));
    return company
      ? { name, type: null, company: true, rows: [], warnings: [] }
      : { name, type: null, rows: [], warnings: ['시트 종류를 알 수 없어 건너뜁니다.'] };
  }
  const hi = findHeader(aoa, type);
  if (hi < 0) return { name, type, rows: [], warnings: ['헤더(열 이름) 행을 찾지 못했습니다.'] };
  const headers = aoa[hi].map(norm);
  const schema = SCHEMAS[type];
  const colIdx = {};
  for (const [key, aliases] of Object.entries(schema.cols)) {
    const i = headers.findIndex((h) => aliases.some((a) => norm(a) === h));
    if (i >= 0) colIdx[key] = i;
  }
  const missing = schema.required.filter((k) => !(k in colIdx));
  if (missing.length) return { name, type, rows: [], warnings: [`필수 열 없음: ${missing.map((k) => schema.cols[k][0]).join(', ')}`] };

  const warnings = new Map();
  const warn = (w) => warnings.set(w, (warnings.get(w) || 0) + 1);
  const rows = [];
  for (const raw of aoa.slice(hi + 1)) {
    if (!raw.some((c) => String(c).trim())) continue;
    const r = {};
    for (const [k, i] of Object.entries(colIdx)) r[k] = raw[i];
    if (type === 'monthly') {
      const ym = String(r.month).match(/(\d{4})\D+(\d{1,2})/);
      if (ym) { r.year = r.year || ym[1]; r.month = ym[2]; }
      r.month = String(r.month).replace(/월/, '').trim();
      if (!/^\d{1,2}$/.test(r.month)) continue; // 합계 행 등은 건너뜀
      if (!r.year) r.year = document.getElementById('u-year').value;
      // 값을 하나도 채우지 않은 달(업로드 양식 그대로)은 건너뜀 — 0으로 덮어쓰지 않게
      if (Object.keys(colIdx).filter((k) => !['year', 'month'].includes(k)).every((k) => String(r[k] ?? '').trim() === '')) continue;
    }
    if (type === 'sales') {
      const label = String(r.customer || '').trim();
      if (/^(합계|소계|총계)$/.test(label)) continue;
      r.date = toDate(r.date);
      r.industry = toIndustry(r.industry, warn);
      r.sales_type = /상품/.test(r.sales_type) ? '상품' : /용역|서비스|유지보수/.test(r.sales_type) ? '용역' : '제품';
    }
    if (type === 'receivables') {
      const label = String(r.customer || '').trim();
      if (/^(합계|소계|총계)$/.test(label)) continue;
      r.invoice_date = toDate(r.invoice_date);
      r.collected_date = toDate(r.collected_date);
      r.due_date = toDate(r.due_date);
    }
    if (type === 'targets' && (!String(r.year).trim() || String(r.revenue ?? '').trim() === '')) continue;
    rows.push(r);
  }
  return { name, type, rows, warnings: [...warnings].map(([w, n]) => (n > 1 ? `${w} (${n}건)` : w)), cols: Object.keys(colIdx) };
}

export async function render(main, ctx) {
  let parsed = [];
  let ledgerSheets = []; // 회사 양식(채권·채무 현황) 시트 — 서버에서 읽음
  let fullBackup = false; // '경영지원 관리 (전체)' 내려받기 파일인지
  let backupRange = null; // 기간(월·분기·연간) 내려받기 파일이면 { from, to, label }

  // 화면 배치는 팀 업로드(제조내역·수주서·출장보고서·견적서)와 같게: 머리 + 파일 고르기 카드(끌어 놓기·안내) → 확인 카드
  main.innerHTML = `
    <div class="page-head">
      <div><h2>경영 데이터 엑셀 업로드</h2><div class="sub">목표·월별실적·매출내역·미수금 엑셀, "경영지원 관리" 양식 파일을 한 번에 반영합니다.</div></div>
      <div class="filters">
        <button class="btn" id="u-tpl">⬇ 업로드 양식</button>
        <button class="btn" id="u-full" title="지금 저장된 모든 경영지원 데이터를 경영지원 관리 양식 엑셀 한 파일로">⬇ 현재 데이터 전체</button>
        <a class="btn" href="#/mgmt/uploads">업로드 이력</a>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px" id="u-picker">
      <label class="dropzone" id="u-drop">
        <input type="file" id="u-file" accept=".xlsx,.xls,.csv" hidden multiple>
        <div style="font-size:15px;font-weight:600;margin-bottom:4px">파일을 여기에 끌어다 놓거나 클릭해서 선택</div>
        <div class="hint">.xlsx / .xls / .csv · 여러 파일 동시 선택 가능 · 올리면 바로 저장되지 않고 확인 화면이 나옵니다</div>
      </label>
      <div class="filters" style="margin-top:12px">
        <label class="hint" style="color:var(--text-2)">월별실적 시트에 연도 열이 없을 때 기준 연도</label>
        <select class="input" id="u-year">${Array.from({ length: 8 }, (_, i) => new Date().getFullYear() - 6 + i).map((y) => `<option ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`).join('')}</select>
      </div>
      <ul class="hint tips">
        <li>[⬇ 업로드 양식]을 내려받아 채우거나, 쓰던 엑셀을 그대로 올려도 됩니다. 열 이름이 비슷하면(거래처/업체명, 공급가액/금액 등) 자동으로 알아봅니다.</li>
        <li>시트마다 종류(연간목표·월별실적·매출내역·미수금·경영지원 관리 양식)를 판별해 확인 화면에 보여 줍니다.</li>
        <li>이 화면에서 내려받은 기간 파일(월·분기·연간)을 다시 올리면 그 기간의 매출내역·미수금만 교체합니다.</li>
        <li>오류가 하나라도 있으면 아무것도 저장되지 않습니다. 저장한 기록은 [업로드 이력]에서 볼 수 있습니다.</li>
      </ul>
    </div>
    <div id="u-preview"></div>`;

  // 업로드 양식 = 내려받기 파일과 같은 회사 양식 서식의 빈 파일
  main.querySelector('#u-tpl').addEventListener('click', () => downloadCompany({ kind: 'template' }));
  main.querySelector('#u-full').addEventListener('click', () => downloadCompany({ kind: 'full' }));
  const drop = main.querySelector('#u-drop');
  const input = main.querySelector('#u-file');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files); });
  input.addEventListener('change', () => handle(input.files));

  let fileNames = [];
  async function handle(files) {
    fileNames = [...files].map((f) => f.name);
    parsed = [];
    ledgerSheets = [];
    fullBackup = false;
    backupRange = null;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const wb = XLSX.read(buf, { cellDates: true });
        let hasCompany = false;
        for (const name of wb.SheetNames) {
          if (name === '작성안내') continue;
          if (name === '안내') {
            const a1 = wb.Sheets[name].A1?.v || '';
            if (String(a1).includes('경영지원 관리 (전체)')) fullBackup = true;
            else {
              const lb = String(a1).match(/경영지원 관리 \((.+)\)/);
              const rg = String(wb.Sheets[name].B3?.v || '').match(/(\d{4}-\d{2})\s*~\s*(\d{4}-\d{2})/);
              if (lb && rg) backupRange = { label: lb[1], from: rg[1], to: rg[2] };
            }
            continue;
          }
          const p = parseSheet(name, wb.Sheets[name]);
          if (p.company) { hasCompany = true; continue; }
          parsed.push({ file: f.name, ...p });
        }
        // 회사 양식 시트는 서식(병합·글자색)까지 봐야 해서 서버에서 읽는다
        if (hasCompany && /\.xlsx$/i.test(f.name)) {
          const b64 = btoa(Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(''));
          const r = await api('/api/mgmt/company/parse', { method: 'POST', body: { file: b64 } });
          r.sheets.forEach((sh) => ledgerSheets.push({ file: f.name, ...sh }));
        }
      } catch (err) {
        parsed.push({ file: f.name, name: '-', type: null, rows: [], warnings: [`파일을 읽을 수 없습니다: ${err.message}`] });
      }
    }
    input.value = '';
    preview();
  }

  function preview() {
    const el = main.querySelector('#u-preview');
    main.querySelector('#u-picker').hidden = !!(parsed.length || ledgerSheets.length);
    if (!parsed.length && !ledgerSheets.length) { el.innerHTML = ''; return; }
    const usable = parsed.filter((p) => p.type && p.rows.length);
    const hasSales = usable.some((p) => p.type === 'sales');
    const hasRecv = usable.some((p) => p.type === 'receivables');
    const thisMonth = new Date().toISOString().slice(0, 7);
    const secNames = { ar: '미수금 현황', ap: '매입 지출', staff: '경비 지출', vendor: '기타 지출' };
    const ledgerHtml = ledgerSheets.length ? `
      <div style="margin:16px 0 8px"><b>경영지원 관리 (회사 양식)</b> <span class="badge blue">${ledgerSheets.length}개월</span></div>
      <div class="notice" style="margin-bottom:10px">시트마다 기준월을 확인해 주세요. 저장하면
        <b>미수금 현황(외상매출금) → 미수금 관리</b>(가장 최근 기준월의 내용으로 교체${hasRecv ? ' — 파일에 미수금 상세 시트가 있어 그쪽을 씁니다' : ''}),
        <b>매입 지출(외상매입금) → 월별 실적 상품·원재료 매입</b>, <b>경비 지출(미지급비용-직원) → 경비</b>, <b>기타 지출(미지급비용-업체) → 광고선전비·접대비·그 외 지출</b>로 그 달에 반영됩니다${usable.some((p) => p.type === 'monthly') ? ' (월별실적 시트에 있는 달은 그 시트 값을 씁니다)' : ''}.</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>파일 › 시트</th><th>기준월</th><th>건수</th></tr></thead><tbody>
      ${ledgerSheets.map((sh, k) => `<tr><td>${esc(sh.file)} › ${esc(sh.sheet)}</td>
        <td><input class="input" type="month" data-lm="${k}" value="${sh.month || thisMonth}" style="width:160px"></td>
        <td>${Object.entries(secNames).map(([key, label]) => `${label} ${sh.counts[key] || 0}`).join(' · ')}${sh.warnings.length ? `<div class="notice warn" style="margin:6px 0 0">${sh.warnings.map(esc).join('<br>')}</div>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '';
    el.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>${esc(fileNames.join(', '))}</h3><span class="hint" id="u-state">경영 데이터 엑셀 · 확인 대기</span></div>
          <div class="filters">
            <button class="btn" id="u-new">다른 파일 올리기</button>
            ${hasSales ? `<span class="check-row"><label><input type="checkbox" id="u-rs"> ${backupRange ? `${esc(backupRange.label)}의 기존 매출 내역을 지우고 교체` : '해당 연도의 기존 매출 내역을 지우고 교체'}</label></span>` : ''}
            ${hasRecv ? `<span class="check-row"><label><input type="checkbox" id="u-rr"> ${backupRange ? `${esc(backupRange.label)}에 청구된 기존 미수금을 지우고 교체` : '기존 미수금 전체를 지우고 교체'}</label></span>` : ''}
            <button class="btn primary" id="u-save" ${usable.length || ledgerSheets.length ? '' : 'disabled'}>저장</button>
          </div>
        </div>
        <div class="kv-row" style="margin-bottom:12px"><span>읽은 시트 <b>${usable.length + ledgerSheets.length}</b></span>
          <span>읽은 행 <b>${usable.reduce((a, p) => a + p.rows.length, 0) + ledgerSheets.reduce((a, sh) => a + sh.entries.length, 0)}</b></span>
          ${parsed.length - usable.length ? `<span class="muted">건너뛴 시트 ${parsed.length - usable.length}</span>` : ''}</div>
        ${fullBackup
          ? '<div class="notice" style="margin-bottom:12px"><b>전체 데이터 파일</b>입니다. 저장하면 매출내역·미수금은 파일 내용으로 <b>교체</b>되고, 연간목표·월별실적은 파일에 있는 연도·월만 덮어씁니다.</div>'
          : backupRange
          ? `<div class="notice" style="margin-bottom:12px"><b>${esc(backupRange.label)} 데이터 파일</b>(${backupRange.from} ~ ${backupRange.to})입니다. 저장하면 이 기간의 매출내역·미수금(청구일 기준)만 파일 내용으로 <b>교체</b>되고, 다른 기간 데이터는 그대로 둡니다.</div>`
          : '<div class="notice" style="margin-bottom:12px">같은 파일을 두 번 올리면 매출 내역·미수금이 중복 등록됩니다. 다시 올릴 때는 \'지우고 교체\'를 선택해 주세요.</div>'}
        <div id="u-result"></div>
        ${ledgerHtml}
        ${parsed.map((p) => sheetPreview(p)).join('')}
      </div>`;
    if (fullBackup || backupRange) el.querySelectorAll('#u-rs, #u-rr').forEach((c) => { c.checked = true; });
    el.querySelectorAll('[data-lm]').forEach((inp) => inp.addEventListener('change', () => { ledgerSheets[Number(inp.dataset.lm)].month = inp.value; }));
    ledgerSheets.forEach((sh) => { if (!sh.month) sh.month = thisMonth; });
    el.querySelector('#u-save')?.addEventListener('click', save);
    el.querySelector('#u-new').addEventListener('click', () => { parsed = []; ledgerSheets = []; preview(); });
  }

  function sheetPreview(p) {
    const schema = p.type ? SCHEMAS[p.type] : null;
    const cols = p.cols || [];
    const head = `<div style="display:flex;gap:8px;align-items:center;margin:16px 0 8px;flex-wrap:wrap">
      <b>${esc(p.file)} › ${esc(p.name)}</b>
      ${schema ? `<span class="badge blue">${schema.title}</span><span class="hint">${p.rows.length}행</span>` : '<span class="badge">건너뜀</span>'}
    </div>`;
    const warns = p.warnings.length ? `<div class="notice warn"><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
    if (!schema || !p.rows.length) return head + warns;
    const fmt = (k, v) => (['amount', 'collected', 'revenue'].includes(k) || k.endsWith('_sales') || k.endsWith('_purchase') || k.endsWith('expense') ? comma(String(v).replace(/[,원\s]/g, '')) : esc(v instanceof Date ? v.toISOString().slice(0, 10) : v));
    const shown = p.rows.slice(0, 5);
    return head + warns + `<div class="table-wrap"><table class="tbl"><thead><tr>${cols.map((k) => `<th>${schema.cols[k][0]}</th>`).join('')}</tr></thead>
      <tbody>${shown.map((r) => `<tr>${cols.map((k) => `<td>${fmt(k, r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${p.rows.length > 5 ? `<div class="hint" style="margin-top:6px">… 외 ${p.rows.length - 5}행</div>` : ''}`;
  }

  async function save() {
    const body = { targets: [], monthly: [], sales: [], receivables: [] };
    for (const p of parsed) if (p.type) body[p.type].push(...p.rows);
    body.replaceSalesYears = !!main.querySelector('#u-rs')?.checked;
    body.replaceReceivables = !!main.querySelector('#u-rr')?.checked;
    body.replaceAllSales = fullBackup && body.replaceSalesYears; // 전체 백업 복원: 매출내역 전부 교체
    if (backupRange) body.replaceRange = { from: backupRange.from, to: backupRange.to }; // 기간 파일: 그 기간만 교체
    const result = main.querySelector('#u-result');
    const btn = main.querySelector('#u-save');
    btn.disabled = true;
    try {
      const months = new Set();
      for (const sh of ledgerSheets) {
        if (!/^\d{4}-\d{2}$/.test(sh.month || '')) throw new Error(`${sh.sheet}: 경영지원 관리 시트의 기준월을 입력해 주세요.`);
        if (months.has(sh.month)) throw new Error(`기준월 ${sh.month}이(가) 두 번 있습니다. 시트마다 다른 기준월을 골라 주세요.`);
        months.add(sh.month);
      }
      const hasData = Object.values(body).some((v) => Array.isArray(v) && v.length);
      const r = hasData ? await api('/api/mgmt/import', { method: 'POST', body }) : { counts: { targets: 0, monthly: 0, sales: 0, receivables: 0 } };
      // 회사 양식 시트 반영: 월별실적 시트에 그 달이 있으면 그 값을 우선, 미수금 상세 시트가 있으면 그쪽을 우선
      const monthlyInFile = new Set(body.monthly.map((m) => `${m.year}-${String(m.month).replace(/\D/g, '').padStart(2, '0')}`));
      const latest = [...months].sort().pop();
      let recvFromCompany = null;
      const costMonths = [];
      for (const sh of ledgerSheets) {
        const out = await api('/api/mgmt/company/import', { method: 'POST', body: {
          month: sh.month, entries: sh.entries, sections: sh.found,
          applyMonthly: !monthlyInFile.has(sh.month),
          // 내려받은 백업 파일은 미수금 시트가 따로 있으므로 미수금 현황으로 미수금을 덮지 않는다
          applyReceivables: !fullBackup && !backupRange && !body.receivables.length && sh.month === latest,
        } });
        if (out.receivables !== null) recvFromCompany = out.receivables;
        if (out.monthly) costMonths.push(sh.month);
      }
      const recvCount = recvFromCompany !== null ? `${recvFromCompany}건 (미수금 현황 ${latest} 기준)` : `${r.counts.receivables}건`;
      const companyNote = !ledgerSheets.length ? ''
        : costMonths.length ? ` + 경영지원 관리 지출 반영 ${costMonths.length}개월(${costMonths.join(', ')})`
          : recvFromCompany === null && !body.monthly.length ? ' · 경영지원 관리 시트에 반영할 내용(거래처·금액)이 없었습니다' : '';
      const note = `연간목표 ${r.counts.targets}건, 월별실적 ${r.counts.monthly}건${companyNote}, 매출내역 ${r.counts.sales}건, 미수금 ${recvCount}`;
      // 이력에는 0건인 항목을 빼고 짧게
      const logNote = [['연간목표', r.counts.targets], ['월별실적', r.counts.monthly], ['매출내역', r.counts.sales]].filter(([, n]) => n).map(([l, n]) => `${l} ${n}건`)
        .concat(recvFromCompany !== null || r.counts.receivables ? [`미수금 ${recvCount}`] : [], costMonths.length ? [`지출 반영 ${costMonths.length}개월`] : []).join(', ') || '반영할 내용 없음';
      result.innerHTML = `<div class="notice">저장 완료 — ${note}. <a href="#/dashboard">대시보드에서 확인 →</a></div>`;
      main.querySelector('#u-state').textContent = '경영 데이터 엑셀 · 저장 완료';
      // 업로드 이력에 남김 (실패해도 저장은 끝났으므로 안내만)
      const savedCount = r.counts.targets + r.counts.monthly + r.counts.sales + (recvFromCompany ?? r.counts.receivables) + costMonths.length;
      const rowCount = parsed.reduce((a, p) => a + (p.type ? p.rows.length : 0), 0) + ledgerSheets.reduce((a, sh) => a + sh.entries.length, 0);
      api('/api/mgmt/upload-log', { method: 'POST', body: { file_name: fileNames.join(', '), row_count: rowCount, saved_count: savedCount, note: logNote } })
        .catch(() => toast('저장은 됐지만 업로드 이력을 남기지 못했습니다.', true));
      toast('업로드한 데이터를 저장했습니다.');
      await ctx.reloadMeta();
    } catch (err) {
      result.innerHTML = `<div class="notice err"><b>${esc(err.message)}</b>${err.details ? `<ul>${err.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`;
      btn.disabled = false;
    }
  }
}
