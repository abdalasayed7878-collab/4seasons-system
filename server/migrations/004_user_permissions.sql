-- صلاحيات مخصصة لكل موظف (JSON array). NULL = صلاحيات الدور الافتراضية.
ALTER TABLE users ADD COLUMN permissions TEXT;
