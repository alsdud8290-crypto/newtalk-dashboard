// 제품 단가·원가 — 경영지원팀(대표 포함)·관리자만 (메뉴·라우트 + 서버 API에서 모두 확인). ITB2026에서 옮겨 옴
//  1) 가격 계산 기준값 + 기준값 바꾸기(새 적용일로 저장) + 변경 기록
//  2) 가격 시뮬레이션: 환율·마진·옵션·원재료 기준을 바꿔 다시 계산 (저장하지 않음)
//  3) 제품 단가표: 모델별 원재료 → 판매가 → 특별할인가 (줄을 누르면 계산 과정)
//  4) 커미션·이익 + 판매금액을 넣어 계산, 5) 열람 기록
import { api, esc, toast, today } from '../core.js';

const wonText = (v) => (v === null || v === undefined ? '-' : `${Math.round(v).toLocaleString('ko-KR')}원`);
const num = (v) => Number(v).toLocaleString('ko-KR');
const signedChange = (v) => (v > 0 ? `▲ ${num(v)}` : v < 0 ? `▼ ${num(-v)}` : '–');

export async function render(main, ctx) {
  const editable = ctx.canEdit('mgmt');
  const sim = { exchange_rate: '', margin: '', option: '', base: 'assembly' };
  let data = null;
  let history = null;
  let series = '';
  let opened = '';
  let timer;

  main.innerHTML = `
    <div class="page-head">
      <div><h2>제품 단가·원가</h2><div class="sub">경영지원팀·대표·관리자만 볼 수 있는 대외비 자료입니다. 화면을 캡처하거나 외부로 보내지 마세요.</div></div>
    </div>
    <div id="pr-body"><div class="empty">불러오는 중…</div></div>`;
  const body = main.querySelector('#pr-body');

  async function load() {
    const qs = new URLSearchParams(Object.entries(sim).filter(([, v]) => v !== '')).toString();
    data = await api(`/api/pricing/products${qs ? `?${qs}` : ''}`);
  }
  async function loadRecords() {
    const [h, l] = await Promise.all([api('/api/pricing/settings'), api('/api/pricing/access-log')]);
    history = h;
    return l.logs;
  }

  function settingCard() {
    const s = data.setting;
    return `
      <div class="card" style="margin-bottom:16px" id="pr-setting">
        <div class="card-head"><div class="ttl"><h3>가격 계산 기준값</h3><span class="hint">${esc(s.effective_date)} 적용</span></div>
          ${editable ? '<button class="btn sm" id="pr-edit">기준값 바꾸기</button>' : ''}</div>
        <div class="kv-row">
          <span>환율 <b>${num(s.exchange_rate)}원/USD</b></span>
          <span>통관 배수 <b>× ${s.customs_factor}</b></span>
          <span>판관비 <b>${s.sga_rate}%</b></span>
          <span>마진 <b>÷ ${s.margin}</b></span>
          <span>특별할인 <b>${s.special_discount_rate}%</b></span>
          <span>커미션 <b>${s.commission_rate}%</b> <span class="muted">(${num(s.commission_unit)}원 미만 버림)</span></span>
        </div>
        <div id="pr-form-slot"></div>
        ${history?.settings.length ? `<details class="hint" style="margin-top:12px"><summary>기준값 변경 기록 ${history.settings.length}건</summary>
          <div class="table-wrap" style="margin-top:6px"><table class="tbl">
            <thead><tr><th>적용일</th><th>바뀐 값 (이전 → 새 값)</th><th>사유</th><th>입력</th></tr></thead>
            <tbody>${history.settings.map((h) => `<tr>
              <td>${esc(h.effective_date)}</td>
              <td class="wrap">${h.changes.length ? h.changes.map((c) => `${esc(c.label)}: ${num(c.old)} → <b>${num(c.new)}</b>`).join('<br>') : '<span class="muted">처음 기준값</span>'}</td>
              <td class="wrap">${esc(h.note || '-')}</td><td class="muted">${esc(h.created_by)} · ${esc(String(h.created_at).slice(0, 16))}</td></tr>`).join('')}</tbody>
          </table></div></details>` : ''}
      </div>`;
  }

  function simCard() {
    const r = data.simulation;
    return `
      <div class="card ${r.active ? 'sim-on' : ''}" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>가격 시뮬레이션</h3>
          ${r.active ? '<span class="status-chip warning">시뮬레이션 중 — 저장되지 않음</span>' : '<span class="hint">값을 바꾸면 아래 단가표가 바로 다시 계산됩니다</span>'}</div>
          ${r.active ? '<button class="btn sm" id="pr-reset">기준값으로 되돌리기</button>' : ''}</div>
        <div class="form-grid sim-grid">
          <div class="field"><label>환율 (원/USD)</label><input class="input" id="sim-rate" type="number" min="1" step="1" placeholder="${data.setting.exchange_rate}" value="${esc(sim.exchange_rate)}"></div>
          <div class="field"><label>마진 값 (나누는 수)</label><select class="input" id="sim-margin">
            <option value="">기준 ${data.setting.margin}</option>${data.margin_choices.map((m) => `<option value="${m}" ${String(m) === sim.margin ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
          <div class="field"><label>옵션</label><select class="input" id="sim-option">
            <option value="">옵션 없음</option>${data.options.map((o) => `<option value="${esc(o.name)}" ${o.name === sim.option ? 'selected' : ''}>${esc(o.name)} (+${o.price_usd} USD)</option>`).join('')}</select></div>
          <div class="field"><label>원재료 기준</label><div class="seg" id="sim-base">
            ${[['assembly', 'Assembly'], ['complete', 'Complete']].map(([v, l]) => `<button type="button" data-v="${v}" class="${sim.base === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        </div>
        <p class="hint" style="margin:10px 0 0">옵션은 USD로 원재료에 더한다고 가정했습니다(확인 필요). 시뮬레이션 중에는 단가표에 "기준 대비" 열이 나옵니다.</p>
      </div>`;
  }

  function explain(m) {
    const s = data.setting;
    const r = data.simulation;
    const option = data.options.find((o) => o.name === r.option);
    return [
      ['원화 환산', `${num(m.usd)} USD × 환율 ${num(r.exchange_rate)}`, m.steps.krw],
      ['옵션 반영', option ? `+ ${option.name} ${option.price_usd} USD × 환율` : '옵션 없음', m.steps.with_option],
      ['통관', `× ${s.customs_factor}`, m.steps.customs],
      ['원가(판관비 반영)', `× (1 + ${s.sga_rate}%)`, m.steps.cost],
      ['마진 반영', `÷ ${r.margin}`, m.steps.margin_price],
      ['판매가', `${num(s.price_round_unit)}원 단위 올림`, m.steps.sale_price],
      ['특별할인가', `× (1 − ${s.special_discount_rate}%), ${num(s.price_round_unit)}원 단위 올림`, m.steps.special_price],
    ];
  }

  function tableCard() {
    const active = data.simulation.active;
    const models = data.models.filter((m) => !series || m.series === series);
    const cols = active ? 9 : 8;
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>제품 단가표</h3><span class="hint">${models.length}개 모델 · 줄을 누르면 계산 과정</span></div>
          <div class="seg" id="pr-series">${['', ...data.series].map((s) => `<button type="button" data-s="${esc(s)}" class="${series === s ? 'on' : ''}">${esc(s || '전체')}</button>`).join('')}</div></div>
        <div class="table-wrap"><table class="tbl click">
          <thead><tr><th>모델</th><th class="r">원재료(USD)</th><th class="r">원화(옵션 포함)</th><th class="r">통관</th><th class="r">원가</th><th class="r">마진 반영</th><th class="r">판매가</th><th class="r">특별할인가</th>${active ? '<th class="r">기준 대비</th>' : ''}</tr></thead>
          <tbody>${models.map((m) => `
            <tr data-m="${esc(m.model_name)}" class="${opened === m.model_name ? 'sel' : ''}">
              <td><b>${esc(m.model_name)}</b></td>
              ${m.steps ? `
                <td class="r num">${num(m.usd)}</td><td class="r num">${wonText(m.steps.with_option)}</td><td class="r num">${wonText(m.steps.customs)}</td>
                <td class="r num">${wonText(m.steps.cost)}</td><td class="r num">${wonText(m.steps.margin_price)}</td>
                <td class="r num"><b>${wonText(m.steps.sale_price)}</b></td><td class="r num">${wonText(m.steps.special_price)}</td>
                ${active ? `<td class="r num ${m.change ? (m.change > 0 ? 'up' : 'down') : 'muted'}">${signedChange(m.change)}</td>` : ''}`
              : `<td colspan="${cols - 1}" class="muted">Complete 원재료 가격이 없어 계산할 수 없습니다.</td>`}
            </tr>
            ${opened === m.model_name && m.steps ? `<tr class="detail-row"><td colspan="${cols}"><ol class="steps-list">
              ${explain(m).map(([l, how, v]) => `<li>${esc(l)}: <span class="muted">${esc(how)}</span> = <b>${wonText(v)}</b></li>`).join('')}</ol></td></tr>` : ''}`).join('')}
          </tbody></table></div>
        <p class="hint" style="margin:10px 0 0">원가 = 통관 후 금액에 판관비를 더한 값, 마진 반영 = 원가 ÷ 마진 값. 중간 금액은 원 단위 반올림으로 보여 주고, 판매가·특별할인가는 계산표와 같이 천원 단위로 올립니다.</p>
      </div>`;
  }

  function commissionCard() {
    const s = data.setting;
    return `
      <div class="card" style="margin-bottom:16px">
        <div class="card-head"><div class="ttl"><h3>커미션·이익</h3><span class="hint">현재 기준값 · 판매금액이 있는 모델</span></div></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>모델</th><th class="r">판매금액</th><th class="r">원가(마진 반영)</th><th class="r">이익</th><th class="r">커미션</th><th class="r">커미션 차감 이익</th><th class="r">마진율 <span class="badge">제안</span></th></tr></thead>
          <tbody>${data.commissions.map((c) => `<tr><td><b>${esc(c.model_name)}</b></td>
            <td class="r num">${wonText(c.sale_amount)}</td><td class="r num">${wonText(c.supply_price)}</td><td class="r num">${wonText(c.profit)}</td>
            <td class="r num">${wonText(c.commission)}</td><td class="r num"><b>${wonText(c.net_profit)}</b></td><td class="r num">${c.margin_rate}%</td></tr>`).join('')
            || '<tr><td colspan="7" class="muted">판매금액이 있는 모델이 없습니다.</td></tr>'}</tbody></table></div>
        <form id="pr-calc" class="filters" style="margin-top:14px">
          <select class="input" name="model" required><option value="">모델 선택</option>${data.models.map((m) => `<option>${esc(m.model_name)}</option>`).join('')}</select>
          <input class="input" name="sale_amount" type="number" min="1" step="1" placeholder="판매금액(원)" required style="width:170px">
          <button class="btn primary">계산</button>
        </form>
        <div id="pr-calc-out"></div>
        <p class="hint" style="margin:10px 0 0">이익 = 판매금액 − 원가(마진 반영), 커미션 = 판매금액 × ${s.commission_rate}%(${num(s.commission_unit)}원 미만 버림),
          마진율 = 커미션 차감 이익 ÷ 판매금액 (계산표에 빈칸이라 임시 정의 — 확인 필요).</p>
      </div>`;
  }

  function logCard(logs) {
    return `
      <div class="card">
        <div class="card-head"><div class="ttl"><h3>열람 기록</h3><span class="hint">이 화면을 누가 언제 봤는지 (같은 사람은 10분에 한 번, 최근 100건)</span></div></div>
        ${!logs.length ? '<div class="empty">기록이 없습니다.</div>' : `<div class="table-wrap" style="max-height:280px"><table class="tbl">
          <thead><tr><th>열람 일시</th><th>사용자</th><th>부서</th></tr></thead>
          <tbody>${logs.map((l) => `<tr><td>${esc(String(l.viewed_at).slice(0, 16))}</td><td>${esc(l.user)} <span class="muted">(${esc(l.username)})</span></td><td>${esc(l.role)}</td></tr>`).join('')}</tbody></table></div>`}
      </div>`;
  }

  let logs = [];
  function draw() {
    body.innerHTML = settingCard() + simCard() + tableCard() + commissionCard() + logCard(logs);
    const $ = (s) => body.querySelector(s);
    $('#pr-edit')?.addEventListener('click', openSettingForm);
    $('#pr-reset')?.addEventListener('click', () => { Object.assign(sim, { exchange_rate: '', margin: '', option: '', base: 'assembly' }); refresh(); });
    $('#sim-rate').addEventListener('input', (e) => { sim.exchange_rate = e.target.value; clearTimeout(timer); timer = setTimeout(refresh, 400); });
    $('#sim-margin').addEventListener('change', (e) => { sim.margin = e.target.value; refresh(); });
    $('#sim-option').addEventListener('change', (e) => { sim.option = e.target.value; refresh(); });
    $('#sim-base').addEventListener('click', (e) => { const b = e.target.closest('[data-v]'); if (b) { sim.base = b.dataset.v; refresh(); } });
    $('#pr-series').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { series = b.dataset.s; draw(); } });
    body.querySelector('.tbl.click').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-m]');
      if (tr) { opened = opened === tr.dataset.m ? '' : tr.dataset.m; draw(); }
    });
    $('#pr-calc').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try {
        const r = await api(`/api/pricing/commission?model=${encodeURIComponent(f.model)}&sale_amount=${encodeURIComponent(f.sale_amount)}`);
        $('#pr-calc-out').innerHTML = `<div class="kv-row calc-out">
          <span>이익 <b>${wonText(r.profit)}</b></span><span>커미션 <b>${wonText(r.commission)}</b></span>
          <span>커미션 차감 이익 <b>${wonText(r.net_profit)}</b></span><span>마진율 <b>${r.margin_rate}%</b></span></div>`;
      } catch (err) { toast(err.message, true); }
    });
  }

  // 환율 입력 중에는 칸이 다시 그려져도 커서가 유지되도록 포커스 복원
  async function refresh() {
    const focused = document.activeElement?.id;
    try {
      await load();
    } catch (err) { toast(err.message, true); return; }
    draw();
    if (focused) {
      const el = body.querySelector(`#${focused}`);
      if (el) { el.focus(); if (el.type === 'number') { const v = el.value; el.value = ''; el.value = v; } }
    }
  }

  function openSettingForm() {
    const s = data.setting;
    body.querySelector('#pr-form-slot').innerHTML = `
      <form id="pr-setting-form" class="setting-form">
        <div class="form-grid six">
          ${history.fields.map((f) => `<div class="field"><label>${esc(f.label)}</label><input class="input" name="${f.key}" type="number" step="any" required value="${s[f.key]}"></div>`).join('')}
          <div class="field"><label>적용일</label><input class="input" type="date" name="effective_date" required min="${esc(s.effective_date)}" max="${today()}" value="${today()}"></div>
          <div class="field" style="grid-column:span 2"><label>변경 사유</label><input class="input" name="note" maxlength="200" placeholder="예: 11월 환율 반영"></div>
        </div>
        <div class="filters" style="margin-top:10px">
          <button class="btn primary sm">저장</button><button type="button" class="btn sm" id="pr-cancel">취소</button>
          <span class="hint">저장하면 그 적용일부터 모든 계산에 새 값이 쓰입니다. 같은 적용일이 이미 있으면 그 값을 고칩니다.</span>
        </div>
      </form>`;
    body.querySelector('#pr-cancel').addEventListener('click', () => { body.querySelector('#pr-form-slot').innerHTML = ''; });
    body.querySelector('#pr-setting-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        history = await api('/api/pricing/settings', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        toast('기준값을 저장했습니다.');
        await load();
        draw();
      } catch (err) { toast(err.message, true); }
    });
  }

  await load();
  logs = await loadRecords();
  draw();
  return () => clearTimeout(timer);
}
