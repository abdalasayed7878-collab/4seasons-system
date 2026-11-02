'use strict';
/* =====================================================================
   الموظفون والمرتبات — للمدير فقط (صلاحية hr:manage غير قابلة للمنح).
   كل الحسابات على الخادم، والمبالغ بالقروش كأعداد صحيحة.
   ===================================================================== */
const { tx } = require('./db');
const U = require('./util');

const LEAVE_TYPES = {
  annual: { label: 'سنوية', paid: true },
  sick: { label: 'مرضية', paid: true },
  other_paid: { label: 'أخرى بمرتب', paid: true },
  unpaid: { label: 'بدون مرتب', paid: false }
};

function createHr(db, { audit }) {
  const q = sql => db.prepare(sql);
  const c2p = U.fromCents;
  const round = Math.round;

  /* ---------------- مساعدات ---------------- */
  const monthOk = m => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''))) throw U.invalid('الشهر غير صحيح.', 'month');
    return m;
  };
  const dateOk = (v, field, { required = true } = {}) => {
    if (v == null || v === '') { if (required) throw U.invalid(`الحقل «${field}» مطلوب.`, field); return null; }
    if (!U.isDateStr(v)) throw U.invalid(`تاريخ غير صحيح في «${field}».`, field);
    return v;
  };
  const numIn = (v, { field, min, max, int = false, required = true }) => {
    if (v == null || v === '') { if (required) throw U.invalid(`الحقل «${field}» مطلوب.`, field); return null; }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) throw U.invalid(`قيمة غير صحيحة في «${field}».`, field);
    return n;
  };
  const utc = s => new Date(s + 'T00:00:00Z');
  const fmt = d => d.toISOString().slice(0, 10);
  const monthRange = period => {
    const [y, m] = period.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { from: `${period}-01`, to: `${period}-${U.pad(last, 2)}` };
  };
  // عدد أيام العمل بين تاريخين (شامل) بدون الإجازة الأسبوعية
  function workingDays(from, to, off) {
    let n = 0;
    for (let d = utc(from); d <= utc(to); d = new Date(d.getTime() + 86400000)) if (d.getUTCDay() !== off) n++;
    return n;
  }
  const maxDate = (a, b) => (a > b ? a : b);
  const minDate = (a, b) => (a < b ? a : b);

  /* ---------------- الإعدادات ---------------- */
  function getSettings() {
    const o = {};
    for (const r of q('SELECT key,value FROM hr_settings').all()) o[r.key] = r.value;
    return {
      workdaysPerMonth: +o.workdays_per_month, defaultDailyHours: +o.default_daily_hours,
      overtimeMultiplier: +o.overtime_multiplier, advanceLimitPercent: +o.advance_limit_percent,
      annualLeaveDays: +o.annual_leave_days, weeklyOffDay: +o.weekly_off_day
    };
  }

  function updateSettings(actor, input) {
    const map = {
      workdaysPerMonth: ['workdays_per_month', { field: 'أيام العمل في الشهر', min: 1, max: 31, int: true }],
      defaultDailyHours: ['default_daily_hours', { field: 'ساعات العمل اليومية', min: 1, max: 24 }],
      overtimeMultiplier: ['overtime_multiplier', { field: 'معامل الساعة الإضافية', min: 1, max: 5 }],
      advanceLimitPercent: ['advance_limit_percent', { field: 'حد السلف (٪)', min: 0, max: 500 }],
      annualLeaveDays: ['annual_leave_days', { field: 'رصيد الإجازة السنوية', min: 0, max: 90, int: true }],
      weeklyOffDay: ['weekly_off_day', { field: 'الإجازة الأسبوعية', min: 0, max: 6, int: true }]
    };
    const changes = {};
    for (const [k, [key, rule]] of Object.entries(map)) {
      if (input[k] === undefined) continue;
      changes[key] = String(numIn(input[k], rule));
    }
    tx(db, () => {
      const up = q('INSERT INTO hr_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(changes)) up.run(k, v);
      audit(actor, 'hr.settings', 'hr_settings', null, changes);
    });
    return getSettings();
  }

  /* ---------------- الموظفون ---------------- */
  // المرتب الشهري المكافئ (للموظف بالساعة: أجر الساعة × ساعات اليوم × أيام الشهر)
  const monthlyEquivalent = (e, s) => (e.pay_type === 'monthly' ? e.salary_cents : round(e.salary_cents * e.daily_hours * s.workdaysPerMonth));
  const advanceLimitOf = (e, s) => (e.advance_limit_cents ?? round(monthlyEquivalent(e, s) * s.advanceLimitPercent / 100));
  const leaveAllowanceOf = (e, s) => e.annual_leave_days ?? s.annualLeaveDays;

  const OUTSTANDING_SQL = `
    SELECT COALESCE(SUM(a.amount_cents - COALESCE((SELECT SUM(r.amount_cents) FROM hr_advance_repayments r WHERE r.advance_id = a.id), 0)), 0) n
    FROM hr_advances a WHERE a.employee_id = ?`;
  const outstandingOf = employeeId => q(OUTSTANDING_SQL).get(employeeId).n;
  const annualUsed = (employeeId, year) => q(`SELECT COALESCE(SUM(days),0) n FROM hr_leaves WHERE employee_id = ? AND leave_type = 'annual' AND substr(start_date,1,4) = ?`)
    .get(employeeId, String(year)).n;

  function empOut(e, s) {
    const year = U.todayStr().slice(0, 4);
    const outstanding = outstandingOf(e.id);
    const limit = advanceLimitOf(e, s);
    const allowance = leaveAllowanceOf(e, s);
    return {
      id: e.id, name: e.name, phone: e.phone, jobTitle: e.job_title, payType: e.pay_type,
      salary: c2p(e.salary_cents), dailyHours: e.daily_hours,
      advanceLimit: e.advance_limit_cents == null ? null : c2p(e.advance_limit_cents),
      annualLeaveDays: e.annual_leave_days, hireDate: e.hire_date, notes: e.notes, active: !!e.active,
      monthlyEquivalent: c2p(monthlyEquivalent(e, s)),
      advanceLimitEffective: c2p(limit), advanceOutstanding: c2p(outstanding), advanceAvailable: c2p(Math.max(0, limit - outstanding)),
      leaveAllowance: allowance, leaveUsed: annualUsed(e.id, year), leaveRemaining: Math.max(0, allowance - annualUsed(e.id, year))
    };
  }

  const getEmployeeRow = id => {
    const e = q('SELECT * FROM employees WHERE id = ?').get(id);
    if (!e) throw U.httpError(404, 'not_found', 'الموظف غير موجود.');
    return e;
  };
  const activeEmployeeRow = id => {
    const e = getEmployeeRow(id);
    if (!e.active) throw U.invalid('الموظف معطّل.', 'employeeId');
    return e;
  };

  function listEmployees({ all = true } = {}) {
    const s = getSettings();
    const rows = q(`SELECT * FROM employees ${all ? '' : 'WHERE active = 1'} ORDER BY active DESC, name`).all();
    return { items: rows.map(e => empOut(e, s)), settings: s };
  }

  function parseEmployee(input, ex) {
    const has = k => input[k] !== undefined;
    const s = getSettings();
    const name = has('name') ? U.str(input.name, { field: 'الاسم', min: 2, max: 80, required: true }) : ex.name;
    let phone = ex?.phone ?? null;
    if (has('phone')) {
      const raw = U.str(input.phone, { field: 'الهاتف', max: 30 });
      phone = raw ? U.normalizePhone(raw) : null;
      if (raw && !phone) throw U.invalid('رقم الهاتف غير صحيح.', 'phone');
    }
    const jobTitle = has('jobTitle') ? U.str(input.jobTitle, { field: 'الوظيفة', max: 60 }) : (ex?.job_title ?? null);
    const payType = has('payType') ? U.pick(input.payType, ['monthly', 'hourly'], 'نوع الأجر') : (ex?.pay_type ?? 'monthly');
    const salaryCents = has('salary') ? U.money(input.salary, { field: 'المرتب', required: true, min: 0, max: 1_000_000 }) : (ex?.salary_cents ?? NaN);
    if (!Number.isFinite(salaryCents)) throw U.invalid('الحقل «المرتب» مطلوب.', 'salary');
    const dailyHours = has('dailyHours') ? numIn(input.dailyHours, { field: 'ساعات العمل اليومية', min: 0.5, max: 24 }) : (ex?.daily_hours ?? s.defaultDailyHours);
    let advanceLimit = ex?.advance_limit_cents ?? null;
    if (has('advanceLimit')) advanceLimit = input.advanceLimit === null || input.advanceLimit === '' ? null : U.money(input.advanceLimit, { field: 'حد السلف', min: 0, max: 1_000_000 });
    let leaveDays = ex?.annual_leave_days ?? null;
    if (has('annualLeaveDays')) leaveDays = input.annualLeaveDays === null || input.annualLeaveDays === '' ? null : numIn(input.annualLeaveDays, { field: 'رصيد الإجازة', min: 0, max: 90, int: true });
    const hireDate = has('hireDate') ? dateOk(input.hireDate, 'تاريخ التعيين', { required: false }) : (ex?.hire_date ?? null);
    const notes = has('notes') ? U.str(input.notes, { field: 'ملاحظات', max: 300 }) : (ex?.notes ?? null);
    const active = has('active') ? (input.active ? 1 : 0) : (ex?.active ?? 1);
    return { name, phone, jobTitle, payType, salaryCents, dailyHours, advanceLimit, leaveDays, hireDate, notes, active };
  }

  function createEmployee(actor, input) {
    const p = parseEmployee(input, null);
    const now = U.nowIso();
    const r = q(`INSERT INTO employees (name,phone,job_title,pay_type,salary_cents,daily_hours,advance_limit_cents,annual_leave_days,hire_date,notes,active,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.name, p.phone, p.jobTitle, p.payType, p.salaryCents, p.dailyHours, p.advanceLimit, p.leaveDays, p.hireDate, p.notes, p.active, now, now);
    const id = Number(r.lastInsertRowid);
    audit(actor, 'hr.employee_create', 'employee', id, { name: p.name, payType: p.payType, salary: c2p(p.salaryCents) });
    return empOut(getEmployeeRow(id), getSettings());
  }

  function updateEmployee(actor, id, input) {
    const ex = getEmployeeRow(id);
    const p = parseEmployee(input, ex);
    q(`UPDATE employees SET name=?, phone=?, job_title=?, pay_type=?, salary_cents=?, daily_hours=?, advance_limit_cents=?, annual_leave_days=?,
      hire_date=?, notes=?, active=?, updated_at=? WHERE id=?`)
      .run(p.name, p.phone, p.jobTitle, p.payType, p.salaryCents, p.dailyHours, p.advanceLimit, p.leaveDays, p.hireDate, p.notes, p.active, U.nowIso(), id);
    const changes = {};
    if (p.salaryCents !== ex.salary_cents) changes.salary = { from: c2p(ex.salary_cents), to: c2p(p.salaryCents) };
    if (p.payType !== ex.pay_type) changes.payType = { from: ex.pay_type, to: p.payType };
    if (p.dailyHours !== ex.daily_hours) changes.dailyHours = { from: ex.daily_hours, to: p.dailyHours };
    if (p.advanceLimit !== ex.advance_limit_cents) changes.advanceLimit = { from: ex.advance_limit_cents == null ? 'افتراضي' : c2p(ex.advance_limit_cents), to: p.advanceLimit == null ? 'افتراضي' : c2p(p.advanceLimit) };
    if (p.active !== ex.active) changes.active = p.active;
    audit(actor, 'hr.employee_update', 'employee', id, { name: p.name, ...changes });
    return empOut(getEmployeeRow(id), getSettings());
  }

  /* ---------------- الحضور وساعات العمل ---------------- */
  function leaveOn(employeeId, date) {
    return q('SELECT id, leave_type FROM hr_leaves WHERE employee_id = ? AND start_date <= ? AND end_date >= ?').get(employeeId, date, date);
  }

  function getAttendanceDay(date) {
    dateOk(date, 'التاريخ');
    const rows = q(`SELECT e.id, e.name, e.job_title, e.daily_hours, a.hours FROM employees e
      LEFT JOIN hr_attendance a ON a.employee_id = e.id AND a.work_date = ?
      WHERE e.active = 1 AND (e.hire_date IS NULL OR e.hire_date <= ?) ORDER BY e.name`).all(date, date);
    return {
      date, items: rows.map(r => {
        const lv = leaveOn(r.id, date);
        return { employeeId: r.id, name: r.name, jobTitle: r.job_title, dailyHours: r.daily_hours, hours: r.hours, leaveType: lv ? lv.leave_type : null };
      })
    };
  }

  function saveAttendanceDay(actor, input) {
    const date = dateOk(input.date, 'التاريخ');
    if (date > U.todayStr()) throw U.invalid('لا يمكن تسجيل ساعات ليوم لم يأتِ بعد.', 'date');
    const entries = Array.isArray(input.entries) ? input.entries : [];
    if (entries.length > 500) throw U.invalid('عدد السجلات كبير.', 'entries');
    const clean = entries.map(en => {
      const employeeId = U.int(en.employeeId, { field: 'الموظف', min: 1, required: true });
      const hours = en.hours === null || en.hours === '' || en.hours === undefined ? null : numIn(en.hours, { field: 'الساعات', min: 0, max: 24 });
      return { employeeId, hours: hours == null ? null : Math.round(hours * 100) / 100 };
    });
    let saved = 0;
    tx(db, () => {
      const up = q(`INSERT INTO hr_attendance (employee_id,work_date,hours,updated_by,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(employee_id,work_date) DO UPDATE SET hours = excluded.hours, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
      const del = q('DELETE FROM hr_attendance WHERE employee_id = ? AND work_date = ?');
      for (const en of clean) {
        getEmployeeRow(en.employeeId);
        if (en.hours == null) del.run(en.employeeId, date); else up.run(en.employeeId, date, en.hours, actor.id, U.nowIso());
        saved++;
      }
      audit(actor, 'hr.attendance', 'attendance', date, { records: saved });
    });
    return getAttendanceDay(date);
  }

  function listAttendanceMonth({ month, employeeId }) {
    monthOk(month);
    const { from, to } = monthRange(month);
    const emp = getEmployeeRow(U.int(employeeId, { field: 'الموظف', min: 1, required: true }));
    const items = q('SELECT work_date, hours FROM hr_attendance WHERE employee_id = ? AND work_date BETWEEN ? AND ? ORDER BY work_date').all(emp.id, from, to)
      .map(r => ({ date: r.work_date, hours: r.hours, overtime: Math.max(0, Math.round((r.hours - emp.daily_hours) * 100) / 100) }));
    const total = items.reduce((a, r) => a + r.hours, 0);
    return { employeeId: emp.id, name: emp.name, dailyHours: emp.daily_hours, items, totalHours: Math.round(total * 100) / 100, days: items.length };
  }

  /* ---------------- الإجازات ---------------- */
  const leaveOut = l => ({
    id: l.id, employeeId: l.employee_id, employeeName: l.employee_name, type: l.leave_type, typeLabel: LEAVE_TYPES[l.leave_type].label,
    paid: LEAVE_TYPES[l.leave_type].paid, startDate: l.start_date, endDate: l.end_date, days: l.days, note: l.note
  });

  function listLeaves({ employeeId, year } = {}) {
    const where = [], params = [];
    if (employeeId) { where.push('l.employee_id = ?'); params.push(Number(employeeId)); }
    if (year) { where.push('substr(l.start_date,1,4) = ?'); params.push(String(year)); }
    const rows = q(`SELECT l.*, e.name AS employee_name FROM hr_leaves l JOIN employees e ON e.id = l.employee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.start_date DESC, l.id DESC LIMIT 300`).all(...params);
    return { items: rows.map(leaveOut) };
  }

  function createLeave(actor, input) {
    const e = activeEmployeeRow(U.int(input.employeeId, { field: 'الموظف', min: 1, required: true }));
    const type = U.pick(input.type, Object.keys(LEAVE_TYPES), 'نوع الإجازة');
    const start = dateOk(input.startDate, 'من تاريخ');
    const end = dateOk(input.endDate || input.startDate, 'إلى تاريخ');
    if (end < start) throw U.invalid('تاريخ النهاية قبل البداية.', 'endDate');
    if ((utc(end) - utc(start)) / 86400000 > 120) throw U.invalid('مدة الإجازة طويلة جدًا (الحد 120 يومًا).', 'endDate');
    const s = getSettings();
    const days = workingDays(start, end, s.weeklyOffDay);
    if (days < 1) throw U.invalid('الفترة كلها إجازة أسبوعية.', 'startDate');
    const overlap = q('SELECT id FROM hr_leaves WHERE employee_id = ? AND start_date <= ? AND end_date >= ?').get(e.id, end, start);
    if (overlap) throw U.httpError(409, 'leave_overlap', 'للموظف إجازة مسجّلة تتقاطع مع هذه الفترة.');
    if (type === 'annual') {
      const allowance = leaveAllowanceOf(e, s);
      const used = annualUsed(e.id, start.slice(0, 4));
      if (used + days > allowance) {
        throw U.httpError(422, 'leave_balance', `رصيد الإجازة السنوية لا يكفي: المتبقي ${Math.max(0, allowance - used)} يوم والمطلوب ${days}. عدّل رصيد الموظف أو اختر نوعًا آخر.`);
      }
    }
    const note = U.str(input.note, { field: 'ملاحظة', max: 200 });
    const r = q('INSERT INTO hr_leaves (employee_id,leave_type,start_date,end_date,days,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(e.id, type, start, end, days, note, actor.id, U.nowIso());
    const id = Number(r.lastInsertRowid);
    audit(actor, 'hr.leave_create', 'leave', id, { employee: e.name, type, start, end, days });
    return leaveOut({ ...q('SELECT * FROM hr_leaves WHERE id = ?').get(id), employee_name: e.name });
  }

  function deleteLeave(actor, id) {
    const l = q('SELECT l.*, e.name AS employee_name FROM hr_leaves l JOIN employees e ON e.id = l.employee_id WHERE l.id = ?').get(id);
    if (!l) throw U.httpError(404, 'not_found', 'الإجازة غير موجودة.');
    if (q('SELECT 1 FROM hr_payroll WHERE employee_id = ? AND period BETWEEN ? AND ?').get(l.employee_id, l.start_date.slice(0, 7), l.end_date.slice(0, 7))) {
      throw U.httpError(409, 'leave_locked', 'تم اعتماد مرتب شهر يقع فيه جزء من هذه الإجازة. احذف كشف المرتب أولًا.');
    }
    q('DELETE FROM hr_leaves WHERE id = ?').run(id);
    audit(actor, 'hr.leave_delete', 'leave', id, { employee: l.employee_name, type: l.leave_type, start: l.start_date, end: l.end_date });
    return { ok: true };
  }

  /* ---------------- الخصومات والمكافآت ---------------- */
  const adjOut = a => ({
    id: a.id, employeeId: a.employee_id, employeeName: a.employee_name, kind: a.kind, date: a.adj_date,
    amount: c2p(a.amount_cents), reason: a.reason
  });

  function listAdjustments({ month, employeeId } = {}) {
    const where = [], params = [];
    if (month) { const { from, to } = monthRange(monthOk(month)); where.push('a.adj_date BETWEEN ? AND ?'); params.push(from, to); }
    if (employeeId) { where.push('a.employee_id = ?'); params.push(Number(employeeId)); }
    const rows = q(`SELECT a.*, e.name AS employee_name FROM hr_adjustments a JOIN employees e ON e.id = a.employee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.adj_date DESC, a.id DESC LIMIT 300`).all(...params);
    return { items: rows.map(adjOut) };
  }

  const periodLocked = (employeeId, date) => !!q('SELECT 1 FROM hr_payroll WHERE employee_id = ? AND period = ?').get(employeeId, date.slice(0, 7));

  function createAdjustment(actor, input) {
    const e = activeEmployeeRow(U.int(input.employeeId, { field: 'الموظف', min: 1, required: true }));
    const kind = U.pick(input.kind, ['deduction', 'bonus'], 'النوع');
    const date = dateOk(input.date || U.todayStr(), 'التاريخ');
    const amount = U.money(input.amount, { field: 'المبلغ', required: true, min: 0, max: 1_000_000 });
    if (!(amount > 0)) throw U.invalid('أدخل مبلغًا أكبر من صفر.', 'amount');
    const reason = U.str(input.reason, { field: 'السبب', min: 2, max: 200, required: true });
    if (periodLocked(e.id, date)) throw U.httpError(409, 'period_locked', 'تم اعتماد مرتب هذا الشهر للموظف. احذف كشف المرتب أولًا ثم أضف التعديل.');
    const r = q('INSERT INTO hr_adjustments (employee_id,kind,adj_date,amount_cents,reason,created_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(e.id, kind, date, amount, reason, actor.id, U.nowIso());
    const id = Number(r.lastInsertRowid);
    audit(actor, kind === 'bonus' ? 'hr.bonus_create' : 'hr.deduction_create', 'adjustment', id, { employee: e.name, amount: c2p(amount), reason, date });
    return adjOut({ ...q('SELECT * FROM hr_adjustments WHERE id = ?').get(id), employee_name: e.name });
  }

  function deleteAdjustment(actor, id) {
    const a = q('SELECT a.*, e.name AS employee_name FROM hr_adjustments a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?').get(id);
    if (!a) throw U.httpError(404, 'not_found', 'السجل غير موجود.');
    if (periodLocked(a.employee_id, a.adj_date)) throw U.httpError(409, 'period_locked', 'تم اعتماد مرتب هذا الشهر. احذف كشف المرتب أولًا.');
    q('DELETE FROM hr_adjustments WHERE id = ?').run(id);
    audit(actor, 'hr.adjustment_delete', 'adjustment', id, { employee: a.employee_name, kind: a.kind, amount: c2p(a.amount_cents) });
    return { ok: true };
  }

  /* ---------------- السلف ---------------- */
  const REMAINING = `a.amount_cents - COALESCE((SELECT SUM(r.amount_cents) FROM hr_advance_repayments r WHERE r.advance_id = a.id), 0)`;
  const advOut = a => ({
    id: a.id, employeeId: a.employee_id, employeeName: a.employee_name, amount: c2p(a.amount_cents),
    installment: a.installment_cents == null ? null : c2p(a.installment_cents), date: a.issued_date, note: a.note,
    repaid: c2p(a.amount_cents - a.remaining_cents), remaining: c2p(a.remaining_cents), repayments: a.repayments
  });

  function listAdvances({ employeeId, open } = {}) {
    const where = [], params = [];
    if (employeeId) { where.push('a.employee_id = ?'); params.push(Number(employeeId)); }
    if (open) where.push(`(${REMAINING}) > 0`);
    const rows = q(`SELECT a.*, e.name AS employee_name, (${REMAINING}) AS remaining_cents,
        (SELECT COUNT(*) FROM hr_advance_repayments r WHERE r.advance_id = a.id) AS repayments
      FROM hr_advances a JOIN employees e ON e.id = a.employee_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.issued_date DESC, a.id DESC LIMIT 300`).all(...params);
    return { items: rows.map(advOut) };
  }

  const getAdvanceRow = id => {
    const a = q(`SELECT a.*, e.name AS employee_name, (${REMAINING}) AS remaining_cents,
        (SELECT COUNT(*) FROM hr_advance_repayments r WHERE r.advance_id = a.id) AS repayments
      FROM hr_advances a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?`).get(id);
    if (!a) throw U.httpError(404, 'not_found', 'السلفة غير موجودة.');
    return a;
  };

  function createAdvance(actor, input) {
    const e = activeEmployeeRow(U.int(input.employeeId, { field: 'الموظف', min: 1, required: true }));
    const amount = U.money(input.amount, { field: 'مبلغ السلفة', required: true, min: 0, max: 1_000_000 });
    if (!(amount > 0)) throw U.invalid('أدخل مبلغًا أكبر من صفر.', 'amount');
    let installment = null;
    if (input.installment !== undefined && input.installment !== null && input.installment !== '') {
      installment = U.money(input.installment, { field: 'القسط الشهري', min: 0, max: 1_000_000 });
      if (!(installment > 0)) installment = null;
      else if (installment > amount) throw U.invalid('القسط أكبر من مبلغ السلفة.', 'installment');
    }
    const date = dateOk(input.date || U.todayStr(), 'التاريخ');
    const note = U.str(input.note, { field: 'ملاحظة', max: 200 });
    const s = getSettings();
    const limit = advanceLimitOf(e, s), out = outstandingOf(e.id);
    if (out + amount > limit) {
      const avail = Math.max(0, limit - out);
      throw U.httpError(422, 'advance_limit', `السلفة تتجاوز حد السلف للموظف. الحد ${c2p(limit)} ج.م، المستحق عليه ${c2p(out)} ج.م، المتاح ${c2p(avail)} ج.م.`, { limit: c2p(limit), outstanding: c2p(out), available: c2p(avail) });
    }
    const r = q('INSERT INTO hr_advances (employee_id,amount_cents,installment_cents,issued_date,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(e.id, amount, installment, date, note, actor.id, U.nowIso());
    const id = Number(r.lastInsertRowid);
    audit(actor, 'hr.advance_create', 'advance', id, { employee: e.name, amount: c2p(amount), installment: installment ? c2p(installment) : null, date });
    return advOut(getAdvanceRow(id));
  }

  function repayAdvance(actor, id, input) {
    const a = getAdvanceRow(id);
    const amount = U.money(input.amount, { field: 'المبلغ', required: true, min: 0, max: 1_000_000 });
    if (!(amount > 0)) throw U.invalid('أدخل مبلغًا أكبر من صفر.', 'amount');
    if (amount > a.remaining_cents) throw U.invalid(`المبلغ أكبر من المتبقي من السلفة (${c2p(a.remaining_cents)} ج.م).`, 'amount');
    q('INSERT INTO hr_advance_repayments (advance_id,amount_cents,paid_date,payroll_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, amount, U.todayStr(), null, U.str(input.note, { field: 'ملاحظة', max: 200 }), actor.id, U.nowIso());
    audit(actor, 'hr.advance_repay', 'advance', id, { employee: a.employee_name, amount: c2p(amount) });
    return advOut(getAdvanceRow(id));
  }

  function deleteAdvance(actor, id) {
    const a = getAdvanceRow(id);
    if (a.repayments > 0) throw U.httpError(409, 'has_repayments', 'عليها دفعات سداد، لا يمكن حذفها.');
    q('DELETE FROM hr_advances WHERE id = ?').run(id);
    audit(actor, 'hr.advance_delete', 'advance', id, { employee: a.employee_name, amount: c2p(a.amount_cents) });
    return { ok: true };
  }

  /* ---------------- المرتبات ---------------- */
  // يحسب مفردات مرتب شهر لموظف (بالقروش) مع خطة خصم أقساط السلف
  function computePayslip(e, period, s) {
    const { from, to } = monthRange(period);
    const att = q(`SELECT COALESCE(SUM(hours),0) h, COALESCE(SUM(MAX(0, hours - ?)),0) ot FROM hr_attendance
      WHERE employee_id = ? AND work_date BETWEEN ? AND ?`).get(e.daily_hours, e.id, from, to);
    const hours = Math.round(att.h * 100) / 100;
    let base, overtime = 0, overtimeHours = 0, unpaidDays = 0, unpaidCents = 0;
    if (e.pay_type === 'hourly') {
      base = round(hours * e.salary_cents);
    } else {
      base = e.salary_cents;
      overtimeHours = Math.round(att.ot * 100) / 100;
      const hourly = e.salary_cents / (s.workdaysPerMonth * e.daily_hours);
      overtime = round(overtimeHours * hourly * s.overtimeMultiplier);
      for (const l of q(`SELECT start_date, end_date FROM hr_leaves WHERE employee_id = ? AND leave_type = 'unpaid' AND start_date <= ? AND end_date >= ?`).all(e.id, to, from)) {
        unpaidDays += workingDays(maxDate(l.start_date, from), minDate(l.end_date, to), s.weeklyOffDay);
      }
      unpaidCents = Math.min(base, round(unpaidDays * e.salary_cents / s.workdaysPerMonth));
    }
    const adj = q(`SELECT kind, COALESCE(SUM(amount_cents),0) n FROM hr_adjustments WHERE employee_id = ? AND adj_date BETWEEN ? AND ? GROUP BY kind`).all(e.id, from, to);
    const bonus = adj.find(a => a.kind === 'bonus')?.n || 0;
    const deduction = adj.find(a => a.kind === 'deduction')?.n || 0;

    let available = Math.max(0, base + overtime + bonus - deduction - unpaidCents);
    const plan = [];
    const advs = q(`SELECT a.id, a.installment_cents, (${REMAINING}) AS remaining FROM hr_advances a
      WHERE a.employee_id = ? AND a.installment_cents IS NOT NULL AND a.issued_date <= ? ORDER BY a.issued_date, a.id`).all(e.id, to);
    for (const a of advs) {
      if (a.remaining <= 0 || available <= 0) continue;
      const part = Math.min(a.installment_cents, a.remaining, available);
      plan.push({ advanceId: a.id, amount: part });
      available -= part;
    }
    const advance = plan.reduce((t, p) => t + p.amount, 0);
    const raw = base + overtime + bonus - deduction - unpaidCents - advance;
    return { hours, overtimeHours, unpaidDays, base, overtime, bonus, deduction, unpaidCents, advance, net: Math.max(0, raw), negative: raw < 0, plan };
  }

  const slipOut = (e, p, extra = {}) => ({
    employeeId: e.id, name: e.name, jobTitle: e.job_title, payType: e.pay_type,
    hours: p.hours, overtimeHours: p.overtimeHours, unpaidDays: p.unpaidDays,
    base: c2p(p.base), overtime: c2p(p.overtime), bonus: c2p(p.bonus), deduction: c2p(p.deduction),
    unpaidLeave: c2p(p.unpaidCents), advance: c2p(p.advance), net: c2p(p.net), negative: !!p.negative, ...extra
  });

  function getPayroll(period) {
    monthOk(period);
    const s = getSettings();
    const { to } = monthRange(period);
    const paid = new Map(q('SELECT * FROM hr_payroll WHERE period = ?').all(period).map(r => [r.employee_id, r]));
    const emps = q(`SELECT * FROM employees WHERE (active = 1 AND (hire_date IS NULL OR hire_date <= ?)) OR id IN (SELECT employee_id FROM hr_payroll WHERE period = ?) ORDER BY name`).all(to, period);
    const items = emps.map(e => {
      const r = paid.get(e.id);
      if (r) {
        return slipOut(e, {
          hours: r.hours, overtimeHours: r.overtime_hours, unpaidDays: r.unpaid_days, base: r.base_cents, overtime: r.overtime_cents,
          bonus: r.bonus_cents, deduction: r.deduction_cents, unpaidCents: r.unpaid_leave_cents, advance: r.advance_cents, net: r.net_cents, negative: false
        }, { status: 'paid', payrollId: r.id, paidDate: r.paid_date });
      }
      return slipOut(e, computePayslip(e, period, s), { status: 'pending', payrollId: null, paidDate: null });
    });
    const sum = k => round(items.reduce((t, i) => t + i[k], 0) * 100) / 100;
    return {
      month: period, items,
      totals: { net: sum('net'), base: sum('base'), overtime: sum('overtime'), bonus: sum('bonus'), deduction: sum('deduction'), unpaidLeave: sum('unpaidLeave'), advance: sum('advance'),
        paidCount: items.filter(i => i.status === 'paid').length, pendingCount: items.filter(i => i.status === 'pending').length,
        pendingNet: round(items.filter(i => i.status === 'pending').reduce((t, i) => t + i.net, 0) * 100) / 100 }
    };
  }

  function approvePayroll(actor, input) {
    const period = monthOk(input.month);
    if (period > U.todayStr().slice(0, 7)) throw U.invalid('لا يمكن اعتماد مرتب شهر لم يبدأ بعد.', 'month');
    const s = getSettings();
    const { to } = monthRange(period);
    const only = Array.isArray(input.employeeIds) ? new Set(input.employeeIds.map(Number)) : null;
    const emps = q(`SELECT * FROM employees WHERE active = 1 AND (hire_date IS NULL OR hire_date <= ?)
      AND id NOT IN (SELECT employee_id FROM hr_payroll WHERE period = ?) ORDER BY name`).all(to, period).filter(e => !only || only.has(e.id));
    if (!emps.length) throw U.httpError(409, 'nothing_to_approve', 'لا يوجد موظفون بانتظار الاعتماد في هذا الشهر.');
    const today = U.todayStr(), now = U.nowIso();
    let total = 0;
    tx(db, () => {
      const ins = q(`INSERT INTO hr_payroll (employee_id,period,pay_type,hours,overtime_hours,unpaid_days,base_cents,overtime_cents,bonus_cents,deduction_cents,
        unpaid_leave_cents,advance_cents,net_cents,paid_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const rep = q('INSERT INTO hr_advance_repayments (advance_id,amount_cents,paid_date,payroll_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)');
      for (const e of emps) {
        const p = computePayslip(e, period, s);
        const r = ins.run(e.id, period, e.pay_type, p.hours, p.overtimeHours, p.unpaidDays, p.base, p.overtime, p.bonus, p.deduction, p.unpaidCents, p.advance, p.net, today, actor.id, now);
        for (const step of p.plan) rep.run(step.advanceId, step.amount, today, Number(r.lastInsertRowid), `قسط مرتب ${period}`, actor.id, now);
        total += p.net;
      }
      audit(actor, 'hr.payroll_approve', 'payroll', period, { employees: emps.length, net: c2p(total) });
    });
    return getPayroll(period);
  }

  function deletePayroll(actor, id) {
    const r = q('SELECT p.*, e.name AS employee_name FROM hr_payroll p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?').get(id);
    if (!r) throw U.httpError(404, 'not_found', 'كشف المرتب غير موجود.');
    tx(db, () => {
      q('DELETE FROM hr_advance_repayments WHERE payroll_id = ?').run(id);   // يرجّع أقساط السلف المخصومة
      q('DELETE FROM hr_payroll WHERE id = ?').run(id);
      audit(actor, 'hr.payroll_delete', 'payroll', id, { employee: r.employee_name, period: r.period, net: c2p(r.net_cents) });
    });
    return getPayroll(r.period);
  }

  /* ---------------- ملخص ---------------- */
  function getSummary() {
    const s = getSettings();
    const today = U.todayStr(), month = today.slice(0, 7);
    const emps = q('SELECT * FROM employees WHERE active = 1').all();
    const monthlyBill = emps.reduce((t, e) => t + monthlyEquivalent(e, s), 0);
    return {
      activeEmployees: emps.length,
      monthlyBill: c2p(monthlyBill),
      advancesOutstanding: c2p(q(`SELECT COALESCE(SUM(${REMAINING}), 0) n FROM hr_advances a`).get().n),
      onLeaveToday: q('SELECT COUNT(DISTINCT employee_id) n FROM hr_leaves WHERE start_date <= ? AND end_date >= ?').get(today, today).n,
      paidThisMonth: c2p(q('SELECT COALESCE(SUM(net_cents),0) n FROM hr_payroll WHERE period = ?').get(month).n),
      month
    };
  }

  return {
    hrGetSettings: getSettings, hrUpdateSettings: updateSettings, hrSummary: getSummary,
    hrListEmployees: listEmployees, hrCreateEmployee: createEmployee, hrUpdateEmployee: updateEmployee,
    hrGetAttendanceDay: getAttendanceDay, hrSaveAttendanceDay: saveAttendanceDay, hrListAttendanceMonth: listAttendanceMonth,
    hrListLeaves: listLeaves, hrCreateLeave: createLeave, hrDeleteLeave: deleteLeave,
    hrListAdjustments: listAdjustments, hrCreateAdjustment: createAdjustment, hrDeleteAdjustment: deleteAdjustment,
    hrListAdvances: listAdvances, hrCreateAdvance: createAdvance, hrRepayAdvance: repayAdvance, hrDeleteAdvance: deleteAdvance,
    hrGetPayroll: getPayroll, hrApprovePayroll: approvePayroll, hrDeletePayroll: deletePayroll
  };
}

module.exports = { createHr, LEAVE_TYPES };
