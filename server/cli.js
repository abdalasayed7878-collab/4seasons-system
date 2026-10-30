'use strict';
// أوامر إدارية: node server/cli.js <command>
const config = require('./config');
const { openDb } = require('./db');
const { createDomain } = require('./domain');
const { ensureSeed, backupNow } = require('./bootstrap');
const U = require('./util');

const [cmd, ...args] = process.argv.slice(2);
const flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : undefined; };

(async () => {
  const db = openDb(config.dbPath);
  const d = createDomain(db, config);
  await ensureSeed(db, config, d);
  switch (cmd) {
    case 'create-user': {
      const r = await d.createUser(null, { username: flag('username'), name: flag('name') || flag('username'), role: flag('role') || 'cashier' }, { password: flag('password') });
      console.log('تم إنشاء المستخدم:', r.user.username, '| الدور:', r.user.role, '| كلمة المرور المؤقتة:', r.password);
      break;
    }
    case 'reset-password': {
      const u = db.prepare('SELECT id FROM users WHERE username = ?').get(flag('username') || '');
      if (!u) throw new Error('المستخدم غير موجود');
      console.log('كلمة المرور المؤقتة الجديدة:', (await d.resetPassword(null, u.id)).password);
      break;
    }
    case 'list-users':
      console.table(d.listUsers().map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active })));
      break;
    case 'backup':
      console.log('تم حفظ نسخة في:', backupNow(db, config));
      break;
    case 'seed-demo': {
      const { seedDemo } = require('../scripts/seed-demo');
      seedDemo(db, d, { customers: +flag('customers') || 1000, orders: +flag('orders') || 4000 });
      break;
    }
    default:
      console.log('الأوامر: create-user --username u --name "الاسم" --role cashier|manager|accountant [--password p] | reset-password --username u | list-users | backup | seed-demo [--customers N --orders N]');
  }
  void U;
  db.close();
})().catch(e => { console.error('خطأ:', e.message); process.exit(1); });
