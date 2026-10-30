'use strict';
const { httpError } = require('./util');

// ---------- رؤوس الأمان ----------
function securityHeaders(config) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https://images.unsplash.com",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ');
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  };
}

// ---------- الكوكيز ----------
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* تجاهل */ } }
  }
  return out;
}

function setCookie(res, req, config, name, value, { maxAgeSec } = {}) {
  const secure = config.cookieSecure === 'true' || (config.cookieSecure === 'auto' && req.secure);
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

// ---------- حماية CSRF: فحص Origin للطلبات المُغيِّرة ----------
function originCheck(allowedHosts = []) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin) return next(); // طلبات من نفس الموقع قد لا ترسل Origin
    try {
      const host = new URL(origin).host;
      if (host === req.headers.host || allowedHosts.includes(host)) return next();
    } catch { /* origin غير صالح */ }
    next(httpError(403, 'forbidden_origin', 'مصدر الطلب غير مسموح.'));
  };
}

// ---------- تحديد معدل الطلبات (في الذاكرة) ----------
function rateLimiter({ windowMs, max, key = req => req.ip, message = 'محاولات كثيرة، حاول لاحقًا.' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  timer.unref();
  const mw = (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(k, h); }
    h.count++;
    if (h.count > max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - now) / 1000));
      return next(httpError(429, 'rate_limited', message));
    }
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}

// ---------- CORS لمسارات الموقع العام فقط ----------
function publicCors(config) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.publicOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
}

module.exports = { securityHeaders, parseCookies, setCookie, originCheck, rateLimiter, publicCors };
