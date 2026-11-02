-- الموظفون والمرتبات (للمدير فقط). كل المبالغ بالقروش، والتواريخ YYYY-MM-DD بتوقيت المغسلة.
-- إعدادات الموارد البشرية منفصلة عن جدول settings لأن الأخير يُرسل لكل المستخدمين وللموقع العام.
CREATE TABLE hr_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO hr_settings (key, value) VALUES
  ('workdays_per_month',   '26'),   -- أيام العمل في الشهر (لحساب أجر اليوم والساعة)
  ('default_daily_hours',  '8'),    -- ساعات العمل اليومية الافتراضية للموظف الجديد
  ('overtime_multiplier',  '1.5'),  -- معامل أجر الساعة الإضافية
  ('advance_limit_percent','50'),   -- حد السلف الافتراضي كنسبة من المرتب الشهري
  ('annual_leave_days',    '21'),   -- رصيد الإجازة السنوية الافتراضي
  ('weekly_off_day',       '5');    -- الإجازة الأسبوعية (0=الأحد ... 5=الجمعة ... 6=السبت)

CREATE TABLE employees (
  id                  INTEGER PRIMARY KEY,
  name                TEXT    NOT NULL,
  phone               TEXT,
  job_title           TEXT,
  pay_type            TEXT    NOT NULL DEFAULT 'monthly' CHECK (pay_type IN ('monthly','hourly')),
  salary_cents        INTEGER NOT NULL DEFAULT 0 CHECK (salary_cents >= 0),   -- مرتب شهري أو أجر الساعة حسب pay_type
  daily_hours         REAL    NOT NULL DEFAULT 8 CHECK (daily_hours > 0 AND daily_hours <= 24),
  advance_limit_cents INTEGER CHECK (advance_limit_cents IS NULL OR advance_limit_cents >= 0),  -- NULL = الحد الافتراضي
  annual_leave_days   INTEGER CHECK (annual_leave_days IS NULL OR annual_leave_days >= 0),      -- NULL = الرصيد الافتراضي
  hire_date           TEXT,
  notes               TEXT,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);

-- ساعات العمل الفعلية يوميًا
CREATE TABLE hr_attendance (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date   TEXT    NOT NULL,
  hours       REAL    NOT NULL CHECK (hours >= 0 AND hours <= 24),
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT    NOT NULL,
  UNIQUE (employee_id, work_date)
);
CREATE INDEX idx_hr_attendance_date ON hr_attendance(work_date);

CREATE TABLE hr_leaves (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type  TEXT    NOT NULL CHECK (leave_type IN ('annual','sick','unpaid','other_paid')),
  start_date  TEXT    NOT NULL,
  end_date    TEXT    NOT NULL,
  days        INTEGER NOT NULL CHECK (days > 0),   -- أيام العمل فقط (بدون الإجازة الأسبوعية)
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT    NOT NULL,
  CHECK (end_date >= start_date)
);
CREATE INDEX idx_hr_leaves_emp ON hr_leaves(employee_id, start_date);

-- خصومات ومكافآت يدوية
CREATE TABLE hr_adjustments (
  id           INTEGER PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL CHECK (kind IN ('deduction','bonus')),
  adj_date     TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason       TEXT    NOT NULL,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_hr_adj_emp ON hr_adjustments(employee_id, adj_date);

-- كشف المرتبات المعتمد (نسخة ثابتة وقت الاعتماد)
CREATE TABLE hr_payroll (
  id                 INTEGER PRIMARY KEY,
  employee_id        INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period             TEXT    NOT NULL,           -- YYYY-MM
  pay_type           TEXT    NOT NULL,
  hours              REAL    NOT NULL DEFAULT 0,
  overtime_hours     REAL    NOT NULL DEFAULT 0,
  unpaid_days        INTEGER NOT NULL DEFAULT 0,
  base_cents         INTEGER NOT NULL DEFAULT 0,
  overtime_cents     INTEGER NOT NULL DEFAULT 0,
  bonus_cents        INTEGER NOT NULL DEFAULT 0,
  deduction_cents    INTEGER NOT NULL DEFAULT 0,
  unpaid_leave_cents INTEGER NOT NULL DEFAULT 0,
  advance_cents      INTEGER NOT NULL DEFAULT 0,
  net_cents          INTEGER NOT NULL DEFAULT 0 CHECK (net_cents >= 0),
  paid_date          TEXT    NOT NULL,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT    NOT NULL,
  UNIQUE (employee_id, period)
);

CREATE TABLE hr_advances (
  id                INTEGER PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  installment_cents INTEGER CHECK (installment_cents IS NULL OR installment_cents > 0),  -- قسط شهري يُخصم تلقائيًا من المرتب
  issued_date       TEXT    NOT NULL,
  note              TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL
);
CREATE INDEX idx_hr_adv_emp ON hr_advances(employee_id, issued_date);

CREATE TABLE hr_advance_repayments (
  id           INTEGER PRIMARY KEY,
  advance_id   INTEGER NOT NULL REFERENCES hr_advances(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  paid_date    TEXT    NOT NULL,
  payroll_id   INTEGER REFERENCES hr_payroll(id) ON DELETE CASCADE,   -- NULL = سداد يدوي
  note         TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_hr_rep_adv ON hr_advance_repayments(advance_id);
CREATE INDEX idx_hr_rep_payroll ON hr_advance_repayments(payroll_id);
