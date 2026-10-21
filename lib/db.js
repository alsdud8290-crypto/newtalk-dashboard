import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(here, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'dashboard.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
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
CREATE TABLE IF NOT EXISTS ai_comments (
  key        TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// 최초 실행 시 관리자 계정 생성 (첫 로그인 때 비밀번호 변경 강제)
const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  // 운영(배포) 환경에서는 기본 비밀번호를 쓰지 않는다. 지정이 없으면 무작위로 만들어 서버 로그에만 남긴다.
  const isProd = process.env.NODE_ENV === 'production';
  const pw = process.env.INITIAL_ADMIN_PASSWORD || (isProd ? crypto.randomBytes(9).toString('base64url') : 'admin1234');
  db.prepare(`INSERT INTO users (username, name, dept, password_hash, perm_mgmt, perm_production, perm_service, perm_admin, must_change_pw)
              VALUES ('admin', '관리자', '관리자', ?, 1, 1, 1, 1, 1)`).run(hashPassword(pw));
  console.log(`[init] 관리자 계정 생성: admin / ${pw}  (첫 로그인 시 비밀번호 변경 필요)`);
}

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
