'use strict';
// اختبارات «العميل السابق»: التحقق بالكود/الهاتف، رمز التحقق، تعديل البيانات، الطلبات المتكررة، وحدود الأمان
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const config = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { ensureSeed } = require('../server/bootstrap');

// كل مجموعة اختبارات بتاخد تطبيق جديد (فبيبدأ عدّاد تحديد المعدل من صفر)
async function makeApp(extra = {}) {
  const db = openDb(':memory:');
  const app = createApp(db, { ...config, dbPath: ':memory:', otpWebhookUrl: '', ...extra });
  const domain = app.locals.domain;
  const first = await ensureSeed(db, { ...config, dbPath: '/tmp/4s-test-first-ret/x.db' }, domain);
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const jar = {};
  const call = async (who, method, url, body) => {
    const res = await fetch(base + '/api' + url, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jar[who] = sc.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const staff = async (who, username, role, pw) => {
    if (who === 'a') {
      await call('a', 'POST', '/auth/login', { username: 'admin', password: first.password });
      await call('a', 'POST', '/auth/password', { current: first.password, next: 'Manager2026ok' });
      return;
    }
    const r = await call('a', 'POST', '/users', { username, name: username, role });
    await call(who, 'POST', '/auth/login', { username, password: r.data.password });
    await call(who, 'POST', '/auth/password', { current: r.data.password, next: pw });
  };
  await staff('a');
  await staff('c', 'cash1', 'cashier', 'Cashier2026ok');
  await staff('k', 'acc1', 'accountant', 'Account2026ok');
  const pub = (path, body) => call('p', 'POST', '/public' + path, body);
  return { db, domain, server, base, call, pub, close: () => server.close() };
}

const GOOD_REQ = { serviceType: 'carpet', prefTime: '12 مساءً - 2 مساءً', elapsedMs: 9000 };

test('عميل سابق بالكود + آخر 4 أرقام: لا تسريب قبل التحقق، ثم تظهر كل بياناته', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'منى أحمد', phone: '01012345678', address: 'حدائق أكتوبر مجاورة 4 عمارة 7' });
  A.db.prepare(`INSERT INTO orders (code,customer_id,status,items_summary,subtotal_cents,total_cents,paid_cents,created_date,created_at,updated_at)
    VALUES ('4S-1001',?,'delivered','بطانية',12000,12000,10000,'2026-10-01','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z')`).run(c.id);

  assert.equal((await A.pub('/customer/lookup', { term: 'abc' })).status, 422);
  assert.equal((await A.pub('/customer/lookup', { term: '4S-C-999999' })).status, 404);

  // الكود بأي صيغة (حروف صغيرة / بدون شرطات / أرقام عربية)
  for (const term of [c.code, c.code.toLowerCase(), '4SC000' + '٠٠١'.replace(/٠/g, '0') + '', '4S-C-1']) {
    const r = await A.pub('/customer/lookup', { term });
    assert.equal(r.status, 200, term);
    assert.deepEqual(r.data, { method: 'code' });      // لا اسم ولا هاتف قبل التحقق
  }

  const bad = await A.pub('/customer/verify', { term: c.code, last4: '0000' });
  assert.equal(bad.status, 403);
  assert.ok(!JSON.stringify(bad.data).includes('منى'));
  assert.equal((await A.pub('/customer/verify', { term: c.code })).status, 403);

  const ok = await A.pub('/customer/verify', { term: c.code, last4: '٥٦٧٨' });   // أرقام عربية مقبولة
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.customer.name, 'منى أحمد');
  assert.equal(ok.data.customer.phone, '01012345678');
  assert.equal(ok.data.customer.address, 'حدائق أكتوبر مجاورة 4 عمارة 7');
  assert.equal(ok.data.customer.code, c.code);
  assert.equal(ok.data.customer.balance, 20);
  assert.equal(ok.data.customer.orders.length, 1);
  assert.equal(ok.data.customer.orders[0].code, '4S-1001');
  assert.ok(!('notes' in ok.data.customer));            // ملاحظات الكاشير الداخلية لا تظهر
});

test('قفل المحاولات الخاطئة على نفس الحساب (حتى لو الكود الصحيح بعد القفل)', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'سارة', phone: '01112223334', address: 'الشيخ زايد' });
  for (let i = 0; i < 5; i++) assert.equal((await A.pub('/customer/verify', { term: c.code, last4: '000' + i })).status, 403);
  const locked = await A.pub('/customer/verify', { term: c.code, last4: '3334' });
  assert.equal(locked.status, 429);
  assert.equal(locked.data.error.code, 'locked');
  assert.ok(A.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'customer.verify_fail'").get().n >= 5);
});

test('نسي الكود: الهاتف يظهر مقنّعًا فقط + رمز تحقق يصل للكاشير', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'هدى علي', phone: '01234567891', address: 'دريم لاند' });

  const look = await A.pub('/customer/lookup', { term: '+20 123 456 7891' });
  assert.equal(look.data.method, 'otp');
  assert.equal(look.data.hint.phone, '012*****891');
  assert.equal(look.data.hint.name, 'هدى ع***');
  assert.ok(!JSON.stringify(look.data).includes('دريم'));        // العنوان لا يظهر قبل التحقق

  assert.equal((await A.pub('/customer/otp', { term: c.code })).status, 422);                    // الكود لا يحتاج OTP
  assert.equal((await A.pub('/customer/verify', { term: c.phone, otp: '123456' })).status, 403); // لا يوجد كود مطلوب بعد

  const req = await A.pub('/customer/otp', { term: c.phone });
  assert.equal(req.status, 200);
  assert.equal(req.data.automatic, false);

  // الكاشير يرى الكود، والمحاسب لا
  assert.equal((await A.call('k', 'GET', '/otps')).status, 403);
  const list = await A.call('c', 'GET', '/otps');
  assert.equal(list.status, 200);
  assert.equal(list.data.items.length, 1);
  const item = list.data.items[0];
  assert.match(item.otp, /^\d{6}$/);
  assert.equal(item.phone, c.phone);
  assert.equal(item.delivered, false);
  assert.equal((await A.call('c', 'GET', '/stats')).data.pendingOtps, 1);

  // كود خاطئ ثم صحيح
  const wrong = await A.pub('/customer/verify', { term: c.phone, otp: item.otp === '111111' ? '222222' : '111111' });
  assert.equal(wrong.status, 403);
  assert.match(wrong.data.error.message, /متبقي 4/);
  const ok = await A.pub('/customer/verify', { term: c.phone, otp: item.otp });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.customer.address, 'دريم لاند');
  // الكود يُستخدم مرة واحدة
  assert.equal((await A.pub('/customer/verify', { term: c.phone, otp: item.otp })).status, 403);
  assert.equal((await A.call('c', 'GET', '/otps')).data.items.length, 0);
});

test('رمز التحقق: 5 محاولات ثم يُلغى، وطلب جديد يُبطل القديم، وحد 3 طلبات في الساعة', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'ريم', phone: '01551112223', address: 'أكتوبر الجديدة' });
  await A.pub('/customer/otp', { term: c.phone });
  const first = (await A.call('c', 'GET', '/otps')).data.items[0].otp;
  const wrong = first === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await A.pub('/customer/verify', { term: c.phone, otp: wrong })).status, 403);
  const dead = await A.pub('/customer/verify', { term: c.phone, otp: first });   // حتى الكود الصحيح بعد 5 أخطاء مرفوض
  assert.equal(dead.status, 403);
  assert.equal(dead.data.error.code, 'otp_expired');

  await A.pub('/customer/otp', { term: c.phone });
  await A.pub('/customer/otp', { term: c.phone });
  const items = (await A.call('c', 'GET', '/otps')).data.items;
  assert.equal(items.length, 1);                                                  // الأحدث فقط
  const limited = await A.pub('/customer/otp', { term: c.phone });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'otp_limit');
});

test('الكاشير يعلّم الكود «تم الإرسال» فيختفي من العدّاد', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'نورهان', phone: '01099887766', address: 'الشيخ زايد' });
  await A.pub('/customer/otp', { term: c.phone });
  const id = (await A.call('c', 'GET', '/otps')).data.items[0].id;
  assert.equal((await A.call('k', 'POST', `/otps/${id}/delivered`)).status, 403);
  assert.equal((await A.call('c', 'POST', `/otps/${id}/delivered`)).status, 200);
  assert.equal((await A.call('c', 'GET', '/stats')).data.pendingOtps, 0);
  assert.equal((await A.call('c', 'GET', '/otps')).data.items[0].delivered, true);   // لسه صالح للاستخدام
  assert.equal((await A.call('c', 'POST', '/otps/999/delivered')).status, 404);
});

test('تعديل العميل لبياناته: التوكن إلزامي، والتعديل يُسجَّل، والبحث عند الكاشير يتحدّث', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'أحمد سامي', phone: '01011112222', address: 'عنوان قديم جدا' });
  const other = A.domain.createCustomer(null, { name: 'غيره', phone: '01033334444', address: 'مكان آخر' });
  const { data: v } = await A.pub('/customer/verify', { term: c.code, last4: '2222' });

  assert.equal((await A.pub('/customer/update', { name: 'x y', address: 'عنوان جديد طويل' })).status, 401);
  assert.equal((await A.pub('/customer/update', { token: 'garbage', name: 'x y' })).status, 401);
  const tampered = v.token.slice(0, -3) + (v.token.endsWith('aaa') ? 'bbb' : 'aaa');
  assert.equal((await A.pub('/customer/update', { token: tampered, name: 'x y' })).status, 401);

  assert.equal((await A.pub('/customer/update', { token: v.token, name: 'أ' })).status, 422);
  assert.equal((await A.pub('/customer/update', { token: v.token, address: '123' })).status, 422);
  assert.equal((await A.pub('/customer/update', { token: v.token, phone: '12345' })).status, 422);
  const dup = await A.pub('/customer/update', { token: v.token, phone: other.phone });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'phone_exists');

  const up = await A.pub('/customer/update', { token: v.token, name: 'أحمد سامي علي', phone: '٠١٠٥٥٥٥٦٦٦٦', address: 'حدائق أكتوبر مجاورة 9 عمارة 2' });
  assert.equal(up.status, 200);
  assert.deepEqual(up.data.changed.sort(), ['address', 'name', 'phone']);
  assert.equal(up.data.customer.phone, '01055556666');
  assert.ok(up.data.token);

  // نفس البيانات مرة أخرى = لا تغيير ولا سجل جديد
  const same = await A.pub('/customer/update', { token: up.data.token, name: 'أحمد سامي علي', address: 'حدائق أكتوبر مجاورة 9 عمارة 2' });
  assert.deepEqual(same.data.changed, []);
  assert.equal(A.db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'customer.self_update'").get().n, 1);

  // الكاشير يلاقيه بالرقم الجديد، والرقم القديم اختفى
  assert.equal((await A.call('c', 'GET', '/customers?q=01055556666')).data.total, 1);
  assert.equal((await A.call('c', 'GET', '/customers?q=01011112222')).data.total, 0);
  const audit = A.db.prepare("SELECT username, details FROM audit_log WHERE action = 'customer.self_update'").get();
  assert.equal(audit.username, 'website');
  assert.equal(JSON.parse(audit.details).phone.from, '01011112222');
  // الكود لا يتغير، وبه + آخر 4 أرقام الجديدة يدخل
  assert.equal((await A.pub('/customer/verify', { term: c.code, last4: '6666' })).status, 200);
});

test('التوكن ينتهي بعد 30 دقيقة', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'منى', phone: '01012340000', address: 'عنوان طويل كفاية' });
  const { data: v } = await A.pub('/customer/verify', { term: c.code, last4: '0000' });
  const real = Date.now;
  Date.now = () => real() + 31 * 60_000;
  try { assert.equal((await A.pub('/customer/update', { token: v.token, name: 'منى جديد' })).status, 401); }
  finally { Date.now = real; }
  assert.equal((await A.pub('/customer/update', { token: v.token, name: 'منى جديد' })).status, 200);
});

test('عميل سابق يطلب أكثر من مرة (حتى 3 مفتوحة) وتظهر عند الكاشير بعلامة «عميل سابق»', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'هبة علي', phone: '01234500000', address: 'حدائق أكتوبر مجاورة 4' });
  const { data: v } = await A.pub('/customer/verify', { term: c.code, last4: '0000' });
  const order = extra => A.pub('/requests', { ...GOOD_REQ, customerType: 'returning', token: v.token, ...extra });

  const r1 = await order(), r2 = await order({ serviceType: 'clothes' }), r3 = await order({ serviceType: 'curtains' });
  for (const r of [r1, r2, r3]) { assert.equal(r.status, 201); assert.equal(r.data.duplicate, false); assert.equal(r.data.returning, true); assert.match(r.data.message, /أهلًا بعودتك/); }
  assert.equal(new Set([r1.data.id, r2.data.id, r3.data.id]).size, 3);          // ثلاث طلبات منفصلة فعلًا
  const r4 = await order();
  assert.equal(r4.status, 429);
  assert.equal(r4.data.error.code, 'too_many_open');

  const list = (await A.call('c', 'GET', '/requests')).data;
  assert.equal(list.total, 3);
  assert.ok(list.items.every(x => x.returning && x.customerCode === c.code && x.customerId === c.id));
  assert.equal(list.counts.new, 3);

  // التحويل لا يُنشئ عميلًا مكررًا ويفتح نفس العميل
  const before = A.db.prepare('SELECT COUNT(*) n FROM customers').get().n;
  const conv = await A.call('c', 'POST', `/requests/${r1.data.id}/convert`);
  assert.equal(conv.status, 200);
  assert.equal(conv.data.customer.id, c.id);
  assert.equal(A.db.prepare('SELECT COUNT(*) n FROM customers').get().n, before);
  // وبعد التحويل/الإلغاء يقدر يطلب تاني
  assert.equal((await order()).status, 201);
});

test('العميل الجديد: منع تكرار الطلب خلال 24 ساعة لسه شغال ولا يحمل علامة عميل سابق', async t => {
  const A = await makeApp(); t.after(A.close);
  const body = { ...GOOD_REQ, fullName: 'سارة محمود', phoneNumber: '01234567890', address: 'حدائق أكتوبر مجاورة 3' };
  const r1 = await A.pub('/requests', body), r2 = await A.pub('/requests', body);
  assert.equal(r1.data.duplicate, false);
  assert.equal(r2.data.duplicate, true);
  assert.equal(r1.data.returning, false);
  const item = (await A.call('c', 'GET', '/requests')).data.items[0];
  assert.equal(item.returning, false);
  assert.equal(item.customerCode, null);
});

test('عميل سابق بدون عنوان مسجّل يُطلب منه إضافته أولًا', async t => {
  const A = await makeApp(); t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'بلا عنوان', phone: '01500000011' });
  const { data: v } = await A.pub('/customer/verify', { term: c.code, last4: '0011' });
  // بدون توكن أو بقيم مرفوضة (ملحوظة: كل نداء بيُحسب في حد المعدل، فالفحوص دي هنا)
  assert.equal((await A.pub('/requests', { ...GOOD_REQ, customerType: 'returning' })).status, 401);
  assert.equal((await A.pub('/requests', { ...GOOD_REQ, customerType: 'returning', token: v.token, serviceType: 'hack' })).status, 422);
  const r = await A.pub('/requests', { ...GOOD_REQ, customerType: 'returning', token: v.token });
  assert.equal(r.status, 422);
  assert.equal(r.data.error.field, 'address');
  await A.pub('/customer/update', { token: v.token, address: 'عنوان جديد بالتفصيل' });
  assert.equal((await A.pub('/requests', { ...GOOD_REQ, customerType: 'returning', token: v.token })).status, 201);
});

test('حدود المعدل على مسارات العميل السابق (حماية من تخمين الأكواد)', async t => {
  const A = await makeApp(); t.after(A.close);
  let last;
  for (let i = 0; i < 21; i++) last = await A.pub('/customer/lookup', { term: `4S-C-${String(900000 + i)}` });
  assert.equal(last.status, 429);
  assert.equal(last.data.error.code, 'rate_limited');
});

test('Webhook اختياري: الكود يُرسل تلقائيًا ويُعلَّم «تم الإرسال»', async t => {
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; });
    req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200).end('ok'); });
  });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  t.after(() => hook.close());
  const A = await makeApp({ otpWebhookUrl: `http://127.0.0.1:${hook.address().port}/send`, otpWebhookToken: 'secret-token' });
  t.after(A.close);
  const c = A.domain.createCustomer(null, { name: 'دعاء', phone: '01277778888', address: 'عنوان طويل كفاية' });
  const r = await A.pub('/customer/otp', { term: c.phone });
  assert.equal(r.data.automatic, true);
  for (let i = 0; i < 40 && !got.length; i++) await new Promise(res => setTimeout(res, 25));
  assert.equal(got.length, 1);
  assert.equal(got[0].auth, 'Bearer secret-token');
  assert.equal(got[0].body.phone, c.phone);
  assert.match(got[0].body.otp, /^\d{6}$/);
  assert.ok(got[0].body.message.includes(got[0].body.otp));
  for (let i = 0; i < 40 && (await A.call('c', 'GET', '/otps')).data.items[0]?.delivered !== true; i++) await new Promise(res => setTimeout(res, 25));
  assert.equal((await A.call('c', 'GET', '/otps')).data.items[0].delivered, true);
  // والعميل يدخل بنفس الكود
  assert.equal((await A.pub('/customer/verify', { term: c.phone, otp: got[0].body.otp })).status, 200);
});

test('فشل الـ webhook لا يكسر الطلب ويبقى الكود متاحًا للكاشير', async t => {
  const A = await makeApp({ otpWebhookUrl: 'http://127.0.0.1:1/unreachable' }); t.after(A.close);
  const origErr = console.error; console.error = () => {};
  t.after(() => { console.error = origErr; });
  const c = A.domain.createCustomer(null, { name: 'فاطمة', phone: '01166665555', address: 'عنوان طويل كفاية' });
  assert.equal((await A.pub('/customer/otp', { term: c.phone })).status, 200);
  await new Promise(r => setTimeout(r, 150));
  const item = (await A.call('c', 'GET', '/otps')).data.items[0];
  assert.equal(item.delivered, false);
});

/* ---------- صلاحيات الموظفين المخصصة ---------- */
test('المدير يحدد صلاحيات كل موظف ويضبط له يوزر وباسوورد', async t => {
  const A = await makeApp(); t.after(A.close);
  const { call } = A;
  const mk = await call('a', 'POST', '/users', {
    username: 'emp1', name: 'موظف', role: 'cashier', password: 'Employee2026x',
    permissions: ['customers:read', 'orders:read']
  });
  assert.equal(mk.status, 201);
  assert.deepEqual([...mk.data.user.permissions].sort(), ['catalog:read', 'customers:read', 'orders:read']);
  assert.equal(mk.data.password, 'Employee2026x');
  assert.equal((await call('e', 'POST', '/auth/login', { username: 'emp1', password: 'Employee2026x' })).status, 200);
  assert.equal((await call('e', 'POST', '/auth/password', { current: 'Employee2026x', next: 'Employee2027y' })).status, 200);
  assert.equal((await call('e', 'GET', '/customers')).status, 200);
  assert.equal((await call('e', 'POST', '/customers', { name: 'سعد علي', phone: '01012345679' })).status, 403);
  assert.equal((await call('e', 'GET', '/requests')).status, 403);
  // المدير يمنحه صلاحيات، وتسري فورًا بدون إعادة دخول
  const id = mk.data.user.id;
  assert.equal((await call('a', 'PUT', '/users/' + id, { permissions: ['customers:write', 'requests:read'] })).status, 200);
  assert.equal((await call('e', 'GET', '/requests')).status, 200);
  assert.equal((await call('e', 'POST', '/customers', { name: 'سعد علي', phone: '01012345679' })).status, 201);
  // تغيير الدور يرجّع للافتراضي
  const back = await call('a', 'PUT', '/users/' + id, { role: 'accountant' });
  assert.equal(back.data.customPermissions, false);
  assert.equal((await call('e', 'GET', '/requests')).status, 403);
  // صلاحيات الإدارة غير قابلة للمنح
  const sneaky = await call('a', 'PUT', '/users/' + id, { role: 'cashier', permissions: ['users:manage', 'settings:write', 'orders:read'] });
  assert.ok(!sneaky.data.permissions.includes('users:manage') && !sneaky.data.permissions.includes('settings:write'));
  assert.equal((await call('e', 'GET', '/users')).status, 403);
  // باسوورد ضعيف مرفوض
  assert.equal((await call('a', 'POST', '/users', { username: 'emp2', name: 'موظف 2', role: 'cashier', password: '123' })).status, 422);
  // الكاشير لا يقدر يعدّل المستخدمين
  assert.equal((await call('c', 'PUT', '/users/' + id, { permissions: ['orders:update'] })).status, 403);
});

/* ---------- تحكم المدير اليدوي ---------- */
test('المدير يعدّل ويحذف الطلبات والمدفوعات والعملاء يدويًا والكاشير لا', async t => {
  const A = await makeApp(); t.after(A.close);
  const { call, db, domain } = A;
  const c = domain.createCustomer(null, { name: 'عميل تحكم', phone: '01033334444', address: 'عنوان طويل للاختبار' });
  const ins = db.prepare(`INSERT INTO orders (code,customer_id,status,items_summary,subtotal_cents,total_cents,paid_cents,created_date,created_at,updated_at)
    VALUES (?,?,'in_progress','قميص',10000,10000,0,'2026-10-01','2026-10-01T10:00:00Z','2026-10-01T10:00:00Z')`);
  const o1 = Number(ins.run('4S-9001', c.id).lastInsertRowid), o2 = Number(ins.run('4S-9002', c.id).lastInsertRowid);
  db.prepare('UPDATE customers SET opening_balance_cents = 5000 WHERE id = ?').run(c.id);

  // الكاشير والمحاسب ممنوعين
  for (const who of ['c', 'k']) {
    assert.equal((await call(who, 'PUT', '/admin/orders/' + o1, { total: 1 })).status, 403);
    assert.equal((await call(who, 'DELETE', '/admin/orders/' + o1)).status, 403);
    assert.equal((await call(who, 'DELETE', '/admin/customers/' + c.id)).status, 403);
    assert.equal((await call(who, 'PUT', '/admin/customers/' + c.id, { openingBalance: 0 })).status, 403);
  }
  // تعديل: إجمالي + مدفوع + حالة + ميعاد
  const bad = await call('a', 'PUT', '/admin/orders/' + o1, { total: 100, paid: 150 });
  assert.equal(bad.status, 422);
  const up = await call('a', 'PUT', '/admin/orders/' + o1, { total: 120, paid: 70, status: 'delivered', deliveryDate: '2026-10-05', note: 'خصم للعميل' });
  assert.equal(up.status, 200);
  assert.equal(up.data.status, 'delivered');
  assert.equal(up.data.paid, 70);
  assert.equal(up.data.total, 120);
  // التعديل لأسفل يشيل دفعات
  assert.equal((await call('a', 'PUT', '/admin/orders/' + o1, { paid: 20 })).data.paid, 20);
  const pays = (await call('a', 'GET', `/customers/${c.id}/payments`)).data.items;
  assert.equal(pays.reduce((s, p) => s + p.amount, 0), 20);
  // حذف دفعة
  const del = await call('a', 'DELETE', '/admin/payments/' + pays[0].id);
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT paid_cents FROM orders WHERE id = ?').get(o1).paid_cents, 0);
  // رصيد افتتاحي
  assert.equal((await call('a', 'PUT', '/admin/customers/' + c.id, { openingBalance: 0 })).data.balance, 220); // 120 + 100
  // حذف عميل له طلبات يحتاج تأكيد
  const need = await call('a', 'DELETE', '/admin/customers/' + c.id);
  assert.equal(need.status, 409);
  assert.equal((await call('a', 'DELETE', '/admin/orders/' + o2)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE id = ?').get(o2).n, 0);
  const gone = await call('a', 'DELETE', '/admin/customers/' + c.id + '?force=1');
  assert.equal(gone.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM orders WHERE customer_id = ?').get(c.id).n, 0);
  assert.equal((await call('a', 'GET', '/customers/' + c.id)).status, 404);
  // كله متسجل في سجل العمليات
  const audit = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'admin.%'").all().map(r => r.action);
  for (const a of ['admin.order_update', 'admin.order_delete', 'admin.payment_delete', 'admin.customer_balance', 'admin.customer_delete']) assert.ok(audit.includes(a), a);
});

/* ---------- الرسائل الداخلية ---------- */
test('رسائل داخلية بين الموظفين والمدير: إرسال وقراءة وردود وخصوصية', async t => {
  const A = await makeApp(); t.after(A.close);
  const { call, db } = A;
  const ids = Object.fromEntries(db.prepare('SELECT username, id FROM users').all().map(u => [u.username, u.id]));
  assert.equal((await call('c', 'GET', '/messages/contacts')).data.items.some(u => u.id === ids.cash1), false);
  // الكاشير يكتب للمدير
  const s1 = await call('c', 'POST', '/messages', { to: [ids.admin], subject: 'عميل بيسأل', body: 'عميل عايز خصم على الستائر' });
  assert.equal(s1.status, 201);
  assert.equal((await call('a', 'GET', '/messages/unread')).data.unread, 1);
  const inbox = await call('a', 'GET', '/messages');
  assert.equal(inbox.data.items[0].from.name, 'cash1');
  assert.equal(inbox.data.items[0].read, false);
  // المحاسب مايقدرش يفتح رسالة مش بتاعته
  assert.equal((await call('k', 'GET', '/messages/' + s1.data.id)).status, 404);
  assert.equal((await call('k', 'DELETE', '/messages/' + s1.data.id)).status, 404);
  // المدير يفتح ويرد
  assert.equal((await call('a', 'GET', '/messages/' + s1.data.id)).status, 200);
  assert.equal((await call('a', 'GET', '/messages/unread')).data.unread, 0);
  const rep = await call('a', 'POST', '/messages', { to: [ids.cash1], subject: 'رد: عميل بيسأل', body: 'وافقت على 10%', parentId: s1.data.id });
  assert.equal(rep.status, 201);
  const th = await call('c', 'GET', '/messages/' + rep.data.id);
  assert.equal(th.data.thread.length, 2);
  // رسالة للكل، وفاضي، ولنفسك
  assert.equal((await call('a', 'POST', '/messages', { toAll: true, subject: 'إعلان', body: 'اجتماع بكرة' })).data.recipients, 2);
  assert.equal((await call('a', 'POST', '/messages', { to: [], subject: 'x', body: 'y' })).status, 422);
  assert.equal((await call('a', 'POST', '/messages', { to: [ids.admin], subject: 'x', body: 'y' })).status, 422);
  assert.equal((await call('a', 'POST', '/messages', { to: [9999], subject: 'x', body: 'y' })).status, 422);
  // الصادر والحذف
  assert.equal((await call('a', 'GET', '/messages?box=sent')).data.items.length, 2);
  assert.equal((await call('k', 'DELETE', '/messages/' + (await call('k', 'GET', '/messages')).data.items[0].id)).status, 200);
  assert.equal((await call('k', 'GET', '/messages')).data.items.length, 0);
});
