-- عميل سابق: رموز تحقق مؤقتة (OTP) + تمييز طلبات الموقع الصادرة من عملاء سابقين

-- رمز التحقق صالح لدقائق قليلة فقط، ويُحذف تلقائيًا بعد انتهائه (انظر bootstrap.js).
CREATE TABLE customer_otps (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  otp          TEXT    NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,        -- محاولات إدخال خاطئة
  expires_at   TEXT    NOT NULL,
  used_at      TEXT,                              -- استُخدم أو حلّ محلّه رمز أحدث
  delivered_at TEXT,                              -- أُرسل للعميل (يدويًا من الكاشير أو عبر الـ webhook)
  delivered_by INTEGER REFERENCES users(id),
  ip           TEXT,
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_otps_customer ON customer_otps(customer_id, created_at);
CREATE INDEX idx_otps_expires  ON customer_otps(expires_at);

-- طلب الموقع من عميل سابق (تم التحقق من هويته) — يظهر للكاشير بعلامة «عميل سابق»
ALTER TABLE web_requests ADD COLUMN is_returning INTEGER NOT NULL DEFAULT 0 CHECK (is_returning IN (0,1));
CREATE INDEX idx_web_requests_customer ON web_requests(customer_id, status);
