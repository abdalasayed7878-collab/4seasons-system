'use strict';
const config = require('./config');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { ensureSeed, startMaintenance } = require('./bootstrap');

(async () => {
  const db = openDb(config.dbPath);
  const app = createApp(db, config);
  const first = await ensureSeed(db, config, app.locals.domain);
  startMaintenance(db, config);

  const server = app.listen(config.port, config.host, () => {
    console.log(`4Seasons شغّال على http://localhost:${config.port}  (الكاشير: /app  |  الموقع: /)`);
    if (first) {
      console.log('\n=== أول تشغيل: بيانات دخول المدير ===');
      console.log(`  المستخدم:  ${first.username}`);
      console.log(`  كلمة المرور المؤقتة:  ${first.password}`);
      console.log(`  (محفوظة أيضًا في ${first.file})\n`);
    }
  });

  const stop = () => { server.close(() => { try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* ok */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch(e => { console.error(e); process.exit(1); });
