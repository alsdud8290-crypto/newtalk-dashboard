// 기간 조회 버튼 (경영 대시보드와 같은 모양): 연도 + [월 | 분기 | 연간 | 기간] + 월·분기 선택 / 기간이면 시작월 ~ 종료월 + [조회]
//  state = { kind: 'month'|'quarter'|'year'|'range', year, month, quarter, from: 'YYYY-MM', to: 'YYYY-MM' } — 이 함수가 값을 바꾼다
//  onChange(state) 는 값이 바뀔 때마다 (기간은 [조회]를 눌렀을 때) 부른다
import { esc, toast } from './core.js';

const KINDS = [['month', '월'], ['quarter', '분기'], ['year', '연간'], ['range', '기간']];
const p2 = (n) => String(n).padStart(2, '0');

// 기간 → 화면 글자·조회 범위 ('YYYY-MM' 시작·끝)
export function periodRange(st) {
  if (st.kind === 'range') return { from: st.from, to: st.to };
  if (st.kind === 'month') return { from: `${st.year}-${p2(st.month)}`, to: `${st.year}-${p2(st.month)}` };
  if (st.kind === 'quarter') return { from: `${st.year}-${p2(st.quarter * 3 - 2)}`, to: `${st.year}-${p2(st.quarter * 3)}` };
  return { from: `${st.year}-01`, to: `${st.year}-12` };
}
export function periodLabel(st) {
  if (st.kind === 'month') return `${st.year}년 ${st.month}월`;
  if (st.kind === 'quarter') return `${st.year}년 ${st.quarter}분기`;
  if (st.kind === 'year') return `${st.year}년`;
  const [a, b] = [st.from, st.to];
  const lab = (v) => `${+v.slice(0, 4)}년 ${+v.slice(5, 7)}월`;
  return a === b ? lab(a) : a.slice(0, 4) === b.slice(0, 4) ? `${a.slice(0, 4)}년 ${+a.slice(5, 7)}~${+b.slice(5, 7)}월` : `${lab(a)} ~ ${lab(b)}`;
}

export function periodControl(slot, st, { years = [], onChange = () => {} } = {}) {
  const now = new Date();
  if (!st.from || !st.to) Object.assign(st, periodRange({ ...st, kind: st.kind === 'range' ? 'year' : st.kind }));
  const yearList = () => [...new Set([...years, st.year, now.getFullYear() + 1, now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2, now.getFullYear() - 3])].sort((a, b) => b - a);
  const draw = () => {
    const n = st.kind === 'month' ? 12 : 4;
    slot.innerHTML = `<div class="filters period-ctl">
      <select class="input" data-pc="year" ${st.kind === 'range' ? 'hidden' : ''}>${yearList().map((y) => `<option value="${y}" ${y === st.year ? 'selected' : ''}>${y}년</option>`).join('')}</select>
      <div class="seg">${KINDS.map(([k, l]) => `<button type="button" data-pc-kind="${k}" class="${st.kind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <select class="input" data-pc="${st.kind === 'month' ? 'month' : 'quarter'}" ${['month', 'quarter'].includes(st.kind) ? '' : 'hidden'}>
        ${Array.from({ length: n }, (_, i) => i + 1).map((v) => `<option value="${v}" ${v === (st.kind === 'month' ? st.month : st.quarter) ? 'selected' : ''}>${v}${st.kind === 'month' ? '월' : '분기'}</option>`).join('')}</select>
      <span class="filters" ${st.kind === 'range' ? '' : 'hidden'}>
        <input class="input" type="month" data-pc-from value="${esc(st.from)}" aria-label="시작월">
        <span class="range-sep">~</span>
        <input class="input" type="month" data-pc-to value="${esc(st.to)}" aria-label="종료월">
        <button type="button" class="btn primary" data-pc-go>조회</button>
      </span>
    </div>`;
  };
  // 단위를 바꿔도 같은 시점을 유지 (경영 대시보드와 같은 규칙)
  function switchKind(kind) {
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;
    let year = st.year;
    let ref = st.kind === 'month' ? st.month : st.kind === 'quarter' ? st.quarter * 3 : st.kind === 'year' ? (year === curY ? curM : 12) : +st.to.slice(5, 7);
    if (st.kind === 'range') year = +st.to.slice(0, 4);
    if (year === curY) ref = Math.min(ref, curM);
    const from = periodRange(st).from;
    const to = st.kind === 'year' && year === curY ? `${year}-${p2(curM)}` : periodRange(st).to;
    Object.assign(st, { kind, year, month: ref, quarter: Math.ceil(ref / 3) });
    if (kind === 'range') Object.assign(st, { from, to });
  }
  slot.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pc-kind]');
    if (b && b.dataset.pcKind !== st.kind) {
      switchKind(b.dataset.pcKind);
      draw();
      onChange(st);
      return;
    }
    if (e.target.closest('[data-pc-go]')) go();
  });
  const go = () => {
    const from = slot.querySelector('[data-pc-from]').value;
    const to = slot.querySelector('[data-pc-to]').value;
    if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) return toast('시작월과 종료월을 골라 주세요.', true);
    if (from > to) return toast('시작월이 종료월보다 늦습니다.', true);
    Object.assign(st, { from, to, year: +to.slice(0, 4) });
    onChange(st);
  };
  slot.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[data-pc-from], [data-pc-to]')) go(); });
  slot.addEventListener('change', (e) => {
    const k = e.target.dataset.pc;
    if (!k) return;
    st[k] = Number(e.target.value);
    onChange(st);
  });
  draw();
  return { redraw: draw };
}
