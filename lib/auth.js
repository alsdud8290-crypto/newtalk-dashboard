import crypto from 'node:crypto';

export const DEPTS = ['경영지원팀', '대표', '관리자', '생산팀', '서비스팀', '생산·서비스 겸직'];
export const ROLES = ['팀원', '팀장'];
// 권한: 팀별 열람(mgmt·production·service) + 팀별 수정(edit_…) + 관리자 페이지(admin)
// DB 열 이름은 perm_<키> (예: perm_edit_production)
export const TEAMS = ['mgmt', 'production', 'service'];
export const PERMS = [...TEAMS, 'admin', ...TEAMS.map((t) => `edit_${t}`)];
const FULL_DEPTS = ['경영지원팀', '대표', '관리자'];

// 부서·직책별 기본 권한. 관리자 페이지에서 사람마다 개별 조정 가능.
//  - 경영지원팀·대표·관리자: 모든 권한
//  - 생산팀·서비스팀·겸직: 자기 팀만 열람, 팀장만 수정
export function defaultPerms(dept, role = '팀원') {
  const p = Object.fromEntries(PERMS.map((k) => [k, 0]));
  if (FULL_DEPTS.includes(dept)) return Object.fromEntries(PERMS.map((k) => [k, 1]));
  const teams = { 생산팀: ['production'], 서비스팀: ['service'], '생산·서비스 겸직': ['production', 'service'] }[dept] || [];
  for (const t of teams) {
    p[t] = 1;
    if (role === '팀장') p[`edit_${t}`] = 1;
  }
  return p;
}

// 수정 권한이 있으면 그 팀 열람도 켠다 (수정만 있고 못 보는 상태 방지)
export function normalizePerms(p) {
  const out = Object.fromEntries(PERMS.map((k) => [k, p[k] ? 1 : 0]));
  for (const t of TEAMS) if (out[`edit_${t}`]) out[t] = 1;
  return out;
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(ref, test);
}

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    dept: u.dept,
    role: u.role || '팀원',
    active: !!u.active,
    mustChangePassword: !!u.must_change_pw,
    perms: Object.fromEntries(PERMS.map((k) => [k, !!u[`perm_${k}`]])),
    createdAt: u.created_at,
  };
}
