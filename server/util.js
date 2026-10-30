'use strict';
const config = require('./config');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const httpError = (status, code, message, extra) => new HttpError(status, code, message, extra);
const invalid = (message, field) => new HttpError(422, 'invalid', message, field ? { field } : undefined);

const nowIso = () => new Date().toISOString();

// تاريخ اليوم بتوقيت المغسلة (YYYY-MM-DD)
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' });
const dateInTz = (d = new Date()) => dateFmt.format(d);
const todayStr = () => dateInTz();
const addDaysStr = (days, from = new Date()) => dateInTz(new Date(from.getTime() + days * 86400000));
const isDateStr = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// ---------- النصوص والأرقام ----------
const toLatinDigits = s => String(s ?? '')
  .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
  .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

// تطبيع للبحث: أرقام لاتينية، حروف صغيرة، توحيد الهمزات والتاء المربوطة والياء، حذف التشكيل
const norm = s => toLatinDigits(s).toLowerCase()
  .replace(/[ً-ٰٟـ]/g, '')
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/\s+/g, ' ').trim();

const escapeLike = s => s.replace(/[\\%_]/g, m => '\\' + m);

// رقم موبايل مصري: 01XXXXXXXXX (يقبل +20 و 0020 وأرقام عربية ومسافات)
function normalizePhone(raw, { mobileOnly = false } = {}) {
  let p = toLatinDigits(raw).replace(/[\s\-().]/g, '');
  p = p.replace(/^(\+20|0020)/, '0');
  if (/^01[0125]\d{8}$/.test(p)) return p;
  if (!mobileOnly && /^0\d{8,10}$/.test(p)) return p; // أرضي بكود المنطقة
  return null;
}

const toCents = v => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const fromCents = c => (c == null ? null : Math.round(c) / 100);

// ---------- التحقق من المدخلات ----------
function str(v, { field, min = 0, max = 500, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw invalid(`الحقل «${field}» مطلوب.`, field);
    return null;
  }
  if (typeof v !== 'string') throw invalid(`قيمة غير صحيحة في «${field}».`, field);
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (required && s.length < Math.max(1, min)) throw invalid(`الحقل «${field}» مطلوب.`, field);
  if (s.length && s.length < min) throw invalid(`«${field}» قصير جدًا.`, field);
  if (s.length > max) throw invalid(`«${field}» طويل جدًا (الحد الأقصى ${max} حرف).`, field);
  return s || null;
}

function int(v, { field, min = -Infinity, max = Infinity, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw invalid(`الحقل «${field}» مطلوب.`, field);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`قيمة غير صحيحة في «${field}».`, field);
  return n;
}

function money(v, { field, min = 0, max = 10_000_000, required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw invalid(`الحقل «${field}» مطلوب.`, field);
    return null;
  }
  const c = toCents(v);
  if (!Number.isFinite(c) || c < min * 100 || c > max * 100) throw invalid(`مبلغ غير صحيح في «${field}».`, field);
  return c;
}

const pick = (v, allowed, field) => {
  if (!allowed.includes(v)) throw invalid(`قيمة غير مسموحة في «${field}».`, field);
  return v;
};

const pad = (n, w) => String(n).padStart(w, '0');

module.exports = {
  HttpError, httpError, invalid, config,
  nowIso, todayStr, addDaysStr, dateInTz, isDateStr,
  toLatinDigits, norm, escapeLike, normalizePhone, toCents, fromCents,
  str, int, money, pick, pad
};
