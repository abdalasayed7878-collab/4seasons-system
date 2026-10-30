'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -64000;
  `);
  migrate(db);
  return db;
}

// يطبّق ملفات migrations/NNN_*.sql بالترتيب ويحفظ الإصدار في PRAGMA user_version
function migrate(db) {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  let current = db.prepare('PRAGMA user_version').get().user_version;
  for (const f of files) {
    const version = parseInt(f, 10);
    if (version <= current) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
      current = version;
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`فشل تطبيق ${f}: ${e.message}`);
    }
  }
}

// معاملة ذرّية: إمّا تنجح كل الخطوات أو لا يُحفظ شيء
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx };
