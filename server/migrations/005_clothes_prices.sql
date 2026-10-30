-- تحديث بنود الملابس والأسعار الجديدة. البنود القديمة بتتعطّل (مش بتتمسح) عشان الفواتير القديمة تفضل سليمة.
UPDATE services SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE name IN ('تي شيرت / بنطلون / قميص (كي)','تطبيق + تعليق','بلوزة (كي)','تنظيف وكي عادي','دراي كلين (قميص/بنطلون/تيشرت/بلوزة)','جلابية (كي)','جلابية تنظيف وكي','بدلة دراي كلين','جاكيت')
   AND category_id IN (SELECT id FROM categories WHERE code IN ('clothes','suits'));

INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'تي شيرت كي تطبيق','piece','fixed',1200,1200,1,1,1000,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='تي شيرت كي تطبيق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'تي شيرت كي تعليق','piece','fixed',1500,1500,1,1,1010,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='تي شيرت كي تعليق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'تي شيرت تنظيف','piece','fixed',3500,3500,1,1,1020,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='تي شيرت تنظيف');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'تي شيرت دراي كلين بقع','piece','fixed',5000,5000,1,1,1030,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='تي شيرت دراي كلين بقع');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'تي شيرت صبغة','piece','fixed',12000,12000,1,1,1040,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='تي شيرت صبغة');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'قميص كي تطبيق','piece','fixed',1200,1200,1,1,1050,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='قميص كي تطبيق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'قميص كي تعليق','piece','fixed',1500,1500,1,1,1060,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='قميص كي تعليق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'قميص تنظيف','piece','fixed',3500,3500,1,1,1070,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='قميص تنظيف');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'قميص دراي كلين بقع','piece','fixed',5000,5000,1,1,1080,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='قميص دراي كلين بقع');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'قميص صبغة','piece','fixed',12000,12000,1,1,1090,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='قميص صبغة');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جلباب كي تطبيق','piece','fixed',2000,2000,1,1,1100,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جلباب كي تطبيق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جلباب كي تعليق','piece','fixed',2500,2500,1,1,1110,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جلباب كي تعليق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جلباب تنظيف تطبيق','piece','fixed',6000,6000,1,1,1120,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جلباب تنظيف تطبيق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جلباب تنظيف تعليق','piece','fixed',7000,7000,1,1,1130,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جلباب تنظيف تعليق');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جلباب صبغة','piece','fixed',20000,20000,1,1,1140,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جلباب صبغة');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'بلوزة كي','piece','range',1500,2000,1,1,1150,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='بلوزة كي');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'بلوزة تنظيف','piece','fixed',4000,4000,1,1,1160,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='بلوزة تنظيف');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'بلوزة دراي كلين بقع','piece','fixed',5000,5000,1,1,1170,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='بلوزة دراي كلين بقع');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'بلوزة صبغة','piece','range',12000,25000,1,1,1180,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='بلوزة صبغة');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'بدلة قطعتين كي','piece','fixed',5000,5000,1,1,1190,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='suits'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='بدلة قطعتين كي');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'بدلة قطعتين دراي كلين','piece','range',12000,15000,1,1,1200,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='suits'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='بدلة قطعتين دراي كلين');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جاكت كي','piece','range',2500,3000,1,1,1210,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='suits'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جاكت كي');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جاكت دراي كلين','piece','range',9000,15000,1,1,1220,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='suits'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جاكت دراي كلين');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'جاكت صبغة','piece','range',15000,25000,1,1,1230,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='suits'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='جاكت صبغة');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'ملابس داخلية تنظيف','piece','fixed',1500,1500,1,1,1240,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='ملابس داخلية تنظيف');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'شراب','piece','fixed',500,500,1,1,1250,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='شراب');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'كرفتة تنظيف','piece','fixed',2000,2000,1,1,1260,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='clothes'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='كرفتة تنظيف');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'ملاية سرير كي','piece','fixed',2000,2000,1,1,1270,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='bedding'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='ملاية سرير كي');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'ملاية سرير تنظيف','piece','fixed',4000,4000,1,1,1280,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='bedding'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='ملاية سرير تنظيف');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'أكياس مخدة كي','piece','fixed',1000,1000,1,1,1290,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='pillows'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='أكياس مخدة كي');
INSERT INTO services (category_id,subgroup,name,unit,pricing,price_min_cents,price_max_cents,show_public,active,sort_order,created_at,updated_at)
SELECT id,NULL,'أكياس مخدة تنظيف','piece','fixed',2000,2000,1,1,1300,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM categories WHERE code='pillows'
AND NOT EXISTS (SELECT 1 FROM services s WHERE s.name='أكياس مخدة تنظيف');
