'use strict';

/* =====================================================================
   قسم الموظفين والمرتبات — للمدير فقط (صلاحية hr:manage).
   يعتمد على أدوات app.js (api, guard, toast, confirmBox, esc, num, money …).
   كل الحسابات على الخادم؛ هنا عرض وإدخال فقط.
   ===================================================================== */
const hr = { emps: [], settings: null, tab: 'employees' };
const LEAVE_LABEL = { annual: 'سنوية', sick: 'مرضية', other_paid: 'أخرى بمرتب', unpaid: 'بدون مرتب' };
const thisMonth = () => isoLocal().slice(0, 7);
const hours = n => num(n) + ' س';
const hrField = (sel, fallback = '') => ($(sel).value.trim() === '' ? fallback : $(sel).value.trim());
const empById = id => hr.emps.find(e => e.id === +id);

/* ---------- تحميل وتبويبات ---------- */
async function loadHr() {
  const [s, e] = await Promise.all([guard(() => api('GET', '/hr/summary')), guard(() => api('GET', '/hr/employees'))]);
  if (!s || !e) return;
  hr.emps = e.items; hr.settings = e.settings;
  $('#hr-stat-count').textContent = num(s.activeEmployees);
  $('#hr-stat-count-sub').textContent = s.onLeaveToday ? `${num(s.onLeaveToday)} في إجازة اليوم` : 'لا أحد في إجازة اليوم';
  $('#hr-stat-bill').textContent = money(s.monthlyBill);
  $('#hr-stat-adv').textContent = money(s.advancesOutstanding);
  $('#hr-stat-paid').textContent = money(s.paidThisMonth);
  $('#hr-stat-paid-sub').textContent = `شهر ${s.month}`;
  fillEmpSelects();
  hrSwitch(hr.tab);
}

function hrSwitch(tab) {
  hr.tab = tab;
  $$('#hr-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.htab === tab));
  $$('#hr .stab').forEach(p => { p.hidden = p.id !== 'htab-' + tab; });
  ({ employees: renderEmployees, attendance: loadAttendance, leaves: loadLeaves, adjust: loadAdjust, advances: loadAdvances, payroll: loadPayroll, rules: renderRules })[tab]();
}

function fillEmpSelects() {
  const active = hr.emps.filter(e => e.active);
  const opts = list => list.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  for (const sel of ['#hl-emp', '#ha-emp', '#hv-emp', '#hr-month-emp']) {
    const el = $(sel), prev = el.value;
    el.innerHTML = opts(active);
    if (prev && [...el.options].some(o => o.value === prev)) el.value = prev;
  }
  const f = $('#hr-leave-filter'), prev = f.value;
  f.innerHTML = '<option value="">كل الموظفين</option>' + opts(hr.emps);
  f.value = prev && [...f.options].some(o => o.value === prev) ? prev : '';
}

/* ---------- الموظفون ---------- */
function renderEmployees() {
  $('#hr-emp-table').innerHTML = hr.emps.length ? hr.emps.map(e => `
    <tr class="${e.active ? '' : 'row-off'}">
      <td data-label="الموظف"><b>${esc(e.name)}</b>${e.jobTitle ? `<span class="sub">${esc(e.jobTitle)}</span>` : ''}${e.phone ? `<span class="sub ltr">${esc(e.phone)}</span>` : ''}</td>
      <td data-label="الأجر">${e.payType === 'monthly' ? `${money(e.salary)} <span class="sub">شهريًا</span>` : `${money(e.salary)} <span class="sub">للساعة · ≈ ${money(e.monthlyEquivalent)} شهريًا</span>`}</td>
      <td data-label="ساعات اليوم">${hours(e.dailyHours)}</td>
      <td data-label="حد السلف / المستحق">${money(e.advanceLimitEffective)}${e.advanceLimit == null ? '' : ' <span class="sub">مخصص</span>'}<span class="sub ${e.advanceOutstanding > 0 ? 'due' : ''}">مستحق عليه ${money(e.advanceOutstanding)}</span></td>
      <td data-label="رصيد الإجازة">${num(e.leaveRemaining)} من ${num(e.leaveAllowance)} يوم</td>
      <td data-label="الحالة"><span class="status ${e.active ? 'ready' : 'done'}">${e.active ? 'يعمل' : 'معطّل'}</span></td>
      <td class="actions"><button type="button" class="action" data-hedit="${e.id}">تعديل</button><button type="button" class="action" data-htoggle="${e.id}">${e.active ? 'تعطيل' : 'تفعيل'}</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-row">لا يوجد موظفون بعد. اضغط «إضافة موظف».</td></tr>';
}

function syncEmpTypeLabel() {
  $('#he-salary-label').textContent = $('#he-type').value === 'hourly' ? 'أجر الساعة (ج.م)' : 'المرتب الشهري (ج.م)';
}

function openEmpDialog(e = null) {
  $('#hr-emp-form').reset();
  $('#he-error').textContent = '';
  $('#he-id').value = e ? e.id : '';
  $('#he-title').textContent = e ? 'تعديل بيانات الموظف' : 'موظف جديد';
  $('#he-name').value = e?.name || '';
  $('#he-job').value = e?.jobTitle || '';
  $('#he-phone').value = e?.phone || '';
  $('#he-type').value = e?.payType || 'monthly';
  $('#he-salary').value = e ? e.salary : '';
  $('#he-hours').value = e ? e.dailyHours : (hr.settings?.defaultDailyHours ?? 8);
  $('#he-hire').value = e?.hireDate || '';
  $('#he-advlimit').value = e?.advanceLimit ?? '';
  $('#he-leave').value = e?.annualLeaveDays ?? '';
  $('#he-notes').value = e?.notes || '';
  $('#he-active').checked = e ? e.active : true;
  $('#he-active-row').hidden = !e;
  $('#he-advlimit').placeholder = `فاضي = الافتراضي (${hr.settings?.advanceLimitPercent ?? 50}٪ من المرتب)`;
  $('#he-leave').placeholder = `فاضي = الافتراضي (${hr.settings?.annualLeaveDays ?? 21} يوم)`;
  syncEmpTypeLabel();
  $('#hr-emp-dialog').showModal();
  $('#he-name').focus();
}

async function submitEmp(ev) {
  ev.preventDefault();
  const id = $('#he-id').value;
  const body = {
    name: $('#he-name').value.trim(), jobTitle: $('#he-job').value.trim(), phone: $('#he-phone').value.trim(),
    payType: $('#he-type').value, salary: $('#he-salary').value, dailyHours: $('#he-hours').value,
    hireDate: $('#he-hire').value || null, advanceLimit: $('#he-advlimit').value === '' ? null : $('#he-advlimit').value,
    annualLeaveDays: $('#he-leave').value === '' ? null : $('#he-leave').value, notes: $('#he-notes').value.trim()
  };
  if (id) body.active = $('#he-active').checked;
  await hrSubmit(ev, '#he-error', async () => {
    await api(id ? 'PUT' : 'POST', id ? '/hr/employees/' + id : '/hr/employees', body);
    $('#hr-emp-dialog').close();
    toast(id ? 'تم حفظ بيانات الموظف.' : 'تمت إضافة الموظف.');
    loadHr();
  });
}

// تنفيذ إرسال نموذج مع عرض الخطأ داخل النافذة
async function hrSubmit(ev, errSel, fn) {
  const btn = ev.submitter; if (btn) btn.disabled = true;
  $(errSel).textContent = '';
  try { await fn(); } catch (err) { if (err instanceof ApiError) { if (err.status !== 401) $(errSel).textContent = err.message; } else { console.error(err); $(errSel).textContent = 'حدث خطأ غير متوقع.'; } }
  finally { if (btn) btn.disabled = false; }
}

/* ---------- الحضور وساعات العمل ---------- */
let attSeq = 0;
async function loadAttendance() {
  const dateEl = $('#hr-att-date');
  if (!dateEl.value) dateEl.value = isoLocal();
  const seq = ++attSeq;
  const r = await guard(() => api('GET', '/hr/attendance?date=' + dateEl.value));
  if (!r || seq !== attSeq) return;
  $('#hr-att-table').innerHTML = r.items.length ? r.items.map(i => `
    <tr>
      <td data-label="الموظف"><b>${esc(i.name)}</b>${i.jobTitle ? `<span class="sub">${esc(i.jobTitle)}</span>` : ''}</td>
      <td data-label="المطلوب">${hours(i.dailyHours)}</td>
      <td data-label="الساعات الفعلية"><input class="hr-hours-input" type="number" min="0" max="24" step="0.25" inputmode="decimal" data-att="${i.employeeId}" data-req="${i.dailyHours}" data-leave="${i.leaveType ? 1 : 0}" value="${i.hours ?? ''}" aria-label="ساعات ${esc(i.name)}" /></td>
      <td data-label="ملاحظة">${i.leaveType ? `<span class="status pending">إجازة ${esc(LEAVE_LABEL[i.leaveType])}</span>` : (i.hours != null && i.hours > i.dailyHours ? `<span class="status progress">إضافي ${hours(i.hours - i.dailyHours)}</span>` : '')}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty-row">لا يوجد موظفون عاملون في هذا التاريخ.</td></tr>';
  loadMonthAtt();
}

async function saveAttendance() {
  const entries = $$('#hr-att-table [data-att]').map(i => ({ employeeId: +i.dataset.att, hours: i.value === '' ? null : Number(i.value) }));
  if (!entries.length) return;
  const r = await guard(() => api('PUT', '/hr/attendance', { date: $('#hr-att-date').value, entries }));
  if (r) { toast('تم حفظ ساعات العمل.'); loadAttendance(); }
}

function fillUsualHours() {
  $$('#hr-att-table [data-att]').forEach(i => { if (i.value === '' && i.dataset.leave !== '1') i.value = i.dataset.req; });
}

async function loadMonthAtt() {
  const m = $('#hr-month-att');
  if (!m.value) m.value = thisMonth();
  const emp = $('#hr-month-emp').value;
  if (!emp) { $('#hr-month-table').innerHTML = ''; $('#hr-month-sum').textContent = ''; return; }
  const r = await guard(() => api('GET', `/hr/attendance/month?month=${m.value}&employeeId=${emp}`));
  if (!r) return;
  $('#hr-month-sum').textContent = r.days ? `${r.name}: ${num(r.days)} يوم · إجمالي ${hours(r.totalHours)} (المطلوب يوميًا ${hours(r.dailyHours)})` : `${r.name}: لا توجد ساعات مسجلة في هذا الشهر.`;
  $('#hr-month-table').innerHTML = r.items.length ? r.items.map(i => `
    <tr><td data-label="اليوم">${esc(fmtDateLong(i.date))}</td><td data-label="الساعات">${hours(i.hours)}</td><td data-label="إضافي">${i.overtime ? hours(i.overtime) : '—'}</td></tr>`).join('')
    : '<tr><td colspan="3" class="empty-row">لا توجد سجلات</td></tr>';
}

/* ---------- الإجازات ---------- */
async function loadLeaves() {
  const emp = $('#hr-leave-filter').value;
  const r = await guard(() => api('GET', '/hr/leaves' + (emp ? '?employeeId=' + emp : '')));
  if (!r) return;
  $('#hr-leave-table').innerHTML = r.items.length ? r.items.map(l => `
    <tr>
      <td data-label="الموظف"><b>${esc(l.employeeName)}</b></td>
      <td data-label="النوع"><span class="status ${l.paid ? 'ready' : 'pending'}">${esc(l.typeLabel)}</span></td>
      <td data-label="من">${esc(fmtDateLong(l.startDate))}</td>
      <td data-label="إلى">${esc(fmtDateLong(l.endDate))}</td>
      <td data-label="الأيام">${num(l.days)}</td>
      <td data-label="ملاحظة" class="items">${esc(l.note || '—')}</td>
      <td class="actions"><button type="button" class="action" data-hldel="${l.id}">حذف</button></td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-row">لا توجد إجازات مسجلة</td></tr>';
}

function leaveInfo() {
  const e = empById($('#hl-emp').value);
  $('#hl-info').textContent = e ? (`رصيد ${e.name} من الإجازة السنوية هذا العام: المتبقي ${num(e.leaveRemaining)} من ${num(e.leaveAllowance)} يوم.` +
    ($('#hl-type').value === 'unpaid' ? ' الأيام ستُخصم من مرتبه.' : '')) : '';
}

function openLeaveDialog() {
  if (!hr.emps.some(e => e.active)) return toast('أضف موظفًا أولًا.', 'err');
  $('#hr-leave-form').reset(); $('#hl-error').textContent = '';
  $('#hl-from').value = $('#hl-to').value = isoLocal();
  leaveInfo();
  $('#hr-leave-dialog').showModal();
}

async function submitLeave(ev) {
  ev.preventDefault();
  await hrSubmit(ev, '#hl-error', async () => {
    await api('POST', '/hr/leaves', { employeeId: +$('#hl-emp').value, type: $('#hl-type').value, startDate: $('#hl-from').value, endDate: $('#hl-to').value, note: $('#hl-note').value.trim() });
    $('#hr-leave-dialog').close(); toast('تم تسجيل الإجازة.'); loadHr();
  });
}

/* ---------- الخصومات والمكافآت ---------- */
async function loadAdjust() {
  const m = $('#hr-adj-month');
  if (!m.value) m.value = thisMonth();
  const r = await guard(() => api('GET', '/hr/adjustments?month=' + m.value));
  if (!r) return;
  $('#hr-adj-table').innerHTML = r.items.length ? r.items.map(a => `
    <tr>
      <td data-label="التاريخ">${esc(fmtDateLong(a.date))}</td>
      <td data-label="الموظف"><b>${esc(a.employeeName)}</b></td>
      <td data-label="النوع"><span class="status ${a.kind === 'bonus' ? 'ready' : 'pending'}">${a.kind === 'bonus' ? 'مكافأة' : 'خصم'}</span></td>
      <td data-label="المبلغ" class="${a.kind === 'bonus' ? '' : 'due-amount'}">${a.kind === 'bonus' ? '+' : '−'} ${money(a.amount)}</td>
      <td data-label="السبب" class="items">${esc(a.reason)}</td>
      <td class="actions"><button type="button" class="action" data-hadel="${a.id}">حذف</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-row">لا توجد خصومات أو مكافآت في هذا الشهر</td></tr>';
}

function openAdjDialog() {
  if (!hr.emps.some(e => e.active)) return toast('أضف موظفًا أولًا.', 'err');
  $('#hr-adj-form').reset(); $('#ha-error').textContent = '';
  $('#ha-date').value = isoLocal();
  $('#hr-adj-dialog').showModal();
}

async function submitAdj(ev) {
  ev.preventDefault();
  await hrSubmit(ev, '#ha-error', async () => {
    await api('POST', '/hr/adjustments', { employeeId: +$('#ha-emp').value, kind: $('#ha-kind').value, amount: $('#ha-amount').value, date: $('#ha-date').value, reason: $('#ha-reason').value.trim() });
    $('#hr-adj-dialog').close(); toast('تم الحفظ.'); loadHr();
  });
}

/* ---------- السلف ---------- */
let advCache = new Map();
async function loadAdvances() {
  const r = await guard(() => api('GET', '/hr/advances' + ($('#hr-adv-open').checked ? '?open=1' : '')));
  if (!r) return;
  advCache = new Map(r.items.map(a => [a.id, a]));
  $('#hr-adv-table').innerHTML = r.items.length ? r.items.map(a => `
    <tr>
      <td data-label="الموظف"><b>${esc(a.employeeName)}</b>${a.note ? `<span class="sub">${esc(a.note)}</span>` : ''}</td>
      <td data-label="التاريخ">${esc(fmtDateLong(a.date))}</td>
      <td data-label="المبلغ">${money(a.amount)}</td>
      <td data-label="القسط الشهري">${a.installment == null ? '<span class="sub">سداد يدوي</span>' : money(a.installment)}</td>
      <td data-label="المسدد">${money(a.repaid)}</td>
      <td data-label="المتبقي" class="${a.remaining > 0 ? 'due-amount' : ''}">${a.remaining > 0 ? money(a.remaining) : '<span class="status ready">مسددة</span>'}</td>
      <td class="actions">${a.remaining > 0 ? `<button type="button" class="action" data-hrepay="${a.id}">سداد</button>` : ''}${a.repayments === 0 ? `<button type="button" class="action" data-hadvdel="${a.id}">حذف</button>` : ''}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty-row">لا توجد سلف</td></tr>';
}

function advInfo() {
  const e = empById($('#hv-emp').value);
  $('#hv-info').textContent = e ? `حد السلف ${money(e.advanceLimitEffective)} · المستحق عليه ${money(e.advanceOutstanding)} · المتاح الآن ${money(e.advanceAvailable)}` : '';
}

function openAdvDialog() {
  if (!hr.emps.some(e => e.active)) return toast('أضف موظفًا أولًا.', 'err');
  $('#hr-adv-form').reset(); $('#hv-error').textContent = '';
  $('#hv-date').value = isoLocal();
  advInfo();
  $('#hr-adv-dialog').showModal();
}

async function submitAdv(ev) {
  ev.preventDefault();
  await hrSubmit(ev, '#hv-error', async () => {
    await api('POST', '/hr/advances', { employeeId: +$('#hv-emp').value, amount: $('#hv-amount').value, installment: $('#hv-inst').value, date: $('#hv-date').value, note: $('#hv-note').value.trim() });
    $('#hr-adv-dialog').close(); toast('تم صرف السلفة.'); loadHr();
  });
}

let repayId = null;
function openRepay(id) {
  const a = advCache.get(id); if (!a) return;
  repayId = id;
  $('#hr-repay-form').reset(); $('#hp-error').textContent = '';
  $('#hp-info').textContent = `${a.employeeName} — المتبقي من السلفة ${money(a.remaining)}`;
  $('#hp-amount').value = a.installment ? Math.min(a.installment, a.remaining) : a.remaining;
  $('#hr-repay-dialog').showModal();
}

async function submitRepay(ev) {
  ev.preventDefault();
  await hrSubmit(ev, '#hp-error', async () => {
    await api('POST', `/hr/advances/${repayId}/repay`, { amount: $('#hp-amount').value });
    $('#hr-repay-dialog').close(); toast('تم تسجيل السداد.'); loadHr();
  });
}

/* ---------- كشف المرتبات ---------- */
let payData = null;
async function loadPayroll() {
  const m = $('#hr-pay-month');
  if (!m.value) m.value = thisMonth();
  const r = await guard(() => api('GET', '/hr/payroll?month=' + m.value));
  if (!r) return;
  payData = r;
  $('#hr-pay-table').innerHTML = r.items.length ? r.items.map(i => `
    <tr>
      <td data-label="الموظف"><b>${esc(i.name)}</b>${i.jobTitle ? `<span class="sub">${esc(i.jobTitle)}</span>` : ''}</td>
      <td data-label="الأساسي">${money(i.base)}${i.payType === 'hourly' ? '<span class="sub">بالساعة</span>' : ''}</td>
      <td data-label="الساعات">${i.hours ? hours(i.hours) : '—'}</td>
      <td data-label="إضافي">${i.overtime ? `${money(i.overtime)}<span class="sub">${hours(i.overtimeHours)}</span>` : '—'}</td>
      <td data-label="مكافآت">${i.bonus ? money(i.bonus) : '—'}</td>
      <td data-label="خصومات" class="${i.deduction ? 'due-amount' : ''}">${i.deduction ? money(i.deduction) : '—'}</td>
      <td data-label="غياب بدون مرتب" class="${i.unpaidLeave ? 'due-amount' : ''}">${i.unpaidLeave ? `${money(i.unpaidLeave)}<span class="sub">${num(i.unpaidDays)} يوم</span>` : '—'}</td>
      <td data-label="سلف" class="${i.advance ? 'due-amount' : ''}">${i.advance ? money(i.advance) : '—'}</td>
      <td data-label="الصافي"><b>${money(i.net)}</b>${i.negative ? '<span class="sub due">الاستقطاعات أكبر من المرتب</span>' : ''}</td>
      <td class="actions">${i.status === 'paid'
        ? `<span class="status ready">مصروف ${esc(fmtDate(i.paidDate))}</span> <button type="button" class="action" data-hpdel="${i.payrollId}" title="حذف الكشف وإرجاع أقساط السلف">إلغاء</button>`
        : '<span class="status pending">بانتظار الاعتماد</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="10" class="empty-row">لا يوجد موظفون في هذا الشهر</td></tr>';
  const t = r.totals;
  $('#hr-pay-foot').innerHTML = r.items.length ? `<tr class="total-row"><td data-label="الإجمالي"><b>الإجمالي</b></td><td>${money(t.base)}</td><td></td><td>${money(t.overtime)}</td><td>${money(t.bonus)}</td><td>${money(t.deduction)}</td><td>${money(t.unpaidLeave)}</td><td>${money(t.advance)}</td><td><b>${money(t.net)}</b></td><td></td></tr>` : '';
  const b = $('#hr-pay-approve');
  b.disabled = !t.pendingCount || m.value > thisMonth();
  b.lastChild.textContent = t.pendingCount ? `اعتماد وصرف (${num(t.pendingCount)} موظف)` : 'تم اعتماد الكل';
}

async function approvePayroll() {
  if (!payData || !payData.totals.pendingCount) return;
  const month = payData.month;
  if (!await confirmBox(`اعتماد مرتبات شهر ${month} لعدد ${num(payData.totals.pendingCount)} موظف بإجمالي صافي ${money(payData.totals.pendingNet)}؟ سيتم خصم أقساط السلف وقفل الشهر لهم.`, { ok: 'اعتماد وصرف', title: 'اعتماد المرتبات' })) return;
  const r = await guard(() => api('POST', '/hr/payroll/approve', { month }));
  if (r) { toast('تم اعتماد المرتبات.'); loadHr(); }
}

/* ---------- قواعد الحساب ---------- */
function renderRules() {
  const s = hr.settings; if (!s) return;
  $('#hr-r-workdays').value = s.workdaysPerMonth; $('#hr-r-hours').value = s.defaultDailyHours; $('#hr-r-ot').value = s.overtimeMultiplier;
  $('#hr-r-advpct').value = s.advanceLimitPercent; $('#hr-r-leave').value = s.annualLeaveDays; $('#hr-r-off').value = String(s.weeklyOffDay);
}

async function saveRules(ev) {
  ev.preventDefault();
  const r = await guard(() => api('PUT', '/hr/settings', {
    workdaysPerMonth: $('#hr-r-workdays').value, defaultDailyHours: $('#hr-r-hours').value, overtimeMultiplier: $('#hr-r-ot').value,
    advanceLimitPercent: $('#hr-r-advpct').value, annualLeaveDays: $('#hr-r-leave').value, weeklyOffDay: $('#hr-r-off').value
  }));
  if (r) { toast('تم حفظ القواعد.'); loadHr(); }
}

/* ---------- ربط الأحداث ---------- */
function initHr() {
  $('#hr-tabs').addEventListener('click', e => { const b = e.target.closest('[data-htab]'); if (b) hrSwitch(b.dataset.htab); });

  $('#hr-add-emp').addEventListener('click', () => openEmpDialog());
  $('#he-type').addEventListener('change', syncEmpTypeLabel);
  $('#hr-emp-form').addEventListener('submit', submitEmp);
  $('#hr-emp-table').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.hedit) openEmpDialog(empById(t.dataset.hedit));
    if (t.dataset.htoggle) {
      const emp = empById(t.dataset.htoggle);
      if (emp.active && !await confirmBox(`تعطيل ${emp.name}؟ سيختفي من الحضور والكشوف الجديدة وتبقى سجلاته.`, { ok: 'تعطيل', title: 'تعطيل موظف', danger: true })) return;
      const r = await guard(() => api('PUT', '/hr/employees/' + emp.id, { active: !emp.active }));
      if (r) loadHr();
    }
  });

  $('#hr-att-date').addEventListener('change', loadAttendance);
  $('#hr-att-save').addEventListener('click', saveAttendance);
  $('#hr-att-fill').addEventListener('click', fillUsualHours);
  $('#hr-month-emp').addEventListener('change', loadMonthAtt);
  $('#hr-month-att').addEventListener('change', loadMonthAtt);

  $('#hr-leave-filter').addEventListener('change', loadLeaves);
  $('#hr-add-leave').addEventListener('click', openLeaveDialog);
  $('#hl-emp').addEventListener('change', leaveInfo);
  $('#hl-type').addEventListener('change', leaveInfo);
  $('#hl-from').addEventListener('change', () => { if (!$('#hl-to').value || $('#hl-to').value < $('#hl-from').value) $('#hl-to').value = $('#hl-from').value; });
  $('#hr-leave-form').addEventListener('submit', submitLeave);
  $('#hr-leave-table').addEventListener('click', async e => {
    const t = e.target.closest('[data-hldel]'); if (!t) return;
    if (!await confirmBox('حذف هذه الإجازة؟ لو كانت سنوية يرجع الرصيد، ولو بدون مرتب يرجع المرتب كاملًا.', { ok: 'حذف', title: 'حذف إجازة', danger: true })) return;
    const r = await guard(() => api('DELETE', '/hr/leaves/' + t.dataset.hldel));
    if (r) { toast('تم حذف الإجازة.'); loadHr(); }
  });

  $('#hr-adj-month').addEventListener('change', loadAdjust);
  $('#hr-add-adj').addEventListener('click', openAdjDialog);
  $('#hr-adj-form').addEventListener('submit', submitAdj);
  $('#hr-adj-table').addEventListener('click', async e => {
    const t = e.target.closest('[data-hadel]'); if (!t) return;
    if (!await confirmBox('حذف هذا السجل؟', { ok: 'حذف', title: 'حذف', danger: true })) return;
    const r = await guard(() => api('DELETE', '/hr/adjustments/' + t.dataset.hadel));
    if (r) { toast('تم الحذف.'); loadAdjust(); }
  });

  $('#hr-adv-open').addEventListener('change', loadAdvances);
  $('#hr-add-adv').addEventListener('click', openAdvDialog);
  $('#hv-emp').addEventListener('change', advInfo);
  $('#hr-adv-form').addEventListener('submit', submitAdv);
  $('#hr-repay-form').addEventListener('submit', submitRepay);
  $('#hr-adv-table').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.hrepay) openRepay(+t.dataset.hrepay);
    if (t.dataset.hadvdel && await confirmBox('حذف هذه السلفة؟ (مسموح فقط لو لم يُسدَّد منها شيء)', { ok: 'حذف', title: 'حذف سلفة', danger: true })) {
      const r = await guard(() => api('DELETE', '/hr/advances/' + t.dataset.hadvdel));
      if (r) { toast('تم حذف السلفة.'); loadHr(); }
    }
  });

  $('#hr-pay-month').addEventListener('change', loadPayroll);
  $('#hr-pay-approve').addEventListener('click', approvePayroll);
  $('#hr-pay-table').addEventListener('click', async e => {
    const t = e.target.closest('[data-hpdel]'); if (!t) return;
    if (!await confirmBox('إلغاء اعتماد مرتب هذا الموظف؟ سيُحذف الكشف وتعود أقساط السلف التي خُصمت منه.', { ok: 'إلغاء الاعتماد', title: 'إلغاء كشف مرتب', danger: true })) return;
    const r = await guard(() => api('DELETE', '/hr/payroll/' + t.dataset.hpdel));
    if (r) { toast('تم إلغاء الكشف.'); loadHr(); }
  });

  $('#hr-rules-form').addEventListener('submit', saveRules);
}

initHr();
