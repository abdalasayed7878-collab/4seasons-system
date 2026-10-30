'use strict';
// البيانات الأولية: التصنيفات والخدمات والمناطق والإعدادات (تُنشأ مرة واحدة عند أول تشغيل)
const { nowIso } = require('./util');
const { tx } = require('./db');

const CATEGORIES = [
  { code: 'bedding', name: 'بطانية - لحاف - مفارش', icon: 'fas fa-layer-group', visual: 'bedding',
    note: 'بخلاف رسوم إزالة البقع الصعبة (حسب الحالة)', note_icon: 'fas fa-triangle-exclamation' },
  { code: 'carpets', name: 'تنظيف السجاد (بالمتر)', icon: 'fas fa-border-all', visual: 'carpets',
    note: 'رسوم إزالة البقع الصعبة تضاف بعد المعاينة', note_icon: 'fas fa-droplet' },
  { code: 'clothes', name: 'كي وتنظيف الملابس', icon: 'fas fa-shirt', visual: 'clothes',
    note: 'إزالة البقع لها رسوم إضافية', note_icon: 'fas fa-spray-can' },
  { code: 'suits', name: 'بدل - جواكت - فساتين', icon: 'fas fa-user-tie', visual: 'clothes' },
  { code: 'pillows', name: 'المخدات والمراتب', icon: 'fas fa-bed', visual: 'bedding' },
  { code: 'curtains', name: 'الستائر - الانتريهات', icon: 'fas fa-window-maximize', visual: 'curtains',
    note: 'تنظيف الانتريهات: يتم إرسال صورة على الواتس للمعاينة وتحديد السعر بدقة.',
    note_icon: 'fab fa-whatsapp', note_whatsapp: 1 }
];

// [التصنيف، المجموعة الفرعية، الاسم، الوحدة، التسعير، أقل سعر، أعلى سعر، نص السعر في الموقع، يظهر في الموقع]
const SERVICES = [
  ['bedding', null, 'بطانية عادية', 'piece', 'range', 120, 140],
  ['bedding', null, 'لحاف / مفرش فايبر', 'piece', 'range', 120, 140],
  ['bedding', null, 'ملاية سرير كي', 'piece', 'fixed', 20, 20],
  ['bedding', null, 'ملاية سرير تنظيف', 'piece', 'fixed', 40, 40],

  ['carpets', null, 'سجاد عادي', 'm2', 'fixed', 35, 35],
  ['carpets', null, 'سجاد شاج / وبري', 'm2', 'fixed', 40, 40],
  ['carpets', null, 'سجاد صوف', 'm2', 'fixed', 45, 45],
  ['carpets', null, 'سجاد صوف يدوي شمواه', 'm2', 'fixed', 45, 45],
  ['carpets', null, 'سجاد حرير', 'm2', 'fixed', 45, 45],

  ['clothes', null, 'تي شيرت كي تطبيق', 'piece', 'fixed', 12, 12],
  ['clothes', null, 'تي شيرت كي تعليق', 'piece', 'fixed', 15, 15],
  ['clothes', null, 'تي شيرت تنظيف', 'piece', 'fixed', 35, 35],
  ['clothes', null, 'تي شيرت دراي كلين بقع', 'piece', 'fixed', 50, 50],
  ['clothes', null, 'تي شيرت صبغة', 'piece', 'fixed', 120, 120],
  ['clothes', null, 'قميص كي تطبيق', 'piece', 'fixed', 12, 12],
  ['clothes', null, 'قميص كي تعليق', 'piece', 'fixed', 15, 15],
  ['clothes', null, 'قميص تنظيف', 'piece', 'fixed', 35, 35],
  ['clothes', null, 'قميص دراي كلين بقع', 'piece', 'fixed', 50, 50],
  ['clothes', null, 'قميص صبغة', 'piece', 'fixed', 120, 120],
  ['clothes', null, 'جلباب كي تطبيق', 'piece', 'fixed', 20, 20],
  ['clothes', null, 'جلباب كي تعليق', 'piece', 'fixed', 25, 25],
  ['clothes', null, 'جلباب تنظيف تطبيق', 'piece', 'fixed', 60, 60],
  ['clothes', null, 'جلباب تنظيف تعليق', 'piece', 'fixed', 70, 70],
  ['clothes', null, 'جلباب صبغة', 'piece', 'fixed', 200, 200],
  ['clothes', null, 'بلوزة كي', 'piece', 'range', 15, 20],
  ['clothes', null, 'بلوزة تنظيف', 'piece', 'fixed', 40, 40],
  ['clothes', null, 'بلوزة دراي كلين بقع', 'piece', 'fixed', 50, 50],
  ['clothes', null, 'بلوزة صبغة', 'piece', 'range', 120, 250],
  ['clothes', null, 'ملابس داخلية تنظيف', 'piece', 'fixed', 15, 15],
  ['clothes', null, 'شراب', 'piece', 'fixed', 5, 5],
  ['clothes', null, 'كرفتة تنظيف', 'piece', 'fixed', 20, 20],
  ['clothes', null, 'عباية (كي)', 'piece', 'range', 25, 30],
  ['clothes', null, 'عبايات تنظيف وكي', 'piece', 'range', 60, 100],

  ['suits', null, 'بدلة قطعتين كي', 'piece', 'fixed', 50, 50],
  ['suits', null, 'بدلة قطعتين دراي كلين', 'piece', 'range', 120, 150],
  ['suits', null, 'جاكت كي', 'piece', 'range', 25, 30],
  ['suits', null, 'جاكت دراي كلين', 'piece', 'range', 90, 150],
  ['suits', null, 'جاكت صبغة', 'piece', 'range', 150, 250],
  ['suits', null, 'سويت شيرت', 'piece', 'range', 50, 60],
  ['suits', null, 'فستان سواريه دراي كلين', 'piece', 'range', 150, 300],
  ['suits', null, 'فستان زفاف', 'piece', 'quote', null, null, 'حسب الاتفاق'],

  ['pillows', null, 'مخدة صغيرة (نص سرير)', 'piece', 'fixed', 50, 50],
  ['pillows', null, 'مخدة سرير 100', 'piece', 'fixed', 80, 80],
  ['pillows', null, 'مخدة سرير 120', 'piece', 'fixed', 100, 100],
  ['pillows', null, 'مخدة سرير 160', 'piece', 'fixed', 120, 120],
  ['pillows', null, 'أكياس مخدة كي', 'piece', 'fixed', 10, 10],
  ['pillows', null, 'أكياس مخدة تنظيف', 'piece', 'fixed', 20, 20],
  ['pillows', 'تنظيف المراتب', 'مرتبة 100 سم', 'piece', 'fixed', 350, 350],
  ['pillows', 'تنظيف المراتب', 'مرتبة 120 سم', 'piece', 'fixed', 400, 400],
  ['pillows', 'تنظيف المراتب', 'مرتبة 160 سم', 'piece', 'fixed', 600, 600],
  ['pillows', 'تنظيف المراتب', 'مرتبة 180 سم', 'piece', 'fixed', 700, 700],

  ['curtains', null, 'ستائر شيفون (المتر)', 'meter', 'fixed', 15, 15],
  ['curtains', null, 'تقيل وشمواه (المتر)', 'meter', 'fixed', 17, 17],
  ['curtains', null, 'بلاك اوت (المتر)', 'meter', 'fixed', 25, 25],
  ['curtains', null, 'تنظيف انتريه', 'service', 'quote', null, null, 'بعد المعاينة', 0]
];

const ZONES = ['حدائق الأهرام', 'غرب سوميد', 'حدائق أكتوبر', 'دريم', 'الشيخ زايد', 'أكتوبر الجديدة'];

const DEFAULT_SETTINGS = {
  business_name: '4seasons',
  business_tagline: 'مغسلة متخصصة للملابس والسجاد والبطانيات والستائر والانتريهات',
  branch: 'حدائق أكتوبر',
  phone: '01028040813',
  whatsapp: '01028040809',
  maps_url: 'https://maps.app.goo.gl/JcZ9eQDdPh6nAjdVA?g_st=aw',
  facebook_url: 'https://www.facebook.com/share/1J6qtav271/',
  hours_text: 'خدمة العملاء: 12 مساءً - 10 مساءً',
  coverage_text: 'سياراتنا تغطي جميع أنحاء أكتوبر وحدائق أكتوبر والشيخ زايد وأكتوبر الجديدة',
  price_notice: 'الأسعار الجديدة سارية اعتبارًا من ديسمبر 2026. جميع الأسعار شاملة التنظيف الأساسي، وأي بقع صعبة لها رسوم إضافية بعد المعاينة.',
  delivery_notice: 'توجد رسوم لخدمة الاستلام والتسليم.',
  extras_notice: 'تتوفر أيضًا خدمات الترزي والصبغة والطباعة على التيشيرتات. السعر حسب الخدمة والطلب.',
  turnaround_days: '4',
  response_hours: '8'
};

function seedCatalog(db) {
  if (db.prepare('SELECT COUNT(*) c FROM categories').get().c > 0) return false;
  const now = nowIso();
  tx(db, () => {
    const insCat = db.prepare(`INSERT INTO categories (code,name,icon,visual,note,note_icon,note_whatsapp,sort_order)
      VALUES (?,?,?,?,?,?,?,?)`);
    const catId = {};
    CATEGORIES.forEach((c, i) => {
      const r = insCat.run(c.code, c.name, c.icon, c.visual || null, c.note || null, c.note_icon || null, c.note_whatsapp || 0, (i + 1) * 10);
      catId[c.code] = Number(r.lastInsertRowid);
    });
    const insSvc = db.prepare(`INSERT INTO services
      (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,public_text,show_public,sort_order,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    SERVICES.forEach((s, i) => {
      const [cat, sub, name, unit, pricing, min, max, text, show] = s;
      insSvc.run(catId[cat], sub, name, unit, pricing, min == null ? null : min * 100, max == null ? null : max * 100,
        text || null, show === 0 ? 0 : 1, (i + 1) * 10, now, now);
    });
    const insZone = db.prepare('INSERT INTO zones (name,fee_cents,sort_order) VALUES (?,0,?)');
    ZONES.forEach((z, i) => insZone.run(z, (i + 1) * 10));
    const insSet = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSet.run(k, v);
  });
  return true;
}

module.exports = { seedCatalog, DEFAULT_SETTINGS };
