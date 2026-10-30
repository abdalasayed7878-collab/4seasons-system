# usage: python3 test/e2e_features.py http://localhost:3000 <admin-temp-password>
import sys
from playwright.sync_api import sync_playwright
BASE, PW = sys.argv[1], sys.argv[2]
errs = []; logs = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
def new_page(b, w=1200, h=900):
    ctx = b.new_context(bypass_csp=True, viewport={'width':w,'height':h}, locale='ar-EG')
    p = ctx.new_page(); p.on('pageerror', lambda e: logs.append(str(e))); return p
def login(p, user, pw, new=None):
    p.goto(BASE + '/app/'); p.fill('#login-username', user); p.fill('#login-password', pw); p.click('#login-form button[type=submit]')
    if new:
        p.wait_for_selector('#password-dialog[open]'); p.fill('#pw-new', new); p.fill('#pw-confirm', new); p.click('#password-form button[type=submit]')
    p.wait_for_selector('#dashboard.active, .view.active')
with sync_playwright() as pw_:
    b = pw_.chromium.launch()
    m = new_page(b); login(m, 'admin', PW, 'Laundry2026ok')
    # قائمة: فتح وقفل على الديسكتوب
    w0 = m.evaluate("document.querySelector('.sidebar').getBoundingClientRect().width")
    m.click('#menu-toggle'); m.wait_for_timeout(400)
    w1 = m.evaluate("document.querySelector('.sidebar').getBoundingClientRect().width")
    ok(w1 < w0 - 100, f'sidebar collapses ({w0}->{w1})')
    m.screenshot(path='shots/collapsed.png')
    m.click('#menu-toggle'); m.wait_for_timeout(400)
    ok(m.evaluate("document.querySelector('.sidebar').getBoundingClientRect().width") > 200, 'sidebar expands')
    # موظف جديد
    m.click('[data-view=settings]'); m.click('[data-stab=users]'); m.wait_for_selector('#users-table tr')
    m.click('#add-user-btn'); m.wait_for_selector('#u-perms input')
    m.fill('#u-username', 'emp1'); m.fill('#u-name', 'موظف الكاشير'); m.fill('#u-password', 'Employee2026x')
    m.click('#user-form button[type=submit]'); m.wait_for_selector('#temp-dialog[open]'); m.click('#temp-dialog [data-close]')
    # الموظف يبعت رسالة للمدير
    e = new_page(b); login(e, 'emp1', 'Employee2026x', 'Employee2027y')
    e.wait_for_function("document.querySelector('#current-user').textContent.includes('موظف')")
    e.click('[data-view=messages]'); e.click('#new-message-btn'); e.wait_for_selector('#cp-contacts input')
    e.check('#cp-contacts input >> nth=0'); e.fill('#cp-subject', 'عميل عايز خصم'); e.fill('#cp-body', 'عميل بيسأل عن خصم على الستائر')
    e.screenshot(path='shots/compose.png'); e.click('#compose-form button[type=submit]')
    e.wait_for_function("document.querySelector('#message-tabs .tab.active').dataset.box==='sent'")
    ok('عميل عايز خصم' in e.inner_text('#messages-table'), 'employee sent message appears in sent')
    # المدير يشوف شارة ويرد
    m.reload(); m.wait_for_selector('#messages-badge:not([hidden])', timeout=8000)
    ok(m.inner_text('#messages-badge').strip() in ('1', '١'), 'manager unread badge')
    m.click('[data-view=messages]'); m.wait_for_selector('#messages-table [data-msg]'); m.click('#messages-table [data-msg]')
    m.wait_for_selector('#read-dialog[open]'); m.fill('#rd-reply', 'تمام، خصم 10%'); m.screenshot(path='shots/read.png')
    m.click('#reply-form button[type=submit]'); m.wait_for_function("document.querySelectorAll('#rd-thread .thread-msg').length===2")
    ok(True, 'manager replied in thread'); m.keyboard.press('Escape')
    e.reload(); e.wait_for_selector('#messages-badge:not([hidden])', timeout=8000); ok(True, 'employee got reply badge')
    # تحكم المدير: عميل + طلب
    m.click('[data-view=customers]'); m.click('#add-customer-top'); m.wait_for_selector('#customer-dialog[open]')
    inputs = m.locator('#customer-dialog input:visible')
    m.fill('#c-name', 'عميل تجربة'); m.fill('#c-phone', '01077778888'); m.fill('#c-address', 'عنوان تجريبي طويل')
    m.click('#customer-form button[type=submit]'); m.wait_for_timeout(900)
    m.keyboard.press('Escape'); m.wait_for_timeout(300)
    m.click('[data-view=orders]'); m.click('[data-view=customers]'); m.wait_for_selector('#customer-table [data-cadmin]')
    m.click('#customer-table [data-cadmin] >> nth=0'); m.wait_for_selector('#cadmin-dialog[open]')
    m.fill('#ca-opening', '250'); m.screenshot(path='shots/cadmin.png'); m.click('#cadmin-form button[type=submit]'); m.wait_for_timeout(600)
    ok('250' in m.inner_text('#ca-sub') or '٢٥٠' in m.inner_text('#ca-sub'), 'manual opening balance applied')
    m.once('dialog', lambda d: d.accept())
    m.click('#ca-delete'); m.wait_for_selector('#confirm-dialog[open]'); m.click('#confirm-ok')
    m.wait_for_function("!document.querySelector('#cadmin-dialog').open", timeout=8000)
    m.wait_for_timeout(500)
    ok('عميل تجربة' not in m.inner_text('#customer-table'), 'customer deleted by manager')
    ok(e.is_hidden('[data-cadmin]'), 'employee has no admin buttons')
    # موبايل
    mob = new_page(b, 390, 844); login(mob, 'admin', 'Laundry2026ok')
    ok(mob.evaluate("document.querySelector('.sidebar').getBoundingClientRect().left >= 390 || document.querySelector('.sidebar').getBoundingClientRect().right > 390"), 'mobile: menu hidden by default')
    mob.screenshot(path='shots/mobile-closed.png')
    mob.click('#menu-toggle'); mob.wait_for_timeout(400)
    ok(mob.evaluate("document.querySelector('.sidebar').getBoundingClientRect().right <= 392"), 'mobile: drawer opens')
    mob.screenshot(path='shots/mobile-drawer.png')
    mob.click('[data-view=messages]'); mob.wait_for_timeout(400)
    ok(mob.evaluate("document.documentElement.scrollWidth <= 392"), 'mobile: no horizontal overflow')
    mob.screenshot(path='shots/mobile-messages.png')
    ok(not logs, 'no JS errors ' + str(logs))
    b.close()
print('\nFAILED' if errs else '\nALL PASS'); sys.exit(1 if errs else 0)
