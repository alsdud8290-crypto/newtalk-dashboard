import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowStr } from './lib/db.js';
import {
  DEPTS, PERMS, defaultPerms, hashPassword, verifyPassword, newToken, parseCookies, publicUser,
} from './lib/auth.js';
import { summarize, resolvePeriod, PeriodError, INDUSTRIES, SALES_TYPES } from './lib/summary.js';
import { generateComment } from './lib/ai.js';
import * as ledger from './lib/ledger.js';

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
app.use('/vendor/html2canvas', express.static(path.join(here, 'node_modules/html2canvas/dist')));
app.use('/vendor/pretendard', express.static(path.join(here, 'node_modules/pretendard/dist/web/variable')));
app.use('/vendor/jszip', express.static(path.join(here, 'node_modules/jszip/dist')));

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
app.use(wrap(async (req, _res, next) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) {
    const row = await db.get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`, token, Date.now());
    if (row) { req.user = row; req.token = token; }
  }
  next();
}));

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

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}|${str(username).toLowerCase()}`;
  const now = Date.now();
  const f = loginFails.get(key);
  if (f && f.count >= MAX_FAILS && now - f.last < LOCK_MS) {
    throw new HttpError(429, `로그인 시도가 너무 많습니다. ${Math.ceil((LOCK_MS - (now - f.last)) / 60000)}분 후 다시 시도해 주세요.`);
  }
  const u = await db.get('SELECT * FROM users WHERE username = ?', str(username));
  if (!u || !u.active || !verifyPassword(String(password || ''), u.password_hash)) {
    const cur = f && now - f.last < LOCK_MS ? f : { count: 0 };
    loginFails.set(key, { count: cur.count + 1, last: now });
    if (loginFails.size > 10000) loginFails.clear();
    throw new HttpError(401, '아이디 또는 비밀번호가 올바르지 않습니다.');
  }
  loginFails.delete(key);
  const token = newToken();
  await db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
  await db.run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', token, u.id, Date.now() + SESSION_DAYS * 86400000);
  res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_DAYS * 86400}`);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  if (req.token) await db.run('DELETE FROM sessions WHERE token = ?', req.token);
  res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
  res.json({ ok: true });
}));

app.get('/api/me', requireLogin, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', requireLogin, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (!verifyPassword(String(current || ''), req.user.password_hash)) throw new HttpError(400, '현재 비밀번호가 올바르지 않습니다.');
  if (String(next || '').length < 8) throw new HttpError(400, '새 비밀번호는 8자 이상이어야 합니다.');
  await db.run('UPDATE users SET password_hash = ?, must_change_pw = 0 WHERE id = ?', hashPassword(next), req.user.id);
  await db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', req.user.id, req.token);
  res.json({ ok: true });
}));

app.get('/api/meta', requireLogin, wrap(async (req, res) => {
  const [series, customers, years] = await Promise.all([
    db.all("SELECT DISTINCT series FROM sales WHERE series <> '' ORDER BY series"),
    db.all('SELECT DISTINCT customer FROM sales UNION SELECT DISTINCT customer FROM receivables ORDER BY 1'),
    db.all(`SELECT year FROM monthly UNION SELECT year FROM targets
            UNION SELECT CAST(substr(date,1,4) AS INTEGER) FROM sales ORDER BY 1`),
  ]);
  res.json({
    industries: INDUSTRIES, salesTypes: SALES_TYPES, depts: DEPTS,
    series: series.map((r) => r.series), customers: customers.map((r) => r.customer), years: years.map((r) => Number(r.year)),
    // 배포 서버가 로컬 파일(무료 서버는 재시작 시 삭제)에 저장 중이면 화면에 경고
    ephemeralStorage: IS_PROD && db.kind === 'local' && !process.env.DATA_DIR,
  });
}));

// ---------- 경영지원팀: 대시보드 ----------
const mgmt = express.Router();
mgmt.use(requirePerm('mgmt'));

// 조회 조건 정리 (형식 오류는 400). AI 코멘트는 "단위:시작월:종료월"을 키로 기간별 저장
function parsePeriod(q) {
  const mode = ['month', 'quarter', 'year', 'range'].includes(q.mode) ? q.mode : 'quarter';
  try {
    const p = resolvePeriod({ mode, year: q.year, period: q.period, from: q.from, to: q.to });
    return { query: { mode, year: q.year, period: q.period, from: q.from, to: q.to }, key: `${mode}:${p.start}:${p.end}` };
  } catch (e) {
    if (e instanceof PeriodError) throw new HttpError(400, e.message);
    throw e;
  }
}

mgmt.get('/summary', wrap(async (req, res) => {
  res.json(await summarize(parsePeriod(req.query).query));
}));

mgmt.get('/ai-comment', wrap(async (req, res) => {
  const row = await db.get('SELECT * FROM ai_comments WHERE key = ?', parsePeriod(req.query).key);
  res.json(row ? { ...JSON.parse(row.content), source: row.source, createdAt: row.created_at } : null);
}));

mgmt.post('/ai-comment', wrap(async (req, res) => {
  const { query, key } = parsePeriod(req.body || {});
  const result = await generateComment(await summarize(query));
  const { source, error, ...content } = result;
  const createdAt = nowStr();
  await db.run(`INSERT INTO ai_comments (key, content, source, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET content = excluded.content, source = excluded.source, created_at = excluded.created_at`, key, JSON.stringify(content), source, createdAt);
  res.json({ ...content, source, error, createdAt });
}));

// ---------- 경영지원팀: 목표 / 월별 실적 ----------
const MONTHLY_FIELDS = ['product_purchase', 'material_purchase', 'expense', 'ad_expense', 'entertainment_expense',
  'other_expense', 'product_sales', 'goods_sales', 'service_sales'];

mgmt.get('/targets/:year', wrap(async (req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  res.json({ year, revenue: (await db.get('SELECT revenue FROM targets WHERE year = ?', year))?.revenue || 0 });
}));

mgmt.put('/targets/:year', wrap(async (req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  const revenue = num(req.body?.revenue);
  await db.run('INSERT INTO targets (year, revenue) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET revenue = excluded.revenue', year, revenue);
  res.json({ year, revenue });
}));

mgmt.get('/monthly/:year', wrap(async (req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  const rows = await db.all('SELECT * FROM monthly WHERE year = ? ORDER BY month', year);
  const detail = await db.all(`SELECT CAST(substr(date,6,2) AS INTEGER) AS month, sales_type, SUM(amount) AS amount
                             FROM sales WHERE substr(date,1,4) = ? GROUP BY month, sales_type`, String(year));
  res.json({ year, rows, detail });
}));

// 월별 실적 저장 문장 (db.batch 에 넣어 한 번에 실행)
function upsertMonthly(year, month, data) {
  const vals = MONTHLY_FIELDS.map((f) => num(data[f]));
  return [`INSERT INTO monthly (year, month, ${MONTHLY_FIELDS.join(', ')}, updated_at)
           VALUES (?, ?, ${MONTHLY_FIELDS.map(() => '?').join(', ')}, ?)
           ON CONFLICT(year, month) DO UPDATE SET ${MONTHLY_FIELDS.map((f) => `${f} = excluded.${f}`).join(', ')},
           updated_at = excluded.updated_at`, [year, month, ...vals, nowStr()]];
}

mgmt.put('/monthly/:year', wrap(async (req, res) => {
  const year = intParam(req.params.year, 2000, 2100, '연도');
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  await db.batch(rows.map((r) => upsertMonthly(year, intParam(r.month, 1, 12, '월'), r)));
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

mgmt.get('/sales', wrap(async (req, res) => {
  const year = intParam(req.query.year, 2000, 2100, '연도');
  res.json(await db.all('SELECT * FROM sales WHERE substr(date,1,4) = ? ORDER BY date DESC, id DESC', String(year)));
}));
mgmt.post('/sales', wrap(async (req, res) => {
  const r = await db.run('INSERT INTO sales (date, customer, industry, series, sales_type, amount, note) VALUES (?,?,?,?,?,?,?)', ...cleanSale(req.body || {}));
  res.json({ id: Number(r.lastInsertRowid) });
}));
mgmt.put('/sales/:id', wrap(async (req, res) => {
  await db.run('UPDATE sales SET date=?, customer=?, industry=?, series=?, sales_type=?, amount=?, note=? WHERE id=?', ...cleanSale(req.body || {}), Number(req.params.id));
  res.json({ ok: true });
}));
mgmt.delete('/sales/:id', wrap(async (req, res) => {
  await db.run('DELETE FROM sales WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- 경영지원팀: 미수금 ----------
function cleanRecv(b) {
  const customer = str(b.customer);
  if (!customer) throw new HttpError(400, '거래처를 입력해 주세요.');
  return [customer, date(b.invoice_date, '청구일자'), num(b.amount), num(b.collected),
    date(b.collected_date, '수금일자', true), date(b.due_date, '결제예정일', true), str(b.note), str(b.code)];
}

mgmt.get('/receivables', wrap(async (req, res) => {
  const where = req.query.open === '1' ? 'WHERE amount - collected > 0.5' : '';
  res.json(await db.all(`SELECT * FROM receivables ${where} ORDER BY invoice_date DESC, id DESC`));
}));
mgmt.post('/receivables', wrap(async (req, res) => {
  const r = await db.run('INSERT INTO receivables (customer, invoice_date, amount, collected, collected_date, due_date, note, code) VALUES (?,?,?,?,?,?,?,?)', ...cleanRecv(req.body || {}));
  res.json({ id: Number(r.lastInsertRowid) });
}));
mgmt.put('/receivables/:id', wrap(async (req, res) => {
  // 화면에서 코드를 보내지 않으면 기존 코드 유지
  await db.run("UPDATE receivables SET customer=?, invoice_date=?, amount=?, collected=?, collected_date=?, due_date=?, note=?, code=COALESCE(NULLIF(?, ''), code) WHERE id=?", ...cleanRecv(req.body || {}), Number(req.params.id));
  res.json({ ok: true });
}));
mgmt.delete('/receivables/:id', wrap(async (req, res) => {
  await db.run('DELETE FROM receivables WHERE id = ?', Number(req.params.id));
  res.json({ ok: true });
}));

// ---------- 경영지원팀: 엑셀 일괄 업로드 (과거 데이터 이관) ----------
// 클라이언트가 엑셀을 파싱해 JSON으로 보낸다. 행 단위 오류는 모아서 반환하고, 오류가 있으면 아무것도 저장하지 않는다.
mgmt.post('/import', wrap(async (req, res) => {
  const { targets = [], monthly = [], sales = [], receivables = [], replaceSalesYears = false, replaceAllSales = false, replaceReceivables = false, replaceRange = null } = req.body || {};
  // replaceRange: 기간 파일(월·분기·연간) 다시 올리기 → 그 기간의 매출내역·미수금만 교체
  const range = replaceRange && /^\d{4}-\d{2}$/.test(replaceRange.from) && /^\d{4}-\d{2}$/.test(replaceRange.to) && replaceRange.from <= replaceRange.to ? replaceRange : null;
  if (replaceRange && !range) throw new HttpError(400, '교체할 기간이 올바르지 않습니다.');
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

  // 전부 하나의 묶음으로 실행 → 중간에 실패하면 아무것도 저장되지 않음
  const stmts = [];
  for (const [year, revenue] of t) stmts.push(['INSERT INTO targets (year, revenue) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET revenue = excluded.revenue', [year, revenue]]);
  for (const x of m) stmts.push(upsertMonthly(x.year, x.month, x.r));
  if (replaceAllSales) stmts.push(['DELETE FROM sales', []]);
  else if (range && replaceSalesYears) stmts.push(['DELETE FROM sales WHERE substr(date,1,7) BETWEEN ? AND ?', [range.from, range.to]]);
  else if (replaceSalesYears) {
    for (const y of new Set(s.map((r) => r[0].slice(0, 4)))) stmts.push(['DELETE FROM sales WHERE substr(date,1,4) = ?', [y]]);
  }
  for (const r of s) stmts.push(['INSERT INTO sales (date, customer, industry, series, sales_type, amount, note) VALUES (?,?,?,?,?,?,?)', r]);
  if (replaceReceivables) stmts.push(range ? ['DELETE FROM receivables WHERE substr(invoice_date,1,7) BETWEEN ? AND ?', [range.from, range.to]] : ['DELETE FROM receivables', []]);
  for (const r of rv) stmts.push(['INSERT INTO receivables (customer, invoice_date, amount, collected, collected_date, due_date, note, code) VALUES (?,?,?,?,?,?,?,?)', r]);
  await db.batch(stmts);
  res.json({ ok: true, counts: { targets: t.length, monthly: m.length, sales: s.length, receivables: rv.length } });
}));

// ---------- 경영지원팀: 데이터 내보내기 (엑셀·CSV 다운로드용) ----------
// period: 'YYYY'(연간) · 'YYYY-Qn'(분기) · 'YYYY-MM'(월) · 없음(전체). 예전 year= 도 받는다. 미수금은 청구일 기준
const p2 = (n) => String(n).padStart(2, '0');
function exportScope(query) {
  const v = String(query.period || query.year || '').trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})$/);
  if (m) { const y = intParam(m[1], 2000, 2100, '연도'); return { from: `${y}-01`, to: `${y}-12`, label: `${y}년` }; }
  m = v.match(/^(\d{4})-Q([1-4])$/i);
  if (m) {
    const y = intParam(m[1], 2000, 2100, '연도');
    const q = Number(m[2]);
    return { from: `${y}-${p2(q * 3 - 2)}`, to: `${y}-${p2(q * 3)}`, label: `${y}년 ${q}분기` };
  }
  m = v.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (m) { const y = intParam(m[1], 2000, 2100, '연도'); return { from: v, to: v, label: `${y}년 ${Number(m[2])}월` }; }
  throw new HttpError(400, `잘못된 기간: ${v}`);
}
const MONTH_KEY = "printf('%04d-%02d', year, month)";
const scoped = (sc) => ({
  targets: () => (sc ? db.all('SELECT year, revenue FROM targets WHERE year BETWEEN ? AND ? ORDER BY year', Number(sc.from.slice(0, 4)), Number(sc.to.slice(0, 4))) : db.all('SELECT year, revenue FROM targets ORDER BY year')),
  monthly: () => (sc ? db.all(`SELECT * FROM monthly WHERE ${MONTH_KEY} BETWEEN ? AND ? ORDER BY year, month`, sc.from, sc.to) : db.all('SELECT * FROM monthly ORDER BY year, month')),
  sales: () => (sc ? db.all('SELECT * FROM sales WHERE substr(date,1,7) BETWEEN ? AND ? ORDER BY date, id', sc.from, sc.to) : db.all('SELECT * FROM sales ORDER BY date, id')),
  receivables: () => (sc ? db.all('SELECT * FROM receivables WHERE substr(invoice_date,1,7) BETWEEN ? AND ? ORDER BY invoice_date, id', sc.from, sc.to) : db.all('SELECT * FROM receivables ORDER BY invoice_date, id')),
});
mgmt.get('/export', wrap(async (req, res) => {
  const q = scoped(exportScope(req.query));
  const [targets, monthly, sales, receivables] = await Promise.all([q.targets(), q.monthly(), q.sales(), q.receivables()]);
  res.json({ targets, monthly, sales, receivables });
}));

// ---------- 경영지원팀: 회사 양식 "경영지원 관리" (별도 탭 없이 모든 내려받기·업로드에 사용) ----------
// 회사 양식 엑셀 읽기 (업로드 미리보기). 반영은 /company/import
mgmt.post('/company/parse', wrap(async (req, res) => {
  const b64 = String(req.body?.file || '');
  if (!b64) throw new HttpError(400, '파일이 없습니다.');
  try {
    res.json({ sheets: await ledger.parseWorkbook(Buffer.from(b64, 'base64')) });
  } catch (e) {
    throw new HttpError(400, `엑셀 파일을 읽을 수 없습니다: ${e.message}`);
  }
}));
// 회사 양식 한 달 반영: 미수금 현황 → 미수금 관리, 매입·경비·기타 지출 → 월별실적 지출 칸
mgmt.post('/company/import', wrap(async (req, res) => {
  const b = req.body || {};
  if (!ledger.validMonth(b.month)) throw new HttpError(400, `기준월 형식은 YYYY-MM 이어야 합니다: ${b.month || '(빈 값)'}`);
  try {
    res.json(await ledger.importCompanyMonth(b.month, Array.isArray(b.entries) ? b.entries : [],
      { applyMonthly: b.applyMonthly !== false, applyReceivables: b.applyReceivables !== false }));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}));
// 모든 엑셀 내려받기 (회사 양식 서식)
//   kind=full      : 안내 + 기준월마다 회사 양식 + 연간목표·월별실적·매출내역·미수금 (year 있으면 그 해만)
//   kind=monthly   : year 의 기준월 회사 양식 + 연간목표·월별실적
//   kind=receivables: 이번 달 회사 양식(미수금 현황) + 미수금 상세 (open=1 미수 건만, q 검색)
//   kind=sales     : 매출내역 (year, q)
//   kind=targets   : 연간목표
mgmt.get('/xlsx', wrap(async (req, res) => {
  const kind = String(req.query.kind || 'full');
  const sc = exportScope(req.query);
  const src = scoped(sc);
  const q = String(req.query.q || '').trim().toLowerCase();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${p2(now.getMonth() + 1)}`;
  const like = (fields) => (r) => !q || fields.map((f) => String(r[f] ?? '')).join(' ').toLowerCase().includes(q);
  const sales = async () => (await src.sales()).filter(like(['customer', 'series', 'note']));
  const receivables = async () => (await db.all(`SELECT * FROM receivables ${req.query.open === '1' ? 'WHERE amount - collected > 0.5' : ''} ORDER BY invoice_date, id`))
    .filter(like(['customer']));
  const scopeName = sc ? sc.label.replace(/\s/g, '') : '전체';
  let spec;
  let label;
  if (kind === 'monthly') {
    spec = { months: await ledger.monthsWithData(sc), data: { targets: await src.targets(), monthly: await src.monthly() } };
    label = `월별실적_${scopeName}`;
  } else if (kind === 'receivables') {
    spec = { months: [thisMonth], data: { receivables: await receivables() } };
    label = `미수금_${thisMonth}`;
  } else if (kind === 'sales') {
    spec = { data: { sales: await sales() } };
    label = `매출내역_${scopeName}`;
  } else if (kind === 'targets') {
    spec = { data: { targets: await src.targets() } };
    label = '연간목표';
  } else {
    const months = await ledger.monthsWithData(sc);
    const rec = await src.receivables();
    const inScope = !sc || (thisMonth >= sc.from && thisMonth <= sc.to);
    if (!months.includes(thisMonth) && inScope && (await db.get('SELECT 1 FROM receivables LIMIT 1'))) months.push(thisMonth);
    spec = { guide: true, scope: sc, months: months.sort(), data: { targets: await src.targets(), monthly: await src.monthly(), sales: await sales(), receivables: rec } };
    label = scopeName;
  }
  const buf = await ledger.buildCompanyWorkbook(spec);
  const stampStr = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const name = `뉴토크코리아_경영지원관리_${label}${q ? `_${q}` : ''}_${stampStr}.xlsx`.replace(/[\\/:*?"<>|]/g, '');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(Buffer.from(buf));
}));

app.use('/api/mgmt', mgmt);

// ---------- 관리자: 사용자 / 권한 ----------
const admin = express.Router();
admin.use(requirePerm('admin'));

const adminCount = async (exceptId) => Number((await db.get('SELECT COUNT(*) AS n FROM users WHERE perm_admin = 1 AND active = 1 AND id <> ?', exceptId)).n);

admin.get('/users', wrap(async (req, res) => res.json((await db.all('SELECT * FROM users ORDER BY active DESC, dept, name')).map(publicUser))));

admin.post('/users', wrap(async (req, res) => {
  const b = req.body || {};
  const username = str(b.username);
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, '아이디는 영문/숫자 3~30자로 입력해 주세요.');
  if (!str(b.name)) throw new HttpError(400, '이름을 입력해 주세요.');
  if (!DEPTS.includes(b.dept)) throw new HttpError(400, '부서를 선택해 주세요.');
  if (String(b.password || '').length < 8) throw new HttpError(400, '초기 비밀번호는 8자 이상이어야 합니다.');
  if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(400, '이미 사용 중인 아이디입니다.');
  const p = { ...defaultPerms(b.dept), ...(b.perms || {}) };
  const r = await db.run(`INSERT INTO users (username, name, dept, password_hash, perm_mgmt, perm_production, perm_service, perm_admin)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, username, str(b.name), b.dept, hashPassword(b.password), ...PERMS.map((k) => (p[k] ? 1 : 0)));
  res.json(publicUser(await db.get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid)));
}));

admin.put('/users/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const u = await db.get('SELECT * FROM users WHERE id = ?', id);
  if (!u) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  const b = req.body || {};
  const name = b.name !== undefined ? str(b.name) : u.name;
  const dept = b.dept !== undefined ? b.dept : u.dept;
  if (!name) throw new HttpError(400, '이름을 입력해 주세요.');
  if (!DEPTS.includes(dept)) throw new HttpError(400, '부서를 선택해 주세요.');
  const perms = Object.fromEntries(PERMS.map((k) => [k, b.perms && k in b.perms ? (b.perms[k] ? 1 : 0) : u[`perm_${k}`]]));
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  if ((!perms.admin || !active) && u.perm_admin && u.active && (await adminCount(id)) === 0) {
    throw new HttpError(400, '마지막 관리자 권한은 해제할 수 없습니다.');
  }
  await db.run(`UPDATE users SET name=?, dept=?, perm_mgmt=?, perm_production=?, perm_service=?, perm_admin=?, active=? WHERE id=?`, name, dept, perms.mgmt, perms.production, perms.service, perms.admin, active, id);
  if (!active) await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json(publicUser(await db.get('SELECT * FROM users WHERE id = ?', id)));
}));

admin.post('/users/:id/reset-password', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const pw = String(req.body?.password || '');
  if (pw.length < 8) throw new HttpError(400, '비밀번호는 8자 이상이어야 합니다.');
  const r = await db.run('UPDATE users SET password_hash = ?, must_change_pw = 1 WHERE id = ?', hashPassword(pw), id);
  if (!r.changes) throw new HttpError(404, '사용자를 찾을 수 없습니다.');
  await db.run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ ok: true });
}));

// 화면 확인용 샘플 직원 (이름에 '(샘플)'). 이미 있는 아이디는 건너뜀
const SAMPLE_STAFF = [
  ['s.ceo', '박성훈(샘플)', '대표'],
  ['s.mgmt1', '김지현(샘플)', '경영지원팀'],
  ['s.mgmt2', '이수민(샘플)', '경영지원팀', { admin: 0 }],
  ['s.mgmt3', '정다은(샘플)', '경영지원팀', { admin: 0 }],
  ['s.dual1', '최민호(샘플)', '생산·서비스 겸직'],
  ['s.dual2', '강태윤(샘플)', '생산·서비스 겸직'],
  ['s.dual3', '윤서진(샘플)', '생산·서비스 겸직'],
  ['s.dual4', '한동욱(샘플)', '생산·서비스 겸직'],
  ['s.dual5', '조은비(샘플)', '생산·서비스 겸직'],
  ['s.prod1', '오재현(샘플)', '생산팀'],
  ['s.prod2', '서현우(샘플)', '생산팀', { mgmt: 1 }],
  ['s.svc1', '임채원(샘플)', '서비스팀'],
  ['s.svc2', '송유진(샘플)', '서비스팀', null, false],
];
const SAMPLE_PASSWORD = 'sample1234!';
app.post('/api/admin/sample-users', requirePerm('admin'), wrap(async (_req, res) => {
  let added = 0;
  for (const [username, name, dept, extra, active = true] of SAMPLE_STAFF) {
    if (await db.get('SELECT 1 FROM users WHERE username = ?', username)) continue;
    const p = { ...defaultPerms(dept), ...(extra || {}) };
    await db.run(`INSERT INTO users (username, name, dept, password_hash, perm_mgmt, perm_production, perm_service, perm_admin, active, must_change_pw)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    username, name, dept, hashPassword(SAMPLE_PASSWORD), ...PERMS.map((k) => (p[k] ? 1 : 0)), active ? 1 : 0);
    added += 1;
  }
  res.json({ added, total: SAMPLE_STAFF.length, password: SAMPLE_PASSWORD });
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
