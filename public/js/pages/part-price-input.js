// 단가 직접 입력 (ITB2026 서비스팀 화면을 옮겨 옴)
// 파트넘버(단가표 부품)를 검색해 고르고 출장지(업체)·단가·적용 시작일을 입력한다.
// 같은 부품이라도 업체마다 따로 쌓이고, 교체부품 단가 화면에서 뉴토크 기준값·평균·최저·최고와 비교된다.
import { api, esc, toast, confirmBox, today, comma, parseMoney, bindMoneyInputs } from '../core.js';

const wonText = (v) => (v === null || v === undefined ? '-' : `${Number(v).toLocaleString('ko-KR')}원`);
// 파트넘버를 하이픈 없이 쳐도 후보가 보이도록 (예: 0501 → XX-05-A-01)
const norm = (t) => String(t || '').replace(/[\s-]/g, '').toUpperCase();

export async function render(main) {
  const choices = await api('/api/parts/catalog/choices');
  let selected = null;

  main.innerHTML = `
    <div class="page-head">
      <div><h2>단가 직접 입력</h2><div class="sub">파트넘버를 검색해 고른 뒤 출장지(업체)와 단가를 입력하세요. 같은 업체의 단가가 바뀌면 새 적용 시작일로 한 줄을 더 입력합니다.</div></div>
      <div class="filters"><a class="btn" href="#/prices/parts">← 부품별 비교</a></div>
    </div>
    <div class="card" style="max-width:900px;margin-bottom:16px">
      ${choices.items.length ? '' : '<div class="notice err">단가표가 없습니다. 관리자가 단가표를 먼저 넣어야 합니다.</div>'}
      <form id="pi-form" class="form-grid" autocomplete="off">
        <div class="field full" style="position:relative">
          <label>파트넘버 *</label>
          <input class="input" name="part" placeholder="파트넘버(예: 05-A-01) 또는 품명을 입력해 목록에서 고르세요">
          <div class="pick-list" id="pi-cands" hidden></div>
        </div>
        <div class="field"><label>출장지(업체) *</label><input class="input" name="quote_company" list="pi-companies" required>
          <datalist id="pi-companies">${choices.companies.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="field"><label>단가 (원, 부가세 제외) *</label><input class="input money" name="unit_price" required></div>
        <div class="field"><label>적용 시작일 *</label><input class="input" type="date" name="effective_date" value="${today()}" required></div>
        <div class="field full"><label>비고 (단가가 달라진 이유 등, 선택)</label><input class="input" name="quote_note"></div>
        <div class="field full"><button class="btn primary">저장</button></div>
      </form>
    </div>
    <div id="pi-detail"></div>`;

  const form = main.querySelector('#pi-form');
  const partInput = form.part;
  const cands = main.querySelector('#pi-cands');
  bindMoneyInputs(form);

  function showCandidates() {
    const q = norm(partInput.value);
    selected = choices.items.find((i) => i.label === partInput.value) || null;
    const list = !q || selected ? [] : choices.items.filter((i) => norm(i.part_no).includes(q) || norm(i.part_no).replace(/\D/g, '').includes(q) || norm(i.name).includes(q)).slice(0, 12);
    cands.hidden = !list.length;
    cands.innerHTML = list.map((c) => `<button type="button" data-id="${c.id}"><b>${esc(c.part_no)}</b> ${esc(c.name)} <span class="muted">${esc(c.applies_to)}</span></button>`).join('');
  }
  partInput.addEventListener('input', () => { showCandidates(); if (!selected) drawDetail(null); });
  partInput.addEventListener('focus', showCandidates);
  document.addEventListener('click', (e) => { if (!e.target.closest('.field')) cands.hidden = true; });
  cands.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    selected = choices.items.find((i) => i.id === Number(b.dataset.id));
    partInput.value = selected.label;
    cands.hidden = true;
    await loadDetail();
  });

  async function loadDetail() { drawDetail(selected ? await api(`/api/parts/catalog/${selected.id}`) : null); }

  function drawDetail(d) {
    const el = main.querySelector('#pi-detail');
    if (!d) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="card" style="max-width:900px">
        <div class="card-head"><div class="ttl"><h3>${esc(d.part_no)} ${esc(d.name)} 출장지별 단가</h3>
          <span class="hint">뉴토크 기준값 ${wonText(d.standard_price)} · 평균 ${wonText(d.stats.average)} · 최저 ${wonText(d.stats.min)} · 최고 ${wonText(d.stats.max)}</span></div></div>
        ${!d.prices.length ? '<div class="empty">아직 입력된 단가가 없습니다.</div>' : `
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>출장지(업체)</th><th>적용 시작일</th><th class="r">단가</th><th>출처</th><th></th></tr></thead>
          <tbody>${d.prices.map((p) => `<tr>
            <td>${esc(p.company)}</td><td>${esc(p.effective_date)}${p.upcoming ? ' <span class="badge">예정</span>' : ''}</td>
            <td class="r num">${wonText(p.unit_price)}</td><td class="muted">${esc(p.source)} ${esc(p.quote_no || '')}</td>
            <td class="r"><button class="btn sm danger" data-del="${p.id}" data-label="${esc(`${p.company} ${comma(p.unit_price)}원 (${p.effective_date}부터)`)}">삭제</button></td></tr>`).join('')}</tbody></table></div>`}
      </div>`;
  }

  main.querySelector('#pi-detail').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || !(await confirmBox(`${b.dataset.label} 줄을 삭제할까요?`, '삭제'))) return;
    try {
      await api(`/api/parts/prices/${b.dataset.del}`, { method: 'DELETE' });
      toast('삭제했습니다.');
      await loadDetail();
    } catch (err) { toast(err.message, true); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selected) { toast('목록에서 파트넘버를 골라 주세요.', true); partInput.focus(); return; }
    const f = Object.fromEntries(new FormData(form));
    try {
      await api('/api/parts/prices', { method: 'POST', body: { catalog_item: selected.id, quote_company: f.quote_company, unit_price: parseMoney(f.unit_price), effective_date: f.effective_date, quote_note: f.quote_note } });
      toast(`${selected.part_no} ${f.quote_company} ${comma(parseMoney(f.unit_price))}원 (${f.effective_date}부터)을 저장했습니다.`);
      if (!choices.companies.includes(f.quote_company.trim())) {
        choices.companies.push(f.quote_company.trim());
        main.querySelector('#pi-companies').append(new Option(f.quote_company.trim()));
      }
      form.unit_price.value = '';
      form.quote_note.value = '';
      await loadDetail();
    } catch (err) { toast(err.message, true); }
  });
}
