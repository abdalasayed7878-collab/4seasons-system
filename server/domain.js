'use strict';
/* =====================================================================
   منطق العمل (الطبقة اللي بتتعامل مع قاعدة البيانات).
   الـ routes بتستدعي الدوال دي فقط، وكل مبلغ بيتحسب هنا على السيرفر
   (العميل لا يستطيع التلاعب بالأسعار أو الإجماليات).
   ===================================================================== */
const crypto = require('node:crypto');
const { tx } = require('./db');
const U = require('./util');
const A = require('./auth');

const PREF_TIMES = ['12 مساءً - 2 مساءً', '3 مساءً - 6 مساءً', '7 مساءً - 10 مساءً'];
const WEB_SERVICE_TYPES = {
  clothes: 'تنظيف الملابس', carpet: 'تنظيف السجاد', blankets: 'تنظيف البطانيات',
  mattresses: 'المراتب والمخدات', curtains: 'تنظيف الستائر', upholstery: 'تنظيف الانتريهات', all: 'الخدمات المتكاملة'
};
const PAYMENT_METHODS = ['cash', 'vodafone_cash', 'instapay'];
const ORDER_METHODS = [...PAYMENT_METHODS, 'deferred'];
const FEE_TYPES = ['إزالة بقع صعبة', 'خدمة ترزي', 'صبغة', 'طباعة تي شيرت', 'رسوم أخرى'];
const OPEN_STATUSES = ['pending_pricing', 'in_progress', 'ready'];
const SETTING_KEYS = ['business_name', 'business_tagline', 'branch', 'phone', 'whatsapp', 'maps_url', 'facebook_url',
  'hours_text', 'coverage_text', 'price_notice', 'delivery_notice', 'extras_notice', 'turnaround_days', 'response_hours'];

const arNum = new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 });
const c2p = U.fromCents;

function createDomain(db, config) {
  const q = sql => db.prepare(sql);

  /* ---------------- مساعدات عامة ---------------- */
  function audit(actor, action, entity, entityId, details) {
    q('INSERT INTO audit_log (user_id,username,action,entity,entity_id,details,ip,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(actor?.id ?? null, actor?.username ?? null, action, entity ?? null, entityId == null ? null : String(entityId),
        details ? JSON.stringify(details) : null, actor?.ip ?? null, U.nowIso());
  }

  function nextCounter(name, start) {
    q('INSERT INTO counters (name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name, start);
    return q('SELECT value FROM counters WHERE name = ?').get(name).value;
  }

  /* ---------------- الإعدادات ---------------- */
  function getSettings() {
    const out = {};
    for (const r of q('SELECT key,value FROM settings').all()) out[r.key] = r.value;
    return out;
  }

  function updateSettings(actor, input) {
    const changes = {};
    for (const k of SETTING_KEYS) {
      if (input[k] === undefined) continue;
      let v = U.str(input[k], { field: k, max: 400 }) ?? '';
      if (['phone', 'whatsapp'].includes(k)) {
        if (v && !U.normalizePhone(v)) throw U.invalid('رقم الهاتف غير صحيح.', k);
        v = v ? U.normalizePhone(v) : '';
      }
      if (['maps_url', 'facebook_url'].includes(k) && v && !/^https:\/\/[^\s]+$/i.test(v)) throw U.invalid('الرابط يجب أن يبدأ بـ https://', k);
      if (['turnaround_days', 'response_hours'].includes(k) && !/^\d{1,3}$/.test(v)) throw U.invalid('قيمة رقمية غير صحيحة.', k);
      changes[k] = v;
    }
    tx(db, () => {
      const up = q('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(changes)) up.run(k, v);
      audit(actor, 'settings.update', 'settings', null, changes);
    });
    return getSettings();
  }

  /* ---------------- الكتالوج: خدمات ومناطق ---------------- */
  const svcOut = s => ({
    id: s.id, categoryId: s.category_id, subgroup: s.subgroup, name: s.name, unit: s.unit, pricing: s.pricing,
    min: c2p(s.price_min_cents), max: c2p(s.price_max_cents), publicText: s.public_text,
    showPublic: !!s.show_public, active: !!s.active, sort: s.sort_order
  });
  const catOut = c => ({ id: c.id, code: c.code, name: c.name, icon: c.icon, visual: c.visual, note: c.note, noteIcon: c.note_icon, noteWhatsapp: !!c.note_whatsapp, sort: c.sort_order, active: !!c.active });
  const zoneOut = z => ({ id: z.id, name: z.name, fee: c2p(z.fee_cents), active: !!z.active, sort: z.sort_order });

  function getCatalog() {
    return {
      categories: q('SELECT * FROM categories ORDER BY sort_order, id').all().map(catOut),
      services: q('SELECT s.* FROM services s JOIN categories c ON c.id = s.category_id ORDER BY c.sort_order, s.sort_order, s.id').all().map(svcOut),
      zones: q('SELECT * FROM zones ORDER BY sort_order, id').all().map(zoneOut)
    };
  }

  function parseServiceInput(input, existing) {
    const name = U.str(input.name ?? existing?.name, { field: 'اسم الخدمة', min: 2, max: 120, required: true });
    const categoryId = U.int(input.categoryId ?? existing?.category_id, { field: 'التصنيف', min: 1, required: true });
    if (!q('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw U.invalid('التصنيف غير موجود.', 'categoryId');
    const unit = U.pick(input.unit ?? existing?.unit, ['piece', 'meter', 'm2', 'service'], 'الوحدة');
    const pricing = U.pick(input.pricing ?? existing?.pricing, ['fixed', 'range', 'quote'], 'نوع التسعير');
    if (unit === 'm2' && pricing === 'quote') throw U.invalid('السجاد بالمتر لا يكون «بعد المعاينة».', 'pricing');
    let min = null, max = null;
    if (pricing !== 'quote') {
      const rawMin = input.min !== undefined ? input.min : (existing ? c2p(existing.price_min_cents) : undefined);
      const rawMax = input.max !== undefined ? input.max : (existing ? c2p(existing.price_max_cents) : undefined);
      min = U.money(rawMin, { field: 'أقل سعر', required: true, max: 1_000_000 });
      max = pricing === 'fixed' ? min : U.money(rawMax, { field: 'أعلى سعر', required: true, max: 1_000_000 });
      if (max < min) throw U.invalid('أعلى سعر يجب ألا يقل عن أقل سعر.', 'max');
    }
    return {
      name, categoryId, unit, pricing, min, max,
      subgroup: U.str(input.subgroup !== undefined ? input.subgroup : existing?.subgroup, { field: 'المجموعة', max: 60 }),
      publicText: U.str(input.publicText !== undefined ? input.publicText : existing?.public_text, { field: 'نص السعر', max: 60 }),
      showPublic: input.showPublic !== undefined ? (input.showPublic ? 1 : 0) : (existing?.show_public ?? 1),
      active: input.active !== undefined ? (input.active ? 1 : 0) : (existing?.active ?? 1),
      sort: input.sort !== undefined ? U.int(input.sort, { field: 'الترتيب', min: 0, max: 100000 }) : null
    };
  }

  function createService(actor, input) {
    const s = parseServiceInput(input, null);
    const now = U.nowIso();
    return tx(db, () => {
      const sort = s.sort ?? ((q('SELECT COALESCE(MAX(sort_order),0) m FROM services WHERE category_id = ?').get(s.categoryId).m) + 10);
      const r = q(`INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,public_text,show_public,active,sort_order,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s.categoryId, s.subgroup, s.name, s.unit, s.pricing, s.min, s.max, s.publicText, s.showPublic, s.active, sort, now, now);
      audit(actor, 'service.create', 'service', r.lastInsertRowid, { name: s.name, min: c2p(s.min), max: c2p(s.max) });
      return svcOut(q('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid));
    });
  }

  function updateService(actor, id, input) {
    const existing = q('SELECT * FROM services WHERE id = ?').get(id);
    if (!existing) throw U.httpError(404, 'not_found', 'الخدمة غير موجودة.');
    const s = parseServiceInput(input, existing);
    return tx(db, () => {
      q(`UPDATE services SET category_id=?, subgroup=?, name=?, unit=?, pricing=?, price_min_cents=?, price_max_cents=?, public_text=?,
         show_public=?, active=?, sort_order=?, updated_at=? WHERE id=?`)
        .run(s.categoryId, s.subgroup, s.name, s.unit, s.pricing, s.min, s.max, s.publicText, s.showPublic, s.active, s.sort ?? existing.sort_order, U.nowIso(), id);
      if (existing.price_min_cents !== s.min || existing.price_max_cents !== s.max) {
        q('INSERT INTO service_price_history (service_id,old_min_cents,old_max_cents,new_min_cents,new_max_cents,changed_by,changed_at) VALUES (?,?,?,?,?,?,?)')
          .run(id, existing.price_min_cents, existing.price_max_cents, s.min, s.max, actor.id, U.nowIso());
      }
      audit(actor, 'service.update', 'service', id, { name: s.name, min: c2p(s.min), max: c2p(s.max), active: !!s.active });
      return svcOut(q('SELECT * FROM services WHERE id = ?').get(id));
    });
  }

  function createZone(actor, input) {
    const name = U.str(input.name, { field: 'اسم المنطقة', min: 2, max: 80, required: true });
    const fee = U.money(input.fee ?? 0, { field: 'الرسوم', max: 100000 });
    if (q('SELECT 1 FROM zones WHERE name = ?').get(name)) throw U.httpError(409, 'zone_exists', 'هذه المنطقة موجودة بالفعل.');
    return tx(db, () => {
      const sort = q('SELECT COALESCE(MAX(sort_order),0) m FROM zones').get().m + 10;
      const r = q('INSERT INTO zones (name,fee_cents,sort_order) VALUES (?,?,?)').run(name, fee, sort);
      audit(actor, 'zone.create', 'zone', r.lastInsertRowid, { name, fee: c2p(fee) });
      return zoneOut(q('SELECT * FROM zones WHERE id = ?').get(r.lastInsertRowid));
    });
  }

  function updateZone(actor, id, input) {
    const z = q('SELECT * FROM zones WHERE id = ?').get(id);
    if (!z) throw U.httpError(404, 'not_found', 'المنطقة غير موجودة.');
    const name = U.str(input.name ?? z.name, { field: 'اسم المنطقة', min: 2, max: 80, required: true });
    const fee = input.fee !== undefined ? U.money(input.fee, { field: 'الرسوم', max: 100000, required: true }) : z.fee_cents;
    const active = input.active !== undefined ? (input.active ? 1 : 0) : z.active;
    const dup = q('SELECT id FROM zones WHERE name = ? AND id != ?').get(name, id);
    if (dup) throw U.httpError(409, 'zone_exists', 'هذه المنطقة موجودة بالفعل.');
    q('UPDATE zones SET name=?, fee_cents=?, active=? WHERE id=?').run(name, fee, active, id);
    audit(actor, 'zone.update', 'zone', id, { name, fee: c2p(fee), active: !!active });
    return zoneOut(q('SELECT * FROM zones WHERE id = ?').get(id));
  }

  /* ---------------- العملاء ---------------- */
  const BAL = `(c.opening_balance_cents + COALESCE((SELECT SUM(o.total_cents - o.paid_cents) FROM orders o WHERE o.customer_id = c.id AND o.status != 'cancelled'), 0))`;
  const CUSTOMER_SELECT = `SELECT c.*, z.name AS zone_name, ${BAL} AS balance_cents
    FROM customers c LEFT JOIN zones z ON z.id = c.zone_id`;
  const customerOut = c => ({
    id: c.id, code: c.code, name: c.name, phone: c.phone, address: c.address, zoneId: c.zone_id, zone: c.zone_name ?? null,
    notes: c.notes, balance: c2p(c.balance_cents), opening: c2p(c.opening_balance_cents), source: c.source, createdAt: c.created_at
  });

  function tokenWhere(text, columns) {
    const tokens = U.norm(text).split(' ').filter(Boolean).slice(0, 5);
    const params = [];
    const sql = tokens.map(t => {
      const like = `%${U.escapeLike(t)}%`;
      params.push(...columns.map(() => like));
      return '(' + columns.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ') + ')';
    });
    return { sql, params };
  }

  function listCustomers({ q: text, page = 1, pageSize = 25, debtors = false }) {
    pageSize = Math.min(Math.max(+pageSize || 25, 1), 100);
    page = Math.max(+page || 1, 1);
    const where = [], params = [];
    const t = tokenWhere(text || '', ['c.search_text']);
    where.push(...t.sql); params.push(...t.params);
    if (debtors) where.push(`${BAL} > 0`);
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = q(`SELECT COUNT(*) n FROM customers c ${w}`).get(...params).n;
    const rows = q(`${CUSTOMER_SELECT} ${w} ORDER BY c.created_at DESC, c.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows.map(customerOut), total, page, pageSize };
  }

  function getCustomer(id) {
    const r = q(`${CUSTOMER_SELECT} WHERE c.id = ?`).get(id);
    if (!r) throw U.httpError(404, 'not_found', 'العميل غير موجود.');
    return customerOut(r);
  }

  function findCustomerExact(term) {
    const t = U.toLatinDigits(term).trim();
    if (!t) return null;
    const phone = U.normalizePhone(t);
    const r = q(`${CUSTOMER_SELECT} WHERE UPPER(c.code) = UPPER(?) OR c.phone = ? LIMIT 1`).get(t, phone || t);
    return r ? customerOut(r) : null;
  }

  function parseCustomerInput(input, existing) {
    const name = U.str(input.name ?? existing?.name, { field: 'الاسم', min: 2, max: 100, required: true });
    const phone = U.normalizePhone(input.phone ?? existing?.phone);
    if (!phone) throw U.invalid('رقم الهاتف غير صحيح. مثال: 01012345678', 'phone');
    const address = U.str(input.address !== undefined ? input.address : existing?.address, { field: 'العنوان', max: 300 });
    const notes = U.str(input.notes !== undefined ? input.notes : existing?.notes, { field: 'ملاحظات', max: 500 });
    let zoneId = input.zoneId !== undefined ? input.zoneId : existing?.zone_id;
    zoneId = zoneId ? U.int(zoneId, { field: 'المنطقة', min: 1 }) : null;
    if (zoneId && !q('SELECT 1 FROM zones WHERE id = ?').get(zoneId)) throw U.invalid('المنطقة غير موجودة.', 'zoneId');
    return { name, phone, address, notes, zoneId };
  }

  const searchText = (name, phone, code) => U.norm(`${name} ${phone} ${code}`);

  function createCustomerTx(actor, input, source = 'cashier') {
    const c = parseCustomerInput(input, null);
    const dup = q('SELECT id, code, name FROM customers WHERE phone = ?').get(c.phone);
    if (dup) throw U.httpError(409, 'phone_exists', `هذا الهاتف مسجل بالفعل للعميل: ${dup.name}`, { customer: getCustomer(dup.id) });
    const n = nextCounter('customer_seq', 1);
    const code = '4S-C-' + U.pad(n, 6);
    const now = U.nowIso();
    const r = q(`INSERT INTO customers (code,name,phone,address,zone_id,notes,source,search_text,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(code, c.name, c.phone, c.address, c.zoneId, c.notes, source, searchText(c.name, c.phone, code), actor?.id ?? null, now, now);
    audit(actor, 'customer.create', 'customer', r.lastInsertRowid, { code, name: c.name, source });
    return Number(r.lastInsertRowid);
  }

  const createCustomer = (actor, input, source) => getCustomer(tx(db, () => createCustomerTx(actor, input, source)));

  function updateCustomer(actor, id, input) {
    const existing = q('SELECT * FROM customers WHERE id = ?').get(id);
    if (!existing) throw U.httpError(404, 'not_found', 'العميل غير موجود.');
    const c = parseCustomerInput(input, existing);
    const dup = q('SELECT id FROM customers WHERE phone = ? AND id != ?').get(c.phone, id);
    if (dup) throw U.httpError(409, 'phone_exists', 'هذا الهاتف مسجل لعميل آخر.');
    q('UPDATE customers SET name=?, phone=?, address=?, zone_id=?, notes=?, search_text=?, updated_at=? WHERE id=?')
      .run(c.name, c.phone, c.address, c.zoneId, c.notes, searchText(c.name, c.phone, existing.code), U.nowIso(), id);
    audit(actor, 'customer.update', 'customer', id, { name: c.name });
    return getCustomer(id);
  }

  /* ---------------- الطلبات ---------------- */
  const qtyText = n => arNum.format(n);
  const lineLabel = l => `${l.kind === 'service' && l.qty > 1 ? qtyText(l.qty) + ' × ' : ''}${l.name}${l.area ? ` (${qtyText(l.area)} م²)` : ''}`;
  const summaryOf = lines => lines.map(lineLabel).join(' + ').slice(0, 500);

  const ORDER_SELECT = `SELECT o.*, c.code AS customer_code, c.name AS customer_name, c.phone AS customer_phone,
      c.address AS customer_address, z.name AS zone_name,
      CASE WHEN o.status = 'pending_pricing' THEN
        CASE WHEN EXISTS (SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.needs = 'area') THEN 'area' ELSE 'price' END
      END AS pending_kind
    FROM orders o JOIN customers c ON c.id = o.customer_id LEFT JOIN zones z ON z.id = o.zone_id`;

  const orderOut = o => ({
    id: o.id, code: o.code, customerId: o.customer_id, customerCode: o.customer_code, customer: o.customer_name,
    phone: o.customer_phone, zone: o.zone_name ?? null, items: o.items_summary, status: o.status, pending: o.pending_kind ?? null,
    subtotal: c2p(o.subtotal_cents), deliveryFee: c2p(o.delivery_fee_cents), total: c2p(o.total_cents), paid: c2p(o.paid_cents),
    remaining: c2p(o.total_cents - o.paid_cents), method: o.payment_method, delivery: o.delivery_date,
    late: OPEN_STATUSES.includes(o.status) && !!o.delivery_date && o.delivery_date < U.todayStr(),
    note: o.note, createdDate: o.created_date, createdAt: o.created_at, deliveredAt: o.delivered_at
  });

  const lineOut = l => ({
    id: l.id, kind: l.kind, serviceId: l.service_id, name: l.name, unit: l.unit, qty: l.qty,
    unitPrice: c2p(l.unit_price_cents), area: l.area, total: c2p(l.line_total_cents), needs: l.needs, note: l.note
  });

  function getOrder(idOrCode) {
    const isCode = typeof idOrCode === 'string' && !/^\d+$/.test(idOrCode);
    const o = q(`${ORDER_SELECT} WHERE ${isCode ? 'o.code' : 'o.id'} = ?`).get(isCode ? idOrCode.toUpperCase() : Number(idOrCode));
    if (!o) throw U.httpError(404, 'not_found', 'الطلب غير موجود.');
    const lines = q('SELECT * FROM order_lines WHERE order_id = ? ORDER BY position, id').all(o.id).map(lineOut);
    const payments = q('SELECT amount_cents, method, kind, created_at FROM payments WHERE order_id = ? ORDER BY id').all(o.id)
      .map(p => ({ amount: c2p(p.amount_cents), method: p.method, createdAt: p.created_at }));
    return { ...orderOut(o), customerAddress: o.customer_address, lines, payments };
  }

  const CODE_RE = /^4s-?(\d{3,9})$/i;
  function ordersWhere({ status, q: text, customerId }) {
    const where = [], params = [];
    let join = false;
    if (status === 'late') { where.push(`o.status IN ('pending_pricing','in_progress','ready') AND o.delivery_date < ?`); params.push(U.todayStr()); }
    else if (status) { where.push('o.status = ?'); params.push(status); }
    if (customerId) { where.push('o.customer_id = ?'); params.push(customerId); }
    const raw = U.toLatinDigits(text || '').trim();
    const m = raw.match(CODE_RE) || (/^\d{4,9}$/.test(raw) ? [null, raw] : null);
    if (m) { where.push('o.code = ?'); params.push('4S-' + m[1]); } // بحث مباشر برقم الطلب (سريع)
    else {
      const t = tokenWhere(raw, ['LOWER(o.code)', 'c.search_text', 'LOWER(o.items_summary)']);
      if (t.sql.length) { join = true; where.push(...t.sql); params.push(...t.params); }
    }
    return { w: where.length ? 'WHERE ' + where.join(' AND ') : '', params, join };
  }

  function listOrders({ status, q: text, customerId, page = 1, pageSize = 25 }) {
    pageSize = Math.min(Math.max(+pageSize || 25, 1), 100);
    page = Math.max(+page || 1, 1);
    const { w, params } = ordersWhere({ status, q: text, customerId });
    // العدّ بدون ربط العملاء ما دام لا يوجد بحث نصي (أسرع بكثير)
    const needJoin = /c\.search_text/.test(w);
    const total = q(`SELECT COUNT(*) n FROM orders o ${needJoin ? 'JOIN customers c ON c.id = o.customer_id' : ''} ${w}`).get(...params).n;
    const rows = q(`${ORDER_SELECT} ${w} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return { items: rows.map(orderOut), total, page, pageSize };
  }

  function orderCounts({ q: text }) {
    const { w, params } = ordersWhere({ q: text });
    const needJoin = /c\.search_text/.test(w);
    const open = `o.status IN ('pending_pricing','in_progress','ready')`;
    if (!w) { // الحالة الشائعة بلا بحث: تعتمد على الفهارس فقط
      const by = Object.fromEntries(q('SELECT status, COUNT(*) n FROM orders GROUP BY status').all().map(r => [r.status, r.n]));
      const late = q(`SELECT COUNT(*) n FROM orders o WHERE ${open} AND o.delivery_date < ?`).get(U.todayStr()).n;
      const all = Object.values(by).reduce((a, b) => a + b, 0);
      return { all, pending_pricing: by.pending_pricing || 0, in_progress: by.in_progress || 0, ready: by.ready || 0, delivered: by.delivered || 0, late };
    }
    const r = q(`SELECT COUNT(*) AS \`all\`,
        COALESCE(SUM(o.status = 'pending_pricing'),0) AS pending_pricing,
        COALESCE(SUM(o.status = 'in_progress'),0) AS in_progress,
        COALESCE(SUM(o.status = 'ready'),0) AS ready,
        COALESCE(SUM(o.status = 'delivered'),0) AS delivered,
        COALESCE(SUM(${open} AND o.delivery_date < ?),0) AS late
      FROM orders o ${needJoin ? 'JOIN customers c ON c.id = o.customer_id' : ''} ${w}`).get(U.todayStr(), ...params);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  }

  function createOrder(actor, input) {
    const customerId = U.int(input.customerId, { field: 'العميل', min: 1, required: true });
    const customer = q('SELECT id, name FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw U.invalid('العميل غير موجود.', 'customerId');

    // المنطقة والرسوم
    let zone = null;
    if (input.zoneId) {
      zone = q('SELECT * FROM zones WHERE id = ? AND active = 1').get(U.int(input.zoneId, { field: 'المنطقة', min: 1 }));
      if (!zone) throw U.invalid('المنطقة غير موجودة أو غير مفعّلة.', 'zoneId');
    }
    const deliveryFee = zone ? zone.fee_cents : 0;

    // التسليم
    const settings = getSettings();
    let deliveryDate = input.deliveryDate;
    if (deliveryDate == null || deliveryDate === '') deliveryDate = U.addDaysStr(Number(settings.turnaround_days) || 4);
    if (!U.isDateStr(deliveryDate)) throw U.invalid('موعد التسليم غير صحيح.', 'deliveryDate');
    if (deliveryDate < U.todayStr()) throw U.invalid('موعد التسليم لا يمكن أن يكون في الماضي.', 'deliveryDate');

    // البنود
    if (!Array.isArray(input.lines) || !input.lines.length) throw U.invalid('أضف قطعة أو خدمة واحدة على الأقل.', 'lines');
    if (input.lines.length > 60) throw U.invalid('عدد البنود كبير جدًا (الحد الأقصى 60).', 'lines');
    const lines = input.lines.map((raw, i) => {
      if (!raw || typeof raw !== 'object') throw U.invalid('بند غير صحيح.', 'lines');
      if (raw.fee) {
        const name = U.pick(raw.name, FEE_TYPES, 'نوع الرسوم');
        const amount = U.money(raw.amount, { field: 'قيمة الرسوم', required: true, max: 100000 });
        if (amount <= 0) throw U.invalid('قيمة الرسوم يجب أن تكون أكبر من صفر.', 'lines');
        return { kind: 'fee', serviceId: null, name, unit: 'fee', qty: 1, unitPrice: amount, total: amount, needs: null, note: U.str(raw.note, { field: 'ملاحظة الرسوم', max: 120 }), position: i };
      }
      const svc = q('SELECT * FROM services WHERE id = ? AND active = 1').get(U.int(raw.serviceId, { field: 'الخدمة', min: 1, required: true }));
      if (!svc) throw U.invalid('خدمة غير موجودة أو غير مفعّلة.', 'lines');
      const qty = Number(raw.qty);
      const step = svc.unit === 'meter' ? 0.5 : 1;
      if (!Number.isFinite(qty) || qty < step || qty > 9999 || Math.abs(qty / step - Math.round(qty / step)) > 1e-9) {
        throw U.invalid(`الكمية غير صحيحة للخدمة «${svc.name}».`, 'lines');
      }
      let unitPrice = null, total = null, needs = null;
      if (svc.pricing === 'quote') needs = 'price';
      else {
        unitPrice = svc.price_min_cents;
        if (svc.pricing === 'range' && raw.unitPrice != null && raw.unitPrice !== '') {
          unitPrice = U.money(raw.unitPrice, { field: 'السعر', required: true });
          if (unitPrice < svc.price_min_cents || unitPrice > svc.price_max_cents) {
            throw U.invalid(`سعر «${svc.name}» يجب أن يكون بين ${c2p(svc.price_min_cents)} و ${c2p(svc.price_max_cents)}.`, 'lines');
          }
        }
        if (svc.unit === 'm2') needs = 'area'; // يُحسب بعد القياس
        else total = Math.round(unitPrice * qty);
      }
      return { kind: 'service', serviceId: svc.id, name: svc.name, unit: svc.unit, qty, unitPrice, total, needs, note: null, position: i };
    });

    const subtotal = lines.reduce((s, l) => s + (l.total ?? 0), 0);
    const total = subtotal + deliveryFee;

    // الدفع
    const method = U.pick(input.paymentMethod ?? 'cash', ORDER_METHODS, 'طريقة الدفع');
    let paid = method === 'deferred' ? 0 : (input.paid == null || input.paid === '' ? total : U.money(input.paid, { field: 'المبلغ المدفوع', required: true }));
    if (paid > total) throw U.invalid('المبلغ المدفوع أكبر من إجمالي الطلب.', 'paid');
    const note = U.str(input.note, { field: 'الملاحظات', max: 500 });
    const status = lines.some(l => l.needs) ? 'pending_pricing' : 'in_progress';
    const now = U.nowIso();

    const id = tx(db, () => {
      const seq = nextCounter('order_seq', config.orderStart);
      const orderCode = '4S-' + seq;
      const r = q(`INSERT INTO orders (code,customer_id,zone_id,status,items_summary,subtotal_cents,delivery_fee_cents,total_cents,paid_cents,
          payment_method,delivery_date,note,web_request_id,created_by,created_date,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(orderCode, customerId, zone?.id ?? null, status, summaryOf(lines), subtotal, deliveryFee, total, paid, method, deliveryDate, note,
          input.webRequestId ? U.int(input.webRequestId, { field: 'طلب الموقع', min: 1 }) : null, actor.id, U.todayStr(), now, now);
      const orderId = Number(r.lastInsertRowid);
      const ins = q(`INSERT INTO order_lines (order_id,position,kind,service_id,name,unit,qty,unit_price_cents,line_total_cents,needs,note)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      for (const l of lines) ins.run(orderId, l.position, l.kind, l.serviceId, l.name, l.unit, l.qty, l.unitPrice, l.total, l.needs, l.note);
      if (paid > 0) {
        q(`INSERT INTO payments (customer_id,order_id,amount_cents,method,kind,created_by,paid_date,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(customerId, orderId, paid, method, 'payment', actor.id, U.todayStr(), now);
      }
      q('INSERT INTO order_events (order_id,from_status,to_status,user_id,created_at) VALUES (?,?,?,?,?)').run(orderId, null, status, actor.id, now);
      audit(actor, 'order.create', 'order', orderId, { code: orderCode, total: c2p(total), paid: c2p(paid), customerId });
      return orderId;
    });
    void 0;
    return getOrder(id);
  }

  // إدخال المساحات (للسجاد) أو الأسعار (للبنود بعد المعاينة)
  function applyPricing(actor, orderId, input) {
    const order = q('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw U.httpError(404, 'not_found', 'الطلب غير موجود.');
    if (order.status !== 'pending_pricing') throw U.httpError(409, 'bad_state', 'هذا الطلب لا ينتظر قياسًا أو تسعيرًا.');
    const pending = q('SELECT * FROM order_lines WHERE order_id = ? AND needs IS NOT NULL ORDER BY position, id').all(orderId);
    if (!Array.isArray(input.lines)) throw U.invalid('أدخل القياسات المطلوبة.', 'lines');
    const byId = new Map(input.lines.map(l => [Number(l?.id), l]));
    const updates = pending.map(line => {
      const given = byId.get(line.id);
      if (!given) throw U.invalid(`أدخل قيمة «${line.name}».`, 'lines');
      if (line.needs === 'area') {
        const area = Number(given.area);
        if (!Number.isFinite(area) || area <= 0 || area > 100000) throw U.invalid(`مساحة غير صحيحة لـ «${line.name}».`, 'lines');
        const areaR = Math.round(area * 100) / 100;
        return { id: line.id, area: areaR, unitPrice: line.unit_price_cents, total: Math.round(areaR * line.unit_price_cents) };
      }
      const price = U.money(given.price, { field: `سعر ${line.name}`, required: true, max: 1_000_000 });
      if (price <= 0) throw U.invalid(`أدخل سعرًا أكبر من صفر لـ «${line.name}».`, 'lines');
      return { id: line.id, area: null, unitPrice: price, total: Math.round(price * line.qty) };
    });
    const added = updates.reduce((s, u) => s + u.total, 0);
    tx(db, () => {
      const up = q('UPDATE order_lines SET area = ?, unit_price_cents = ?, line_total_cents = ?, needs = NULL WHERE id = ?');
      for (const u of updates) up.run(u.area, u.unitPrice, u.total, u.id);
      const all = q('SELECT * FROM order_lines WHERE order_id = ? ORDER BY position, id').all(orderId);
      const summary = summaryOf(all);
      q(`UPDATE orders SET status = 'in_progress', subtotal_cents = subtotal_cents + ?, total_cents = total_cents + ?, items_summary = ?, updated_at = ? WHERE id = ?`)
        .run(added, added, summary, U.nowIso(), orderId);
      q('INSERT INTO order_events (order_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?)')
        .run(orderId, 'pending_pricing', 'in_progress', actor.id, 'تم إدخال القياس/التسعير', U.nowIso());
      audit(actor, 'order.pricing', 'order', orderId, { added: c2p(added) });
    });
    return getOrder(orderId);
  }

  const TRANSITIONS = { in_progress: 'ready', ready: 'delivered' };
  function advanceOrder(actor, orderId, to) {
    const order = q('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw U.httpError(404, 'not_found', 'الطلب غير موجود.');
    if (TRANSITIONS[order.status] !== to) throw U.httpError(409, 'bad_transition', 'لا يمكن نقل الطلب لهذه الحالة من حالته الحالية.');
    const now = U.nowIso();
    tx(db, () => {
      q('UPDATE orders SET status = ?, updated_at = ?, delivered_at = ? WHERE id = ?').run(to, now, to === 'delivered' ? now : null, orderId);
      q('INSERT INTO order_events (order_id,from_status,to_status,user_id,created_at) VALUES (?,?,?,?,?)').run(orderId, order.status, to, actor.id, now);
      audit(actor, 'order.status', 'order', orderId, { from: order.status, to });
    });
    return getOrder(orderId);
  }

  /* ---------------- التحصيل ---------------- */
  // يُوزَّع المبلغ على الرصيد الافتتاحي ثم أقدم الطلبات غير المسددة
  function collectPayment(actor, customerId, input) {
    const c = q(`${CUSTOMER_SELECT} WHERE c.id = ?`).get(customerId);
    if (!c) throw U.httpError(404, 'not_found', 'العميل غير موجود.');
    const amount = U.money(input.amount, { field: 'المبلغ', required: true });
    const method = U.pick(input.method ?? 'cash', PAYMENT_METHODS, 'طريقة الدفع');
    if (!(amount > 0)) throw U.invalid('أدخل مبلغًا أكبر من صفر.', 'amount');
    if (amount > c.balance_cents) throw U.invalid(`المبلغ أكبر من الرصيد المستحق (${c2p(c.balance_cents)} ج.م).`, 'amount');
    const now = U.nowIso(), today = U.todayStr();
    tx(db, () => {
      let left = amount;
      const insPay = q('INSERT INTO payments (customer_id,order_id,amount_cents,method,kind,created_by,paid_date,created_at) VALUES (?,?,?,?,?,?,?,?)');
      if (c.opening_balance_cents > 0) {
        const part = Math.min(left, c.opening_balance_cents);
        q('UPDATE customers SET opening_balance_cents = opening_balance_cents - ?, updated_at = ? WHERE id = ?').run(part, now, customerId);
        insPay.run(customerId, null, part, method, 'opening', actor.id, today, now);
        left -= part;
      }
      if (left > 0) {
        const open = q(`SELECT id, total_cents, paid_cents FROM orders WHERE customer_id = ? AND status != 'cancelled' AND total_cents > paid_cents
          ORDER BY created_at, id`).all(customerId);
        for (const o of open) {
          if (left <= 0) break;
          const part = Math.min(left, o.total_cents - o.paid_cents);
          q('UPDATE orders SET paid_cents = paid_cents + ?, updated_at = ? WHERE id = ?').run(part, now, o.id);
          insPay.run(customerId, o.id, part, method, 'payment', actor.id, today, now);
          left -= part;
        }
      }
      audit(actor, 'payment.collect', 'customer', customerId, { amount: c2p(amount), method });
    });
    return getCustomer(customerId);
  }

  /* ---------------- لوحة المؤشرات ---------------- */
  let statsCache = { at: 0, value: null };
  function getStats() {
    if (statsCache.value && Date.now() - statsCache.at < 5000) return statsCache.value;
    const today = U.todayStr();
    const todayOrders = q(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) s FROM orders WHERE created_date = ? AND status != 'cancelled'`).get(today);
    const st = q(`SELECT status, COUNT(*) n FROM orders WHERE status IN ('pending_pricing','in_progress','ready') GROUP BY status`).all();
    const by = Object.fromEntries(st.map(r => [r.status, r.n]));
    const debt = q(`
      SELECT COALESCE(SUM(bal),0) AS total, COUNT(*) AS n FROM (
        SELECT c.id, c.opening_balance_cents + COALESCE(SUM(o.total_cents - o.paid_cents),0) AS bal
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'cancelled'
        WHERE c.opening_balance_cents > 0 OR EXISTS (SELECT 1 FROM orders x WHERE x.customer_id = c.id AND x.total_cents > x.paid_cents)
        GROUP BY c.id HAVING bal > 0)`).get();
    const dueToday = q(`SELECT COUNT(*) n FROM orders WHERE status IN ('pending_pricing','in_progress','ready') AND delivery_date = ?`).get(today).n;
    const late = q(`SELECT COUNT(*) n FROM orders WHERE status IN ('pending_pricing','in_progress','ready') AND delivery_date < ?`).get(today).n;
    const newRequests = q(`SELECT COUNT(*) n FROM web_requests WHERE status = 'new'`).get().n;
    const pendingOtps = q('SELECT COUNT(*) n FROM customer_otps WHERE used_at IS NULL AND delivered_at IS NULL AND expires_at > ?').get(U.nowIso()).n;
    const collectedToday = q(`SELECT COALESCE(SUM(amount_cents),0) s FROM payments WHERE paid_date = ?`).get(today).s;
    statsCache = {
      at: Date.now(),
      value: {
        today, salesToday: c2p(todayOrders.s), ordersToday: todayOrders.n, collectedToday: c2p(collectedToday),
        pendingPricing: by.pending_pricing || 0, inProgress: by.in_progress || 0, ready: by.ready || 0,
        active: (by.pending_pricing || 0) + (by.in_progress || 0) + (by.ready || 0),
        dueTotal: c2p(debt.total), debtors: debt.n, deliveriesToday: dueToday, late, newRequests, pendingOtps
      }
    };
    return statsCache.value;
  }
  const invalidateStats = () => { statsCache.at = 0; };

  /* ---------------- طلبات الموقع ---------------- */
  const REQ_SELECT = `SELECT w.*, c.code AS customer_code FROM web_requests w LEFT JOIN customers c ON c.id = w.customer_id`;
  const reqOut = r => ({
    id: r.id, name: r.name, phone: r.phone, address: r.address, serviceType: r.service_type,
    serviceLabel: WEB_SERVICE_TYPES[r.service_type] || r.service_type, prefTime: r.pref_time, status: r.status,
    returning: !!r.is_returning, customerId: r.customer_id, customerCode: r.customer_code ?? null,
    note: r.note, createdAt: r.created_at, handledAt: r.handled_at
  });
  const getWebRequest = id => {
    const r = q(`${REQ_SELECT} WHERE w.id = ?`).get(id);
    if (!r) throw U.httpError(404, 'not_found', 'الطلب غير موجود.');
    return r;
  };

  // input.customerType === 'returning' → عميل سابق تم التحقق منه (input.token) ويُستخدم ما هو مسجل لدينا من بياناته
  function createWebRequest(input, { ip } = {}) {
    const returning = input.customerType === 'returning';
    if (returning) {
      const serviceType = U.pick(input.serviceType, Object.keys(WEB_SERVICE_TYPES), 'نوع الخدمة');
      const prefTime = U.pick(input.prefTime, PREF_TIMES, 'ميعاد الاستلام');
      const c = readSelfToken(input.token);
      if (!c.address || c.address.length < 6) throw U.invalid('أضف عنوانك أولًا من «تعديل بياناتي» ثم أعد إرسال الطلب.', 'address');
      // العميل السابق المُتحقَّق منه يقدر يطلب أكتر من مرة، بحد أقصى لعدد الطلبات المفتوحة
      const open = q(`SELECT COUNT(*) n FROM web_requests WHERE customer_id = ? AND status IN ('new','contacted')`).get(c.id).n;
      if (open >= SELF.MAX_OPEN_REQUESTS) {
        throw U.httpError(429, 'too_many_open', `لديك ${open} طلبات مفتوحة بالفعل وسنتواصل معك قريبًا. لو عندك طلب جديد كلّمنا على الهاتف.`);
      }
      const r = q(`INSERT INTO web_requests (name,phone,address,service_type,pref_time,customer_id,is_returning,created_at) VALUES (?,?,?,?,?,?,1,?)`)
        .run(c.name, c.phone, c.address, serviceType, prefTime, c.id, U.nowIso());
      audit({ username: 'website', ip }, 'webrequest.create_returning', 'web_request', r.lastInsertRowid, { customerId: c.id, code: c.code });
      invalidateStats();
      return { id: Number(r.lastInsertRowid), duplicate: false, returning: true, name: c.name, phone: c.phone, prefTime };
    }
    const name = U.str(input.fullName, { field: 'الاسم', min: 2, max: 100, required: true });
    const phone = U.normalizePhone(input.phoneNumber, { mobileOnly: true });
    if (!phone) throw U.invalid('رقم الهاتف غير صحيح. مثال: 01012345678', 'phoneNumber');
    const address = U.str(input.address, { field: 'العنوان', min: 6, max: 300, required: true });
    const serviceType = U.pick(input.serviceType, Object.keys(WEB_SERVICE_TYPES), 'نوع الخدمة');
    const prefTime = U.pick(input.prefTime, PREF_TIMES, 'ميعاد الاستلام');
    // منع التكرار: نفس الرقم له طلب مفتوح خلال 24 ساعة
    const recent = q(`SELECT id FROM web_requests WHERE phone = ? AND status IN ('new','contacted') AND created_at > ?`)
      .get(phone, new Date(Date.now() - 86400000).toISOString());
    if (recent) return { id: recent.id, duplicate: true, returning: false, name, phone, prefTime };
    const r = q('INSERT INTO web_requests (name,phone,address,service_type,pref_time,created_at) VALUES (?,?,?,?,?,?)')
      .run(name, phone, address, serviceType, prefTime, U.nowIso());
    invalidateStats();
    return { id: Number(r.lastInsertRowid), duplicate: false, returning: false, name, phone, prefTime };
  }

  function listWebRequests({ status, page = 1, pageSize = 25 }) {
    pageSize = Math.min(Math.max(+pageSize || 25, 1), 100);
    page = Math.max(+page || 1, 1);
    const where = status ? 'WHERE w.status = ?' : '';
    const params = status ? [status] : [];
    const total = q(`SELECT COUNT(*) n FROM web_requests w ${where}`).get(...params).n;
    const rows = q(`${REQ_SELECT} ${where} ORDER BY (w.status = 'new') DESC, w.created_at DESC, w.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize);
    const counts = Object.fromEntries(q('SELECT status, COUNT(*) n FROM web_requests GROUP BY status').all().map(r => [r.status, r.n]));
    return { items: rows.map(reqOut), total, page, pageSize, counts };
  }

  function setWebRequestStatus(actor, id, status, note) {
    U.pick(status, ['contacted', 'cancelled'], 'الحالة');
    const r = getWebRequest(id);
    if (r.status === 'converted') throw U.httpError(409, 'bad_state', 'تم تحويل هذا الطلب بالفعل.');
    q('UPDATE web_requests SET status = ?, note = COALESCE(?, note), handled_by = ?, handled_at = ? WHERE id = ?')
      .run(status, U.str(note, { field: 'ملاحظة', max: 300 }), actor.id, U.nowIso(), id);
    audit(actor, 'webrequest.' + status, 'web_request', id);
    invalidateStats();
    return reqOut(getWebRequest(id));
  }

  // يحوّل طلب الموقع لعميل (جديد أو موجود) ليبدأ الكاشير الطلب
  function convertWebRequest(actor, id) {
    const r = getWebRequest(id);
    if (r.status === 'cancelled') throw U.httpError(409, 'bad_state', 'هذا الطلب ملغي.');
    const customerId = tx(db, () => {
      // العميل السابق مرتبط بحسابه مباشرة، وغيره يُطابَق برقم الهاتف
      let cid = r.customer_id ?? q('SELECT id FROM customers WHERE phone = ?').get(r.phone)?.id;
      if (!cid) {
        const zones = q('SELECT id, name FROM zones WHERE active = 1').all();
        const addr = U.norm(r.address);
        const zone = zones.find(z => addr.includes(U.norm(z.name)));
        cid = createCustomerTx(actor, {
          name: r.name, phone: r.phone, address: r.address, zoneId: zone?.id ?? null,
          notes: `طلب من الموقع: ${WEB_SERVICE_TYPES[r.service_type] || r.service_type}`
        }, 'website');
      }
      q(`UPDATE web_requests SET status = 'converted', customer_id = ?, handled_by = ?, handled_at = ? WHERE id = ?`).run(cid, actor.id, U.nowIso(), id);
      audit(actor, 'webrequest.convert', 'web_request', id, { customerId: cid });
      return cid;
    });
    invalidateStats();
    return { customer: getCustomer(customerId), request: reqOut(getWebRequest(id)) };
  }

  /* ---------------- العميل السابق (الموقع العام) ----------------
     الهوية تُثبَت بأحد طريقين:
       1) كود العميل + آخر 4 أرقام من هاتفه المسجّل (الكود مطبوع على بطاقته وفاتورته)
       2) نسيه؟ رقم الهاتف + رمز تحقق (OTP) يصل لهاتفه على واتساب (يُرسله الكاشير أو الـ webhook)
     بعد التحقق يُصدَر توكن موقّع قصير العمر يسمح بعرض/تعديل بياناته وتسجيل طلب جديد. */
  const SELF = {
    OTP_TTL_MS: 10 * 60_000, OTP_MAX_ATTEMPTS: 5, OTP_PER_HOUR: 3,
    TOKEN_TTL_MS: 30 * 60_000, LOCK_AFTER_FAILS: 5, LOCK_MS: 15 * 60_000, MAX_OPEN_REQUESTS: 3
  };
  const tokenSecret = crypto.randomBytes(32);   // يتجدد مع كل تشغيل — التوكنات مؤقتة أصلًا
  const failures = new Map();                    // customerId → { n, until }
  const CUST_CODE_RE = /^4s-?c-?(\d{1,6})$/i;
  const MOBILE_RE = /^01[0125]\d{8}$/;

  const safeEq = (a, b) => {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const hmac = body => crypto.createHmac('sha256', tokenSecret).update(body).digest('base64url');

  function signSelfToken(customerId) {
    const body = `${customerId}.${Date.now() + SELF.TOKEN_TTL_MS}`;
    return `${Buffer.from(body).toString('base64url')}.${hmac(body)}`;
  }
  function readSelfToken(token) {
    const bad = () => U.httpError(401, 'session_expired', 'انتهت صلاحية الجلسة. تحقق من هويتك من جديد.');
    if (typeof token !== 'string' || token.length > 200) throw bad();
    const [p, sig] = token.split('.');
    if (!p || !sig) throw bad();
    const body = Buffer.from(p, 'base64url').toString();
    if (!safeEq(sig, hmac(body))) throw bad();
    const [cid, exp] = body.split('.').map(Number);
    if (!(exp > Date.now())) throw bad();
    const c = q('SELECT * FROM customers WHERE id = ?').get(cid);
    if (!c) throw bad();
    return c;
  }

  function parseSelfTerm(raw) {
    const t = U.toLatinDigits(String(raw ?? '')).replace(/\s+/g, '');
    if (!t || t.length > 40) return null;
    const m = t.match(CUST_CODE_RE);
    if (m) return { kind: 'code', code: '4S-C-' + U.pad(Number(m[1]), 6) };
    const phone = U.normalizePhone(t, { mobileOnly: true });
    return phone ? { kind: 'phone', phone } : null;
  }
  const findByTerm = t => (t.kind === 'code'
    ? q('SELECT * FROM customers WHERE code = ?').get(t.code)
    : q('SELECT * FROM customers WHERE phone = ?').get(t.phone));
  const needTerm = raw => {
    const t = parseSelfTerm(raw);
    if (!t) throw U.invalid('اكتب كود العميل (مثال: 4S-C-000124) أو رقم هاتفك المسجّل.', 'term');
    return t;
  };
  const notFound = () => U.httpError(404, 'not_found', 'لم نجد عميلًا بهذه البيانات. تأكد منها أو اختر «عميل جديد».');
  const webActor = ip => ({ username: 'website', ip });

  const maskName = name => {
    const parts = String(name).trim().split(/\s+/);
    return parts.length > 1 ? `${parts[0]} ${[...parts[1]][0]}***` : `${[...parts[0]].slice(0, 2).join('')}***`;
  };
  const maskPhone = p => (p.length > 6 ? p.slice(0, 3) + '*'.repeat(p.length - 6) + p.slice(-3) : '*'.repeat(p.length));

  function isLocked(customerId) {
    const f = failures.get(customerId);
    if (!f) return false;
    if (f.until && f.until > Date.now()) return true;
    if (f.until) failures.delete(customerId);
    return false;
  }
  function registerFailure(customerId) {
    if (failures.size > 5000) for (const [k, v] of failures) if (v.until && v.until <= Date.now()) failures.delete(k);
    const f = failures.get(customerId) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= SELF.LOCK_AFTER_FAILS) { f.n = 0; f.until = Date.now() + SELF.LOCK_MS; }
    failures.set(customerId, f);
  }

  // ما يراه العميل عن نفسه بعد التحقق (بدون ملاحظات الكاشير الداخلية)
  function selfView(customerId) {
    const c = getCustomer(customerId);
    const orders = q(`SELECT code, status, total_cents, paid_cents, created_date, delivery_date FROM orders
      WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 5`).all(customerId).map(o => ({
      code: o.code, status: o.status, total: c2p(o.total_cents), remaining: c2p(o.total_cents - o.paid_cents),
      createdDate: o.created_date, delivery: o.delivery_date
    }));
    return { code: c.code, name: c.name, phone: c.phone, address: c.address || '', zone: c.zone, balance: c.balance, orders };
  }

  // الخطوة 1: هل هذا عميل لدينا؟ وبأي وسيلة نتحقق منه؟ (بدون كشف بياناته)
  function selfLookup(rawTerm) {
    const t = needTerm(rawTerm);
    const c = findByTerm(t);
    if (!c) throw notFound();
    if (t.kind === 'code') return { method: 'code' };
    return { method: 'otp', hint: { name: maskName(c.name), phone: maskPhone(c.phone) } };
  }

  function dispatchOtp(otpId, c, otp) {
    if (!config.otpWebhookUrl) return;
    const message = `كود التحقق الخاص بك لدى ${getSettings().business_name || '4Seasons'} هو: ${otp}\nصالح لمدة ${SELF.OTP_TTL_MS / 60000} دقائق. لا تشاركه مع أحد.`;
    fetch(config.otpWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.otpWebhookToken ? { Authorization: `Bearer ${config.otpWebhookToken}` } : {}) },
      body: JSON.stringify({ event: 'customer_otp', phone: c.phone, name: c.name, otp, expiresInMinutes: SELF.OTP_TTL_MS / 60000, message }),
      signal: AbortSignal.timeout(5000)
    }).then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      q('UPDATE customer_otps SET delivered_at = ? WHERE id = ?').run(U.nowIso(), otpId);
      invalidateStats();
    }).catch(e => console.error('[otp webhook] فشل الإرسال التلقائي، الكود متاح للكاشير:', e.message));
  }

  // الخطوة 2 (نسي الكود): يُنشئ رمز تحقق ويظهر عند الكاشير ليرسله على واتساب العميل
  function selfRequestOtp(input, { ip } = {}) {
    const t = needTerm(input.term);
    if (t.kind !== 'phone') throw U.invalid('اكتب رقم هاتفك المسجّل.', 'term');
    const c = findByTerm(t);
    if (!c) throw notFound();
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    if (q('SELECT COUNT(*) n FROM customer_otps WHERE customer_id = ? AND created_at > ?').get(c.id, hourAgo).n >= SELF.OTP_PER_HOUR) {
      throw U.httpError(429, 'otp_limit', 'طلبت الكود أكثر من مرة. حاول بعد ساعة أو كلّمنا على الهاتف.');
    }
    const otp = String(crypto.randomInt(100000, 1000000));
    const now = U.nowIso();
    const id = tx(db, () => {
      q('UPDATE customer_otps SET used_at = ? WHERE customer_id = ? AND used_at IS NULL').run(now, c.id); // الأحدث فقط يعمل
      const r = q('INSERT INTO customer_otps (customer_id,otp,expires_at,ip,created_at) VALUES (?,?,?,?,?)')
        .run(c.id, otp, new Date(Date.now() + SELF.OTP_TTL_MS).toISOString(), ip ?? null, now);
      audit(webActor(ip), 'customer.otp_request', 'customer', c.id);
      return Number(r.lastInsertRowid);
    });
    invalidateStats();
    dispatchOtp(id, c, otp);
    return { ok: true, expiresInMinutes: SELF.OTP_TTL_MS / 60000, automatic: !!config.otpWebhookUrl };
  }

  // الخطوة 3: إثبات الهوية → توكن + بيانات العميل كاملة
  function selfVerify(input, { ip } = {}) {
    const t = needTerm(input.term);
    const c = findByTerm(t);
    const fail = () => U.httpError(403, 'verify_failed', 'البيانات غير مطابقة. راجعها وحاول مرة أخرى.');
    if (!c) throw fail();
    if (isLocked(c.id)) throw U.httpError(429, 'locked', 'محاولات كثيرة. حاول بعد 15 دقيقة أو كلّمنا على الهاتف.');
    const digits = v => U.toLatinDigits(String(v ?? '')).replace(/\D/g, '');

    if (t.kind === 'code') {
      const last4 = digits(input.last4);
      if (last4.length !== 4 || !safeEq(c.phone.slice(-4), last4)) {
        registerFailure(c.id);
        audit(webActor(ip), 'customer.verify_fail', 'customer', c.id, { method: 'code' });
        throw fail();
      }
    } else {
      const row = q('SELECT * FROM customer_otps WHERE customer_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1').get(c.id, U.nowIso());
      if (!row || row.attempts >= SELF.OTP_MAX_ATTEMPTS) {
        throw U.httpError(403, 'otp_expired', 'انتهت صلاحية الكود أو لم يُطلب. اطلب كودًا جديدًا.');
      }
      q('UPDATE customer_otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
      if (!safeEq(row.otp, digits(input.otp))) {
        audit(webActor(ip), 'customer.verify_fail', 'customer', c.id, { method: 'otp' });
        const left = SELF.OTP_MAX_ATTEMPTS - row.attempts - 1;
        throw U.httpError(403, 'verify_failed', left > 0 ? `الكود غير صحيح. متبقي ${left} محاولات.` : 'الكود غير صحيح. اطلب كودًا جديدًا.');
      }
      q('UPDATE customer_otps SET used_at = ? WHERE id = ?').run(U.nowIso(), row.id);
    }
    failures.delete(c.id);
    audit(webActor(ip), 'customer.verify', 'customer', c.id, { method: t.kind === 'code' ? 'code' : 'otp' });
    return { token: signSelfToken(c.id), customer: selfView(c.id) };
  }

  // تعديل العميل لبياناته بنفسه (الاسم / الهاتف / العنوان)
  function selfUpdate(input, { ip } = {}) {
    const c = readSelfToken(input.token);
    const name = U.str(input.name ?? c.name, { field: 'الاسم', min: 2, max: 100, required: true });
    const address = U.str(input.address ?? c.address, { field: 'العنوان', min: 6, max: 300, required: true });
    let phone = c.phone;
    if (input.phone !== undefined && input.phone !== null && input.phone !== '') {
      const p = U.normalizePhone(input.phone);
      if (!p || (p !== c.phone && !MOBILE_RE.test(p))) throw U.invalid('رقم الهاتف غير صحيح. مثال: 01012345678', 'phone');
      phone = p;
    }
    if (phone !== c.phone && q('SELECT 1 FROM customers WHERE phone = ? AND id != ?').get(phone, c.id)) {
      throw U.httpError(409, 'phone_exists', 'هذا الرقم مسجل لحساب آخر. كلّمنا على الهاتف لتحديثه.', { field: 'phone' });
    }
    const changes = {};
    if (name !== c.name) changes.name = { from: c.name, to: name };
    if (phone !== c.phone) changes.phone = { from: c.phone, to: phone };
    if (address !== (c.address ?? '')) changes.address = { from: c.address, to: address };
    const changed = Object.keys(changes);
    if (changed.length) {
      tx(db, () => {
        q('UPDATE customers SET name=?, phone=?, address=?, search_text=?, updated_at=? WHERE id=?')
          .run(name, phone, address, searchText(name, phone, c.code), U.nowIso(), c.id);
        audit(webActor(ip), 'customer.self_update', 'customer', c.id, changes);
      });
    }
    return { token: signSelfToken(c.id), customer: selfView(c.id), changed };
  }

  /* ---- جانب الكاشير: رموز التحقق المطلوبة ---- */
  function listActiveOtps() {
    return q(`SELECT o.id, o.customer_id, o.otp, o.attempts, o.expires_at, o.delivered_at, o.created_at, c.code, c.name, c.phone
      FROM customer_otps o JOIN customers c ON c.id = o.customer_id
      WHERE o.used_at IS NULL AND o.expires_at > ? ORDER BY o.created_at DESC LIMIT 50`).all(U.nowIso()).map(r => ({
      id: r.id, customerId: r.customer_id, customerCode: r.code, name: r.name, phone: r.phone, otp: r.otp,
      attempts: r.attempts, expiresAt: r.expires_at, delivered: !!r.delivered_at, createdAt: r.created_at
    }));
  }

  function markOtpDelivered(actor, id) {
    const r = q('SELECT id FROM customer_otps WHERE id = ? AND used_at IS NULL AND expires_at > ?').get(id, U.nowIso());
    if (!r) throw U.httpError(404, 'not_found', 'الكود منتهي أو غير موجود.');
    q('UPDATE customer_otps SET delivered_at = ?, delivered_by = ? WHERE id = ?').run(U.nowIso(), actor.id, id);
    invalidateStats();
    return { ok: true };
  }

  /* ---------------- تحكم المدير اليدوي ---------------- */
  const ORDER_STATUSES = ['pending_pricing', 'in_progress', 'ready', 'delivered', 'cancelled'];

  function listCustomerPayments(customerId) {
    return q(`SELECT p.id, p.amount_cents, p.method, p.kind, p.note, p.paid_date, p.created_at, o.code AS order_code
      FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE p.customer_id = ? ORDER BY p.id DESC LIMIT 200`).all(customerId)
      .map(p => ({ id: p.id, amount: c2p(p.amount_cents), method: p.method, kind: p.kind, note: p.note, paidDate: p.paid_date, createdAt: p.created_at, orderCode: p.order_code }));
  }

  // تعديل يدوي للطلب: الحالة، الإجمالي، المدفوع، الميعاد، الملاحظة، تاريخ الإنشاء
  function adminUpdateOrder(actor, id, input) {
    const o = q('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw U.httpError(404, 'not_found', 'الطلب غير موجود.');
    const status = input.status !== undefined ? U.pick(input.status, ORDER_STATUSES, 'الحالة') : o.status;
    const total = input.total !== undefined ? U.money(input.total, { field: 'الإجمالي', required: true }) : o.total_cents;
    const paid = input.paid !== undefined ? U.money(input.paid, { field: 'المدفوع', required: true }) : o.paid_cents;
    if (paid > total) throw U.invalid('المدفوع لا يمكن أن يزيد عن إجمالي الطلب.', 'paid');
    const note = input.note !== undefined ? U.str(input.note, { field: 'الملاحظة', max: 500 }) : o.note;
    const dateOf = (v, f, cur) => {
      if (v === undefined) return cur;
      if (v === null || v === '') return null;
      if (!U.isDateStr(v)) throw U.invalid('تاريخ غير صحيح.', f);
      return v;
    };
    const deliveryDate = dateOf(input.deliveryDate, 'deliveryDate', o.delivery_date);
    const createdDate = dateOf(input.createdDate, 'createdDate', o.created_date) || o.created_date;
    const now = U.nowIso();
    tx(db, () => {
      const subtotal = total !== o.total_cents ? Math.max(0, total - o.delivery_fee_cents) : o.subtotal_cents;
      q(`UPDATE orders SET status=?, total_cents=?, subtotal_cents=?, paid_cents=?, note=?, delivery_date=?, created_date=?, updated_at=?,
         delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE NULL END WHERE id=?`)
        .run(status, total, subtotal, paid, note, deliveryDate, createdDate, now, status, now, id);
      if (status !== o.status) {
        q('INSERT INTO order_events (order_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?)')
          .run(id, o.status, status, actor.id, 'تعديل يدوي من المدير', now);
      }
      const diff = paid - o.paid_cents;
      if (diff > 0) {
        q('INSERT INTO payments (customer_id,order_id,amount_cents,method,kind,note,created_by,paid_date,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(o.customer_id, id, diff, 'cash', 'payment', 'تسوية يدوية من المدير', actor.id, U.todayStr(), now);
      } else if (diff < 0) {
        let left = -diff;
        for (const p of q('SELECT id, amount_cents FROM payments WHERE order_id = ? ORDER BY id DESC').all(id)) {
          if (left <= 0) break;
          if (p.amount_cents <= left) { q('DELETE FROM payments WHERE id = ?').run(p.id); left -= p.amount_cents; }
          else { q('UPDATE payments SET amount_cents = amount_cents - ? WHERE id = ?').run(left, p.id); left = 0; }
        }
      }
      audit(actor, 'admin.order_update', 'order', id, {
        code: o.code, status: [o.status, status], total: [c2p(o.total_cents), c2p(total)], paid: [c2p(o.paid_cents), c2p(paid)]
      });
    });
    invalidateStats();
    return getOrder(id);
  }

  function adminDeleteOrder(actor, id) {
    const o = q('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) throw U.httpError(404, 'not_found', 'الطلب غير موجود.');
    tx(db, () => {
      q('DELETE FROM payments WHERE order_id = ?').run(id);
      q('DELETE FROM order_lines WHERE order_id = ?').run(id);
      q('DELETE FROM order_events WHERE order_id = ?').run(id);
      q('DELETE FROM orders WHERE id = ?').run(id);
      audit(actor, 'admin.order_delete', 'order', id, { code: o.code, customerId: o.customer_id, total: c2p(o.total_cents), paid: c2p(o.paid_cents), status: o.status });
    });
    invalidateStats();
    return { ok: true };
  }

  function adminDeletePayment(actor, id) {
    const p = q('SELECT * FROM payments WHERE id = ?').get(id);
    if (!p) throw U.httpError(404, 'not_found', 'الدفعة غير موجودة.');
    tx(db, () => {
      if (p.kind === 'opening') {
        q('UPDATE customers SET opening_balance_cents = opening_balance_cents + ?, updated_at = ? WHERE id = ?').run(p.amount_cents, U.nowIso(), p.customer_id);
      } else if (p.order_id) {
        q('UPDATE orders SET paid_cents = MAX(0, paid_cents - ?), updated_at = ? WHERE id = ?').run(p.amount_cents, U.nowIso(), p.order_id);
      }
      q('DELETE FROM payments WHERE id = ?').run(id);
      audit(actor, 'admin.payment_delete', 'payment', id, { customerId: p.customer_id, orderId: p.order_id, amount: c2p(p.amount_cents), kind: p.kind });
    });
    invalidateStats();
    return getCustomer(p.customer_id);
  }

  // رصيد افتتاحي (مديونية سابقة) يدويًا
  function adminUpdateCustomer(actor, id, input) {
    const c = q('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw U.httpError(404, 'not_found', 'العميل غير موجود.');
    const opening = U.money(input.openingBalance, { field: 'الرصيد الافتتاحي', required: true });
    q('UPDATE customers SET opening_balance_cents = ?, updated_at = ? WHERE id = ?').run(opening, U.nowIso(), id);
    audit(actor, 'admin.customer_balance', 'customer', id, { from: c2p(c.opening_balance_cents), to: c2p(opening) });
    invalidateStats();
    return getCustomer(id);
  }

  function adminDeleteCustomer(actor, id, { force = false } = {}) {
    const c = q('SELECT * FROM customers WHERE id = ?').get(id);
    if (!c) throw U.httpError(404, 'not_found', 'العميل غير موجود.');
    const orders = q('SELECT id FROM orders WHERE customer_id = ?').all(id);
    if (orders.length && !force) {
      throw U.httpError(409, 'has_orders', `للعميل ${orders.length} طلب. حذف العميل سيحذف طلباته ومدفوعاته أيضًا.`, { count: orders.length });
    }
    tx(db, () => {
      for (const o of orders) {
        q('DELETE FROM payments WHERE order_id = ?').run(o.id);
        q('DELETE FROM order_lines WHERE order_id = ?').run(o.id);
        q('DELETE FROM order_events WHERE order_id = ?').run(o.id);
        q('DELETE FROM orders WHERE id = ?').run(o.id);
      }
      q('DELETE FROM payments WHERE customer_id = ?').run(id);
      q('UPDATE web_requests SET customer_id = NULL WHERE customer_id = ?').run(id);
      q('DELETE FROM customer_otps WHERE customer_id = ?').run(id);
      q('DELETE FROM customers WHERE id = ?').run(id);
      audit(actor, 'admin.customer_delete', 'customer', id, { code: c.code, name: c.name, phone: c.phone, orders: orders.length });
    });
    invalidateStats();
    return { ok: true, deletedOrders: orders.length };
  }

  /* ---------------- الرسائل الداخلية ---------------- */
  const MSG_MAX_RECIPIENTS = 50;
  const msgOut = r => ({
    id: r.id, subject: r.subject, body: r.body, parentId: r.parent_id, createdAt: r.created_at,
    from: { id: r.sender_id, name: r.sender_name }, read: r.read_at !== undefined ? !!r.read_at : undefined
  });

  // المستخدمون المفعّلون الذين يمكن مراسلتهم
  function messageContacts(me) {
    return q('SELECT id, name, role FROM users WHERE active = 1 AND id != ? ORDER BY role = \'manager\' DESC, name').all(me.id);
  }

  function sendMessage(me, input) {
    const subject = U.str(input.subject, { field: 'الموضوع', min: 1, max: 120, required: true });
    const body = U.str(input.body, { field: 'الرسالة', min: 1, max: 4000, required: true });
    let to = Array.isArray(input.to) ? input.to : [];
    if (input.toAll === true) to = q('SELECT id FROM users WHERE active = 1').all().map(u => u.id);
    to = [...new Set(to.map(Number).filter(Number.isInteger))].filter(id => id !== me.id);
    if (!to.length) throw U.invalid('اختر مستلمًا واحدًا على الأقل.', 'to');
    if (to.length > MSG_MAX_RECIPIENTS) throw U.invalid('عدد المستلمين كبير.', 'to');
    const ok = new Set(q(`SELECT id FROM users WHERE active = 1 AND id IN (${to.map(() => '?').join(',')})`).all(...to).map(u => u.id));
    if (to.some(id => !ok.has(id))) throw U.invalid('مستلم غير موجود أو معطّل.', 'to');
    let parentId = null;
    if (input.parentId) {
      const par = q('SELECT m.id FROM messages m WHERE m.id = ? AND (m.sender_id = ? OR EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.id AND r.user_id = ?))').get(Number(input.parentId), me.id, me.id);
      if (!par) throw U.httpError(404, 'not_found', 'الرسالة الأصلية غير موجودة.');
      parentId = par.id;
    }
    // قيد على الإغراق: 30 رسالة في الساعة للمستخدم
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    if (q('SELECT COUNT(*) n FROM messages WHERE sender_id = ? AND created_at > ?').get(me.id, hourAgo).n >= 30) {
      throw U.httpError(429, 'rate_limited', 'أرسلت رسائل كتير. جرّب بعد شوية.');
    }
    let id;
    tx(db, () => {
      id = Number(q('INSERT INTO messages (sender_id,subject,body,parent_id,created_at) VALUES (?,?,?,?,?)').run(me.id, subject, body, parentId, U.nowIso()).lastInsertRowid);
      const ins = q('INSERT INTO message_recipients (message_id,user_id) VALUES (?,?)');
      to.forEach(uid => ins.run(id, uid));
    });
    return { id, recipients: to.length };
  }

  function listMessages(me, box = 'inbox', { page = 1, pageSize = 25 } = {}) {
    const off = (Math.max(1, page) - 1) * pageSize;
    if (box === 'sent') {
      const rows = q(`SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id
        WHERE m.sender_id = ? ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(me.id, pageSize, off);
      const total = q('SELECT COUNT(*) n FROM messages WHERE sender_id = ?').get(me.id).n;
      return { items: rows.map(r => ({ ...msgOut(r), read: undefined,
        to: q('SELECT u.id, u.name, r.read_at FROM message_recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = ?').all(r.id)
          .map(x => ({ id: x.id, name: x.name, read: !!x.read_at })) })), total, page, pageSize };
    }
    const rows = q(`SELECT m.*, u.name AS sender_name, r.read_at FROM message_recipients r JOIN messages m ON m.id = r.message_id
      JOIN users u ON u.id = m.sender_id WHERE r.user_id = ? AND r.deleted = 0 ORDER BY m.id DESC LIMIT ? OFFSET ?`).all(me.id, pageSize, off);
    const total = q('SELECT COUNT(*) n FROM message_recipients WHERE user_id = ? AND deleted = 0').get(me.id).n;
    return { items: rows.map(msgOut), total, page, pageSize };
  }

  function unreadMessages(me) {
    return q('SELECT COUNT(*) n FROM message_recipients WHERE user_id = ? AND deleted = 0 AND read_at IS NULL').get(me.id).n;
  }

  // فتح رسالة: لازم تكون مرسلها أو مستلمها. فتحها بيعلّمها مقروءة
  function getMessage(me, id) {
    const m = q('SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?').get(id);
    const mine = m && (m.sender_id === me.id || q('SELECT 1 FROM message_recipients WHERE message_id = ? AND user_id = ? AND deleted = 0').get(id, me.id));
    if (!mine) throw U.httpError(404, 'not_found', 'الرسالة غير موجودة.');
    q('UPDATE message_recipients SET read_at = ? WHERE message_id = ? AND user_id = ? AND read_at IS NULL').run(U.nowIso(), id, me.id);
    const to = q('SELECT u.id, u.name, r.read_at FROM message_recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = ?').all(id)
      .map(x => ({ id: x.id, name: x.name, read: !!x.read_at }));
    // سلسلة الردود
    const root = (function rootOf(mm) { let cur = mm; while (cur.parent_id) { const p = q('SELECT * FROM messages WHERE id = ?').get(cur.parent_id); if (!p) break; cur = p; } return cur; })(m);
    const thread = q(`WITH RECURSIVE t(id) AS (SELECT id FROM messages WHERE id = ? UNION ALL SELECT m.id FROM messages m JOIN t ON m.parent_id = t.id)
      SELECT m.*, u.name AS sender_name FROM messages m JOIN t ON t.id = m.id JOIN users u ON u.id = m.sender_id ORDER BY m.id`).all(root.id)
      .filter(x => x.sender_id === me.id || q('SELECT 1 FROM message_recipients WHERE message_id = ? AND user_id = ?').get(x.id, me.id))
      .map(x => ({ ...msgOut(x), read: undefined }));
    return { ...msgOut(m), read: undefined, to, thread };
  }

  function deleteMessage(me, id) {
    const r = q('UPDATE message_recipients SET deleted = 1 WHERE message_id = ? AND user_id = ?').run(id, me.id);
    if (!r.changes) throw U.httpError(404, 'not_found', 'الرسالة غير موجودة.');
    return { ok: true };
  }

  /* ---------------- المستخدمون ---------------- */
  const userOut = u => ({ id: u.id, username: u.username, name: u.name, role: u.role, permissions: A.effectivePerms(u.role, u.permissions), customPermissions: !!u.permissions && u.role !== 'manager', active: !!u.active, lastLoginAt: u.last_login_at, mustChangePassword: !!u.must_change_password });
  const ROLES = ['manager', 'cashier', 'accountant'];

  // null = افتراضي الدور | مصفوفة = مخصصة
  function permsToStore(role, input) {
    if (role === 'manager' || input === null) return null;
    if (!Array.isArray(input)) throw U.invalid('الصلاحيات غير صحيحة.', 'permissions');
    return JSON.stringify(A.normalizePerms(input));
  }

  const listUsers = () => q('SELECT * FROM users ORDER BY id').all().map(userOut);

  async function createUser(actor, input, { password, mustChange = true } = {}) {
    const username = U.str(input.username, { field: 'اسم المستخدم', min: 3, max: 30, required: true });
    if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw U.invalid('اسم المستخدم: حروف إنجليزية وأرقام و _ . - فقط.', 'username');
    const name = U.str(input.name, { field: 'الاسم', min: 2, max: 80, required: true });
    const role = U.pick(input.role, ROLES, 'الدور');
    if (q('SELECT 1 FROM users WHERE username = ?').get(username)) throw U.httpError(409, 'username_exists', 'اسم المستخدم مستخدم بالفعل.');
    const perms = input.permissions === undefined ? null : permsToStore(role, input.permissions);
    if (password) A.checkPasswordStrength(password, username);
    const pw = password || A.generatePassword();
    const hash = await A.hashPassword(pw);
    const r = q('INSERT INTO users (username,name,role,permissions,password_hash,must_change_password,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(username, name, role, perms, hash, mustChange ? 1 : 0, U.nowIso());
    audit(actor, 'user.create', 'user', r.lastInsertRowid, { username, role, permissions: perms ? JSON.parse(perms) : 'default' });
    return { user: userOut(q('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid)), password: pw };
  }

  function activeManagers() { return q(`SELECT COUNT(*) n FROM users WHERE role = 'manager' AND active = 1`).get().n; }

  function updateUser(actor, id, input) {
    const u = q('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw U.httpError(404, 'not_found', 'المستخدم غير موجود.');
    const name = U.str(input.name ?? u.name, { field: 'الاسم', min: 2, max: 80, required: true });
    const role = U.pick(input.role ?? u.role, ROLES, 'الدور');
    const active = input.active !== undefined ? (input.active ? 1 : 0) : u.active;
    if (id === actor.id && (!active || role !== u.role)) throw U.httpError(409, 'self_change', 'لا يمكنك تعطيل حسابك أو تغيير دورك بنفسك.');
    if (u.role === 'manager' && u.active && (role !== 'manager' || !active) && activeManagers() <= 1) {
      throw U.httpError(409, 'last_manager', 'لا يمكن تعطيل آخر مدير في النظام.');
    }
    // تغيير الدور بدون صلاحيات صريحة يرجّع الصلاحيات لافتراضي الدور الجديد
    const perms = input.permissions !== undefined ? permsToStore(role, input.permissions) : (role !== u.role ? null : u.permissions);
    if (id === actor.id && input.permissions !== undefined && u.role !== 'manager') throw U.httpError(409, 'self_change', 'لا يمكنك تعديل صلاحياتك بنفسك.');
    q('UPDATE users SET name = ?, role = ?, permissions = ?, active = ? WHERE id = ?').run(name, role, perms, active, id);
    if (!active) A.destroyUserSessions(db, id);
    audit(actor, 'user.update', 'user', id, { role, active: !!active, permissions: perms ? JSON.parse(perms) : 'default' });
    return userOut(q('SELECT * FROM users WHERE id = ?').get(id));
  }

  async function resetPassword(actor, id) {
    const u = q('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw U.httpError(404, 'not_found', 'المستخدم غير موجود.');
    const pw = A.generatePassword();
    q('UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE id = ?').run(await A.hashPassword(pw), id);
    A.destroyUserSessions(db, id);
    audit(actor, 'user.reset_password', 'user', id);
    return { password: pw };
  }

  async function changeOwnPassword(actor, currentToken, { current, next }) {
    const u = q('SELECT * FROM users WHERE id = ?').get(actor.id);
    if (!(await A.verifyPassword(String(current ?? ''), u.password_hash))) throw U.httpError(403, 'wrong_password', 'كلمة المرور الحالية غير صحيحة.');
    A.checkPasswordStrength(next, u.username);
    if (await A.verifyPassword(next, u.password_hash)) throw U.httpError(422, 'weak_password', 'اختر كلمة مرور مختلفة عن الحالية.');
    q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await A.hashPassword(next), actor.id);
    A.destroyUserSessions(db, actor.id, currentToken);
    audit(actor, 'user.change_password', 'user', actor.id);
  }

  /* ---------------- تسجيل الدخول ---------------- */
  async function login(username, password, { ip, userAgent }) {
    const u = q('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
    const fail = () => U.httpError(401, 'bad_credentials', 'اسم المستخدم أو كلمة المرور غير صحيحة.');
    if (!u || !u.active) { await A.burnTime(String(password || '')); audit({ ip, username: String(username).slice(0, 40) }, 'login.fail', 'user', null); throw fail(); }
    if (u.locked_until && u.locked_until > U.nowIso()) {
      throw U.httpError(429, 'locked', 'تم إيقاف الحساب مؤقتًا بسبب محاولات كثيرة. حاول بعد قليل.');
    }
    const ok = await A.verifyPassword(String(password || ''), u.password_hash);
    if (!ok) {
      const fails = u.failed_logins + 1;
      if (fails >= 5) q('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(new Date(Date.now() + 5 * 60_000).toISOString(), u.id);
      else q('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, u.id);
      audit({ id: u.id, username: u.username, ip }, 'login.fail', 'user', u.id);
      throw fail();
    }
    q('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(U.nowIso(), u.id);
    const token = A.createSession(db, u.id, userAgent, config.sessionHours);
    audit({ id: u.id, username: u.username, ip }, 'login.ok', 'user', u.id);
    const permissions = A.effectivePerms(u.role, u.permissions);
    return { token, permissions, user: { id: u.id, username: u.username, name: u.name, role: u.role, permissions, mustChangePassword: !!u.must_change_password } };
  }

  return {
    audit, getSettings, updateSettings, getCatalog, createService, updateService, createZone, updateZone,
    listCustomers, getCustomer, findCustomerExact, createCustomer, updateCustomer,
    listOrders, orderCounts, getOrder, createOrder, applyPricing, advanceOrder, collectPayment, getStats, invalidateStats,
    createWebRequest, listWebRequests, setWebRequestStatus, convertWebRequest,
    selfLookup, selfRequestOtp, selfVerify, selfUpdate, listActiveOtps, markOtpDelivered,
    listCustomerPayments, adminUpdateOrder, adminDeleteOrder, adminDeletePayment, adminUpdateCustomer, adminDeleteCustomer,
    messageContacts, sendMessage, listMessages, unreadMessages, getMessage, deleteMessage,
    listUsers, createUser, updateUser, resetPassword, changeOwnPassword, login,
    constants: { PREF_TIMES, WEB_SERVICE_TYPES, FEE_TYPES, PAYMENT_METHODS, ORDER_METHODS }
  };
}

module.exports = { createDomain, PREF_TIMES, WEB_SERVICE_TYPES, FEE_TYPES, PAYMENT_METHODS, ORDER_METHODS };
