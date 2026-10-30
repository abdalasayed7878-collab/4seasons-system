'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { ensureSeed } = require('../server/bootstrap');

let server, base, db, domain, adminPw;
const jar = {};
async function call(who, method, url, body, headers = {}) {
  const res = await fetch(base + '/api' + url, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const login = async (who, username, password) => call(who, 'POST', '/auth/login', { username, password });

test.before(async () => {
  db = openDb(':memory:');
  const app = createApp(db, { ...config, dbPath: ':memory:' });
  domain = app.locals.domain;
  const first = await ensureSeed(db, { ...config, dbPath: '/tmp/4s-test-first/x.db' }, domain);
  adminPw = first.password;
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); });

test('تسجيل دخول المدير يُجبر على تغيير كلمة المرور قبل أي عملية', async () => {
  assert.equal((await login('a', 'admin', 'wrong')).status, 401);
  const r = await login('a', 'admin', adminPw);
  assert.equal(r.status, 200);
  assert.equal(r.data.user.mustChangePassword, true);
  const blocked = await call('a', 'GET', '/catalog');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.error.code, 'must_change_password');
  assert.equal((await call('a', 'POST', '/auth/password', { current: adminPw, next: 'short' })).status, 422);
  assert.equal((await call('a', 'POST', '/auth/password', { current: adminPw, next: 'Manager2026ok' })).status, 200);
  assert.equal((await call('a', 'GET', '/catalog')).status, 200);
});

test('إنشاء مستخدم كاشير وصلاحياته محدودة', async () => {
  const r = await call('a', 'POST', '/users', { username: 'cash1', name: 'كاشير', role: 'cashier' });
  assert.equal(r.status, 201);
  await login('c', 'cash1', r.data.password);
  assert.equal((await call('c', 'POST', '/auth/password', { current: r.data.password, next: 'Cashier2026ok' })).status, 200);
  assert.equal((await call('c', 'PUT', '/settings', { phone: '01000000000' })).status, 403);
  assert.equal((await call('c', 'POST', '/services', { name: 'x' })).status, 403);
  assert.equal((await call('c', 'GET', '/users')).status, 403);
  assert.equal((await call('c', 'GET', '/admin/backup')).status, 403);
  assert.equal((await call('c', 'GET', '/catalog')).status, 200);
});

let customerId;
test('العميل: التحقق من الهاتف ومنع التكرار والبحث', async () => {
  assert.equal((await call('c', 'POST', '/customers', { name: 'منى', phone: '123' })).status, 422);
  const r = await call('c', 'POST', '/customers', { name: 'منى أحمد', phone: '٠١٠١٢٣٤٥٦٧٨' });
  assert.equal(r.status, 201);
  customerId = r.data.id;
  assert.equal(r.data.phone, '01012345678');
  const dup = await call('c', 'POST', '/customers', { name: 'تانية', phone: '+201012345678' });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'phone_exists');
  const s = await call('c', 'GET', '/customers?q=' + encodeURIComponent('احمد'));
  assert.equal(s.data.total, 1); // البحث يتجاهل الهمزة
  assert.equal((await call('c', 'GET', '/customers/find?term=' + r.data.code)).data.customer.id, customerId);
});

const svc = name => db.prepare('SELECT * FROM services WHERE name = ?').get(name);

test('الطلب: الأسعار تُحسب على الخادم وتُرفض القيم المتلاعب بها', async () => {
  const blanket = svc('بطانية عادية'), shifon = svc('ستائر شيفون (المتر)');
  const bad = (lines, extra = {}) => call('c', 'POST', '/orders', { customerId, lines, ...extra });
  assert.equal((await bad([{ serviceId: blanket.id, qty: 1, unitPrice: 1 }])).status, 422);       // أقل من الحد
  assert.equal((await bad([{ serviceId: blanket.id, qty: 0 }])).status, 422);
  assert.equal((await bad([{ serviceId: shifon.id, qty: 1.3 }])).status, 422);                    // الستائر بنصف متر
  assert.equal((await bad([{ serviceId: blanket.id, qty: 1 }], { paid: 99999 })).status, 422);    // دفع أكبر من الإجمالي
  assert.equal((await bad([{ serviceId: blanket.id, qty: 1 }], { deliveryDate: '2020-01-01' })).status, 422);
  assert.equal((await bad([{ fee: true, name: 'اسم عشوائي', amount: 10 }])).status, 422);
  assert.equal((await bad([])).status, 422);

  const ok = await bad([{ serviceId: blanket.id, qty: 2, unitPrice: 130 }, { serviceId: shifon.id, qty: 2.5 }, { fee: true, name: 'خدمة ترزي', amount: 40 }], { paymentMethod: 'cash', paid: 100 });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.subtotal, 2 * 130 + 2.5 * 15 + 40);
  assert.equal(ok.data.paid, 100);
  assert.equal(ok.data.remaining, ok.data.total - 100);
  assert.equal(ok.data.status, 'in_progress');
  assert.match(ok.data.code, /^4S-\d+$/);
});

test('سجاد بالمتر وبنود بعد المعاينة: بانتظار القياس ثم التسعير', async () => {
  const carpet = svc('سجاد عادي'), quote = svc('فستان زفاف');
  const o = await call('c', 'POST', '/orders', { customerId, lines: [{ serviceId: carpet.id, qty: 2 }, { serviceId: quote.id, qty: 1 }], paymentMethod: 'deferred' });
  assert.equal(o.status, 201);
  assert.equal(o.data.status, 'pending_pricing');
  assert.equal(o.data.total, 0);
  const lines = o.data.lines;
  assert.equal((await call('c', 'POST', `/orders/${o.data.id}/status`, { status: 'ready' })).status, 409); // لا يتخطى المرحلة
  assert.equal((await call('c', 'POST', `/orders/${o.data.id}/pricing`, { lines: [{ id: lines[0].id, area: -3 }, { id: lines[1].id, price: 500 }] })).status, 422);
  const p = await call('c', 'POST', `/orders/${o.data.id}/pricing`, { lines: [{ id: lines[0].id, area: 7.5 }, { id: lines[1].id, price: 500 }] });
  assert.equal(p.status, 200);
  assert.equal(p.data.status, 'in_progress');
  assert.equal(p.data.total, 7.5 * 35 + 500);
  assert.equal((await call('c', 'POST', `/orders/${o.data.id}/pricing`, { lines: [] })).status, 409);
  assert.equal((await call('c', 'POST', `/orders/${o.data.id}/status`, { status: 'ready' })).status, 200);
  assert.equal((await call('c', 'POST', `/orders/${o.data.id}/status`, { status: 'delivered' })).status, 200);
});

test('التحصيل يوزّع المبلغ على أقدم الطلبات ويرفض الزيادة', async () => {
  const before = (await call('c', 'GET', '/customers/' + customerId)).data.balance;
  assert.ok(before > 0);
  assert.equal((await call('c', 'POST', `/customers/${customerId}/payments`, { amount: before + 1, method: 'cash' })).status, 422);
  assert.equal((await call('c', 'POST', `/customers/${customerId}/payments`, { amount: 100, method: 'bitcoin' })).status, 422);
  const after = await call('c', 'POST', `/customers/${customerId}/payments`, { amount: before, method: 'instapay' });
  assert.equal(after.status, 200);
  assert.equal(after.data.balance, 0);
  const sum = db.prepare('SELECT SUM(total_cents - paid_cents) s FROM orders WHERE customer_id = ?').get(customerId).s;
  assert.equal(sum, 0);
});

test('الحساب المحاسب للقراءة فقط', async () => {
  const r = await call('a', 'POST', '/users', { username: 'acc1', name: 'محاسب', role: 'accountant' });
  await login('k', 'acc1', r.data.password);
  await call('k', 'POST', '/auth/password', { current: r.data.password, next: 'Account2026ok' });
  assert.equal((await call('k', 'GET', '/orders')).status, 200);
  assert.equal((await call('k', 'GET', '/stats')).status, 200);
  assert.equal((await call('k', 'POST', '/orders', { customerId, lines: [] })).status, 403);
  assert.equal((await call('k', 'POST', `/customers/${customerId}/payments`, { amount: 1 })).status, 403);
});

test('طلبات الموقع: تحقق، فخ الروبوتات، منع التكرار، التحويل لعميل', async () => {
  const good = { fullName: 'هبة علي', phoneNumber: '01234567891', address: 'حدائق أكتوبر مجاورة 4', serviceType: 'carpet', prefTime: '12 مساءً - 2 مساءً', elapsedMs: 8000 };
  const pub = body => call('p', 'POST', '/public/requests', body);
  assert.equal((await pub({ ...good, phoneNumber: '12' })).status, 422);
  assert.equal((await pub({ ...good, serviceType: 'hack' })).status, 422);
  const before = db.prepare('SELECT COUNT(*) n FROM web_requests').get().n;
  assert.equal((await pub({ ...good, company: 'spam.com' })).status, 201);   // يتظاهر بالنجاح ولا يحفظ
  assert.equal((await pub({ ...good, elapsedMs: 100 })).status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_requests').get().n, before);
  const r1 = await pub(good);
  assert.equal(r1.status, 201); assert.equal(r1.data.duplicate, false);
  const r2 = await pub(good);
  assert.equal(r2.data.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_requests').get().n, before + 1);
  const conv = await call('c', 'POST', `/requests/${r1.data.id}/convert`);
  assert.equal(conv.status, 200);
  assert.equal(conv.data.customer.source, 'website');
  assert.equal(conv.data.request.status, 'converted');
  assert.equal((await call('c', 'POST', `/requests/${r1.data.id}/status`, { status: 'cancelled' })).status, 409);
});

test('حماية CSRF: طلب مُغيِّر من موقع غريب يُرفض', async () => {
  const r = await call('a', 'POST', '/zones', { name: 'منطقة خبيثة' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(r.data.error.code, 'forbidden_origin');
});

test('المدير: آخر مدير لا يمكن تعطيله، وتعديل الأسعار يُسجَّل تاريخيًا', async () => {
  const me = (await call('a', 'GET', '/auth/me')).data.user;
  assert.equal((await call('a', 'PUT', '/users/' + me.id, { active: false })).status, 409);
  const s = svc('بطانية عادية');
  const up = await call('a', 'PUT', '/services/' + s.id, { min: 125, max: 145 });
  assert.equal(up.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM service_price_history WHERE service_id = ?').get(s.id).n, 1);
  assert.equal((await call('a', 'PUT', '/services/' + s.id, { min: 200, max: 100 })).status, 422);
  // الطلبات القديمة تحتفظ بسعرها وقت الإنشاء
  const old = db.prepare("SELECT unit_price_cents FROM order_lines WHERE service_id = ? ORDER BY id LIMIT 1").get(s.id);
  assert.equal(old.unit_price_cents, 13000);
});

test('قفل الحساب بعد محاولات فاشلة متكررة', async () => {
  const r = await call('a', 'POST', '/users', { username: 'locky', name: 'قفل', role: 'cashier' });
  let last;
  for (let i = 0; i < 6; i++) last = await login('l', 'locky', 'bad-password-' + i);
  assert.equal(last.status, 429);
  assert.equal((await login('l', 'locky', r.data.password)).status, 429);
});

test('الصفحة العامة تُرسم من قاعدة البيانات وتهرّب المدخلات', async () => {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'hours_text'").run('<script>alert(1)</script>');
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.includes('125 - 145 ج'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('application/ld+json'));
});
