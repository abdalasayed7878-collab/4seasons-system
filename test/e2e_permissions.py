# usage: python3 test/e2e_permissions.py http://localhost:3000 <admin-temp-password>
import sys
from playwright.sync_api import sync_playwright
BASE, PW = sys.argv[1], sys.argv[2]
errs = []
def ok(c, m):
    print(('PASS ' if c else 'FAIL ') + m)
    if not c: errs.append(m)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(bypass_csp=True, viewport={'width':1200,'height':900}, locale='ar-EG')
    page = ctx.new_page(); logs = []
    page.on('pageerror', lambda e: logs.append(str(e)))
    page.goto(BASE + '/app/')
    page.fill('#login-username', 'admin'); page.fill('#login-password', PW); page.click('#login-form button[type=submit]')
    page.wait_for_selector('#password-dialog[open]')
    page.fill('#pw-new', 'Laundry2026ok'); page.fill('#pw-confirm', 'Laundry2026ok'); page.click('#password-form button[type=submit]')
    page.wait_for_selector('#dashboard.active')
    page.click('[data-view=settings]'); page.click('[data-stab=users]'); page.wait_for_selector('#users-table tr')
    page.click('#add-user-btn'); page.wait_for_selector('#u-perms input')
    page.fill('#u-username', 'emp1'); page.fill('#u-name', 'موظف الكاشير'); page.fill('#u-password', 'Employee2026x')
    # شيل صلاحية تغيير الحالة والتحصيل
    page.uncheck('#u-perms input[value="orders:update"]'); page.uncheck('#u-perms input[value="payments:collect"]')
    page.screenshot(path='shots/user-create.png')
    page.click('#user-form button[type=submit]'); page.wait_for_selector('#temp-dialog[open]')
    ok(page.inner_text('#tp-pass').strip() == 'Employee2026x', 'manager-chosen password shown')
    page.click('#temp-dialog [data-close]')
    page.wait_for_selector('[data-uperms]')
    page.click('[data-uperms]'); page.wait_for_selector('#pm-perms input')
    ok(not page.is_checked('#pm-perms input[value="orders:update"]') and page.is_checked('#pm-perms input[value="orders:create"]'), 'perm dialog reflects saved perms')
    page.check('#pm-perms input[value="orders:update"]'); page.screenshot(path='shots/perm-dialog.png')
    page.click('#perm-form button[type=submit]'); page.wait_for_function("!document.querySelector('#perm-dialog').open")
    ok('مخصصة' in page.inner_text('#users-table'), 'table shows custom perms')
    # دخول الموظف
    emp = ctx.browser.new_context(bypass_csp=True, viewport={'width':1200,'height':900}, locale='ar-EG').new_page()
    emp.on('pageerror', lambda e: logs.append(str(e)))
    emp.goto(BASE + '/app/'); emp.fill('#login-username', 'emp1'); emp.fill('#login-password', 'Employee2026x'); emp.click('#login-form button[type=submit]')
    emp.wait_for_selector('#password-dialog[open]')
    emp.fill('#pw-new', 'Employee2027y'); emp.fill('#pw-confirm', 'Employee2027y'); emp.click('#password-form button[type=submit]')
    emp.wait_for_function("document.querySelector('#current-user').textContent.includes('موظف')")
    ok(emp.is_hidden('[data-view=settings]'), 'employee: no settings')
    ok(emp.is_visible('[data-view=pos]'), 'employee: has cashier')
    emp.screenshot(path='shots/employee.png')
    # المدير يسحب صلاحية الكاشير
    page.click('[data-uperms]'); page.wait_for_selector('#pm-perms input')
    for k in ['orders:create']: page.uncheck(f'#pm-perms input[value="{k}"]')
    page.click('#perm-form button[type=submit]'); page.wait_for_function("!document.querySelector('#perm-dialog').open")
    emp.reload(); emp.wait_for_selector('#current-user')
    emp.wait_for_function("document.querySelector('#current-user').textContent.includes('موظف')")
    ok(emp.is_hidden('[data-view=pos]'), 'after revoke: cashier hidden')
    ok(not logs, 'no JS errors ' + str(logs))
    b.close()
print('\nFAILED' if errs else '\nALL PASS'); sys.exit(1 if errs else 0)
