// 생산팀 화면 공통: 기간 선택(월·분기·연간·기간 — 생산·서비스 화면끼리 같이 씀), 납기 처리 상태 표시, D-day
import { api, esc } from '../core.js';
import { periodControl } from '../period-control.js';

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
  if (p.kind === 'range') { qs.set('from', p.from); qs.set('to', p.to); }
  return qs.toString();
}
// 내려받기 창에서 고른 기간 글자('2026' · '2026-Q3' · '2026-09') → 목록 조회와 같은 쿼리
export function pickQS(v) {
  const m = /^(\d{4})(?:-Q(\d)|-(\d{2}))?$/.exec(v || '');
  if (!m) return periodQS();
  return periodQS({ year: +m[1], kind: m[2] ? 'quarter' : m[3] ? 'month' : 'year', quarter: +m[2] || 1, month: +m[3] || 1 });
}

// 내려받기 창의 처음 값 = 화면에서 고른 기간
//  화면이 '기간'이면 끝나는 해 연간으로 시작
export const dlPeriod = () => (prodPeriod.kind === 'range'
  ? { year: +prodPeriod.to.slice(0, 4), mode: 'year' }
  : { year: prodPeriod.year, mode: prodPeriod.kind, month: prodPeriod.month, quarter: prodPeriod.quarter });

// 연도 목록: 데이터가 있는 가장 이른 연도(없으면 3년 전) ~ 내년
let earliest = null;
async function yearList() {
  if (earliest === null) earliest = (await api('/api/production/years').catch(() => ({}))).earliest_year || 0;
  const y = now.getFullYear();
  const from = Math.max(2000, Math.min(earliest || y, y - 3));
  return Array.from({ length: y + 1 - from + 1 }, (_, i) => y + 1 - i);
}

// 기간 선택 영역 (경영 대시보드와 같은 모양): 연도 + [월/분기/연간/기간] + 월·분기 / 시작월~종료월
export async function periodSelector(slot, onChange) {
  const years = await yearList();
  return periodControl(slot, prodPeriod, { years, onChange: () => { setProdPeriod({}); onChange(); } });
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
