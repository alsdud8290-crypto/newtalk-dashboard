// 확인용 임시 직원 12명 등록. 이미 있는 아이디는 건너뜀.
// 사용: npm run seed:users
import { db } from '../lib/db.js';
import { defaultPerms, hashPassword, PERMS } from '../lib/auth.js';

const PASSWORD = 'temp1234!';
const STAFF = [
  ['ceo', '임시 대표', '대표'],
  ['mgmt01', '임시 경영지원1', '경영지원팀'],
  ['mgmt02', '임시 경영지원2', '경영지원팀'],
  ['mgmt03', '임시 경영지원3', '경영지원팀'],
  ['prod01', '임시 겸직1', '생산·서비스 겸직'],
  ['prod02', '임시 겸직2', '생산·서비스 겸직'],
  ['prod03', '임시 겸직3', '생산·서비스 겸직'],
  ['prod04', '임시 생산 전담', '생산팀'],
  ['svc01', '임시 겸직4', '생산·서비스 겸직'],
  ['svc02', '임시 겸직5', '생산·서비스 겸직'],
  ['svc03', '임시 서비스 전담', '서비스팀'],
  ['multi01', '임시 겸직6', '생산·서비스 겸직'],
];

const INSERT = `INSERT INTO users (username, name, dept, password_hash, ${PERMS.map((k) => `perm_${k}`).join(', ')}, must_change_pw)
                VALUES (?, ?, ?, ?, ${PERMS.map(() => '?').join(', ')}, 1)`;
let added = 0;
for (const [username, name, dept] of STAFF) {
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) continue;
  const p = defaultPerms(dept);
  await db.run(INSERT, username, name, dept, hashPassword(PASSWORD), ...PERMS.map((k) => p[k]));
  added += 1;
}
console.log(`임시 직원 ${added}명 등록 (건너뜀 ${STAFF.length - added}명). 초기 비밀번호: ${PASSWORD}`);
