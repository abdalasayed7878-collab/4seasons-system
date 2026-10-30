'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { seedCatalog } = require('./seed');
const A = require('./auth');
const U = require('./util');

// أول تشغيل: ينشئ الكتالوج ومديرًا بكلمة مرور عشوائية تُحفظ في ملف (تُجبر على تغييرها عند أول دخول)
async function ensureSeed(db, config, domain) {
  seedCatalog(db);
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return null;
  const { user, password } = await domain.createUser(null, { username: 'admin', name: 'المدير', role: 'manager' });
  const file = path.join(path.dirname(config.dbPath), 'FIRST_RUN_CREDENTIALS.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `اسم المستخدم: ${user.username}\nكلمة المرور المؤقتة: ${password}\n(سيُطلب منك تغييرها عند أول دخول. احذف هذا الملف بعدها.)\n`, { mode: 0o600 });
  return { username: user.username, password, file };
}

function backupNow(db, config, keep = 14) {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const stamp = U.dateInTz() + '_' + new Date().toISOString().slice(11, 19).replace(/:/g, '-');
  const file = path.join(config.backupDir, `4seasons-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(config.backupDir).filter(f => /^4seasons-.*\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(config.backupDir, f), { force: true });
  return file;
}

function startMaintenance(db, config) {
  const t1 = setInterval(() => {
    A.purgeExpiredSessions(db);
    // رموز التحقق مؤقتة: تُحذف بعد ساعة من انتهائها
    try { db.prepare('DELETE FROM customer_otps WHERE expires_at <= ?').run(new Date(Date.now() - 3600_000).toISOString()); } catch (e) { console.error('[otp] تنظيف:', e.message); }
  }, 30 * 60_000);
  let lastBackupDay = null;
  const t2 = setInterval(() => {
    const day = U.todayStr();
    if (day !== lastBackupDay) {
      try { backupNow(db, config); lastBackupDay = day; } catch (e) { console.error('[نسخ احتياطي] فشل:', e.message); }
    }
  }, 60 * 60_000);
  t1.unref(); t2.unref();
}

module.exports = { ensureSeed, backupNow, startMaintenance };
