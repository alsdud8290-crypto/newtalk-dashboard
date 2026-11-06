import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, nowStr } from './lib/db.js';
import {
  DEPTS, PERMS, ROLES, defaultPerms, normalizePerms, hashPassword, verifyPassword, newToken, parseCookies, publicUser,
} from './lib/auth.js';
import { summarize, resolvePeriod, PeriodError, INDUSTRIES, SALES_TYPES } from './lib/summary.js';
import { generateComment } from './lib/ai.js';
import * as ledger from './lib/ledger.js';
import * as stmt from './lib/statements.js';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as pricing from './lib/pricing.js';
import * as production from './lib/production.js';
import * as uploads from './lib/uploads.js';
import * as service from './lib/service.js';
import './lib/pdf-uploads.js'; // 수주서·출장보고서 PDF 업로드 규칙 등록
import './lib/order-uploads.js'; // 생산 데이터 업로드: 수주내역 엑셀 시트 규칙 등록
import './lib/part-uploads.js'; // 부품 단가 데이터(CSV)·신규 부품(엑셀) 업로드 규칙 등록
import './lib/service-upload.js'; // 서비스 데이터(출장보고서) 엑셀 업로드 규칙 등록

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

// 상태 확인: 저장소 종류만 알려 줌 (turso = 원격 DB 연결됨, local = 서버 재시작 시 초기화되는 파일)
app.get('/healthz', (_req, res) => res.json({ ok: true, storage: db.kind }));
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
// perm: 권한 이름 하나 또는 배열(그중 하나라도 있으면 통과)
const requirePerm = (perm) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, '로그인이 필요합니다.'));
  if (![].concat(perm).some((p) => req.user[`perm_${p}`])) return next(new HttpError(403, '이 메뉴에 대한 권한이 없습니다.'));
  next();
};
// 조회(GET)는 열람 권한으로 통과시키고, 입력·수정·삭제는 그 팀 수정 권한(팀장·경영지원팀·대표·관리자)이 있어야 한다
// except: 수정 권한 없이도 허용할 POST 경로 (예: AI 코멘트 다시 만들기 — 데이터를 바꾸지 않음)
const requireEditFor = (team, except = []) => (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || except.includes(req.path)) return next();
  if (!req.user?.[`perm_edit_${team}`]) return next(new HttpError(403, '수정 권한이 없습니다. 팀장 또는 관리자에게 요청해 주세요.'));
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
mgmt.use(requireEditFor('mgmt', ['/ai-comment']));

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
// 매출: 제품·상품·용역·영업외수익 / 지출: 상품 매입·판관비·영업외비용·원재료 매입·노무비·경비 / 미수금 총액(수기)
const MONTHLY_FIELDS = ['product_sales', 'goods_sales', 'service_sales', 'non_op_income',
  'product_purchase', 'sga_expense', 'non_op_expense', 'material_purchase', 'labor_cost', 'expense', 'receivables_total'];

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
//  예전 양식(광고선전비·접대비·그 외 지출 열)은 판관비로 합친다
function upsertMonthly(year, month, data) {
  const legacy = num(data.ad_expense) + num(data.entertainment_expense) + num(data.other_expense);
  if (legacy && !num(data.sga_expense)) data = { ...data, sga_expense: legacy };
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

// 손익계산서·제조원가명세서 → 월별 실적: 읽기(미리보기)와 반영(파일에 있는 칸만 그 달에 덮어씀)
mgmt.post('/statements/parse', wrap(async (req, res) => {
  const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 24) : [];
  if (!files.length) throw new HttpError(400, '파일이 없습니다.');
  res.json({ files: files.map((f) => {
    try {
      const list = stmt.parseStatements(Buffer.from(String(f.file || ''), 'base64'), str(f.name));
      return list.length ? list : [{ file: str(f.name), type: null, warnings: ['손익계산서·제조원가명세서가 아닙니다. 건너뜁니다.'] }];
    } catch (e) { return [{ file: str(f.name), type: null, warnings: [`파일을 읽을 수 없습니다: ${e.message}`] }]; }
  }).flat() });
}));
mgmt.post('/statements/apply', wrap(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const stmts = [];
  for (const it of items) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(it.month || ''));
    if (!m || +m[2] < 1 || +m[2] > 12) throw new HttpError(400, `기준월 형식은 YYYY-MM 이어야 합니다: ${it.month || '(빈 값)'}`);
    const fields = Object.keys(it.values || {}).filter((f) => MONTHLY_FIELDS.includes(f) && f !== 'receivables_total');
    if (!fields.length) continue;
    stmts.push([`INSERT INTO monthly (year, month, ${fields.join(', ')}, updated_at) VALUES (?, ?, ${fields.map(() => '?').join(', ')}, ?)
                 ON CONFLICT(year, month) DO UPDATE SET ${fields.map((f) => `${f} = excluded.${f}`).join(', ')}, updated_at = excluded.updated_at`,
    [+m[1], +m[2], ...fields.map((f) => num(it.values[f])), nowStr()]]);
    // 명세서의 모든 과목 행도 저장 → 내려받으면 올린 파일처럼 빈칸 없이 나옴
    const lines = Array.isArray(it.lines) ? it.lines.slice(0, 300).filter((r) => Array.isArray(r))
      .map((r) => [String(r[0] ?? '').slice(0, 100), ...[r[1], r[2]].map((v) => (v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)))]) : [];
    if (['pl', 'mc'].includes(it.type) && lines.length) {
      stmts.push([`INSERT INTO statement_lines (year, month, kind, lines, updated_at) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(year, month, kind) DO UPDATE SET lines = excluded.lines, updated_at = excluded.updated_at`,
      [+m[1], +m[2], it.type, JSON.stringify(lines), nowStr()]]);
    }
  }
  if (!stmts.length) throw new HttpError(400, '저장할 금액이 없습니다.');
  await db.batch(stmts);
  const names = items.map((it) => str(it.file)).filter(Boolean);
  await uploads.logSaved('mgmt_statement', names.join(', '), req.user, {
    rowCount: items.length, savedCount: stmts.length, note: items.map((it) => `${it.month} ${str(it.title)}`).join(', ') });
  res.json({ ok: true, count: stmts.length });
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

// 조회: from·to('YYYY-MM', 기간 조회) 또는 year
mgmt.get('/sales', wrap(async (req, res) => {
  const ym = /^\d{4}-(0[1-9]|1[0-2])$/;
  if (req.query.from || req.query.to) {
    const { from, to } = req.query;
    if (!ym.test(from || '') || !ym.test(to || '') || from > to) throw new HttpError(400, '기간은 시작월 ≤ 종료월(YYYY-MM)이어야 합니다.');
    return res.json(await db.all('SELECT * FROM sales WHERE substr(date,1,7) BETWEEN ? AND ? ORDER BY date DESC, id DESC', from, to));
  }
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
// 매출자료 CSV 올리기: 같은 원본 ID(없으면 판매번호)가 이미 있으면 새 값으로 덮어쓴다
mgmt.post('/sales/upsert', wrap(async (req, res) => {
  const list = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const errors = [];
  const rows = list.map((r, i) => {
    try {
      const key = str(r.ext_id) || (str(r.order_no) ? `SO:${str(r.order_no)}` : '');
      if (!key) throw new HttpError(400, 'ID와 판매번호가 모두 비어 있습니다.');
      return [...cleanSale(r), key, str(r.order_no), str(r.work_type), str(r.biz_type), str(r.export_type), str(r.end_client), str(r.project), str(r.brand)];
    } catch (e) { errors.push(`${str(r.file)} ${i + 1}번째 행: ${e.message}`); return null; }
  });
  if (errors.length) return res.status(400).json({ error: '매출자료에 오류가 있어 저장하지 않았습니다.', details: errors.slice(0, 50), total: errors.length });
  const keys = [...new Set(rows.map((r) => r[7]))];
  const existing = new Set();
  for (let i = 0; i < keys.length; i += 500) {
    const part = keys.slice(i, i + 500);
    (await db.all(`SELECT ext_id FROM sales WHERE ext_id IN (${part.map(() => '?').join(',')})`, ...part)).forEach((x) => existing.add(x.ext_id));
  }
  // 'NT-행번호' = 화면에서 직접 등록한 매출을 내려받은 것 → 그 원래 행을 덮어씀
  for (const k of keys) {
    const m = /^NT-(\d+)$/.exec(k);
    if (m && !existing.has(k) && await db.get("SELECT 1 FROM sales WHERE id = ? AND ext_id = ''", Number(m[1]))) existing.add(k);
  }
  const stmts = [];
  for (const r of rows) {
    const nt = /^NT-(\d+)$/.exec(r[7]);
    if (nt) stmts.push(["DELETE FROM sales WHERE id = ? AND ext_id = ''", [Number(nt[1])]]);
    stmts.push(['DELETE FROM sales WHERE ext_id = ?', [r[7]]]);
    stmts.push([`INSERT INTO sales (date, customer, industry, series, sales_type, amount, note, ext_id, order_no, work_type, biz_type, export_type, end_client, project, brand)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, r]);
  }
  await db.batch(stmts);
  const updated = keys.filter((k) => existing.has(k)).length;
  const files = [...new Set(list.map((r) => str(r.file)).filter(Boolean))];
  await uploads.logSaved('mgmt_sales_csv', files.join(', '), req.user, { rowCount: rows.length, savedCount: rows.length, note: `새로 ${keys.length - updated}건 · 덮어씀 ${updated}건` });
  res.json({ ok: true, inserted: keys.length - updated, updated });
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

// 업로드 이력에 남기기 (저장이 끝난 뒤 화면에서 한 번 부름): 파일 이름·읽은 행·저장 건수·요약
mgmt.post('/upload-log', wrap(async (req, res) => {
  const b = req.body || {};
  await uploads.logSaved('mgmt_excel', b.file_name, req.user, { rowCount: b.row_count, savedCount: b.saved_count, note: b.note });
  res.status(201).json({ ok: true });
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
      { applyMonthly: b.applyMonthly !== false, applyReceivables: b.applyReceivables !== false, sections: Array.isArray(b.sections) ? b.sections : null }));
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}));
// 모든 엑셀 내려받기 — 자료마다 회사에서 쓰는 형식 그대로
//   kind=monthly    : 월별 실적 → 달마다 손익계산서·제조원가명세서 (회계 프로그램 양식)
//   kind=sales      : 매출 내역 → 달마다 매출자료 (판매 관리 프로그램 CSV와 같은 열, q 검색)
//   kind=receivables: 미수금 → 경영지원 관리 회사 양식 (미수금 현황)
//   kind=full       : 위 세 가지 + 연간목표를 한 파일로 (경영 데이터 업로드에 그대로 다시 올릴 수 있음)
//   kind=template   : full 과 같은 구성의 빈 양식 (이번 달)
//   format=csv      : 시트마다 CSV 한 개, 여러 개면 ZIP
mgmt.get('/xlsx', wrap(async (req, res) => {
  const kind = String(req.query.kind || 'full');
  const sc = exportScope(req.query);
  const src = scoped(sc);
  const q = String(req.query.q || '').trim().toLowerCase();
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${p2(now.getMonth() + 1)}`;
  const like = (fields) => (r) => !q || fields.map((f) => String(r[f] ?? '')).join(' ').toLowerCase().includes(q);
  const sales = async () => (await src.sales()).filter(like(['customer', 'series', 'note', 'project', 'order_no', 'end_client']));
  const receivables = async () => (await db.all(`SELECT * FROM receivables ${req.query.open === '1' ? 'WHERE amount - collected > 0.5' : ''} ORDER BY invoice_date, id`))
    .filter(like(['customer']));
  const scopeName = sc ? sc.label.replace(/\s/g, '') : '전체';
  // 검색어 없이 받은 파일에는 '안내' 시트(기간 표시)를 넣어, 다시 올리면 그 기간만 교체되게 한다
  const guide = !q;
  // 기간을 고르면 그 기간의 달(이번 달까지)은 데이터가 없어도 회사 양식 시트를 넣는다 (빈 양식으로 작성할 수 있게)
  const scopeMonths = async () => {
    const set = new Set(await ledger.monthsWithData(sc));
    for (let m = sc.from; m <= sc.to && m <= thisMonth;) {
      set.add(m);
      const [yy, mm] = m.split('-').map(Number);
      m = mm === 12 ? `${yy + 1}-01` : `${yy}-${p2(mm + 1)}`;
    }
    return [...set].sort();
  };
  // 월·분기 파일에는 1년 단위 값인 연간목표를 넣지 않는다
  const targets = async () => (sc && sc.from.slice(5) === '01' && sc.to.slice(5) === '12' || !sc ? src.targets() : undefined);
  // 기간 안의 달 (이번 달까지, 데이터가 있는 달은 모두). 기간이 없으면 데이터가 있는 달
  const monthsOf = async () => {
    const set = new Set((await src.monthly()).map((r) => `${r.year}-${p2(r.month)}`));
    (await src.sales()).forEach((r) => set.add(r.date.slice(0, 7)));
    if (sc) for (const m of await scopeMonths()) set.add(m);
    if (!set.size) set.add(thisMonth);
    return [...set].sort();
  };
  const monthlyBy = async () => Object.fromEntries((await src.monthly()).map((r) => [`${r.year}-${p2(r.month)}`, r]));
  const salesBy = async () => (await sales()).reduce((m, r) => ((m[r.date.slice(0, 7)] ||= []).push(r), m), {});
  // 시트 목록 [이름, aoa, 쓰기 함수] — 엑셀·CSV 공통
  // 그 달에 올린 명세서가 있으면 과목 행 그대로 (key 'YYYY-MM|pl')
  const linesBy = async () => Object.fromEntries((await db.all('SELECT year, month, kind, lines FROM statement_lines'))
    .map((r) => [`${r.year}-${p2(r.month)}|${r.kind}`, JSON.parse(r.lines)]));
  const stmtSheets = (months, by, lb = {}) => months.flatMap((m) => ['pl', 'mc'].map((k) => [stmt.statementSheetName(k, m), stmt.statementAoa(k, m, by[m] || null, lb[`${m}|${k}`]),
    (ws) => stmt.writeStatementSheet(ws, k, m, by[m] || null, lb[`${m}|${k}`])]));
  const salesSheets = (months, by) => months.filter((m) => by[m]?.length || months.length === 1).map((m) => {
    const aoa = stmt.salesFileAoa(by[m] || []);
    return [stmt.salesSheetName(m), aoa, (ws) => stmt.writeAoaTable(ws, aoa, [14, 12, 14, 18, 9, 15, 26, 40, 26, 15], [10])];
  });
  const targetSheet = (rows) => {
    const aoa = [['연도', '목표매출액'], ...rows.map((r) => [r.year, r.revenue ?? ''])];
    return ['연간목표', aoa, (ws) => stmt.writeAoaTable(ws, aoa, [10, 20], [2])];
  };
  const stampStr0 = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const fname = (label, ext) => `뉴토크코리아_${label}${q ? `_${q}` : ''}_${stampStr0}.${ext}`.replace(/[\\/:*?"<>|]/g, '');
  // CSV: 시트 하나면 그 CSV, 여러 개면 ZIP
  const sendCsv = async (label, sheets) => {
    if (sheets.length === 1) return fileSend(res, `${sheets[0][0]}.csv`, 'text/csv; charset=utf-8', Buffer.from(stmt.aoaCsv(sheets[0][1]), 'utf8'));
    const zip = new JSZip();
    sheets.forEach(([name, aoa]) => zip.file(`${name}.csv`, stmt.aoaCsv(aoa)));
    return fileSend(res, fname(`${label}_CSV`, 'zip'), 'application/zip', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  };
  const sendSheets = async (label, sheets) => {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'NEWTORK 경영 대시보드';
    sheets.forEach(([name, , write]) => write(wb.addWorksheet(name)));
    return fileSend(res, fname(label, 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from(await wb.xlsx.writeBuffer()));
  };
  const csv = req.query.format === 'csv';
  if (kind === 'monthly') {
    const sheets = stmtSheets(await monthsOf(), await monthlyBy(), await linesBy());
    return csv ? sendCsv(`월별실적_${scopeName}`, sheets) : sendSheets(`손익계산서·제조원가명세서_${scopeName}`, sheets);
  }
  if (kind === 'sales') {
    const by = await salesBy();
    const sheets = salesSheets(sc ? (await monthsOf()).filter((m) => by[m]?.length) : Object.keys(by).sort(), by);
    if (!sheets.length) sheets.push([stmt.salesSheetName(sc ? sc.to : thisMonth), [stmt.SALES_FILE_HEAD], (ws) => stmt.writeAoaTable(ws, [stmt.SALES_FILE_HEAD], [14, 12, 14, 18, 9, 15, 26, 40, 26, 15])]);
    return csv ? sendCsv(`매출자료_${scopeName}`, sheets) : sendSheets(`매출자료_${scopeName}`, sheets);
  }
  let spec;
  let label;
  if (kind === 'full' || kind === 'template') {
    const tpl = kind === 'template';
    const months = tpl ? [thisMonth] : await monthsOf();
    const by = tpl ? {} : await monthlyBy();
    const sby = tpl ? {} : await salesBy();
    const tRows = tpl ? [{ year: now.getFullYear() }] : (await targets()) || [];
    // 미수금(경영지원 관리) 시트는 미수금 총액이 있거나 올려 둔 미수금 현황이 있는 달만 — 다시 올렸을 때 없던 달의 미수금이 생기지 않게
    //  기준은 월별 실적의 미수금 총액(화면에 보이는 값): 올려 둔 미수금 현황 행의 합계가 총액과 같으면 그 행 그대로,
    //  다르면(나중에 총액을 직접 고친 경우 등) 총액 한 줄 → 다시 올려도 미수금 총액이 바뀌지 않음. 총액이 없는 달은 넣지 않음
    const arMonths = tpl ? months : [];
    const arEntries = {};
    if (!tpl) {
      for (const m of months) {
        const total = Math.round(Number(by[m]?.receivables_total) || 0);
        if (!total) continue;
        const stored = (await ledger.getEntries(m)).filter((e) => e.section === 'ar' && e.name);
        const sum = Math.round(stored.reduce((a, e) => a + (Number(e.balance) || 0), 0));
        arMonths.push(m);
        arEntries[m] = stored.length && sum === total ? stored
          : [{ section: 'ar', grp: 'collected', code: '', name: '미수금 총액 (월별 실적 입력값)', balance: total, memo: '', red: 0 }];
      }
    }
    const sheets = [...(tpl || tRows.length ? [targetSheet(tRows)] : []), ...stmtSheets(months, by, tpl ? {} : await linesBy()), ...salesSheets(tpl ? months : months.filter((m) => sby[m]?.length), sby)];
    if (csv) {
      // 미수금(경영지원 관리 양식)은 CSV로는 표 하나로: 기준월·구분·코드·거래처명·잔액·적요
      const grp = { long: '장기 미수', collected: '당월 수금', scheduled: '수금 예정', normal: '' };
      for (const m of arMonths) {
        const ar = tpl ? [] : arEntries[m];
        if (ar.length || tpl) sheets.push([`미수금_${m.replace('-', '')}`, [['기준월', '구분', '코드', '거래처명', '잔액', '적요'], ...ar.map((e) => [m, grp[e.grp] ?? e.grp, e.code, e.name, e.balance, e.memo])]]);
      }
      return sendCsv(tpl ? '업로드양식' : `경영데이터_${scopeName}`, sheets);
    }
    spec = {
      guide: true, template: tpl, scope: sc, months: arMonths, arOnly: true, entries: arEntries,
      guideRows: [
        ...(sheets.some(([n]) => n === '연간목표') ? [['연간목표', '연도별 목표매출액(원). 목표매출액이 빈 행은 건너뜀']] : []),
        ['손익계산서_YYYYMM', '월별 손익계산서 (회계 프로그램 양식) → 제품·상품·용역 매출, 영업외수익, 상품 매입, 판관비, 영업외비용'],
        ['제조원가명세서_YYYYMM', '월별 제조원가명세서 (회계 프로그램 양식) → 원재료 매입, 노무비, 경비'],
        ['YYYY-MM', '경영지원 관리 (회사 양식) — 미수금 현황. 합계가 그 달 월별 실적의 미수금 총액'],
        ['매출자료_YYYYMM', '매출자료 (판매 관리 프로그램 CSV와 같은 열). 같은 *ID는 덮어씀'],
      ],
      guideNote: tpl ? '쓰는 시트만 채워 웹의 [경영 데이터 업로드]에 올리세요. 다른 달은 시트를 복사해 이름의 YYYYMM만 바꾸면 됩니다. 빈 시트는 건너뜁니다.'
        : '이 파일을 웹의 [경영 데이터 업로드]에 그대로 올리면 파일에 있는 달의 월별 실적·미수금 총액이 덮어써지고, 매출자료는 같은 *ID끼리 덮어씁니다.',
      extend: (wb) => sheets.forEach(([name, , write]) => write(wb.addWorksheet(name))),
    };
    label = tpl ? `업로드양식_${now.getFullYear()}` : `경영데이터_${scopeName}`;
  } else if (kind === 'receivables') {
    if (sc) {
      // 기간: 달마다 그 기간의 미수금 현황 + 그 기간에 청구된 건(미수·수금 완료 모두)
      const months = await scopeMonths();
      spec = { guide, scope: sc, months, arOnly: true, data: { receivables: (await src.receivables()).filter(like(['customer'])) } };
      label = `경영지원관리_미수금_${scopeName}`;
    } else {
      spec = { guide: guide && req.query.open !== '1', months: [thisMonth], arOnly: true, data: { receivables: await receivables() } };
      label = `경영지원관리_미수금_${thisMonth}`;
    }
  } else if (kind === 'targets') {
    spec = { data: { targets: await src.targets() } };
    label = '연간목표';
  } else {
    throw new HttpError(400, `알 수 없는 내려받기 종류: ${kind}`);
  }
  const buf = await ledger.buildCompanyWorkbook(spec);
  const stampStr = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const name = `뉴토크코리아_${label}${q ? `_${q}` : ''}_${stampStr}.xlsx`.replace(/[\\/:*?"<>|]/g, '');
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
  const role = ROLES.includes(b.role) ? b.role : '팀원';
  const p = normalizePerms({ ...defaultPerms(b.dept, role), ...(b.perms || {}) });
  const r = await db.run(`INSERT INTO users (username, name, dept, role, password_hash, ${PERMS.map((k) => `perm_${k}`).join(', ')})
                        VALUES (?, ?, ?, ?, ?, ${PERMS.map(() => '?').join(', ')})`, username, str(b.name), b.dept, role, hashPassword(b.password), ...PERMS.map((k) => p[k]));
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
  const role = ROLES.includes(b.role) ? b.role : (u.role || '팀원');
  const before = Object.fromEntries(PERMS.map((k) => [k, b.perms && k in b.perms ? (b.perms[k] ? 1 : 0) : u[`perm_${k}`]]));
  // 열람을 끄면 그 팀 수정도 끈다 (수정을 켜면 열람은 normalizePerms가 켠다)
  for (const t of ['mgmt', 'production', 'service']) if (b.perms && t in b.perms && !b.perms[t]) before[`edit_${t}`] = 0;
  const perms = normalizePerms(before);
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  if ((!perms.admin || !active) && u.perm_admin && u.active && (await adminCount(id)) === 0) {
    throw new HttpError(400, '마지막 관리자 권한은 해제할 수 없습니다.');
  }
  await db.run(`UPDATE users SET name=?, dept=?, role=?, ${PERMS.map((k) => `perm_${k}=?`).join(', ')}, active=? WHERE id=?`,
    name, dept, role, ...PERMS.map((k) => perms[k]), active, id);
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

// 부서·직책별 기본 권한 { 부서: { 팀원: {...}, 팀장: {...} } }
app.get('/api/admin/default-perms', requirePerm('admin'), (_req, res) => res.json(Object.fromEntries(DEPTS.map((d) => [d, Object.fromEntries(ROLES.map((r) => [r, defaultPerms(d, r)]))]))));
app.use('/api/admin', admin);

// ---------- 단가 (ITB2026에서 옮겨 옴) ----------
// 부품 단가(뉴토크 기준값·출장지별 단가): 서비스팀 열람 권한으로 조회, 부품 등록·기준값 수정은 서비스팀 수정 권한
const parts = express.Router();
parts.use(requirePerm('service'));
parts.use(requireEditFor('service'));
const fileSend = (res, name, type, buf) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.send(buf);
};
// 표 내려받기: 기본 엑셀(.xlsx), ?format=csv 이면 CSV (시트가 여러 개면 CSV들을 ZIP 하나로). base = 확장자 뺀 파일 이름
const sheetsSend = async (req, res, base, sheets) => {
  if (req.query.format === 'csv') {
    if (sheets.length === 1) return fileSend(res, `${base}.csv`, 'text/csv; charset=utf-8', pricing.sheetCsv(sheets[0]));
    return fileSend(res, `${base}_CSV.zip`, 'application/zip', await pricing.csvZip(sheets));
  }
  fileSend(res, `${base}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', await pricing.simpleWorkbook(sheets));
};
const q = (v) => String(v || '').trim();
parts.get('/catalog', wrap(async (req, res) => res.json(await pricing.catalogTable(q(req.query.q), q(req.query.category)))));
parts.get('/catalog/export', wrap(async (req, res) => sheetsSend(req, res, `부품단가_${nowStr().slice(0, 10)}`, await pricing.catalogSheets(q(req.query.q), q(req.query.category)))));
// 업로드 양식: ?kind=catalog(부품 단가 데이터·신규 부품) | company(출장지별 단가), ?format=csv 이면 CSV
parts.get('/template', wrap(async (req, res) => {
  const company = req.query.kind === 'company';
  const sheet = company
    ? ['출장지별 단가', [['파트넘버', 'a', 14], ['품목', 'b', 22], ['출장지', 'c', 18], ['단가', 'd', 12], ['적용 시작일', 'e', 13], ['비고', 'f', 24]],
      [{ a: 'VX-05-A-01', b: 'Motor', c: '가상정수센터', d: 500000, e: '2026-03-10', f: '' }]]
    : ['부품 단가', pricing.CATALOG_FIELDS.map(([, label], i) => [label, String(i), label === '품목' ? 24 : 16]),
      [{ 0: '05 MOTOR', 1: 'VX-05-A-01', 2: 'Motor', 3: 'NTI-01 ~ 03', 4: 500000 }]];
  await sheetsSend(req, res, company ? '출장지별단가_양식' : '부품단가_양식', [sheet]);
}));
parts.get('/companies', wrap(async (req, res) => res.json(await pricing.companyComparison(q(req.query.category)))));
parts.get('/companies/export', wrap(async (req, res) => sheetsSend(req, res, `출장지별단가비교_${nowStr().slice(0, 10)}`, await pricing.companySheets(q(req.query.category)))));
parts.get('/catalog/:id', wrap(async (req, res) => res.json(await pricing.catalogDetail(req.params.id))));
// 신규 부품 등록(한 건): 같은 파트넘버가 있으면 409 → overwrite: true로 다시 보내면 덮어씀
parts.post('/catalog', wrap(async (req, res) => res.status(201).json(await pricing.saveCatalogItem(req.body || {}))));
// 뉴토크 기준값(= 기준단가) 직접 고치기 (부품별 비교 표에서 두 번 눌러 입력)
parts.patch('/catalog/:id', wrap(async (req, res) => res.json(await pricing.setListPrice(req.params.id, req.body || {}))));
app.use('/api/parts', parts);

// ---------- 생산팀 (ITB2026에서 옮겨 옴) ----------
// 조회는 생산팀 열람 권한, 연간 목표 입력은 생산팀 수정 권한(팀장·경영지원팀·대표·관리자)
const prod = express.Router();
prod.use(requirePerm('production'));
prod.use(requireEditFor('production'));
const yearParam = (v) => intParam(v, 2000, 2100, '연도');
prod.get('/targets/:year', wrap(async (req, res) => res.json(await production.getTarget(yearParam(req.params.year)))));
prod.put('/targets/:year', wrap(async (req, res) => res.json(await production.setTarget(yearParam(req.params.year), req.body || {}))));
prod.get('/dashboard', wrap(async (req, res) => res.json(await production.dashboard(req.query))));
prod.get('/sales', wrap(async (req, res) => res.json(await production.salesSummary(req.query))));
prod.get('/serials', wrap(async (req, res) => res.json(await production.searchSerials(req.query.q))));
prod.get('/serials/:serial', wrap(async (req, res) => res.json(await production.serialDetail(req.params.serial))));
prod.get('/due-calendar', wrap(async (req, res) => res.json(await production.dueCalendar(req.query))));
prod.get('/due-calendar/search', wrap(async (req, res) => res.json(await production.searchDue(req.query.q))));
// 납기 캘린더 출고 처리(체크박스·실제 출고일) — 생산팀 수정 권한
prod.patch('/due-calendar/shipment', wrap(async (req, res) => res.json(await production.setShipment(req.body || {}))));
prod.get('/due-soon', wrap(async (_req, res) => res.json(await production.dueSoon())));
prod.get('/records', wrap(async (req, res) => res.json(await production.recordList(req.query))));
prod.get('/records/export', wrap(async (req, res) => {
  const { label, rows } = await production.recordExportRows(req.query);
  await sheetsSend(req, res, `제조내역_${label}`, [['제조내역', production.RECORD_COLUMNS, rows]]);
}));
prod.get('/orders', wrap(async (req, res) => res.json(await production.orderList(req.query))));
prod.get('/orders/export', wrap(async (req, res) => {
  const { label, rows } = await production.orderExportRows(req.query);
  await sheetsSend(req, res, `수주내역_${label}`, [['수주내역', production.ORDER_COLUMNS.map(([h, k, w]) => [h, k, w, k === 'item.quantity' ? 'won' : undefined]), rows]]);
}));
// 대시보드 엑셀(또는 ?format=csv → 시트별 CSV ZIP): ?period=2026 | 2026-Q3 | 2026-09 (+ 생산량 집계 기준 customer_basis·product_group)
const dashExport = (mod, prefix) => wrap(async (req, res) => {
  const { label, sheets } = await mod.dashboardSheets({ ...req.query, ...production.periodQuery(req.query.period) });
  await sheetsSend(req, res, `${prefix}_${label.replace(/\s+/g, '')}_${nowStr().slice(0, 10)}`, sheets);
});
prod.get('/dashboard/export', dashExport(production, '생산팀대시보드'));
prod.get('/years', wrap(async (_req, res) => res.json({ earliest_year: await production.earliestYear() })));
app.use('/api/production', prod);

// ---------- 서비스팀 (ITB2026에서 옮겨 옴) ----------
// 조회는 서비스팀 열람 권한. 보고서 입력은 서비스 데이터 엑셀 업로드(/api/uploads, 서비스팀 수정 권한)
const svc = express.Router();
svc.use(requirePerm('service'));
svc.use(requireEditFor('service'));
svc.get('/dashboard', wrap(async (req, res) => res.json(await service.dashboard(req.query))));
svc.get('/dashboard/export', dashExport(service, '서비스팀대시보드'));
svc.get('/reports', wrap(async (req, res) => res.json(await service.reportList(req.query))));
svc.get('/reports/:id', wrap(async (req, res) => res.json(await service.reportDetail(req.params.id))));
svc.get('/form-choices', wrap(async (_req, res) => res.json(await service.formChoices())));
app.use('/api/service', svc);

// 팀 업로드 (추출 → 확인·수정 → 저장). 권한은 파일 종류를 맡은 팀의 수정 권한으로 lib/uploads.js에서 확인
const up = express.Router();
up.use(requireLogin);
up.get('/', wrap(async (req, res) => res.json(await uploads.history(String(req.query.team || ''), req.user))));
up.post('/', wrap(async (req, res) => res.status(201).json(await uploads.createBatch(req.body || {}, req.user))));
up.patch('/:id', wrap(async (req, res) => res.json(await uploads.patchBatch(req.params.id, req.body || {}, req.user))));
up.post('/:id/confirm', wrap(async (req, res) => res.json(await uploads.confirmBatch(req.params.id, req.user))));
up.post('/:id/cancel', wrap(async (req, res) => res.json(await uploads.cancelBatch(req.params.id, req.user))));
app.use('/api/uploads', up);

// ---------- 에러 처리 ----------
app.use('/api', (_req, _res, next) => next(new HttpError(404, '없는 API입니다.')));
app.use((err, _req, res, _next) => {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? '서버 오류가 발생했습니다.' : err.message,
    ...(err.batch ? { batch: err.batch } : {}), ...(err.fields ? { fields: err.fields } : {}), ...(err.existing ? { existing: err.existing } : {}) });
});

app.listen(PORT, () => console.log(`뉴토크 코리아 경영 대시보드: http://localhost:${PORT}`));
// 처음 실행 때 한 번만 가상 데이터를 넣는다 (app_flags.virtual_seeded). 데이터를 지운 뒤 다시 켜도 가상 데이터는 돌아오지 않음
//  원격 DB(Turso)에서는 시간이 걸리므로 서버를 먼저 켜고 뒤에서 넣는다
(async () => {
  try {
    if (!(await db.get("SELECT 1 FROM app_flags WHERE key = 'virtual_seeded'"))) {
      // 예전 버전에서 이미 데이터가 들어간 DB는 가상 데이터를 더 넣지 않고 표시만 남김 (각 seed 함수가 표가 비어 있을 때만 넣음)
      await pricing.seedVirtualPricing();
      await production.seedVirtualProduction();
      await service.seedVirtualService();
      await db.run("INSERT OR IGNORE INTO app_flags (key, value) VALUES ('virtual_seeded', ?)", nowStr());
    }
    await service.backfillSerialKeys(); // 출장보고서 일련번호 → 제조내역 비교용 번호
  } catch (e) {
    console.error('[seed] 가상 데이터 넣기 실패', e);
  }
})();
