-- =====================================================================
-- 4Seasons — المخطط الأساسي لقاعدة البيانات (الإصدار 1)
-- كل المبالغ تُخزَّن بالقروش (INTEGER) لتفادي أخطاء الكسور العشرية.
-- كل التواريخ/الأوقات بصيغة ISO-8601 بتوقيت UTC، وأعمدة *_date بتاريخ المغسلة المحلي (YYYY-MM-DD).
-- =====================================================================

-- ---------- المستخدمون والجلسات ----------
CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name                 TEXT    NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('manager','cashier','accountant')),
  password_hash        TEXT    NOT NULL,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  failed_logins        INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT    NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_exp  ON sessions(expires_at);

-- ---------- كتالوج الخدمات والأسعار ----------
CREATE TABLE categories (
  id            INTEGER PRIMARY KEY,
  code          TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  icon          TEXT    NOT NULL DEFAULT 'fa-shirt',
  visual        TEXT,                              -- صورة الكولاج في الموقع: clothes | carpets | bedding | curtains
  note          TEXT,
  note_icon     TEXT,
  note_whatsapp INTEGER NOT NULL DEFAULT 0 CHECK (note_whatsapp IN (0,1)),
  sort_order    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE services (
  id              INTEGER PRIMARY KEY,
  category_id     INTEGER NOT NULL REFERENCES categories(id),
  subgroup        TEXT,
  name            TEXT    NOT NULL,
  unit            TEXT    NOT NULL CHECK (unit IN ('piece','meter','m2','service')),
  pricing         TEXT    NOT NULL CHECK (pricing IN ('fixed','range','quote')),
  price_min_cents INTEGER,
  price_max_cents INTEGER,
  public_text     TEXT,                            -- نص يظهر بدل السعر في الموقع (مثال: حسب الاتفاق)
  show_public     INTEGER NOT NULL DEFAULT 1 CHECK (show_public IN (0,1)),
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  CHECK (pricing = 'quote' OR (price_min_cents IS NOT NULL AND price_max_cents IS NOT NULL
         AND price_min_cents >= 0 AND price_max_cents >= price_min_cents))
);
CREATE INDEX idx_services_category ON services(category_id, sort_order);

CREATE TABLE service_price_history (
  id            INTEGER PRIMARY KEY,
  service_id    INTEGER NOT NULL REFERENCES services(id),
  old_min_cents INTEGER,
  old_max_cents INTEGER,
  new_min_cents INTEGER,
  new_max_cents INTEGER,
  changed_by    INTEGER REFERENCES users(id),
  changed_at    TEXT NOT NULL
);
CREATE INDEX idx_price_history_service ON service_price_history(service_id, changed_at);

CREATE TABLE zones (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  fee_cents  INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ---------- العملاء ----------
CREATE TABLE customers (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT    NOT NULL UNIQUE,             -- 4S-C-000001
  name                  TEXT    NOT NULL,
  phone                 TEXT    NOT NULL UNIQUE,
  address               TEXT,
  zone_id               INTEGER REFERENCES zones(id),
  notes                 TEXT,
  opening_balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_balance_cents >= 0),
  source                TEXT    NOT NULL DEFAULT 'cashier' CHECK (source IN ('cashier','website','import')),
  search_text           TEXT    NOT NULL,                    -- الاسم + الهاتف + الكود بعد التطبيع (للبحث)
  created_by            INTEGER REFERENCES users(id),
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);
CREATE INDEX idx_customers_name    ON customers(name);
CREATE INDEX idx_customers_zone    ON customers(zone_id);
CREATE INDEX idx_customers_created ON customers(created_at);

-- ---------- طلبات المغسلة ----------
CREATE TABLE orders (
  id                 INTEGER PRIMARY KEY,
  code               TEXT    NOT NULL UNIQUE,                -- 4S-1001
  customer_id        INTEGER NOT NULL REFERENCES customers(id),
  zone_id            INTEGER REFERENCES zones(id),
  status             TEXT    NOT NULL CHECK (status IN ('pending_pricing','in_progress','ready','delivered','cancelled')),
  items_summary      TEXT    NOT NULL DEFAULT '',
  subtotal_cents     INTEGER NOT NULL DEFAULT 0,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL DEFAULT 0,
  paid_cents         INTEGER NOT NULL DEFAULT 0,
  payment_method     TEXT    NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','vodafone_cash','instapay','deferred')),
  delivery_date      TEXT,
  note               TEXT,
  web_request_id     INTEGER,
  created_by         INTEGER REFERENCES users(id),
  created_date       TEXT    NOT NULL,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL,
  delivered_at       TEXT,
  CHECK (total_cents >= 0 AND paid_cents >= 0 AND paid_cents <= total_cents)
);
CREATE INDEX idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX idx_orders_status   ON orders(status, delivery_date);
CREATE INDEX idx_orders_created  ON orders(created_date);
CREATE INDEX idx_orders_delivery ON orders(delivery_date);
CREATE INDEX idx_orders_open     ON orders(customer_id) WHERE total_cents > paid_cents;

CREATE TABLE order_lines (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL DEFAULT 0,
  kind             TEXT    NOT NULL CHECK (kind IN ('service','fee')),
  service_id       INTEGER REFERENCES services(id),
  name             TEXT    NOT NULL,                         -- نسخة من اسم الخدمة وقت الطلب
  unit             TEXT    NOT NULL,
  qty              REAL    NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER,                                  -- سعر الوحدة وقت الطلب (NULL = لم يُسعَّر بعد)
  area             REAL,                                     -- المساحة بالمتر المربع بعد القياس
  line_total_cents INTEGER,                                  -- NULL = بانتظار القياس/التسعير
  needs            TEXT CHECK (needs IN ('area','price')),
  note             TEXT
);
CREATE INDEX idx_order_lines_order   ON order_lines(order_id, position);
CREATE INDEX idx_order_lines_service ON order_lines(service_id);

CREATE TABLE order_events (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id, created_at);

-- ---------- المدفوعات ----------
CREATE TABLE payments (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  order_id     INTEGER REFERENCES orders(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method       TEXT    NOT NULL CHECK (method IN ('cash','vodafone_cash','instapay')),
  kind         TEXT    NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','opening')),
  note         TEXT,
  created_by   INTEGER REFERENCES users(id),
  paid_date    TEXT    NOT NULL,
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_payments_customer ON payments(customer_id, created_at);
CREATE INDEX idx_payments_order    ON payments(order_id);
CREATE INDEX idx_payments_date     ON payments(paid_date, method);

-- ---------- طلبات الاستلام القادمة من الموقع ----------
CREATE TABLE web_requests (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  address     TEXT NOT NULL,
  service_type TEXT NOT NULL,
  pref_time   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','converted','cancelled')),
  customer_id INTEGER REFERENCES customers(id),
  note        TEXT,
  handled_by  INTEGER REFERENCES users(id),
  handled_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_web_requests_status ON web_requests(status, created_at);
CREATE INDEX idx_web_requests_phone  ON web_requests(phone, created_at);

-- ---------- التدقيق والإعدادات والعدّادات ----------
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  username   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_entity  ON audit_log(entity, entity_id);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
