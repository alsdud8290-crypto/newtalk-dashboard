import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client/web';
import { hashPassword } from './auth.js';

// 저장소 두 가지를 같은 비동기 인터페이스로 감싼다.
//  - TURSO_DATABASE_URL 이 있으면 Turso(원격 SQLite, 무료 플랜) — 배포 서버에서 데이터 보존용
//  - 없으면 로컬 파일 data/dashboard.db (node:sqlite)
// 인터페이스: all / get / run / exec / batch(원자적 묶음 실행)

const here = path.dirname(fileURLToPath(import.meta.url));

function localDb() {
  const dir = process.env.DATA_DIR || path.join(here, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const raw = new DatabaseSync(path.join(dir, 'dashboard.db'));
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const run = (sql, args) => {
    const r = raw.prepare(sql).run(...args);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  };
  return {
    kind: 'local',
    all: async (sql, ...args) => raw.prepare(sql).all(...args),
    get: async (sql, ...args) => raw.prepare(sql).get(...args),
    run: async (sql, ...args) => run(sql, args),
    exec: async (sql) => raw.exec(sql),
    batch: async (stmts) => {
      raw.exec('BEGIN');
      try {
        const out = stmts.map(([sql, args = []]) => run(sql, args));
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

async function tursoDb() {
  // file: 주소는 이 컴퓨터에서 Turso와 같은 방식(libsql)으로 시험할 때만 쓴다
  const make = tursoUrl.startsWith('file:') ? (await import('@libsql/client')).createClient : createClient;
  const client = make({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN });
  const rows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
  const result = (rs) => ({ changes: rs.rowsAffected, lastInsertRowid: Number(rs.lastInsertRowid ?? 0) });
  return {
    kind: 'turso',
    all: async (sql, ...args) => rows(await client.execute({ sql, args })),
    get: async (sql, ...args) => rows(await client.execute({ sql, args }))[0],
    run: async (sql, ...args) => result(await client.execute({ sql, args })),
    exec: async (sql) => client.executeMultiple(sql),
    batch: async (stmts) => (stmts.length
      ? (await client.batch(stmts.map(([sql, args = []]) => ({ sql, args })), 'write')).map(result)
      : []),
  };
}

// 비어 있거나 'none' 같은 자리표시 값이면 Turso를 쓰지 않는다
const tursoUrl = (process.env.TURSO_DATABASE_URL || '').trim();
export const db = /^(libsql|https?|wss?):\/\/|^file:/.test(tursoUrl) ? await tursoDb() : localDb();

// 화면에 표시되는 시각은 서버 시간대(TZ, 배포 시 Asia/Seoul) 기준으로 앱에서 만든다
export function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  username        TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  dept            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  perm_mgmt       INTEGER NOT NULL DEFAULT 0,
  perm_production INTEGER NOT NULL DEFAULT 0,
  perm_service    INTEGER NOT NULL DEFAULT 0,
  perm_admin      INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  must_change_pw  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  year    INTEGER PRIMARY KEY,
  revenue REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS monthly (
  year                  INTEGER NOT NULL,
  month                 INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  product_purchase      REAL NOT NULL DEFAULT 0,
  material_purchase     REAL NOT NULL DEFAULT 0,
  expense               REAL NOT NULL DEFAULT 0,
  ad_expense            REAL NOT NULL DEFAULT 0,
  entertainment_expense REAL NOT NULL DEFAULT 0,
  other_expense         REAL NOT NULL DEFAULT 0,
  product_sales         REAL NOT NULL DEFAULT 0,
  goods_sales           REAL NOT NULL DEFAULT 0,
  service_sales         REAL NOT NULL DEFAULT 0,
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (year, month)
);
-- 올린 손익계산서(pl)·제조원가명세서(mc)의 과목 행 전부 (JSON [[과목, 세부, 합계], ...]) — 내려받을 때 그대로 쓴다
CREATE TABLE IF NOT EXISTS statement_lines (
  year       INTEGER NOT NULL,
  month      INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  lines      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (year, month, kind)
);
CREATE TABLE IF NOT EXISTS sales (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  customer   TEXT NOT NULL,
  industry   TEXT NOT NULL,
  series     TEXT NOT NULL DEFAULT '',
  sales_type TEXT NOT NULL DEFAULT '제품',
  amount     REAL NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);
CREATE TABLE IF NOT EXISTS receivables (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer       TEXT NOT NULL,
  invoice_date   TEXT NOT NULL,
  amount         REAL NOT NULL DEFAULT 0,
  collected      REAL NOT NULL DEFAULT 0,
  collected_date TEXT NOT NULL DEFAULT '',
  due_date       TEXT NOT NULL DEFAULT '',
  note           TEXT NOT NULL DEFAULT ''
);
-- 채권·채무 현황 (회사 양식 "경영지원 관리") — 기준월별 거래처 잔액
CREATE TABLE IF NOT EXISTS ledger (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  month   TEXT NOT NULL,
  section TEXT NOT NULL,
  grp     TEXT NOT NULL DEFAULT 'normal',
  code    TEXT NOT NULL DEFAULT '',
  name    TEXT NOT NULL DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,
  memo    TEXT NOT NULL DEFAULT '',
  red     INTEGER NOT NULL DEFAULT 0,
  sort    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ledger_month ON ledger(month);
-- ===== 단가 (ITB2026 생산·서비스 웹에서 옮겨 옴) =====
-- 부품 단가표. list_price = 기준단가 = 뉴토크 기준값 (화면에서 직접 수정, 신규 부품 등록·CSV 업로드는 파트넘버 기준 덮어쓰기)
-- discount_rate·extra_price는 예전 산식(할인율·추가단가)용으로 남은 칸 — 지금은 쓰지 않음
CREATE TABLE IF NOT EXISTS part_catalog (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  part_no         TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL,
  applies_to      TEXT NOT NULL DEFAULT '',
  list_price      INTEGER,
  list_price_date TEXT,
  discount_rate   TEXT,
  extra_price     INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (part_no, name)
);
-- 출장지(업체)별 부품 단가 (출장지별 단가 CSV 업로드). 같은 부품·출장지·적용 시작일이면 덮어쓰고, 날짜가 다르면 한 줄 추가
CREATE TABLE IF NOT EXISTS part_prices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  part_name       TEXT NOT NULL,
  catalog_item_id INTEGER REFERENCES part_catalog(id) ON DELETE SET NULL,
  unit_price      INTEGER NOT NULL,
  effective_date  TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  quote_no        TEXT NOT NULL DEFAULT '',
  quote_item      TEXT NOT NULL DEFAULT '',
  quote_company   TEXT NOT NULL DEFAULT '',
  quote_project   TEXT NOT NULL DEFAULT '',
  quote_note      TEXT NOT NULL DEFAULT '',
  created_by      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_part_prices_item ON part_prices(catalog_item_id, effective_date);
-- ===== 생산팀 (ITB2026에서 옮겨 옴) — 날짜는 'YYYY-MM-DD' 글자 =====
CREATE TABLE IF NOT EXISTS prod_targets (
  year            INTEGER PRIMARY KEY,
  target_quantity INTEGER NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- 제조내역: 엑셀 1행 = 제품 1대. 전체 일련번호(예: N82260001)로 구분
CREATE TABLE IF NOT EXISTS mfg_records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_full       TEXT NOT NULL UNIQUE,
  serial_short      TEXT NOT NULL,
  model_name        TEXT NOT NULL DEFAULT '',
  bush_machining    TEXT NOT NULL DEFAULT '',
  rpm               TEXT NOT NULL DEFAULT '',
  power             TEXT NOT NULL DEFAULT '',
  manufactured_date TEXT,
  inspection_date   TEXT,
  inspection_no     TEXT NOT NULL DEFAULT '',
  po_no             TEXT NOT NULL DEFAULT '',
  so_no             TEXT NOT NULL DEFAULT '',
  customer_order_no TEXT NOT NULL DEFAULT '',
  customer          TEXT NOT NULL DEFAULT '',
  final_orderer     TEXT NOT NULL DEFAULT '',
  project_name      TEXT NOT NULL DEFAULT '',
  due_date          TEXT,
  shipped_date      TEXT,
  note              TEXT NOT NULL DEFAULT '',
  source_sheet      TEXT NOT NULL DEFAULT '',
  created_by        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mfg_short ON mfg_records(serial_short);
CREATE INDEX IF NOT EXISTS idx_mfg_made ON mfg_records(manufactured_date);
CREATE INDEX IF NOT EXISTS idx_mfg_due ON mfg_records(due_date);
-- 수주서 (PDF 1장 = 1건, 판매번호로 구분) + 제품정보
CREATE TABLE IF NOT EXISTS sales_orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_no          TEXT NOT NULL UNIQUE,
  order_no          TEXT NOT NULL DEFAULT '',
  order_doc_no      TEXT NOT NULL DEFAULT '',
  order_date        TEXT,
  business_type_raw TEXT NOT NULL DEFAULT '',
  industry          TEXT NOT NULL,
  customer          TEXT NOT NULL DEFAULT '',
  final_orderer     TEXT NOT NULL DEFAULT '',
  project_name      TEXT NOT NULL DEFAULT '',
  delivery_date     TEXT,
  due_date          TEXT,
  note              TEXT NOT NULL DEFAULT '',
  created_by        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sales_order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  power        TEXT NOT NULL DEFAULT '',
  flange       TEXT NOT NULL DEFAULT '',
  rpm_ot       TEXT NOT NULL DEFAULT '',
  stem_bush    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_soi_order ON sales_order_items(order_id);
-- ===== 서비스팀 (ITB2026에서 옮겨 옴) — 출장보고서 1건 = 출장 1회 =====
CREATE TABLE IF NOT EXISTS trip_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date        TEXT NOT NULL,
  end_date          TEXT,
  extra_trip        TEXT NOT NULL DEFAULT '',
  paid_type         TEXT NOT NULL,
  requester_type    TEXT NOT NULL DEFAULT '',
  requester         TEXT NOT NULL,
  region            TEXT NOT NULL,
  district          TEXT NOT NULL DEFAULT '',
  work_type         TEXT NOT NULL DEFAULT '',
  purpose           TEXT NOT NULL DEFAULT '',
  fault_description TEXT NOT NULL DEFAULT '',
  work_description  TEXT NOT NULL DEFAULT '',
  work_result       TEXT NOT NULL DEFAULT '',
  author            TEXT NOT NULL,
  input_method      TEXT NOT NULL DEFAULT 'pdf',
  created_by        INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_trip_start ON trip_reports(start_date);
CREATE TABLE IF NOT EXISTS trip_companions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES trip_reports(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id     INTEGER NOT NULL REFERENCES trip_reports(id) ON DELETE CASCADE,
  model_name    TEXT NOT NULL,
  spec          TEXT NOT NULL DEFAULT '',
  serial_no_raw TEXT NOT NULL DEFAULT '',
  quantity      INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS trip_parts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES trip_reports(id) ON DELETE CASCADE,
  part_name TEXT NOT NULL,
  quantity  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trip_comp ON trip_companions(report_id);
CREATE INDEX IF NOT EXISTS idx_trip_prod ON trip_products(report_id);
CREATE INDEX IF NOT EXISTS idx_trip_part ON trip_parts(report_id);
-- 요청처 → 시·도·시·군 대응표 (입력·업로드 때 고른 값을 기억해 다음부터 자동으로 채움)
CREATE TABLE IF NOT EXISTS requester_regions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  requester TEXT NOT NULL UNIQUE,
  region    TEXT NOT NULL,
  district  TEXT NOT NULL DEFAULT ''
);
-- 업로드 기록: 업로드 → 추출 → 사람이 확인·수정 → 저장/취소. 원본 파일은 보관하지 않고 추출 결과(JSON)만
CREATE TABLE IF NOT EXISTS upload_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'extracted',
  data        TEXT NOT NULL DEFAULT '{}',
  saved_count INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS ai_comments (
  key        TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

await db.exec(SCHEMA);
// 기존 DB에 새 열 추가 (이미 있으면 무시): 미수금 거래처 코드 — 회사 양식의 코드(A열)
try { await db.exec("ALTER TABLE receivables ADD COLUMN code TEXT NOT NULL DEFAULT ''"); } catch { /* 이미 있음 */ }

// 월별 실적 항목 개편 (손익계산서·제조원가명세서 기준): 영업외수익·판관비·영업외비용·노무비 + 수기 입력 미수금 총액
//  예전 광고선전비·접대비·그 외 지출은 판관비로 옮기고 0으로 비운다 (열은 남겨 둠, 한 번만 옮겨짐)
for (const col of ['non_op_income', 'sga_expense', 'non_op_expense', 'labor_cost', 'receivables_total']) {
  try { await db.exec(`ALTER TABLE monthly ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`); } catch { /* 이미 있음 */ }
}
await db.exec(`UPDATE monthly SET sga_expense = sga_expense + ad_expense + entertainment_expense + other_expense,
               ad_expense = 0, entertainment_expense = 0, other_expense = 0
               WHERE ad_expense <> 0 OR entertainment_expense <> 0 OR other_expense <> 0`);
// 매출자료 CSV 업로드: 원본 ID(같은 ID를 다시 올리면 덮어씀)와 판매번호·작업 구분·사업 구분·수출 구분·최종발주처·사업명
for (const col of ['ext_id', 'order_no', 'work_type', 'biz_type', 'export_type', 'end_client', 'project']) {
  try { await db.exec(`ALTER TABLE sales ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`); } catch { /* 이미 있음 */ }
}
await db.exec("CREATE INDEX IF NOT EXISTS idx_sales_ext ON sales(ext_id)");
// 산업 분야: 가스·오일·석유를 매출자료 CSV의 사업 구분처럼 하나로 묶음
await db.exec("UPDATE sales SET industry = '가스·오일·석유화학' WHERE industry IN ('가스', '오일', '석유')");

// 권한 세분화 (팀별 열람/수정 + 직책). 새로 만든 열이면 기존 사용자 값을 채운다:
// 경영지원팀·대표·관리자는 가진 열람 권한만큼 수정도 켜고, 생산·서비스는 팀원(열람만)으로 둔다
let addedEdit = false;
for (const col of ["role TEXT NOT NULL DEFAULT '팀원'", 'perm_edit_mgmt INTEGER NOT NULL DEFAULT 0', 'perm_edit_production INTEGER NOT NULL DEFAULT 0', 'perm_edit_service INTEGER NOT NULL DEFAULT 0']) {
  try { await db.exec(`ALTER TABLE users ADD COLUMN ${col}`); if (col.startsWith('perm_edit_mgmt')) addedEdit = true; } catch { /* 이미 있음 */ }
}
if (addedEdit) {
  await db.exec(`UPDATE users SET perm_edit_mgmt = perm_mgmt, perm_edit_production = perm_production, perm_edit_service = perm_service
                 WHERE dept IN ('경영지원팀', '대표', '관리자')`);
}

// 최초 실행 시 관리자 계정 생성 (첫 로그인 때 비밀번호 변경 강제)
const userCount = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
if (Number(userCount) === 0) {
  // 운영(배포) 환경에서는 기본 비밀번호를 쓰지 않는다. 지정이 없으면 무작위로 만들어 서버 로그에만 남긴다.
  const isProd = process.env.NODE_ENV === 'production';
  const pw = process.env.INITIAL_ADMIN_PASSWORD || (isProd ? crypto.randomBytes(9).toString('base64url') : 'admin1234');
  await db.run(`INSERT INTO users (username, name, dept, password_hash, perm_mgmt, perm_production, perm_service, perm_admin,
                  perm_edit_mgmt, perm_edit_production, perm_edit_service, must_change_pw)
                VALUES ('admin', '관리자', '관리자', ?, 1, 1, 1, 1, 1, 1, 1, 1)`, hashPassword(pw));
  console.log(`[init] 관리자 계정 생성: admin / ${pw}  (첫 로그인 시 비밀번호 변경 필요)`);
}
console.log(`[db] 저장소: ${db.kind === 'turso' ? 'Turso (원격, 데이터 보존)' : '로컬 파일'}`);
