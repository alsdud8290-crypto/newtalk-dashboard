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

function tursoDb() {
  const client = createClient({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN });
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
export const db = /^(libsql|https?|wss?):\/\//.test(tursoUrl) ? tursoDb() : localDb();

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
-- 금액·비율 중 소수가 있는 값은 TEXT(정확한 십진수 문자열)로 두고 decimal.js로 계산한다
-- 제품 가격 계산 기준값 (적용일별 한 줄, 가장 최근 적용일을 쓴다)
CREATE TABLE IF NOT EXISTS price_settings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_date        TEXT NOT NULL UNIQUE,
  exchange_rate         TEXT NOT NULL,
  customs_factor        TEXT NOT NULL,
  sga_rate              TEXT NOT NULL,
  margin                TEXT NOT NULL,
  special_discount_rate TEXT NOT NULL,
  price_round_unit      INTEGER NOT NULL DEFAULT 1000,
  commission_rate       TEXT NOT NULL,
  commission_unit       INTEGER NOT NULL DEFAULT 10000,
  margin_choices        TEXT NOT NULL DEFAULT '[]',
  note                  TEXT NOT NULL DEFAULT '',
  created_by            INTEGER,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS price_access_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS product_models (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name   TEXT NOT NULL UNIQUE,
  series       TEXT NOT NULL,
  assembly_usd TEXT NOT NULL,
  complete_usd TEXT,
  sale_price   INTEGER,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS product_options (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  price_usd  TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
-- 뉴토크 기준값 전체 기본값 (id=1 한 줄)
CREATE TABLE IF NOT EXISTS price_standard (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  default_discount_rate TEXT NOT NULL DEFAULT '0',
  default_extra_price   INTEGER NOT NULL DEFAULT 0,
  low_alert_rate        TEXT NOT NULL DEFAULT '10',
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- 부품 단가표 (파트넘버 + 품명으로 구분)
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
-- 단가표 개정 이력 (예전 견적은 견적 당시 단가표와 비교)
CREATE TABLE IF NOT EXISTS part_list_prices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id        INTEGER NOT NULL REFERENCES part_catalog(id) ON DELETE CASCADE,
  list_price     INTEGER,
  effective_date TEXT NOT NULL,
  UNIQUE (item_id, effective_date)
);
-- 출장지(업체)별 부품 단가 (직접 입력 또는 견적서). 바뀌면 덮어쓰지 않고 새 적용 시작일로 한 줄 추가
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
