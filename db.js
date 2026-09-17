// Databas: SQLite-fil (inbyggd i Node.js). Allt sparas i data/chatt.db
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file = process.env.DB_PATH || path.join(__dirname, 'data', 'chatt.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username     TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      pass_hash    TEXT NOT NULL,
      salt         TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token    TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      sender    TEXT NOT NULL REFERENCES users(username),
      recipient TEXT NOT NULL REFERENCES users(username),
      text      TEXT NOT NULL,
      time      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pair ON messages(sender, recipient);
  `);
  return db;
}

module.exports = { openDb };
