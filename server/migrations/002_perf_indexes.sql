-- فهارس لقوائم الطلبات الكبيرة (مئات الآلاف من الطلبات)
CREATE INDEX idx_orders_created_at     ON orders(created_at DESC, id DESC);
CREATE INDEX idx_orders_status_created ON orders(status, created_at DESC, id DESC);
