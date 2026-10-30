'use strict';
(() => {
  const $ = id => document.getElementById(id);

  /* القائمة في الموبايل */
  const hamburger = $('hamburger');
  const navLinks = $('navLinks');
  const setMenu = open => {
    navLinks.classList.toggle('active', open);
    hamburger.setAttribute('aria-expanded', String(open));
    hamburger.setAttribute('aria-label', open ? 'إغلاق القائمة' : 'فتح القائمة');
  };
  hamburger.addEventListener('click', () => setMenu(!navLinks.classList.contains('active')));
  navLinks.querySelectorAll('a').forEach(a => a.addEventListener('click', () => setMenu(false)));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

  /* الشعار: لو الصورة غير موجودة نخفيها بدل الأيقونة المكسورة */
  document.querySelectorAll('img.brand-logo').forEach(img => {
    const hide = () => { img.style.display = 'none'; };
    if (img.complete && img.naturalWidth === 0) hide();
    else img.addEventListener('error', hide);
  });

  /* التمرير السلس للروابط الداخلية */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      history.replaceState(null, '', id);
    });
  });

  /* نموذج الطلب */
  const form = $('orderForm');
  const formError = $('formError');
  const modal = $('confirmationModal');
  const openedAt = Date.now();
  let lastFocus = null;

  const toLatin = s => s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
  const cleanPhone = s => toLatin(s).replace(/[\s\-().]/g, '').replace(/^(\+20|0020)/, '0');
  const validPhone = p => /^01[0125]\d{8}$/.test(p);

  function setFieldError(id, msg) {
    const input = $(id);
    const box = form.querySelector(`[data-for="${id}"]`);
    if (box) box.textContent = msg || '';
    if (input) { if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  }

  function validate() {
    let first = null;
    const check = (id, ok, msg) => { setFieldError(id, ok ? '' : msg); if (!ok && !first) first = $(id); };
    check('fullName', $('fullName').value.trim().length >= 2, 'اكتب اسمك بالكامل.');
    check('phoneNumber', validPhone(cleanPhone($('phoneNumber').value)), 'اكتب رقم موبايل صحيح، مثال: 01012345678');
    check('addressDetails', $('addressDetails').value.trim().length >= 6, 'اكتب العنوان بالتفصيل مع أقرب معلم.');
    check('serviceType', !!$('serviceType').value, 'اختر نوع الخدمة.');
    if (first) first.focus();
    return !first;
  }

  function showError(msg) { formError.textContent = msg; formError.classList.add('show'); formError.scrollIntoView({ block: 'nearest' }); }
  function clearError() { formError.textContent = ''; formError.classList.remove('show'); }

  function openModal(data) {
    $('modalCustomerName').textContent = data.name;
    $('modalCustomerPhone').textContent = data.phone;
    $('modalCustomerTime').textContent = data.time;
    if (data.message) $('modalNote').textContent = data.message;
    const wa = $('modalWa');
    if (data.whatsappUrl && /^https:\/\/wa\.me\//.test(data.whatsappUrl)) { wa.href = data.whatsappUrl; wa.hidden = false; } else { wa.hidden = true; }
    lastFocus = document.activeElement;
    modal.hidden = false;
    modal.classList.add('open');
    $('modalConfirmBtn').focus();
  }
  function closeModal() {
    modal.classList.remove('open');
    modal.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('closeModalBtn').addEventListener('click', closeModal);
  $('modalConfirmBtn').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => {
    if (modal.classList.contains('open')) {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Tab') { // حبس التركيز داخل النافذة
        const f = [...modal.querySelectorAll('button, a[href]')].filter(x => !x.hidden && x.offsetParent !== null);
        if (!f.length) return;
        const a = f[0], z = f[f.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    }
  });

  /* ---------- عميل سابق ---------- */
  const API = '/api/public';
  const isReturning = () => (form.querySelector('input[name="customerType"]:checked') || {}).value === 'returning';
  const show = (id, on) => { $(id).hidden = !on; };
  const ret = { token: null, term: '', method: null };   // التوكن في الذاكرة فقط

  async function api(path, body) {
    let res;
    try {
      res = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw { message: 'تعذر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى.' }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign({ status: res.status, message: 'حدث خطأ. حاول مرة أخرى.' }, data.error || {});
    return data;
  }
  async function busy(btn, label, fn) {
    const html = btn.innerHTML;
    btn.disabled = true;
    if (label) btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = html; }
  }
  const money = n => Number(n || 0).toLocaleString('ar-EG') + ' ج.م';
  const STATUS = { new: 'جديد', processing: 'قيد التنفيذ', ready: 'جاهز', delivered: 'تم التسليم', cancelled: 'ملغي' };

  function resetReturning() {
    ret.token = null; ret.term = ''; ret.method = null;
    ['lookupTerm', 'last4', 'otpCode'].forEach(id => { $(id).value = ''; setFieldError(id, ''); });
    show('stepLookup', true); show('stepVerify', false); show('stepProfile', false);
    show('otpEntry', false); show('otpSendBtn', true);
    show('editCard', false); show('profileCard', true);
    setFieldError('verify', '');
  }

  function setMode() {
    const r = isReturning();
    show('newFields', !r);
    show('returningPanel', r);
    
    clearError();
    if (r && !ret.token) $('lookupTerm').focus();
  }
  form.querySelectorAll('input[name="customerType"]').forEach(x => x.addEventListener('change', setMode));

  async function doLookup() {
    const term = $('lookupTerm').value.trim();
    setFieldError('lookupTerm', '');
    if (term.length < 4) { setFieldError('lookupTerm', 'اكتب كود العميل أو رقم الهاتف.'); return; }
    try {
      const r = await busy($('lookupBtn'), 'جارٍ البحث...', () => api('/customer/lookup', { term }));
      ret.term = term; ret.method = r.method;
      show('stepLookup', false); show('stepVerify', true);
      show('verifyCode', r.method === 'code'); show('verifyOtp', r.method === 'otp');
      if (r.method === 'code') {
        $('verifyIntro').textContent = 'وجدنا حسابك. للتأكد إنه حسابك اكتب آخر 4 أرقام من هاتفك المسجّل.';
        $('last4').focus();
      } else {
        $('verifyIntro').textContent = `وجدنا حسابًا باسم ${r.hint.name} ورقم ${r.hint.phone}. هنبعتلك كود تحقق على واتساب للرقم المسجّل.`;
      }
    } catch (e) {
      setFieldError('lookupTerm', e.status === 404 ? 'مفيش حساب بالبيانات دي. راجعها أو اطلب كعميل جديد.' : e.message);
    }
  }

  async function sendOtp() {
    setFieldError('verify', '');
    try {
      const r = await busy($('otpSendBtn'), 'جارٍ الإرسال...', () => api('/customer/otp', { term: ret.term }));
      show('otpEntry', true);
      $('otpNote').textContent = r.automatic
        ? `أرسلنا كودًا من 6 أرقام على واتساب. صالح لمدة ${r.expiresInMinutes} دقائق.`
        : `تم تسجيل طلبك. فريقنا هيبعتلك الكود على واتساب خلال دقائق (صالح ${r.expiresInMinutes} دقائق).`;
      const wa = form.dataset.wa;
      if (wa) { const l = $('otpWaLink'); l.href = 'https://wa.me/' + wa.replace(/\D/g, '') + '?text=' + encodeURIComponent('أحتاج كود التحقق لحسابي'); l.hidden = false; }
      $('otpCode').focus();
    } catch (e) { setFieldError('verify', e.message); }
  }

  function renderProfile(c, msg) {
    $('pAvatar').textContent = (c.name || '?').trim().charAt(0);
    $('pName').textContent = c.name;
    $('pCode').textContent = c.code;
    $('pPhone').textContent = c.phone;
    $('pAddress').textContent = c.address || 'لا يوجد عنوان مسجّل';
    const bal = $('pBalance');
    bal.hidden = !(c.balance > 0);
    if (c.balance > 0) bal.textContent = 'المستحق عليك حاليًا: ' + money(c.balance);
    const list = $('pOrdersList');
    list.replaceChildren();
    (c.orders || []).forEach(o => {
      const li = document.createElement('li');
      const a = document.createElement('span'); a.textContent = o.code;
      const b = document.createElement('span'); b.textContent = STATUS[o.status] || o.status;
      const t = document.createElement('span'); t.textContent = money(o.total);
      li.append(a, b, t); list.append(li);
    });
    show('pOrders', (c.orders || []).length > 0);
    const m = $('profileMsg'); m.hidden = !msg; m.textContent = msg || '';
    show('stepVerify', false); show('stepProfile', true);
    show('profileCard', true); show('editCard', false);
    ret.profile = c;
  }

  async function doVerify() {
    setFieldError('verify', ''); setFieldError('last4', ''); setFieldError('otpCode', '');
    const body = { term: ret.term };
    if (ret.method === 'code') {
      body.last4 = toLatin($('last4').value).trim();
      if (!/^\d{4}$/.test(body.last4)) { setFieldError('last4', 'اكتب 4 أرقام.'); return; }
    } else {
      body.otp = toLatin($('otpCode').value).trim();
      if (!/^\d{6}$/.test(body.otp)) { setFieldError('otpCode', 'اكتب الكود المكوّن من 6 أرقام.'); return; }
    }
    try {
      const r = await busy($('verifyBtn'), 'جارٍ التحقق...', () => api('/customer/verify', body));
      ret.token = r.token;
      renderProfile(r.customer);
    } catch (e) { setFieldError('verify', e.message); }
  }

  function startEdit() {
    const c = ret.profile;
    $('editName').value = c.name; $('editPhone').value = c.phone; $('editAddress').value = c.address || '';
    ['editName', 'editPhone', 'editAddress', 'edit'].forEach(id => setFieldError(id, ''));
    show('profileCard', false); show('editCard', true);
    $('editName').focus();
  }
  async function saveEdit() {
    ['editName', 'editPhone', 'editAddress', 'edit'].forEach(id => setFieldError(id, ''));
    const name = $('editName').value.trim(), address = $('editAddress').value.trim(), phone = cleanPhone($('editPhone').value);
    let bad = false;
    if (name.length < 2) { setFieldError('editName', 'اكتب الاسم بالكامل.'); bad = true; }
    if (!validPhone(phone)) { setFieldError('editPhone', 'اكتب رقم موبايل صحيح، مثال: 01012345678'); bad = true; }
    if (address.length < 6) { setFieldError('editAddress', 'اكتب العنوان بالتفصيل مع أقرب معلم.'); bad = true; }
    if (bad) return;
    try {
      const r = await busy($('saveEditBtn'), 'جارٍ الحفظ...', () => api('/customer/update', { token: ret.token, name, phone, address }));
      ret.token = r.token;
      renderProfile(r.customer, r.changed.length ? 'تم حفظ بياناتك ✔' : 'لا توجد تغييرات.');
    } catch (e) {
      if (e.code === 'session_expired') { sessionExpired(); return; }
      const f = { phone: 'editPhone', name: 'editName', address: 'editAddress' }[e.field];
      setFieldError(f || 'edit', e.message);
    }
  }
  function sessionExpired() {
    resetReturning();
    showError('انتهت جلسة التحقق. أكّد هويتك من جديد للمتابعة.');
  }

  $('lookupBtn').addEventListener('click', doLookup);
  $('lookupTerm').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doLookup(); } });
  $('otpSendBtn').addEventListener('click', sendOtp);
  $('otpResendBtn').addEventListener('click', sendOtp);
  $('verifyBtn').addEventListener('click', doVerify);
  ['last4', 'otpCode'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doVerify(); } }));
  $('verifyBack').addEventListener('click', resetReturning);
  $('switchBtn').addEventListener('click', resetReturning);
  $('editBtn').addEventListener('click', startEdit);
  $('cancelEditBtn').addEventListener('click', () => { show('editCard', false); show('profileCard', true); });
  $('saveEditBtn').addEventListener('click', saveEdit);

  ['fullName', 'phoneNumber', 'addressDetails', 'serviceType'].forEach(id => $(id).addEventListener('input', () => setFieldError(id, '')));

  function validateReturning() {
    if (!ret.token) { showError('أكّد هويتك أولًا (كود العميل أو رقم الهاتف) ثم اختر الخدمة.'); return false; }
    setFieldError('serviceType', $('serviceType').value ? '' : 'اختر نوع الخدمة.');
    if (!$('serviceType').value) { $('serviceType').focus(); return false; }
    return true;
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    clearError();
    const returning = isReturning();
    if (!(returning ? validateReturning() : validate())) return;
    const btn = form.querySelector('.submit-btn');
    const original = btn.innerHTML;
    const time = (form.querySelector('input[name="prefTime"]:checked') || {}).value;
    const common = { serviceType: $('serviceType').value, prefTime: time, company: $('company').value, elapsedMs: Date.now() - openedAt };
    const payload = returning
      ? { customerType: 'returning', token: ret.token, ...common }
      : { customerType: 'new', fullName: $('fullName').value.trim(), phoneNumber: cleanPhone($('phoneNumber').value), address: $('addressDetails').value.trim(), ...common };
    btn.disabled = true;
    btn.textContent = 'جارٍ إرسال الطلب...';
    try {
      const res = await fetch(API + '/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = body.error || {};
        if (err.code === 'session_expired') sessionExpired();
        else if (err.field === 'phoneNumber') setFieldError('phoneNumber', err.message);
        else showError(err.message || 'تعذر إرسال الطلب حاليًا. حاول مرة أخرى أو كلّمنا على الهاتف.');
        return;
      }
      openModal({
        name: returning ? ret.profile.name : payload.fullName,
        phone: returning ? ret.profile.phone : payload.phoneNumber,
        time: payload.prefTime, message: body.message, whatsappUrl: body.whatsappUrl
      });
      form.reset();
      resetReturning();
      setMode();
    } catch {
      showError('تعذر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى، أو كلّمنا على الهاتف.');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  });
})();
