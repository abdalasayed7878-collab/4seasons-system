'use strict';
// يملأ قاعدة البيانات ببيانات تجريبية كبيرة لاختبار الأداء: node server/cli.js seed-demo --customers 50000 --orders 200000
const { tx } = require('../server/db');
const U = require('../server/util');

const FIRST = ['أحمد', 'محمد', 'محمود', 'مصطفى', 'خالد', 'عمر', 'يوسف', 'إبراهيم', 'علي', 'حسن', 'مريم', 'سارة', 'منى', 'نورهان', 'فاطمة', 'هدى', 'آية', 'دعاء', 'ريم', 'هبة'];
const LAST = ['سامي', 'علاء', 'محمود', 'عبد الله', 'السيد', 'فتحي', 'رمضان', 'حسين', 'جمال', 'نبيل', 'صلاح', 'ياسين', 'شريف', 'عادل', 'كمال'];
const STATUSES = ['delivered', 'delivered', 'delivered', 'delivered', 'ready', 'in_progress', 'pending_pricing'];

function seedDemo(db, domain, { customers = 1000, orders = 4000 } = {}) {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const services = db.prepare(`SELECT * FROM services WHERE pricing != 'quote' AND unit IN ('piece','meter')`).all();
  const zones = db.prepare('SELECT id FROM zones').all().map(z => z.id);
  const t0 = Date.now();
  const nowIso = U.nowIso();
  const today = U.todayStr();

  tx(db, () => {
    const startC = db.prepare("SELECT COALESCE(MAX(id),0) m FROM customers").get().m;
    const insC = db.prepare(`INSERT INTO customers (code,name,phone,address,zone_id,source,search_text,created_at,updated_at,opening_balance_cents)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const ids = [];
    for (let i = 1; i <= customers; i++) {
      const n = startC + i;
      const code = '4S-C-' + U.pad(n, 6);
      const name = `${pick(FIRST)} ${pick(LAST)} ${n}`;
      const phone = '01' + pick([0, 1, 2, 5]) + U.pad(10000000 + n * 7 % 89999999, 8);
      const r = insC.run(code, name, phone, 'عنوان تجريبي ' + n, pick(zones), 'import', U.norm(`${name} ${phone} ${code}`), nowIso, nowIso, rnd() < 0.02 ? 5000 : 0);
      ids.push(Number(r.lastInsertRowid));
    }
    db.prepare("INSERT INTO counters (name,value) VALUES ('customer_seq',?) ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)").run(startC + customers);

    let seq = db.prepare("SELECT COALESCE(value, 1000) v FROM counters WHERE name = 'order_seq'").get()?.v ?? 1000;
    const insO = db.prepare(`INSERT INTO orders (code,customer_id,zone_id,status,items_summary,subtotal_cents,delivery_fee_cents,total_cents,paid_cents,payment_method,delivery_date,created_date,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insL = db.prepare(`INSERT INTO order_lines (order_id,position,kind,service_id,name,unit,qty,unit_price_cents,line_total_cents) VALUES (?,?,?,?,?,?,?,?,?)`);
    const insP = db.prepare(`INSERT INTO payments (customer_id,order_id,amount_cents,method,kind,paid_date,created_at) VALUES (?,?,?,?,?,?,?)`);
    for (let i = 0; i < orders; i++) {
      seq++;
      const cid = pick(ids);
      const status = pick(STATUSES);
      const n = 1 + Math.floor(rnd() * 3);
      const lines = Array.from({ length: n }, () => { const s = pick(services); const q = s.unit === 'meter' ? 2 + Math.floor(rnd() * 8) : 1 + Math.floor(rnd() * 3); return { s, q, total: s.price_min_cents * q }; });
      const subtotal = lines.reduce((a, l) => a + l.total, 0);
      const days = Math.floor(rnd() * 400);
      const created = new Date(Date.now() - days * 86400000);
      const createdDate = U.dateInTz(created);
      const method = pick(['cash', 'cash', 'vodafone_cash', 'instapay', 'deferred']);
      const paid = status === 'delivered' || method !== 'deferred' ? (rnd() < 0.85 ? subtotal : Math.floor(subtotal / 2)) : 0;
      const r = insO.run('4S-' + seq, cid, pick(zones), status, lines.map(l => l.s.name).join(' + '), subtotal, 0, subtotal, method === 'deferred' ? 0 : paid, method,
        U.addDaysStr(4 - days, new Date()), createdDate, created.toISOString(), nowIso);
      const oid = Number(r.lastInsertRowid);
      lines.forEach((l, p) => insL.run(oid, p, 'service', l.s.id, l.s.name, l.s.unit, l.q, l.s.price_min_cents, l.total));
      if (method !== 'deferred' && paid > 0) insP.run(cid, oid, paid, method, 'payment', createdDate, created.toISOString());
    }
    db.prepare("INSERT INTO counters (name,value) VALUES ('order_seq',?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(seq);
  });
  void today;
  console.log(`تمت إضافة ${customers} عميل و ${orders} طلب خلال ${((Date.now() - t0) / 1000).toFixed(1)} ثانية.`);
}

module.exports = { seedDemo };
