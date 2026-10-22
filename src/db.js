const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'meals.db');
if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_no     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin','kiosk')),
  club          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS meals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('breakfast','lunch','dinner')),
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price       INTEGER NOT NULL CHECK (price BETWEEN 500 AND 2000 AND price % 100 = 0),
  hidden      INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS meals_date ON meals(date);

CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  meal_id        INTEGER NOT NULL REFERENCES meals(id),
  date           TEXT NOT NULL,
  type           TEXT NOT NULL,
  price          INTEGER NOT NULL,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('now','salary')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('paid','due')),
  pickup_status  TEXT NOT NULL DEFAULT 'booked' CHECK (pickup_status IN ('booked','picked','no_show','cancelled')),
  picked_at      TEXT,
  club           TEXT,
  pickup_mode    TEXT CHECK (pickup_mode IN ('takeaway','dinein')),
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_per_meal
  ON bookings(user_id, date, type) WHERE pickup_status <> 'cancelled';
CREATE INDEX IF NOT EXISTS bookings_date ON bookings(date);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  date       TEXT NOT NULL,
  method     TEXT NOT NULL,
  admin_id   INTEGER REFERENCES users(id),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  phone      TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phone      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS login_attempts (
  member_no    TEXT PRIMARY KEY COLLATE NOCASE,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER,
  action     TEXT NOT NULL,
  details    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  clubs: 'نادي 1,نادي 2,نادي 3,نادي 4,نادي 5',
  cutoff_time: '23:59',
  reminder_time: '21:00',
  breakfast_window: '06:00-10:00',
  lunch_window: '11:30-15:00',
  dinner_window: '18:00-22:00',
  allow_cancel: '0',
  reminder_template:
    'مرحبًا {name}، لم تحجز وجبات الغد ({date}) بعد. يُغلق الحجز الساعة {cutoff} مساءً. احجز الآن: {link}',
  site_url: process.env.SITE_URL || 'http://localhost:3000',
  last_reminder_date: '',
  last_noshow_date: '',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key];
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function allSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function clubs() {
  return getSetting('clubs').split(',').map((s) => s.trim()).filter(Boolean);
}

// Creates the built-in admin and kiosk accounts on first run.
function ensureSystemAccounts() {
  const accounts = [
    { member_no: 'admin', name: 'المشرف', role: 'admin', password: process.env.ADMIN_PASSWORD || 'admin12345' },
    { member_no: 'kiosk', name: 'شاشة الاستلام', role: 'kiosk', password: process.env.KIOSK_PASSWORD || 'kiosk12345' },
  ];
  for (const a of accounts) {
    const exists = db.prepare('SELECT id FROM users WHERE member_no = ?').get(a.member_no);
    if (!exists) {
      db.prepare('INSERT INTO users (member_no, name, password_hash, role) VALUES (?, ?, ?, ?)')
        .run(a.member_no, a.name, bcrypt.hashSync(a.password, 10), a.role);
      console.log(`[setup] تم إنشاء حساب ${a.name}: ${a.member_no} / ${a.password} — غيّر كلمة المرور بعد أول دخول.`);
    }
  }
}
ensureSystemAccounts();

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function audit(adminId, action, details = '') {
  db.prepare('INSERT INTO audit_log (admin_id, action, details) VALUES (?, ?, ?)')
    .run(adminId, action, typeof details === 'string' ? details : JSON.stringify(details));
}

module.exports = { db, tx, getSetting, setSetting, allSettings, clubs, audit };
