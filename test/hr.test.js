'use strict';
// اختبارات قسم الموظفين والمرتبات (للمدير فقط). الشهر المستخدم أكتوبر 2026:
// 1 أكتوبر = الخميس، الجمعة (الإجازة الأسبوعية) = 2 و9 و16 و23 و30.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { ensureSeed } = require('../server/bootstrap');

let server, base, db, adminPw;
const jar = {};
async function call(who, method, url, body) {
  const res = await fetch(base + '/api' + url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const login = (who, u, p) => call(who, 'POST', '/auth/login', { username: u, password: p });
const M = '2026-10';

test.before(async () => {
  db = openDb(':memory:');
  const app = createApp(db, { ...config, dbPath: ':memory:' });
  const first = await ensureSeed(db, { ...config, dbPath: '/tmp/4s-test-hr/x.db' }, app.locals.domain);
  adminPw = first.password;
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
  await login('a', 'admin', adminPw);
  await call('a', 'POST', '/auth/password', { current: adminPw, next: 'Manager2026ok' });
  const u = await call('a', 'POST', '/users', { username: 'cash9', name: 'كاشير', role: 'cashier' });
  await login('c', 'cash9', u.data.password);
  await call('c', 'POST', '/auth/password', { current: u.data.password, next: 'Cashier2026ok' });
});
test.after(() => { server.close(); });

test('المدير فقط يدخل على الموظفين والمرتبات (والكاشير والمحاسب ممنوعين)', async () => {
  for (const [m, url] of [['GET', '/hr/employees'], ['GET', '/hr/payroll'], ['GET', '/hr/summary'], ['GET', '/hr/advances'], ['PUT', '/hr/settings'], ['POST', '/hr/employees']]) {
    assert.equal((await call('c', m, url, m === 'GET' ? undefined : {})).status, 403, `${m} ${url}`);
  }
  // حتى لو منح المدير الكاشير كل الصلاحيات القابلة للمنح، صلاحية الموظفين لا تُمنح
  const list = await call('a', 'GET', '/users');
  const cash = list.data.items.find(x => x.username === 'cash9');
  await call('a', 'PUT', '/users/' + cash.id, { permissions: ['stats:read', 'customers:read', 'hr:manage', '*'] });
  assert.equal((await call('c', 'GET', '/hr/employees')).status, 403);
  assert.equal((await call('a', 'GET', '/hr/employees')).status, 200);
  const acc = await call('a', 'POST', '/users', { username: 'acc9', name: 'محاسب', role: 'accountant' });
  await login('k', 'acc9', acc.data.password);
  await call('k', 'POST', '/auth/password', { current: acc.data.password, next: 'Account2026ok' });
  assert.equal((await call('k', 'GET', '/hr/payroll')).status, 403);
});

let emp, emp2;
test('إضافة موظف والتحقق من المدخلات وحد السلف الافتراضي', async () => {
  assert.equal((await call('a', 'POST', '/hr/employees', { name: 'س', salary: 100 })).status, 422);
  assert.equal((await call('a', 'POST', '/hr/employees', { name: 'أحمد علي', salary: -5 })).status, 422);
  assert.equal((await call('a', 'POST', '/hr/employees', { name: 'أحمد علي', salary: 2600, phone: '123' })).status, 422);
  const r = await call('a', 'POST', '/hr/employees', { name: 'أحمد علي', jobTitle: 'مكوجي', salary: 2600, dailyHours: 8, phone: '01012345678', hireDate: '2026-01-01' });
  assert.equal(r.status, 201);
  emp = r.data;
  assert.equal(emp.advanceLimitEffective, 1300);          // 50٪ من المرتب
  assert.equal(emp.leaveAllowance, 21);
  const r2 = await call('a', 'POST', '/hr/employees', { name: 'منى سعيد', payType: 'hourly', salary: 20, dailyHours: 6, hireDate: '2026-01-01' });
  assert.equal(r2.status, 201);
  emp2 = r2.data;
  assert.equal(emp2.monthlyEquivalent, 20 * 6 * 26);
});

test('الحضور: تسجيل الساعات ورفض المستقبل والقيم الخاطئة', async () => {
  const day = await call('a', 'GET', `/hr/attendance?date=2026-10-01`);
  assert.equal(day.data.items.length, 2);
  assert.equal((await call('a', 'PUT', '/hr/attendance', { date: '2999-01-01', entries: [] })).status, 422);
  assert.equal((await call('a', 'PUT', '/hr/attendance', { date: '2026-10-01', entries: [{ employeeId: emp.id, hours: 30 }] })).status, 422);
  assert.equal((await call('a', 'PUT', '/hr/attendance', { date: '2026-10-01', entries: [{ employeeId: emp.id, hours: 10 }, { employeeId: emp2.id, hours: 6 }] })).status, 200);
  assert.equal((await call('a', 'PUT', '/hr/attendance', { date: '2026-10-03', entries: [{ employeeId: emp2.id, hours: 5.5 }] })).status, 200);
  const m = await call('a', 'GET', `/hr/attendance/month?month=${M}&employeeId=${emp2.id}`);
  assert.equal(m.data.totalHours, 11.5);
  assert.equal(m.data.days, 2);
  // مسح اليوم بإرسال null
  await call('a', 'PUT', '/hr/attendance', { date: '2026-10-03', entries: [{ employeeId: emp2.id, hours: null }] });
  assert.equal((await call('a', 'GET', `/hr/attendance/month?month=${M}&employeeId=${emp2.id}`)).data.totalHours, 6);
});

test('الإجازات: الرصيد والتقاطع واستبعاد الجمعة', async () => {
  const bad = b => call('a', 'POST', '/hr/leaves', { employeeId: emp.id, ...b });
  assert.equal((await bad({ type: 'weird', startDate: '2026-10-05' })).status, 422);
  assert.equal((await bad({ type: 'sick', startDate: '2026-10-09' })).status, 422);            // جمعة فقط
  assert.equal((await bad({ type: 'annual', startDate: '2026-10-05', endDate: '2026-12-31' })).status, 422); // مدة طويلة
  const un = await bad({ type: 'unpaid', startDate: '2026-10-05', endDate: '2026-10-06' });
  assert.equal(un.status, 201);
  assert.equal(un.data.days, 2);
  assert.equal((await bad({ type: 'sick', startDate: '2026-10-06' })).status, 409);              // تقاطع
  const annual = await bad({ type: 'annual', startDate: '2026-10-11', endDate: '2026-10-17' });  // 7 أيام منها جمعة 16
  assert.equal(annual.status, 201);
  assert.equal(annual.data.days, 6);
  // رصيد 21 يوم: المتبقي 15 → طلب 16 يوم مرفوض
  assert.equal((await bad({ type: 'annual', startDate: '2026-11-01', endDate: '2026-11-19' })).status, 422);
  const e = (await call('a', 'GET', '/hr/employees')).data.items.find(x => x.id === emp.id);
  assert.equal(e.leaveUsed, 6);
  assert.equal(e.leaveRemaining, 15);
  assert.equal((await call('a', 'DELETE', '/hr/leaves/' + annual.data.id)).status, 200);
});

test('الخصومات والمكافآت', async () => {
  const bad = b => call('a', 'POST', '/hr/adjustments', { employeeId: emp.id, ...b });
  assert.equal((await bad({ kind: 'deduction', amount: 0, reason: 'تأخير' })).status, 422);
  assert.equal((await bad({ kind: 'deduction', amount: 50 })).status, 422);                     // السبب مطلوب
  assert.equal((await bad({ kind: 'fine', amount: 50, reason: 'x' })).status, 422);
  assert.equal((await bad({ kind: 'deduction', amount: 50, reason: 'تأخير', date: '2026-10-10' })).status, 201);
  assert.equal((await bad({ kind: 'bonus', amount: 100, reason: 'مكافأة أداء', date: '2026-10-12' })).status, 201);
  assert.equal((await call('a', 'GET', `/hr/adjustments?month=${M}`)).data.items.length, 2);
});

let adv;
test('السلف: حد السلف وتخصيصه لكل موظف', async () => {
  const mk = b => call('a', 'POST', '/hr/advances', { employeeId: emp.id, ...b });
  assert.equal((await mk({ amount: 0 })).status, 422);
  assert.equal((await mk({ amount: 500, installment: 600 })).status, 422);                      // قسط أكبر من السلفة
  const over = await mk({ amount: 1400 });
  assert.equal(over.status, 422);
  assert.equal(over.data.error.code, 'advance_limit');
  assert.equal(over.data.error.available, 1300);
  const ok = await mk({ amount: 1000, installment: 400, date: '2026-10-08', note: 'ظرف طارئ' });
  assert.equal(ok.status, 201);
  adv = ok.data;
  assert.equal((await mk({ amount: 400 })).status, 422);                                         // المستحق 1000 + 400 > 1300
  assert.equal((await mk({ amount: 300 })).status, 201);                                         // يكمل الحد بالضبط
  // المدير يرفع الحد لهذا الموظف فقط
  assert.equal((await call('a', 'PUT', '/hr/employees/' + emp.id, { advanceLimit: 3000 })).data.advanceLimitEffective, 3000);
  assert.equal((await mk({ amount: 500 })).status, 201);
  // الرجوع للحد الافتراضي
  assert.equal((await call('a', 'PUT', '/hr/employees/' + emp.id, { advanceLimit: null })).data.advanceLimitEffective, 1300);
  // تغيير النسبة الافتراضية من الإعدادات
  assert.equal((await call('a', 'PUT', '/hr/settings', { advanceLimitPercent: 100 })).data.advanceLimitPercent, 100);
  assert.equal((await call('a', 'GET', '/hr/employees')).data.items.find(x => x.id === emp.id).advanceLimitEffective, 2600);
  await call('a', 'PUT', '/hr/settings', { advanceLimitPercent: 50 });
  assert.equal((await call('a', 'PUT', '/hr/settings', { advanceLimitPercent: 9999 })).status, 422);
});

test('كشف المرتبات: الحساب والاعتماد وخصم قسط السلفة', async () => {
  const pr = await call('a', 'GET', `/hr/payroll?month=${M}`);
  assert.equal(pr.status, 200);
  const a = pr.data.items.find(i => i.employeeId === emp.id);
  // مرتب 2600، ساعة = 12.5، إضافي ساعتان × 1.5 = 37.5، غياب بدون مرتب يومان × 100 = 200
  assert.equal(a.base, 2600);
  assert.equal(a.overtimeHours, 2);
  assert.equal(a.overtime, 37.5);
  assert.equal(a.unpaidDays, 2);
  assert.equal(a.unpaidLeave, 200);
  assert.equal(a.bonus, 100);
  assert.equal(a.deduction, 50);
  assert.equal(a.advance, 400);             // قسط السلفة الأولى (السلف الأخرى بلا قسط)
  assert.equal(a.net, 2600 + 37.5 + 100 - 50 - 200 - 400);
  const b = pr.data.items.find(i => i.employeeId === emp2.id);   // بالساعة: 6 ساعات × 20
  assert.equal(b.base, 120);
  assert.equal(b.net, 120);

  assert.equal((await call('a', 'POST', '/hr/payroll/approve', { month: '2999-01' })).status, 422);
  const ap = await call('a', 'POST', '/hr/payroll/approve', { month: M });
  assert.equal(ap.status, 200);
  assert.equal(ap.data.totals.paidCount, 2);
  assert.equal(ap.data.totals.pendingCount, 0);
  assert.equal((await call('a', 'POST', '/hr/payroll/approve', { month: M })).status, 409);       // لا اعتماد مزدوج

  // القسط اتخصم من السلفة
  const advs = (await call('a', 'GET', `/hr/advances?employeeId=${emp.id}`)).data.items;
  assert.equal(advs.find(x => x.id === adv.id).remaining, 600);
  // الشهر المعتمد مقفول للتعديلات
  assert.equal((await call('a', 'POST', '/hr/adjustments', { employeeId: emp.id, kind: 'deduction', amount: 10, reason: 'سبب تجريبي', date: '2026-10-20' })).status, 409);
  assert.equal((await call('a', 'DELETE', '/hr/leaves/' + (await call('a', 'GET', `/hr/leaves?employeeId=${emp.id}`)).data.items[0].id)).status, 409);

  // حذف الكشف يرجّع القسط
  const slip = ap.data.items.find(i => i.employeeId === emp.id);
  assert.equal((await call('a', 'DELETE', '/hr/payroll/' + slip.payrollId)).status, 200);
  assert.equal((await call('a', 'GET', `/hr/advances?employeeId=${emp.id}`)).data.items.find(x => x.id === adv.id).remaining, 1000);
  assert.equal((await call('a', 'GET', `/hr/payroll?month=${M}`)).data.items.find(i => i.employeeId === emp.id).status, 'pending');
});

test('سداد يدوي للسلفة وحذفها ومنع المبالغ الزائدة', async () => {
  assert.equal((await call('a', 'POST', `/hr/advances/${adv.id}/repay`, { amount: 5000 })).status, 422);
  const r = await call('a', 'POST', `/hr/advances/${adv.id}/repay`, { amount: 250 });
  assert.equal(r.status, 200);
  assert.equal(r.data.remaining, 750);
  assert.equal((await call('a', 'DELETE', '/hr/advances/' + adv.id)).status, 409);               // عليها سداد
  const open = (await call('a', 'GET', '/hr/advances?open=1')).data.items;
  const fresh = open.find(x => x.repayments === 0);
  assert.equal((await call('a', 'DELETE', '/hr/advances/' + fresh.id)).status, 200);
});

test('تعطيل الموظف يخرجه من الحضور والكشف الجديد، والعمليات في سجل التدقيق', async () => {
  await call('a', 'PUT', '/hr/employees/' + emp2.id, { active: false });
  assert.equal((await call('a', 'GET', '/hr/attendance?date=2026-10-20')).data.items.length, 1);
  assert.equal((await call('a', 'POST', '/hr/advances', { employeeId: emp2.id, amount: 10 })).status, 422);
  const audit = await call('a', 'GET', '/audit?pageSize=200');
  const actions = new Set(audit.data.items.map(x => x.action));
  for (const k of ['hr.employee_create', 'hr.advance_create', 'hr.payroll_approve', 'hr.payroll_delete', 'hr.leave_create', 'hr.deduction_create']) assert.ok(actions.has(k), k);
  const s = await call('a', 'GET', '/hr/summary');
  assert.equal(s.data.activeEmployees, 1);
});
