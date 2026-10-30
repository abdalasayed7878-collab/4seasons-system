'use strict';

/* =====================================================================
   4Seasons — نظام المغسلة (واجهة الكاشير)
   كل البيانات والحسابات على الخادم عبر /api — لا يوجد تخزين محلي للبيانات.
   ===================================================================== */

/* ---------- أدوات عامة ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 });
const round2 = n => Math.round((+n || 0) * 100) / 100;
const num = n => nf.format(round2(n));
const money = n => num(n) + ' ج.م';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = n => `<svg class="ico" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const toLatin = s => String(s ?? '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
const norm = s => toLatin(s).toLowerCase().replace(/[ً-ٟ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isoLocal = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return isoLocal(d); };
const toDate = iso => new Date(iso && iso.length === 10 ? iso + 'T00:00:00' : iso);
const fmtDate = iso => { if (!iso) return '—'; const d = toDate(iso); return isNaN(d) ? '—' : new Intl.DateTimeFormat('ar-EG', { day: 'numeric', month: 'short' }).format(d); };
const fmtDateLong = iso => { if (!iso) return '—'; const d = toDate(iso); return isNaN(d) ? '—' : new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(d); };
const fmtDateTime = iso => { if (!iso) return '—'; const d = toDate(iso); return isNaN(d) ? '—' : new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }).format(d); };
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- المسميات ---------- */
const PAY_LABEL = { cash: 'نقدي', vodafone_cash: 'فودافون كاش', instapay: 'إنستا باي', deferred: 'آجل (عند التسليم)' };
const ROLE_LABEL = { manager: 'مدير', cashier: 'كاشير', accountant: 'محاسب' };
const UNIT_LABEL = { piece: 'قطعة', meter: 'متر', m2: 'متر مربع', service: 'خدمة' };
const PRICING_LABEL = { fixed: 'ثابت', range: 'متغيّر', quote: 'بعد المعاينة' };
const STATUS_LABEL = { pending_pricing: 'بانتظار القياس', in_progress: 'تحت التنفيذ', ready: 'جاهز للتسليم', delivered: 'تم التسليم', cancelled: 'ملغي' };
const statusClass = s => ({ pending_pricing: 'pending', in_progress: 'progress', ready: 'ready' }[s] || 'done');
const statusText = o => o.status === 'pending_pricing' && o.pending === 'price' ? 'بانتظار التسعير' : STATUS_LABEL[o.status] || o.status;
const REQ_LABEL = { new: 'جديد', contacted: 'تم التواصل', converted: 'تم التحويل', cancelled: 'ملغي' };
const VIEW_PERM = { dashboard: 'stats:read', pos: 'orders:create', customers: 'customers:read', orders: 'orders:read', requests: 'requests:read', messages: 'self', settings: 'settings:write' };
const TITLES = { dashboard: 'أهلاً بك في 4Seasons', pos: 'الكاشير والطلبات', customers: 'العملاء', orders: 'متابعة الطلبات', requests: 'طلبات الموقع', messages: 'الرسائل الداخلية', settings: 'إعدادات النظام' };

/* ---------- الحالة ---------- */
let me = null;                       // { user, permissions }
let catalog = { categories: [], services: [], zones: [], settings: {} };
let selectedCustomer = null, cart = [], serviceCat = 0, posTotal = 0, paidTouched = false, saving = false;
let payCustomer = null, pricingOrder = null, alertRows = [], suggestList = [], pollTimer = null;
const custState = { q: '', page: 1, debtors: false };
const ordState = { q: '', status: '', page: 1 };
const reqState = { status: '', page: 1 };
let currentView = '';

const can = perm => !!me && (perm === 'self' || me.permissions.includes('*') || me.permissions.includes(perm));

/* ---------- الاتصال بالخادم ---------- */
class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(e.message || 'تعذر الاتصال بالخادم. حاول مرة أخرى.');
    this.status = status; this.code = e.code; this.field = e.field; this.extra = e;
  }
}

async function api(method, url, body, { raw = false } = {}) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch { throw new ApiError(0, { error: { code: 'network', message: 'تعذر الاتصال بالخادم. تأكد من الاتصال بالشبكة.' } }); }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (res.status === 401 && url !== '/auth/login') sessionExpired();
    else if (res.status === 403 && err.code === 'must_change_password' && me) { me.user.mustChangePassword = true; openPassword(true); }
    throw err;
  }
  return data;
}

// تنفيذ إجراء مع عرض أي خطأ كإشعار
async function guard(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof ApiError) { if (e.status !== 401) toast(e.message, 'err'); } else { console.error(e); toast('حدث خطأ غير متوقع.', 'err'); }
    return undefined;
  }
}

/* ---------- الإشعارات والنوافذ ---------- */
function toast(msg, type = 'ok') {
  const stack = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.setAttribute('role', type === 'err' ? 'alert' : 'status');
  el.innerHTML = `${icon(type === 'err' ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  while (stack.children.length >= 3) stack.firstElementChild.remove();
  stack.append(el);
  try {
    const open = stack.matches(':popover-open');
    if (open && $('dialog[open]')) stack.hidePopover();
    if (!stack.matches(':popover-open')) stack.showPopover();
  } catch { /* المتصفح لا يدعم popover */ }
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => { el.remove(); if (!stack.children.length) { try { stack.hidePopover(); } catch { /* ignore */ } } }, 250);
  }, 3800);
}

function confirmBox(msg, { ok = 'تأكيد', title = 'تأكيد الإجراء', danger = false } = {}) {
  return new Promise(resolve => {
    const d = $('#confirm-dialog'), b = $('#confirm-ok');
    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = msg;
    b.textContent = ok;
    b.className = danger ? 'danger' : 'primary';
    const done = v => { d.close(); resolve(v); };
    b.onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal();
    $('#confirm-cancel').focus();
  });
}

/* ---------- باركود Code 128 (النمط B) ---------- */
const C128 = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112').split(' ');

function code128Pattern(text) {
  const codes = [104];
  let sum = 104;
  [...String(text)].forEach((ch, i) => {
    const v = ch.charCodeAt(0) - 32;
    if (v < 0 || v > 95) throw new Error('حرف غير مدعوم في الباركود');
    codes.push(v);
    sum += v * (i + 1);
  });
  codes.push(sum % 103, 106);
  return codes.map(c => C128[c]).join('');
}

function barcodeSvg(text, { height = 60, quiet = 10, module = 0 } = {}) {
  try {
    const p = code128Pattern(text);
    let x = quiet, bar = true, d = '';
    for (const w of p) { const n = +w; if (bar) d += `M${x} 0h${n}v${height}h-${n}z`; x += n; bar = !bar; }
    const W = x + quiet;
    const size = module ? ` style="width:${W * module}px;max-width:100%;height:${height}px"` : '';
    return `<svg class="barcode-svg"${size} viewBox="0 0 ${W} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="باركود ${esc(text)}"><path d="${d}" fill="#000"/></svg>`;
  } catch { return ''; }
}

/* ---------- ترقيم الصفحات ---------- */
function renderPager(el, { page, pageSize, total }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button type="button" class="secondary small" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>السابق</button>
    <span>صفحة ${num(page)} من ${num(pages)} · ${num(total)} نتيجة</span>
    <button type="button" class="secondary small" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>التالي</button>`;
}

/* ---------- تسجيل الدخول والجلسة ---------- */
const setLoginError = m => { $('#login-error').textContent = m || ''; };
let loginPassword = '';

async function login(e) {
  e.preventDefault();
  const username = $('#login-username').value.trim(), password = $('#login-password').value;
  if (!username || !password) return setLoginError('أدخل اسم المستخدم وكلمة المرور.');
  const btn = e.submitter || $('#login-form button[type=submit]');
  btn.disabled = true;
  try {
    me = await api('POST', '/auth/login', { username, password });
    setLoginError('');
    loginPassword = password;
    $('#login-form').reset();
    if (me.user.mustChangePassword) openPassword(true);
    else await boot();
  } catch (err) {
    setLoginError(err.message);
  } finally { btn.disabled = false; }
}

function sessionExpired() {
  if (!me) return;
  me = null;
  stopPolling();
  $$('dialog[open]').forEach(d => d.close());
  showLogin('انتهت الجلسة، سجّل الدخول من جديد.');
}

function showLogin(msg = '') {
  $('#login-screen').classList.remove('hidden');
  $('.app-shell').inert = true;
  setLoginError(msg);
  $('#login-username').focus();
}

async function logout() {
  try { await api('POST', '/auth/logout'); } catch { /* ignore */ }
  me = null; selectedCustomer = null; cart = [];
  stopPolling();
  $('#login-form').reset();
  showLogin();
}

async function loadCatalog() {
  if (!can('catalog:read')) return;
  catalog = await api('GET', '/catalog');
}

async function boot() {
  await loadCatalog();
  const u = me.user;
  $('#sidebar-user').textContent = u.name;
  $('#sidebar-role').textContent = u.role === 'manager' ? 'صلاحية كاملة' : 'صلاحيات ' + ROLE_LABEL[u.role];
  $('#role-avatar').textContent = [...u.name][0] || '؟';
  $('#current-user').textContent = u.name;
  $('#branch-pill').textContent = `فرع ${catalog.settings.branch || ''}`.trim();
  $$('.nav-item').forEach(b => { b.hidden = !can(VIEW_PERM[b.dataset.view]); });
  $$('[data-go]').forEach(b => { b.hidden = !can(VIEW_PERM[b.dataset.go]); });
  renderCategories(); renderServices(); renderZonesSelect(); resetPos();
  $('#login-screen').classList.add('hidden');
  $('.app-shell').inert = false;
  const first = ['dashboard', 'pos', 'orders', 'customers', 'requests', 'settings'].find(v => can(VIEW_PERM[v]));
  if (first) show(first);
  startPolling();
}

/* ---------- تغيير كلمة المرور ---------- */
function openPassword(forced = false) {
  const d = $('#password-dialog');
  $('#password-form').reset();
  $('#pw-error').textContent = '';
  d.dataset.forced = forced ? '1' : '';
  $('#pw-close').hidden = forced;
  $('#pw-title').textContent = forced ? 'اختر كلمة مرور جديدة' : 'تغيير كلمة المرور';
  $('#pw-sub').textContent = forced ? 'هذه كلمة مرور مؤقتة. اختر كلمة مرور خاصة بك قبل المتابعة (8 أحرف على الأقل، بها حروف وأرقام).' : 'استخدم 8 أحرف على الأقل، بها حروف وأرقام.';
  const curLabel = $('#pw-current').closest('label');
  if (forced && loginPassword) { $('#pw-current').value = loginPassword; curLabel.hidden = true; } else curLabel.hidden = false;
  if (!d.open) d.showModal();
  (curLabel.hidden ? $('#pw-new') : $('#pw-current')).focus();
}

async function submitPassword(e) {
  e.preventDefault();
  const cur = $('#pw-current').value, next = $('#pw-new').value, conf = $('#pw-confirm').value;
  const err = $('#pw-error');
  if (!cur) { err.textContent = 'أدخل كلمة المرور الحالية.'; return; }
  if (next !== conf) { err.textContent = 'تأكيد كلمة المرور غير مطابق.'; return; }
  try {
    await api('POST', '/auth/password', { current: cur, next });
  } catch (ex) { err.textContent = ex.message; return; }
  const wasForced = $('#password-dialog').dataset.forced === '1';
  loginPassword = '';
  me.user.mustChangePassword = false;
  $('#password-dialog').dataset.forced = '';
  $('#password-dialog').close();
  toast('تم تغيير كلمة المرور.');
  if (wasForced) await boot();
}

/* ---------- التنقل ---------- */
function show(view) {
  if (!can(VIEW_PERM[view])) return;
  currentView = view;
  $$('.view').forEach(e => e.classList.toggle('active', e.id === view));
  $$('.nav-item').forEach(e => {
    const on = e.dataset.view === view;
    e.classList.toggle('active', on);
    if (on) e.setAttribute('aria-current', 'page'); else e.removeAttribute('aria-current');
  });
  $('#page-title').textContent = TITLES[view];
  document.title = (view === 'dashboard' ? '4Seasons' : TITLES[view] + ' | 4Seasons');
  if (view === 'dashboard') loadDashboard();
  if (view === 'pos') renderZonesSelect();
  if (view === 'customers') { $('#customer-filter').value = custState.q; $('#debtors-only').checked = custState.debtors; loadCustomers(); }
  if (view === 'orders') { $('#order-search').value = ordState.q; loadOrders(); }
  if (view === 'requests') { loadRequests(); loadOtps(); }
  if (view === 'messages') loadMessages();
  if (view === 'settings') loadSettings();
  if (drawerMode()) setMenuOpen(false);
  window.scrollTo(0, 0);
}

function startPolling() {
  stopPolling();
  refreshBadge(); refreshMsgBadge();
  pollTimer = setInterval(() => { if (!document.hidden) { refreshBadge(); refreshMsgBadge(); } }, 20000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

async function refreshBadge() {
  if (!me || !can('stats:read') || !can('requests:read')) return;
  try {
    const s = await api('GET', '/stats');
    badgeParts.otps = s.pendingOtps || 0; setBadge(s.newRequests);
    if (s.pendingOtps > otpSeen && !$('#requests').classList.contains('active')) toast(`عميل سابق طلب كود تحقق (${num(s.pendingOtps)})`);
    otpSeen = s.pendingOtps || 0;
    if (!$('#requests').hidden && $('#requests').classList.contains('active') && can('requests:read')) loadOtps();
  } catch { /* ignore */ }
}
const badgeParts = { reqs: 0, otps: 0 };
let otpSeen = 0;
function setBadge(n) {
  if (n != null) badgeParts.reqs = n;
  const total = badgeParts.reqs + badgeParts.otps;
  const b = $('#requests-badge');
  b.hidden = !total; b.textContent = num(total);
}

/* ---------- الرئيسية ---------- */
const totalText = o => o.status === 'pending_pricing' ? (o.total ? `${money(o.total)} + ${o.pending === 'price' ? 'تسعير' : 'قياس'}` : (o.pending === 'price' ? 'بانتظار التسعير' : 'بانتظار القياس')) : money(o.total);
let dashSeq = 0;

async function loadDashboard() {
  const seq = ++dashSeq;
  const [s, recent] = await Promise.all([
    guard(() => api('GET', '/stats')),
    can('orders:read') ? guard(() => api('GET', '/orders?pageSize=5')) : Promise.resolve(null)
  ]);
  if (seq !== dashSeq || !s) return;
  $('#stat-sales').textContent = money(s.salesToday);
  $('#stat-sales-sub').textContent = s.ordersToday ? `من ${num(s.ordersToday)} طلب اليوم · تحصيل ${money(s.collectedToday)}` : 'لا توجد طلبات اليوم بعد';
  $('#stat-active').textContent = num(s.active);
  $('#stat-active-sub').textContent = `${num(s.ready)} جاهزة للتسليم · ${num(s.pendingPricing)} بانتظار القياس`;
  $('#stat-due').textContent = money(s.dueTotal);
  $('#stat-due-sub').textContent = s.debtors ? `${num(s.debtors)} عميل عليهم رصيد` : 'لا توجد أرصدة معلّقة';
  $('#stat-deliveries').textContent = num(s.deliveriesToday);
  $('#stat-deliveries-sub').textContent = s.late ? `${num(s.late)} طلب متأخر عن الموعد` : 'لا توجد طلبات متأخرة';
  badgeParts.otps = s.pendingOtps || 0; setBadge(s.newRequests);

  const list = recent?.items || [];
  $('#recent-orders').innerHTML = list.length ? list.map(o => `
    <button type="button" class="mini-order" data-go-order="${esc(o.code)}">
      <i class="order-dot ${statusClass(o.status)}"></i>
      <div><b>${esc(o.code)} · ${esc(o.customer)}</b><span>${esc(o.items)} · ${esc(statusText(o))}</span></div>
      <span class="amount">${esc(totalText(o))}</span>
    </button>`).join('') : '<p class="empty-note">لا توجد طلبات بعد</p>';

  alertRows = [];
  if (s.pendingOtps && can('requests:read')) alertRows.push({ tone: 'amber', ico: 'package', title: `${num(s.pendingOtps)} كود تحقق`, text: 'عملاء سابقون بانتظار الكود على واتساب', view: 'requests' });
  if (s.newRequests && can('requests:read')) alertRows.push({ tone: 'amber', ico: 'package', title: `${num(s.newRequests)} طلب`, text: 'جديد من الموقع بانتظار التواصل', view: 'requests', apply: () => { reqState.status = 'new'; reqState.page = 1; } });
  if (s.ready) alertRows.push({ tone: 'green', ico: 'truck', title: `${num(s.ready)} طلب`, text: 'جاهزة للتسليم', view: 'orders', apply: () => { ordState.status = 'ready'; ordState.q = ''; ordState.page = 1; } });
  if (s.pendingPricing) alertRows.push({ tone: 'amber', ico: 'ruler', title: `${num(s.pendingPricing)} طلب`, text: 'تحتاج قياسًا أو تسعيرًا', view: 'orders', apply: () => { ordState.status = 'pending_pricing'; ordState.q = ''; ordState.page = 1; } });
  if (s.late) alertRows.push({ tone: 'red', ico: 'clock', title: `${num(s.late)} طلب`, text: 'متأخرة عن موعد التسليم', view: 'orders', apply: () => { ordState.status = 'late'; ordState.q = ''; ordState.page = 1; } });
  if (s.dueTotal > 0) alertRows.push({ tone: 'red', ico: 'wallet', title: money(s.dueTotal), text: 'أرصدة مستحقة للتحصيل', view: 'customers', apply: () => { custState.debtors = true; custState.q = ''; custState.page = 1; } });
  alertRows = alertRows.filter(a => can(VIEW_PERM[a.view]));
  $('#alerts').innerHTML = alertRows.length ? alertRows.map((a, i) => `
    <button type="button" class="alert-row" data-alert="${i}">
      <span class="alert-ico ${a.tone}">${icon(a.ico)}</span>
      <div><b>${esc(a.title)}</b><span class="t">${esc(a.text)}</span></div>
      <span class="go">${icon('arrow')}</span>
    </button>`).join('') : '<p class="empty-note">لا توجد تنبيهات — كل شيء تحت السيطرة.</p>';
}

/* ---------- الكاشير: الخدمات والسلة ---------- */
const stepOf = x => x.unit === 'meter' ? 0.5 : 1;
const isPending = x => !x.fee && (x.pricing === 'quote' || x.unit === 'm2');
const svcActive = () => catalog.services.filter(s => s.active);

const priceLabel = s => {
  if (s.pricing === 'quote') return 'بعد المعاينة';
  const unit = s.unit === 'm2' ? '/م²' : s.unit === 'meter' ? '/م' : '';
  return `${num(s.min)}${s.max !== s.min ? '–' + num(s.max) : ''} ج.م${unit}`;
};

function renderCategories() {
  const cats = catalog.categories.filter(c => c.active);
  $('#service-cats').innerHTML = [`<button type="button" class="cat${serviceCat === 0 ? ' active' : ''}" data-cat="0">الكل</button>`]
    .concat(cats.map(c => `<button type="button" class="cat${serviceCat === c.id ? ' active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`)).join('');
}

function renderServices() {
  const q = norm($('#service-search').value);
  const list = svcActive().filter(s => (!serviceCat || s.categoryId === serviceCat) && norm(s.name).includes(q));
  $('#service-options').innerHTML = list.length
    ? list.map(s => `<button type="button" class="chip" data-service="${s.id}">${esc(s.name)}<em>${priceLabel(s)}</em></button>`).join('')
    : '<p class="empty-note">لا توجد خدمات مطابقة</p>';
}

function addFromSearch() {
  const q = norm($('#service-search').value);
  if (!q) return toast('اكتب اسم الخدمة أو اخترها من القائمة.', 'err');
  const s = svcActive().find(x => (!serviceCat || x.categoryId === serviceCat) && norm(x.name).includes(q));
  if (!s) return toast('لا توجد خدمة بهذا الاسم.', 'err');
  addService(s.id);
  $('#service-search').value = '';
  renderServices();
}

function addService(id) {
  const s = catalog.services.find(x => x.id === id);
  if (!s) return;
  const existing = cart.find(x => x.serviceId === s.id);
  if (existing) existing.qty = round2(existing.qty + stepOf(existing));
  else cart.push({ key: uid(), serviceId: s.id, name: s.name, unit: s.unit, pricing: s.pricing, qty: 1, price: s.min ?? 0, min: s.min, max: s.max });
  renderCart();
}

const lineSub = x => x.fee ? 'رسوم إضافية' + (x.note ? ' — ' + x.note : '')
  : x.pricing === 'quote' ? 'يُحدد السعر بعد المعاينة'
  : x.unit === 'm2' ? `تُحسب بعد القياس — ${money(x.price)} لكل م²`
  : 'لكل ' + (UNIT_LABEL[x.unit] || 'قطعة');
const lineTotalText = x => x.fee ? money(x.price) : x.pricing === 'quote' ? 'بعد المعاينة' : x.unit === 'm2' ? 'بعد القياس' : money(x.price * x.qty);

function renderCart() {
  const el = $('#cart');
  if (!cart.length) {
    el.className = 'cart empty-state';
    el.textContent = 'لا توجد قطع في الطلب بعد';
    updateTotals();
    return;
  }
  el.className = 'cart';
  el.innerHTML = cart.map((x, i) => `
    <div class="cart-row" data-i="${i}">
      <div class="cart-name"><b>${esc(x.name)}</b><small>${esc(lineSub(x))}</small></div>
      <button type="button" class="remove" data-remove="${i}" aria-label="حذف ${esc(x.name)}">${icon('x')}</button>
      <div class="cart-ctrl">
        ${x.fee ? '' : `<div class="qty">
          <button type="button" data-dec="${i}" aria-label="تقليل الكمية">${icon('minus')}</button>
          <input type="number" min="${stepOf(x)}" step="${stepOf(x)}" value="${x.qty}" data-qty="${i}" aria-label="الكمية" inputmode="decimal" />
          <button type="button" data-inc="${i}" aria-label="زيادة الكمية">${icon('plus')}</button>
        </div>`}
        ${(!x.fee && x.pricing === 'range')
          ? `<label class="price-input">السعر<input type="number" data-price="${i}" min="${x.min}" max="${x.max}" value="${x.price}" inputmode="decimal" aria-label="السعر بين ${x.min} و ${x.max}" /></label>`
          : ''}
      </div>
      <b class="line-total ${isPending(x) ? 'later' : ''}" data-total="${i}">${lineTotalText(x)}</b>
    </div>`).join('');
  updateTotals();
}

function refreshLine(i) {
  const x = cart[i], t = $(`[data-total="${i}"]`);
  if (t) t.textContent = lineTotalText(x);
  updateTotals();
}

function currentZone() { return catalog.zones.find(z => String(z.id) === $('#zone').value); }

function updateTotals() {
  const subtotal = round2(cart.reduce((s, x) => s + (isPending(x) ? 0 : x.price * x.qty), 0));
  const fee = currentZone()?.fee || 0;
  posTotal = round2(subtotal + fee);
  $('#subtotal').textContent = money(subtotal);
  $('#delivery-fee').textContent = money(fee);
  $('#grand-total').textContent = money(posTotal);
  const later = cart.filter(isPending).length;
  const note = $('#pending-note');
  note.hidden = !later;
  if (later) note.textContent = `${num(later)} بند يُسعَّر لاحقًا (قياس السجاد / المعاينة) ولا يدخل في الإجمالي الآن.`;
  syncPaid();
  return { subtotal, fee, total: posTotal };
}

function syncPaid() {
  const method = $('#payment').value, inp = $('#paid');
  if (method === 'deferred') { inp.readOnly = true; inp.value = 0; }
  else {
    inp.readOnly = false;
    inp.max = posTotal;
    if (!paidTouched) inp.value = posTotal;
    else if (+inp.value > posTotal) inp.value = posTotal;
  }
  const rem = Math.max(0, posTotal - (+inp.value || 0));
  const r = $('#remaining');
  r.textContent = money(rem);
  r.classList.toggle('due', rem > 0);
}

/* ---------- الكاشير: العميل ---------- */
function renderZonesSelect() {
  const zones = catalog.zones.filter(z => z.active);
  const zEl = $('#zone'), zCur = zEl.value;
  zEl.innerHTML = '<option value="">بدون توصيل</option>' + zones.map(z =>
    `<option value="${z.id}"${String(z.id) === zCur ? ' selected' : ''}>${esc(z.name)}${z.fee ? ` (+${num(z.fee)} ج.م)` : ''}</option>`).join('');
  const cEl = $('#c-zone'), cCur = cEl.value;
  cEl.innerHTML = '<option value="">اختر المنطقة</option>' + zones.map(z => `<option value="${z.id}"${String(z.id) === cCur ? ' selected' : ''}>${esc(z.name)}</option>`).join('');
}

function closeSuggest() {
  const box = $('#customer-suggest');
  box.hidden = true; box.innerHTML = '';
  $('#customer-search').setAttribute('aria-expanded', 'false');
}

let suggestSeq = 0;
const searchCustomers = debounce(async () => {
  const text = $('#customer-search').value.trim();
  if (norm(text).length < 2) { closeSuggest(); return; }
  const seq = ++suggestSeq;
  let r;
  try { r = await api('GET', '/customers?pageSize=6&q=' + encodeURIComponent(text)); } catch { return; }
  if (seq !== suggestSeq) return;
  suggestList = r.items;
  const box = $('#customer-suggest');
  box.innerHTML = suggestList.length
    ? suggestList.map((c, i) => `<button type="button" role="option" data-pick="${i}"${i === 0 ? ' class="on"' : ''}><b>${esc(c.name)}</b><small>${esc(c.phone)} · ${esc(c.code)}</small></button>`).join('')
    : '<span class="suggest-empty">لا يوجد عميل مطابق — يمكنك إضافة عميل جديد</span>';
  box.hidden = false;
  $('#customer-search').setAttribute('aria-expanded', 'true');
}, 250);

function selectCustomer(c) {
  selectedCustomer = c;
  suggestSeq++;
  closeSuggest();
  $('#customer-search').value = '';
  const box = $('#selected-customer');
  box.className = 'empty-state selected-customer';
  box.innerHTML = `
    <div class="sc-avatar">${esc([...c.name][0] || '؟')}</div>
    <div class="sc-info">
      <b>${esc(c.name)} <small>${esc(c.code)}</small></b>
      <small class="line"><span dir="ltr">${esc(c.phone)}</span></small>
      <small class="line">${esc(c.address || 'لا يوجد عنوان')}</small>
      ${c.balance > 0 ? `<small class="due">رصيد مستحق: ${money(c.balance)}</small>` : ''}
    </div>
    <button type="button" class="text-btn sc-change" data-clear-customer>تغيير</button>`;
  if (c.zoneId && catalog.zones.some(z => z.id === c.zoneId && z.active)) $('#zone').value = String(c.zoneId);
  updateTotals();
}

function clearCustomer() {
  selectedCustomer = null;
  const box = $('#selected-customer');
  box.className = 'empty-state';
  box.textContent = 'ابحث عن عميل أو أضف عميلًا جديدًا';
}

function resetPos() {
  cart = []; paidTouched = false;
  clearCustomer();
  $('#zone').value = '';
  $('#order-note').value = '';
  $('#payment').value = 'cash';
  const dd = $('#delivery-date');
  dd.min = isoLocal();
  dd.value = addDays(+catalog.settings.turnaround_days || 4);
  $('#customer-search').value = '';
  closeSuggest();
  renderCart();
}

function openCustomerDialog(c = null) {
  renderZonesSelect();
  $('#customer-form').reset();
  $$('#customer-form .invalid').forEach(i => i.classList.remove('invalid'));
  $('#c-id').value = c ? c.id : '';
  $('#cd-title').textContent = c ? 'تعديل بيانات العميل' : 'عميل جديد';
  $('#cd-sub').textContent = c ? c.code : 'سينشئ النظام رقم عميل وباركودًا تلقائيًا.';
  $('#c-submit').textContent = c ? 'حفظ التعديلات' : 'حفظ وإنشاء البطاقة';
  if (c) {
    $('#c-name').value = c.name; $('#c-phone').value = c.phone; $('#c-address').value = c.address || '';
    $('#c-zone').value = c.zoneId ? String(c.zoneId) : ''; $('#c-notes').value = c.notes || '';
  }
  $('#customer-dialog').showModal();
  $('#c-name').focus();
}

async function submitCustomer(e) {
  e.preventDefault();
  const nameEl = $('#c-name'), phoneEl = $('#c-phone');
  const name = nameEl.value.trim();
  const phone = toLatin(phoneEl.value).replace(/[\s-]/g, '').replace(/^(\+?20|0020)/, '0');
  if (name.length < 2) { nameEl.classList.add('invalid'); nameEl.focus(); return toast('أدخل اسم العميل.', 'err'); }
  if (!/^01[0125]\d{8}$/.test(phone) && !/^0\d{8,10}$/.test(phone)) { phoneEl.classList.add('invalid'); phoneEl.focus(); return toast('رقم الهاتف غير صحيح. مثال: 01012345678', 'err'); }
  const id = $('#c-id').value;
  const body = { name, phone, address: $('#c-address').value.trim(), zoneId: $('#c-zone').value ? +$('#c-zone').value : null, notes: $('#c-notes').value.trim() };
  const btn = $('#c-submit'); btn.disabled = true;
  try {
    const c = id ? await api('PUT', '/customers/' + id, body) : await api('POST', '/customers', body);
    $('#customer-dialog').close();
    if (id) {
      toast('تم تحديث بيانات العميل.');
      if (selectedCustomer?.id === c.id) selectCustomer(c);
      if (currentView === 'customers') loadCustomers();
    } else {
      selectCustomer(c);
      if (currentView === 'customers') loadCustomers();
      openCard(c);
    }
  } catch (err) {
    if (err.code === 'phone_exists' && err.extra?.customer) {
      $('#customer-dialog').close();
      selectCustomer(err.extra.customer);
      toast(err.message, 'err');
    } else if (err.status !== 401) toast(err.message, 'err');
  } finally { btn.disabled = false; }
}

function openCard(c) {
  $('#digital-name').textContent = c.name;
  $('#digital-id').textContent = c.code;
  $('#barcode').innerHTML = barcodeSvg(c.code, { height: 60, module: 2 });
  $('#barcode-text').textContent = c.code;
  $('#card-dialog').showModal();
}

/* ---------- حفظ الطلب والفاتورة ---------- */
async function saveOrder() {
  if (saving) return;
  if (!selectedCustomer) return toast('اختر العميل أولًا.', 'err');
  if (!cart.length) return toast('أضف قطعة أو خدمة واحدة على الأقل.', 'err');
  const delivery = $('#delivery-date').value;
  if (delivery && delivery < isoLocal()) return toast('موعد التسليم لا يمكن أن يكون في الماضي.', 'err');
  const t = updateTotals(), method = $('#payment').value;
  const paid = method === 'deferred' ? 0 : round2(+$('#paid').value || 0);
  if (paid > t.total) return toast('المبلغ المدفوع أكبر من إجمالي الطلب.', 'err');

  const body = {
    customerId: selectedCustomer.id, zoneId: $('#zone').value ? +$('#zone').value : null,
    deliveryDate: delivery || null, note: $('#order-note').value.trim() || null,
    paymentMethod: method, paid,
    lines: cart.map(x => x.fee ? { fee: true, name: x.name, amount: x.price, note: x.note || null }
      : { serviceId: x.serviceId, qty: x.qty, ...(x.pricing === 'range' ? { unitPrice: x.price } : {}) })
  };
  saving = true;
  const btn = $('#save-order'); btn.disabled = true;
  try {
    const order = await api('POST', '/orders', body);
    resetPos();
    openInvoice(order, true);
    refreshBadge();
  } catch (e) { if (e.status !== 401) toast(e.message, 'err'); }
  finally { saving = false; btn.disabled = false; }
}

const piecesOf = l => l.unit === 'meter' || l.unit === 'service' ? 1 : Math.max(1, Math.ceil(l.qty));

function receiptHtml(o) {
  const s = catalog.settings;
  const rows = o.lines.map(l => {
    let qty, unit, amt;
    if (l.kind === 'fee') { qty = '—'; unit = num(l.unitPrice); amt = num(l.total); }
    else {
      qty = l.unit === 'm2' ? (l.area ? `${num(l.area)} م²` : `${num(l.qty)} قطعة`) : num(l.qty);
      unit = l.unitPrice == null ? '—' : num(l.unitPrice);
      amt = l.total == null ? (l.needs === 'price' ? 'بعد المعاينة' : 'بعد القياس') : num(l.total);
    }
    return `<tr><td>${esc(l.name)}${l.note ? `<span class="sub">${esc(l.note)}</span>` : ''}</td><td>${qty}</td><td>${unit}</td><td>${amt}</td></tr>`;
  }).join('');
  const pending = o.lines.some(l => l.total == null);
  return `
    <div class="r-head">
      <img class="r-logo" src="logo.png" alt="${esc(s.business_name || '4Seasons')}" width="150" height="132">${s.branch ? `<small>فرع ${esc(s.branch)}</small>` : ''}${s.phone ? `<small dir="ltr">${esc(s.phone)}</small>` : ''}
    </div>
    <dl class="r-meta">
      <dt>رقم الطلب</dt><dd>${esc(o.code)}</dd>
      <dt>التاريخ</dt><dd>${esc(fmtDateTime(o.createdAt))}</dd>
      <dt>العميل</dt><dd>${esc(o.customer)}</dd>
      <dt>الهاتف</dt><dd dir="ltr">${esc(o.phone)}</dd>
      ${o.zone ? `<dt>المنطقة</dt><dd>${esc(o.zone)}</dd>` : ''}
      <dt>موعد التسليم</dt><dd>${esc(fmtDateLong(o.delivery))}</dd>
      <dt>طريقة الدفع</dt><dd>${esc(PAY_LABEL[o.method] || o.method)}</dd>
    </dl>
    <table><thead><tr><th>الصنف</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="r-sum">
      <p><span>إجمالي الخدمات</span><b>${money(o.subtotal)}</b></p>
      ${o.deliveryFee ? `<p><span>التوصيل</span><b>${money(o.deliveryFee)}</b></p>` : ''}
      <p class="grand"><span>الإجمالي</span><b>${money(o.total)}</b></p>
      <p><span>المدفوع</span><b>${money(o.paid)}</b></p>
      <p><span>المتبقي</span><b>${money(o.remaining)}</b></p>
    </div>
    ${pending ? '<p class="r-note">* يُحسب سعر السجاد / المعاينة لاحقًا وتُضاف قيمته إلى الإجمالي.</p>' : ''}
    ${o.note ? `<p class="r-note">ملاحظات: ${esc(o.note)}</p>` : ''}
    <div class="r-barcode">${barcodeSvg(o.code, { height: 46, module: 2 })}</div>
    <p class="r-id">${esc(o.code)}</p>
    <p class="r-thanks">شكرًا لثقتكم في ${esc(s.business_name || '4Seasons')} — يُرجى إحضار الفاتورة عند الاستلام</p>`;
}

function labelsHtml(o) {
  const items = o.lines.filter(l => l.kind !== 'fee');
  const total = items.reduce((s, l) => s + piecesOf(l), 0);
  let n = 0;
  return items.flatMap(l => Array.from({ length: piecesOf(l) }, () => {
    n++;
    const code = `${o.code}-${n}`;
    return `<div class="label">
      <div class="l-top"><span>${esc(o.code)}</span><span>${num(n)}/${num(total)}</span></div>
      <div><div class="l-name">${esc(l.name)}</div><div class="l-sub">${esc(o.customer)}${o.delivery ? ' · تسليم ' + esc(fmtDate(o.delivery)) : ''}</div></div>
      ${barcodeSvg(code, { height: 40, quiet: 6 })}
      <div class="l-code">${esc(code)}</div>
    </div>`;
  })).join('');
}

function openInvoice(o, justSaved = false) {
  $('#invoice-title').textContent = justSaved ? `تم حفظ الطلب ${o.code}` : `فاتورة الطلب ${o.code}`;
  $('#invoice-sheet').innerHTML = receiptHtml(o);
  $('#labels-sheet').innerHTML = labelsHtml(o);
  $('#invoice-dialog').showModal();
}

/* ---------- العملاء ---------- */
let custSeq = 0;
async function loadCustomers() {
  const seq = ++custSeq;
  const qs = new URLSearchParams({ page: custState.page, pageSize: 25 });
  if (custState.q) qs.set('q', custState.q);
  if (custState.debtors) qs.set('debtors', '1');
  const r = await guard(() => api('GET', '/customers?' + qs));
  if (!r || seq !== custSeq) return;
  $('#customer-count').textContent = `${num(r.total)} عميل`;
  const writable = can('customers:write'), collect = can('payments:collect');
  $('#add-customer-top').hidden = !writable;
  $('#customer-table').innerHTML = r.items.length ? r.items.map(c => `
    <tr>
      <td data-label="رقم العميل"><b>${esc(c.code)}</b></td>
      <td data-label="العميل">${esc(c.name)}${c.address ? `<span class="sub">${esc(c.address)}</span>` : ''}</td>
      <td data-label="الهاتف"><span class="ltr">${esc(c.phone)}</span></td>
      <td data-label="المنطقة">${esc(c.zone || '—')}</td>
      <td data-label="الرصيد المستحق">${c.balance > 0 ? `<span class="due-amount">${money(c.balance)}</span>` : '—'}</td>
      <td class="actions">
        ${c.balance > 0 && collect ? `<button type="button" class="action ok" data-pay="${c.id}">${icon('wallet')}تحصيل</button>` : ''}
        ${can('orders:create') ? `<button type="button" class="action go" data-neworder="${c.id}">${icon('plus')}طلب</button>` : ''}
        <button type="button" class="action" data-card="${c.id}">${icon('id')}البطاقة</button>
        ${writable ? `<button type="button" class="action" data-edit="${c.id}">تعديل</button>` : ''}
        ${can('admin:edit') ? `<button type="button" class="action" data-cadmin="${c.id}">تحكم</button>` : ''}
      </td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-row">لا يوجد عملاء مطابقون للبحث</td></tr>';
  custRows = new Map(r.items.map(c => [c.id, c]));
  renderPager($('#customer-pager'), r);
}
let custRows = new Map();

function openPayment(c) {
  payCustomer = c;
  $('#pay-customer').textContent = c.name;
  $('#pay-balance').textContent = money(c.balance);
  const i = $('#pay-amount');
  i.value = c.balance; i.max = c.balance;
  i.classList.remove('invalid');
  $('#pay-method').value = 'cash';
  $('#payment-dialog').showModal();
  i.select();
}

async function submitPayment(e) {
  e.preventDefault();
  const c = payCustomer, a = round2(+$('#pay-amount').value);
  if (!c || !(a > 0)) { $('#pay-amount').classList.add('invalid'); return toast('أدخل مبلغًا صحيحًا.', 'err'); }
  if (a > c.balance + 0.001) { $('#pay-amount').classList.add('invalid'); return toast(`المبلغ أكبر من الرصيد المستحق (${money(c.balance)}).`, 'err'); }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    await api('POST', `/customers/${c.id}/payments`, { amount: a, method: $('#pay-method').value });
    $('#payment-dialog').close();
    toast(`تم تحصيل ${money(a)} من ${c.name}.`);
    if (currentView === 'customers') loadCustomers(); else if (currentView === 'dashboard') loadDashboard();
  } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- الطلبات ---------- */
const TABS = [['', 'الكل', 'all'], ['pending_pricing', 'بانتظار القياس', 'pending_pricing'], ['in_progress', 'تحت التنفيذ', 'in_progress'], ['ready', 'جاهز للتسليم', 'ready'], ['delivered', 'تم التسليم', 'delivered'], ['late', 'متأخرة', 'late']];

function actionButton(o) {
  if (!can('orders:update')) return '';
  const id = o.id;
  if (o.status === 'pending_pricing') return `<button type="button" class="action go" data-next="${id}">${icon('ruler')}${o.pending === 'price' ? 'إدخال السعر' : 'إدخال القياس'}</button>`;
  if (o.status === 'in_progress') return `<button type="button" class="action go" data-next="${id}">${icon('check')}جاهز للتسليم</button>`;
  if (o.status === 'ready') return `<button type="button" class="action ok" data-next="${id}">${icon('truck')}تأكيد التسليم</button>`;
  return '';
}

let ordSeq = 0, ordRows = new Map();
async function loadOrders() {
  const seq = ++ordSeq;
  const qs = new URLSearchParams({ page: ordState.page, pageSize: 25, counts: '1' });
  if (ordState.q) qs.set('q', ordState.q);
  if (ordState.status) qs.set('status', ordState.status);
  const r = await guard(() => api('GET', '/orders?' + qs));
  if (!r || seq !== ordSeq) return;
  $('#status-tabs').innerHTML = TABS.map(([v, l, k]) =>
    `<button type="button" class="tab${ordState.status === v ? ' active' : ''}" data-filter="${esc(v)}" role="tab" aria-selected="${ordState.status === v}">${esc(l)}<span class="n">${num(r.counts?.[k] ?? 0)}</span></button>`).join('');
  ordRows = new Map(r.items.map(o => [o.id, o]));
  $('#orders-table').innerHTML = r.items.length ? r.items.map(o => `
    <tr>
      <td data-label="رقم الطلب"><b>${esc(o.code)}</b></td>
      <td data-label="العميل">${esc(o.customer)}</td>
      <td class="items" data-label="القطع" title="${esc(o.items)}">${esc(o.items)}</td>
      <td data-label="موعد التسليم">${esc(fmtDate(o.delivery))}${o.late ? '<span class="late-badge">متأخر</span>' : ''}</td>
      <td data-label="الحالة"><span class="status ${statusClass(o.status)}">${esc(statusText(o))}</span></td>
      <td data-label="الإجمالي">${esc(totalText(o))}${o.remaining > 0 && o.status !== 'pending_pricing' ? `<span class="sub due">متبقي ${money(o.remaining)}</span>` : ''}</td>
      <td class="actions">${actionButton(o)}${can('admin:edit') ? `<button type="button" class="action" data-oadmin="${o.id}">تحكم</button>` : ''}<button type="button" class="action" data-invoice="${o.id}" title="عرض الفاتورة" aria-label="عرض فاتورة ${esc(o.code)}">${icon('receipt')}</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-row">لا توجد طلبات مطابقة</td></tr>';
  renderPager($('#orders-pager'), r);
}

async function advanceOrder(id) {
  const o = ordRows.get(id);
  if (!o) return;
  if (o.status === 'pending_pricing') return openPricing(id);
  if (o.status === 'in_progress') {
    const r = await guard(() => api('POST', `/orders/${id}/status`, { status: 'ready' }));
    if (r) { toast(`الطلب ${o.code} جاهز للتسليم.`); loadOrders(); }
  } else if (o.status === 'ready') {
    const due = o.remaining > 0 ? ` المتبقي على الطلب: ${money(o.remaining)}.` : '';
    const ok = await confirmBox(`تأكيد تسليم الطلب ${o.code} للعميل ${o.customer}؟${due}`, { ok: 'تأكيد التسليم', title: 'تسليم الطلب' });
    if (!ok) return;
    const r = await guard(() => api('POST', `/orders/${id}/status`, { status: 'delivered' }));
    if (r) { toast(`تم تسليم الطلب ${o.code}.`); loadOrders(); }
  }
}

/* ---------- القياس والتسعير ---------- */
async function openPricing(id) {
  const o = await guard(() => api('GET', '/orders/' + id));
  if (!o) return;
  pricingOrder = o;
  const pend = o.lines.filter(l => l.needs);
  $('#md-title').textContent = pend.every(l => l.needs === 'area') ? 'إدخال قياس السجاد' : 'إدخال القياس أو التسعير';
  $('#measure-sub').textContent = `الطلب ${o.code} — ${o.customer}. أدخل المساحة بالمتر المربع بعد الغسيل، أو السعر بعد المعاينة.`;
  $('#measure-fields').innerHTML = pend.map(l => l.needs === 'area'
    ? `<div class="measure-row"><label for="m-${l.id}">${esc(l.name)} — ${num(l.qty)} قطعة<small>${money(l.unitPrice)} لكل م²</small>
        <input id="m-${l.id}" data-m="${l.id}" data-kind="area" data-rate="${l.unitPrice}" type="number" min="0.1" step="any" inputmode="decimal" placeholder="إجمالي المساحة بالمتر المربع" /></label></div>`
    : `<div class="measure-row"><label for="m-${l.id}">${esc(l.name)}${l.qty > 1 ? ` × ${num(l.qty)}` : ''}<small>سعر الوحدة بعد المعاينة</small>
        <input id="m-${l.id}" data-m="${l.id}" data-kind="price" data-qty="${l.qty}" type="number" min="1" step="any" inputmode="decimal" placeholder="السعر بالجنيه" /></label></div>`).join('');
  updatePricingTotal();
  $('#measure-dialog').showModal();
  $('#measure-fields input')?.focus();
}

function updatePricingTotal() {
  const t = $$('#measure-fields input').reduce((s, i) => {
    const v = +i.value;
    if (!(v > 0)) return s;
    return s + (i.dataset.kind === 'area' ? v * +i.dataset.rate : v * +i.dataset.qty);
  }, 0);
  $('#measure-total').textContent = money(t);
}

async function submitPricing(e) {
  e.preventDefault();
  const o = pricingOrder;
  if (!o) return;
  const inputs = $$('#measure-fields input');
  let ok = true;
  inputs.forEach(i => { const bad = !(+i.value > 0); i.classList.toggle('invalid', bad); if (bad) ok = false; });
  if (!ok) return toast('أدخل قيمة صحيحة لكل بند.', 'err');
  const lines = inputs.map(i => i.dataset.kind === 'area' ? { id: +i.dataset.m, area: +i.value } : { id: +i.dataset.m, price: +i.value });
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const r = await api('POST', `/orders/${o.id}/pricing`, { lines });
    $('#measure-dialog').close();
    pricingOrder = null;
    toast(`تم الحفظ. إجمالي الطلب ${r.code}: ${money(r.total)}.`);
    if (currentView === 'orders') loadOrders(); else if (currentView === 'dashboard') loadDashboard();
  } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- طلبات الموقع ---------- */
const REQ_TABS = [['', 'الكل'], ['new', 'جديدة'], ['contacted', 'تم التواصل'], ['converted', 'تم التحويل'], ['cancelled', 'ملغاة']];
let reqSeq = 0, reqRows = new Map();

async function loadRequests() {
  const seq = ++reqSeq;
  const qs = new URLSearchParams({ page: reqState.page, pageSize: 25 });
  if (reqState.status) qs.set('status', reqState.status);
  const r = await guard(() => api('GET', '/requests?' + qs));
  if (!r || seq !== reqSeq) return;
  const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
  $('#request-tabs').innerHTML = REQ_TABS.map(([v, l]) =>
    `<button type="button" class="tab${reqState.status === v ? ' active' : ''}" data-rfilter="${v}">${l}<span class="n">${num(v ? (r.counts[v] || 0) : total)}</span></button>`).join('');
  setBadge(r.counts.new || 0);
  reqRows = new Map(r.items.map(x => [x.id, x]));
  const write = can('requests:write');
  $('#requests-table').innerHTML = r.items.length ? r.items.map(x => `
    <tr>
      <td data-label="العميل"><b>${esc(x.name)}</b>${x.returning ? ` <span class="ret-tag" title="عميل سابق">سابق${x.customerCode ? ' · <span class="ltr">' + esc(x.customerCode) + '</span>' : ''}</span>` : ''}</td>
      <td data-label="الهاتف"><a class="ltr" href="tel:${esc(x.phone)}">${esc(x.phone)}</a></td>
      <td class="items" data-label="العنوان" title="${esc(x.address)}">${esc(x.address)}</td>
      <td data-label="الخدمة">${esc(x.serviceLabel)}</td>
      <td data-label="الميعاد">${esc(x.prefTime)}</td>
      <td data-label="وصل في">${esc(fmtDateTime(x.createdAt))}</td>
      <td data-label="الحالة"><span class="status ${x.status === 'new' ? 'pending' : x.status === 'contacted' ? 'progress' : x.status === 'converted' ? 'ready' : 'done'}">${esc(REQ_LABEL[x.status])}</span></td>
      <td class="actions">${write && (x.status === 'new' || x.status === 'contacted') ? `
        <button type="button" class="action go" data-rconvert="${x.id}">${icon('plus')}تحويل لطلب</button>
        ${x.status === 'new' ? `<button type="button" class="action" data-rcontact="${x.id}">تم التواصل</button>` : ''}
        <button type="button" class="action" data-rcancel="${x.id}">إلغاء</button>` : ''}
        ${x.status === 'converted' && x.customerId && can('orders:create') ? `<button type="button" class="action" data-neworder="${x.customerId}">${icon('plus')}طلب</button>` : ''}
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="empty-row">لا توجد طلبات</td></tr>';
  renderPager($('#requests-pager'), r);
}

let otpSeq = 0;
async function loadOtps() {
  if (!can('requests:read')) return;
  const seq = ++otpSeq;
  const r = await api('GET', '/otps').catch(() => null);
  if (!r || seq !== otpSeq) return;
  const items = r.items || r;
  const pending = items.filter(o => !o.delivered).length;
  badgeParts.otps = pending; setBadge();
  $('#otp-card').hidden = !items.length;
  const write = can('requests:write');
  $('#otp-list').innerHTML = items.map(o => {
    const msg = `كود التحقق الخاص بك لدى 4Seasons هو: ${o.otp}\nصالح لمدة 10 دقائق. لا تشاركه مع أحد.`;
    const wa = 'https://wa.me/2' + o.phone.replace(/\D/g, '').replace(/^0/, '0') + '?text=' + encodeURIComponent(msg);
    return `<li class="${o.delivered ? 'done' : ''}">
      <div class="otp-code ltr" aria-label="كود التحقق">${esc(o.otp)}</div>
      <div class="otp-who"><b>${esc(o.name)}</b> <small class="ltr">${esc(o.customerCode)}</small><br><a class="ltr" href="tel:${esc(o.phone)}">${esc(o.phone)}</a>
        <small>· ينتهي ${esc(fmtDateTime(o.expiresAt))}${o.attempts ? ` · محاولات خاطئة: ${num(o.attempts)}` : ''}</small></div>
      <div class="otp-actions">${write ? `<a class="action go" href="${esc(wa)}" target="_blank" rel="noopener noreferrer" data-otp-sent="${o.id}">إرسال على واتساب</a>` : ''}
        ${o.delivered ? '<span class="status ready">تم الإرسال</span>' : ''}</div>
    </li>`;
  }).join('');
}

async function startOrderFor(customerId) {
  const c = await guard(() => api('GET', '/customers/' + customerId));
  if (!c) return;
  show('pos');
  selectCustomer(c);
}

/* ---------- القائمة الجانبية (فتح / قفل) ---------- */
const drawerMode = () => matchMedia('(max-width: 900px)').matches;
function setMenuOpen(open) {
  const shell = $('.app-shell');
  if (drawerMode()) {
    shell.classList.toggle('menu-open', open);
    $('#menu-scrim').hidden = !open;
  } else {
    shell.classList.toggle('collapsed', !open);
    try { localStorage.setItem('4s_menu', open ? 'open' : 'closed'); } catch { /* ignore */ }
  }
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
}
function toggleMenu() {
  const shell = $('.app-shell');
  setMenuOpen(drawerMode() ? !shell.classList.contains('menu-open') : shell.classList.contains('collapsed'));
}
function initMenu() {
  let saved = null;
  try { saved = localStorage.getItem('4s_menu'); } catch { /* ignore */ }
  if (!drawerMode() && saved === 'closed') { $('.app-shell').classList.add('collapsed'); $('#menu-toggle').setAttribute('aria-expanded', 'false'); }
  else if (drawerMode()) $('#menu-toggle').setAttribute('aria-expanded', 'false');
  $('#menu-toggle').addEventListener('click', toggleMenu);
  $('#menu-scrim').addEventListener('click', () => setMenuOpen(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && drawerMode() && $('.app-shell').classList.contains('menu-open')) setMenuOpen(false); });
  matchMedia('(max-width: 900px)').addEventListener('change', () => { $('.app-shell').classList.remove('menu-open'); $('#menu-scrim').hidden = true; });
}

/* ---------- الرسائل الداخلية ---------- */
const msgState = { box: 'inbox', page: 1 };
let msgCurrent = null, msgUnread = 0;

async function refreshMsgBadge() {
  if (!me) return;
  try {
    const r = await api('GET', '/messages/unread');
    if (r.unread > msgUnread && currentView !== 'messages') toast(`وصلتك رسالة جديدة (${num(r.unread)} غير مقروءة)`);
    msgUnread = r.unread;
    const b = $('#messages-badge'); b.hidden = !r.unread; b.textContent = num(r.unread);
    if (currentView === 'messages' && msgState.box === 'inbox' && r.unread) loadMessages();
  } catch { /* ignore */ }
}

async function loadMessages() {
  const r = await guard(() => api('GET', `/messages?box=${msgState.box}&page=${msgState.page}`));
  if (!r) return;
  $$('#message-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.box === msgState.box));
  $('#msg-who-th').textContent = msgState.box === 'sent' ? 'إلى' : 'من';
  $('#inbox-count').textContent = num(msgUnread);
  $('#messages-table').innerHTML = r.items.length ? r.items.map(m => {
    const who = msgState.box === 'sent' ? m.to.map(x => x.name).join('، ') : m.from.name;
    const unread = msgState.box === 'inbox' && m.read === false;
    return `<tr class="msg-row${unread ? ' unread' : ''}" data-msg="${m.id}" tabindex="0" role="button">
      <td data-label="${msgState.box === 'sent' ? 'إلى' : 'من'}"><b>${esc(who)}</b></td>
      <td class="items" data-label="الموضوع">${unread ? '<span class="dot" aria-label="غير مقروءة"></span>' : ''}${esc(m.subject)}<span class="sub">${esc(m.body.slice(0, 80))}</span></td>
      <td data-label="التاريخ">${esc(fmtDateTime(m.createdAt))}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="3" class="empty-row">لا توجد رسائل</td></tr>';
  renderPager($('#messages-pager'), r);
}

async function openMessage(id) {
  const m = await guard(() => api('GET', '/messages/' + id));
  if (!m) return;
  msgCurrent = m;
  $('#rd-title').textContent = m.subject;
  $('#rd-meta').textContent = `من ${m.from.name} إلى ${m.to.map(x => x.name).join('، ')}`;
  $('#rd-thread').innerHTML = m.thread.map(t => `<article class="thread-msg${t.id === m.id ? ' current' : ''}">
    <header><b>${esc(t.from.name)}</b><small>${esc(fmtDateTime(t.createdAt))}</small></header><p>${esc(t.body)}</p></article>`).join('');
  $('#rd-reply').value = '';
  $('#read-dialog').showModal();
  refreshMsgBadge();
  loadMessages();
}

async function openCompose(reply) {
  const r = await guard(() => api('GET', '/messages/contacts'));
  if (!r) return;
  $('#cp-contacts').innerHTML = r.items.map(u => `<label class="perm-item"><input type="checkbox" value="${u.id}"> <span>${esc(u.name)} <small class="muted">(${ROLE_LABEL[u.role] || u.role})</small></span></label>`).join('') || '<p class="muted">لا يوجد مستخدمون آخرون.</p>';
  $('#compose-form').reset(); $('#cp-error').textContent = '';
  $('#compose-dialog').showModal();
}

async function submitCompose(e) {
  e.preventDefault();
  const to = [...$('#cp-contacts').querySelectorAll('input:checked')].map(i => +i.value);
  const body = { subject: $('#cp-subject').value.trim(), body: $('#cp-body').value.trim() };
  if ($('#cp-all').checked) body.toAll = true; else body.to = to;
  $('#cp-error').textContent = '';
  try {
    await api('POST', '/messages', body);
    $('#compose-dialog').close(); toast('تم إرسال الرسالة.');
    msgState.box = 'sent'; msgState.page = 1; loadMessages();
  } catch (err) { $('#cp-error').textContent = err.message || 'تعذر الإرسال.'; }
}

async function submitReply(e) {
  e.preventDefault();
  const text = $('#rd-reply').value.trim();
  if (!text || !msgCurrent) return;
  const m = msgCurrent;
  const to = m.from.id === me.user.id ? m.to.map(x => x.id) : [m.from.id];
  const subject = m.subject.startsWith('رد:') ? m.subject : 'رد: ' + m.subject;
  const r = await guard(() => api('POST', '/messages', { to, subject, body: text, parentId: m.id }));
  if (r) { toast('تم إرسال الرد.'); openMessage(r.id); }
}

/* ---------- تحكم المدير اليدوي ---------- */
let oaOrder = null, caCustomer = null;
async function openOrderAdmin(id) {
  const o = await guard(() => api('GET', '/orders/' + id));
  if (!o) return;
  oaOrder = o;
  $('#oa-title').textContent = 'تحكم في الطلب ' + o.code;
  $('#oa-sub').textContent = `العميل: ${o.customer} — أي تعديل هنا بيتسجل في سجل العمليات.`;
  $('#oa-status').innerHTML = Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}"${o.status === k ? ' selected' : ''}>${v}</option>`).join('');
  $('#oa-total').value = o.total; $('#oa-paid').value = o.paid;
  $('#oa-created').value = o.createdDate || o.created_date || ''; $('#oa-delivery').value = o.delivery || '';
  $('#oa-note').value = o.note || ''; $('#oa-error').textContent = '';
  $('#oadmin-dialog').showModal();
}
async function submitOrderAdmin(e) {
  e.preventDefault();
  $('#oa-error').textContent = '';
  const body = { status: $('#oa-status').value, total: $('#oa-total').value, paid: $('#oa-paid').value,
    deliveryDate: $('#oa-delivery').value || null, note: $('#oa-note').value };
  if ($('#oa-created').value) body.createdDate = $('#oa-created').value;
  try {
    await api('PUT', '/admin/orders/' + oaOrder.id, body);
    $('#oadmin-dialog').close(); toast('تم حفظ تعديلات الطلب.'); refreshAfterAdmin();
  } catch (err) { $('#oa-error').textContent = err.message || 'تعذر الحفظ.'; }
}
async function deleteOrderAdmin() {
  if (!await confirmBox(`حذف الطلب ${oaOrder.code} نهائيًا مع مدفوعاته؟ لا يمكن التراجع.`, { ok: 'نعم، احذف', title: 'حذف طلب', danger: true })) return;
  const r = await guard(() => api('DELETE', '/admin/orders/' + oaOrder.id));
  if (r) { $('#oadmin-dialog').close(); toast('تم حذف الطلب.'); refreshAfterAdmin(); }
}

async function openCustAdmin(id) {
  const c = custRows.get(id);
  if (!c) return;
  caCustomer = c;
  $('#ca-title').textContent = 'تحكم في ' + c.name;
  $('#ca-sub').textContent = `${c.code} — المستحق الحالي: ${money(c.balance)}`;
  $('#ca-opening').value = c.opening ?? 0; $('#ca-error').textContent = '';
  await loadCustPayments();
  $('#cadmin-dialog').showModal();
}
async function loadCustPayments() {
  const r = await guard(() => api('GET', `/customers/${caCustomer.id}/payments`));
  if (!r) return;
  $('#ca-payments').innerHTML = r.items.length ? r.items.map(p => `<li><span><b>${money(p.amount)}</b> · ${esc(PAY_LABEL[p.method] || p.method)}${p.kind === 'opening' ? ' · مديونية سابقة' : p.orderCode ? ' · ' + esc(p.orderCode) : ''}<small class="muted"> ${esc(fmtDateTime(p.createdAt))}</small></span>
    <button type="button" class="action" data-delpay="${p.id}">حذف</button></li>`).join('') : '<li class="muted">لا توجد دفعات.</li>';
}
async function submitCustAdmin(e) {
  e.preventDefault();
  $('#ca-error').textContent = '';
  try {
    const c = await api('PUT', '/admin/customers/' + caCustomer.id, { openingBalance: $('#ca-opening').value || 0 });
    toast('تم حفظ الرصيد.'); $('#ca-sub').textContent = `${c.code} — المستحق الحالي: ${money(c.balance)}`; refreshAfterAdmin();
  } catch (err) { $('#ca-error').textContent = err.message || 'تعذر الحفظ.'; }
}
async function deleteCustAdmin() {
  const c = caCustomer;
  if (!await confirmBox(`حذف العميل ${c.name}؟`, { ok: 'متابعة', title: 'حذف عميل', danger: true })) return;
  try {
    await api('DELETE', '/admin/customers/' + c.id);
  } catch (err) {
    if (err.code !== 'has_orders') { toast(err.message, 'err'); return; }
    if (!await confirmBox(`${err.message} هل أنت متأكد؟ لا يمكن التراجع.`, { ok: 'احذف الكل', title: 'حذف العميل وطلباته', danger: true })) return;
    const r = await guard(() => api('DELETE', `/admin/customers/${c.id}?force=1`));
    if (!r) return;
  }
  $('#cadmin-dialog').close(); toast('تم حذف العميل.'); refreshAfterAdmin();
}
function refreshAfterAdmin() {
  if (currentView === 'orders') loadOrders();
  if (currentView === 'customers') loadCustomers();
  if (currentView === 'dashboard') loadDashboard();
}

/* ---------- الإعدادات ---------- */
let usersCache = [];
async function loadSettings() {
  await guard(loadCatalog);
  renderCategories(); renderServices(); renderZonesSelect();
  renderServicesTable(); renderZones(); fillBusinessForm();
  const active = $('#settings-tabs .tab.active')?.dataset.stab || 'services';
  if (active === 'users') loadUsers();
  if (active === 'system') loadAudit();
}

function switchSettingsTab(name) {
  $$('#settings-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.stab === name));
  $$('.stab').forEach(s => { s.hidden = s.id !== 'stab-' + name; });
  if (name === 'users') loadUsers();
  if (name === 'system') loadAudit();
}

function renderServicesTable() {
  const catName = new Map(catalog.categories.map(c => [c.id, c.name]));
  $('#services-table').innerHTML = catalog.services.map(s => `
    <tr class="${s.active ? '' : 'row-off'}">
      <td data-label="الخدمة"><b>${esc(s.name)}</b>${s.subgroup ? `<span class="sub">${esc(s.subgroup)}</span>` : ''}${!s.showPublic ? '<span class="sub">لا يظهر في الموقع</span>' : ''}</td>
      <td data-label="التصنيف">${esc(catName.get(s.categoryId) || '—')}</td>
      <td data-label="الوحدة">${esc(UNIT_LABEL[s.unit])}</td>
      <td data-label="السعر">${esc(priceLabel(s))} <span class="sub">${esc(PRICING_LABEL[s.pricing])}</span></td>
      <td data-label="الحالة"><span class="status ${s.active ? 'ready' : 'done'}">${s.active ? 'مفعّلة' : 'معطّلة'}</span></td>
      <td class="actions"><button type="button" class="action" data-sedit="${s.id}">تعديل</button><button type="button" class="action" data-stoggle="${s.id}">${s.active ? 'تعطيل' : 'تفعيل'}</button></td>
    </tr>`).join('');
}

function syncServiceForm() {
  const p = $('#sv-pricing').value;
  $('#sv-min').closest('label').hidden = p === 'quote';
  $('#sv-max').closest('label').hidden = p !== 'range';
}

function openServiceDialog(s = null) {
  $('#sv-id').value = s ? s.id : '';
  $('#sd-title').textContent = s ? 'تعديل الخدمة' : 'خدمة جديدة';
  $('#sv-category').innerHTML = catalog.categories.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#sv-name').value = s?.name || '';
  $('#sv-category').value = String(s?.categoryId || catalog.categories[0]?.id || '');
  $('#sv-subgroup').value = s?.subgroup || '';
  $('#sv-unit').value = s?.unit || 'piece';
  $('#sv-pricing').value = s?.pricing || 'fixed';
  $('#sv-min').value = s?.min ?? '';
  $('#sv-max').value = s?.max ?? '';
  $('#sv-public').value = s?.publicText || '';
  $('#sv-show').checked = s ? s.showPublic : true;
  $('#sv-active').checked = s ? s.active : true;
  syncServiceForm();
  $('#service-dialog').showModal();
  $('#sv-name').focus();
}

async function submitService(e) {
  e.preventDefault();
  const id = $('#sv-id').value, pricing = $('#sv-pricing').value;
  const min = $('#sv-min').value, max = $('#sv-max').value;
  const body = {
    name: $('#sv-name').value.trim(), categoryId: +$('#sv-category').value, subgroup: $('#sv-subgroup').value.trim() || null,
    unit: $('#sv-unit').value, pricing, publicText: $('#sv-public').value.trim() || null,
    showPublic: $('#sv-show').checked, active: $('#sv-active').checked
  };
  if (pricing !== 'quote') {
    if (min === '' || !(+min >= 0)) return toast('أدخل السعر.', 'err');
    body.min = +min;
    if (pricing === 'range') { if (max === '' || +max < +min) return toast('أعلى سعر يجب ألا يقل عن أقل سعر.', 'err'); body.max = +max; }
  }
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    await api(id ? 'PUT' : 'POST', id ? '/services/' + id : '/services', body);
    $('#service-dialog').close();
    toast('تم حفظ الخدمة.');
    await loadSettings();
  } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
  finally { if (btn) btn.disabled = false; }
}

function renderZones() {
  $('#zones-list').innerHTML = catalog.zones.map(z => `
    <div class="zone-row"><b>${esc(z.name)}</b>
    <label>الرسوم بالجنيه<input data-zone="${z.id}" type="number" min="0" step="any" value="${z.fee}" inputmode="decimal" /></label>
    <label class="check-inline"><input type="checkbox" data-zone-active="${z.id}" ${z.active ? 'checked' : ''} /> مفعّلة</label></div>`).join('');
}

async function saveZones() {
  const changes = [];
  catalog.zones.forEach(z => {
    const fee = round2(+$(`[data-zone="${z.id}"]`).value), active = $(`[data-zone-active="${z.id}"]`).checked;
    if (fee !== z.fee || active !== z.active) changes.push({ id: z.id, fee: Math.max(0, fee), active });
  });
  if (!changes.length) return toast('لا توجد تعديلات لحفظها.');
  try {
    for (const c of changes) await api('PUT', '/zones/' + c.id, { fee: c.fee, active: c.active });
    toast('تم حفظ المناطق.');
  } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
  await loadSettings();
}

function fillBusinessForm() {
  $$('#business-form [data-key]').forEach(i => { i.value = catalog.settings[i.dataset.key] ?? ''; });
}

async function saveBusiness(e) {
  e.preventDefault();
  const body = {};
  $$('#business-form [data-key]').forEach(i => { body[i.dataset.key] = i.value.trim(); });
  try {
    catalog.settings = await api('PUT', '/settings', body);
    $('#branch-pill').textContent = `فرع ${catalog.settings.branch || ''}`.trim();
    toast('تم حفظ البيانات. تظهر فورًا في الموقع.');
  } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
}

async function loadUsers() {
  const r = await guard(() => api('GET', '/users'));
  if (!r) return;
  usersCache = r.items;
  $('#users-table').innerHTML = r.items.map(u => {
    const self = u.id === me.user.id;
    return `<tr class="${u.active ? '' : 'row-off'}">
      <td data-label="المستخدم"><span class="ltr">${esc(u.username)}</span></td>
      <td data-label="الاسم">${esc(u.name)}${self ? ' <small>(أنت)</small>' : ''}</td>
      <td data-label="الدور"><select data-urole="${u.id}" aria-label="دور ${esc(u.name)}" ${self ? 'disabled' : ''}>${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}"${u.role === k ? ' selected' : ''}>${v}</option>`).join('')}</select></td>
      <td data-label="الصلاحيات">${u.role === 'manager' ? 'كل الصلاحيات' : `${u.customPermissions ? 'مخصصة' : 'افتراضي الدور'} · ${num(u.permissions.filter(p => p !== 'catalog:read').length)}`}</td>
      <td data-label="آخر دخول">${esc(u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'لم يدخل بعد')}</td>
      <td data-label="الحالة"><span class="status ${u.active ? 'ready' : 'done'}">${u.active ? 'مفعّل' : 'معطّل'}</span></td>
      <td class="actions">${self || u.role === 'manager' ? '' : `<button type="button" class="action" data-uperms="${u.id}">الصلاحيات</button>`}${self ? '' : `<button type="button" class="action" data-utoggle="${u.id}">${u.active ? 'تعطيل' : 'تفعيل'}</button><button type="button" class="action" data-ureset="${u.id}">إعادة كلمة المرور</button>`}</td>
    </tr>`;
  }).join('');
}

/* ---- صلاحيات الموظفين ---- */
let permMeta = null;
async function loadPermMeta() { if (!permMeta) permMeta = await guard(() => api('GET', '/users/permissions')); return permMeta; }
function renderPermGrid(box, selected) {
  const sel = new Set(selected);
  box.innerHTML = permMeta.groups.map(g => `<div class="perm-group"><b>${esc(g.group)}</b>${g.items.map(i =>
    `<label class="perm-item"><input type="checkbox" value="${i.key}"${sel.has(i.key) ? ' checked' : ''}> <span>${esc(i.label)}</span></label>`).join('')}</div>`).join('');
}
const readPermGrid = box => [...box.querySelectorAll('input:checked')].map(i => i.value);
function syncCreatePerms() {
  const role = $('#u-role').value;
  $('#u-perms').hidden = role === 'manager'; $('#u-perms-note').hidden = role !== 'manager';
  if (role !== 'manager') renderPermGrid($('#u-perms'), permMeta.defaults[role] || []);
}
let permEditId = null;
async function openPermDialog(id) {
  const u = usersCache.find(x => x.id === id); if (!u || !await loadPermMeta()) return;
  permEditId = id;
  $('#pm-sub').textContent = `${u.name} (${ROLE_LABEL[u.role]}) — اختار اللي يقدر يعمله.`;
  renderPermGrid($('#pm-perms'), u.permissions);
  $('#perm-dialog').showModal();
}

function showTempPassword(title, sub, pass) {
  $('#tp-title').textContent = title; $('#tp-sub').textContent = sub; $('#tp-pass').textContent = pass;
  $('#temp-dialog').showModal();
}

async function submitUser(e) {
  e.preventDefault();
  const role = $('#u-role').value;
  const body = { username: $('#u-username').value.trim(), name: $('#u-name').value.trim(), role };
  const pw = $('#u-password').value.trim();
  if (pw) body.password = pw;
  if (role !== 'manager') body.permissions = readPermGrid($('#u-perms'));
  $('#u-error').textContent = '';
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/users', body);
    $('#user-dialog').close();
    showTempPassword('تم إنشاء الحساب', `المستخدم: ${r.user.username} — ${ROLE_LABEL[r.user.role]}`, r.password);
    loadUsers();
  } catch (err) {
    $('#u-error').textContent = err.message || 'تعذر إنشاء الحساب.';
  } finally { if (btn) btn.disabled = false; }
}

async function loadAudit() {
  const r = await guard(() => api('GET', '/audit?pageSize=40'));
  if (!r) return;
  $('#audit-table').innerHTML = r.items.length ? r.items.map(a => {
    let det = '';
    try { det = a.details ? Object.entries(JSON.parse(a.details)).map(([k, v]) => `${k}: ${v}`).join('، ') : ''; } catch { det = ''; }
    return `<tr><td data-label="الوقت">${esc(fmtDateTime(a.created_at))}</td><td data-label="المستخدم">${esc(a.username || '—')}</td><td data-label="العملية"><span class="ltr">${esc(a.action)}</span></td><td class="items" data-label="التفاصيل" title="${esc(det)}">${esc(a.entity ? `${a.entity} #${a.entity_id ?? ''} ` : '')}${esc(det)}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="empty-row">لا توجد عمليات</td></tr>';
}

async function downloadBackup() {
  const btn = $('#download-backup'); btn.disabled = true;
  try {
    const res = await api('GET', '/admin/backup', undefined, { raw: true });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `4seasons-backup-${isoLocal()}.db`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast('تم تنزيل النسخة الاحتياطية.');
  } catch (err) { if (err.status !== 401) toast(err.message, 'err'); }
  finally { btn.disabled = false; }
}

/* ---------- التهيئة وربط الأحداث ---------- */
function setToday() {
  $('#today').textContent = new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}

async function init() {
  setToday();
  $('.app-shell').inert = true;

  // الدخول والخروج
  $('#login-form').addEventListener('submit', login);
  $('#logout').addEventListener('click', logout);
  $('#change-password').addEventListener('click', () => openPassword(false));
  $('#password-form').addEventListener('submit', submitPassword);
  $('#password-dialog').addEventListener('cancel', e => { if ($('#password-dialog').dataset.forced === '1') e.preventDefault(); });
  $('#toggle-pass').addEventListener('click', () => {
    const p = $('#login-password'), show = p.type === 'password';
    p.type = show ? 'text' : 'password';
    $('#toggle-pass').innerHTML = icon(show ? 'eye-off' : 'eye');
    $('#toggle-pass').setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
  });

  // التنقل
  $$('.nav-item').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
  $$('[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.go)));
  $('#recent-orders').addEventListener('click', e => {
    const b = e.target.closest('[data-go-order]');
    if (!b) return;
    ordState.q = b.dataset.goOrder; ordState.status = ''; ordState.page = 1;
    show('orders');
  });
  $('#alerts').addEventListener('click', e => {
    const b = e.target.closest('[data-alert]');
    if (!b) return;
    const a = alertRows[+b.dataset.alert];
    a.apply();
    show(a.view);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBadge(); });

  // النوافذ
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-close]');
    if (b) b.closest('dialog')?.close();
    if (!e.target.closest('.customer-panel .search-field')) closeSuggest();
  });
  ['#card-dialog', '#invoice-dialog'].forEach(sel => {
    const d = $(sel);
    d.addEventListener('mousedown', e => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
  });
  document.addEventListener('input', e => e.target.classList?.remove('invalid'));

  // الكاشير — العميل
  const cs = $('#customer-search');
  cs.addEventListener('input', searchCustomers);
  cs.addEventListener('keydown', async e => {
    const items = $$('#customer-suggest [data-pick]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      let i = items.findIndex(b => b.classList.contains('on'));
      items[i]?.classList.remove('on');
      i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[i].classList.add('on'); items[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = cs.value.trim();
      if (!q) return;
      const r = await guard(() => api('GET', '/customers/find?term=' + encodeURIComponent(q)));
      if (r?.customer) return selectCustomer(r.customer);
      const onIdx = items.find(b => b.classList.contains('on'))?.dataset.pick;
      if (onIdx != null && suggestList[+onIdx]) return selectCustomer(suggestList[+onIdx]);
      if (r) toast('لا يوجد عميل بهذا الرقم. استخدم «عميل جديد» لإضافته.', 'err');
    } else if (e.key === 'Escape') closeSuggest();
  });
  $('#customer-suggest').addEventListener('click', e => {
    const b = e.target.closest('[data-pick]');
    if (b && suggestList[+b.dataset.pick]) selectCustomer(suggestList[+b.dataset.pick]);
  });
  $('#selected-customer').addEventListener('click', e => { if (e.target.closest('[data-clear-customer]')) { clearCustomer(); cs.focus(); } });
  $('#new-customer').addEventListener('click', () => openCustomerDialog());
  $('#add-customer-top').addEventListener('click', () => openCustomerDialog());
  $('#customer-form').addEventListener('submit', submitCustomer);
  $('#zone').addEventListener('change', updateTotals);

  // الكاشير — الخدمات
  $('#service-search').addEventListener('input', renderServices);
  $('#service-search').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addFromSearch(); } });
  $('#add-service').addEventListener('click', addFromSearch);
  $('#service-options').addEventListener('click', e => { const b = e.target.closest('[data-service]'); if (b) addService(+b.dataset.service); });
  $('#service-cats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    serviceCat = +b.dataset.cat;
    renderCategories(); renderServices();
  });

  // الكاشير — السلة
  const cartEl = $('#cart');
  cartEl.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.remove != null) { cart.splice(+t.dataset.remove, 1); renderCart(); return; }
    const inc = t.dataset.inc != null, dec = t.dataset.dec != null;
    if (inc || dec) {
      const i = +(inc ? t.dataset.inc : t.dataset.dec), x = cart[i], st = stepOf(x);
      x.qty = Math.max(st, round2(x.qty + (inc ? st : -st)));
      renderCart();
      $(`[data-${inc ? 'inc' : 'dec'}="${i}"]`)?.focus();
    }
  });
  cartEl.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.qty != null) {
      const i = +t.dataset.qty, x = cart[i], st = stepOf(x);
      let v = +t.value || st;
      v = Math.max(st, Math.round(v / st) * st);
      x.qty = Math.min(9999, v);
      refreshLine(i);
    } else if (t.dataset.price != null) {
      const i = +t.dataset.price, x = cart[i];
      x.price = Math.min(x.max, Math.max(x.min, +t.value || x.min));
      refreshLine(i);
    }
  });
  cartEl.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.qty != null) t.value = cart[+t.dataset.qty].qty;
    if (t.dataset.price != null) t.value = cart[+t.dataset.price].price;
  });

  // رسوم إضافية
  $('#add-fee').addEventListener('click', () => { $('#fee-form').reset(); $('#fee-dialog').showModal(); $('#fee-value').focus(); });
  $('#fee-form').addEventListener('submit', e => {
    e.preventDefault();
    const v = round2(+$('#fee-value').value);
    if (!(v > 0)) { $('#fee-value').classList.add('invalid'); return toast('أدخل قيمة صحيحة للرسوم.', 'err'); }
    cart.push({ key: uid(), fee: true, name: $('#fee-type').value, note: $('#fee-note').value.trim(), unit: 'fee', qty: 1, price: v });
    $('#fee-dialog').close();
    renderCart();
  });

  // الدفع وحفظ الطلب
  $('#payment').addEventListener('change', () => { paidTouched = false; syncPaid(); });
  $('#paid').addEventListener('input', () => { paidTouched = true; syncPaid(); });
  $('#save-order').addEventListener('click', saveOrder);
  $('#clear-order').addEventListener('click', async () => {
    if (!cart.length && !selectedCustomer) return;
    if (await confirmBox('سيتم مسح بيانات الطلب الحالي. هل تريد المتابعة؟', { ok: 'نعم، إلغاء الطلب', title: 'إلغاء الطلب', danger: true })) resetPos();
  });

  // الطباعة
  $('#print-card').addEventListener('click', () => window.print());
  $('#print-invoice').addEventListener('click', () => window.print());
  $('#print-labels').addEventListener('click', () => { document.body.classList.add('print-labels'); window.print(); });
  window.addEventListener('afterprint', () => document.body.classList.remove('print-labels'));

  // العملاء
  $('#customer-filter').addEventListener('input', debounce(() => { custState.q = $('#customer-filter').value.trim(); custState.page = 1; loadCustomers(); }, 300));
  $('#debtors-only').addEventListener('change', () => { custState.debtors = $('#debtors-only').checked; custState.page = 1; loadCustomers(); });
  $('#customer-table').addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.card) openCard(custRows.get(+t.dataset.card));
    if (t.dataset.pay) openPayment(custRows.get(+t.dataset.pay));
    if (t.dataset.edit) openCustomerDialog(custRows.get(+t.dataset.edit));
    if (t.dataset.neworder) startOrderFor(+t.dataset.neworder);
    if (t.dataset.cadmin) openCustAdmin(+t.dataset.cadmin);
  });
  $('#customer-pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { custState.page = +b.dataset.page; loadCustomers(); } });
  $('#payment-form').addEventListener('submit', submitPayment);

  // الطلبات
  $('#order-search').addEventListener('input', debounce(() => { ordState.q = $('#order-search').value.trim(); ordState.page = 1; loadOrders(); }, 300));
  $('#status-tabs').addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) { ordState.status = b.dataset.filter; ordState.page = 1; loadOrders(); } });
  $('#orders-table').addEventListener('click', async e => {
    const n = e.target.closest('[data-next]'), v = e.target.closest('[data-invoice]'), ad = e.target.closest('[data-oadmin]');
    if (ad) return openOrderAdmin(+ad.dataset.oadmin);
    if (n) advanceOrder(+n.dataset.next);
    if (v) { const o = await guard(() => api('GET', '/orders/' + v.dataset.invoice)); if (o) openInvoice(o); }
  });
  $('#orders-pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { ordState.page = +b.dataset.page; loadOrders(); } });
  $('#measure-form').addEventListener('submit', submitPricing);
  $('#measure-fields').addEventListener('input', updatePricingTotal);

  // القائمة والرسائل وتحكم المدير
  initMenu();
  $('#message-tabs').addEventListener('click', e => { const b = e.target.closest('[data-box]'); if (b) { msgState.box = b.dataset.box; msgState.page = 1; loadMessages(); } });
  $('#messages-pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { msgState.page = +b.dataset.page; loadMessages(); } });
  $('#messages-table').addEventListener('click', e => { const r = e.target.closest('[data-msg]'); if (r) openMessage(+r.dataset.msg); });
  $('#messages-table').addEventListener('keydown', e => { const r = e.target.closest('[data-msg]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openMessage(+r.dataset.msg); } });
  $('#new-message-btn').addEventListener('click', () => openCompose());
  $('#compose-form').addEventListener('submit', submitCompose);
  $('#cp-all').addEventListener('change', e => { $('#cp-contacts').querySelectorAll('input').forEach(i => { i.checked = e.target.checked; i.disabled = e.target.checked; }); });
  $('#reply-form').addEventListener('submit', submitReply);
  $('#rd-delete').addEventListener('click', async () => {
    if (!msgCurrent || !await confirmBox('حذف الرسالة من صندوقك؟', { ok: 'حذف', title: 'حذف رسالة', danger: true })) return;
    const r = await guard(() => api('DELETE', '/messages/' + msgCurrent.id));
    if (r) { $('#read-dialog').close(); loadMessages(); refreshMsgBadge(); }
  });
  $('#oadmin-form').addEventListener('submit', submitOrderAdmin);
  $('#oa-delete').addEventListener('click', deleteOrderAdmin);
  $('#cadmin-form').addEventListener('submit', submitCustAdmin);
  $('#ca-delete').addEventListener('click', deleteCustAdmin);
  $('#ca-payments').addEventListener('click', async e => {
    const b = e.target.closest('[data-delpay]');
    if (!b || !await confirmBox('حذف الدفعة دي؟ هيتعدّل رصيد العميل وإجمالي المدفوع تلقائيًا.', { ok: 'حذف', title: 'حذف دفعة', danger: true })) return;
    const r = await guard(() => api('DELETE', '/admin/payments/' + b.dataset.delpay));
    if (r) { $('#ca-sub').textContent = `${r.code} — المستحق الحالي: ${money(r.balance)}`; await loadCustPayments(); refreshAfterAdmin(); }
  });

  // طلبات الموقع
  $('#refresh-requests').addEventListener('click', () => { loadRequests(); loadOtps(); });
  $('#otp-list').addEventListener('click', e => {
    const a = e.target.closest('[data-otp-sent]');
    if (a) api('POST', `/otps/${a.dataset.otpSent}/delivered`).then(loadOtps).catch(() => {});
  });
  $('#request-tabs').addEventListener('click', e => { const b = e.target.closest('[data-rfilter]'); if (b) { reqState.status = b.dataset.rfilter; reqState.page = 1; loadRequests(); } });
  $('#requests-pager').addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b && !b.disabled) { reqState.page = +b.dataset.page; loadRequests(); } });
  $('#requests-table').addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.neworder) return startOrderFor(+t.dataset.neworder);
    if (t.dataset.rconvert) {
      const r = await guard(() => api('POST', `/requests/${t.dataset.rconvert}/convert`));
      if (r) { show('pos'); selectCustomer(r.customer); toast(`تم تجهيز العميل ${r.customer.name}. أضف الخدمات لإنشاء الطلب.`); }
    }
    if (t.dataset.rcontact) { const r = await guard(() => api('POST', `/requests/${t.dataset.rcontact}/status`, { status: 'contacted' })); if (r) loadRequests(); }
    if (t.dataset.rcancel) {
      const x = reqRows.get(+t.dataset.rcancel);
      if (await confirmBox(`إلغاء طلب ${x?.name || ''}؟`, { ok: 'نعم، إلغاء', title: 'إلغاء طلب الموقع', danger: true })) {
        const r = await guard(() => api('POST', `/requests/${t.dataset.rcancel}/status`, { status: 'cancelled' }));
        if (r) loadRequests();
      }
    }
  });

  // الإعدادات
  $('#settings-tabs').addEventListener('click', e => { const b = e.target.closest('[data-stab]'); if (b) switchSettingsTab(b.dataset.stab); });
  $('#add-service-btn').addEventListener('click', () => openServiceDialog());
  $('#sv-pricing').addEventListener('change', syncServiceForm);
  $('#service-form').addEventListener('submit', submitService);
  $('#services-table').addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.sedit) openServiceDialog(catalog.services.find(s => s.id === +t.dataset.sedit));
    if (t.dataset.stoggle) {
      const s = catalog.services.find(x => x.id === +t.dataset.stoggle);
      const r = await guard(() => api('PUT', '/services/' + s.id, { active: !s.active }));
      if (r) { toast(r.active ? 'تم تفعيل الخدمة.' : 'تم تعطيل الخدمة.'); loadSettings(); }
    }
  });
  $('#save-zones').addEventListener('click', saveZones);
  $('#add-zone').addEventListener('click', async () => {
    const el = $('#new-zone-name'), name = el.value.trim();
    if (!name) { el.focus(); return toast('اكتب اسم المنطقة أولًا.', 'err'); }
    const r = await guard(() => api('POST', '/zones', { name, fee: 0 }));
    if (r) { el.value = ''; toast(`تمت إضافة منطقة «${name}».`); loadSettings(); }
  });
  $('#new-zone-name').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#add-zone').click(); } });
  $('#business-form').addEventListener('submit', saveBusiness);
  $('#add-user-btn').addEventListener('click', async () => {
    if (!await loadPermMeta()) return;
    $('#user-form').reset(); $('#u-error').textContent = ''; syncCreatePerms();
    $('#user-dialog').showModal(); $('#u-username').focus();
  });
  $('#u-role').addEventListener('change', syncCreatePerms);
  $('#perm-form').addEventListener('submit', async e => {
    e.preventDefault();
    const r = await guard(() => api('PUT', '/users/' + permEditId, { permissions: readPermGrid($('#pm-perms')) }));
    if (r) { $('#perm-dialog').close(); toast('تم حفظ الصلاحيات.'); loadUsers(); }
  });
  $('#pm-default').addEventListener('click', async () => {
    const r = await guard(() => api('PUT', '/users/' + permEditId, { permissions: null }));
    if (r) { $('#perm-dialog').close(); toast('رجعت صلاحيات الدور الافتراضية.'); loadUsers(); }
  });
  $('#user-form').addEventListener('submit', submitUser);
  $('#users-table').addEventListener('change', async e => {
    const s = e.target.closest('[data-urole]');
    if (!s) return;
    const r = await guard(() => api('PUT', '/users/' + s.dataset.urole, { role: s.value }));
    if (r) toast('تم تغيير الدور.'); loadUsers();
  });
  $('#users-table').addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.uperms) return openPermDialog(+t.dataset.uperms);
    if (t.dataset.utoggle) {
      const u = usersCache.find(x => x.id === +t.dataset.utoggle);
      if (u.active && !(await confirmBox(`تعطيل حساب ${u.name}؟ سيتم تسجيل خروجه فورًا.`, { ok: 'تعطيل', title: 'تعطيل مستخدم', danger: true }))) return;
      const r = await guard(() => api('PUT', '/users/' + u.id, { active: !u.active }));
      if (r) loadUsers();
    }
    if (t.dataset.ureset) {
      const u = usersCache.find(x => x.id === +t.dataset.ureset);
      if (!(await confirmBox(`إعادة ضبط كلمة مرور ${u.name}؟ سيتم تسجيل خروجه وإنشاء كلمة مؤقتة جديدة.`, { ok: 'إعادة الضبط', title: 'كلمة المرور' }))) return;
      const r = await guard(() => api('POST', `/users/${u.id}/reset-password`));
      if (r) showTempPassword('كلمة مرور مؤقتة جديدة', `المستخدم: ${u.username}`, r.password);
    }
  });
  $('#tp-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#tp-pass').textContent); toast('تم النسخ.'); } catch { toast('تعذر النسخ، انسخها يدويًا.', 'err'); }
  });
  $('#download-backup').addEventListener('click', downloadBackup);
  $('#refresh-audit').addEventListener('click', loadAudit);

  // استعادة الجلسة (الكوكي على الخادم)
  try {
    me = await api('GET', '/auth/me');
    if (me.user.mustChangePassword) { $('#login-screen').classList.add('hidden'); openPassword(true); }
    else await boot();
  } catch { me = null; showLogin(); }
}

init();
