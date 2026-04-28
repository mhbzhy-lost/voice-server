const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(process.cwd(), 'voice.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Idempotent migration: add nickname column if missing
const userColumns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userColumns.includes('nickname')) {
  db.exec("ALTER TABLE users ADD COLUMN nickname TEXT");
  db.exec("UPDATE users SET nickname = username WHERE nickname IS NULL");
}

// Seed superadmin account if not exists
const saPassword = process.env.SUPERADMIN_PASSWORD || 'superadmin123';
const saHash = bcrypt.hashSync(saPassword, 10);
db.prepare(`INSERT OR IGNORE INTO users (username, password, role, nickname) VALUES (?, ?, ?, ?)`).run('superadmin', saHash, 'superadmin', 'superadmin');

module.exports = { db, SUPERADMIN_PASSWORD: saPassword };
