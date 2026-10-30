'use strict';
const path = require('node:path');

// يقرأ ملف .env (اختياري) من جذر المشروع
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* لا يوجد ملف .env */ }

const env = process.env;
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);

module.exports = {
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  dbPath: path.resolve(env.DB_PATH || path.join(__dirname, '..', 'data', '4seasons.db')),
  backupDir: path.resolve(env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups')),
  tz: env.TZ_NAME || 'Africa/Cairo',
  // خلف Nginx/Render/Cloudflare اجعلها true ليقرأ عنوان IP الحقيقي ويعرف أن الاتصال HTTPS
  trustProxy: bool(env.TRUST_PROXY, false),
  // auto = يتحدد من الاتصال (HTTPS)، true/false لفرضها
  cookieSecure: (env.COOKIE_SECURE || 'auto').toLowerCase(),
  sessionHours: Number(env.SESSION_HOURS) || 12,
  // مواقع مسموح لها بإرسال طلبات الاستلام لو الموقع العام مستضاف في مكان آخر
  publicOrigins: list(env.PUBLIC_ORIGINS),
  siteUrl: (env.SITE_URL || '').replace(/\/+$/, ''),
  orderStart: Number(env.ORDER_START) || 1001,
  // اختياري: رابط يستقبل رمز التحقق (POST JSON) لإرساله تلقائيًا على واتساب/SMS. لو فاضي الكاشير بيبعته يدويًا.
  otpWebhookUrl: (env.OTP_WEBHOOK_URL || '').trim(),
  otpWebhookToken: (env.OTP_WEBHOOK_TOKEN || '').trim(),
  appDir: path.join(__dirname, '..', 'app'),
  websiteDir: path.join(__dirname, '..', 'website'),
  isProd: env.NODE_ENV === 'production'
};
