import crypto from 'node:crypto';

export const DEPTS = ['경영지원팀', '대표', '관리자', '생산팀', '서비스팀', '생산·서비스 겸직'];
export const PERMS = ['mgmt', 'production', 'service', 'admin'];

// 부서별 기본 권한. 관리자 페이지에서 사람마다 개별 조정 가능.
export function defaultPerms(dept) {
  switch (dept) {
    case '경영지원팀':
    case '대표':
    case '관리자':
      return { mgmt: 1, production: 1, service: 1, admin: 1 };
    case '생산팀':
      return { mgmt: 0, production: 1, service: 0, admin: 0 };
    case '서비스팀':
      return { mgmt: 0, production: 0, service: 1, admin: 0 };
    case '생산·서비스 겸직':
      return { mgmt: 0, production: 1, service: 1, admin: 0 };
    default:
      return { mgmt: 0, production: 0, service: 0, admin: 0 };
  }
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
    active: !!u.active,
    mustChangePassword: !!u.must_change_pw,
    perms: {
      mgmt: !!u.perm_mgmt,
      production: !!u.perm_production,
      service: !!u.perm_service,
      admin: !!u.perm_admin,
    },
    createdAt: u.created_at,
  };
}
