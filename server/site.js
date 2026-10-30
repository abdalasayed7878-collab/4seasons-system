'use strict';
// يرسم الصفحة العامة من القالب باستخدام الأسعار والإعدادات الحية من قاعدة البيانات
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = c => { const v = c / 100; return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ''); };
const waNumber = p => '2' + String(p || '').replace(/\D/g, '').replace(/^2?/, '');
const telHref = p => 'tel:+2' + String(p || '').replace(/\D/g, '').replace(/^2?/, '');

function priceText(s) {
  if (s.public_text) return s.public_text;
  if (s.pricing === 'quote') return 'بعد المعاينة';
  const suffix = s.unit === 'm2' ? ' ج / م' : ' ج';
  return (s.price_min_cents === s.price_max_cents ? num(s.price_min_cents) : `${num(s.price_min_cents)} - ${num(s.price_max_cents)}`) + suffix;
}

function renderServices(db, settings) {
  const cats = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order, id').all();
  const svcs = db.prepare('SELECT * FROM services WHERE active = 1 AND show_public = 1 ORDER BY sort_order, id').all();
  return cats.map(c => {
    const list = svcs.filter(s => s.category_id === c.id);
    if (!list.length) return '';
    // تقسيم بحسب المجموعة الفرعية مع الحفاظ على الترتيب
    const groups = [];
    for (const s of list) {
      let g = groups.find(x => x.sub === (s.subgroup || null));
      if (!g) groups.push(g = { sub: s.subgroup || null, items: [] });
      g.items.push(s);
    }
    const body = groups.map(g =>
      (g.sub ? `<div class="sub-price-title">${esc(g.sub)}</div>` : '') +
      `<ul class="price-list">${g.items.map(s => `<li><strong>${esc(s.name)}</strong> <span>${esc(priceText(s))}</span></li>`).join('')}</ul>`).join('\n');
    let note = '';
    if (c.note) {
      const icon = esc(c.note_icon || 'fas fa-info-circle');
      note = c.note_whatsapp && settings.whatsapp
        ? `<div class="note-price"><i class="${icon}" aria-hidden="true"></i> <a href="https://wa.me/${waNumber(settings.whatsapp)}" target="_blank" rel="noopener noreferrer">${esc(c.note)}</a></div>`
        : `<div class="note-price"><i class="${icon}" aria-hidden="true"></i> ${esc(c.note)}</div>`;
    }
    return `<div class="service-card">
                <div class="service-visual ${esc(c.visual || 'clothes')}" role="img" aria-label="${esc(c.name)}"></div>
                <div class="service-icon"><i class="${esc(c.icon)}" aria-hidden="true"></i></div>
                <h3>${esc(c.name)}</h3>
                ${body}
                ${note}
            </div>`;
  }).join('\n');
}

function renderNotices(s) {
  const n = [[s.price_notice, 'fas fa-info-circle', 'background:#ffe9db;'], [s.delivery_notice, 'fas fa-truck', ''], [s.extras_notice, 'fas fa-scissors', '']];
  return n.filter(x => x[0]).map(([t, i, st]) =>
    `<div class="note-price" style="max-width:1200px;margin:15px auto 0;${st}justify-content:center;text-align:center;"><i class="${i}" aria-hidden="true"></i> ${esc(t)}</div>`).join('\n');
}

function contactLines(s, withDetails) {
  const L = [];
  if (s.phone) L.push(`<p><i class="fas fa-phone" aria-hidden="true"></i> ${withDetails ? 'للحجز والاتصال: ' : ''}<a href="${telHref(s.phone)}" dir="ltr">${esc(s.phone)}</a></p>`);
  if (s.whatsapp) L.push(`<p><i class="fab fa-whatsapp" aria-hidden="true"></i> ${withDetails ? 'واتساب: ' : ''}<a href="https://wa.me/${waNumber(s.whatsapp)}" target="_blank" rel="noopener noreferrer" dir="ltr">${esc(s.whatsapp)}</a></p>`);
  if (withDetails && s.hours_text) L.push(`<p><i class="fas fa-clock" aria-hidden="true"></i> ${esc(s.hours_text)}</p>`);
  if (s.maps_url) L.push(`<p><i class="fas fa-map-marker-alt" aria-hidden="true"></i> <a href="${esc(s.maps_url)}" target="_blank" rel="noopener noreferrer">الفرع الرئيسي: ${esc(s.branch)}</a></p>`);
  if (s.coverage_text) L.push(`<p><i class="fas fa-truck" aria-hidden="true"></i> ${esc(s.coverage_text)}</p>`);
  return L.join('\n                    ');
}

function createSiteRouter(domain, config, staticOpts) {
  const templatePath = path.join(config.websiteDir, 'index.template.html');
  if (!fs.existsSync(templatePath)) throw Object.assign(new Error('no site template'), { code: 'MODULE_NOT_FOUND' });
  const router = express.Router();
  const assetv = String(Math.floor(Date.now() / 1000));
  let template = fs.readFileSync(templatePath, 'utf8');

  function render(req) {
    if (!config.isProd) template = fs.readFileSync(templatePath, 'utf8');
    const s = domain.getSettings();
    const { PREF_TIMES, WEB_SERVICE_TYPES } = domain.constants;
    const base = config.siteUrl || `${req.protocol}://${req.get('host')}`;
    const title = `${s.business_name} | مغسلة متخصصة - الأسعار والخدمات`;
    const description = s.business_tagline || 'مغسلة متخصصة';
    const hasLogo = fs.existsSync(path.join(config.websiteDir, 'assets', '4seasons-logo.png'));
    const social = [
      s.facebook_url && `<a href="${esc(s.facebook_url)}" target="_blank" rel="noopener noreferrer" aria-label="فيسبوك"><i class="fab fa-facebook-f" aria-hidden="true"></i></a>`,
      s.whatsapp && `<a href="https://wa.me/${waNumber(s.whatsapp)}" target="_blank" rel="noopener noreferrer" aria-label="واتساب"><i class="fab fa-whatsapp" aria-hidden="true"></i></a>`,
      s.phone && `<a href="${telHref(s.phone)}" aria-label="اتصال"><i class="fas fa-phone" aria-hidden="true"></i></a>`
    ].filter(Boolean).join('');
    const jsonld = {
      '@context': 'https://schema.org', '@type': 'DryCleaningOrLaundry', name: s.business_name, description,
      url: base + '/', telephone: s.phone ? '+2' + s.phone : undefined,
      areaServed: s.coverage_text || undefined,
      address: { '@type': 'PostalAddress', addressLocality: s.branch, addressCountry: 'EG' },
      hasMap: s.maps_url || undefined, image: hasLogo ? base + '/assets/4seasons-logo.png' : undefined,
      sameAs: s.facebook_url ? [s.facebook_url] : undefined
    };
    const map = {
      title: esc(title), description: esc(description),
      canonical: `<link rel="canonical" href="${esc(base)}/">`,
      og_image: hasLogo ? `<meta property="og:image" content="${esc(base)}/assets/4seasons-logo.png">` : '',
      jsonld: JSON.stringify(jsonld).replace(/</g, '\\u003c'),
      assetv, wa_number: s.whatsapp ? waNumber(s.whatsapp) : '', hours_text: esc(s.hours_text || ''), business_name: esc(s.business_name), response_hours: esc(s.response_hours), turnaround_days: esc(s.turnaround_days),
      services: renderServices(req.app.locals.db, s), notices: renderNotices(s),
      contact_lines: contactLines(s, true), footer_contact: contactLines(s, false), social,
      service_options: Object.entries(WEB_SERVICE_TYPES).map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('\n'),
      time_options: PREF_TIMES.map((t, i) => `<label class="time-option"><input type="radio" name="prefTime" value="${esc(t)}"${i === 0 ? ' checked' : ''}> <span>${esc(t)}</span></label>`).join('\n'),
      year: new Date().getFullYear()
    };
    return template.replace(/%%(\w+)%%/g, (m, k) => (k in map ? String(map[k]) : m));
  }

  router.get(['/', '/index.html'], (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(render(req));
  });
  router.get('/site.css', (req, res) => res.sendFile(path.join(config.websiteDir, 'site.css'), { maxAge: config.isProd ? '7d' : 0 }));
  router.get('/site.js', (req, res) => res.sendFile(path.join(config.websiteDir, 'site.js'), { maxAge: config.isProd ? '7d' : 0 }));
  router.use('/assets', express.static(path.join(config.websiteDir, 'assets'), { ...staticOpts, maxAge: config.isProd ? '7d' : 0 }));
  router.get('/robots.txt', (req, res) => {
    const base = config.siteUrl || `${req.protocol}://${req.get('host')}`;
    res.type('text').send(`User-agent: *\nDisallow: /app\nDisallow: /api\nSitemap: ${base}/sitemap.xml\n`);
  });
  router.get('/sitemap.xml', (req, res) => {
    const base = config.siteUrl || `${req.protocol}://${req.get('host')}`;
    res.type('xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(base)}/</loc></url></urlset>\n`);
  });
  return router;
}

module.exports = { createSiteRouter };
