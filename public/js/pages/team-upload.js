// 팀 업로드 화면 공통 (ITB2026 업로드 확인 화면을 옮겨 옴): 파일 선택 → 추출 → 확인·수정 → 저장
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
  let batch = null;
  let filter = 'all';
  const edits = {}; // { rowId: { values: {...}, excluded } } — [다시 검사]·[저장] 때 보냄

  main.innerHTML = `
    <div class="page-head"><div><h2>${conf.title}</h2><div class="sub">${conf.sub}</div></div>
      <div class="filters"><a class="btn" href="#/${conf.team}/uploads">업로드 이력</a></div></div>
    <div id="tu-body"></div>`;
  const body = main.querySelector('#tu-body');

  function drawPicker() {
    body.innerHTML = `
      <div class="card" style="margin-bottom:16px">
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
      batch = await api('/api/uploads', { method: 'POST', body: { kind: ctx.kind, file_name: file.name, file: btoa(bin) } });
      Object.keys(edits).forEach((k) => delete edits[k]);
      filter = 'all';
      drawReview();
    } catch (err) {
      drawPicker();
      body.insertAdjacentHTML('afterbegin', `<div class="notice err">${esc(err.message)}</div>`);
    }
  }

  const valueOf = (r, key) => edits[r.id]?.values?.[key] ?? r.values[key] ?? '';
  function drawReview() {
    const s = batch.summary;
    const rows = batch.rows.filter((r) => filter === 'all' || rowState(r) === filter);
    const count = (k) => (k === 'all' ? batch.rows.length : batch.rows.filter((r) => rowState(r) === k).length);
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
          <span>제외 <b>${s.excluded_rows}</b></span>${s.skipped_rows ? `<span class="muted">읽을 때 뺀 행(일련번호 없음) ${s.skipped_rows}</span>` : ''}
        </div>
        ${done ? (batch.status === 'saved' ? `<div class="notice" style="margin:14px 0 0">저장했습니다 — ${batch.saved_count}건. <a href="#/${conf.team}">대시보드에서 확인 →</a></div>` : '') : s.error_rows
          ? '<div class="notice warn" style="margin:14px 0 0">오류가 있는 행을 고치거나 제외해야 저장할 수 있습니다. 칸을 고친 뒤 [고친 값 반영 · 다시 검사]를 누르세요.</div>' : ''}
      </div>
      <div class="card">
        <div class="seg" id="tu-filter" style="margin-bottom:12px">${ROW_STATES.map(([k, l]) => `<button type="button" data-f="${k}" class="${filter === k ? 'on' : ''}">${l} ${count(k)}</button>`).join('')}</div>
        ${!rows.length ? '<div class="empty">해당하는 행이 없습니다.</div>' : `
        <div class="table-wrap" style="max-height:65vh"><table class="tbl edit review">
          <thead><tr><th>행</th><th>상태</th>${done ? '' : '<th class="c">제외</th>'}${batch.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => {
            const st = rowState(r);
            return `<tr data-id="${r.id}" class="st-${st}">
              <td class="muted">${esc(r.sheet || '')} ${r.row_no ?? ''}</td>
              <td>${st === 'skip' ? skipChip(r) : STATE_CHIP[st]}</td>
              ${done ? '' : `<td class="c"><input type="checkbox" data-ex ${(edits[r.id]?.excluded ?? r.excluded) ? 'checked' : ''}></td>`}
              ${batch.columns.map((c) => {
                const err = r.errors?.[c.key];
                const ch = r.changes?.[c.key];
                const v = valueOf(r, c.key);
                return `<td class="${err ? 'err' : ''} ${ch ? 'chg' : ''}">
                  ${done || r.excluded ? `<span>${esc(v)}</span>` : `<input class="input" data-k="${c.key}" value="${esc(v)}" style="width:${Math.min(260, Math.max(96, String(v).length * 8.5 + 30))}px">`}
                  ${err ? `<div class="cell-err">${esc(err)}</div>` : ''}
                  ${ch ? `<div class="cell-chg">이전: ${esc(ch.old || '(빈 값)')}</div>` : ''}</td>`;
              }).join('')}
            </tr>`;
          }).join('')}</tbody></table></div>`}
      </div>`;

    body.querySelector('#tu-new')?.addEventListener('click', () => { batch = null; drawPicker(); });
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
      if (!('ex' in e.target.dataset)) return;
      const id = Number(e.target.closest('tr').dataset.id);
      (edits[id] ||= {}).excluded = e.target.checked;
      recheck();
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

  drawPicker();
}

// ---------------- 업로드 이력 ----------------
export const history = {
  async render(main, ctx) {
    const d = await api(`/api/uploads?team=${ctx.team}`);
    const chip = { saved: 'done', extracted: 'warning', saving: 'warning', cancelled: 'pending' };
    const icon = { saved: '✓', extracted: '…', saving: '…', cancelled: '✕' };
    main.innerHTML = `
      <div class="page-head"><div><h2>업로드 이력</h2><div class="sub">${ctx.team === 'production' ? '생산팀' : '서비스팀'} 파일 업로드 기록 최근 ${d.limit}건 · 원본 파일은 보관하지 않아 내려받기는 없습니다</div></div></div>
      <div class="card">${!d.results.length ? '<div class="empty">업로드 기록이 없습니다.</div>' : `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>올린 시각</th><th>올린 사람</th><th>종류</th><th>파일 이름</th><th>상태</th><th class="r">추출 행</th><th class="r">저장</th></tr></thead>
          <tbody>${d.results.map((b) => `<tr><td>${esc(String(b.created_at).slice(0, 16))}</td><td>${esc(b.uploaded_by)}</td><td>${esc(b.kind_display)}</td>
            <td class="wrap">${esc(b.file_name)}</td><td><span class="status-chip ${chip[b.status] || 'pending'}">${icon[b.status] || ''} ${esc(b.status_display)}</span></td>
            <td class="r">${b.row_count}</td><td class="r">${b.status === 'saved' ? `${b.saved_count}건` : '-'}</td></tr>`).join('')}</tbody>
        </table></div>`}</div>`;
  },
};
