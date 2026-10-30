'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const U = require('./util');
const A = require('./auth');
const S = require('./security');
const { createDomain } = require('./domain');

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp(db, config) {
  const d = createDomain(db, config);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.locals.db = db;
  app.locals.domain = d;

  app.use(S.securityHeaders(config));
  app.use(express.json({ limit: '100kb' }));

  const allowedHosts = config.publicOrigins.map(o => { try { return new URL(o).host; } catch { return null; } }).filter(Boolean);
  const ipOf = req => req.ip || req.socket?.remoteAddress || '';
  const actorOf = req => ({ ...req.user, ip: ipOf(req) });

  const api = express.Router();
  api.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  /* ---------- مسارات عامة (الموقع) ---------- */
  const pub = express.Router();
  pub.use(S.publicCors(config));
  const limit = (max, message) => S.rateLimiter({ windowMs: 10 * 60_000, max, key: ipOf, message });

  pub.post('/requests', limit(6, 'أرسلت طلبات كثيرة. حاول بعد قليل أو كلّمنا على الهاتف.'), wrap((req, res) => {
    const b = req.body || {};
    const settings = d.getSettings();
    // فخ للروبوتات: حقل مخفي، وزمن تعبئة أقل من 3 ثوانٍ يعني آلة
    const bot = (typeof b.company === 'string' && b.company.trim() !== '') || (Number(b.elapsedMs) < 2500);
    if (bot) return res.status(201).json({ ok: true, message: 'تم استلام طلبك.' });
    const r = d.createWebRequest(b, { ip: ipOf(req) });
    const hours = settings.response_hours || '8';
    const wa = '2' + String(settings.whatsapp || '').replace(/^\+?2?/, '');
    const text = `مرحبًا، أنا ${r.name}. أرسلت طلب استلام من الموقع (رقم ${r.id}).`;
    res.status(201).json({
      ok: true,
      id: r.id,
      duplicate: r.duplicate,
      returning: r.returning,
      message: r.duplicate
        ? 'لديك طلب مفتوح بالفعل وسنتواصل معك قريبًا.'
        : r.returning
          ? `أهلًا بعودتك! تم استلام طلبك وسنتواصل معك خلال ${hours} ساعات لتأكيد الموعد.`
          : `تم استلام طلبك بنجاح. سنتواصل معك خلال ${hours} ساعات لتأكيد الموعد.`,
      whatsappUrl: settings.whatsapp ? `https://wa.me/${wa}?text=${encodeURIComponent(text)}` : null
    });
  }));

  // العميل السابق: بحث → (رمز تحقق) → تحقق → عرض/تعديل البيانات. الحدود هنا أشد لأن المسارات تكشف بيانات عملاء.
  pub.post('/customer/lookup', limit(20, 'محاولات بحث كثيرة. حاول بعد قليل أو كلّمنا على الهاتف.'),
    wrap((req, res) => res.json(d.selfLookup((req.body || {}).term))));
  pub.post('/customer/otp', limit(5, 'طلبات كود كثيرة. حاول بعد قليل أو كلّمنا على الهاتف.'),
    wrap((req, res) => res.json(d.selfRequestOtp(req.body || {}, { ip: ipOf(req) }))));
  pub.post('/customer/verify', limit(15, 'محاولات تحقق كثيرة. حاول بعد قليل أو كلّمنا على الهاتف.'),
    wrap((req, res) => res.json(d.selfVerify(req.body || {}, { ip: ipOf(req) }))));
  pub.post('/customer/update', limit(20, 'تعديلات كثيرة. حاول بعد قليل.'),
    wrap((req, res) => res.json(d.selfUpdate(req.body || {}, { ip: ipOf(req) }))));
  api.use('/public', pub);

  /* ---------- المصادقة ---------- */
  api.use(S.originCheck(allowedHosts));
  const loginLimiter = S.rateLimiter({ windowMs: 10 * 60_000, max: 15, key: ipOf, message: 'محاولات دخول كثيرة. حاول بعد قليل.' });

  api.post('/auth/login', loginLimiter, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') throw U.invalid('أدخل اسم المستخدم وكلمة المرور.');
    const r = await d.login(username, password, { ip: ipOf(req), userAgent: req.headers['user-agent'] });
    S.setCookie(res, req, config, A.COOKIE, r.token, { maxAgeSec: config.sessionHours * 3600 });
    res.json({ user: r.user, permissions: r.permissions });
  }));

  const auth = A.authenticate(db, config);
  api.post('/auth/logout', (req, res) => {
    const token = S.parseCookies(req.headers.cookie)[A.COOKIE];
    A.destroySession(db, token);
    S.setCookie(res, req, config, A.COOKIE, '', { maxAgeSec: 0 });
    res.json({ ok: true });
  });

  api.use(auth);

  api.get('/auth/me', (req, res) => res.json({ user: req.user, permissions: req.user.permissions, settings: d.getSettings() }));
  api.post('/auth/password', wrap(async (req, res) => {
    const { current, next } = req.body || {};
    await d.changeOwnPassword(actorOf(req), req.sessionToken, { current, next });
    res.json({ ok: true });
  }));

  const P = A.requirePerm;
  // أي طلب مُغيِّر يُبطل كاش المؤشرات
  api.use((req, res, next) => { if (req.method !== 'GET') res.on('finish', d.invalidateStats); next(); });
  const id = req => U.int(req.params.id, { field: 'المعرّف', min: 1, required: true });

  /* ---------- الكتالوج والإعدادات ---------- */
  api.get('/catalog', P('catalog:read'), (req, res) => res.json({ ...d.getCatalog(), settings: d.getSettings(), constants: d.constants }));
  api.put('/settings', P('settings:write'), (req, res) => res.json(d.updateSettings(actorOf(req), req.body || {})));
  api.post('/services', P('catalog:write'), (req, res) => res.status(201).json(d.createService(actorOf(req), req.body || {})));
  api.put('/services/:id', P('catalog:write'), (req, res) => res.json(d.updateService(actorOf(req), id(req), req.body || {})));
  api.post('/zones', P('catalog:write'), (req, res) => res.status(201).json(d.createZone(actorOf(req), req.body || {})));
  api.put('/zones/:id', P('catalog:write'), (req, res) => res.json(d.updateZone(actorOf(req), id(req), req.body || {})));

  api.get('/stats', P('stats:read'), (req, res) => res.json(d.getStats()));

  /* ---------- العملاء ---------- */
  api.get('/customers', P('customers:read'), (req, res) =>
    res.json(d.listCustomers({ q: String(req.query.q || ''), page: req.query.page, pageSize: req.query.pageSize, debtors: req.query.debtors === '1' })));
  api.get('/customers/find', P('customers:read'), (req, res) => res.json({ customer: d.findCustomerExact(String(req.query.term || '')) }));
  api.get('/customers/:id', P('customers:read'), (req, res) => res.json(d.getCustomer(id(req))));
  api.post('/customers', P('customers:write'), (req, res) => res.status(201).json(d.createCustomer(actorOf(req), req.body || {})));
  api.put('/customers/:id', P('customers:write'), (req, res) => res.json(d.updateCustomer(actorOf(req), id(req), req.body || {})));
  api.post('/customers/:id/payments', P('payments:collect'), (req, res) => res.json(d.collectPayment(actorOf(req), id(req), req.body || {})));

  /* ---------- الطلبات ---------- */
  api.get('/orders', P('orders:read'), (req, res) => {
    const out = d.listOrders({
      status: req.query.status ? String(req.query.status) : undefined, q: String(req.query.q || ''),
      customerId: req.query.customerId ? Number(req.query.customerId) : undefined, page: req.query.page, pageSize: req.query.pageSize
    });
    if (req.query.counts === '1') out.counts = d.orderCounts({ q: String(req.query.q || '') });
    res.json(out);
  });
  api.get('/orders/:id', P('orders:read'), (req, res) => res.json(d.getOrder(req.params.id)));
  api.post('/orders', P('orders:create'), (req, res) => res.status(201).json(d.createOrder(actorOf(req), req.body || {})));
  api.post('/orders/:id/pricing', P('orders:update'), (req, res) => res.json(d.applyPricing(actorOf(req), id(req), req.body || {})));
  api.post('/orders/:id/status', P('orders:update'), (req, res) => res.json(d.advanceOrder(actorOf(req), id(req), String((req.body || {}).status))));

  /* ---------- طلبات الموقع ---------- */
  /* الرسائل الداخلية: متاحة لكل مستخدم مسجّل (بدون صلاحية خاصة) */
  const mustOk = (req, res, next) => (req.user.mustChangePassword ? next(U.httpError(403, 'must_change_password', 'يجب تغيير كلمة المرور أولًا.')) : next());
  api.get('/messages/unread', mustOk, (req, res) => res.json({ unread: d.unreadMessages(req.user) }));
  api.get('/messages/contacts', mustOk, (req, res) => res.json({ items: d.messageContacts(req.user) }));
  api.get('/messages', mustOk, (req, res) => res.json(d.listMessages(req.user, req.query.box === 'sent' ? 'sent' : 'inbox', { page: Math.max(1, Number(req.query.page) || 1) })));
  api.post('/messages', mustOk, (req, res) => res.status(201).json(d.sendMessage(req.user, req.body || {})));
  api.get('/messages/:id', mustOk, (req, res) => res.json(d.getMessage(req.user, id(req))));
  api.delete('/messages/:id', mustOk, (req, res) => res.json(d.deleteMessage(req.user, id(req))));

  /* تحكم المدير اليدوي (للمدير فقط) */
  api.get('/customers/:id/payments', P('customers:read'), (req, res) => res.json({ items: d.listCustomerPayments(id(req)) }));
  api.put('/admin/orders/:id', P('admin:edit'), (req, res) => res.json(d.adminUpdateOrder(actorOf(req), id(req), req.body || {})));
  api.delete('/admin/orders/:id', P('admin:edit'), (req, res) => res.json(d.adminDeleteOrder(actorOf(req), id(req))));
  api.delete('/admin/payments/:id', P('admin:edit'), (req, res) => res.json(d.adminDeletePayment(actorOf(req), id(req))));
  api.put('/admin/customers/:id', P('admin:edit'), (req, res) => res.json(d.adminUpdateCustomer(actorOf(req), id(req), req.body || {})));
  api.delete('/admin/customers/:id', P('admin:edit'), (req, res) => res.json(d.adminDeleteCustomer(actorOf(req), id(req), { force: req.query.force === '1' })));

  api.get('/requests', P('requests:read'), (req, res) =>
    res.json(d.listWebRequests({ status: req.query.status ? String(req.query.status) : undefined, page: req.query.page, pageSize: req.query.pageSize })));
  api.post('/requests/:id/status', P('requests:write'), (req, res) =>
    res.json(d.setWebRequestStatus(actorOf(req), id(req), (req.body || {}).status, (req.body || {}).note)));
  api.post('/requests/:id/convert', P('requests:write'), (req, res) => res.json(d.convertWebRequest(actorOf(req), id(req))));

  // رموز التحقق المطلوبة من العملاء السابقين (يرسلها الكاشير على واتساب العميل)
  api.get('/otps', P('requests:read'), (req, res) => res.json({ items: d.listActiveOtps() }));
  api.post('/otps/:id/delivered', P('requests:write'), (req, res) => res.json(d.markOtpDelivered(actorOf(req), id(req))));

  /* ---------- المستخدمون والإدارة ---------- */
  api.get('/users/permissions', P('users:manage'), (req, res) => res.json({ groups: A.ASSIGNABLE.map(g => ({ group: g.group, items: g.items.map(([key, label]) => ({ key, label })) })), defaults: { cashier: A.PERMISSIONS.cashier, accountant: A.PERMISSIONS.accountant } }));
  api.get('/users', P('users:manage'), (req, res) => res.json({ items: d.listUsers() }));
  api.post('/users', P('users:manage'), wrap(async (req, res) => res.status(201).json(await d.createUser(actorOf(req), req.body || {}, { password: typeof (req.body || {}).password === 'string' && req.body.password ? req.body.password : undefined }))));
  api.put('/users/:id', P('users:manage'), (req, res) => res.json(d.updateUser(actorOf(req), id(req), req.body || {})));
  api.post('/users/:id/reset-password', P('users:manage'), wrap(async (req, res) => res.json(await d.resetPassword(actorOf(req), id(req)))));

  api.get('/audit', P('audit:read'), (req, res) => {
    const pageSize = Math.min(Math.max(+req.query.pageSize || 50, 1), 200);
    const page = Math.max(+req.query.page || 1, 1);
    const total = db.prepare('SELECT COUNT(*) n FROM audit_log').get().n;
    const items = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, (page - 1) * pageSize);
    res.json({ items, total, page, pageSize });
  });

  api.get('/admin/backup', P('backup:run'), wrap(async (req, res) => {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(config.backupDir, `4seasons-${stamp}.db`);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    d.audit(actorOf(req), 'backup.download', 'system', null);
    res.download(file, path.basename(file), () => fs.rm(file, () => {}));
  }));

  api.use((req, res, next) => next(U.httpError(404, 'not_found', 'المسار غير موجود.')));
  app.use('/api', api);

  /* ---------- الملفات الثابتة: الكاشير على /app والموقع على / ---------- */
  const staticOpts = { index: false, etag: true, maxAge: config.isProd ? '1h' : 0, setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } };
  app.use('/app', express.static(config.appDir, { ...staticOpts, index: 'index.html' }));
  let site;
  try { site = require('./site').createSiteRouter(d, config, staticOpts); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  if (site) app.use('/', site);
  app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });

  /* ---------- الأخطاء ---------- */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof U.HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.extra || {}) } });
    }
    if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ error: { code: 'bad_json', message: 'البيانات المرسلة غير صالحة.' } });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: { code: 'too_large', message: 'حجم البيانات كبير.' } });
    if (/UNIQUE constraint failed/.test(err?.message || '')) return res.status(409).json({ error: { code: 'duplicate', message: 'هذه البيانات مسجلة بالفعل.' } });
    console.error('[خطأ]', req.method, req.originalUrl, err);
    res.status(500).json({ error: { code: 'server_error', message: 'حدث خطأ غير متوقع. حاول مرة أخرى.' } });
  });

  return app;
}

module.exports = { createApp };
