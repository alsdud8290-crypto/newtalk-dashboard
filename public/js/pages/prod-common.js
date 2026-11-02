// 생산팀 화면 공통: 기간 선택(당월·분기·연간 — 생산팀 화면끼리 같이 씀), 납기 처리 상태 표시, D-day
import { api, esc } from '../core.js';

const now = new Date();
const quarterOf = (m) => Math.floor((m - 1) / 3) + 1;
// 처음 화면은 지금 진행 중인 분기. 고른 기간은 이 브라우저에 기억 (생산팀 화면끼리 공유)
export const prodPeriod = (() => {
  const base = { year: now.getFullYear(), kind: 'quarter', month: now.getMonth() + 1, quarter: quarterOf(now.getMonth() + 1) };
  try { return { ...base, ...JSON.parse(localStorage.getItem('prodPeriod') || '{}') }; } catch { return base; }
})();
export function setProdPeriod(p) {
  Object.assign(prodPeriod, p);
  try { localStorage.setItem('prodPeriod', JSON.stringify(prodPeriod)); } catch { /* 무시 */ }
}
export function periodQS(p = prodPeriod) {
  const qs = new URLSearchParams({ year: p.year, period: p.kind });
  if (p.kind === 'month') qs.set('month', p.month);
  if (p.kind === 'quarter') qs.set('quarter', p.quarter);
  return qs.toString();
}

// 연도 목록: 데이터가 있는 가장 이른 연도(없으면 3년 전) ~ 내년
let earliest = null;
async function yearList() {
  if (earliest === null) earliest = (await api('/api/production/years').catch(() => ({}))).earliest_year || 0;
  const y = now.getFullYear();
  const from = Math.max(2000, Math.min(earliest || y, y - 3));
  return Array.from({ length: y + 1 - from + 1 }, (_, i) => y + 1 - i);
}

// 기간 선택 영역: 연도 + [당월/분기/연간] + (당월) 월 / (분기) 분기
export async function periodSelector(slot, onChange) {
  const years = await yearList();
  const p = prodPeriod;
  const draw = () => {
    slot.innerHTML = `<div class="filters">
      <select class="input" data-ps="year">${years.map((y) => `<option value="${y}" ${y === p.year ? 'selected' : ''}>${y}년</option>`).join('')}</select>
      <div class="seg">${[['month', '당월'], ['quarter', '분기'], ['year', '연간']].map(([v, l]) => `<button type="button" data-kind="${v}" class="${p.kind === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${p.kind === 'month' ? `<select class="input" data-ps="month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${i + 1 === p.month ? 'selected' : ''}>${i + 1}월</option>`).join('')}</select>` : ''}
      ${p.kind === 'quarter' ? `<select class="input" data-ps="quarter">${[1, 2, 3, 4].map((q) => `<option value="${q}" ${q === p.quarter ? 'selected' : ''}>${q}분기</option>`).join('')}</select>` : ''}
    </div>`;
  };
  draw();
  slot.addEventListener('change', (e) => {
    const k = e.target.dataset.ps;
    if (!k) return;
    setProdPeriod({ [k]: Number(e.target.value) });
    onChange();
  });
  slot.addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b || b.dataset.kind === p.kind) return;
    setProdPeriod({ kind: b.dataset.kind });
    draw();
    onChange();
  });
  return { redraw: draw };
}

// 납기 처리 상태 (출고일로 판단). 색만으로 구분하지 않도록 기호와 글자를 함께 붙인다
export const DUE_STATUS = {
  overdue: { label: '납기 지남', icon: '!', cls: 'critical' },
  pending: { label: '출고 전', icon: '○', cls: 'pending' },
  partial: { label: '일부 출고', icon: '◐', cls: 'warning' },
  done: { label: '출고 완료', icon: '✓', cls: 'done' },
};
export const DUE_STATUS_ORDER = ['overdue', 'pending', 'partial', 'done'];
export const statusKey = (o) => (o.overdue ? 'overdue' : o.status);
export const statusChip = (o) => { const s = DUE_STATUS[statusKey(o)]; return `<span class="status-chip ${s.cls}">${s.icon} ${s.label}</span>`; };
// D-day 글자: 0 → D-day, 앞으로 3일 → D-3, 지남 2일 → D+2
export const dDayText = (d) => (d === 0 ? 'D-day' : d > 0 ? `D-${d}` : `D+${-d}`);
export const dDayChip = (d) => `<span class="status-chip ${d < 0 ? 'critical' : d <= 3 ? 'warning' : 'pending'}">${dDayText(d)}</span>`;
export const orderLabel = (o) => (o.po_no ? `#${esc(o.po_no)}` : '<span class="muted">수주번호 없음</span>');
export const qty = (v) => `${Number(v).toLocaleString('ko-KR')}대`;
export const dash = (v) => (v === null || v === undefined || v === '' ? '-' : esc(v));
