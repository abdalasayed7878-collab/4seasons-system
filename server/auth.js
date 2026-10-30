'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { httpError, nowIso } = require('./util');
const { parseCookies } = require('./security');

const scrypt = promisify(crypto.scrypt);
const COOKIE = '4s_sid';

// ---------- كلمات المرور ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const key = await scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, salt, hash] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, {
      N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024
    });
    return crypto.timingSafeEqual(expected, key);
  } catch { return false; }
}

let dummyHash;
async function burnTime(password) { // نفس زمن التحقق حتى لو المستخدم غير موجود
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generatePassword(len = 12) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

function checkPasswordStrength(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) throw httpError(422, 'weak_password', 'كلمة المرور يجب ألا تقل عن 8 أحرف.');
  if (pw.length > 128) throw httpError(422, 'weak_password', 'كلمة المرور طويلة جدًا.');
  if (username && pw.toLowerCase() === String(username).toLowerCase()) throw httpError(422, 'weak_password', 'كلمة المرور لا يجب أن تطابق اسم المستخدم.');
  if (!/[A-Za-z؀-ۿ]/.test(pw) || !/\d/.test(pw)) throw httpError(422, 'weak_password', 'استخدم حروفًا وأرقامًا معًا في كلمة المرور.');
}

// ---------- الجلسات ----------
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId, userAgent, hours) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
    .run(sha256(token), userId, now.toISOString(), new Date(now.getTime() + hours * 3600_000).toISOString(), String(userAgent || '').slice(0, 200));
  return token;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

function destroyUserSessions(db, userId, exceptToken) {
  if (exceptToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(exceptToken));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function purgeExpiredSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
}

// ---------- الصلاحيات ----------
const PERMISSIONS = {
  manager: ['*'],
  cashier: ['catalog:read', 'stats:read', 'customers:read', 'customers:write', 'orders:read', 'orders:create',
    'orders:update', 'payments:collect', 'requests:read', 'requests:write'],
  accountant: ['catalog:read', 'stats:read', 'orders:read']
};

// الصلاحيات اللي المدير يقدر يمنحها أو يسحبها لكل موظف (المدير نفسه دايمًا عنده كل حاجة)
const ASSIGNABLE = [
  { group: 'الرئيسية', items: [['stats:read', 'عرض الرئيسية والمؤشرات']] },
  { group: 'العملاء', items: [['customers:read', 'عرض العملاء'], ['customers:write', 'إضافة وتعديل العملاء']] },
  { group: 'الطلبات', items: [['orders:read', 'عرض الطلبات'], ['orders:create', 'إنشاء طلب (الكاشير)'], ['orders:update', 'تغيير حالة الطلب والقياس والتسعير'], ['payments:collect', 'تحصيل المدفوعات']] },
  { group: 'طلبات الموقع', items: [['requests:read', 'عرض طلبات الموقع وأكواد التحقق'], ['requests:write', 'التعامل مع طلبات الموقع وتحويلها']] }
];
const ASSIGNABLE_KEYS = ASSIGNABLE.flatMap(g => g.items.map(i => i[0]));
// صلاحية تعتمد على أخرى (لا يصح منحها وحدها)
const REQUIRES = {
  'customers:write': ['customers:read'], 'orders:create': ['orders:read', 'customers:read'], 'orders:update': ['orders:read'],
  'payments:collect': ['orders:read', 'customers:read'], 'requests:write': ['requests:read']
};
function normalizePerms(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter(p => ASSIGNABLE_KEYS.includes(p)));
  for (const p of [...set]) (REQUIRES[p] || []).forEach(r => set.add(r));
  set.add('catalog:read'); // لازمة لعرض الخدمات في الكاشير
  return [...set];
}
// الصلاحيات الفعلية: مخصصة لو المدير حدّدها، وإلا افتراضية الدور
function effectivePerms(role, stored) {
  if (role === 'manager') return PERMISSIONS.manager;
  if (stored) { try { const a = JSON.parse(stored); if (Array.isArray(a)) return normalizePerms(a); } catch { /* افتراضي */ } }
  return PERMISSIONS[role] || [];
}
const can = (user, perm) => (user.permissions || []).some(p => p === '*' || p === perm);

// ---------- Middleware ----------
function authenticate(db, config) {
  const touch = db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?');
  const find = db.prepare(`
    SELECT s.token_hash, s.expires_at, u.id, u.username, u.name, u.role, u.permissions, u.active, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);
  return (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return next(httpError(401, 'unauthenticated', 'سجّل الدخول للمتابعة.'));
    const row = find.get(sha256(token));
    if (!row || !row.active || row.expires_at <= nowIso()) {
      if (row) destroySession(db, token);
      return next(httpError(401, 'unauthenticated', 'انتهت الجلسة، سجّل الدخول من جديد.'));
    }
    // تجديد انزلاقي للجلسة
    const newExp = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
    if (Date.parse(newExp) - Date.parse(row.expires_at) > 600_000) touch.run(newExp, row.token_hash);
    req.user = { id: row.id, username: row.username, name: row.name, role: row.role, permissions: effectivePerms(row.role, row.permissions), mustChangePassword: !!row.must_change_password };
    req.sessionToken = token;
    next();
  };
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return next(httpError(401, 'unauthenticated', 'سجّل الدخول للمتابعة.'));
    if (!can(req.user, perm)) return next(httpError(403, 'forbidden', 'ليست لديك صلاحية لهذا الإجراء.'));
    if (req.user.mustChangePassword) return next(httpError(403, 'must_change_password', 'يجب تغيير كلمة المرور أولًا.'));
    next();
  };
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, burnTime, generatePassword, checkPasswordStrength,
  createSession, destroySession, destroyUserSessions, purgeExpiredSessions,
  PERMISSIONS, ASSIGNABLE, ASSIGNABLE_KEYS, normalizePerms, effectivePerms, can, authenticate, requirePerm
};
