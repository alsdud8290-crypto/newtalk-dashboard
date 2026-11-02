// 공통 유틸: API 호출, 금액 포맷, 토스트, 모달

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    if (res.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('auth:expired'));
    throw err;
  }
  return data;
}

// 수정 권한이 없는 사람에게 화면 위에 보여 주는 안내
export const VIEW_ONLY = '<div class="notice">열람 전용입니다. 입력·수정은 팀장 또는 관리자에게 요청해 주세요.</div>';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 표시용 금액: 1억 이상은 억원, 1만 이상은 만원
export function won(v, { digits = 2 } = {}) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(digits)}억원`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString('ko-KR')}만원`;
  return `${sign}${Math.round(a).toLocaleString('ko-KR')}원`;
}
export const comma = (v) => (v === null || v === undefined || v === '' ? '' : Math.round(Number(v)).toLocaleString('ko-KR'));
export const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '-' : `${(v * 100).toFixed(d)}%`);
export const parseMoney = (s) => {
  const n = Number(String(s ?? '').replace(/[,\s원]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// 금액 입력칸: 포커스 시 원 숫자, 포커스 아웃 시 콤마
export function bindMoneyInputs(root) {
  root.querySelectorAll('input.money').forEach((el) => {
    el.addEventListener('focus', () => { el.value = el.value.replace(/,/g, ''); el.select(); });
    el.addEventListener('blur', () => { el.value = el.value.trim() === '' ? '' : comma(parseMoney(el.value)); });
  });
}

let toastTimer;
export function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3000);
}

// 간단한 모달. onSubmit이 false를 반환하면 닫지 않는다.
export function modal({ title, body, submitLabel = '저장', onSubmit, wide = false }) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<form class="modal" style="${wide ? 'max-width:720px' : ''}">
      <h3>${esc(title)}</h3>
      <div class="modal-body">${body}</div>
      <div class="notice err modal-err" hidden></div>
      <div class="actions">
        <button type="button" class="btn" data-close>취소</button>
        ${onSubmit ? `<button type="submit" class="btn primary">${esc(submitLabel)}</button>` : ''}
      </div>
    </form>`;
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.hasAttribute('data-close')) close(); });
  const form = bg.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = bg.querySelector('.modal-err');
    errBox.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await onSubmit(form);
      if (r !== false) close();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  document.body.appendChild(bg);
  bindMoneyInputs(bg);
  bg.querySelector('input, select')?.focus();
  return { el: bg, close };
}

export function confirmBox(message, label = '확인') {
  return new Promise((resolve) => {
    const m = modal({ title: '확인', body: `<p style="margin:0">${esc(message)}</p>`, submitLabel: label, onSubmit: () => resolve(true) });
    m.el.querySelector('[data-close]').addEventListener('click', () => resolve(false));
  });
}

// 기간 상태 (연도 + 월/분기/연간/기간) — 화면 간 공유, 브라우저에 기억
const now = new Date();
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
const saved = (() => { try { return JSON.parse(localStorage.getItem('period') || 'null'); } catch { return null; } })();
export const period = {
  year: now.getFullYear(),
  mode: 'quarter',
  period: Math.floor(now.getMonth() / 3) + 1,
  from: ym(now.getFullYear(), 1), // 기간 조회 기본값: 올해 1월 ~ 이번 달
  to: ym(now.getFullYear(), now.getMonth() + 1),
  ...(saved || {}),
};
export function setPeriod(p) {
  Object.assign(period, p);
  try { localStorage.setItem('period', JSON.stringify(period)); } catch { /* 저장 불가 시 무시 */ }
}
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function yearOptions(selected, extra = []) {
  const y = now.getFullYear();
  const years = new Set([...extra, y - 3, y - 2, y - 1, y, y + 1, selected]);
  return [...years].sort().map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${v}년</option>`).join('');
}
