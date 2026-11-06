// 팀 업로드 화면 공통 (ITB2026 업로드 확인 화면을 옮겨 옴): 파일 선택 → 추출 → 확인·수정 → 저장
//  단가 화면(부품 단가 데이터 CSV·출장지별 단가 CSV·신규 부품 엑셀)도 mountUpload로 이 흐름을 쓴다
//  - 표에서 칸을 바로 고칠 수 있고, 행을 제외할 수 있다. [다시 검사]로 고친 값을 반영해 오류·중복을 다시 확인
//  - 오류가 하나라도 있으면 저장되지 않는다. 이미 저장된 번호는 건너뛰거나(기본) 새 값으로 갱신(제조내역)
// 업로드 이력: 그 팀 파일 종류의 최근 100건 (원본 파일은 보관하지 않음)
import { api, esc, toast, confirmBox } from '../core.js';

const UPLOADS = {
  manufacturing_excel: {
    title: '제조내역 엑셀 업로드', team: 'production', accept: '.xlsx',
    sub: '제조내역 엑셀(연도별 시트)을 올리면 일련번호가 있는 행만 읽습니다. 같은 일련번호가 이미 있으면 새로 올린 값으로 갱신하고, 바뀐 칸을 이전 → 새 값으로 보여 줍니다.',
    tips: ['위쪽 작성방법·두 줄 제목은 자동으로 건너뜁니다 ("일련번호" 제목 칸을 찾아 그 아래부터).', '일련번호·모델명·검사번호의 앞부분(N8226, NTI-, NTK26)은 셀 표시 형식에서 읽습니다.',
      '일련번호가 없는 행(오른쪽 숫자만 있는 행)은 제외합니다.', '같은 파일에 같은 일련번호가 여러 번 나오면 마지막 행 기준입니다.'],
  },
  sales_order_excel: {
    title: '수주내역', team: 'production', accept: '.xlsx', done: '#/production/orders', doneLabel: '수주 내역에서 확인', skippedLabel: '판매번호·품명이 모두 빈 행',
    sub: '수주내역 시트를 판매번호·제품 단위로 읽습니다. 같은 판매번호·품목 순번이 이미 있으면 새 값으로 덮어씁니다(바뀐 칸 표시).', tips: [],
  },
  sales_order_pdf: {
    title: '수주서 PDF 업로드', team: 'production', accept: '.pdf',
    sub: '수주서 PDF(1쪽 = 수주서 1건)를 올리면 판매정보와 제품정보를 읽습니다. 확인 표는 제품 1개 = 1행이고, 같은 판매번호가 이미 있으면 건너뜁니다.',
    tips: ['PDF에서 긴 값이 "…"로 잘려 있으면 오류로 표시됩니다. 전체 값으로 고쳐 주세요.', '사업구분은 7개 산업 분야로 바꿔 보여 줍니다(모르는 값은 기타). 확인 표에서 바꿀 수 있습니다.',
      '수주서류 번호는 "#26024 …"에서 번호만 저장합니다.', '같은 판매번호의 행끼리는 주문 정보가 같아야 합니다.'],
  },
  trip_report_pdf: {
    title: '출장보고서 PDF 업로드', team: 'service', accept: '.pdf',
    sub: '출장보고서 PDF(1쪽 = 보고서 1건)를 올리면 출장정보·제품·교체 부품·작업 내용을 읽습니다. 검사 규칙은 직접 입력과 같습니다.',
    tips: ['요청처의 시·도·시·군이 기억돼 있으면 자동으로 채우고, 없으면 확인 표에서 골라 주세요(저장하면 기억).', '잘린 값(…), 특히 긴 부품명은 전체 값으로 고쳐 주세요.',
      '같은 출장 시작일·요청처의 보고서가 있으면 건너뜁니다. 실제로 두 번 간 경우 "중복 아님"을 체크하세요.'],
  },
  service_csv: {
    title: '서비스 데이터 업로드', team: 'service', accept: '.csv', done: '#/service/reports', doneLabel: '출장보고서 목록에서 확인', skippedLabel: 'ID가 빈 줄',
    sub: '서비스 데이터 CSV를 올리면 1줄 = 출장보고서 1건으로 읽습니다. 같은 ID가 이어지는 줄은 그 보고서의 제품으로 합칩니다.',
    tips: ['같은 ID가 이미 저장돼 있으면 새 내용으로 덮어씁니다(바뀐 칸을 이전 → 새 값으로 표시). 내용이 같으면 건너뜁니다.',
      '시·도·시·군은 "지역" 칸(예: 경상남도 김해시)에서 읽습니다. 비어 있으면 기억된 요청처 지역이나 요청처·출장 목적 글자에서 찾고, 그래도 없으면 확인 표에서 골라 주세요.',
      '2차·3차 출장 작업 내용과 특이사항은 작업 내용·작업 결과 뒤에 이어 붙입니다. 작성자·동행자는 메일 주소를 빼고 이름·직함만 씁니다.',
      'UTF-8·EUC-KR CSV 모두 읽습니다. 여러 달 파일은 하나씩 올리면 됩니다.'],
  },
  part_price_csv: {
    skippedLabel: '분류 제목·빈 파트넘버', title: '부품 단가 데이터 업로드', team: 'service', accept: '.csv', back: '#/prices/parts', backLabel: '부품별 비교', done: '#/prices/parts', doneLabel: '부품별 비교에서 확인',
    sub: '부품 단가 데이터 CSV를 올리면 분류·파트넘버·품목·적용모델·기준단가를 읽어 단가표에 저장합니다. 같은 파트넘버가 이미 있으면 새 내용으로 덮어씁니다(바뀐 칸 표시).',
    tips: ['회사 "부품 및 단가리스트" 엑셀의 [부품] 시트를 "CSV(쉼표로 분리)"로 저장해 그대로 올리면 됩니다 — 머리글 "구분(= 파트넘버)·품목·적요(= 적용모델)·기준단가".',
      '"01 현장서비스"처럼 한 칸만 있는 줄은 분류 제목으로 읽고, 그 아래 부품들의 분류로 씁니다. [대외비] 안내 줄은 건너뜁니다.',
      '"분류, 파트넘버, 품목, 적용모델, 기준단가" 머리글로 된 CSV도 됩니다(양식 내려받기). UTF-8·EUC-KR 모두 읽습니다.',
      '같은 파일에 같은 파트넘버가 여러 번 나오면 아래쪽 줄 기준입니다. 기준단가가 빈 칸이면 "미입력"으로 저장합니다.'],
  },
  company_price_csv: {
    skippedLabel: '빈 파트넘버·파트넘버 없는 품목(출장수리비 등)·단가 빈 줄', title: '출장지(판매처)별 단가 업로드', team: 'service', accept: '.csv,.xlsx', back: '#/prices/parts', backLabel: '부품별 비교', done: '#/prices/companies', doneLabel: '출장지별 비교에서 확인',
    sub: '출장지(업체)별 부품 단가 CSV나 수주 내역 CSV를 올리면 파트넘버·출장지·단가·적용 시작일을 읽어 저장합니다. 같은 부품·출장지·적용 시작일이 이미 있으면 새 단가로 덮어씁니다.',
    tips: ['수주 내역 CSV(부품단가데이터.csv처럼 판매처·수주일·제품정보-품명·제품정보-단가 칸이 있는 파일)는 그대로 올리면 됩니다 — 판매처 = 출장지, 수주일 = 적용 시작일, 품명 "MD-07-A-01 Main Board for NTI-04" = 파트넘버·품목·적용모델.',
      '또는 머리글 "파트넘버, 품목(선택), 출장지, 단가, 적용 시작일, 비고(선택)"로 된 CSV — 양식을 내려받아 쓰세요.',
      '단가표에 없는 파트넘버는 품목이 있으면 단가표에 새로 등록합니다(분류·기준단가는 비어 있으니 신규 부품 등록이나 부품별 비교에서 채우세요). 같은 파트넘버는 품명 표기가 달라도 같은 부품입니다.',
      '적용 시작일은 2026-03-10, 2026.3.10, 2026/03/10 모두 됩니다. 단가는 원 단위 정수(콤마 허용, 부가세 제외).'],
  },
  part_catalog_excel: {
    skippedLabel: '분류 제목·빈 파트넘버', title: '신규 부품 엑셀 업로드', team: 'service', accept: '.xlsx,.xls,.csv', back: '#/prices/parts', backLabel: '부품별 비교', done: '#/prices/parts', doneLabel: '부품별 비교에서 확인',
    sub: '엑셀로 여러 부품을 한 번에 등록합니다. 같은 파트넘버가 이미 있으면 새 내용으로 덮어씁니다(바뀐 칸 표시).',
    tips: ['머리글: 분류, 파트넘버, 품목, 적용모델, 기준단가 — 양식을 내려받아 쓰세요. 회사 "부품 및 단가리스트" 엑셀도 그대로 됩니다([부품] 시트만 읽음).',
      '같은 파일에 같은 파트넘버가 여러 번 나오면 아래쪽 줄 기준입니다.'],
  },
};

const ROW_STATES = [['all', '전체'], ['error', '오류'], ['save', '저장 예정'], ['update', '갱신'], ['skip', '건너뜀'], ['excluded', '제외']];
const hasErr = (r) => Object.keys(r.errors || {}).length > 0;
const rowState = (r) => (r.excluded ? 'excluded' : hasErr(r) ? 'error' : r.duplicate ? 'skip' : r.update ? 'update' : 'save');
const STATE_CHIP = {
  error: '<span class="status-chip critical">! 오류</span>', save: '<span class="status-chip done">+ 저장 예정</span>',
  update: '<span class="status-chip warning">↻ 갱신</span>', excluded: '<span class="badge">제외</span>',
};
const skipChip = (r) => `<span class="badge" title="${r.superseded ? '같은 파일 아래쪽에 같은 번호가 다시 나와 마지막 행을 씁니다' : '이미 저장된 값과 같습니다'}">${r.superseded ? '건너뜀(아래 행 사용)' : '건너뜀(이미 있음)'}</span>`;

export async function render(main, ctx) {
  const conf = UPLOADS[ctx.kind];
  main.innerHTML = `
    <div class="page-head"><div><h2>${conf.title}</h2><div class="sub">${conf.sub}</div></div>
      <div class="filters">${conf.back ? `<a class="btn" href="${conf.back}">← ${conf.backLabel}</a>` : ''}<a class="btn" href="#/${conf.team}/uploads">업로드 이력</a></div></div>
    <div id="tu-body"></div>`;
  mountUpload(main.querySelector('#tu-body'), ctx.kind);
}

// 업로드 → 확인 → 저장 화면을 body 안에 그린다. heading 을 주면 파일 선택 카드에 제목·설명을 붙인다 (다른 화면 위에 넣을 때)
//  batch 를 주면 이미 읽은 업로드의 확인 화면부터, onReset 을 주면 [다른 파일 올리기]를 그 함수가 맡는다 (생산 데이터 업로드)
export function mountUpload(body, kind, { heading = '', batch: initial = null, onReset = null } = {}) {
  const conf = UPLOADS[kind];
  let batch = initial;
  let filter = 'all';
  const edits = {}; // { rowId: { values: {...}, excluded } } — [다시 검사]·[저장] 때 보냄

  function drawPicker() {
    body.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        ${heading ? `<div class="card-head"><div class="ttl"><h3>${heading}</h3><span class="hint">${conf.sub}</span></div></div>` : ''}
        <label class="dropzone" id="tu-drop"><input type="file" id="tu-file" accept="${conf.accept}" hidden>
          <div style="font-size:15px;font-weight:600;margin-bottom:4px">파일을 여기에 끌어다 놓거나 클릭해서 선택</div>
          <div class="hint">${conf.accept} · 10MB 이하 · 올리면 바로 저장되지 않고 확인 화면이 나옵니다</div></label>
        <ul class="hint tips">${conf.tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>`;
    const drop = body.querySelector('#tu-drop');
    const input = body.querySelector('#tu-file');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); });
  }

  async function upload(file) {
    body.innerHTML = '<div class="card empty">파일을 읽는 중…</div>';
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      batch = await api('/api/uploads', { method: 'POST', body: { kind, file_name: file.name, file: btoa(bin) } });
      Object.keys(edits).forEach((k) => delete edits[k]);
      filter = 'all';
      drawReview();
    } catch (err) {
      drawPicker();
      body.insertAdjacentHTML('afterbegin', `<div class="notice err">${esc(err.message)}</div>`);
    }
  }

  const valueOf = (r, key) => edits[r.id]?.values?.[key] ?? r.values[key] ?? '';
  // 칸 입력: choices → 선택 목록, choices_by → 같은 행의 다른 칸 값에 따른 목록(예: 시·도 → 시·군), multiline → 여러 줄, suggestions → 추천 목록
  function cellInput(c, r, v) {
    const width = Math.min(260, Math.max(96, String(v).length * 8.5 + 30));
    let choices = c.choices;
    if (c.choices_by) choices = c.choices_map?.[valueOf(r, c.choices_by)] || [];
    if (choices) {
      if (c.choices_by && !choices.length) return '<span class="muted">없음</span>';
      return `<select class="input" data-k="${c.key}" style="width:${Math.max(110, width)}px"><option value="">선택</option>${choices.map((x) => `<option ${x === v ? 'selected' : ''}>${esc(x)}</option>`).join('')}${v && !choices.includes(v) ? `<option selected>${esc(v)}</option>` : ''}</select>`;
    }
    if (c.multiline) return `<textarea class="input" data-k="${c.key}" rows="${Math.min(6, Math.max(2, String(v).split('\n').length))}" style="width:240px">${esc(v)}</textarea>`;
    return `<input class="input" data-k="${c.key}" value="${esc(v)}" ${c.suggestions ? `list="dl-${c.key}"` : ''} style="width:${c.suggestions ? 260 : width}px">`;
  }
  function drawReview() {
    const s = batch.summary;
    const noted = (r) => Object.keys(r.fixes || {}).length + Object.keys(r.warnings || {}).length > 0;
    const match = (r, k) => (k === 'all' ? true : k === 'noted' ? noted(r) : rowState(r) === k);
    const rows = batch.rows.filter((r) => match(r, filter));
    const count = (k) => batch.rows.filter((r) => match(r, k)).length;
    const pending = Object.keys(edits).length;
    const done = batch.status !== 'extracted';
    body.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head">
          <div class="ttl"><h3>${esc(batch.file_name)}</h3><span class="hint">${esc(batch.kind_display)} · ${done ? (batch.status === 'saved' ? `저장 완료 ${batch.saved_count}건` : '취소됨') : '확인 대기'}</span></div>
          ${done ? '<button class="btn" id="tu-new">다른 파일 올리기</button>' : `<div class="filters">
            <button class="btn" id="tu-recheck" ${pending ? '' : 'disabled'}>고친 값 반영 · 다시 검사${pending ? ` (${pending})` : ''}</button>
            <button class="btn danger" id="tu-cancel">업로드 취소</button>
            <button class="btn primary" id="tu-save" ${s.to_save || pending ? '' : 'disabled'}>저장 (${s.to_save}건)</button></div>`}
        </div>
        <div class="kv-row">
          <span>추출 <b>${s.total}</b>행</span><span>저장 예정 <b>${s.to_save}</b>${batch.update_existing ? ` (그중 갱신 ${s.update_rows})` : ''}</span>
          <span class="${s.error_rows ? 'bad' : ''}">오류 <b>${s.error_rows}</b></span><span>건너뜀 <b>${s.duplicate_rows}</b>${s.superseded_rows ? ` (아래 행으로 대체 ${s.superseded_rows})` : ''}</span>
          <span>제외 <b>${s.excluded_rows}</b></span>${s.fixed_rows ? `<span class="warn-txt">자동 수정 <b>${s.fixed_rows}</b>행</span>` : ''}${s.warning_rows ? `<span class="warn-txt">확인 필요 <b>${s.warning_rows}</b>행</span>` : ''}${s.skipped_rows ? `<span class="muted">읽을 때 뺀 행(${conf.skippedLabel || '일련번호 없음'}) ${s.skipped_rows}</span>` : ''}
        </div>
        ${done ? (batch.status === 'saved' ? `<div class="notice" style="margin:14px 0 0">저장했습니다 — ${batch.saved_count}건. <a href="${conf.done || `#/${conf.team}`}">${conf.doneLabel || '대시보드에서 확인'} →</a></div>` : '') : s.error_rows
          ? '<div class="notice warn" style="margin:14px 0 0">오류가 있는 행을 고치거나 제외해야 저장할 수 있습니다. 칸을 고친 뒤 [고친 값 반영 · 다시 검사]를 누르세요.</div>' : ''}
        ${!done && (s.fixed_rows || s.warning_rows) ? `<div class="notice" style="margin:14px 0 0">오타로 보이는 값 ${s.fixed_rows}행은 자동으로 고쳤습니다(노란 칸에 원래 값 표시). 저장 전에 맞는지 확인해 주세요.${s.warning_rows ? ` 확인 필요 ${s.warning_rows}행은 고치지 않고 그대로 두었습니다.` : ''} 위쪽 [자동 수정·확인] 버튼으로 해당 행만 볼 수 있습니다.</div>` : ''}
      </div>
      <div class="card">
        <div class="seg" id="tu-filter" style="margin-bottom:12px">${[...ROW_STATES, ...(batch.rows.some(noted) ? [['noted', '자동 수정·확인']] : [])].map(([k, l]) => `<button type="button" data-f="${k}" class="${filter === k ? 'on' : ''}">${l} ${count(k)}</button>`).join('')}</div>
        ${!rows.length ? '<div class="empty">해당하는 행이 없습니다.</div>' : `
        ${batch.columns.filter((c) => c.suggestions).map((c) => `<datalist id="dl-${c.key}">${c.suggestions.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`).join('')}
        <div class="table-wrap" style="max-height:65vh"><table class="tbl edit review">
          <thead><tr><th>행</th><th>상태</th>${done ? '' : '<th class="c">제외</th>'}${batch.allow_duplicate_override && !done ? '<th class="c">중복 아님</th>' : ''}${batch.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => {
            const st = rowState(r);
            return `<tr data-id="${r.id}" class="st-${st}">
              <td class="muted">${esc(r.sheet || '')} ${r.row_no ?? ''}</td>
              <td>${st === 'skip' ? skipChip(r) : STATE_CHIP[st]}</td>
              ${done ? '' : `<td class="c"><input type="checkbox" data-ex ${(edits[r.id]?.excluded ?? r.excluded) ? 'checked' : ''}></td>`}
              ${batch.allow_duplicate_override && !done ? `<td class="c">${r.matches_existing || r.in_file_duplicate || r.allow_duplicate ? `<input type="checkbox" data-dup ${r.allow_duplicate ? 'checked' : ''} title="같은 곳에 실제로 두 번 간 경우">` : ''}</td>` : ''}
              ${batch.columns.map((c) => {
                const err = r.errors?.[c.key];
                const ch = r.changes?.[c.key];
                const v = valueOf(r, c.key);
                return `<td class="${err ? 'err' : ''} ${ch ? 'chg' : ''} ${r.fixes?.[c.key] || r.warnings?.[c.key] ? 'fixed' : ''}">
                  ${done || r.excluded ? `<span class="pre">${esc(v)}</span>` : cellInput(c, r, v)}
                  ${err ? `<div class="cell-err">${esc(err)}</div>` : ''}
                  ${ch ? `<div class="cell-chg">이전: ${esc(ch.old || '(빈 값)')}</div>` : ''}
                  ${r.fixes?.[c.key] ? `<div class="cell-fix">⚠ ${esc(r.fixes[c.key])}</div>` : ''}
                  ${r.warnings?.[c.key] ? `<div class="cell-fix">⚠ ${esc(r.warnings[c.key])}</div>` : ''}</td>`;
              }).join('')}
            </tr>`;
          }).join('')}</tbody></table></div>`}
      </div>`;

    body.querySelector('#tu-new')?.addEventListener('click', () => { if (onReset) { onReset(); return; } batch = null; drawPicker(); });
    body.querySelector('#tu-filter').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; drawReview(); } });
    const table = body.querySelector('.review');
    table?.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      const id = Number(e.target.closest('tr').dataset.id);
      ((edits[id] ||= {}).values ||= {})[k] = e.target.value;
      const btn = body.querySelector('#tu-recheck');
      btn.disabled = false;
      btn.textContent = `고친 값 반영 · 다시 검사 (${Object.keys(edits).length})`;
    });
    table?.addEventListener('change', (e) => {
      const id = Number(e.target.closest('tr')?.dataset.id);
      if ('ex' in e.target.dataset) { (edits[id] ||= {}).excluded = e.target.checked; recheck(); return; }
      if ('dup' in e.target.dataset) { (edits[id] ||= {}).allow_duplicate = e.target.checked; recheck(); return; }
      // 선택 목록은 바로 반영 (시·도를 바꾸면 시·군 목록이 바뀌어야 하므로 다시 검사)
      if (e.target.tagName === 'SELECT' && e.target.dataset.k) { ((edits[id] ||= {}).values ||= {})[e.target.dataset.k] = e.target.value; recheck(); }
    });
    body.querySelector('#tu-recheck')?.addEventListener('click', recheck);
    body.querySelector('#tu-cancel')?.addEventListener('click', async () => {
      if (!(await confirmBox('이 업로드를 취소할까요? 아무것도 저장되지 않습니다.', '업로드 취소'))) return;
      batch = await api(`/api/uploads/${batch.id}/cancel`, { method: 'POST' });
      toast('업로드를 취소했습니다.');
      drawReview();
    });
    body.querySelector('#tu-save')?.addEventListener('click', save);
  }

  async function sendEdits() {
    const rows = Object.entries(edits).map(([id, e]) => ({ id: Number(id), ...e }));
    if (!rows.length) return;
    batch = await api(`/api/uploads/${batch.id}`, { method: 'PATCH', body: { rows } });
    Object.keys(edits).forEach((k) => delete edits[k]);
  }
  async function recheck() {
    try { await sendEdits(); drawReview(); } catch (err) { toast(err.message, true); }
  }
  async function save() {
    try {
      await sendEdits();
      if (batch.summary.error_rows) { drawReview(); toast(`오류가 있는 행이 ${batch.summary.error_rows}개 있습니다.`, true); return; }
      batch = await api(`/api/uploads/${batch.id}/confirm`, { method: 'POST' });
      toast(`${batch.saved_count}건을 저장했습니다.`);
      drawReview();
    } catch (err) {
      toast(err.message, true);
      try { if (err.status === 400) await recheck(); } catch { /* 무시 */ }
    }
  }

  if (batch) drawReview(); else drawPicker();
}

// ---------------- 생산 데이터 업로드 (제조내역 + 수주내역을 엑셀 한 파일로) ----------------
//  같은 파일을 두 규칙으로 읽는다: "일련번호" 제목이 있는 시트 = 제조내역, "판매번호·품명·수량" 제목이 있는 시트 = 수주내역
//  찾은 쪽마다 확인 표가 하나씩 나오고 각각 저장한다 (둘 다 같은 번호가 있으면 덮어씀). 수주서 PDF는 아래 [수주서 PDF]에서 지금처럼
const PROD_PARTS = [['sales_order_excel', '수주내역'], ['manufacturing_excel', '제조내역']];
const PROD_TABS = [['excel', '엑셀 (수주내역 · 제조내역)'], ['pdf', '수주서 PDF']];
export const productionUpload = {
  async render(main, ctx) {
    let tab = ctx.tab === 'pdf' ? 'pdf' : 'excel';
    main.innerHTML = `
      <div class="page-head"><div><h2>생산 데이터 업로드</h2><div class="sub">엑셀 한 파일을 올리면 수주내역과 제조내역을 시트 제목으로 구분해 각각 확인·저장합니다. 같은 데이터가 이미 있으면 새 값으로 덮어씁니다.</div></div>
        <div class="filters"><a class="btn" href="#/production/uploads">업로드 이력</a></div></div>
      <div class="seg" id="pu-tab" style="margin-bottom:12px">${PROD_TABS.map(([k, l]) => `<button type="button" data-t="${k}">${l}</button>`).join('')}</div>
      <div id="pu-body"></div>`;
    const body = main.querySelector('#pu-body');
    const tabs = main.querySelector('#pu-tab');
    const show = () => {
      tabs.querySelectorAll('[data-t]').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
      if (tab === 'pdf') mountUpload(body, 'sales_order_pdf', { heading: '수주서 PDF 업로드' });
      else picker();
    };
    tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-t]'); if (b && b.dataset.t !== tab) { tab = b.dataset.t; show(); } });

    function picker(message = '') {
      body.innerHTML = `${message}
        <div class="card" style="margin-bottom:16px">
          <label class="dropzone" id="pu-drop"><input type="file" id="pu-file" accept=".xlsx" hidden>
            <div style="font-size:15px;font-weight:600;margin-bottom:4px">생산 데이터 엑셀을 여기에 끌어다 놓거나 클릭해서 선택</div>
            <div class="hint">.xlsx · 10MB 이하 · 올리면 바로 저장되지 않고 수주내역·제조내역 확인 화면이 나옵니다</div></label>
          <ul class="hint tips">${[
            '시트마다 제목 칸을 보고 구분합니다: "일련번호" 제목이 있는 시트 = 제조내역, "판매번호·품명(제품정보-품명)·수량" 제목이 있는 시트 = 수주내역.',
            '수주내역 시트가 없으면 제조내역 행을 판매번호(#26024)별로 묶어 수주내역을 만듭니다 — 제품 = 모델명·전원·rpm·부시 가공별 대수, 판매처·사업명·납기일 = 그 판매번호의 첫 행, 산업 분야 = 기타.',
            '제조내역: 같은 일련번호가 이미 있으면 새 값으로 덮어씁니다. 출고일 칸이 비어 있으면 납기 캘린더에서 체크·입력한 출고일은 지우지 않습니다. 날짜 칸의 날짜가 아닌 글자(예: 완제품입고)는 비고로 옮깁니다.',
            '수주내역: 같은 판매번호가 이미 있으면 주문 정보와 제품(같은 순번)을 새 값으로 덮어씁니다. 한 수주의 둘째 제품 줄부터 비어 있는 주문 칸은 위 줄(같은 *ID) 값을 씁니다.',
            '두 확인 표는 따로 저장합니다. 오류가 있는 행은 고치거나 제외해야 저장됩니다.',
          ].map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        </div>`;
      const drop = body.querySelector('#pu-drop');
      const input = body.querySelector('#pu-file');
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
      input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); });
    }

    async function upload(file) {
      if (!/\.xlsx$/i.test(file.name)) { picker('<div class="notice err">.xlsx 파일만 올릴 수 있습니다.</div>'); return; }
      body.innerHTML = '<div class="card empty">파일을 읽는 중…</div>';
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const b64 = btoa(bin);
      const results = await Promise.allSettled(PROD_PARTS.map(([kind]) => api('/api/uploads', { method: 'POST', body: { kind, file_name: file.name, file: b64 } })));
      const found = results.map((r, i) => [PROD_PARTS[i], r]).filter(([, r]) => r.status === 'fulfilled');
      if (!found.length) {
        picker(`<div class="notice err">수주내역·제조내역을 읽지 못했습니다.<br>${results.map((r, i) => `${PROD_PARTS[i][1]}: ${esc(r.reason?.message || '')}`).join('<br>')}</div>`);
        return;
      }
      body.innerHTML = `
        <div class="notice" style="margin-bottom:16px"><b>${esc(file.name)}</b> — ${results.map((r, i) => `${PROD_PARTS[i][1]} ${r.status === 'fulfilled' ? `<b>${r.value.summary.total}행</b>` : '<span class="muted">없음</span>'}`).join(' · ')}
          <button class="btn sm" id="pu-again" style="margin-left:8px">다른 파일 올리기</button>
          ${results.filter((r) => r.status === 'rejected').map((r) => `<div class="hint" style="margin-top:6px">${esc(r.reason?.message || '')}</div>`).join('')}</div>
        ${found.map(([[kind, label]]) => `<h3 style="margin:18px 0 10px">${label}</h3><div data-part="${kind}"></div>`).join('')}`;
      body.querySelector('#pu-again').addEventListener('click', () => picker());
      for (const [[kind], r] of found) mountUpload(body.querySelector(`[data-part="${kind}"]`), kind, { batch: r.value, onReset: () => picker() });
    }
    show();
  },
};

// ---------------- 업로드 이력 ----------------
const TEAM_NAMES = { mgmt: '경영지원팀', production: '생산팀', service: '서비스팀', prices: '단가' };
// 이력 화면 오른쪽 위: 그 팀의 업로드 화면으로 가는 버튼
const UPLOAD_LINKS = {
  mgmt: [['#/upload', '경영 데이터 업로드']],
  production: [['#/production/upload', '생산 데이터 업로드']],
  service: [['#/service/upload', '서비스 데이터 업로드']],
  prices: [['#/prices/upload', '부품 단가 데이터 업로드'], ['#/prices/new', '신규 부품 등록']],
};
export const history = {
  async render(main, ctx) {
    const d = await api(`/api/uploads?team=${ctx.team}`);
    const chip = { saved: 'done', extracted: 'warning', saving: 'warning', cancelled: 'pending' };
    const icon = { saved: '✓', extracted: '…', saving: '…', cancelled: '✕' };
    const hasNote = d.results.some((b) => b.note);
    main.innerHTML = `
      <div class="page-head"><div><h2>업로드 이력</h2><div class="sub">${TEAM_NAMES[ctx.team]} 파일 업로드 기록 최근 ${d.limit}건 · 원본 파일은 보관하지 않아 내려받기는 없습니다</div></div>
        <div class="filters">${(UPLOAD_LINKS[ctx.team] || []).map(([href, label]) => `<a class="btn" href="${href}">${label}</a>`).join('')}</div></div>
      <div class="card">${!d.results.length ? '<div class="empty">업로드 기록이 없습니다.</div>' : `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>올린 시각</th><th>올린 사람</th><th>종류</th><th>파일 이름</th><th>상태</th>${hasNote ? '<th>내용</th>' : ''}<th class="r">추출 행</th><th class="r">저장</th></tr></thead>
          <tbody>${d.results.map((b) => `<tr><td>${esc(String(b.created_at).slice(0, 16))}</td><td>${esc(b.uploaded_by)}</td><td>${esc(b.kind_display)}</td>
            <td class="wrap">${esc(b.file_name)}</td><td><span class="status-chip ${chip[b.status] || 'pending'}">${icon[b.status] || ''} ${esc(b.status_display)}</span></td>
            ${hasNote ? `<td class="wrap muted">${esc(b.note)}</td>` : ''}<td class="r">${b.row_count}</td><td class="r">${b.status === 'saved' ? `${b.saved_count}건` : '-'}</td></tr>`).join('')}</tbody>
        </table></div>`}</div>`;
  },
};
