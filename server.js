import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, tx } from './lib/db.js';
import {
  DEPTS, PERMS, defaultPerms, hashPassword, verifyPassword, newToken, parseCookies, publicUser,
} from './lib/auth.js';
import { summarize, INDUSTRIES, SALES_TYPES } from './lib/summary.js';
import { generateComment } from './lib/ai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 7;
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render 등 HTTPS 프록시 뒤에서 req.secure / req.ip를 올바르게 인식

// 보안 헤더
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// 다른 사이트에서 보낸 변경 요청 차단 (Origin이 다르면 거부)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  let host = null;
  try { host = origin ? new URL(origin).host : req.headers.host; } catch { /* Origin: null 등 */ }
  if (host !== req.headers.host) return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(here, 'public')));
app.use('/vendor/chart.js', express.static(path.join(here, 'node_modules/chart.js/dist')));
app.use('/vendor/xlsx', express.static(path.join(here, 'node_modules/xlsx/dist')));

// ---------- 공통 ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) { next(e); }
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/[,\s원]/g, ''));
  if (!Number.isFinite(n)) throw new HttpError(400, `숫자가 아닌 값: ${v}`);
  return n;
};
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v, field, optional = false) => {
  const s = str(v);
  if (!s && optional) return '';
  if (!DATE_RE.test(s)) throw new HttpError(400, `${field} 날짜 형식은 YYYY-MM-DD 이어야 합니다: ${s || '(빈 값)'}`);
  return s;
};
const intParam = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `잘못된 ${name}: ${v}`);
  return n;
};

// ---------- 인증 ----------
app.use((req, _res, next) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`).get(token, Date.now());
    if (row) { req.user = row; req.token = token; }
  }
  next();
});

const requireLogin = (req, _res, next) => next(req.user ? undefined : new HttpError(401, '로그인이 필요합니다.'));
const requirePerm = (perm) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, '로그인이 필요합니다.'));
  if (!req.user[`perm_${perm}`]) return next(new HttpError(403, '이 메뉴에 대한 권한이 없습니다.'));
  next();
};

// 로그인 실패 제한: 같은 IP·아이디로 10분 안에 5번 틀리면 10분간 잠금
const LOCK_MS = 10 * 60 * 1000;
const MAX_FAILS = 5;
const loginFails = new Map();
const cookieFlags = (req) => `HttpOnly; SameSite=Lax; Path=/${req.secure ? '; Secure' : ''}`;

app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}|${str(username).toLowerCase()}`;
  const now = Date.now();
  const f = loginFails.get(key);
  if (f && f.count >= MAX_FAILS && now - f.last < LOCK_MS) {
    throw new HttpError(429, `로그인 시도가 너무 많습니다. ${Math.ceil((LOCK_MS - (now - f.last)) / 60000)}분 후 다시 시도해 주세요.`);
  }
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(str(username));
  if (!u || !u.active || !verifyPassword(String(password || ''), u.password_hash)) {
    const cur = f && now - f.last < LOCK_MS ? f : { count: 0 };
    loginFails.set(key, { count: cur.count + 1, last: now });
    if (loginFails.size > 10000) loginFails.clear();
    throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  loginFails.delete(key);
  const token = newToken();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, u.id, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', requireLogin, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', requireLogin, wrap((req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user.password_hash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
  if (String(next || '').length < 8) throw new HttpError(400, '새 비밀번호는 8자 이상이어야 합니다.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
  res.json({ ok: true });
}));

app.get('/api/meta', requireLogin, (_req, res) => {
  const series = db.prepare("SELECT DISTINCT series FROM sales WHERE series <> '' ORDER BY series").all().map((r) => r.series);
  const customers = db.prepare('SELECT DISTINCT customer FROM sales UNION SELECT DISTINCT customer FROM receivables ORDER BY 1').all().map((r) => r.customer);
  const years = db.prepare(`SELECT year FROM monthly UNION SELECT year FROM targets
                            UNION SELECT CAST(substr(date,1,4) AS INTEGER) FROM sales ORDER BY 1`).all().map((r) => r.year);
  res.json({ industries: INDUSTRIES, salesTypes: SALES_TYPES, depts: DEPTS, series, customers, years });
});

// ---------- 경영지원팀: 대시보드 ----------
const mgmt = express.Router();
mgmt.use(requirePerm('mgmt'));

function parsePeriod(q) {
  const year = intParam(q.year, 2000, 2100, '연도');
  const mode = q.mode === 'month' ? 'month' : 'quarter';
  const period = intParam(q.period, 1, mode === 'month' ? 12 : 4, '기간');
  return { year, mode, period };
}

mgmt.get('/summary', wrap((req, res) => {
  const { year, mode, period } = parsePeriod(req.query);
  res.json(summarize(year, mode, period));
}));

mgmt.get('/ai-comment', wrap((req, res) => {
  const { year, mode, period } = parsePeriod(req.query);
  const row = db.prepare('SELECT * FROM ai_comments WHERE key = ?').get(`${year}-${mode}-${period}`);
  res.json(row ? { ...JSON.parse(row.content), source: row.source, createdAt: row.created_at } : null);
}));

mgmt.post('/ai-comment', wrap(async (req, res) => {
  const { year, mode, period } = parsePeriod(req.body || {});
  const result = await generateComment(summarize(year, mode, period));
  const { source, error, ...content } = result;
  db.prepare(`INSERT INTO ai_comments (key, content, source, created_at) VALUES (?, ?, ?, datetime('now','localtime'))
              ON CONFLICT(key) DO UPDATE SET content = excluded.content, source = excluded.source, created_at = excluded.created_at`)
    .run(`${year}-${mode}-${period}`, JSON.stringify(content), source);
  const row = db.prepare('SELECT created_at FROM ai_comments WHERE key = ?').get(`${year}-${mode}-${period}`);
  res.json({ ...content, source, error, createdAt: row.created_at });
}));

// ---------- 경영지원팀: 목표 / 월별 실적 ----------
const MONTHLY_FIELDS = ['product_purchase', 'material_purchase', 'expense', 'ad_expense', 'entertainment_expense',
  'other_expense', 'product_sales', 'goods_sales', 'service_sales'];

mgmt.get('/targets/:year', wrap((req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  res.json({ year, revenue: db.prepare('SELECT revenue FROM targets WHERE year = ?').get(year)?.revenue || 0 });
}));

mgmt.put('/targets/:year', wrap((req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  const revenue = num(req.body?.revenue);
  db.prepare('INSERT INTO targets (year, revenue) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET revenue = excluded.revenue').run(year, revenue);
  res.json({ year, revenue });
}));

mgmt.get('/monthly/:year', wrap((req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  const rows = db.prepare('SELECT * FROM monthly WHERE year = ? ORDER BY month').all(year);
  const detail = db.prepare(`SELECT CAST(substr(date,6,2) AS INTEGER) AS month, sales_type, SUM(amount) AS amount
                             FROM sales WHERE substr(date,1,4) = ? GROUP BY month, sales_type`).all(String(year));
  res.json({ year, rows, detail });
}));

function upsertMonthly(year, month, data) {
  const vals = MONTHLY_FIELDS.map((f) => num(data[f]));
  db.prepare(`INSERT INTO monthly (year, month, ${MONTHLY_FIELDS.join(', ')}, updated_at)
              VALUES (?, ?, ${MONTHLY_FIELDS.map(() => '?').join(', ')}, datetime('now','localtime'))
              ON CONFLICT(year, month) DO UPDATE SET ${MONTHLY_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
              updated_at = excluded.updated_at`).run(year, month, ...vals);
}

mgmt.put('/monthly/:year', wrap((req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  tx(() => rows.forEach((r) => upsertMonthly(year, intParam(r.month, 1, 12, '월'), r)));
  res.json({ ok: true, count: rows.length });
}));

// ---------- 경영지원팀: 매출 내역 ----------
function cleanSale(b) {
  const industry = str(b.industry);
  if (!INDUSTRIES.includes(industry)) throw new HttpError(400, `산업분야는 ${INDUSTRIES.join('/')} 중 하나여야 합니다: ${industry || '(빈 값)'}`);
  const salesType = str(b.sales_type) || '제품';
  if (!SALES_TYPES.includes(salesType)) throw new HttpError(400, `매출구분은 제품/상품/용역 중 하나여야 합니다: ${salesType}`);
  const customer = str(b.customer);
  if (!customer) throw new HttpError(400, '판매처를 입력해 주세요.');
  return [date(b.date, '일자'), customer, industry, str(b.series), salesType, num(b.amount), str(b.note)];
}

mgmt.get('/sales', wrap((req, res) => {
  const year = intParam(req.query.year, 2000, 2100, '연도');
  res.json(db.prepare('SELECT * FROM sales WHERE substr(date,1,4) = ? ORDER BY date DESC, id DESC').all(String(year)));
}));
mgmt.post('/sales', wrap((req, res) => {
  const r = db.prepare('INSERT INTO sales (date, customer, industry, series, sales_type, amount, note) VALUES (?,?,?,?,?,?,?)').run(...cleanSale(req.body || {}));
  res.json({ id: Number(r.lastInsertRowid) });
}));
mgmt.put('/sales/:id', wrap((req, res) => {
  db.prepare('UPDATE sales SET date=?, customer=?, industry=?, series=?, sales_type=?, amount=?, note=? WHERE id=?').run(...cleanSale(req.body || {}), Number(req.params.id));
  res.json({ ok: true });
}));
mgmt.delete('/sales/:id', wrap((req, res) => {
  db.prepare('DELETE FROM sales WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- 경영지원팀: 미수금 ----------
function cleanRecv(b) {
  const customer = str(b.customer);
  if (!customer) throw new HttpError(400, '거래처를 입력해 주세요.');
  return [customer, date(b.invoice_date, '청구일자'), num(b.amount), num(b.collected),
    date(b.collected_date, '수금일자', true), date(b.due_date, '결제예정일', true), str(b.note)];
}

mgmt.get('/receivables', wrap((req, res) => {
  const where = req.query.open === '1' ? 'WHERE amount - collected > 0.5' : '';
  res.json(db.prepare(`SELECT * FROM receivables ${where} ORDER BY invoice_date DESC, id DESC`).all());
}));
mgmt.post('/receivables', wrap((req, res) => {
  const r = db.prepare('INSERT INTO receivables (customer, invoice_date, amount, collected, collected_date, due_date, note) VALUES (?,?,?,?,?,?,?)').run(...cleanRecv(req.body || {}));
  res.json({ id: Number(r.lastInsertRowid) });
}));
mgmt.put('/receivables/:id', wrap((req, res) => {
  db.prepare('UPDATE receivables SET customer=?, invoice_date=?, amount=?, collected=?, collected_date=?, due_date=?, note=? WHERE id=?').run(...cleanRecv(req.body || {}), Number(req.params.id));
  res.json({ ok: true });
}));
mgmt.delete('/receivables/:id', wrap((req, res) => {
  db.prepare('DELETE FROM receivables WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- 경영지원팀: 엑셀 일괄 업로드 (과거 데이터 이관) ----------
// 클라이언트가 엑셀을 파싱해 JSON으로 보낸다. 행 단위 오류는 모아서 반환하고, 오류가 있으면 아무것도 저장하지 않는다.
mgmt.post('/import', wrap((req, res) => {
  const { targets = [], monthly = [], sales = [], receivables = [], replaceSalesYears = false, replaceReceivables = false } = req.body || {};
  const errors = [];
  const check = (sheet, i, fn) => {
    try { return fn(); } catch (e) { errors.push(`[${sheet}] ${i + 2}행: ${e.message}`); return null; }
  };
  const t = targets.map((r, i) => check('연간목표', i, () => [intParam(r.year, 2000, 2100, '연도'), num(r.revenue)]));
  const m = monthly.map((r, i) => check('월별실적', i, () => ({ year: intParam(r.year, 2000, 2100, '연도'), month: intParam(r.month, 1, 12, '월'), r })));
  m.forEach((x, i) => x && check('월별실적', i, () => MONTHLY_FIELDS.forEach((f) => num(x.r[f]))));
  const s = sales.map((r, i) => check('매출내역', i, () => cleanSale(r)));
  const rv = receivables.map((r, i) => check('미수금', i, () => cleanRecv(r)));
  if (errors.length) return res.status(400).json({ error: '업로드 데이터에 오류가 있어 저장하지 않았습니다.', details: errors.slice(0, 50), total: errors.length });

  tx(() => {
    for (const [year, revenue] of t) db.prepare('INSERT INTO targets (year, revenue) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET revenue = excluded.revenue').run(year, revenue);
    for (const x of m) upsertMonthly(x.year, x.month, x.r);
    if (replaceSalesYears) {
      for (const y of new Set(s.map((r) => r[0].slice(0, 4)))) db.prepare('DELETE FROM sales WHERE substr(date,1,4) = ?').run(y);
    }
    const insS = db.prepare('INSERT INTO sales (date, customer, industry, series, sales_type, amount, note) VALUES (?,?,?,?,?,?,?)');
    for (const r of s) insS.run(...r);
    if (replaceReceivables) db.exec('DELETE FROM receivables');
    const insR = db.prepare('INSERT INTO receivables (customer, invoice_date, amount, collected, collected_date, due_date, note) VALUES (?,?,?,?,?,?,?)');
    for (const r of rv) insR.run(...r);
  });
  res.json({ ok: true, counts: { targets: t.length, monthly: m.length, sales: s.length, receivables: rv.length } });
}));

app.use('/api/mgmt', mgmt);

// ---------- 관리자: 사용자 / 권한 ----------
const admin = express.Router();
admin.use(requirePerm('admin'));

const adminCount = (exceptId) => db.prepare('SELECT COUNT(*) AS n FROM users WHERE perm_admin = 1 AND active = 1 AND id <> ?').get(exceptId).n;

admin.get('/users', (_req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY active DESC, dept, name').all().map(publicUser)));

admin.post('/users', wrap((req, res) => {
  const b = req.body || {};
  const username = str(b.username);
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, '아이디는 영문/숫자 3~30자로 입력해 주세요.');
  if (!str(b.name)) throw new HttpError(400, '이름을 입력해 주세요.');
  if (!DEPTS.includes(b.dept)) throw new HttpError(400, '부서를 선택해 주세요.');
  if (String(b.password || '').length < 8) throw new HttpError(400, '초기 비밀번호는 8자 이상이어야 합니다.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(400, '이미 사용 중인 아이디입니다.');
  const p = { ...defaultPerms(b.dept), ...(b.perms || {}) };
  const r = db.prepare(`INSERT INTO users (username, name, dept, password_hash, perm_mgmt, perm_production, perm_service, perm_admin)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(username, str(b.name), b.dept, hashPassword(b.password), ...PERMS.map((k) => (p[k] ? 1 : 0)));
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)));
}));

admin.put('/users/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name) : u.name;
  const dept = b.dept !== undefined ? b.dept : u.dept;
  if (!name) throw new HttpError(400, '이름을 입력해 주세요.');
  if (!DEPTS.includes(dept)) throw new HttpError(400, '부서를 선택해 주세요.');
  const perms = Object.fromEntries(PERMS.map((k) => [k, b.perms && k in b.perms ? (b.perms[k] ? 1 : 0) : u[`perm_${k}`]]));
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  if ((!perms.admin || !active) && u.perm_admin && u.active && adminCount(id) === 0) {
    throw new HttpError(400, '마지막 관리자 권한은 해제할 수 없습니다.');
  }
  db.prepare(`UPDATE users SET name=?, dept=?, perm_mgmt=?, perm_production=?, perm_service=?, perm_admin=?, active=? WHERE id=?`)
    .run(name, dept, perms.mgmt, perms.production, perms.service, perms.admin, active, id);
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
}));

admin.post('/users/:id/reset-password', wrap((req, res) => {
  const id = Number(req.params.id);
  const pw = String(req.body?.password || '');
  if (pw.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
  const r = db.prepare('UPDATE users SET password_hash = ?, must_change_pw = 1 WHERE id = ?').run(hashPassword(pw), id);
  if (!r.changes) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
}));

app.get('/api/admin/default-perms', requirePerm('admin'), (_req, res) => res.json(Object.fromEntries(DEPTS.map((d) => [d, defaultPerms(d)]))));
app.use('/api/admin', admin);

// ---------- 에러 처리 ----------
app.use('/api', (_req, _res, next) => next(new HttpError(404, '없는 API입니다.')));
app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message });
});

app.listen(PORT, () => console.log(`뉴토크 코리아 경영 대시보드: http://localhost:${PORT}`));
