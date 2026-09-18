// Databas: SQLite (inbyggd i Node.js 22+). Filen ligger i data/chatt.db
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 3;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version < SCHEMA_VERSION) {
    // Äldre testversion av databasen: börja om med nytt schema.
    db.exec(`
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS sessions;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS users;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username        TEXT PRIMARY KEY,
      email           TEXT NOT NULL UNIQUE,
      display_name    TEXT NOT NULL,
      bio             TEXT NOT NULL DEFAULT '',
      avatar          TEXT,
      pass_hash       TEXT NOT NULL,
      salt            TEXT NOT NULL,
      verified        INTEGER NOT NULL DEFAULT 0,
      code_hash       TEXT,
      code_expires    INTEGER,
      code_attempts   INTEGER NOT NULL DEFAULT 0,
      code_sent_at    INTEGER,
      searchable      INTEGER NOT NULL DEFAULT 1,
      calls_from      TEXT NOT NULL DEFAULT 'everyone',
      read_receipts   INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      username   TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      id         TEXT PRIMARY KEY,
      owner      TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sender    TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      recipient TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      kind      TEXT NOT NULL DEFAULT 'text',
      text      TEXT,
      file_id   TEXT REFERENCES files(id) ON DELETE SET NULL,
      reply_to  INTEGER,
      edited_at TEXT,
      deleted   INTEGER NOT NULL DEFAULT 0,
      read_at   TEXT,
      time      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pair ON messages(sender, recipient, id);
    CREATE INDEX IF NOT EXISTS idx_recipient ON messages(recipient, id);
  `);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

module.exports = { openDb };
